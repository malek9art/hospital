import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  PrintHeader,
  ReasonDialog,
  Select,
  Textarea,
  useToast,
} from '../components';
import { formatDateTime } from '../lib/format';

const MODALITY_LABEL: Record<string, string> = {
  xray: 'أشعة سينية (X-Ray)',
  ct: 'أشعة مقطعية (CT)',
  mri: 'رنين مغناطيسي (MRI)',
  us: 'موجات فوق صوتية (Ultrasound)',
  mammography: 'ماموغرام',
  fluoroscopy: 'تنظير تألقي (Fluoroscopy)',
};

export default function RadiologyPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState('active');
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    findings: '',
    impression: '',
    recommendation: '',
    critical: false,
  });
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [ackReportId, setAckReportId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api<any>(`/api/radiology/worklist?status=${status}`);
      setItems(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل قائمة عمل الأشعة');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  async function openOrder(id: string) {
    try {
      setDetail(await api(`/api/radiology/orders/${id}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر فتح طلب الأشعة');
    }
  }

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await load();
      if (detail?.order?.id) await openOrder(detail.order.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تنفيذ الإجراء');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  if (err && items.length === 0) return <ErrorState message={err} onRetry={load} />;
  if (loading && items.length === 0) return <PageSkeleton cards={2} rows={6} />;

  const draft = detail?.reports?.find((r: any) => r.status === 'draft');
  const finalReport = detail?.reports?.find((r: any) => r.status === 'final');
  const o = detail?.order;
  const activeFacility = auth.facilities.find((f) => f.id === auth.activeFacilityId);

  return (
    <div className="space-y-4">
      <div className="no-print">
        <PageHeader
          title="الأشعة والتصوير الطبي (RIS)"
          subtitle="إدارة طلبات التصوير، كتابة التقارير التشخيصية المؤرشفة، وإبلاغ النتائج الحرجة. (بدون PACS/DICOM)"
        />
      </div>

      <Card
        title="قائمة عمل قسم الأشعة"
        className="no-print"
        action={
          <Select
            aria-label="تصفية حالة طلبات الأشعة"
            className="!w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="active">الطلبات النشطة</option>
            <option value="ordered">بانتظار التصوير</option>
            <option value="in_progress">قيد التصوير</option>
            <option value="performed">بانتظار التقرير</option>
            <option value="verified">تقارير معتمدة</option>
            <option value="cancelled">ملغاة</option>
            <option value="all">الكل</option>
          </Select>
        }
      >
        <DataTable
          caption="طلبات التصوير الإشعاعي"
          rows={items}
          rowKey={(i) => i.id}
          rowClassName={(i) => (i.priority === 'stat' ? 'bg-rose-50/60' : '')}
          emptyTitle="لا توجد طلبات أشعة في هذه الحالة"
          cardTitle={(i) => `${i.modality_ar} — ${i.body_part}`}
          cardSubtitle={(i) => `${i.order_no} · ${i.patient_name} (${i.mrn})`}
          cardBadge={(i) => <Badge value={i.status} />}
          cardActions={(i) => (
            <Button variant="primary" size="sm" onClick={() => openOrder(i.id)}>
              فتح الطلب والتقرير
            </Button>
          )}
          columns={[
            { key: 'no', header: 'رقم الطلب', render: (i) => <span className="font-mono text-xs">{i.order_no}</span> },
            {
              key: 'pt',
              header: 'المريض',
              render: (i) => (
                <div>
                  <span className="font-semibold">{i.patient_name}</span>
                  <span className="block text-xs text-slate-400 font-mono">
                    {i.mrn} · {i.encounter_no}
                  </span>
                </div>
              ),
            },
            {
              key: 'exam',
              header: 'الفحص',
              render: (i) => (
                <div>
                  <span>{i.modality_ar}</span>
                  <span className="block text-xs text-slate-400">{i.body_part}</span>
                </div>
              ),
            },
            {
              key: 'pri',
              header: 'الأولوية',
              render: (i) => <Badge value={i.priority === 'stat' ? 'stat' : i.priority === 'urgent' ? 'urgent' : 'open'} label={i.priority} />,
            },
            {
              key: 'st',
              header: 'الحالة',
              render: (i) => (
                <div className="flex items-center gap-1">
                  <Badge value={i.status} />
                  {i.critical && <Badge value="critical_high" label="نتيجة حرجة" />}
                </div>
              ),
            },
            { key: 'doc', header: 'الطبيب الطالب', render: (i) => <span className="text-xs">{i.ordered_by_name}</span> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (i) => (
                <Button variant="ghost" size="sm" onClick={() => openOrder(i.id)}>
                  فتح
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {o && (
        <div className="print-sheet">
          <PrintHeader
            facilityName={activeFacility?.name_ar}
            documentTitle={`تقرير تصوير إشعاعي — ${o.patient_name}`}
            documentNo={o.order_no}
          />
          <Card
            title={`${o.order_no} — ${o.patient_name}`}
            subtitle={`${MODALITY_LABEL[o.modality] ?? o.modality} · ${o.body_part}`}
            action={
              <div className="flex gap-2 no-print">
                {detail.reports.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => window.print()}>
                    طباعة التقرير
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDetail(null);
                    setForm({ findings: '', impression: '', recommendation: '', critical: false });
                  }}
                >
                  إغلاق
                </Button>
              </div>
            }
          >
            <div className="grid md:grid-cols-2 gap-3">
              <div className="text-sm space-y-1">
                <p>
                  <span className="text-slate-500">المبرر السريري:</span> {o.clinical_indication}
                </p>
                <p>
                  <span className="text-slate-500">الطبيب الطالب:</span> {o.ordered_by_name}
                </p>
                {o.performed_at && (
                  <p>
                    <span className="text-slate-500">تاريخ إجراء التصوير:</span> {formatDateTime(o.performed_at)}
                  </p>
                )}
                {o.cancel_reason && <p className="text-rose-700 font-semibold">سبب الإلغاء: {o.cancel_reason}</p>}
              </div>

              <div className="flex flex-wrap gap-2 items-start justify-end no-print">
                {has(auth, 'radiology.perform') && o.status === 'ordered' && (
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    onClick={() => act(() => api(`/api/radiology/orders/${o.id}/start`, { method: 'POST' }), 'بدأ التصوير').catch(() => {})}
                  >
                    بدء التصوير
                  </Button>
                )}
                {has(auth, 'radiology.perform') && ['ordered', 'in_progress'].includes(o.status) && (
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    onClick={() => act(() => api(`/api/radiology/orders/${o.id}/perform`, { method: 'POST' }), 'أُتم التصوير الإشعاعي').catch(() => {})}
                  >
                    إتمام التصوير
                  </Button>
                )}
                {has(auth, 'radiology.order') && ['ordered', 'in_progress'].includes(o.status) && (
                  <Button variant="danger" size="sm" onClick={() => setCancelModalOpen(true)}>
                    إلغاء الطلب
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <h3 className="font-bold text-sm text-slate-900">التقارير التشخيصية</h3>
              {detail.reports.length === 0 && <p className="text-xs text-slate-500">لا توجد تقارير مكتوبة بعد.</p>}
              {detail.reports.map((r: any) => (
                <div key={r.id} className="border border-slate-200 rounded-xl p-3 text-sm space-y-1">
                  <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500">
                    <span>
                      الإصدار #{r.version} · {r.reported_by_name} · {formatDateTime(r.reported_at)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Badge value={r.status === 'final' ? 'verified' : 'open'} label={r.status === 'final' ? 'نهائي معتمد' : 'مسودة'} />
                      {r.is_critical && <Badge value="critical_high" label="نتيجة حرجة" />}
                    </div>
                  </div>
                  <p>
                    <b className="text-slate-600">النتائج (Findings):</b> {r.findings}
                  </p>
                  <p>
                    <b className="text-slate-600">الانطباع التشخيصي (Impression):</b> {r.impression}
                  </p>
                  {r.recommendation && (
                    <p>
                      <b className="text-slate-600">التوصية:</b> {r.recommendation}
                    </p>
                  )}
                  {r.acknowledged_at && (
                    <p className="text-xs text-emerald-700 font-semibold pt-1">
                      ✓ استُلمت النتيجة الحرجة بواسطة {r.acknowledged_by_name}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {has(auth, 'radiology.report') && ['performed', 'reported'].includes(o.status) && !draft && (
              <div className="mt-4 border-t border-slate-100 pt-3 space-y-2 no-print">
                <h4 className="font-bold text-sm">
                  {detail.reports.length ? 'إضافة تقرير تصحيحي (Addendum / إصدار جديد)' : 'كتابة التقرير الإشعاعي'}
                </h4>
                <Textarea
                  label="النتائج التفصيلية (5 أحرف على الأقل)"
                  rows={2}
                  value={form.findings}
                  onChange={(e) => setForm({ ...form, findings: e.target.value })}
                />
                <Textarea
                  label="الانطباع التشخيصي (5 أحرف على الأقل)"
                  rows={2}
                  value={form.impression}
                  onChange={(e) => setForm({ ...form, impression: e.target.value })}
                />
                <Input
                  label="التوصية السريرية (اختياري)"
                  value={form.recommendation}
                  onChange={(e) => setForm({ ...form, recommendation: e.target.value })}
                />
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={form.critical}
                    onChange={(e) => setForm({ ...form, critical: e.target.checked })}
                  />
                  نتيجة حرجة تستوجب إشعار الطبيب الطالب فورًا
                </label>
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  disabled={form.findings.trim().length < 5 || form.impression.trim().length < 5}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/radiology/orders/${o.id}/reports`, {
                          method: 'POST',
                          body: JSON.stringify(form),
                        }),
                      'حُفظ التقرير كمسودة',
                    ).catch(() => {})
                  }
                >
                  حفظ المسودة
                </Button>
              </div>
            )}

            {has(auth, 'radiology.verify') && draft && (
              <div className="mt-4 border-t border-slate-100 pt-3 no-print">
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    act(
                      () => api(`/api/radiology/reports/${draft.id}/finalize`, { method: 'POST' }),
                      'اعتُمد التقرير النهائي وأُضيفت رسوم الفحص',
                    ).catch(() => {})
                  }
                >
                  اعتماد التقرير النهائي
                </Button>
              </div>
            )}

            {has(auth, 'radiology.critical.ack') && finalReport?.is_critical && !finalReport.acknowledged_at && (
              <div className="mt-4 border-t border-slate-100 pt-3 no-print">
                <Button variant="danger" size="sm" onClick={() => setAckReportId(finalReport.id)}>
                  توثيق استلام النتيجة الحرجة
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}

      <ReasonDialog
        open={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        title={`إلغاء طلب الأشعة (${o?.order_no ?? ''})`}
        consequenceNote="سيتم إلغاء الطلب نهائيًا وتوثيق السبب في سجل الزيارة والتدقيق."
        minLength={5}
        confirmLabel="تأكيد الإلغاء"
        variant="danger"
        onConfirm={async (reason) => {
          if (!o) return;
          await act(
            () =>
              api(`/api/radiology/orders/${o.id}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ reason }),
              }),
            'أُلغي طلب الأشعة بسبب موثّق',
          );
        }}
      />

      <ReasonDialog
        open={!!ackReportId}
        onClose={() => setAckReportId(null)}
        title="توثيق استلام نتيجة أشعة حرجة"
        consequenceNote="سيتم توثيق استلام النتيجة الحرجة والإجراء المتخذ في ملف المريض."
        label="ملاحظة الاستلام والإجراء السريري"
        minLength={5}
        confirmLabel="تأكيد الاستلام"
        onConfirm={async (note) => {
          if (!ackReportId) return;
          await act(
            () =>
              api(`/api/radiology/reports/${ackReportId}/acknowledge`, {
                method: 'POST',
                body: JSON.stringify({ note }),
              }),
            'سُجّل استلام النتيجة الإشعاعية الحرجة',
          );
        }}
      />
    </div>
  );
}

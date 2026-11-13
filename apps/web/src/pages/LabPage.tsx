import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  PageSkeleton,
  PollingControl,
  ReasonDialog,
  Select,
  StatCard,
  Textarea,
  useToast,
} from '../components';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime, formatNumber } from '../lib/format';
import { getBootstrapCached } from '../lib/referenceCache';

export default function LabPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [status, setStatus] = useState('all');
  const [items, setItems] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [labTests, setLabTests] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [encounters, setEncounters] = useState<any[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [ackTarget, setAckTarget] = useState<{ id: string; message: string } | null>(null);
  const [amendTarget, setAmendTarget] = useState<any | null>(null);
  const [amendForm, setAmendForm] = useState({ valueNumeric: '', reason: '' });

  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [orderForm, setOrderForm] = useState({
    patientId: '',
    encounterId: '',
    selectedTests: ['CBC'] as string[],
    priority: 'routine',
    clinicalNotes: '',
  });

  const canAck = has(auth, 'lab.critical.ack');
  const canAmend = has(auth, 'lab.result.amend');
  const canOrder = has(auth, 'clinical.order.create') && has(auth, 'patient.read');

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      const [wl, al, boot, pts] = await Promise.all([
        api<any>(`/api/lab/worklist?status=${status}`),
        canAck ? api<any>('/api/lab/alerts') : Promise.resolve({ items: [] }),
        getBootstrapCached(auth.activeFacilityId).catch(() => ({ labTests: [] })),
        canOrder ? api<any>('/api/patients?limit=50').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      ]);
      setItems(wl.items ?? []);
      setAlerts(al.items ?? []);
      setLabTests(boot.labTests ?? []);
      const ptList = pts.items ?? [];
      setPatients(ptList);
      setOrderForm((p) => ({ ...p, patientId: p.patientId || ptList[0]?.id || '' }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل قائمة المختبر');
    } finally {
      setLoading(false);
    }
  }, [status, canAck, canOrder, auth.activeFacilityId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!orderModalOpen || !orderForm.patientId || !has(auth, 'clinical.encounter.read')) return;
    api<any>(`/api/encounters?patientId=${orderForm.patientId}&status=open`)
      .then((res) => {
        const list = res.items ?? [];
        setEncounters(list);
        setOrderForm((p) => ({ ...p, encounterId: list[0]?.id ?? '' }));
      })
      .catch(() => setEncounters([]));
  }, [orderModalOpen, orderForm.patientId, auth]);

  const polling = usePolling(loadAll, { intervalMs: 25_000, enabled: true });

  const kpis = useMemo(() => {
    const waitingSample = items.filter((i) => i.status === 'ordered').length;
    const waitingResult = items.filter((i) => i.status === 'collected').length;
    const waitingVerify = items.filter((i) => i.status === 'resulted').length;
    const openCrit = alerts.filter((a) => !a.acknowledged_at).length;
    return { waitingSample, waitingResult, waitingVerify, openCrit };
  }, [items, alerts]);

  async function act(path: string, body: unknown, msg: string) {
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      toast.success(msg);
      await loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تنفيذ الإجراء');
    }
  }

  async function submitLabOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!orderForm.encounterId || orderForm.selectedTests.length === 0) return;
    setBusy(true);
    try {
      const res = await api<{ orderNo: string }>(`/api/encounters/${orderForm.encounterId}/lab-orders`, {
        method: 'POST',
        body: JSON.stringify({
          tests: orderForm.selectedTests,
          priority: orderForm.priority,
          clinicalNotes: orderForm.clinicalNotes.trim() || undefined,
        }),
      });
      toast.success(`تم إرسال طلب التحاليل المخبرية (${res.orderNo})`);
      setOrderModalOpen(false);
      setOrderForm((p) => ({ ...p, clinicalNotes: '' }));
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إنشاء طلب التحاليل');
    } finally {
      setBusy(false);
    }
  }

  async function submitAmendment(e: React.FormEvent) {
    e.preventDefault();
    if (!amendTarget?.result_id) return;
    setBusy(true);
    try {
      await api(`/api/lab/results/${amendTarget.result_id}/amend`, {
        method: 'POST',
        body: JSON.stringify({
          valueNumeric: Number(amendForm.valueNumeric),
          reason: amendForm.reason.trim(),
        }),
      });
      toast.success('تم تصحيح النتيجة المعتمدة وتوثيق السبب في سجل التعديلات غير القابل للحذف');
      setAmendTarget(null);
      setAmendForm({ valueNumeric: '', reason: '' });
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر تصحيح النتيجة');
    } finally {
      setBusy(false);
    }
  }

  if (err && items.length === 0) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && items.length === 0) return <PageSkeleton cards={4} rows={6} />;

  const renderRowActions = (i: any) => {
    const isSelfResulted = i.resulted_by && i.resulted_by === auth.user.id;
    return (
      <div className="flex flex-wrap gap-1.5 items-center">
        {i.status === 'ordered' && has(auth, 'lab.sample.collect') && (
          <Button variant="ghost" size="sm" onClick={() => act(`/api/lab/items/${i.id}/collect`, {}, 'تم جمع العينة وتوليد باركود الأنبوب')}>
            جمع عينة
          </Button>
        )}
        {i.status === 'collected' && has(auth, 'lab.result.enter') && (
          <div className="flex gap-1.5 items-center">
            <input
              aria-label="قيمة التحليل"
              className="input !w-24 text-xs"
              type="number"
              step="0.01"
              placeholder="القيمة"
              value={values[i.id] ?? ''}
              onChange={(e) => setValues({ ...values, [i.id]: e.target.value })}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!values[i.id]}
              onClick={() => act(`/api/lab/items/${i.id}/result`, { valueNumeric: Number(values[i.id]) }, 'تم حفظ النتيجة المخبرية')}
            >
              حفظ
            </Button>
          </div>
        )}
        {i.status === 'resulted' && has(auth, 'lab.result.verify') && (
          isSelfResulted ? (
            <span
              className="text-[11px] px-2 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200"
              title="ضابط فصل المهام (SoD): لا يمكن لمدخل النتيجة اعتمادها بنفسه"
            >
              يتطلب مشرف مختبر آخر (SoD)
            </span>
          ) : (
            <Button variant="primary" size="sm" onClick={() => act(`/api/lab/items/${i.id}/verify`, {}, 'تم اعتماد النتيجة المخبرية')}>
              اعتماد النتيجة
            </Button>
          )
        )}
        {i.status === 'verified' && canAmend && i.result_id && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAmendTarget(i);
              setAmendForm({ valueNumeric: String(i.value_numeric ?? ''), reason: '' });
            }}
          >
            تصحيح موثّق
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="المختبرات الطبية والتحاليل التشخيصية (LIS)"
        subtitle="جمع العينات، إدخال النتائج مع النطاقات المرجعية، فصل مهام الاعتماد (SoD)، التصحيحات الموثّقة، وتنبيهات القيم الحرجة."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canOrder && (
              <Button variant="primary" size="sm" onClick={() => setOrderModalOpen(true)}>
                + طلب تحاليل
              </Button>
            )}
            <PollingControl
              enabled={polling.enabled}
              onToggle={polling.setEnabled}
              lastUpdatedAt={polling.lastUpdatedAt}
              busy={polling.busy}
              onRefresh={polling.refreshNow}
            />
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="بانتظار سحب العينة" value={formatNumber(kpis.waitingSample)} tone="warning" />
        <StatCard label="بانتظار إدخال النتيجة" value={formatNumber(kpis.waitingResult)} tone="info" />
        <StatCard label="بانتظار اعتماد المشرف (SoD)" value={formatNumber(kpis.waitingVerify)} tone="brand" />
        <StatCard
          label="قيم حرجة غير مستلمة"
          value={formatNumber(kpis.openCrit)}
          tone={kpis.openCrit > 0 ? 'danger' : 'success'}
        />
      </div>

      <Card
        title="قائمة عمل التحاليل المخبرية"
        action={
          <Select
            aria-label="تصفية حالة التحاليل"
            className="!w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">كل الحالات</option>
            <option value="ordered">بانتظار العينة</option>
            <option value="collected">بانتظار النتيجة</option>
            <option value="resulted">بانتظار الاعتماد</option>
            <option value="verified">معتمدة</option>
          </Select>
        }
      >
        <DataTable
          caption="قائمة عمل التحاليل المخبرية"
          rows={items}
          rowKey={(i) => i.id}
          emptyTitle="لا توجد تحاليل مطابقة لحالة التصفية"
          cardTitle={(i) => `${i.test_name} (${i.test_code})`}
          cardSubtitle={(i) => `${i.order_no} · ${i.patient_name} (${i.mrn})`}
          cardBadge={(i) => <Badge value={i.status} />}
          cardActions={renderRowActions}
          columns={[
            {
              key: 'no',
              header: 'الطلب / الباركود',
              render: (i) => (
                <div>
                  <span className="font-mono text-xs font-bold">{i.order_no}</span>
                  {i.specimen_barcode && <span className="block text-[11px] text-slate-400 font-mono">{i.specimen_barcode}</span>}
                </div>
              ),
            },
            {
              key: 'pt',
              header: 'المريض',
              render: (i) => (
                <div>
                  <span className="font-semibold">{i.patient_name}</span>
                  <span className="block text-xs text-slate-400 font-mono">{i.mrn}</span>
                </div>
              ),
            },
            {
              key: 'test',
              header: 'التحليل والمدى المرجعي',
              render: (i) => (
                <div>
                  <span className="font-semibold">{i.test_name}</span>
                  <span className="block text-xs text-slate-500 font-mono" dir="ltr">
                    {i.test_code}
                    {i.ref_low != null && i.ref_high != null ? ` (${i.ref_low}–${i.ref_high} ${i.unit ?? ''})` : ''}
                  </span>
                </div>
              ),
            },
            {
              key: 'pri',
              header: 'الأولوية',
              render: (i) => <Badge value={i.priority === 'stat' ? 'stat' : i.priority === 'urgent' ? 'urgent' : 'routine'} />,
            },
            { key: 'st', header: 'الحالة', render: (i) => <Badge value={i.status} /> },
            {
              key: 'val',
              header: 'النتيجة',
              render: (i) => (
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-semibold">
                    {i.value_numeric ?? i.value_text ?? '—'} {i.unit ?? ''}
                  </span>
                  {i.flag && i.flag !== 'normal' && <Badge value={i.flag} />}
                </div>
              ),
            },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              isActions: true,
              render: renderRowActions,
            },
          ]}
        />
        <p className="text-xs text-slate-500 mt-3">
          ضابط فصل المهام: اعتماد النتيجة يتطلب مشرفًا أو أخصائيًا مختلفًا عن مدخل النتيجة (`lab@demo.hms` يدخل النتيجة و`lab2@demo.hms` يعتمدها). القيم الحرجة تُطلق تنبيهًا فوريًا.
        </p>
      </Card>

      {canAck && (
        <Card title="تنبيهات القيم الحرجة (Critical Value Alerts)">
          {alerts.length === 0 ? (
            <EmptyState title="لا توجد تنبيهات قيم حرجة مسجلة" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {alerts.map((a) => (
                <li key={a.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-900">{a.message}</p>
                    <p className="text-xs text-slate-500">{formatDateTime(a.created_at)}</p>
                  </div>
                  {a.acknowledged_at ? (
                    <Badge value="verified" label="تم الإقرار والتبليغ" />
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setAckTarget({ id: a.id, message: a.message })}
                    >
                      إقرار وتوثيق التبليغ
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* Modal: New Lab Order */}
      <Modal open={orderModalOpen} onClose={() => setOrderModalOpen(false)} title="طلب تحاليل مخبرية جديدة">
        <form onSubmit={submitLabOrder} className="space-y-3">
          <Select
            label="المريض"
            required
            value={orderForm.patientId}
            onChange={(e) => setOrderForm({ ...orderForm, patientId: e.target.value })}
          >
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullNameAr} ({p.mrn})
              </option>
            ))}
          </Select>
          <Select
            label="الزيارة المفتوحة"
            required
            value={orderForm.encounterId}
            onChange={(e) => setOrderForm({ ...orderForm, encounterId: e.target.value })}
          >
            {encounters.length === 0 && <option value="">لا توجد زيارة مفتوحة لهذا المريض</option>}
            {encounters.map((enc) => (
              <option key={enc.id} value={enc.id}>
                {enc.encounter_no} · {enc.department_name ?? enc.encounter_type}
              </option>
            ))}
          </Select>
          <div>
            <p className="label">التحاليل المطلوبة (اختر واحدًا أو أكثر)</p>
            <div className="grid grid-cols-2 gap-2 max-h-44 overflow-y-auto p-2.5 rounded-xl border border-slate-200 bg-slate-50 text-xs">
              {labTests.map((t) => {
                const checked = orderForm.selectedTests.includes(t.code);
                return (
                  <label key={t.code} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...orderForm.selectedTests, t.code]
                          : orderForm.selectedTests.filter((c) => c !== t.code);
                        setOrderForm({ ...orderForm, selectedTests: next });
                      }}
                    />
                    <span>
                      {t.name_ar} <span className="font-mono text-slate-500">({t.code})</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <Select
            label="الأولوية"
            value={orderForm.priority}
            onChange={(e) => setOrderForm({ ...orderForm, priority: e.target.value })}
          >
            <option value="routine">روتيني</option>
            <option value="urgent">عاجل</option>
            <option value="stat">فوري حرج (STAT)</option>
          </Select>
          <Textarea
            label="ملاحظات سريرية للمختبر"
            rows={2}
            value={orderForm.clinicalNotes}
            onChange={(e) => setOrderForm({ ...orderForm, clinicalNotes: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOrderModalOpen(false)}>
              إلغاء
            </Button>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={!orderForm.encounterId || orderForm.selectedTests.length === 0}
            >
              إرسال للمختبر
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Result Amendment */}
      <Modal
        open={!!amendTarget}
        onClose={() => setAmendTarget(null)}
        title={`تصحيح موثّق لنتيجة معتمدة (${amendTarget?.test_name ?? ''})`}
      >
        <form onSubmit={submitAmendment} className="space-y-3">
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-900">
            القيمة السابقة ({amendTarget?.value_numeric ?? '—'} {amendTarget?.unit ?? ''}) ستُحفظ في سجل التعديلات المخبرية جنبًا إلى جنب مع القيمة المصححة واسمك.
          </div>
          <Input
            label={`القيمة المصححة (${amendTarget?.unit ?? ''})`}
            type="number"
            step="0.01"
            required
            value={amendForm.valueNumeric}
            onChange={(e) => setAmendForm({ ...amendForm, valueNumeric: e.target.value })}
          />
          <Textarea
            label="سبب التصحيح المخبري (10 أحرف على الأقل)"
            required
            minLength={10}
            rows={3}
            placeholder="مثال: إعادة معايرة جهاز الكيمياء الحيوية وتكرار الفحص على نفس العينة..."
            value={amendForm.reason}
            onChange={(e) => setAmendForm({ ...amendForm, reason: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setAmendTarget(null)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={amendForm.reason.trim().length < 10}>
              اعتماد التصحيح
            </Button>
          </div>
        </form>
      </Modal>

      <ReasonDialog
        open={!!ackTarget}
        onClose={() => setAckTarget(null)}
        title="إقرار وتوثيق تبليغ نتيجة مخبرية حرجة"
        consequenceNote={`سيتم توثيق استلام وإبلاغ النتيجة الحرجة: «${ackTarget?.message ?? ''}» باسمك وتوقيتك في السجل السريري.`}
        label="ملاحظة التبليغ والإجراء السريري"
        placeholder="مثال: تم إبلاغ الطبيب المناوب هاتفيًا وإعادة السحب للتأكيد…"
        minLength={5}
        confirmLabel="توثيق الإقرار"
        onConfirm={async (note) => {
          if (!ackTarget) return;
          await api(`/api/lab/alerts/${ackTarget.id}/ack`, {
            method: 'POST',
            body: JSON.stringify({ note }),
          });
          toast.success('تم الإقرار بالقيمة الحرجة دون إعادة تحميل الصفحة');
          await loadAll();
        }}
      />
    </div>
  );
}

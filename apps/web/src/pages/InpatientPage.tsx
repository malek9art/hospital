import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  PageSkeleton,
  Select,
  StatCard,
  Textarea,
  useToast,
} from '../components';
import { formatDateTime } from '../lib/format';

const BED_COLOR: Record<string, string> = {
  available: 'bg-emerald-50 border-emerald-200',
  occupied: 'bg-rose-50 border-rose-200',
  cleaning: 'bg-amber-50 border-amber-200',
  maintenance: 'bg-slate-100 border-slate-300',
};
const BED_LABEL: Record<string, string> = {
  available: 'متاح',
  occupied: 'مشغول',
  cleaning: 'تنظيف',
  maintenance: 'صيانة',
};

export default function InpatientPage({ auth, routeId }: { auth: Me; routeId?: string | null }) {
  const toast = useToast();
  const [beds, setBeds] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [admissions, setAdmissions] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [admit, setAdmit] = useState({ patientId: '', bedId: '', reason: '' });
  const [transfer, setTransfer] = useState<{ id: string; patientName: string; toBedId: string; reason: string } | null>(null);
  const [discharge, setDischarge] = useState<{ id: string; patientName: string; dischargeType: string; summary: string } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [b, a, p] = await Promise.all([
        api<any>('/api/inpatient/beds'),
        has(auth, 'inpatient.admit') ? api<any>('/api/inpatient/admissions') : Promise.resolve({ items: [] }),
        has(auth, 'patient.read') ? api<any>('/api/patients?limit=100') : Promise.resolve({ items: [] }),
      ]);
      setBeds(b.beds ?? []);
      setSummary(b.summary ?? null);
      setAdmissions(a.items ?? []);
      setPatients(p.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات التنويم');
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await load();
    } catch (ex) {
      const ae = ex as ApiError;
      const admId = (ae.details as { admissionId?: string })?.admissionId;
      toast.error(ae.message + (admId ? ` (${admId})` : ''));
    } finally {
      setBusy(false);
    }
  }

  if (err && beds.length === 0) return <ErrorState message={err} onRetry={load} />;
  if (loading && beds.length === 0) return <PageSkeleton cards={5} rows={6} />;

  const availableBeds = beds.filter((b) => b.bed_status === 'available');

  return (
    <div className="space-y-4">
      <PageHeader
        title="إدارة التنويم والأسرّة (ADT)"
        subtitle="تنويم المرضى، خريطة الأسرّة الحية، النقل بين الأجنحة، والخروج مع احتساب الإقامة تلقائيًا."
      />

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard label="إجمالي الأسرّة" value={summary.total} />
          <StatCard label="مشغول" value={summary.occupied} tone={summary.occupied > 0 ? 'warning' : 'default'} />
          <StatCard label="متاح" value={summary.available} tone="success" />
          <StatCard label="قيد التنظيف" value={summary.cleaning} />
          <StatCard label="صيانة" value={summary.maintenance} />
        </div>
      )}

      {has(auth, 'inpatient.admit') && (
        <Card title="تنويم مريض (أمر طبيب)" subtitle="يُنشئ زيارة تنويم مستقلة ويحجز السرير؛ تُحتسب أيام الإقامة عند الخروج.">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Select
              label="المريض"
              value={admit.patientId}
              onChange={(e) => setAdmit({ ...admit, patientId: e.target.value })}
            >
              <option value="">— اختر المريض —</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullNameAr} · {p.mrn}
                </option>
              ))}
            </Select>
            <Select
              label="السرير المتاح"
              value={admit.bedId}
              onChange={(e) => setAdmit({ ...admit, bedId: e.target.value })}
            >
              <option value="">— بدون سرير مؤقتًا —</option>
              {availableBeds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.ward_name} · {b.room_no}/{b.bed_no}
                </option>
              ))}
            </Select>
            <div className="sm:col-span-2">
              <Input
                label="سبب التنويم السريري"
                value={admit.reason}
                onChange={(e) => setAdmit({ ...admit, reason: e.target.value })}
                placeholder="مثال: مراقبة ضغط دم غير مستقر وفحوص قلبية"
              />
            </div>
          </div>
          <Button
            variant="primary"
            className="mt-3"
            busy={busy}
            disabled={!admit.patientId || !admit.reason.trim()}
            onClick={() =>
              act(async () => {
                await api('/api/inpatient/admissions', {
                  method: 'POST',
                  body: JSON.stringify({
                    patientId: admit.patientId,
                    bedId: admit.bedId || undefined,
                    reason: admit.reason,
                  }),
                });
                setAdmit({ patientId: '', bedId: '', reason: '' });
              }, 'تم تنويم المريض وتخصيص السرير')
            }
          >
            تأكيد أمر التنويم
          </Button>
        </Card>
      )}

      <Card title="خريطة الأسرّة الحية حسب الأجنحة">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {beds.map((b) => (
            <div key={b.id} className={`border rounded-xl p-3 text-sm ${BED_COLOR[b.bed_status] ?? 'bg-white'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-900">
                  {b.ward_name} · {b.room_no}/{b.bed_no}
                </span>
                <span className="badge bg-white/80 text-slate-800 border border-slate-200">
                  {BED_LABEL[b.bed_status] ?? b.bed_status}
                </span>
              </div>
              {b.patient_name && (
                <p className="text-xs mt-1.5 font-medium text-slate-800">
                  {b.patient_name} <span className="text-slate-500 font-mono">{b.mrn}</span>
                </p>
              )}
              {b.bed_status === 'cleaning' && has(auth, 'inpatient.bed.manage') && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 bg-white"
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/inpatient/beds/${b.id}/status`, {
                          method: 'PATCH',
                          body: JSON.stringify({ status: 'available' }),
                        }),
                      'تم تحرير السرير وأصبح متاحًا للتنويم',
                    )
                  }
                >
                  تم التنظيف والتعقيم
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>

      {has(auth, 'inpatient.admit') && (
        <Card title="سجل التنويمات">
          <DataTable
            caption="قائمة حالات التنويم"
            rows={admissions}
            rowKey={(a) => a.id}
            rowClassName={(a) => (routeId && a.id === routeId ? 'bg-brand-50 ring-2 ring-brand-500' : '')}
            emptyTitle="لا توجد حالات تنويم مسجلة"
            cardTitle={(a) => a.patient_name}
            cardSubtitle={(a) => `${a.admission_no} · ${a.ward_name ? `${a.ward_name} ${a.room_no}/${a.bed_no}` : 'بلا سرير'}`}
            cardBadge={(a) => <Badge value={a.status === 'active' ? 'open' : 'completed'} />}
            cardActions={(a) =>
              a.status === 'active' ? (
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setTransfer({ id: a.id, patientName: a.patient_name, toBedId: '', reason: '' })}
                  >
                    نقل سرير
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setDischarge({ id: a.id, patientName: a.patient_name, dischargeType: 'home', summary: '' })}
                  >
                    تسجيل خروج
                  </Button>
                </div>
              ) : null
            }
            columns={[
              { key: 'no', header: 'رقم التنويم', render: (a) => <span className="font-mono text-xs">{a.admission_no}</span> },
              {
                key: 'pt',
                header: 'المريض',
                render: (a) => (
                  <div>
                    <span className="font-semibold">{a.patient_name}</span>
                    <span className="block text-xs text-slate-400 font-mono">{a.mrn}</span>
                  </div>
                ),
              },
              { key: 'bed', header: 'السرير', render: (a) => (a.ward_name ? `${a.ward_name} · ${a.room_no}/${a.bed_no}` : '—') },
              { key: 'doc', header: 'الطبيب المعالج', render: (a) => a.doctor_name },
              { key: 'in', header: 'تاريخ الدخول', render: (a) => formatDateTime(a.admitted_at) },
              { key: 'st', header: 'الحالة', render: (a) => <Badge value={a.status === 'active' ? 'open' : 'completed'} /> },
              {
                key: 'act',
                header: 'إجراءات',
                hideInCard: true,
                render: (a) =>
                  a.status === 'active' ? (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setTransfer({ id: a.id, patientName: a.patient_name, toBedId: '', reason: '' })}
                      >
                        نقل
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setDischarge({ id: a.id, patientName: a.patient_name, dischargeType: 'home', summary: '' })}
                      >
                        خروج
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
        </Card>
      )}

      {/* Transfer Modal */}
      <Modal
        open={!!transfer}
        onClose={() => setTransfer(null)}
        title={`نقل سرير المريض — ${transfer?.patientName ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTransfer(null)}>
              إلغاء
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!transfer?.toBedId || (transfer?.reason.trim().length ?? 0) < 3}
              onClick={() => {
                if (!transfer) return;
                act(
                  () =>
                    api(`/api/inpatient/admissions/${transfer.id}/transfer`, {
                      method: 'POST',
                      body: JSON.stringify({ toBedId: transfer.toBedId, reason: transfer.reason }),
                    }),
                  'تم نقل المريض وتحويل السرير السابق للتنظيف',
                ).then(() => setTransfer(null));
              }}
            >
              تأكيد النقل
            </Button>
          </>
        }
      >
        {transfer && (
          <div className="space-y-3">
            <Select
              label="السرير الهدف المتاح"
              required
              value={transfer.toBedId}
              onChange={(e) => setTransfer({ ...transfer, toBedId: e.target.value })}
            >
              <option value="">— اختر السرير الهدف —</option>
              {availableBeds.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.ward_name} · {b.room_no}/{b.bed_no}
                </option>
              ))}
            </Select>
            <Input
              label="سبب النقل (3 أحرف على الأقل)"
              required
              value={transfer.reason}
              onChange={(e) => setTransfer({ ...transfer, reason: e.target.value })}
            />
          </div>
        )}
      </Modal>

      {/* Discharge Modal */}
      <Modal
        open={!!discharge}
        onClose={() => setDischarge(null)}
        title={`تسجيل خروج المريض — ${discharge?.patientName ?? ''}`}
        description="يغلق التنويم والزيارة السريرية ويحتسب رسوم الإقامة اليومية."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDischarge(null)}>
              إلغاء
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={(discharge?.summary.trim().length ?? 0) < 20}
              onClick={() => {
                if (!discharge) return;
                act(
                  () =>
                    api(`/api/inpatient/admissions/${discharge.id}/discharge`, {
                      method: 'POST',
                      body: JSON.stringify({ dischargeType: discharge.dischargeType, summary: discharge.summary }),
                    }),
                  'تم تسجيل الخروج واحتساب أيام الإقامة',
                ).then(() => setDischarge(null));
              }}
            >
              تأكيد الخروج
            </Button>
          </>
        }
      >
        {discharge && (
          <div className="space-y-3">
            <Select
              label="وجهة الخروج"
              value={discharge.dischargeType}
              onChange={(e) => setDischarge({ ...discharge, dischargeType: e.target.value })}
            >
              <option value="home">خروج إلى المنزل</option>
              <option value="transfer">تحويل إلى منشأة أخرى</option>
              <option value="deceased">وفاة</option>
              <option value="against_advice">خروج ضد النصيحة الطبية (AMA)</option>
            </Select>
            <Textarea
              label="ملخص الخروج الطبي وتعليمات الأدوية (20 حرفًا على الأقل)"
              rows={4}
              required
              value={discharge.summary}
              onChange={(e) => setDischarge({ ...discharge, summary: e.target.value })}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

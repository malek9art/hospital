import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
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
  PollingControl,
  Select,
  Textarea,
  useToast,
} from '../components';
import { usePolling } from '../hooks/usePolling';

const LEVELS: Record<number, { ar: string; cls: string }> = {
  1: { ar: '١ — إنعاش فوري', cls: 'bg-rose-700 text-white' },
  2: { ar: '٢ — حرج جدًا', cls: 'bg-orange-600 text-white' },
  3: { ar: '٣ — عاجل', cls: 'bg-amber-400 text-slate-950' },
  4: { ar: '٤ — أقل إلحاحًا', cls: 'bg-sky-200 text-slate-900' },
  5: { ar: '٥ — غير عاجل', cls: 'bg-slate-200 text-slate-800' },
};

export default function EmergencyPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [board, setBoard] = useState<any>(null);
  const [patients, setPatients] = useState<any[]>([]);
  const [freeBeds, setFreeBeds] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    patientId: '',
    unidentified: false,
    sex: 'male',
    age: '',
    chiefComplaint: '',
    level: '3',
    notes: '',
    hr: '',
    sbp: '',
    spo2: '',
    temp: '',
  });

  const [action, setAction] = useState<{
    kind: 'retriage' | 'discharge' | 'admit';
    encounterId: string;
    patientName: string;
    level: string;
    reason: string;
    summary: string;
    bedId: string;
  } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [b, p] = await Promise.all([
        api<any>('/api/emergency/board'),
        has(auth, 'patient.read') ? api<any>('/api/patients?limit=100') : Promise.resolve({ items: [] }),
      ]);
      setBoard(b);
      setPatients(p.items ?? []);
      if (has(auth, 'inpatient.admit')) {
        const beds = await api<any>('/api/inpatient/beds');
        setFreeBeds((beds.beds ?? []).filter((x: any) => x.bed_status === 'available'));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل لوحة الطوارئ');
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    load();
  }, [load]);

  const polling = usePolling(load, { intervalMs: 25_000, enabled: true });

  async function register(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const vitals: Record<string, number> = {};
      if (form.hr) vitals.heartRate = Number(form.hr);
      if (form.sbp) vitals.systolicBp = Number(form.sbp);
      if (form.spo2) vitals.spo2 = Number(form.spo2);
      if (form.temp) vitals.temperatureC = Number(form.temp);
      const payload: Record<string, unknown> = {
        chiefComplaint: form.chiefComplaint,
        level: Number(form.level),
        notes: form.notes || undefined,
        vitals: Object.keys(vitals).length ? vitals : undefined,
      };
      if (form.unidentified) {
        payload.unidentified = { sex: form.sex, estimatedAge: form.age ? Number(form.age) : undefined };
      } else {
        payload.patientId = form.patientId;
      }
      const r = await api<{ temporaryIdentity?: boolean }>('/api/emergency/arrivals', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast.success(
        r.temporaryIdentity
          ? 'تم تسجيل وصول مجهول الهوية برقم مؤقت — يمكن مطابقته لاحقًا'
          : 'تم تسجيل الوصول وتحديد مستوى الفرز',
      );
      setForm({ ...form, patientId: '', chiefComplaint: '', notes: '', hr: '', sbp: '', spo2: '', temp: '' });
      await load();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر تسجيل الوصول');
    } finally {
      setSaving(false);
    }
  }

  async function submitAction() {
    if (!action) return;
    setSaving(true);
    try {
      if (action.kind === 'retriage') {
        await api(`/api/emergency/visits/${action.encounterId}/retriage`, {
          method: 'POST',
          body: JSON.stringify({ level: Number(action.level), reason: action.reason }),
        });
        toast.success('تم تحديث مستوى الفرز بسبب موثّق');
      } else if (action.kind === 'discharge') {
        await api(`/api/emergency/visits/${action.encounterId}/disposition`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'discharge', dischargeType: 'home', summary: action.summary }),
        });
        toast.success('تم إنهاء زيارة الطوارئ واحتساب رسم الزيارة');
      } else {
        await api(`/api/emergency/visits/${action.encounterId}/disposition`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'admit', bedId: action.bedId || undefined }),
        });
        toast.success('تم تحويل المريض إلى قسم التنويم');
      }
      setAction(null);
      await load();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'فشلت العملية');
    } finally {
      setSaving(false);
    }
  }

  if (err && !board) return <ErrorState message={err} onRetry={load} />;
  if (loading && !board) return <PageSkeleton cards={5} rows={5} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="قسم الطوارئ والفرز (CTAS 1–5)"
        subtitle="الترتيب في اللوحة حسب مستوى الخطورة ثم وقت الوصول، مع تنبيه فوري للمستويات 1 و2."
        actions={
          <PollingControl
            enabled={polling.enabled}
            onToggle={polling.setEnabled}
            lastUpdatedAt={polling.lastUpdatedAt}
            busy={polling.busy}
            onRefresh={polling.refreshNow}
          />
        }
      />

      {board && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((l) => (
            <div key={l} className={`rounded-xl p-3 text-center shadow-xs ${LEVELS[l].cls}`}>
              <p className="text-xs font-semibold">{LEVELS[l].ar}</p>
              <p className="text-2xl font-bold mt-0.5">{board.byLevel?.[l] ?? 0}</p>
            </div>
          ))}
        </div>
      )}

      <Card title="تسجيل وصول جديد للطوارئ">
        <form onSubmit={register} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="sm:col-span-2">
            <label className="label">المريض</label>
            <div className="flex items-center gap-2">
              <select
                aria-label="اختيار المريض"
                className="input"
                disabled={form.unidentified}
                value={form.patientId}
                onChange={(e) => setForm({ ...form, patientId: e.target.value })}
              >
                <option value="">— اختر مريضًا مسجلًا —</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullNameAr} · {p.mrn}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={form.unidentified}
                  onChange={(e) => setForm({ ...form, unidentified: e.target.checked, patientId: '' })}
                />
                مجهول الهوية
              </label>
            </div>
          </div>

          {form.unidentified && (
            <>
              <Select
                label="الجنس الظاهري"
                value={form.sex}
                onChange={(e) => setForm({ ...form, sex: e.target.value })}
              >
                <option value="male">ذكر</option>
                <option value="female">أنثى</option>
                <option value="other">غير محدد</option>
              </Select>
              <Input
                label="العمر التقريبي"
                type="number"
                value={form.age}
                onChange={(e) => setForm({ ...form, age: e.target.value })}
              />
            </>
          )}

          <div className="sm:col-span-2">
            <Input
              label="الشكوى الرئيسية"
              required
              value={form.chiefComplaint}
              onChange={(e) => setForm({ ...form, chiefComplaint: e.target.value })}
              placeholder="مثال: ألم صدري حاد وضيق تنفس"
            />
          </div>

          <Select
            label="مستوى الفرز"
            value={form.level}
            onChange={(e) => setForm({ ...form, level: e.target.value })}
          >
            {[1, 2, 3, 4, 5].map((l) => (
              <option key={l} value={l}>
                {LEVELS[l].ar}
              </option>
            ))}
          </Select>

          <div className="grid grid-cols-4 gap-1.5 sm:col-span-2">
            <Input label="نبض" type="number" value={form.hr} onChange={(e) => setForm({ ...form, hr: e.target.value })} />
            <Input label="انقباضي" type="number" value={form.sbp} onChange={(e) => setForm({ ...form, sbp: e.target.value })} />
            <Input label="SpO₂" type="number" value={form.spo2} onChange={(e) => setForm({ ...form, spo2: e.target.value })} />
            <Input label="حرارة" type="number" step="0.1" value={form.temp} onChange={(e) => setForm({ ...form, temp: e.target.value })} />
          </div>

          <div className="flex items-end">
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              busy={saving}
              disabled={!form.chiefComplaint || (!form.patientId && !form.unidentified)}
            >
              تسجيل وفرز
            </Button>
          </div>
        </form>
      </Card>

      <Card title="لوحة الحالات النشطة في الطوارئ">
        <DataTable
          caption="حالات الطوارئ النشطة"
          rows={board?.items ?? []}
          rowKey={(i) => i.id}
          rowClassName={(i) => (i.level <= 2 ? 'bg-rose-50/60' : '')}
          emptyTitle="لا توجد حالات نشطة في قسم الطوارئ حاليًا"
          cardTitle={(i) => i.patient_name}
          cardSubtitle={(i) => `${i.mrn} · ${i.chief_complaint}`}
          cardBadge={(i) => <span className={`badge ${LEVELS[i.level]?.cls ?? ''}`}>{LEVELS[i.level]?.ar}</span>}
          cardActions={(i) => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setAction({
                    kind: 'retriage',
                    encounterId: i.encounter_id,
                    patientName: i.patient_name,
                    level: String(i.level),
                    reason: '',
                    summary: '',
                    bedId: '',
                  })
                }
              >
                إعادة فرز
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setAction({
                    kind: 'discharge',
                    encounterId: i.encounter_id,
                    patientName: i.patient_name,
                    level: String(i.level),
                    reason: '',
                    summary: '',
                    bedId: '',
                  })
                }
              >
                خروج
              </Button>
              {has(auth, 'inpatient.admit') && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    setAction({
                      kind: 'admit',
                      encounterId: i.encounter_id,
                      patientName: i.patient_name,
                      level: String(i.level),
                      reason: '',
                      summary: '',
                      bedId: '',
                    })
                  }
                >
                  تنويم
                </Button>
              )}
            </div>
          )}
          columns={[
            {
              key: 'lv',
              header: 'مستوى الفرز',
              render: (i) => (
                <div>
                  <span className={`badge ${LEVELS[i.level]?.cls ?? ''}`}>{LEVELS[i.level]?.ar}</span>
                  {i.previous_level && (
                    <span className="block text-[10px] text-slate-500 mt-0.5">سابقًا: {i.previous_level}</span>
                  )}
                </div>
              ),
            },
            {
              key: 'pt',
              header: 'المريض',
              render: (i) => (
                <div>
                  <span className="font-semibold">{i.patient_name}</span>
                  <span className="block text-xs text-slate-400">
                    {i.mrn}
                    {i.identity_status === 'unverified_temporary' && ' · مجهول الهوية'}
                  </span>
                </div>
              ),
            },
            { key: 'cc', header: 'الشكوى الرئيسية', render: (i) => i.chief_complaint },
            {
              key: 'wait',
              header: 'الانتظار',
              render: (i) => (
                <span className={`font-bold ${i.waiting_minutes > 30 && i.level >= 3 ? 'text-rose-700' : ''}`}>
                  {i.waiting_minutes} د
                </span>
              ),
            },
            {
              key: 'vitals',
              header: 'آخر علامات',
              render: (i) => (
                <span className="text-xs">
                  {i.last_hr ? `نبض ${i.last_hr}` : '—'}
                  {i.last_sbp ? ` · ضغط ${i.last_sbp}` : ''}
                  {i.last_spo2 ? ` · SpO₂ ${i.last_spo2}%` : ''}
                </span>
              ),
            },
            {
              key: 'st',
              header: 'الحالة',
              render: (i) => <Badge value={i.status === 'in_treatment' ? 'in_consultation' : 'open'} />,
            },
            {
              key: 'act',
              header: 'إجراءات',
              hideInCard: true,
              render: (i) => (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setAction({
                        kind: 'retriage',
                        encounterId: i.encounter_id,
                        patientName: i.patient_name,
                        level: String(i.level),
                        reason: '',
                        summary: '',
                        bedId: '',
                      })
                    }
                  >
                    إعادة فرز
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setAction({
                        kind: 'discharge',
                        encounterId: i.encounter_id,
                        patientName: i.patient_name,
                        level: String(i.level),
                        reason: '',
                        summary: '',
                        bedId: '',
                      })
                    }
                  >
                    خروج
                  </Button>
                  {has(auth, 'inpatient.admit') && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        setAction({
                          kind: 'admit',
                          encounterId: i.encounter_id,
                          patientName: i.patient_name,
                          level: String(i.level),
                          reason: '',
                          summary: '',
                          bedId: '',
                        })
                      }
                    >
                      تنويم
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={!!action}
        onClose={() => setAction(null)}
        title={
          action?.kind === 'retriage'
            ? `إعادة فرز — ${action.patientName}`
            : action?.kind === 'discharge'
              ? `خروج من الطوارئ — ${action?.patientName}`
              : `تحويل للتنويم — ${action?.patientName}`
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setAction(null)}>
              إلغاء
            </Button>
            <Button
              variant="primary"
              busy={saving}
              disabled={
                action?.kind === 'retriage'
                  ? action.reason.trim().length < 5
                  : action?.kind === 'discharge'
                    ? action.summary.trim().length < 10
                    : false
              }
              onClick={submitAction}
            >
              تأكيد الإجراء
            </Button>
          </>
        }
      >
        {action?.kind === 'retriage' && (
          <div className="space-y-3">
            <Select
              label="مستوى الفرز الجديد"
              value={action.level}
              onChange={(e) => setAction({ ...action, level: e.target.value })}
            >
              {[1, 2, 3, 4, 5].map((l) => (
                <option key={l} value={l}>
                  {LEVELS[l].ar}
                </option>
              ))}
            </Select>
            <Input
              label="سبب تعديل مستوى الفرز (5 أحرف على الأقل)"
              required
              value={action.reason}
              onChange={(e) => setAction({ ...action, reason: e.target.value })}
            />
          </div>
        )}
        {action?.kind === 'discharge' && (
          <Textarea
            label="ملخص الخروج وتعليمات المتابعة (10 أحرف على الأقل)"
            rows={4}
            required
            value={action.summary}
            onChange={(e) => setAction({ ...action, summary: e.target.value })}
          />
        )}
        {action?.kind === 'admit' && (
          <Select
            label="تخصيص سرير متاح (اختياري)"
            value={action.bedId}
            onChange={(e) => setAction({ ...action, bedId: e.target.value })}
          >
            <option value="">بدون سرير حاليًا (بانتظار تخصيص سرير)</option>
            {freeBeds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.ward_name} · غرفة {b.room_no} / سرير {b.bed_no}
              </option>
            ))}
          </Select>
        )}
      </Modal>
    </div>
  );
}

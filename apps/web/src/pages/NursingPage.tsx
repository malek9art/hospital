import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  ReasonDialog,
  Select,
  StatCard,
  useToast,
} from '../components';
import { formatDateTime } from '../lib/format';

const SHIFT_LABEL: Record<string, string> = { morning: 'صباحية', evening: 'مسائية', night: 'ليلية' };
const CONDITION_LABEL: Record<string, string> = {
  stable: 'مستقرة',
  improving: 'تتحسن',
  deteriorating: 'متدهورة',
  critical: 'حرجة',
};
const MAR_LABEL: Record<string, string> = {
  given: 'أُعطي',
  held: 'أُوقف',
  refused: 'رفض المريض',
  missed: 'فائت',
};

export default function NursingPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [board, setBoard] = useState<any>(null);
  const [active, setActive] = useState<any>(null);
  const [mar, setMar] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [handovers, setHandovers] = useState<any[]>([]);
  const [nurses, setNurses] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [dose, setDose] = useState({
    itemId: '',
    status: 'given',
    doseGiven: '',
    route: 'فموي',
    reason: '',
    witnessUserId: '',
    identity: false,
    allergy: false,
  });
  const [planForm, setPlanForm] = useState({ title: '', diagnosis: '', goals: '', task: '' });
  const [handoverForm, setHandoverForm] = useState({
    shift: 'evening',
    condition: 'stable',
    situation: '',
    background: '',
    assessment: '',
    recommendation: '',
  });

  // Replaces both window.prompt calls in Nursing!
  const [skipTaskTarget, setSkipTaskTarget] = useState<{ id: string; description: string } | null>(null);
  const [closePlanTarget, setClosePlanTarget] = useState<{ id: string; title: string } | null>(null);

  const loadBoard = useCallback(async () => {
    setErr(null);
    try {
      const b = await api<any>('/api/nursing/board');
      setBoard(b);
      if (active) {
        const current = (b.items ?? []).find((i: any) => i.admission_id === active.admission_id);
        if (current) setActive(current);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل لوحة التمريض');
    } finally {
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    loadBoard();
  }, []);

  async function openPatient(item: any) {
    setActive(item);
    try {
      const [m1, p, h] = await Promise.all([
        api<any>(`/api/nursing/patients/${item.patient_id}/mar`),
        api<any>(`/api/nursing/care-plans?admissionId=${item.admission_id}`),
        api<any>(`/api/nursing/handovers?admissionId=${item.admission_id}`),
      ]);
      setMar(m1);
      setPlans(p.plans ?? []);
      setHandovers(h.items ?? []);
      if (m1.due?.[0]) {
        setDose((d) => ({
          ...d,
          itemId: m1.due[0].itemId,
          doseGiven: m1.due[0].dose,
          route: m1.due[0].route,
        }));
      }
      if (nurses.length === 0) {
        const w = await api<any>('/api/nursing/witnesses');
        setNurses(w.items ?? []);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تحميل الملف التمريضي');
    }
  }

  async function refreshAll() {
    if (active) await openPatient(active);
    await loadBoard();
  }

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await refreshAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'فشلت العملية');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  if (err && !board) return <ErrorState message={err} onRetry={loadBoard} />;
  if (loading && !board) return <PageSkeleton cards={3} rows={6} />;

  const dueDoses = mar?.due ?? [];
  const selectedDose = dueDoses.find((d: any) => d.itemId === dose.itemId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="الرعاية التمريضية وسجل إعطاء الأدوية (MAR)"
        subtitle="إدارة الجرعات، الشاهد الثاني للأدوية عالية الخطورة، خطط الرعاية، وتسليم المناوبات (SBAR)."
      />

      {board && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="المرضى المنوّمون حاليًا" value={board.totals.patients} />
          <StatCard
            label="جرعات دوائية متأخرة"
            value={board.totals.overdue_medications}
            tone={board.totals.overdue_medications > 0 ? 'danger' : 'success'}
          />
          <StatCard
            label="مهام رعاية مستحقة"
            value={board.totals.due_tasks}
            tone={board.totals.due_tasks > 0 ? 'warning' : 'default'}
          />
        </div>
      )}

      <Card title="لوحة جناح التمريض">
        <DataTable
          caption="قائمة مرضى الجناح للتمريض"
          rows={board?.items ?? []}
          rowKey={(i) => i.admission_id}
          rowClassName={(i) => (i.next_due?.overdueMinutes > 0 ? 'bg-amber-50/70' : '')}
          emptyTitle="لا يوجد مرضى منوّمون في الجناح حاليًا"
          cardTitle={(i) => i.patient_name}
          cardSubtitle={(i) => `${i.bed_no ? `${i.ward_name} · ${i.room_no}/${i.bed_no}` : 'بدون سرير'} · ${i.mrn}`}
          cardBadge={(i) =>
            i.next_due?.overdueMinutes > 0 ? (
              <Badge value="critical_high" label={`متأخرة ${i.next_due.overdueMinutes} د`} />
            ) : null
          }
          cardActions={(i) => (
            <Button variant="primary" size="sm" onClick={() => openPatient(i)}>
              فتح الملف التمريضي
            </Button>
          )}
          columns={[
            {
              key: 'bed',
              header: 'السرير',
              render: (i) => (i.bed_no ? `${i.ward_name} · ${i.room_no}/${i.bed_no}` : 'بدون سرير'),
            },
            {
              key: 'pt',
              header: 'المريض',
              render: (i) => (
                <div>
                  <span className="font-semibold">{i.patient_name}</span>
                  <span className="block text-xs text-slate-400">
                    {i.mrn} · {i.doctor_name}
                  </span>
                </div>
              ),
            },
            {
              key: 'vitals',
              header: 'آخر علامات حيوية',
              render: (i) => {
                const v = i.last_vitals;
                return v
                  ? `نبض ${v.heart_rate ?? '—'} · ضغط ${v.systolic_bp ?? '—'}/${v.diastolic_bp ?? '—'} · SpO₂ ${v.spo2 ?? '—'}%`
                  : '—';
              },
            },
            {
              key: 'due',
              header: 'الجرعة القادمة',
              render: (i) => {
                if (!i.next_due) return '—';
                const overdue = i.next_due.overdueMinutes > 0;
                return (
                  <div className="text-xs">
                    <span className="font-medium">{i.next_due.drug}</span>
                    <span className={`block ${overdue ? 'text-rose-700 font-bold' : 'text-slate-500'}`}>
                      {overdue
                        ? `متأخرة ${i.next_due.overdueMinutes} د`
                        : `بعد ${Math.max(0, Math.round((new Date(i.next_due.nextDueAt).getTime() - Date.now()) / 60000))} د`}
                    </span>
                  </div>
                );
              },
            },
            {
              key: 'tasks',
              header: 'مهام الرعاية',
              render: (i) => <span className="text-xs">{i.due_tasks} مستحقة / {i.open_tasks} مفتوحة</span>,
            },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (i) => (
                <Button variant="primary" size="sm" onClick={() => openPatient(i)}>
                  الملف التمريضي
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {active && (
        <div className="grid lg:grid-cols-2 gap-4">
          {/* MAR Card */}
          <Card
            title={`سجل إعطاء الأدوية (MAR) — ${active.patient_name}`}
            action={
              <Button variant="ghost" size="sm" onClick={() => setActive(null)}>
                إغلاق
              </Button>
            }
          >
            {dueDoses.length === 0 ? (
              <EmptyState title="لا توجد أدوية مصروفة مستحقة لهذا المريض" />
            ) : (
              <div className="space-y-2.5">
                <Select
                  label="الدواء المستحق"
                  value={dose.itemId}
                  onChange={(e) => {
                    const d = dueDoses.find((x: any) => x.itemId === e.target.value);
                    setDose({ ...dose, itemId: e.target.value, doseGiven: d?.dose ?? '', route: d?.route ?? 'فموي' });
                  }}
                >
                  {dueDoses.map((d: any) => (
                    <option key={d.itemId} value={d.itemId}>
                      {d.drug} · {d.dose} · {d.frequency}
                      {d.highAlert ? ' · ⚠ عالي الخطورة' : ''}
                    </option>
                  ))}
                </Select>

                <div className="grid grid-cols-2 gap-2">
                  <Select
                    label="حالة الإعطاء"
                    value={dose.status}
                    onChange={(e) => setDose({ ...dose, status: e.target.value })}
                  >
                    <option value="given">أُعطي للمريض</option>
                    <option value="held">إيقاف مؤقت</option>
                    <option value="refused">رفض المريض</option>
                    <option value="missed">فائت</option>
                  </Select>
                  <Input
                    label="الجرعة المعطاة"
                    value={dose.doseGiven}
                    onChange={(e) => setDose({ ...dose, doseGiven: e.target.value })}
                  />
                  <Input
                    label="مسار الإعطاء"
                    value={dose.route}
                    onChange={(e) => setDose({ ...dose, route: e.target.value })}
                  />
                  <Select
                    label="الشاهد الثاني (للأدوية عالية الخطورة)"
                    value={dose.witnessUserId}
                    onChange={(e) => setDose({ ...dose, witnessUserId: e.target.value })}
                  >
                    <option value="">— بدون شاهد —</option>
                    {nurses
                      .filter((n) => n.id !== auth.user.id)
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.full_name_ar}
                        </option>
                      ))}
                  </Select>
                </div>

                {dose.status !== 'given' && (
                  <Input
                    label="سبب عدم الإعطاء (5 أحرف على الأقل)"
                    required
                    value={dose.reason}
                    onChange={(e) => setDose({ ...dose, reason: e.target.value })}
                  />
                )}

                {dose.status === 'given' && (
                  <div className="flex flex-wrap gap-4 text-xs pt-1">
                    <label className="flex items-center gap-1.5 font-medium">
                      <input
                        type="checkbox"
                        checked={dose.identity}
                        onChange={(e) => setDose({ ...dose, identity: e.target.checked })}
                      />
                      تحققت من هوية المريض وسوار المعصم
                    </label>
                    <label className="flex items-center gap-1.5 font-medium">
                      <input
                        type="checkbox"
                        checked={dose.allergy}
                        onChange={(e) => setDose({ ...dose, allergy: e.target.checked })}
                      />
                      تحققت من سجل الحساسية
                    </label>
                  </div>
                )}

                {selectedDose?.highAlert && dose.status === 'given' && (
                  <p className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">
                    ⚠ دواء عالي الخطورة: يشترط توثيق شاهد تمريضي ثانٍ مختلف عن المعطي (فصل مهام).
                  </p>
                )}

                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  disabled={!dose.itemId || (dose.status !== 'given' && dose.reason.trim().length < 5)}
                  onClick={() =>
                    act(
                      () =>
                        api('/api/nursing/mar', {
                          method: 'POST',
                          body: JSON.stringify({
                            prescriptionItemId: dose.itemId,
                            status: dose.status,
                            doseGiven: dose.status === 'given' ? dose.doseGiven : undefined,
                            route: dose.status === 'given' ? dose.route : undefined,
                            identityVerified: dose.identity,
                            allergyChecked: dose.allergy,
                            witnessUserId: dose.witnessUserId || undefined,
                            reason: dose.status === 'given' ? undefined : dose.reason,
                          }),
                        }),
                      'تم توثيق سجل إعطاء الدواء',
                    ).catch(() => {})
                  }
                >
                  توثيق في سجل MAR
                </Button>
              </div>
            )}

            <div className="mt-4 border-t border-slate-100 pt-3">
              <h3 className="text-xs font-bold text-slate-700 mb-2">سجل الجرعات السابقة</h3>
              <ul className="text-xs space-y-1.5 max-h-48 overflow-y-auto">
                {(mar?.history ?? []).slice(0, 15).map((h: any) => (
                  <li key={h.id} className={h.corrects_id ? 'text-slate-400 line-through' : ''}>
                    {formatDateTime(h.administered_at)} — <b>{h.drug}</b> {h.dose_given ?? ''} ·{' '}
                    <span className={h.status === 'given' ? 'text-emerald-700 font-semibold' : 'text-rose-700 font-semibold'}>
                      {MAR_LABEL[h.status]}
                    </span>
                    {h.witness_name && ` · شاهد: ${h.witness_name}`}
                    {h.reason && ` · (${h.reason})`}
                  </li>
                ))}
                {(mar?.history ?? []).length === 0 && <li className="text-slate-400">لا توجد جرعات سابقة.</li>}
              </ul>
            </div>
          </Card>

          {/* Care Plans Card */}
          <Card title="خطط الرعاية التمريضية">
            {plans.length === 0 && <p className="text-xs text-slate-500 mb-3">لا توجد خطة رعاية نشطة بعد.</p>}
            <div className="space-y-2.5">
              {plans.map((p) => (
                <div key={p.id} className="border border-slate-200 rounded-xl p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-sm text-slate-900">{p.title}</span>
                    <Badge value={p.status === 'active' ? 'open' : 'completed'} />
                  </div>
                  <p className="text-xs text-slate-600">{p.nursing_diagnosis}</p>
                  <p className="text-xs">
                    <span className="text-slate-500">الأهداف:</span> {p.goals}
                  </p>
                  <ul className="text-xs space-y-1 pt-1">
                    {(p.tasks ?? []).map((t: any) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 bg-slate-50 rounded-lg px-2.5 py-1.5">
                        <span className={t.status !== 'pending' ? 'line-through text-slate-400' : ''}>
                          {t.description} {t.due_at && <span className="text-slate-400">· {formatDateTime(t.due_at)}</span>}
                        </span>
                        {t.status === 'pending' && has(auth, 'nursing.mar.administer') && p.status === 'active' && (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                act(
                                  () =>
                                    api(`/api/nursing/care-plan-tasks/${t.id}/complete`, {
                                      method: 'POST',
                                      body: JSON.stringify({ status: 'done' }),
                                    }),
                                  'أُنجزت المهمة التمريضية',
                                ).catch(() => {})
                              }
                            >
                              إنجاز
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={() => setSkipTaskTarget({ id: t.id, description: t.description })}
                            >
                              تخطٍّ بسبب
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  {p.status === 'active' && has(auth, 'nursing.careplan.manage') && (
                    <div className="pt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setClosePlanTarget({ id: p.id, title: p.title })}
                      >
                        إغلاق الخطة (تحقق الهدف)
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {has(auth, 'nursing.careplan.manage') && (
              <div className="border-t border-slate-200 mt-3 pt-3 space-y-2">
                <p className="text-xs font-bold text-slate-700">إنشاء خطة رعاية جديدة</p>
                <Input
                  label="عنوان الخطة"
                  value={planForm.title}
                  onChange={(e) => setPlanForm({ ...planForm, title: e.target.value })}
                />
                <Input
                  label="التشخيص التمريضي"
                  value={planForm.diagnosis}
                  onChange={(e) => setPlanForm({ ...planForm, diagnosis: e.target.value })}
                />
                <Input
                  label="الأهداف المتوقعة"
                  value={planForm.goals}
                  onChange={(e) => setPlanForm({ ...planForm, goals: e.target.value })}
                />
                <Input
                  label="أول مهمة رعاية (اختياري)"
                  value={planForm.task}
                  onChange={(e) => setPlanForm({ ...planForm, task: e.target.value })}
                />
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  disabled={
                    planForm.title.trim().length < 3 ||
                    planForm.diagnosis.trim().length < 5 ||
                    planForm.goals.trim().length < 5
                  }
                  onClick={() =>
                    act(
                      () =>
                        api('/api/nursing/care-plans', {
                          method: 'POST',
                          body: JSON.stringify({
                            encounterId: active.encounter_id,
                            title: planForm.title,
                            nursingDiagnosis: planForm.diagnosis,
                            goals: planForm.goals,
                            tasks: planForm.task.trim() ? [{ description: planForm.task.trim() }] : [],
                          }),
                        }),
                      'أُنشئت خطة الرعاية التمريضية',
                    )
                      .then(() => setPlanForm({ title: '', diagnosis: '', goals: '', task: '' }))
                      .catch(() => {})
                  }
                >
                  إنشاء الخطة
                </Button>
              </div>
            )}
          </Card>

          {/* SBAR Handover Card */}
          <div className="lg:col-span-2">
            <Card title={`تسليم المناوبة التمريضية (SBAR) — ${handovers.length} سجل`}>
              <div className="grid md:grid-cols-2 gap-3">
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {handovers.map((h) => (
                    <div key={h.id} className="border border-slate-200 rounded-xl p-3 text-xs space-y-1">
                      <div className="flex justify-between text-slate-500">
                        <span>
                          {SHIFT_LABEL[h.shift]} · {formatDateTime(h.handed_over_at)}
                        </span>
                        <span>
                          {CONDITION_LABEL[h.patient_condition]} · من {h.from_name}
                        </span>
                      </div>
                      <p>
                        <b>S:</b> {h.situation}
                      </p>
                      <p>
                        <b>B:</b> {h.background}
                      </p>
                      <p>
                        <b>A:</b> {h.assessment}
                      </p>
                      <p>
                        <b>R:</b> {h.recommendation}
                      </p>
                      {h.acknowledged_at ? (
                        <p className="text-emerald-700 font-semibold pt-1">
                          ✓ استُلم بواسطة {h.acknowledged_by_name} — {formatDateTime(h.acknowledged_at)}
                        </p>
                      ) : (
                        has(auth, 'nursing.read') &&
                        h.from_user_id !== auth.user.id && (
                          <Button
                            variant="primary"
                            size="sm"
                            className="mt-1"
                            onClick={() =>
                              act(
                                () => api(`/api/nursing/handovers/${h.id}/acknowledge`, { method: 'POST' }),
                                'تم توثيق استلام المناوبة',
                              ).catch(() => {})
                            }
                          >
                            استلام التسليم (فصل مهام)
                          </Button>
                        )
                      )}
                    </div>
                  ))}
                  {handovers.length === 0 && <EmptyState title="لا توجد تسليمات سابقة" />}
                </div>

                {has(auth, 'nursing.handover.write') && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label="المناوبة"
                        value={handoverForm.shift}
                        onChange={(e) => setHandoverForm({ ...handoverForm, shift: e.target.value })}
                      >
                        <option value="morning">صباحية</option>
                        <option value="evening">مسائية</option>
                        <option value="night">ليلية</option>
                      </Select>
                      <Select
                        label="حالة المريض"
                        value={handoverForm.condition}
                        onChange={(e) => setHandoverForm({ ...handoverForm, condition: e.target.value })}
                      >
                        {Object.entries(CONDITION_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {(
                      [
                        ['situation', 'الوضع الحالي (S — 10 أحرف على الأقل)'],
                        ['background', 'الخلفية المرضية (B — 10 أحرف على الأقل)'],
                        ['assessment', 'التقييم التمريضي (A — 10 أحرف على الأقل)'],
                        ['recommendation', 'التوصية للمناوبة التالية (R — 10 أحرف على الأقل)'],
                      ] as const
                    ).map(([k, label]) => (
                      <Input
                        key={k}
                        label={label}
                        value={handoverForm[k]}
                        onChange={(e) => setHandoverForm({ ...handoverForm, [k]: e.target.value })}
                      />
                    ))}
                    <Button
                      variant="primary"
                      size="sm"
                      busy={busy}
                      disabled={(['situation', 'background', 'assessment', 'recommendation'] as const).some(
                        (k) => handoverForm[k].trim().length < 10,
                      )}
                      onClick={() =>
                        act(
                          () =>
                            api('/api/nursing/handovers', {
                              method: 'POST',
                              body: JSON.stringify({
                                encounterId: active.encounter_id,
                                ...handoverForm,
                              }),
                            }),
                          'تم حفظ تسليم المناوبة (سجل غير قابل للتعديل)',
                        )
                          .then(() =>
                            setHandoverForm({
                              ...handoverForm,
                              situation: '',
                              background: '',
                              assessment: '',
                              recommendation: '',
                            }),
                          )
                          .catch(() => {})
                      }
                    >
                      توثيق تسليم المناوبة
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ReasonDialog #1: Skip Care Plan Task */}
      <ReasonDialog
        open={!!skipTaskTarget}
        onClose={() => setSkipTaskTarget(null)}
        title="توثيق سبب تخطي المهمة التمريضية"
        consequenceNote={`سيتم تعليم المهمة «${skipTaskTarget?.description ?? ''}» كمتخطاة وحفظ السبب في سجل الرعاية والتدقيق.`}
        minLength={5}
        confirmLabel="تأكيد التخطي"
        variant="danger"
        onConfirm={async (note) => {
          if (!skipTaskTarget) return;
          await act(
            () =>
              api(`/api/nursing/care-plan-tasks/${skipTaskTarget.id}/complete`, {
                method: 'POST',
                body: JSON.stringify({ status: 'skipped', note }),
              }),
            'تم تخطي المهمة بسبب موثّق',
          );
        }}
      />

      {/* ReasonDialog #2: Close Care Plan */}
      <ReasonDialog
        open={!!closePlanTarget}
        onClose={() => setClosePlanTarget(null)}
        title="إغلاق خطة الرعاية التمريضية"
        consequenceNote={`سيتم إغلاق الخطة «${closePlanTarget?.title ?? ''}» كهدف متحقق مع حفظ مبرر الإغلاق نهائيًا.`}
        minLength={5}
        confirmLabel="إغلاق الخطة"
        variant="primary"
        onConfirm={async (reason) => {
          if (!closePlanTarget) return;
          await act(
            () =>
              api(`/api/nursing/care-plans/${closePlanTarget.id}/close`, {
                method: 'POST',
                body: JSON.stringify({ status: 'achieved', reason }),
              }),
            'أُغلقت خطة الرعاية بنجاح',
          );
        }}
      />
    </div>
  );
}

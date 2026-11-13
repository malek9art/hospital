import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, has, hasAny, type Me } from '../api';
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
  ReasonDialog,
  Select,
  StatCard,
  Textarea,
  useToast,
} from '../components';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime, formatMoney, formatNumber } from '../lib/format';

const MODALITY_LABELS: Record<string, string> = {
  therapeutic_exercise: 'تمارين علاجية وتقوية عضلية',
  manual_therapy: 'علاج يدوي وتحريك مفاصل',
  electrotherapy: 'علاج كهربائي (TENS / EMS)',
  ultrasound_therapy: 'موجات فوق صوتية علاجية',
  hydrotherapy: 'علاج مائي تأهيلي',
  gait_training: 'تدريب المشي والتوازن الوظيفي',
  neuro_rehab: 'تأهيل عصبي وحركي',
  post_op_rehab: 'تأهيل ما بعد العمليات الجراحية',
  chest_physio: 'علاج طبيعي صدري وتنفسي',
};

const TOLERANCE_LABELS: Record<string, string> = {
  excellent: 'ممتاز — تحمّل كامل دون إجهاد',
  good: 'جيد — استجابة مستقرة',
  fair: 'متوسط — إجهاد بسيط محتمل',
  poor: 'ضعيف — إجهاد سريع يستلزم تخفيف الشدة',
};

export default function PhysiotherapyPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [status, setStatus] = useState('active');
  const [totals, setTotals] = useState<any>(null);
  const [referrals, setReferrals] = useState<any[]>([]);
  const [openEncounters, setOpenEncounters] = useState<any[]>([]);
  const [therapists, setTherapists] = useState<any[]>([]);
  const [detail, setDetail] = useState<{ referral: any; sessions: any[] } | null>(null);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Modals
  const [referOpen, setReferOpen] = useState(false);
  const [assessOpen, setAssessOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [completeSessTarget, setCompleteSessTarget] = useState<any | null>(null);
  const [cancelRefOpen, setCancelRefOpen] = useState(false);

  const [referForm, setReferForm] = useState({
    encounterId: '',
    diagnosisSummary: '',
    bodyRegion: '',
    modalityPlan: 'therapeutic_exercise',
    precautions: '',
    totalSessions: '6',
    priority: 'routine',
    assignedTherapistId: '',
  });

  const [assessForm, setAssessForm] = useState({
    initialAssessment: '',
    rehabGoals: '',
    baselinePainScore: '7',
    baselineMobilityScore: '5',
  });

  const [sessionForm, setSessionForm] = useState({
    modality: 'therapeutic_exercise',
    durationMinutes: '45',
    fee: '180',
    painBefore: '6',
    painAfter: '3',
    romNotes: '',
    progressNotes: '',
    patientTolerance: 'good',
    completeImmediately: true,
  });

  const canRefer = has(auth, 'physio.refer');
  const canPerform = has(auth, 'physio.perform');
  const canCancel = hasAny(auth, ['physio.refer', 'physio.perform']);

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      const board = await api<any>('/api/physio/board');
      const refs = board.referrals ?? [];
      const encs = board.openEncounters ?? [];
      const ths = board.therapists ?? [];

      setTotals(board.totals ?? null);
      setReferrals(refs);
      setOpenEncounters(encs);
      setTherapists(ths);

      setReferForm((prev) => ({
        ...prev,
        encounterId: prev.encounterId || encs[0]?.id || '',
        assignedTherapistId: prev.assignedTherapistId || ths[0]?.id || '',
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات العلاج الطبيعي والتأهيل');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const polling = usePolling(loadAll, { intervalMs: 30_000, enabled: true });

  const filteredReferrals = useMemo(() => {
    if (status === 'all') return referrals;
    if (status === 'active') return referrals.filter((r) => ['referred', 'active'].includes(r.status));
    return referrals.filter((r) => r.status === status);
  }, [referrals, status]);

  async function openReferral(id: string) {
    try {
      const d = await api<{ referral: any; sessions: any[] }>(`/api/physio/referrals/${id}`);
      setDetail(d);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر فتح ملف التأهيل');
    }
  }

  async function submitReferral(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ referralNo: string; id: string }>('/api/physio/referrals', {
        method: 'POST',
        body: JSON.stringify({
          encounterId: referForm.encounterId,
          diagnosisSummary: referForm.diagnosisSummary.trim(),
          bodyRegion: referForm.bodyRegion.trim(),
          modalityPlan: referForm.modalityPlan,
          precautions: referForm.precautions.trim() || undefined,
          totalSessions: Number(referForm.totalSessions),
          priority: referForm.priority,
          assignedTherapistId: referForm.assignedTherapistId || undefined,
        }),
      });
      toast.success(`تم إنشاء إحالة العلاج الطبيعي (${res.referralNo})`);
      setReferOpen(false);
      setReferForm((p) => ({ ...p, diagnosisSummary: '', bodyRegion: '', precautions: '' }));
      await loadAll();
      await openReferral(res.id);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إنشاء إحالة العلاج الطبيعي');
    } finally {
      setBusy(false);
    }
  }

  async function submitAssessment(e: React.FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/physio/referrals/${detail.referral.id}/assess`, {
        method: 'POST',
        body: JSON.stringify({
          initialAssessment: assessForm.initialAssessment.trim(),
          rehabGoals: assessForm.rehabGoals.trim(),
          baselinePainScore: Number(assessForm.baselinePainScore),
          baselineMobilityScore: Number(assessForm.baselineMobilityScore),
        }),
      });
      toast.success('تم اعتماد التقييم التأهيلي الأولي وتفعيل خطة العلاج');
      setAssessOpen(false);
      await Promise.all([loadAll(), openReferral(detail.referral.id)]);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر حفظ التقييم الأولي');
    } finally {
      setBusy(false);
    }
  }

  async function submitSession(e: React.FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      const created = await api<{ id: string; sessionNo: string }>(
        `/api/physio/referrals/${detail.referral.id}/sessions`,
        {
          method: 'POST',
          body: JSON.stringify({
            durationMinutes: Number(sessionForm.durationMinutes),
            fee: Number(sessionForm.fee),
          }),
        },
      );
      if (sessionForm.completeImmediately) {
        await api(`/api/physio/sessions/${created.id}/complete`, {
          method: 'POST',
          body: JSON.stringify({
            modalitiesPerformed: [sessionForm.modality],
            painBefore: Number(sessionForm.painBefore),
            painAfter: Number(sessionForm.painAfter),
            romNotes: sessionForm.romNotes.trim() || 'تحسّن تدريجي في مدى الحركة الوظيفي',
            patientTolerance: sessionForm.patientTolerance,
            progressNotes: sessionForm.progressNotes.trim() || 'أُتمت الجلسة وفق البروتوكول العلاجي المعتمد',
          }),
        });
        toast.success(`تم إتمام جلسة التأهيل ${created.sessionNo} وإدراج الرسوم في فاتورة المريض`);
      } else {
        toast.success(`تمت جدولة الجلسة ${created.sessionNo}`);
      }
      setSessionOpen(false);
      setSessionForm((p) => ({ ...p, romNotes: '', progressNotes: '' }));
      await Promise.all([loadAll(), openReferral(detail.referral.id)]);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر تسجيل جلسة العلاج الطبيعي');
    } finally {
      setBusy(false);
    }
  }

  async function submitCompleteScheduledSession(e: React.FormEvent) {
    e.preventDefault();
    if (!completeSessTarget || !detail) return;
    setBusy(true);
    try {
      await api(`/api/physio/sessions/${completeSessTarget.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          modalitiesPerformed: [sessionForm.modality],
          painBefore: Number(sessionForm.painBefore),
          painAfter: Number(sessionForm.painAfter),
          romNotes: sessionForm.romNotes.trim(),
          patientTolerance: sessionForm.patientTolerance,
          progressNotes: sessionForm.progressNotes.trim(),
        }),
      });
      toast.success('أُتمت الجلسة المجدولة وأُضيفت رسوم العلاج الطبيعي تلقائيًا');
      setCompleteSessTarget(null);
      await Promise.all([loadAll(), openReferral(detail.referral.id)]);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إتمام الجلسة');
    } finally {
      setBusy(false);
    }
  }

  if (err && referrals.length === 0) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && referrals.length === 0) return <PageSkeleton cards={4} rows={6} />;

  const ref = detail?.referral;

  return (
    <div className="space-y-4">
      <PageHeader
        title="العلاج الطبيعي والتأهيل الطبي (Physical Therapy & Rehab)"
        subtitle="إدارة الإحالات التأهيلية، التقييم الوظيفي المبدئي، جلسات العلاج مع مقياس الألم البصري (VAS 0–10) ومدى الحركة (ROM)، والفوترة الآلية."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canRefer && (
              <Button variant="primary" size="sm" onClick={() => setReferOpen(true)}>
                + إحالة علاج طبيعي
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

      {totals && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard
            label="إحالات بانتظار التقييم"
            value={formatNumber(totals.pendingReferrals)}
            tone={Number(totals.pendingReferrals) > 0 ? 'warning' : 'default'}
          />
          <StatCard label="خطط تأهيل نشطة" value={formatNumber(totals.activePlans)} tone="brand" />
          <StatCard label="جلسات مجدولة" value={formatNumber(totals.scheduledSessions)} tone="info" />
          <StatCard label="جلسات منجزة ومفوترة" value={formatNumber(totals.completedSessions)} tone="success" />
          <StatCard
            label="متوسط انخفاض الألم (VAS)"
            value={`${totals.avgPainDrop ?? 0} درجة`}
            tone="success"
            sub="مؤشر جودة سريري"
          />
        </div>
      )}

      <Card
        title="قائمة عمل إحالات وخطط التأهيل الطبي"
        action={
          <Select
            aria-label="تصفية حالة إحالات العلاج الطبيعي"
            className="!w-48 text-xs"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="active">الإحالات النشطة والجديدة</option>
            <option value="referred">بانتظار التقييم الأولي</option>
            <option value="completed">مكتملة البرنامج</option>
            <option value="cancelled">ملغاة</option>
            <option value="all">الكل</option>
          </Select>
        }
      >
        <DataTable
          caption="إحالات العلاج الطبيعي والتأهيل"
          rows={filteredReferrals}
          rowKey={(r) => r.id}
          emptyTitle="لا توجد إحالات علاج طبيعي في هذه الحالة"
          cardTitle={(r) => `${r.patient_name} (${r.mrn})`}
          cardSubtitle={(r) => `${r.referral_no} · ${r.body_region}`}
          cardBadge={(r) => <Badge value={r.status} />}
          cardActions={(r) => (
            <Button variant="primary" size="sm" onClick={() => openReferral(r.id)}>
              فتح ملف التأهيل
            </Button>
          )}
          columns={[
            { key: 'no', header: 'رقم الإحالة', render: (r) => <span className="font-mono text-xs font-bold">{r.referral_no}</span> },
            {
              key: 'pt',
              header: 'المريض',
              render: (r) => (
                <div>
                  <span className="font-semibold">{r.patient_name}</span>
                  <span className="block text-xs text-slate-400 font-mono">{r.mrn} · {r.encounter_no}</span>
                </div>
              ),
            },
            {
              key: 'region',
              header: 'المنطقة / البروتوكول',
              render: (r) => (
                <div>
                  <span className="font-semibold">{r.body_region}</span>
                  <span className="block text-xs text-slate-500">{r.modality_plan_ar ?? MODALITY_LABELS[r.modality_plan] ?? r.modality_plan}</span>
                </div>
              ),
            },
            {
              key: 'prog',
              header: 'تقدم الجلسات',
              render: (r) => {
                const pct = Math.min(100, Math.round((Number(r.completed_sessions) / Math.max(1, Number(r.total_sessions))) * 100));
                return (
                  <div className="min-w-[110px]">
                    <div className="flex justify-between text-xs font-mono mb-1">
                      <span>
                        {r.completed_sessions}/{r.total_sessions}
                      </span>
                      <span>{pct}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div className="h-full bg-brand-600 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              },
            },
            { key: 'pri', header: 'الأولوية', render: (r) => <Badge value={r.priority} /> },
            { key: 'st', header: 'الحالة', render: (r) => <Badge value={r.status} /> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (r) => (
                <Button variant="ghost" size="sm" onClick={() => openReferral(r.id)}>
                  فتح الملف
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {ref && detail && (
        <Card
          title={`ملف التأهيل ${ref.referral_no} — ${ref.patient_name} (${ref.mrn})`}
          subtitle={`${ref.body_region} · ${ref.modality_plan_ar ?? MODALITY_LABELS[ref.modality_plan] ?? ref.modality_plan}`}
          action={
            <div className="flex flex-wrap gap-2">
              {canPerform && !['completed', 'cancelled'].includes(ref.status) && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setAssessForm({
                        initialAssessment: ref.initial_assessment ?? '',
                        rehabGoals: ref.rehab_goals ?? '',
                        baselinePainScore: String(ref.baseline_pain_score ?? 7),
                        baselineMobilityScore: String(ref.baseline_mobility_score ?? 5),
                      });
                      setAssessOpen(true);
                    }}
                  >
                    {ref.assessed_at ? 'تحديث التقييم والأهداف' : 'إجراء التقييم الأولي'}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setSessionForm((p) => ({ ...p, modality: ref.modality_plan }));
                      setSessionOpen(true);
                    }}
                  >
                    + تسجيل جلسة علاجية
                  </Button>
                </>
              )}
              {canCancel && !['completed', 'cancelled'].includes(ref.status) && (
                <Button variant="danger" size="sm" onClick={() => setCancelRefOpen(true)}>
                  إلغاء الإحالة
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                إغلاق
              </Button>
            </div>
          }
        >
          <div className="grid md:grid-cols-2 gap-4 text-sm">
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 space-y-1.5">
              <h4 className="font-bold text-slate-900">بيانات الإحالة الطبية</h4>
              <p>
                <span className="text-slate-500">التشخيص الموجّه:</span> {ref.diagnosis_summary}
              </p>
              {ref.precautions && (
                <p className="text-amber-800 font-medium">
                  <span className="text-amber-700">احتياطات وموانع:</span> {ref.precautions}
                </p>
              )}
              <p className="text-xs text-slate-500">
                الطبيب المحيل: {ref.referred_by_name} · الأخصائي المعالج: {ref.therapist_name ?? 'غير معيّن بعد'}
              </p>
              {ref.cancel_reason && <p className="text-rose-700 font-semibold">سبب الإلغاء: {ref.cancel_reason}</p>}
            </div>

            <div className="rounded-xl bg-brand-50/40 border border-brand-200 p-3.5 space-y-1.5">
              <h4 className="font-bold text-brand-950">التقييم الوظيفي المبدئي وأهداف التأهيل</h4>
              {ref.initial_assessment ? (
                <>
                  <p>{ref.initial_assessment}</p>
                  <p>
                    <strong>الأهداف:</strong> {ref.rehab_goals}
                  </p>
                  <div className="flex flex-wrap gap-3 pt-1 text-xs font-semibold">
                    <span className="px-2 py-0.5 rounded bg-white border border-slate-200">
                      الألم المبدئي (VAS): {ref.baseline_pain_score ?? '—'}/10
                    </span>
                    <span className="px-2 py-0.5 rounded bg-white border border-slate-200">
                      القدرة الحركية المبدئية: {ref.baseline_mobility_score ?? '—'}/10
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-xs text-slate-600">لم يُوثّق التقييم التأهيلي الأولي بعد — اضغط «إجراء التقييم الأولي» لبدء الخطة.</p>
              )}
            </div>
          </div>

          <div className="mt-4">
            <h4 className="font-bold text-sm text-slate-900 mb-2">سجل جلسات العلاج الطبيعي ({detail.sessions.length})</h4>
            <DataTable
              caption="جلسات العلاج الطبيعي"
              rows={detail.sessions}
              rowKey={(s) => s.id}
              emptyTitle="لم تُسجّل جلسات علاجية لهذه الإحالة بعد"
              columns={[
                { key: 'num', header: '#', render: (s) => <span className="font-mono font-bold">#{s.session_number}</span> },
                { key: 'no', header: 'رقم الجلسة', render: (s) => <span className="font-mono text-xs">{s.session_no}</span> },
                {
                  key: 'mod',
                  header: 'التدخل العلاجي',
                  render: (s) => {
                    const mods: string[] = Array.isArray(s.modalities_performed) ? s.modalities_performed : [];
                    return (
                      <div>
                        <span className="font-semibold">
                          {mods.length > 0 ? mods.map((m) => MODALITY_LABELS[m] ?? m).join(' + ') : 'جلسة مجدولة'}
                        </span>
                        <span className="block text-xs text-slate-500">{s.duration_minutes} دقيقة · {s.therapist_name}</span>
                      </div>
                    );
                  },
                },
                {
                  key: 'vas',
                  header: 'الألم VAS (قبل ← بعد)',
                  render: (s) =>
                    s.pain_before != null || s.pain_after != null ? (
                      <span className="font-mono text-xs font-semibold">
                        {s.pain_before ?? '—'}/10 ←{' '}
                        <span className={Number(s.pain_after) < Number(s.pain_before) ? 'text-emerald-700' : ''}>
                          {s.pain_after ?? '—'}/10
                        </span>
                      </span>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'notes',
                  header: 'مدى الحركة (ROM) والتطور',
                  render: (s) => (
                    <div className="text-xs max-w-xs">
                      {s.rom_notes && <div className="font-medium text-slate-800">{s.rom_notes}</div>}
                      {s.progress_notes && <div className="text-slate-500">{s.progress_notes}</div>}
                      {s.tolerance_ar && <div className="text-emerald-700 font-medium">التحمّل: {s.tolerance_ar}</div>}
                    </div>
                  ),
                },
                { key: 'fee', header: 'الرسوم', render: (s) => <span className="font-mono text-xs">{formatMoney(s.fee)}</span> },
                { key: 'st', header: 'الحالة', render: (s) => <Badge value={s.status} /> },
                {
                  key: 'act',
                  header: 'إجراء',
                  isActions: true,
                  render: (s) =>
                    canPerform && s.status === 'scheduled' ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setCompleteSessTarget(s);
                          setSessionForm((p) => ({
                            ...p,
                            modality: ref.modality_plan,
                            durationMinutes: String(s.duration_minutes ?? 45),
                            romNotes: '',
                            progressNotes: '',
                          }));
                        }}
                      >
                        إتمام الجلسة
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-400">{s.performed_at ? formatDateTime(s.performed_at) : '—'}</span>
                    ),
                },
              ]}
            />
          </div>
        </Card>
      )}

      {/* Modal: New Referral */}
      <Modal open={referOpen} onClose={() => setReferOpen(false)} title="إنشاء إحالة علاج طبيعي وتأهيل طبي">
        <form onSubmit={submitReferral} className="space-y-3">
          <Select
            label="الزيارة السريرية المفتوحة"
            required
            value={referForm.encounterId}
            onChange={(e) => setReferForm({ ...referForm, encounterId: e.target.value })}
          >
            {openEncounters.length === 0 && <option value="">لا توجد زيارات مفتوحة حاليًا</option>}
            {openEncounters.map((enc) => (
              <option key={enc.id} value={enc.id}>
                {enc.patient_name} ({enc.mrn}) — {enc.encounter_no} · {enc.dept_name}
              </option>
            ))}
          </Select>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="المنطقة التشريحية المستهدفة"
              required
              placeholder="مثال: مفصل الركبة اليمنى / أسفل الظهر"
              value={referForm.bodyRegion}
              onChange={(e) => setReferForm({ ...referForm, bodyRegion: e.target.value })}
            />
            <Select
              label="البروتوكول العلاجي الرئيسي"
              value={referForm.modalityPlan}
              onChange={(e) => setReferForm({ ...referForm, modalityPlan: e.target.value })}
            >
              {Object.entries(MODALITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <Textarea
            label="ملخص التشخيص الطبي ومبرر الإحالة (5 أحرف على الأقل)"
            required
            minLength={5}
            rows={2}
            value={referForm.diagnosisSummary}
            onChange={(e) => setReferForm({ ...referForm, diagnosisSummary: e.target.value })}
          />
          <Input
            label="الاحتياطات والمحاذير السريرية (اختياري)"
            placeholder="مثال: تجنب الثني العميق فوق 90 درجة..."
            value={referForm.precautions}
            onChange={(e) => setReferForm({ ...referForm, precautions: e.target.value })}
          />
          <div className="grid sm:grid-cols-3 gap-3">
            <Input
              label="عدد الجلسات"
              type="number"
              min="1"
              max="60"
              required
              value={referForm.totalSessions}
              onChange={(e) => setReferForm({ ...referForm, totalSessions: e.target.value })}
            />
            <Select
              label="الأولوية"
              value={referForm.priority}
              onChange={(e) => setReferForm({ ...referForm, priority: e.target.value })}
            >
              <option value="routine">روتيني</option>
              <option value="urgent">عاجل</option>
              <option value="stat">فوري حرج</option>
            </Select>
            <Select
              label="الأخصائي المعالج"
              value={referForm.assignedTherapistId}
              onChange={(e) => setReferForm({ ...referForm, assignedTherapistId: e.target.value })}
            >
              <option value="">تعيين تلقائي</option>
              {therapists.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.full_name_ar}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setReferOpen(false)}>
              إلغاء
            </Button>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={!referForm.encounterId || referForm.diagnosisSummary.trim().length < 5}
            >
              إرسال الإحالة
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Initial Assessment */}
      <Modal open={assessOpen} onClose={() => setAssessOpen(false)} title="التقييم الوظيفي الأولي وخطة أهداف التأهيل">
        <form onSubmit={submitAssessment} className="space-y-3">
          <Textarea
            label="نتائج الفحص الحركي والوظيفي المبدئي (5 أحرف على الأقل)"
            required
            minLength={5}
            rows={3}
            value={assessForm.initialAssessment}
            onChange={(e) => setAssessForm({ ...assessForm, initialAssessment: e.target.value })}
          />
          <Textarea
            label="الأهداف التأهيلية القصيرة والطويلة المدى (5 أحرف على الأقل)"
            required
            minLength={5}
            rows={2}
            value={assessForm.rehabGoals}
            onChange={(e) => setAssessForm({ ...assessForm, rehabGoals: e.target.value })}
          />
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="مقياس الألم المبدئي (VAS 0–10)"
              type="number"
              min="0"
              max="10"
              required
              value={assessForm.baselinePainScore}
              onChange={(e) => setAssessForm({ ...assessForm, baselinePainScore: e.target.value })}
            />
            <Input
              label="مؤشر القدرة الحركية المبدئي (1–10)"
              type="number"
              min="1"
              max="10"
              required
              value={assessForm.baselineMobilityScore}
              onChange={(e) => setAssessForm({ ...assessForm, baselineMobilityScore: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setAssessOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              حفظ التقييم وتفعيل الخطة
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: New Session */}
      <Modal open={sessionOpen} onClose={() => setSessionOpen(false)} title="توثيق أو جدولة جلسة علاج طبيعي">
        <form onSubmit={submitSession} className="space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <Select
              label="التدخل العلاجي"
              value={sessionForm.modality}
              onChange={(e) => setSessionForm({ ...sessionForm, modality: e.target.value })}
            >
              {Object.entries(MODALITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Input
              label="المدة (دقيقة)"
              type="number"
              min="15"
              max="180"
              required
              value={sessionForm.durationMinutes}
              onChange={(e) => setSessionForm({ ...sessionForm, durationMinutes: e.target.value })}
            />
            <Input
              label="رسوم الجلسة (ر.س)"
              type="number"
              min="0"
              required
              value={sessionForm.fee}
              onChange={(e) => setSessionForm({ ...sessionForm, fee: e.target.value })}
            />
          </div>
          {sessionForm.completeImmediately && (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                <Input
                  label="مقياس الألم قبل الجلسة (VAS 0–10)"
                  type="number"
                  min="0"
                  max="10"
                  required
                  value={sessionForm.painBefore}
                  onChange={(e) => setSessionForm({ ...sessionForm, painBefore: e.target.value })}
                />
                <Input
                  label="مقياس الألم بعد الجلسة (VAS 0–10)"
                  type="number"
                  min="0"
                  max="10"
                  required
                  value={sessionForm.painAfter}
                  onChange={(e) => setSessionForm({ ...sessionForm, painAfter: e.target.value })}
                />
              </div>
              <Input
                label="قراءات مدى الحركة للمفصل (ROM Notes — 3 أحرف على الأقل)"
                required
                minLength={3}
                placeholder="مثال: Flexion 0–115°, Extension 0°"
                value={sessionForm.romNotes}
                onChange={(e) => setSessionForm({ ...sessionForm, romNotes: e.target.value })}
              />
              <Textarea
                label="ملاحظات التقدم العلاجي (5 أحرف على الأقل)"
                required
                minLength={5}
                rows={2}
                value={sessionForm.progressNotes}
                onChange={(e) => setSessionForm({ ...sessionForm, progressNotes: e.target.value })}
              />
              <Select
                label="تحمّل المريض للجلسة"
                value={sessionForm.patientTolerance}
                onChange={(e) => setSessionForm({ ...sessionForm, patientTolerance: e.target.value })}
              >
                {Object.entries(TOLERANCE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </>
          )}
          <label className="flex items-center gap-2 text-xs font-medium text-slate-800">
            <input
              type="checkbox"
              checked={sessionForm.completeImmediately}
              onChange={(e) => setSessionForm({ ...sessionForm, completeImmediately: e.target.checked })}
            />
            إتمام الجلسة الآن وإصدار بند رسوم العلاج الطبيعي تلقائيًا
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setSessionOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              حفظ الجلسة
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Complete Scheduled Session */}
      <Modal
        open={!!completeSessTarget}
        onClose={() => setCompleteSessTarget(null)}
        title={`إتمام الجلسة المجدولة (${completeSessTarget?.session_no ?? ''})`}
      >
        <form onSubmit={submitCompleteScheduledSession} className="space-y-3">
          <Select
            label="التدخل العلاجي المنفّذ"
            value={sessionForm.modality}
            onChange={(e) => setSessionForm({ ...sessionForm, modality: e.target.value })}
          >
            {Object.entries(MODALITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="الألم قبل الجلسة (0–10)"
              type="number"
              min="0"
              max="10"
              required
              value={sessionForm.painBefore}
              onChange={(e) => setSessionForm({ ...sessionForm, painBefore: e.target.value })}
            />
            <Input
              label="الألم بعد الجلسة (0–10)"
              type="number"
              min="0"
              max="10"
              required
              value={sessionForm.painAfter}
              onChange={(e) => setSessionForm({ ...sessionForm, painAfter: e.target.value })}
            />
          </div>
          <Input
            label="مدى الحركة (ROM — 3 أحرف على الأقل)"
            required
            minLength={3}
            placeholder="مثال: Flexion 0–120°"
            value={sessionForm.romNotes}
            onChange={(e) => setSessionForm({ ...sessionForm, romNotes: e.target.value })}
          />
          <Textarea
            label="ملاحظات التقدم العلاجي (5 أحرف على الأقل)"
            required
            minLength={5}
            rows={2}
            value={sessionForm.progressNotes}
            onChange={(e) => setSessionForm({ ...sessionForm, progressNotes: e.target.value })}
          />
          <Select
            label="تحمّل المريض"
            value={sessionForm.patientTolerance}
            onChange={(e) => setSessionForm({ ...sessionForm, patientTolerance: e.target.value })}
          >
            {Object.entries(TOLERANCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCompleteSessTarget(null)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              اعتماد إتمام الجلسة والفوترة
            </Button>
          </div>
        </form>
      </Modal>

      <ReasonDialog
        open={cancelRefOpen}
        onClose={() => setCancelRefOpen(false)}
        title={`إلغاء إحالة العلاج الطبيعي (${ref?.referral_no ?? ''})`}
        consequenceNote="سيتم إغلاق الإحالة وإلغاء الجلسات المجدولة المتبقية مع حفظ السبب في سجل التدقيق."
        minLength={5}
        confirmLabel="تأكيد الإلغاء"
        variant="danger"
        onConfirm={async (reason) => {
          if (!ref) return;
          await api(`/api/physio/referrals/${ref.id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
          toast.success('أُلغيت إحالة العلاج الطبيعي بسبب موثّق');
          await Promise.all([loadAll(), openReferral(ref.id)]);
        }}
      />
    </div>
  );
}

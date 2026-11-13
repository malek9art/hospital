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
  ReasonDialog,
  Select,
  StatCard,
  useToast,
} from '../components';
import { useBootstrap } from '../hooks/useBootstrap';
import { formatDateTime } from '../lib/format';

const PHASE_AR: Record<string, string> = {
  sign_in: 'قبل التخدير (Sign In)',
  time_out: 'قبل الشق الجراحي (Time Out)',
  sign_out: 'قبل مغادرة الغرفة (Sign Out)',
};

export default function SurgeryPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const { data: boot } = useBootstrap();
  const [board, setBoard] = useState<any>(null);
  const [theatres, setTheatres] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [patients, setPatients] = useState<any[]>([]);
  const [openEncounters, setOpenEncounters] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [signIn, setSignIn] = useState<Record<string, boolean>>({});
  const [timeOut, setTimeOut] = useState<Record<string, boolean>>({});
  const [signOut, setSignOut] = useState<Record<string, boolean>>({});
  const [counts, setCounts] = useState({
    instruments: { expected: 0, actual: 0 },
    sponges: { expected: 0, actual: 0 },
    needles: { expected: 0, actual: 0 },
  });
  const [discrepancy, setDiscrepancy] = useState('');
  const [anes, setAnes] = useState({
    phase: 'maintenance',
    heartRate: '',
    systolicBp: '',
    diastolicBp: '',
    spo2: '',
    agent: '',
  });
  const [pacu, setPacu] = useState({
    aldreteScore: 9,
    painScore: 0,
    heartRate: '',
    spo2: '',
    nausea: false,
    disposition: 'ward',
    notes: '',
  });
  const [form, setForm] = useState({
    patientId: '',
    encounterId: '',
    theatreId: '',
    procedureName: '',
    anesthesiologistId: '',
    scheduledAt: '',
    estimatedMinutes: 60,
    priority: 'elective',
    anesthesiaType: 'general',
  });

  // Replaces window.prompt for Surgery case cancellation!
  const [cancelModalOpen, setCancelModalOpen] = useState(false);

  const loadBoard = useCallback(async () => {
    setErr(null);
    try {
      const b = await api<any>('/api/surgery/board?status=active');
      setBoard(b);
      if (detail?.id) {
        setDetail(await api<any>(`/api/surgery/cases/${detail.id}`));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل جدول العمليات');
    } finally {
      setLoading(false);
    }
  }, [detail?.id]);

  useEffect(() => {
    loadBoard();
    api<any>('/api/surgery/theatres')
      .then((t) => setTheatres(t.items ?? []))
      .catch(() => setTheatres([]));
    if (has(auth, 'surgery.schedule') && has(auth, 'patient.read')) {
      api<any>('/api/patients?limit=100')
        .then((r) => setPatients(r.items ?? []))
        .catch(() => setPatients([]));
    }
  }, [auth]);

  useEffect(() => {
    const cl = board?.checklist;
    if (!cl) return;
    setSignIn((cur) => (Object.keys(cur).length ? cur : Object.fromEntries(cl.sign_in.map((i: any) => [i.key, false]))));
    setTimeOut((cur) => (Object.keys(cur).length ? cur : Object.fromEntries(cl.time_out.map((i: any) => [i.key, false]))));
    setSignOut((cur) => (Object.keys(cur).length ? cur : Object.fromEntries(cl.sign_out.map((i: any) => [i.key, false]))));
  }, [board]);

  async function openCase(c: any) {
    try {
      const d = await api<any>(`/api/surgery/cases/${c.id}`);
      setDetail(d);
      setSignIn(
        Object.fromEntries(
          (d.checklists ?? [])
            .filter((x: any) => x.phase === 'sign_in')
            .flatMap((x: any) => Object.entries(x.items).filter(([, v]) => typeof v === 'boolean')),
        ),
      );
      setTimeOut(
        Object.fromEntries(
          (d.checklists ?? [])
            .filter((x: any) => x.phase === 'time_out')
            .flatMap((x: any) => Object.entries(x.items).filter(([, v]) => typeof v === 'boolean')),
        ),
      );
      setSignOut({});
      setCounts({
        instruments: { expected: 0, actual: 0 },
        sponges: { expected: 0, actual: 0 },
        needles: { expected: 0, actual: 0 },
      });
      setDiscrepancy('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر فتح تفاصيل العملية');
    }
  }

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await loadBoard();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تنفيذ الإجراء');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function pickPatient(id: string) {
    setForm((f) => ({ ...f, patientId: id, encounterId: '' }));
    setOpenEncounters([]);
    if (!id) return;
    try {
      const p = await api<any>(`/api/patients/${id}`);
      setOpenEncounters((p.encounters ?? []).filter((e: any) => e.status === 'open'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر جلب زيارات المريض');
    }
  }

  if (err && !board) return <ErrorState message={err} onRetry={loadBoard} />;
  if (loading && !board) return <PageSkeleton cards={4} rows={5} />;

  const required = board?.checklist ?? { sign_in: [], time_out: [], sign_out: [] };
  const signInDone = (detail?.checklists ?? []).some((c: any) => c.phase === 'sign_in');
  const timeOutDone = (detail?.checklists ?? []).some((c: any) => c.phase === 'time_out');

  const renderChecklist = (
    phase: 'sign_in' | 'time_out' | 'sign_out',
    state: Record<string, boolean>,
    setState: (v: Record<string, boolean>) => void,
  ) => (
    <div className="space-y-1.5">
      {(required[phase] ?? []).map((i: any) => (
        <label key={i.key} className="flex items-start gap-2 text-xs cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={!!state[i.key]}
            onChange={(e) => setState({ ...state, [i.key]: e.target.checked })}
          />
          <span>{i.label}</span>
        </label>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="غرف العمليات والتخدير والإفاقة (OR & PACU)"
        subtitle="قوائم التحقق الجراحي لمنظمة الصحة العالمية (WHO)، مراقبة التخدير، وعدّ الأدوات."
      />

      {board && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="قيد العملية الآن" value={board.totals.in_progress} tone="info" />
          <StatCard label="في وحدة الإفاقة (PACU)" value={board.totals.recovery} tone="warning" />
          <StatCard label="عمليات مجدولة" value={board.totals.scheduled} />
          <StatCard label="مكتملة اليوم" value={board.totals.completed_today} tone="success" />
        </div>
      )}

      <Card title="جدول غرف العمليات النشط">
        <DataTable
          caption="جدول العمليات الجراحية"
          rows={board?.items ?? []}
          rowKey={(c) => c.id}
          emptyTitle="لا توجد عمليات جراحية نشطة حاليًا"
          cardTitle={(c) => c.procedure_name}
          cardSubtitle={(c) => `${c.case_no} · ${c.patient_name} (${c.mrn})`}
          cardBadge={(c) => <Badge value={c.status} />}
          cardActions={(c) => (
            <Button variant="primary" size="sm" onClick={() => openCase(c)}>
              فتح ملف العملية
            </Button>
          )}
          columns={[
            {
              key: 'proc',
              header: 'الإجراء الجراحي',
              render: (c) => (
                <div>
                  <span className="font-semibold">{c.procedure_name}</span>
                  <span className="block text-xs text-slate-400 font-mono">
                    {c.case_no} · {c.priority === 'emergency' ? 'طارئة' : c.priority === 'urgent' ? 'عاجلة' : 'مجدولة'}
                  </span>
                </div>
              ),
            },
            {
              key: 'pt',
              header: 'المريض',
              render: (c) => (
                <div>
                  <span>{c.patient_name}</span>
                  <span className="block text-xs text-slate-400 font-mono">{c.mrn}</span>
                </div>
              ),
            },
            {
              key: 'team',
              header: 'الغرفة والفريق',
              render: (c) => (
                <div className="text-xs">
                  <span className="font-medium">{c.theatre_name}</span>
                  <span className="block text-slate-500">
                    {c.surgeon_name}
                    {c.anesthesiologist_name ? ` · تخدير: ${c.anesthesiologist_name}` : ''}
                  </span>
                </div>
              ),
            },
            {
              key: 'time',
              header: 'الموعد',
              render: (c) => (
                <div className="text-xs">
                  {formatDateTime(c.scheduled_at)}
                  <span className="block text-slate-400">{c.estimated_minutes} د</span>
                </div>
              ),
            },
            {
              key: 'chk',
              header: 'التحقق',
              render: (c) => (
                <div className="text-xs">
                  {c.preop_checks}/2 قوائم
                  {c.counts_correct === false && <span className="block text-rose-700 font-bold">عدّ غير مطابق</span>}
                </div>
              ),
            },
            { key: 'st', header: 'الحالة', render: (c) => <Badge value={c.status} /> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (c) => (
                <Button variant="ghost" size="sm" onClick={() => openCase(c)}>
                  فتح
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {detail && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Card
            title={`${detail.procedure_name} — ${detail.patient_name}`}
            subtitle={`${detail.case_no} · ${detail.theatre_name} · فصيلة الدم: ${detail.blood_type ?? '—'}`}
            action={
              <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                إغلاق
              </Button>
            }
          >
            <div className="text-xs space-y-1 text-slate-600 mb-3">
              <p>
                الجراح: <b>{detail.surgeon_name}</b> · التخدير: {detail.anesthesiologist_name ?? '—'} ({detail.anesthesia_type})
              </p>
              <p>
                الحالة الحالية: <Badge value={detail.status} />
              </p>
              {detail.counts_correct === false && (
                <p className="text-rose-700 font-semibold">⚠ عدّ غير مطابق: {detail.count_discrepancy}</p>
              )}
              {detail.cancel_reason && <p className="text-rose-700">سبب الإلغاء: {detail.cancel_reason}</p>}
            </div>

            <div className="space-y-2 border-t border-slate-100 pt-2">
              {(detail.checklists ?? []).map((ch: any) => (
                <div key={ch.id} className="border border-slate-200 rounded-xl p-2.5">
                  <p className="text-xs font-bold">
                    {PHASE_AR[ch.phase]} — {formatDateTime(ch.completed_at)} · {ch.completed_by_name ?? ''}
                  </p>
                  <ul className="text-[11px] text-slate-600 mt-1 grid sm:grid-cols-2 gap-1">
                    {(ch.required ?? []).map((r: any) => (
                      <li key={r.key} className={ch.items?.[r.key] === true ? 'text-emerald-700' : 'text-slate-400'}>
                        {ch.items?.[r.key] === true ? '✓' : '✗'} {r.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {detail.status === 'scheduled' && !signInDone && (has(auth, 'surgery.checklist') || has(auth, 'anesthesia.perform')) && (
              <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
                <p className="text-sm font-bold">قائمة ما قبل التخدير (WHO Sign In)</p>
                {renderChecklist('sign_in', signIn, setSignIn)}
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/surgery/cases/${detail.id}/checklists`, {
                          method: 'POST',
                          body: JSON.stringify({ phase: 'sign_in', items: signIn }),
                        }),
                      'سُجلت قائمة ما قبل التخدير',
                    ).catch(() => {})
                  }
                >
                  حفظ قائمة ما قبل التخدير
                </Button>
              </div>
            )}

            {detail.status === 'prepared' && !timeOutDone && (has(auth, 'surgery.checklist') || has(auth, 'anesthesia.perform')) && (
              <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
                <p className="text-sm font-bold">قائمة ما قبل الشق الجراحي (WHO Time Out)</p>
                {renderChecklist('time_out', timeOut, setTimeOut)}
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/surgery/cases/${detail.id}/checklists`, {
                          method: 'POST',
                          body: JSON.stringify({ phase: 'time_out', items: timeOut }),
                        }),
                      'سُجلت قائمة ما قبل الشق الجراحي',
                    ).catch(() => {})
                  }
                >
                  حفظ قائمة ما قبل الشق
                </Button>
              </div>
            )}

            {detail.status === 'prepared' && timeOutDone && has(auth, 'surgery.perform') && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() => act(() => api(`/api/surgery/cases/${detail.id}/start`, { method: 'POST' }), 'بدأت العملية الجراحية').catch(() => {})}
                >
                  بدء العملية الجراحية
                </Button>
              </div>
            )}

            {['scheduled', 'prepared'].includes(detail.status) && has(auth, 'surgery.schedule') && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <Button variant="danger" size="sm" onClick={() => setCancelModalOpen(true)}>
                  إلغاء العملية الجراحية
                </Button>
              </div>
            )}
          </Card>

          <Card title="التخدير، عدّ الأدوات، والإفاقة (PACU)">
            {detail.status === 'in_progress' && has(auth, 'anesthesia.perform') && (
              <div className="space-y-2 mb-4">
                <p className="text-sm font-bold">تسجيل قياس تخدير جديد</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <Select label="المرحلة" value={anes.phase} onChange={(e) => setAnes({ ...anes, phase: e.target.value })}>
                    <option value="induction">تحريض</option>
                    <option value="maintenance">استمرار</option>
                    <option value="emergence">إفاقة</option>
                  </Select>
                  <Input label="نبض" value={anes.heartRate} onChange={(e) => setAnes({ ...anes, heartRate: e.target.value })} />
                  <Input label="انقباضي" value={anes.systolicBp} onChange={(e) => setAnes({ ...anes, systolicBp: e.target.value })} />
                  <Input label="انبساطي" value={anes.diastolicBp} onChange={(e) => setAnes({ ...anes, diastolicBp: e.target.value })} />
                  <Input label="SpO₂" value={anes.spo2} onChange={(e) => setAnes({ ...anes, spo2: e.target.value })} />
                  <Input label="الدواء التخديري" value={anes.agent} onChange={(e) => setAnes({ ...anes, agent: e.target.value })} />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  disabled={!anes.heartRate && !anes.spo2 && !anes.agent}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/surgery/cases/${detail.id}/anesthesia`, {
                          method: 'POST',
                          body: JSON.stringify({
                            phase: anes.phase,
                            heartRate: anes.heartRate ? Number(anes.heartRate) : undefined,
                            systolicBp: anes.systolicBp ? Number(anes.systolicBp) : undefined,
                            diastolicBp: anes.diastolicBp ? Number(anes.diastolicBp) : undefined,
                            spo2: anes.spo2 ? Number(anes.spo2) : undefined,
                            agent: anes.agent || undefined,
                          }),
                        }),
                      'سُجل قياس التخدير',
                    ).catch(() => {})
                  }
                >
                  حفظ القياس
                </Button>
              </div>
            )}

            {(detail.anesthesia ?? []).length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-bold mb-1">سجل التخدير ({detail.anesthesia.length})</p>
                <ul className="text-xs space-y-1 max-h-36 overflow-y-auto">
                  {detail.anesthesia.map((r: any) => (
                    <li key={r.id} className="border-b border-slate-100 pb-1">
                      {formatDateTime(r.recorded_at)} · نبض {r.heart_rate ?? '—'} · SpO₂ {r.spo2 ?? '—'}% · {r.agent ?? ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.status === 'in_progress' && has(auth, 'surgery.perform') && (
              <div className="border-t border-slate-100 pt-3 space-y-2">
                <p className="text-sm font-bold">قائمة ما بعد العملية وعدّ الأدوات (WHO Sign Out)</p>
                {renderChecklist('sign_out', signOut, setSignOut)}
                <div className="grid grid-cols-3 gap-2 pt-1">
                  {(['instruments', 'sponges', 'needles'] as const).map((k) => (
                    <div key={k} className="text-xs space-y-1">
                      <p className="font-semibold text-slate-600">
                        {k === 'instruments' ? 'أدوات' : k === 'sponges' ? 'شاش/كمامات' : 'إبر'}
                      </p>
                      <div className="flex gap-1">
                        <input
                          aria-label={`متوقع ${k}`}
                          className="input"
                          type="number"
                          placeholder="متوقع"
                          value={counts[k].expected}
                          onChange={(e) => setCounts({ ...counts, [k]: { ...counts[k], expected: Number(e.target.value) } })}
                        />
                        <input
                          aria-label={`فعلي ${k}`}
                          className="input"
                          type="number"
                          placeholder="فعلي"
                          value={counts[k].actual}
                          onChange={(e) => setCounts({ ...counts, [k]: { ...counts[k], actual: Number(e.target.value) } })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <Input
                  label="ملاحظة عدم التطابق (إلزامية عند اختلاف العدّ — 15 حرفًا على الأقل)"
                  value={discrepancy}
                  onChange={(e) => setDiscrepancy(e.target.value)}
                />
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/surgery/cases/${detail.id}/close`, {
                          method: 'POST',
                          body: JSON.stringify({
                            signOut,
                            counts,
                            ...(discrepancy.trim().length >= 15 ? { discrepancyNote: discrepancy.trim() } : {}),
                          }),
                        }),
                      'أُغلقت العملية ونُقل المريض للإفاقة مع احتساب الرسوم',
                    ).catch(() => {})
                  }
                >
                  إغلاق العملية الجراحية
                </Button>
              </div>
            )}

            {detail.status === 'recovery' &&
              (has(auth, 'anesthesia.perform') || has(auth, 'surgery.checklist') || has(auth, 'surgery.perform')) && (
                <div className="border-t border-slate-100 pt-3 space-y-2">
                  <p className="text-sm font-bold">تسجيل الإفاقة ومقياس ألدريتي (Aldrete ≥ 8 للنقل)</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      label="درجة ألدريتي (0–10)"
                      type="number"
                      min={0}
                      max={10}
                      value={pacu.aldreteScore}
                      onChange={(e) => setPacu({ ...pacu, aldreteScore: Number(e.target.value) })}
                    />
                    <Input
                      label="درجة الألم (0–10)"
                      type="number"
                      min={0}
                      max={10}
                      value={pacu.painScore}
                      onChange={(e) => setPacu({ ...pacu, painScore: Number(e.target.value) })}
                    />
                    <Input label="نبض" value={pacu.heartRate} onChange={(e) => setPacu({ ...pacu, heartRate: e.target.value })} />
                    <Input label="SpO₂" value={pacu.spo2} onChange={(e) => setPacu({ ...pacu, spo2: e.target.value })} />
                    <Select
                      label="وجهة النقل"
                      value={pacu.disposition}
                      onChange={(e) => setPacu({ ...pacu, disposition: e.target.value })}
                    >
                      <option value="ward">إلى الجناح</option>
                      <option value="icu">إلى العناية المركزة</option>
                      <option value="day_surgery_discharge">خروج جراحة اليوم الواحد</option>
                    </Select>
                    <label className="flex items-center gap-2 text-xs self-end pb-2">
                      <input
                        type="checkbox"
                        checked={pacu.nausea}
                        onChange={(e) => setPacu({ ...pacu, nausea: e.target.checked })}
                      />
                      غثيان بعد التخدير
                    </label>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={pacu.aldreteScore < 8}
                    onClick={() =>
                      act(
                        () =>
                          api(`/api/surgery/cases/${detail.id}/recovery`, {
                            method: 'POST',
                            body: JSON.stringify({
                              aldreteScore: Number(pacu.aldreteScore),
                              painScore: Number(pacu.painScore),
                              heartRate: pacu.heartRate ? Number(pacu.heartRate) : undefined,
                              spo2: pacu.spo2 ? Number(pacu.spo2) : undefined,
                              nausea: pacu.nausea,
                              disposition: pacu.disposition,
                              notes: pacu.notes || undefined,
                            }),
                          }),
                        'أُكملت العملية بعد استيفاء معيار الإفاقة',
                      ).catch(() => {})
                    }
                  >
                    إتمام الإفاقة والنقل
                  </Button>
                </div>
              )}
          </Card>
        </div>
      )}

      {has(auth, 'surgery.schedule') && (
        <Card title="جدولة عملية جراحية جديدة" subtitle="تُرفض الجدولة تلقائيًا عند تعارض وقت الغرفة.">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Select label="المريض" value={form.patientId} onChange={(e) => pickPatient(e.target.value)}>
              <option value="">— اختر المريض —</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullNameAr ?? p.full_name_ar} · {p.mrn}
                </option>
              ))}
            </Select>
            <Select
              label="الزيارة المفتوحة"
              value={form.encounterId}
              onChange={(e) => setForm({ ...form, encounterId: e.target.value })}
            >
              <option value="">— اختر الزيارة —</option>
              {openEncounters.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.encounter_no ?? e.encounterNo} · {e.department}
                </option>
              ))}
            </Select>
            <Select
              label="غرفة العمليات"
              value={form.theatreId}
              onChange={(e) => setForm({ ...form, theatreId: e.target.value })}
            >
              <option value="">— اختر الغرفة —</option>
              {theatres.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name_ar}
                </option>
              ))}
            </Select>
            <Input
              label="اسم الإجراء الجراحي"
              value={form.procedureName}
              onChange={(e) => setForm({ ...form, procedureName: e.target.value })}
            />
            <Input
              label="التاريخ والوقت"
              type="datetime-local"
              value={form.scheduledAt}
              onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
            />
            <Select
              label="طبيب التخدير"
              value={form.anesthesiologistId}
              onChange={(e) => setForm({ ...form, anesthesiologistId: e.target.value })}
            >
              <option value="">— اختياري —</option>
              {(boot?.doctors ?? [])
                .filter((d) => d.role_id === 'anesthesiologist')
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.full_name_ar}
                  </option>
                ))}
            </Select>
          </div>
          <Button
            variant="primary"
            size="sm"
            className="mt-3"
            busy={busy}
            disabled={
              !form.patientId ||
              !form.encounterId ||
              !form.theatreId ||
              form.procedureName.trim().length < 3 ||
              !form.scheduledAt
            }
            onClick={() =>
              act(async () => {
                await api('/api/surgery/cases', {
                  method: 'POST',
                  body: JSON.stringify({
                    patientId: form.patientId,
                    encounterId: form.encounterId,
                    theatreId: form.theatreId,
                    procedureName: form.procedureName,
                    anesthesiologistId: form.anesthesiologistId || undefined,
                    priority: form.priority,
                    anesthesiaType: form.anesthesiaType,
                    scheduledAt: new Date(form.scheduledAt).toISOString(),
                    estimatedMinutes: Number(form.estimatedMinutes),
                  }),
                });
                setForm({ ...form, procedureName: '', scheduledAt: '', encounterId: '' });
              }, 'جُدولت العملية الجراحية بنجاح').catch(() => {})
            }
          >
            جدولة العملية
          </Button>
        </Card>
      )}

      {/* ReasonDialog #3: Cancel Surgery Case */}
      <ReasonDialog
        open={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        title="إلغاء العملية الجراحية"
        consequenceNote={`سيتم إلغاء العملية «${detail?.procedure_name ?? ''}» وتحرير غرفة العمليات مع حفظ السبب في سجل التدقيق.`}
        minLength={5}
        confirmLabel="تأكيد إلغاء العملية"
        variant="danger"
        onConfirm={async (reason) => {
          if (!detail) return;
          await act(
            () =>
              api(`/api/surgery/cases/${detail.id}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ reason }),
              }),
            'أُلغيت العملية الجراحية بسبب موثّق',
          );
        }}
      />
    </div>
  );
}

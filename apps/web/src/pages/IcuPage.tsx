import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Button,
  Card,
  DataTable,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  Select,
  StatCard,
  useToast,
} from '../components';
import { formatDateTime } from '../lib/format';

const VENT_AR: Record<string, string> = {
  ac: 'تحكم بالحجم/الضغط (AC)',
  simv: 'SIMV',
  psv: 'دعم ضغط (PSV)',
  cpap: 'CPAP',
  hfnc: 'أكسجين عالي التدفق (HFNC)',
  room_air: 'هواء الغرفة',
};
const ICU_DISPOSITION_AR: Record<string, string> = {
  ward: 'نقل إلى الجناح العام',
  transfer: 'تحويل لمنشأة أخرى',
  home: 'خروج للمنزل',
  deceased: 'وفاة',
  against_advice: 'خروج ضد النصيحة الطبية',
};
const GOAL_LABELS: Array<[string, string]> = [
  ['sedationTarget', 'هدف التهدئة اليومي (RASS)'],
  ['headOfBedElevated', 'رفع رأس السرير ٣٠–٤٥°'],
  ['vapBundle', 'حزمة الوقاية من التهاب الرئة (VAP)'],
  ['dvtProphylaxis', 'الوقاية من الجلطات الوريدية (DVT)'],
  ['stressUlcerProphylaxis', 'وقاية قرحة الإجهاد'],
  ['nutritionPlan', 'خطة التغذية السريرية'],
  ['earlyMobility', 'الحركة والتأهيل المبكر'],
];

export default function IcuPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [board, setBoard] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [admissions, setAdmissions] = useState<any[]>([]);
  const [openFor, setOpenFor] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [obs, setObs] = useState<Record<string, string>>({
    heartRate: '',
    systolicBp: '',
    diastolicBp: '',
    respRate: '',
    spo2: '',
    temperatureC: '',
    gcs: '',
    rass: '',
    urineMl: '',
    notes: '',
  });
  const [vent, setVent] = useState({ mode: 'ac', fio2Pct: 40, peepCmh2o: 5, tidalVolumeMl: 450, setRate: 16, reason: '' });
  const [sofa, setSofa] = useState({
    pao2: '90',
    fio2Pct: '40',
    respiratorySupport: true,
    platelets: '200',
    bilirubin: '0.8',
    map: '75',
    vasopressor: 'none',
    gcs: '15',
    creatinine: '1',
    urine24hMl: '',
  });
  const [goals, setGoals] = useState<Record<string, boolean>>({});
  const [closing, setClosing] = useState({ disposition: 'ward', note: '' });

  const load = useCallback(async () => {
    setErr(null);
    try {
      const b = await api<any>('/api/icu/board');
      setBoard(b);
      if (detail?.id) {
        setDetail(await api<any>(`/api/icu/stays/${detail.id}`));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل لوحة العناية المركزة');
    } finally {
      setLoading(false);
    }
  }, [detail?.id]);

  useEffect(() => {
    load();
    if (has(auth, 'icu.manage')) {
      api<any>('/api/inpatient/admissions')
        .then((r) => setAdmissions((r.items ?? []).filter((a: any) => a.status === 'active')))
        .catch(() => setAdmissions([]));
    }
  }, [auth]);

  async function openStay(s: any) {
    try {
      const d = await api<any>(`/api/icu/stays/${s.id}`);
      setDetail(d);
      const today = d.goals?.[0];
      setGoals(
        today
          ? Object.fromEntries(GOAL_LABELS.map(([k]) => [k, !!today[k]]))
          : Object.fromEntries(GOAL_LABELS.map(([k]) => [k, false])),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر فتح ملف العناية المركزة');
    }
  }

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تنفيذ العملية');
    } finally {
      setBusy(false);
    }
  }

  if (err && !board) return <ErrorState message={err} onRetry={load} />;
  if (loading && !board) return <PageSkeleton cards={3} rows={5} />;

  const latest = detail?.observations?.[0];
  const latestVent = detail?.ventilator?.[0];
  const latestSofa = detail?.scores?.[0];

  return (
    <div className="space-y-4">
      <PageHeader
        title="العناية المركزة (ICU)"
        subtitle="مراقبة ساعية، إعدادات التنفس الصناعي المؤرشفة، حزم الرعاية اليومية، وحساب مؤشر SOFA على الخادم."
      />

      {board && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="مرضى العناية المركزة" value={board.totals.patients} />
          <StatCard label="على دعم تنفسي" value={board.totals.ventilated} tone="warning" />
          <StatCard
            label="متوسط درجة SOFA"
            value={board.totals.avg_sofa ?? 0}
            tone={(board.totals.avg_sofa ?? 0) >= 10 ? 'danger' : 'default'}
          />
        </div>
      )}

      <Card title="لوحة أسرّة العناية المركزة">
        <DataTable
          caption="مرضى العناية المركزة"
          rows={board?.items ?? []}
          rowKey={(i) => i.id}
          rowClassName={(i) => ((i.sofa_total ?? 0) >= 10 ? 'bg-rose-50/60' : '')}
          emptyTitle="لا يوجد مرضى في العناية المركزة حاليًا"
          cardTitle={(i) => i.patient_name}
          cardSubtitle={(i) => `${i.ward_name} · ${i.room_no}/${i.bed_no} · ${i.mrn}`}
          cardBadge={(i) => (
            <span className="badge bg-slate-100 text-slate-800">SOFA: {i.sofa_total ?? '—'}</span>
          )}
          cardActions={(i) => (
            <Button variant="primary" size="sm" onClick={() => openStay(i)}>
              فتح ملف العناية
            </Button>
          )}
          columns={[
            {
              key: 'bed',
              header: 'السرير',
              render: (i) => (
                <div className="text-xs">
                  <span className="font-semibold">
                    {i.ward_name} · {i.room_no}/{i.bed_no}
                  </span>
                  <span className="block text-slate-400 font-mono">{i.stay_no}</span>
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
              key: 'vitals',
              header: 'آخر قياسات',
              render: (i) =>
                i.last_observed_at ? (
                  <div className="text-xs">
                    نبض {i.heart_rate ?? '—'} · {i.systolic_bp ?? '—'}/{i.diastolic_bp ?? '—'} · SpO₂ {i.spo2 ?? '—'}% · GCS{' '}
                    {i.gcs ?? '—'}
                    <span className="block text-slate-400">{formatDateTime(i.last_observed_at)}</span>
                  </div>
                ) : (
                  '—'
                ),
            },
            {
              key: 'vent',
              header: 'التنفس الصناعي',
              render: (i) =>
                i.vent_mode ? (
                  <div className="text-xs">
                    {VENT_AR[i.vent_mode] ?? i.vent_mode}
                    <span className="block text-slate-500">
                      FiO₂ {i.fio2_pct}% · PEEP {i.peep_cmh2o ?? '—'}
                    </span>
                  </div>
                ) : (
                  'بلا دعم'
                ),
            },
            {
              key: 'sofa',
              header: 'SOFA',
              render: (i) => (
                <span
                  className={`font-bold ${
                    (i.sofa_total ?? 0) >= 10
                      ? 'text-rose-700'
                      : (i.sofa_total ?? 0) >= 6
                        ? 'text-amber-700'
                        : 'text-slate-700'
                  }`}
                >
                  {i.sofa_total ?? '—'}
                </span>
              ),
            },
            {
              key: 'bundle',
              header: 'حزمة اليوم',
              render: (i) =>
                i.bundled_today ? (
                  <span className="text-xs text-emerald-700 font-semibold">✓ مسجلة</span>
                ) : (
                  <span className="text-xs text-amber-700 font-semibold">▲ غير مسجلة</span>
                ),
            },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (i) => (
                <Button variant="ghost" size="sm" onClick={() => openStay(i)}>
                  فتح الملف
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {has(auth, 'icu.manage') && (
        <Card title="فتح إقامة عناية مركزة جديدة" subtitle="يشترط وجود تنويم نشط على سرير مصنّف عناية مركزة.">
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[260px]">
              <Select
                label="التنويم النشط"
                value={openFor}
                onChange={(e) => setOpenFor(e.target.value)}
              >
                <option value="">— اختر تنويمًا نشطًا —</option>
                {admissions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.admission_no} · {a.patient_name} · {a.ward_name ?? ''}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="primary"
              busy={busy}
              disabled={!openFor}
              onClick={() =>
                act(async () => {
                  await api('/api/icu/stays', { method: 'POST', body: JSON.stringify({ admissionId: openFor }) });
                  setOpenFor('');
                }, 'فُتحت إقامة العناية المركزة')
              }
            >
              فتح إقامة العناية
            </Button>
          </div>
        </Card>
      )}

      {detail && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Card
            title={`${detail.patient_name} — ${detail.stay_no}`}
            subtitle={`${detail.ward_name} · ${detail.room_no}/${detail.bed_no} · تنويم ${detail.admission_no}`}
            action={
              <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                إغلاق
              </Button>
            }
          >
            <div className="text-xs space-y-1 text-slate-600 mb-3">
              <p>الطبيب الاستشاري: {detail.intensivist_name ?? '—'} · بدأت: {formatDateTime(detail.opened_at)}</p>
              {latestSofa && (
                <p>
                  آخر درجة SOFA: <b>{latestSofa.total}</b> / 24 — {formatDateTime(latestSofa.recorded_at)}
                </p>
              )}
            </div>

            <div className="border-t border-slate-100 pt-2">
              <p className="text-xs font-bold mb-1.5">آخر القياسات المسجلة</p>
              {latest ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs bg-slate-50 p-2.5 rounded-xl">
                  <span>نبض: {latest.heart_rate ?? '—'}</span>
                  <span>ضغط: {latest.systolic_bp ?? '—'}/{latest.diastolic_bp ?? '—'}</span>
                  <span>تنفس: {latest.resp_rate ?? '—'}</span>
                  <span>SpO₂: {latest.spo2 ?? '—'}%</span>
                  <span>حرارة: {latest.temperature_c ?? '—'}°</span>
                  <span>GCS: {latest.gcs ?? '—'}</span>
                  <span>RASS: {latest.rass ?? '—'}</span>
                  <span>بول: {latest.urine_ml ?? '—'} مل</span>
                </div>
              ) : (
                <p className="text-xs text-slate-400">لا توجد قياسات مسجلة بعد.</p>
              )}
            </div>

            {detail.status === 'active' && has(auth, 'icu.chart') && (
              <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
                <p className="text-sm font-bold">تسجيل قياسات ساعية جديدة</p>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['heartRate', 'نبض'],
                    ['systolicBp', 'انقباضي'],
                    ['diastolicBp', 'انبساطي'],
                    ['respRate', 'تنفس'],
                    ['spo2', 'SpO₂'],
                    ['temperatureC', 'حرارة'],
                    ['gcs', 'GCS'],
                    ['rass', 'RASS'],
                    ['urineMl', 'بول/ساعة'],
                  ].map(([k, label]) => (
                    <Input
                      key={k}
                      label={label}
                      type="number"
                      step="0.1"
                      value={obs[k]}
                      onChange={(e) => setObs({ ...obs, [k]: e.target.value })}
                    />
                  ))}
                </div>
                <Input
                  label="ملاحظة سريرية (اختياري)"
                  value={obs.notes}
                  onChange={(e) => setObs({ ...obs, notes: e.target.value })}
                />
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  disabled={!Object.entries(obs).some(([k, v]) => k !== 'notes' && v !== '')}
                  onClick={() =>
                    act(async () => {
                      await api(`/api/icu/stays/${detail.id}/observations`, {
                        method: 'POST',
                        body: JSON.stringify({
                          ...Object.fromEntries(
                            Object.entries(obs)
                              .filter(([k, v]) => k !== 'notes' && v !== '')
                              .map(([k, v]) => [k, Number(v)]),
                          ),
                          notes: obs.notes || undefined,
                        }),
                      });
                      setObs({ ...obs, notes: '' });
                    }, 'سُجلت القياسات الحيوية للعناية المركزة')
                  }
                >
                  حفظ القياسات
                </Button>
              </div>
            )}

            {detail.status === 'active' && has(auth, 'icu.discharge') && (
              <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
                <p className="text-sm font-bold">إغلاق إقامة العناية المركزة</p>
                <Select
                  label="وجهة الخروج من العناية"
                  value={closing.disposition}
                  onChange={(e) => setClosing({ ...closing, disposition: e.target.value })}
                >
                  {Object.entries(ICU_DISPOSITION_AR).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Input
                  label="ملخص الإغلاق السريري (15 حرفًا على الأقل)"
                  value={closing.note}
                  onChange={(e) => setClosing({ ...closing, note: e.target.value })}
                />
                <Button
                  variant="danger"
                  size="sm"
                  busy={busy}
                  disabled={closing.note.trim().length < 15}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/icu/stays/${detail.id}/discharge`, {
                          method: 'POST',
                          body: JSON.stringify(closing),
                        }),
                      'أُغلقت إقامة العناية المركزة',
                    )
                  }
                >
                  تأكيد الإغلاق
                </Button>
              </div>
            )}
          </Card>

          <Card title="التنفس الصناعي، حزمة الرعاية، ومؤشر SOFA">
            <div className="text-xs mb-3">
              <p className="font-bold text-slate-700">إعداد التنفس الحالي:</p>
              {latestVent ? (
                <p className="mt-0.5">
                  {VENT_AR[latestVent.mode]} · FiO₂ {latestVent.fio2_pct}% · PEEP {latestVent.peep_cmh2o ?? '—'} ·{' '}
                  {latestVent.tidal_volume_ml ?? '—'} مل
                </p>
              ) : (
                <p className="text-slate-400">لا إعدادات مسجلة.</p>
              )}
            </div>

            {detail.status === 'active' && has(auth, 'icu.ventilator') && (
              <div className="border-t border-slate-100 pt-3 mb-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    label="نمط التهوية"
                    value={vent.mode}
                    onChange={(e) => setVent({ ...vent, mode: e.target.value })}
                  >
                    {Object.entries(VENT_AR).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                  <Input
                    label="FiO₂ %"
                    type="number"
                    value={vent.fio2Pct}
                    onChange={(e) => setVent({ ...vent, fio2Pct: Number(e.target.value) })}
                  />
                  <Input
                    label="PEEP (cmH₂O)"
                    type="number"
                    value={vent.peepCmh2o}
                    onChange={(e) => setVent({ ...vent, peepCmh2o: Number(e.target.value) })}
                  />
                  <Input
                    label="حجم المد (مل)"
                    type="number"
                    value={vent.tidalVolumeMl}
                    onChange={(e) => setVent({ ...vent, tidalVolumeMl: Number(e.target.value) })}
                  />
                </div>
                <Input
                  label="سبب تغيير الإعدادات"
                  value={vent.reason}
                  onChange={(e) => setVent({ ...vent, reason: e.target.value })}
                />
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/icu/stays/${detail.id}/ventilator`, {
                          method: 'POST',
                          body: JSON.stringify({ ...vent, reason: vent.reason || undefined }),
                        }),
                      'حُفظ إصدار جديد لإعدادات التنفس الصناعي',
                    )
                  }
                >
                  تسجيل الإعدادات
                </Button>
              </div>
            )}

            {detail.status === 'active' && has(auth, 'icu.chart') && (
              <div className="border-t border-slate-100 pt-3 mb-3 space-y-2">
                <p className="text-sm font-bold">حزمة الرعاية اليومية (ICU Care Bundle)</p>
                <div className="grid sm:grid-cols-2 gap-1.5">
                  {GOAL_LABELS.map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!goals[k]}
                        onChange={(e) => setGoals({ ...goals, [k]: e.target.checked })}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/icu/stays/${detail.id}/goals`, {
                          method: 'POST',
                          body: JSON.stringify(goals),
                        }),
                      'حُفظت حزمة الرعاية اليومية',
                    )
                  }
                >
                  حفظ حزمة اليوم
                </Button>
              </div>
            )}

            {detail.status === 'active' && has(auth, 'icu.chart') && (
              <div className="border-t border-slate-100 pt-3 space-y-2">
                <p className="text-sm font-bold">حساب درجة SOFA المعيارية</p>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['pao2', 'PaO₂'],
                      ['fio2Pct', 'FiO₂ %'],
                      ['platelets', 'صفيحات'],
                      ['bilirubin', 'بيليروبين'],
                      ['map', 'MAP'],
                      ['gcs', 'GCS'],
                      ['creatinine', 'كرياتينين'],
                      ['urine24hMl', 'بول 24س'],
                    ] as const
                  ).map(([k, label]) => (
                    <Input
                      key={k}
                      label={label}
                      type="number"
                      step="0.1"
                      value={sofa[k]}
                      onChange={(e) => setSofa({ ...sofa, [k]: e.target.value })}
                    />
                  ))}
                  <Select
                    label="رافع الضغط"
                    value={sofa.vasopressor}
                    onChange={(e) => setSofa({ ...sofa, vasopressor: e.target.value })}
                  >
                    <option value="none">بلا رافع ضغط</option>
                    <option value="dobutamine">دوبوتامين</option>
                    <option value="dopamine_low">دوبامين ≤5</option>
                    <option value="dopamine_mid">دوبامين &gt;5</option>
                    <option value="dopamine_high">دوبامين &gt;15</option>
                    <option value="norepinephrine_low">نورإبينفرين ≤0.1</option>
                    <option value="norepinephrine_high">نورإبينفرين &gt;0.1</option>
                    <option value="epinephrine_low">إبينفرين ≤0.1</option>
                    <option value="epinephrine_high">إبينفرين &gt;0.1</option>
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={sofa.respiratorySupport}
                    onChange={(e) => setSofa({ ...sofa, respiratorySupport: e.target.checked })}
                  />
                  المريض على دعم تنفسي ميكانيكي
                </label>
                <Button
                  variant="primary"
                  size="sm"
                  busy={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`/api/icu/stays/${detail.id}/sofa`, {
                          method: 'POST',
                          body: JSON.stringify({
                            vasopressor: sofa.vasopressor,
                            respiratorySupport: sofa.respiratorySupport,
                            pao2: Number(sofa.pao2),
                            fio2Pct: Number(sofa.fio2Pct),
                            platelets: Number(sofa.platelets),
                            bilirubin: Number(sofa.bilirubin),
                            map: Number(sofa.map),
                            gcs: Number(sofa.gcs),
                            creatinine: Number(sofa.creatinine),
                            urine24hMl: sofa.urine24hMl === '' ? undefined : Number(sofa.urine24hMl),
                          }),
                        }),
                      'تم حساب وحفظ درجة SOFA',
                    )
                  }
                >
                  حساب وحفظ SOFA
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

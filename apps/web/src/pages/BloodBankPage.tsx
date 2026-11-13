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
  Tabs,
  useToast,
} from '../components';
import { formatDateTime } from '../lib/format';

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const COMPONENT_AR: Record<string, string> = {
  rbc: 'كريات دم حمراء',
  ffp: 'بلازما طازجة مجمدة',
  platelets: 'صفائح دموية',
  cryo: 'راسب قري',
};
const URGENCY_AR: Record<string, string> = { routine: 'روتيني', urgent: 'عاجل', emergency: 'طارئ' };
const REACTION_AR: Record<string, string> = {
  febrile: 'حمّوي غير انحلالي',
  allergic: 'تحسسي',
  hemolytic: 'انحلالي حاد',
  trali: 'TRALI',
  taco: 'TACO',
  septic: 'إنتاني',
  other: 'أخرى',
};
const SEVERITY_AR: Record<string, string> = {
  mild: 'خفيف',
  moderate: 'متوسط',
  severe: 'شديد',
  life_threatening: 'مهدد للحياة',
};
const OUTCOME_AR: Record<string, string> = {
  completed: 'مكتمل بنجاح',
  stopped_reaction: 'أُوقف لتفاعل نقل',
  stopped_other: 'أُوقف لسبب آخر',
};

export default function BloodBankPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [stock, setStock] = useState<any>(null);
  const [requestList, setRequestList] = useState<any[]>([]);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [sel, setSel] = useState<any>(null);
  const [match, setMatch] = useState<any>(null);
  const [reserved, setReserved] = useState<any[]>([]);
  const [unit, setUnit] = useState<any>(null);
  const [checkers, setCheckers] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [encounters, setEncounters] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [donor, setDonor] = useState({
    bloodType: 'O+',
    hemoglobin: '',
    hbv: true,
    hcv: true,
    hiv: true,
    syphilis: true,
    deferralReason: '',
    components: ['rbc'],
  });
  const [req, setReq] = useState({
    patientId: '',
    encounterId: '',
    component: 'rbc',
    unitsRequested: 2,
    urgency: 'routine',
    indication: '',
    hbValue: '',
  });
  const [tx, setTx] = useState<Record<string, any>>({
    secondCheckerId: '',
    preHeartRate: '',
    preSystolicBp: '',
    preTemperatureC: '',
    preSpo2: '',
    consent: false,
  });
  const [closing, setClosing] = useState({ outcome: 'completed', volumeTransfusedMl: '', notes: '' });
  const [reaction, setReaction] = useState({
    reactionType: 'febrile',
    severity: 'mild',
    description: '',
    actionTaken: '',
  });

  const [discardTarget, setDiscardTarget] = useState<{ id: string; unitNo: string } | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<{ unitId: string; unitNo: string } | null>(null);

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      const [s, r] = await Promise.all([
        api<any>('/api/bloodbank/stock'),
        api<any>(`/api/bloodbank/requests?status=${filter}`),
      ]);
      setStock(s);
      setRequestList(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات بنك الدم');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadAll();
    if (has(auth, 'bloodbank.transfuse')) {
      api<any>('/api/bloodbank/second-checkers')
        .then((r) => setCheckers(r.items ?? []))
        .catch(() => setCheckers([]));
    }
    if (has(auth, 'bloodbank.request') && has(auth, 'patient.read')) {
      api<any>('/api/patients?limit=100')
        .then((r) => setPatients(r.items ?? []))
        .catch(() => setPatients([]));
    }
  }, [auth, loadAll]);

  async function refreshPanels(activeReq = sel, activeUnit = unit) {
    await loadAll();
    if (activeReq && has(auth, 'bloodbank.crossmatch')) {
      try {
        setMatch(await api<any>(`/api/bloodbank/requests/${activeReq.id}/compatible-units`));
      } catch {
        /* ignore */
      }
    }
    if (activeReq && has(auth, 'bloodbank.issue')) {
      try {
        const x = await api<any>(`/api/bloodbank/requests/${activeReq.id}/reserved-units`);
        setReserved(x.items ?? []);
      } catch {
        /* ignore */
      }
    }
    if (activeUnit) {
      try {
        setUnit(await api<any>(`/api/bloodbank/units/${activeUnit.id}`));
      } catch {
        /* ignore */
      }
    }
  }

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await refreshPanels();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تنفيذ الإجراء');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function openRequest(r: any) {
    setSel(r);
    setMatch(null);
    setReserved([]);
    setUnit(null);
    if (has(auth, 'bloodbank.crossmatch')) {
      try {
        setMatch(await api<any>(`/api/bloodbank/requests/${r.id}/compatible-units`));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'تعذّر تحميل وحدات المطابقة');
      }
    }
    if (has(auth, 'bloodbank.issue')) {
      try {
        const x = await api<any>(`/api/bloodbank/requests/${r.id}/reserved-units`);
        setReserved(x.items ?? []);
      } catch {
        /* ignore */
      }
    }
  }

  async function openUnit(id: string) {
    try {
      setUnit(await api<any>(`/api/bloodbank/units/${id}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر فتح تفاصيل الوحدة');
    }
  }

  async function pickPatient(patientId: string) {
    setReq({ ...req, patientId, encounterId: '' });
    setEncounters([]);
    if (!patientId) return;
    try {
      const r = await api<any>(`/api/encounters?patientId=${patientId}`);
      const list = r.items ?? [];
      setEncounters(list);
      if (list[0]) setReq((cur) => ({ ...cur, patientId, encounterId: list[0].id }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر جلب الزيارات');
    }
  }

  if (err && !stock) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && !stock) return <PageSkeleton cards={5} rows={6} />;

  const selectedPatient = patients.find((p) => p.id === req.patientId);
  const latestMatch = unit?.crossmatches?.length
    ? [...unit.crossmatches].reverse().find((c: any) => c.result === 'compatible') ??
      unit.crossmatches[unit.crossmatches.length - 1]
    : null;
  const activeTx = (unit?.transfusions ?? []).find((t: any) => !t.completed_at);
  const doneTx = (unit?.transfusions ?? []).find((t: any) => t.completed_at);
  const anyReaction = (unit?.transfusions ?? []).some((t: any) => t.reaction);
  const hasScreeningPass = donor.hbv && donor.hcv && donor.hiv && donor.syphilis;

  return (
    <div className="space-y-4">
      <PageHeader
        title="بنك الدم وسلسلة النقل السريري"
        subtitle="مصفوفة توافق ABO/Rh، فحص المطابقة، الصرف، التحقق المزدوج قبل النقل، والإبلاغ عن التفاعلات."
      />

      {stock && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard label="وحدات متاحة" value={stock.totals.available} tone="success" />
          <StatCard label="محجوزة للمرضى" value={stock.totals.reserved} tone="warning" />
          <StatCard label="مصروفة للأجنحة" value={stock.totals.issued} tone="info" />
          <StatCard
            label="منتهية الصلاحية"
            value={stock.totals.expired}
            tone={stock.totals.expired > 0 ? 'danger' : 'default'}
          />
          <StatCard label="نُقلت اليوم" value={stock.totals.transfused_today} />
        </div>
      )}

      <Card
        title="مخزون بنك الدم حسب الفصيلة والمكوّن"
        subtitle="الحد الصريح: فحص ABO/Rh مطبّق على الخادم؛ لا يشمل فحص الأجسام المضادة غير النمطية ولا ربط بنك دم وطني."
      >
        <div className="overflow-x-auto mb-4">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr>
                <th className="th">المكوّن</th>
                {BLOOD_TYPES.map((t) => (
                  <th key={t} className="th text-center" dir="ltr">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(COMPONENT_AR).map((c) => (
                <tr key={c}>
                  <td className="td font-semibold">{COMPONENT_AR[c]}</td>
                  {BLOOD_TYPES.map((t) => {
                    const g = (stock?.grid ?? []).find((x: any) => x.component === c && x.blood_type === t);
                    const n = g?.available ?? 0;
                    return (
                      <td
                        key={t}
                        className={`td text-center ${n > 0 ? 'font-bold text-emerald-700' : 'text-slate-300'}`}
                      >
                        {n || '—'}
                        {g?.reserved ? (
                          <span className="block text-[11px] font-normal text-amber-700">محجوز {g.reserved}</span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <DataTable
          caption="وحدات الدم المسجلة"
          rows={stock?.units ?? []}
          rowKey={(u) => u.id}
          rowClassName={(u) => (u.expired ? 'bg-rose-50/70' : '')}
          emptyTitle="لا توجد وحدات مسجلة في المخزون"
          cardTitle={(u) => `${u.unit_no} (${u.blood_type})`}
          cardSubtitle={(u) => `${u.component_ar} · متبرع ${u.donor_no}`}
          cardBadge={(u) => <Badge value={u.status} />}
          cardActions={(u) => (
            <Button variant="ghost" size="sm" onClick={() => openUnit(u.id)}>
              تفاصيل وتتبع
            </Button>
          )}
          columns={[
            { key: 'no', header: 'رقم الوحدة', render: (u) => <span className="font-mono text-xs">{u.unit_no}</span> },
            { key: 'comp', header: 'المكوّن', render: (u) => u.component_ar },
            { key: 'bt', header: 'الفصيلة', render: (u) => <b dir="ltr">{u.blood_type}</b> },
            {
              key: 'exp',
              header: 'الصلاحية',
              render: (u) => (
                <div className="text-xs">
                  {u.expired ? (
                    <span className="text-rose-700 font-bold">منتهية</span>
                  ) : (
                    <span className={u.days_left <= 5 ? 'text-amber-700 font-semibold' : ''}>{u.days_left} يوم</span>
                  )}
                  <span className="block text-slate-400">{formatDateTime(u.expires_at)}</span>
                </div>
              ),
            },
            { key: 'st', header: 'الحالة', render: (u) => <Badge value={u.status} /> },
            { key: 'donor', header: 'المتبرع', render: (u) => <span className="font-mono text-xs">{u.donor_no}</span> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (u) => (
                <Button variant="ghost" size="sm" onClick={() => openUnit(u.id)}>
                  تفاصيل
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="طلبات نقل الدم"
        action={
          <Tabs
            active={filter}
            onChange={setFilter}
            items={[
              { key: 'active', label: 'النشطة' },
              { key: 'all', label: 'الكل' },
            ]}
          />
        }
      >
        <DataTable
          caption="طلبات نقل الدم"
          rows={requestList}
          rowKey={(r) => r.id}
          emptyTitle="لا توجد طلبات دم مطابقة"
          cardTitle={(r) => `${r.patient_name} (${r.patient_blood_type ?? '—'})`}
          cardSubtitle={(r) => `${r.request_no} · ${r.component_ar} · ${r.transfused_units}/${r.units_requested}`}
          cardBadge={(r) => <Badge value={r.status} />}
          cardActions={(r) => (
            <Button variant="primary" size="sm" onClick={() => openRequest(r)}>
              المطابقة والصرف
            </Button>
          )}
          columns={[
            {
              key: 'no',
              header: 'الطلب',
              render: (r) => (
                <div className="text-xs">
                  <span className="font-mono">{r.request_no}</span>
                  <span className="block text-slate-400">{formatDateTime(r.requested_at)}</span>
                </div>
              ),
            },
            {
              key: 'pt',
              header: 'المريض',
              render: (r) => (
                <div>
                  <span className="font-semibold">{r.patient_name}</span>
                  <span className="block text-xs text-slate-400">
                    {r.mrn} · {r.patient_blood_type ?? 'فصيلة غير مسجلة'}
                  </span>
                </div>
              ),
            },
            { key: 'comp', header: 'المكوّن', render: (r) => r.component_ar },
            { key: 'units', header: 'الوحدات', render: (r) => `${r.transfused_units}/${r.units_requested}` },
            { key: 'urg', header: 'الأولوية', render: (r) => URGENCY_AR[r.urgency] ?? r.urgency },
            { key: 'st', header: 'الحالة', render: (r) => <Badge value={r.status} /> },
            { key: 'ind', header: 'الاستطباب', render: (r) => <span className="text-xs">{r.indication}</span> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (r) => (
                <Button variant="ghost" size="sm" onClick={() => openRequest(r)}>
                  المطابقة والصرف
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {sel && (
        <Card
          title={`مطابقة وصرف الطلب ${sel.request_no} — ${sel.patient_name}`}
          subtitle={`فصيلة المريض: ${sel.patient_blood_type ?? 'غير مسجلة'} · المكوّن: ${sel.component_ar}`}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSel(null);
                setMatch(null);
                setReserved([]);
              }}
            >
              إغلاق
            </Button>
          }
        >
          {reserved.length > 0 && (
            <div className="mb-4">
              <p className="text-sm font-bold mb-2">الوحدات المحجوزة الجاهزة للصرف</p>
              <div className="space-y-1.5">
                {reserved.map((u) => (
                  <div key={u.id} className="flex items-center justify-between bg-emerald-50/60 border border-emerald-200 rounded-xl px-3 py-2 text-xs">
                    <span>
                      <b className="font-mono">{u.unit_no}</b> · {u.blood_type} · {u.component_ar} ({u.days_left} يوم)
                    </span>
                    {has(auth, 'bloodbank.issue') && (
                      <Button
                        variant="primary"
                        size="sm"
                        busy={busy}
                        onClick={() =>
                          act(
                            () =>
                              api(`/api/bloodbank/requests/${sel.id}/issue`, {
                                method: 'POST',
                                body: JSON.stringify({ unitId: u.id }),
                              }),
                            `صُرفت الوحدة ${u.unit_no} للجناح`,
                          ).catch(() => {})
                        }
                      >
                        صرف للجناح
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {match && (
            <div>
              <p className="text-sm font-bold mb-2">
                فحص التوافق — متوافقة {match.compatibleCount} من أصل {match.units.length}
              </p>
              <DataTable
                caption="نتائج فحص التوافق"
                rows={match.units}
                rowKey={(u: any) => u.id}
                emptyTitle="لا توجد وحدات متاحة من هذا المكوّن"
                cardTitle={(u: any) => `${u.unit_no} (${u.blood_type})`}
                cardSubtitle={(u: any) => `${u.days_left} يوم متبقٍ`}
                cardBadge={(u: any) => (
                  <Badge value={u.compatible ? 'verified' : 'cancelled'} label={u.compatible ? 'متوافقة' : 'غير متوافقة'} />
                )}
                columns={[
                  { key: 'no', header: 'الوحدة', render: (u: any) => <span className="font-mono text-xs">{u.unit_no}</span> },
                  { key: 'bt', header: 'الفصيلة', render: (u: any) => <b dir="ltr">{u.blood_type}</b> },
                  { key: 'days', header: 'الصلاحية', render: (u: any) => `${u.days_left} يوم` },
                  {
                    key: 'res',
                    header: 'نتيجة التوافق',
                    render: (u: any) =>
                      u.compatible ? (
                        <span className="text-emerald-700 font-semibold">✓ متوافقة</span>
                      ) : (
                        <span className="text-rose-700">{u.reason}</span>
                      ),
                  },
                  {
                    key: 'act',
                    header: 'إجراء',
                    render: (u: any) =>
                      has(auth, 'bloodbank.crossmatch') ? (
                        u.compatible ? (
                          <Button
                            variant="primary"
                            size="sm"
                            busy={busy}
                            onClick={() =>
                              act(
                                () =>
                                  api(`/api/bloodbank/requests/${sel.id}/crossmatch`, {
                                    method: 'POST',
                                    body: JSON.stringify({ unitId: u.id, method: 'gel' }),
                                  }),
                                `حُجزت الوحدة ${u.unit_no}`,
                              ).catch(() => {})
                            }
                          >
                            فحص وحجز
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setOverrideTarget({ unitId: u.id, unitNo: u.unit_no })}
                          >
                            توثيق قرار تجاوز
                          </Button>
                        )
                      ) : null,
                  },
                ]}
              />
            </div>
          )}
        </Card>
      )}

      {unit && (
        <Card
          title={`تفاصيل الوحدة ${unit.unit_no} — ${COMPONENT_AR[unit.component]}`}
          action={
            <Button variant="ghost" size="sm" onClick={() => setUnit(null)}>
              إغلاق
            </Button>
          }
        >
          <div className="grid sm:grid-cols-2 gap-3 text-xs text-slate-700">
            <div className="space-y-1">
              <p>
                الفصيلة: <b dir="ltr">{unit.blood_type}</b> · الحجم: {unit.volume_ml ?? '—'} مل · الحالة:{' '}
                <Badge value={unit.status} />
              </p>
              <p>
                المتبرع: <span className="font-mono">{unit.donor_no}</span> · تاريخ الجمع: {formatDateTime(unit.collected_at)}
              </p>
              {unit.discard_reason && <p className="text-rose-700 font-semibold">سبب الاستبعاد: {unit.discard_reason}</p>}
            </div>
            <div className="space-y-1">
              <p>
                الفحوص الفيروسية: HBV {unit.screening?.hbv ? 'سلبي' : 'إيجابي'} · HCV{' '}
                {unit.screening?.hcv ? 'سلبي' : 'إيجابي'} · HIV {unit.screening?.hiv ? 'سلبي' : 'إيجابي'} · الزهري{' '}
                {unit.screening?.syphilis ? 'سلبي' : 'إيجابي'}
              </p>
            </div>
          </div>

          {(unit.transfusions ?? []).map((t: any) => (
            <div
              key={t.id}
              className={`mt-3 rounded-xl border p-3 text-xs ${
                t.completed_at ? 'bg-slate-50 border-slate-200' : 'bg-amber-50 border-amber-200'
              }`}
            >
              <p className="font-bold">
                نقل بدأه {t.started_by_name} · تدقيق مزدوج: {t.checker_name} · {formatDateTime(t.started_at)}
              </p>
              <p className="mt-0.5">
                {t.completed_at
                  ? `انتهى ${formatDateTime(t.completed_at)} — ${OUTCOME_AR[t.outcome] ?? t.outcome} · ${t.volume_transfused_ml ?? 0} مل`
                  : 'جارٍ النقل الآن — بانتظار الإغلاق'}
              </p>
              {t.reaction && (
                <p className="text-rose-700 font-semibold mt-1">
                  ⚠ تفاعل مسجل: {REACTION_AR[t.reaction.reaction_type]} ({SEVERITY_AR[t.reaction.severity]}) —{' '}
                  {t.reaction.description}
                </p>
              )}
            </div>
          ))}

          {unit.status === 'issued' && !activeTx && has(auth, 'bloodbank.transfuse') && latestMatch && (
            <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
              <p className="text-sm font-bold">بدء النقل السريري (يتطلب مدققًا ثانيًا وموافقة مستنيرة)</p>
              <div className="grid sm:grid-cols-5 gap-2">
                <Select
                  label="المدقق الثاني"
                  value={tx.secondCheckerId}
                  onChange={(e) => setTx({ ...tx, secondCheckerId: e.target.value })}
                >
                  <option value="">— اختر المدقق —</option>
                  {checkers
                    .filter((c) => c.id !== auth.user.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.full_name_ar}
                      </option>
                    ))}
                </Select>
                <Input label="نبض" value={tx.preHeartRate} onChange={(e) => setTx({ ...tx, preHeartRate: e.target.value })} />
                <Input label="انقباضي" value={tx.preSystolicBp} onChange={(e) => setTx({ ...tx, preSystolicBp: e.target.value })} />
                <Input label="SpO₂" value={tx.preSpo2} onChange={(e) => setTx({ ...tx, preSpo2: e.target.value })} />
                <Input label="حرارة" value={tx.preTemperatureC} onChange={(e) => setTx({ ...tx, preTemperatureC: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={tx.consent}
                  onChange={(e) => setTx({ ...tx, consent: e.target.checked })}
                />
                تم التحقق المزدوج من هوية المريض، الموافقة المستنيرة، ومطابقة الوحدة
              </label>
              <Button
                variant="primary"
                size="sm"
                busy={busy}
                disabled={!tx.secondCheckerId || !tx.consent}
                onClick={() =>
                  act(
                    () =>
                      api(`/api/bloodbank/units/${unit.id}/transfuse`, {
                        method: 'POST',
                        body: JSON.stringify({
                          requestId: latestMatch.request_id,
                          secondCheckerId: tx.secondCheckerId,
                          consentConfirmed: true,
                          ...Object.fromEntries(
                            Object.entries(tx)
                              .filter(([k, v]) => k.startsWith('pre') && v !== '')
                              .map(([k, v]) => [k, Number(v)]),
                          ),
                        }),
                      }),
                    'بدأ نقل وحدة الدم بعد التحقق المزدوج',
                  ).catch(() => {})
                }
              >
                بدء النقل
              </Button>
            </div>
          )}

          {activeTx && has(auth, 'bloodbank.transfuse') && (
            <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
              <p className="text-sm font-bold">إغلاق سجل النقل</p>
              <div className="grid sm:grid-cols-3 gap-2">
                <Select
                  label="نتيجة النقل"
                  value={closing.outcome}
                  onChange={(e) => setClosing({ ...closing, outcome: e.target.value })}
                >
                  {Object.entries(OUTCOME_AR).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Input
                  label="الحجم المنقول (مل)"
                  type="number"
                  value={closing.volumeTransfusedMl}
                  onChange={(e) => setClosing({ ...closing, volumeTransfusedMl: e.target.value })}
                />
                <Input
                  label="ملاحظات"
                  value={closing.notes}
                  onChange={(e) => setClosing({ ...closing, notes: e.target.value })}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                busy={busy}
                disabled={closing.volumeTransfusedMl === '' || Number(closing.volumeTransfusedMl) > 600}
                onClick={() =>
                  act(
                    () =>
                      api(`/api/bloodbank/transfusions/${activeTx.id}/complete`, {
                        method: 'POST',
                        body: JSON.stringify({
                          outcome: closing.outcome,
                          volumeTransfusedMl: Number(closing.volumeTransfusedMl),
                          notes: closing.notes || undefined,
                        }),
                      }),
                    'أُغلق سجل نقل الدم',
                  ).catch(() => {})
                }
              >
                حفظ نتيجة النقل
              </Button>
            </div>
          )}

          {unit.status === 'transfused' && !anyReaction && has(auth, 'bloodbank.reaction') && (
            <div className="mt-4 border-t border-slate-100 pt-3 space-y-2">
              <p className="text-sm font-bold text-rose-800">الإبلاغ عن تفاعل نقل دم</p>
              <div className="grid sm:grid-cols-2 gap-2">
                <Select
                  label="نوع التفاعل"
                  value={reaction.reactionType}
                  onChange={(e) => setReaction({ ...reaction, reactionType: e.target.value })}
                >
                  {Object.entries(REACTION_AR).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Select
                  label="الشدة"
                  value={reaction.severity}
                  onChange={(e) => setReaction({ ...reaction, severity: e.target.value })}
                >
                  {Object.entries(SEVERITY_AR).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
                <Input
                  label="وصف التفاعل السريري (10 أحرف على الأقل)"
                  value={reaction.description}
                  onChange={(e) => setReaction({ ...reaction, description: e.target.value })}
                />
                <Input
                  label="الإجراء العلاجي المتخذ (5 أحرف على الأقل)"
                  value={reaction.actionTaken}
                  onChange={(e) => setReaction({ ...reaction, actionTaken: e.target.value })}
                />
              </div>
              <Button
                variant="danger"
                size="sm"
                busy={busy}
                disabled={reaction.description.trim().length < 10 || reaction.actionTaken.trim().length < 5}
                onClick={() =>
                  act(
                    () =>
                      api(`/api/bloodbank/transfusions/${doneTx?.id ?? unit.transfusions[0]?.id}/reactions`, {
                        method: 'POST',
                        body: JSON.stringify(reaction),
                      }),
                    'سُجل تفاعل النقل واستُبعدت الوحدة تلقائيًا',
                  ).catch(() => {})
                }
              >
                تسجيل التفاعل واستبعاد الوحدة
              </Button>
            </div>
          )}

          {(unit.status === 'available' || unit.status === 'reserved') && has(auth, 'bloodbank.stock') && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setDiscardTarget({ id: unit.id, unitNo: unit.unit_no })}
              >
                استبعاد وإتلاف الوحدة
              </Button>
            </div>
          )}
        </Card>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        {has(auth, 'bloodbank.stock') && (
          <Card title="تسجيل تبرع دم جديد">
            <div className="grid sm:grid-cols-3 gap-2">
              <Select
                label="فصيلة الدم"
                value={donor.bloodType}
                onChange={(e) => setDonor({ ...donor, bloodType: e.target.value })}
              >
                {BLOOD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
              <Input
                label="الهيموغلوبين (g/dL)"
                type="number"
                step="0.1"
                value={donor.hemoglobin}
                onChange={(e) => setDonor({ ...donor, hemoglobin: e.target.value })}
              />
              <Input
                label="سبب الاستبعاد (إن وجد)"
                value={donor.deferralReason}
                onChange={(e) => setDonor({ ...donor, deferralReason: e.target.value })}
              />
            </div>
            <div className="flex flex-wrap gap-3 mt-3 text-xs">
              {(
                [
                  ['hbv', 'HBV سلبي'],
                  ['hcv', 'HCV سلبي'],
                  ['hiv', 'HIV سلبي'],
                  ['syphilis', 'الزهري سلبي'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={donor[k]}
                    onChange={(e) => setDonor({ ...donor, [k]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-3 mt-2 text-xs">
              {Object.entries(COMPONENT_AR).map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={donor.components.includes(k)}
                    onChange={(e) =>
                      setDonor({
                        ...donor,
                        components: e.target.checked
                          ? [...donor.components, k]
                          : donor.components.filter((x) => x !== k),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <Button
              variant="primary"
              size="sm"
              className="mt-3"
              busy={busy}
              disabled={donor.components.length === 0}
              onClick={() =>
                act(
                  () =>
                    api('/api/bloodbank/donors', {
                      method: 'POST',
                      body: JSON.stringify({
                        bloodType: donor.bloodType,
                        hemoglobin: donor.hemoglobin === '' ? undefined : Number(donor.hemoglobin),
                        hbvNegative: donor.hbv,
                        hcvNegative: donor.hcv,
                        hivNegative: donor.hiv,
                        syphilisNegative: donor.syphilis,
                        deferralReason: donor.deferralReason || undefined,
                        units: donor.components.map((c) => ({ component: c })),
                      }),
                    }),
                  hasScreeningPass ? 'سُجل التبرع وأُضيفت الوحدات للمخزون' : 'سُجل تبرع غير مؤهل واستُبعدت وحداته',
                ).catch(() => {})
              }
            >
              تسجيل التبرع
            </Button>
          </Card>
        )}

        {has(auth, 'bloodbank.request') && (
          <Card title="إنشاء طلب دم جديد">
            <div className="grid sm:grid-cols-2 gap-2">
              <Select label="المريض" value={req.patientId} onChange={(e) => pickPatient(e.target.value)}>
                <option value="">— اختر المريض —</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.mrn} · {p.fullNameAr} · {p.bloodType ?? 'بلا فصيلة'}
                  </option>
                ))}
              </Select>
              <Select
                label="الزيارة المفتوحة"
                value={req.encounterId}
                onChange={(e) => setReq({ ...req, encounterId: e.target.value })}
              >
                <option value="">— اختر الزيارة —</option>
                {encounters.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.encounter_no} · {e.department_name ?? ''}
                  </option>
                ))}
              </Select>
              <Select
                label="المكوّن المطلوب"
                value={req.component}
                onChange={(e) => setReq({ ...req, component: e.target.value })}
              >
                {Object.entries(COMPONENT_AR).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              <Input
                label="عدد الوحدات"
                type="number"
                min={1}
                max={20}
                value={req.unitsRequested}
                onChange={(e) => setReq({ ...req, unitsRequested: Number(e.target.value) })}
              />
              <Select
                label="الأولوية"
                value={req.urgency}
                onChange={(e) => setReq({ ...req, urgency: e.target.value })}
              >
                {Object.entries(URGENCY_AR).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              <Input
                label="الهيموغلوبين الحالي (اختياري)"
                type="number"
                step="0.1"
                value={req.hbValue}
                onChange={(e) => setReq({ ...req, hbValue: e.target.value })}
              />
            </div>
            <div className="mt-2">
              <Input
                label="الاستطباب السريري (5 أحرف على الأقل)"
                value={req.indication}
                onChange={(e) => setReq({ ...req, indication: e.target.value })}
              />
            </div>
            {selectedPatient && !selectedPatient.bloodType && (
              <p className="text-xs text-rose-700 mt-1.5">فصيلة دم المريض غير مسجلة في ملفه الطبي.</p>
            )}
            <Button
              variant="primary"
              size="sm"
              className="mt-3"
              busy={busy}
              disabled={!req.encounterId || !selectedPatient?.bloodType || req.indication.trim().length < 5}
              onClick={() =>
                act(async () => {
                  await api('/api/bloodbank/requests', {
                    method: 'POST',
                    body: JSON.stringify({
                      patientId: req.patientId,
                      encounterId: req.encounterId,
                      component: req.component,
                      unitsRequested: Number(req.unitsRequested),
                      urgency: req.urgency,
                      indication: req.indication,
                      hbValue: req.hbValue === '' ? undefined : Number(req.hbValue),
                    }),
                  });
                  setReq({ ...req, patientId: '', encounterId: '', indication: '', hbValue: '' });
                  setEncounters([]);
                }, 'أُرسل طلب الدم بنجاح').catch(() => {})
              }
            >
              إرسال الطلب
            </Button>
          </Card>
        )}
      </div>

      {/* ReasonDialog for Unit Discard */}
      <ReasonDialog
        open={!!discardTarget}
        onClose={() => setDiscardTarget(null)}
        title={`استبعاد وحدة الدم ${discardTarget?.unitNo ?? ''}`}
        consequenceNote="الاستبعاد إجراء نهائي يمنع صرف الوحدة أو إعادتها للمخزون ويُسجّل في سجل التدقيق."
        minLength={5}
        confirmLabel="تأكيد الاستبعاد"
        variant="danger"
        onConfirm={async (reason) => {
          if (!discardTarget) return;
          await act(
            () =>
              api(`/api/bloodbank/units/${discardTarget.id}/discard`, {
                method: 'POST',
                body: JSON.stringify({ reason }),
              }),
            'استُبعدت وحدة الدم بسبب موثّق',
          );
        }}
      />

      {/* ReasonDialog for Documented Override */}
      <ReasonDialog
        open={!!overrideTarget}
        onClose={() => setOverrideTarget(null)}
        title={`توثيق قرار سريري على الوحدة ${overrideTarget?.unitNo ?? ''}`}
        consequenceNote="يُسجّل التجاوز الموثق كقرار سريري في سجل المطابقة دون منح إذن صرف تلقائي لوحدة غير متوافقة."
        minLength={5}
        confirmLabel="توثيق القرار"
        variant="primary"
        onConfirm={async (note) => {
          if (!overrideTarget || !sel) return;
          await act(
            () =>
              api(`/api/bloodbank/requests/${sel.id}/crossmatch`, {
                method: 'POST',
                body: JSON.stringify({ unitId: overrideTarget.unitId, method: 'gel', forceIncompatible: true, note }),
              }),
            'سُجّل القرار السريري في سجل المطابقة',
          );
        }}
      />
    </div>
  );
}

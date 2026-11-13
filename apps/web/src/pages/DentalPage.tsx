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
  Tabs,
  Textarea,
  useToast,
} from '../components';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime, formatMoney, formatNumber } from '../lib/format';
import { getBootstrapCached } from '../lib/referenceCache';

type TabKey = 'odontogram' | 'worklist';
type DentitionMode = 'permanent' | 'deciduous';

const PERMANENT_UPPER_RIGHT = [18, 17, 16, 15, 14, 13, 12, 11];
const PERMANENT_UPPER_LEFT = [21, 22, 23, 24, 25, 26, 27, 28];
const PERMANENT_LOWER_RIGHT = [48, 47, 46, 45, 44, 43, 42, 41];
const PERMANENT_LOWER_LEFT = [31, 32, 33, 34, 35, 36, 37, 38];

const DECIDUOUS_UPPER_RIGHT = [55, 54, 53, 52, 51];
const DECIDUOUS_UPPER_LEFT = [61, 62, 63, 64, 65];
const DECIDUOUS_LOWER_RIGHT = [85, 84, 83, 82, 81];
const DECIDUOUS_LOWER_LEFT = [71, 72, 73, 74, 75];

const CONDITION_META: Record<string, { ar: string; symbol: string; tileCls: string }> = {
  healthy: { ar: 'سليم', symbol: '✓', tileCls: 'bg-white border-slate-300 text-slate-800' },
  caries: { ar: 'تسوس نشط', symbol: '●', tileCls: 'bg-rose-50 border-rose-400 text-rose-900' },
  filled: { ar: 'حشوة ترميمية', symbol: '■', tileCls: 'bg-sky-50 border-sky-400 text-sky-900' },
  crown: { ar: 'تاج / تلبيسة', symbol: '♛', tileCls: 'bg-amber-50 border-amber-400 text-amber-900' },
  root_canal: { ar: 'علاج عصب (RCT)', symbol: '⚡', tileCls: 'bg-purple-50 border-purple-400 text-purple-900' },
  missing: { ar: 'مفقود خلقيًا', symbol: '○', tileCls: 'bg-slate-100 border-dashed border-slate-400 text-slate-500' },
  extracted: { ar: 'مخلوع', symbol: '✕', tileCls: 'bg-slate-200 border-slate-400 text-slate-700' },
  implant: { ar: 'زرعة سنية', symbol: '⏚', tileCls: 'bg-emerald-50 border-emerald-500 text-emerald-900' },
  fracture: { ar: 'كسر تاجي/جذري', symbol: '↯', tileCls: 'bg-orange-50 border-orange-400 text-orange-900' },
  periodontal: { ar: 'التهاب لثة ودواعم', symbol: '≈', tileCls: 'bg-pink-50 border-pink-400 text-pink-900' },
};

const SURFACE_OPTIONS = [
  { value: 'whole', label: 'كامل السن (Whole)' },
  { value: 'occlusal', label: 'الإطباقي (Occlusal)' },
  { value: 'mesial', label: 'الإنسي (Mesial)' },
  { value: 'distal', label: 'الوحشي (Distal)' },
  { value: 'buccal', label: 'الدهليزي / الخدي (Buccal)' },
  { value: 'lingual', label: 'اللساني / الحنكي (Lingual)' },
  { value: 'incisal', label: 'القاطع (Incisal)' },
];

export default function DentalPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [tab, setTab] = useState<TabKey>('odontogram');
  const [dentition, setDentition] = useState<DentitionMode>('permanent');

  const [totals, setTotals] = useState<any>(null);
  const [worklist, setWorklist] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [encounters, setEncounters] = useState<any[]>([]);
  const [selectedEncounterId, setSelectedEncounterId] = useState('');
  const [dentalDeptId, setDentalDeptId] = useState('');

  const [chartData, setChartData] = useState<{
    patient: any;
    allergies: any[];
    toothMap: Record<string, any>;
    entries: any[];
    procedures: any[];
  } | null>(null);
  const [selectedTooth, setSelectedTooth] = useState<number>(36);
  const [statusFilter, setStatusFilter] = useState('all');

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Modals
  const [chartModalOpen, setChartModalOpen] = useState(false);
  const [procModalOpen, setProcModalOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<any | null>(null);
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [panoramicOpen, setPanoramicOpen] = useState(false);

  const [chartForm, setChartForm] = useState({
    surface: 'occlusal',
    condition: 'caries',
    notes: '',
  });

  const [procForm, setProcForm] = useState({
    procedureCode: 'D2391',
    toothNumber: '36',
    anesthesiaUsed: '',
    clinicalNotes: '',
    fee: '',
    completeImmediately: false,
  });

  const [completeForm, setCompleteForm] = useState({
    anesthesiaUsed: '',
    clinicalNotes: '',
  });

  const [panoramicIndication, setPanoramicIndication] = useState(
    'تقييم شامل للفكين والأسنان والجذور (Panoramic OPG)',
  );

  const canChart = has(auth, 'dental.chart');
  const canPerform = has(auth, 'dental.perform');
  const canReadPatient = has(auth, 'patient.read');
  const canOrderRad = has(auth, 'radiology.order');
  const canCreateEnc = has(auth, 'clinical.encounter.create');

  const loadBase = useCallback(async () => {
    setErr(null);
    try {
      const [board, ptRes, boot] = await Promise.all([
        api<any>('/api/dental/board'),
        canReadPatient ? api<any>('/api/patients?limit=50').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
        getBootstrapCached(auth.activeFacilityId).catch(() => ({ departments: [] })),
      ]);
      const procs = board.procedures ?? [];
      const cats = board.catalog ?? [];
      const pts = ptRes.items ?? [];
      const dntDept =
        (boot.departments ?? []).find((d: any) => d.dept_type === 'dental' || d.code === 'DNT') ??
        boot.departments?.[0];

      setTotals(board.totals ?? null);
      setWorklist(procs);
      setCatalog(cats);
      setPatients(pts);
      if (dntDept?.id) setDentalDeptId(dntDept.id);
      if (cats[0]?.code) {
        setProcForm((p) => ({ ...p, procedureCode: p.procedureCode || cats[0].code }));
      }
      setSelectedPatientId((prev) => prev || procs[0]?.patient_id || pts[0]?.id || '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات عيادة الأسنان');
    } finally {
      setLoading(false);
    }
  }, [auth.activeFacilityId, canReadPatient]);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  const loadPatientChart = useCallback(
    async (patientId: string) => {
      if (!patientId) {
        setChartData(null);
        setEncounters([]);
        return;
      }
      try {
        const res = await api<any>(`/api/dental/patients/${patientId}`);
        setChartData({
          patient: res.patient,
          allergies: res.allergies ?? [],
          toothMap: res.toothMap ?? {},
          entries: res.entries ?? [],
          procedures: res.procedures ?? [],
        });
        const encList = res.openEncounters ?? [];
        setEncounters(encList);
        setSelectedEncounterId(encList[0]?.id ?? '');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'تعذّر تحميل مخطط أسنان المريض');
      }
    },
    [toast],
  );

  useEffect(() => {
    if (selectedPatientId) {
      void loadPatientChart(selectedPatientId);
    }
  }, [selectedPatientId, loadPatientChart]);

  const polling = usePolling(loadBase, { intervalMs: 30_000, enabled: true });

  const filteredWorklist = useMemo(() => {
    if (statusFilter === 'all') return worklist;
    return worklist.filter((p) => p.status === statusFilter);
  }, [worklist, statusFilter]);

  const toothHistory = useMemo(() => {
    if (!chartData) return { entries: [], procedures: [] };
    return {
      entries: chartData.entries.filter((e) => Number(e.tooth_number) === selectedTooth),
      procedures: chartData.procedures.filter((p) => Number(p.tooth_number) === selectedTooth),
    };
  }, [chartData, selectedTooth]);

  async function openNewDentalVisit() {
    if (!selectedPatientId || !dentalDeptId) return;
    setBusy(true);
    try {
      const res = await api<{ id: string; encounterNo: string }>('/api/encounters', {
        method: 'POST',
        body: JSON.stringify({
          patientId: selectedPatientId,
          encounterType: 'outpatient',
          departmentId: dentalDeptId,
          chiefComplaint: 'مراجعة وفحص عيادة الأسنان',
        }),
      });
      toast.success(`تم فتح زيارة عيادة الأسنان (${res.encounterNo})`);
      await loadPatientChart(selectedPatientId);
      setSelectedEncounterId(res.id);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر فتح زيارة جديدة');
    } finally {
      setBusy(false);
    }
  }

  async function submitChartEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPatientId) return;
    setBusy(true);
    try {
      await api('/api/dental/odontogram', {
        method: 'POST',
        body: JSON.stringify({
          patientId: selectedPatientId,
          encounterId: selectedEncounterId || undefined,
          toothNumber: selectedTooth,
          surface: chartForm.surface,
          condition: chartForm.condition,
          notes: chartForm.notes.trim() || undefined,
        }),
      });
      toast.success(`تم توثيق حالة السن #${selectedTooth} في مخطط الأسنان الدائم`);
      setChartModalOpen(false);
      setChartForm((p) => ({ ...p, notes: '' }));
      await Promise.all([loadBase(), loadPatientChart(selectedPatientId)]);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر حفظ قراءة السن');
    } finally {
      setBusy(false);
    }
  }

  async function submitProcedure(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedEncounterId) {
      toast.error('يرجى فتح زيارة سريرية نشطة للمريض أولًا');
      return;
    }
    const chosenCat = catalog.find((c) => c.code === procForm.procedureCode) ?? catalog[0];
    if (!chosenCat) return;
    setBusy(true);
    try {
      const created = await api<{ id: string; procedureNo: string }>('/api/dental/procedures', {
        method: 'POST',
        body: JSON.stringify({
          encounterId: selectedEncounterId,
          toothNumber: procForm.toothNumber ? Number(procForm.toothNumber) : undefined,
          procedureCode: chosenCat.code,
          category: chosenCat.category,
          description: chosenCat.ar,
          anesthesiaUsed: procForm.anesthesiaUsed.trim() || undefined,
          fee: procForm.fee ? Number(procForm.fee) : Number(chosenCat.fee),
          clinicalNotes: procForm.clinicalNotes.trim() || undefined,
        }),
      });
      if (procForm.completeImmediately) {
        await api(`/api/dental/procedures/${created.id}/complete`, {
          method: 'POST',
          body: JSON.stringify({
            anesthesiaUsed: procForm.anesthesiaUsed.trim() || undefined,
            clinicalNotes: procForm.clinicalNotes.trim() || undefined,
          }),
        });
        toast.success(`تم إتمام الإجراء السني ${created.procedureNo} وإدراج الرسوم في فاتورة المريض`);
      } else {
        toast.success(`تمت جدولة الإجراء السني ${created.procedureNo}`);
      }
      setProcModalOpen(false);
      setProcForm((p) => ({
        ...p,
        anesthesiaUsed: '',
        clinicalNotes: '',
        fee: '',
        completeImmediately: false,
      }));
      await Promise.all([loadBase(), loadPatientChart(selectedPatientId)]);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر تسجيل الإجراء السني');
    } finally {
      setBusy(false);
    }
  }

  async function submitCompleteProcedure(e: React.FormEvent) {
    e.preventDefault();
    if (!completeTarget) return;
    setBusy(true);
    try {
      await api(`/api/dental/procedures/${completeTarget.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          anesthesiaUsed: completeForm.anesthesiaUsed.trim() || undefined,
          clinicalNotes: completeForm.clinicalNotes.trim() || undefined,
        }),
      });
      toast.success('أُتم الإجراء السني وأُضيفت الرسوم إلى فاتورة المريض تلقائيًا');
      setCompleteTarget(null);
      setCompleteForm({ anesthesiaUsed: '', clinicalNotes: '' });
      await Promise.all([loadBase(), selectedPatientId ? loadPatientChart(selectedPatientId) : Promise.resolve()]);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إتمام الإجراء السني');
    } finally {
      setBusy(false);
    }
  }

  async function submitPanoramicOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedEncounterId) {
      toast.error('يلزم وجود زيارة نشطة لطلب أشعة بانوراما الأسنان');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ orderNo: string }>('/api/radiology/orders', {
        method: 'POST',
        body: JSON.stringify({
          encounterId: selectedEncounterId,
          modality: 'panoramic',
          bodyPart: `الفكين والأسنان (تركيز السن #${selectedTooth})`,
          priority: 'routine',
          clinicalIndication: panoramicIndication.trim(),
        }),
      });
      toast.success(`تم إرسال طلب أشعة بانوراما الأسنان (${res.orderNo}) إلى قسم الأشعة`);
      setPanoramicOpen(false);
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إرسال طلب الأشعة البانورامية');
    } finally {
      setBusy(false);
    }
  }

  const renderToothButton = (num: number) => {
    const entry = chartData?.toothMap?.[String(num)];
    const condKey = entry?.condition ?? 'healthy';
    const meta = CONDITION_META[condKey] ?? CONDITION_META.healthy;
    const isSelected = selectedTooth === num;
    return (
      <button
        key={num}
        type="button"
        onClick={() => setSelectedTooth(num)}
        aria-label={`السن ${num} — ${meta.ar}`}
        aria-pressed={isSelected}
        className={`flex flex-col items-center justify-center rounded-xl border-2 px-1.5 py-2 min-w-[42px] sm:min-w-[48px] transition cursor-pointer ${
          meta.tileCls
        } ${isSelected ? 'ring-2 ring-brand-600 ring-offset-1 scale-105 shadow-sm' : 'hover:border-brand-400'}`}
      >
        <span className="text-[11px] font-mono font-bold leading-none">{num}</span>
        <span aria-hidden="true" className="text-sm font-bold my-0.5 leading-none">
          {meta.symbol}
        </span>
        <span className="text-[9px] leading-tight truncate max-w-[44px]">
          {condKey === 'healthy' ? 'سليم' : meta.ar.split(' ')[0]}
        </span>
      </button>
    );
  };

  if (err && worklist.length === 0 && patients.length === 0) return <ErrorState message={err} onRetry={loadBase} />;
  if (loading && worklist.length === 0 && patients.length === 0) return <PageSkeleton cards={4} rows={6} />;

  const upperRight = dentition === 'permanent' ? PERMANENT_UPPER_RIGHT : DECIDUOUS_UPPER_RIGHT;
  const upperLeft = dentition === 'permanent' ? PERMANENT_UPPER_LEFT : DECIDUOUS_UPPER_LEFT;
  const lowerRight = dentition === 'permanent' ? PERMANENT_LOWER_RIGHT : DECIDUOUS_LOWER_RIGHT;
  const lowerLeft = dentition === 'permanent' ? PERMANENT_LOWER_LEFT : DECIDUOUS_LOWER_LEFT;

  const currentToothState = chartData?.toothMap?.[String(selectedTooth)];
  const currentCondMeta = CONDITION_META[currentToothState?.condition ?? 'healthy'] ?? CONDITION_META.healthy;

  return (
    <div className="space-y-4">
      <PageHeader
        title="عيادة طب وجراحة الأسنان (Dental Clinic & FDI Odontogram)"
        subtitle="مخطط الأسنان التفاعلي العالمي (FDI 11–48 & 51–85)، توثيق الأسطح السنية غير القابل للحذف، خطط العلاج والفوترة التلقائية، وطلبات بانوراما الفكين."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canPerform && selectedPatientId && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setProcForm((p) => ({ ...p, toothNumber: String(selectedTooth) }));
                  setProcModalOpen(true);
                }}
              >
                + إجراء سني جديد
              </Button>
            )}
            {canChart && selectedPatientId && (
              <Button variant="ghost" size="sm" onClick={() => setChartModalOpen(true)}>
                + توثيق حالة السن #{selectedTooth}
              </Button>
            )}
            {canOrderRad && selectedEncounterId && (
              <Button variant="ghost" size="sm" onClick={() => setPanoramicOpen(true)}>
                طلب أشعة بانوراما (OPG)
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="إجراءات مخططة" value={formatNumber(totals.planned)} tone="warning" />
          <StatCard label="جلسات جارية" value={formatNumber(totals.inProgress)} tone="info" />
          <StatCard label="مكتملة اليوم" value={formatNumber(totals.completedToday)} tone="success" />
          <StatCard label="مرضى بمخطط أسنان FDI" value={formatNumber(totals.chartedPatients)} tone="brand" />
        </div>
      )}

      <Tabs<TabKey>
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'odontogram', label: 'مخطط الأسنان التفاعلي (FDI Odontogram)' },
          { key: 'worklist', label: 'سجل الإجراءات والجلسات السنية', count: worklist.length },
        ]}
      />

      {tab === 'odontogram' && (
        <div className="space-y-4">
          <Card title="اختيار المريض والزيارة السريرية">
            <div className="grid md:grid-cols-3 gap-3 items-end">
              <Select
                label="المريض"
                value={selectedPatientId}
                onChange={(e) => setSelectedPatientId(e.target.value)}
              >
                <option value="">— اختر مريضًا لعرض مخطط الأسنان —</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullNameAr} ({p.mrn})
                  </option>
                ))}
              </Select>

              <Select
                label="الزيارة المفتوحة المرتبطة"
                value={selectedEncounterId}
                onChange={(e) => setSelectedEncounterId(e.target.value)}
              >
                {encounters.length === 0 && <option value="">لا توجد زيارة مفتوحة حاليًا</option>}
                {encounters.map((enc) => (
                  <option key={enc.id} value={enc.id}>
                    {enc.encounter_no} · {enc.dept_name}
                  </option>
                ))}
              </Select>

              <div className="flex flex-wrap gap-2">
                {canCreateEnc && selectedPatientId && dentalDeptId && (
                  <Button variant="ghost" size="sm" busy={busy} onClick={openNewDentalVisit}>
                    + فتح زيارة عيادة أسنان
                  </Button>
                )}
                <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-100">
                  <button
                    type="button"
                    onClick={() => {
                      setDentition('permanent');
                      setSelectedTooth(36);
                    }}
                    className={`px-2.5 py-1 text-xs rounded-md font-semibold cursor-pointer ${
                      dentition === 'permanent' ? 'bg-white text-brand-800 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    دائمة (11–48)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDentition('deciduous');
                      setSelectedTooth(55);
                    }}
                    className={`px-2.5 py-1 text-xs rounded-md font-semibold cursor-pointer ${
                      dentition === 'deciduous' ? 'bg-white text-brand-800 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    لبنية (51–85)
                  </button>
                </div>
              </div>
            </div>
            {chartData?.allergies && chartData.allergies.length > 0 && (
              <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-900 font-semibold">
                تنبيه حساسية دوائية مسجلة للمريض:{' '}
                {chartData.allergies.map((a: any) => `${a.allergen} (${a.severity})`).join(' · ')}
              </div>
            )}
          </Card>

          {!selectedPatientId ? (
            <EmptyState title="اختر مريضًا من القائمة أعلاه لعرض مخطط الأسنان التفاعلي" />
          ) : (
            <div className="grid xl:grid-cols-12 gap-4">
              <div className="xl:col-span-8">
                <Card
                  title={
                    dentition === 'permanent'
                      ? 'مخطط الأسنان الدائمة (ترقيم الاتحاد العالمي لطب الأسنان FDI 11–48)'
                      : 'مخطط الأسنان اللبنية للأطفال (FDI 51–85)'
                  }
                  subtitle="اضغط على أي سن لعرض تاريخه العلاجي أو تسجيل حالة سطح سني أو إجراء علاجي."
                >
                  <div className="space-y-4 overflow-x-auto pb-2" dir="ltr">
                    <div>
                      <p className="text-[11px] text-center font-semibold text-slate-500 mb-1.5" dir="rtl">
                        الفك العلوي (اليمين {upperRight[0]}–{upperRight[upperRight.length - 1]} | اليسار {upperLeft[0]}–{upperLeft[upperLeft.length - 1]})
                      </p>
                      <div className="flex items-center justify-center gap-1.5 min-w-max">
                        <div className="flex gap-1">{upperRight.map(renderToothButton)}</div>
                        <div className="w-0.5 h-12 bg-brand-300 mx-1 rounded" aria-hidden="true" />
                        <div className="flex gap-1">{upperLeft.map(renderToothButton)}</div>
                      </div>
                    </div>

                    <div className="border-t border-dashed border-slate-200" />

                    <div>
                      <div className="flex items-center justify-center gap-1.5 min-w-max">
                        <div className="flex gap-1">{lowerRight.map(renderToothButton)}</div>
                        <div className="w-0.5 h-12 bg-brand-300 mx-1 rounded" aria-hidden="true" />
                        <div className="flex gap-1">{lowerLeft.map(renderToothButton)}</div>
                      </div>
                      <p className="text-[11px] text-center font-semibold text-slate-500 mt-1.5" dir="rtl">
                        الفك السفلي (اليمين {lowerRight[0]}–{lowerRight[lowerRight.length - 1]} | اليسار {lowerLeft[0]}–{lowerLeft[lowerLeft.length - 1]})
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap gap-2">
                    {Object.entries(CONDITION_META).map(([k, v]) => (
                      <span
                        key={k}
                        className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border ${v.tileCls}`}
                      >
                        <span aria-hidden="true" className="font-bold">
                          {v.symbol}
                        </span>
                        <span>{v.ar}</span>
                      </span>
                    ))}
                  </div>
                </Card>
              </div>

              <div className="xl:col-span-4">
                <Card
                  title={`تفاصيل السن المختار #${selectedTooth}`}
                  subtitle={`الحالة الحالية: ${currentCondMeta.symbol} ${currentCondMeta.ar}`}
                  action={
                    canChart ? (
                      <Button variant="primary" size="sm" onClick={() => setChartModalOpen(true)}>
                        تحديث السن
                      </Button>
                    ) : undefined
                  }
                >
                  <div className="space-y-3 text-sm">
                    {currentToothState ? (
                      <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
                        <p>
                          <strong>آخر تشخيص موثّق:</strong> {currentCondMeta.ar}{' '}
                          {currentToothState.surface ? `(السطح: ${currentToothState.surface})` : ''}
                        </p>
                        {currentToothState.notes && <p className="text-slate-600">{currentToothState.notes}</p>}
                        <p className="text-slate-400">
                          بواسطة {currentToothState.recorded_by_name} · {formatDateTime(currentToothState.recorded_at)}
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">لم تُسجّل ملاحظات مرضية على السن #{selectedTooth} (يُعامل كسن سليم).</p>
                    )}

                    <div>
                      <h4 className="font-bold text-xs text-slate-700 mb-1.5">الإجراءات السنية على السن #{selectedTooth}</h4>
                      {toothHistory.procedures.length === 0 ? (
                        <p className="text-xs text-slate-400">لا توجد إجراءات علاجية مسجلة لهذا السن.</p>
                      ) : (
                        <ul className="space-y-1.5 text-xs">
                          {toothHistory.procedures.map((p: any) => (
                            <li key={p.id} className="rounded-lg border border-slate-200 p-2 flex items-center justify-between gap-2">
                              <div>
                                <span className="font-semibold block">{p.description}</span>
                                <span className="text-slate-500 font-mono">{p.procedure_no} · {formatMoney(p.fee)}</span>
                              </div>
                              <Badge value={p.status} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <h4 className="font-bold text-xs text-slate-700 mb-1.5">السجل التاريخي التراكمي للسن ({toothHistory.entries.length})</h4>
                      {toothHistory.entries.length === 0 ? (
                        <p className="text-xs text-slate-400">لا توجد قراءات سابقة.</p>
                      ) : (
                        <ul className="space-y-1 text-xs max-h-44 overflow-y-auto">
                          {toothHistory.entries.map((e: any) => (
                            <li key={e.id} className="border-b border-slate-100 pb-1">
                              <span className="font-semibold">
                                {CONDITION_META[e.condition]?.ar ?? e.condition_ar ?? e.condition}
                              </span>
                              {e.surface && <span className="font-mono text-slate-500"> [{e.surface}]</span>}
                              {e.notes && <span className="block text-slate-600">{e.notes}</span>}
                              <span className="text-[11px] text-slate-400">{formatDateTime(e.recorded_at)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'worklist' && (
        <Card
          title="قائمة عمل الإجراءات السنية والفوترة السريرية"
          action={
            <Select
              aria-label="تصفية حالة الإجراءات السنية"
              className="!w-44 text-xs"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">كل الحالات</option>
              <option value="planned">مخططة</option>
              <option value="in_progress">قيد الجلسة</option>
              <option value="completed">مكتملة ومفوترة</option>
              <option value="cancelled">ملغاة</option>
            </Select>
          }
        >
          <DataTable
            caption="قائمة الإجراءات السنية"
            rows={filteredWorklist}
            rowKey={(p) => p.id}
            emptyTitle="لا توجد إجراءات سنية مسجلة في هذه الحالة"
            cardTitle={(p) => `${p.description} ${p.tooth_number ? `(السن #${p.tooth_number})` : ''}`}
            cardSubtitle={(p) => `${p.procedure_no} · ${p.patient_name} (${p.mrn})`}
            cardBadge={(p) => <Badge value={p.status} />}
            columns={[
              { key: 'no', header: 'رقم الإجراء', render: (p) => <span className="font-mono text-xs font-bold">{p.procedure_no}</span> },
              {
                key: 'pt',
                header: 'المريض',
                render: (p) => (
                  <div>
                    <span className="font-semibold">{p.patient_name}</span>
                    <span className="block text-xs text-slate-400 font-mono">{p.mrn} · {p.encounter_no}</span>
                  </div>
                ),
              },
              {
                key: 'proc',
                header: 'الإجراء والسن',
                render: (p) => (
                  <div>
                    <span className="font-semibold">{p.description}</span>
                    <span className="block text-xs text-slate-500">
                      {p.category_ar} · {p.tooth_number ? `السن #${p.tooth_number}` : 'إجراء عام للفكين'}
                    </span>
                  </div>
                ),
              },
              { key: 'doc', header: 'طبيب الأسنان', render: (p) => <span className="text-xs">{p.dentist_name}</span> },
              { key: 'fee', header: 'الرسوم', render: (p) => <span className="font-mono text-xs">{formatMoney(p.fee)}</span> },
              { key: 'st', header: 'الحالة', render: (p) => <Badge value={p.status} /> },
              {
                key: 'act',
                header: 'إجراء',
                isActions: true,
                render: (p) => {
                  if (!canPerform || ['completed', 'cancelled'].includes(p.status)) {
                    return <span className="text-xs text-slate-400">—</span>;
                  }
                  return (
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          setCompleteTarget(p);
                          setCompleteForm({
                            anesthesiaUsed: p.anesthesia_used ?? '',
                            clinicalNotes: p.clinical_notes ?? '',
                          });
                        }}
                      >
                        إتمام وفوترة
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => setCancelTarget(p)}>
                        إلغاء
                      </Button>
                    </div>
                  );
                },
              },
            ]}
          />
        </Card>
      )}

      {/* Modal: Record Tooth Chart Entry */}
      <Modal
        open={chartModalOpen}
        onClose={() => setChartModalOpen(false)}
        title={`توثيق حالة السن #${selectedTooth} (سجل تراكمي غير قابل للحذف)`}
      >
        <form onSubmit={submitChartEntry} className="space-y-3">
          <Select
            label="الحالة التشخيصية للسن"
            value={chartForm.condition}
            onChange={(e) => setChartForm({ ...chartForm, condition: e.target.value })}
          >
            {Object.entries(CONDITION_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.symbol} {v.ar}
              </option>
            ))}
          </Select>
          <Select
            label="السطح السني المصاب / المعالج"
            value={chartForm.surface}
            onChange={(e) => setChartForm({ ...chartForm, surface: e.target.value })}
          >
            {SURFACE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Textarea
            label="ملاحظات سريرية (عمق الجيب اللثوي، حساسية البرودة، إلخ)"
            rows={2}
            value={chartForm.notes}
            onChange={(e) => setChartForm({ ...chartForm, notes: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setChartModalOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              حفظ في مخطط الأسنان
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: New Dental Procedure */}
      <Modal open={procModalOpen} onClose={() => setProcModalOpen(false)} title="تسجيل إجراء علاجي أو جراحي للأسنان">
        <form onSubmit={submitProcedure} className="space-y-3">
          <Select
            label="الإجراء السني المعتمد"
            value={procForm.procedureCode}
            onChange={(e) => setProcForm({ ...procForm, procedureCode: e.target.value })}
          >
            {catalog.map((c) => (
              <option key={c.code} value={c.code}>
                {c.ar} ({c.code}) — {formatMoney(c.fee)}
              </option>
            ))}
          </Select>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="رقم السن (FDI)"
              type="number"
              placeholder="مثال: 36 (أو اتركه فارغًا للتنظيف العام)"
              value={procForm.toothNumber}
              onChange={(e) => setProcForm({ ...procForm, toothNumber: e.target.value })}
            />
            <Input
              label="رسوم مخصصة (اختياري)"
              type="number"
              min="0"
              step="0.01"
              placeholder="تلقائي من اللائحة"
              value={procForm.fee}
              onChange={(e) => setProcForm({ ...procForm, fee: e.target.value })}
            />
          </div>
          <Input
            label="التخدير الموضعي المستخدم (اختياري)"
            placeholder="مثال: Lidocaine 2% + Epinephrine 1:100,000 (1.8 ml)"
            value={procForm.anesthesiaUsed}
            onChange={(e) => setProcForm({ ...procForm, anesthesiaUsed: e.target.value })}
          />
          <Textarea
            label="تفاصيل الإجراء السريري"
            rows={2}
            value={procForm.clinicalNotes}
            onChange={(e) => setProcForm({ ...procForm, clinicalNotes: e.target.value })}
          />
          <label className="flex items-center gap-2 text-xs font-medium text-slate-800">
            <input
              type="checkbox"
              checked={procForm.completeImmediately}
              onChange={(e) => setProcForm({ ...procForm, completeImmediately: e.target.checked })}
            />
            إتمام الجلسة الآن وتحديث مخطط السن وإصدار بند الفاتورة تلقائيًا
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setProcModalOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              حفظ الإجراء السني
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Complete Planned Procedure */}
      <Modal
        open={!!completeTarget}
        onClose={() => setCompleteTarget(null)}
        title={`إتمام الإجراء السني (${completeTarget?.procedure_no ?? ''})`}
      >
        <form onSubmit={submitCompleteProcedure} className="space-y-3">
          <Input
            label="ملاحظات التخدير الموضعي"
            value={completeForm.anesthesiaUsed}
            onChange={(e) => setCompleteForm({ ...completeForm, anesthesiaUsed: e.target.value })}
          />
          <Textarea
            label="الملاحظات الختامية وتعليمات ما بعد الإجراء"
            rows={3}
            required
            value={completeForm.clinicalNotes}
            onChange={(e) => setCompleteForm({ ...completeForm, clinicalNotes: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCompleteTarget(null)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              اعتماد الإتمام وإدراج الرسوم
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Quick Panoramic OPG Order */}
      <Modal
        open={panoramicOpen}
        onClose={() => setPanoramicOpen(false)}
        title="إرسال طلب أشعة بانوراما الأسنان (Panoramic OPG)"
      >
        <form onSubmit={submitPanoramicOrder} className="space-y-3">
          <Textarea
            label="المبرر السريري لطلب البانوراما (5 أحرف على الأقل)"
            rows={3}
            required
            minLength={5}
            value={panoramicIndication}
            onChange={(e) => setPanoramicIndication(e.target.value)}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setPanoramicOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={panoramicIndication.trim().length < 5}>
              إرسال لقسم الأشعة
            </Button>
          </div>
        </form>
      </Modal>

      <ReasonDialog
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        title={`إلغاء الإجراء السني (${cancelTarget?.procedure_no ?? ''})`}
        consequenceNote="سيُلغى الإجراء المخطط ويُحفظ سبب الإلغاء في ملف المريض وسجل التدقيق."
        minLength={5}
        confirmLabel="تأكيد الإلغاء"
        variant="danger"
        onConfirm={async (reason) => {
          if (!cancelTarget) return;
          await api(`/api/dental/procedures/${cancelTarget.id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
          toast.success('أُلغي الإجراء السني بسبب موثّق');
          await Promise.all([loadBase(), selectedPatientId ? loadPatientChart(selectedPatientId) : Promise.resolve()]);
        }}
      />
    </div>
  );
}

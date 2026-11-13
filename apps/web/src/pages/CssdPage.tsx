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
  PollingControl,
  ReasonDialog,
  Select,
  StatCard,
  Tabs,
  useToast,
} from '../components';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime, formatIsoDate } from '../lib/format';

export default function CssdPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const can = useCallback((p: string) => has(auth, p), [auth]);

  const [tab, setTab] = useState<'cssd' | 'ipc'>(() => (has(auth, 'cssd.read') ? 'cssd' : 'ipc'));
  const [board, setBoard] = useState<any>(null);
  const [ipc, setIpc] = useState<any>(null);
  const [patients, setPatients] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [setForm, setSetForm] = useState({
    code: '',
    nameAr: '',
    category: 'laparotomy',
    instrumentCount: '20',
    department: 'OR',
  });
  const [recv, setRecv] = useState({ setId: '', packaging: 'wrap' });
  const [loadForm, setLoadForm] = useState({ autoclaveCode: 'STM-01', method: 'steam', packIds: [] as string[] });
  const [issue, setIssue] = useState({ packId: '', issuedTo: 'غرفة العمليات 1', caseId: '' });
  const [iso, setIso] = useState({ patientId: '', precaution: 'contact', organism: '', reason: '' });
  const [hai, setHai] = useState({
    patientId: '',
    caseType: 'cauti',
    organism: '',
    deviceDays: '',
    notes: '',
    onsetDate: new Date().toISOString().slice(0, 10),
  });
  const [hyg, setHyg] = useState({
    unit: 'العناية المركزة',
    moment: 'before_patient',
    opportunities: '20',
    compliant: '18',
    observedRole: 'nurse',
    notes: '',
  });

  // Replaces ALL FOUR window.prompt calls (#5, #6, #7, #8)!
  const [recallTarget, setRecallTarget] = useState<{ id: string; loadNo: string } | null>(null);
  const [endIsoTarget, setEndIsoTarget] = useState<{ id: string; patientName: string } | null>(null);
  const [reviewCaseTarget, setReviewCaseTarget] = useState<{
    id: string;
    patientName: string;
    decision: 'confirmed' | 'excluded';
  } | null>(null);

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      const tasks: Promise<unknown>[] = [];
      if (can('cssd.read')) {
        tasks.push(api<any>('/api/cssd/board').then(setBoard));
      }
      if (can('infection.read')) {
        tasks.push(api<any>('/api/infection/board').then(setIpc));
      }
      await Promise.all(tasks);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات التعقيم ومكافحة العدوى');
    } finally {
      setLoading(false);
    }
  }, [can]);

  useEffect(() => {
    loadAll();
    if (can('patient.read')) {
      api<any>('/api/patients?limit=50')
        .then((r) => setPatients(r.items ?? []))
        .catch(() => setPatients([]));
    }
    if (can('surgery.read')) {
      api<any>('/api/surgery/board?status=active')
        .then((r) => setCases(r.items ?? []))
        .catch(() => setCases([]));
    }
  }, [can, loadAll]);

  const polling = usePolling(loadAll, { intervalMs: 25_000, enabled: true });

  async function act(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'فشلت العملية');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  if (err && !board && !ipc) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && !board && !ipc) return <PageSkeleton cards={6} rows={6} />;

  const packs: any[] = board?.packs ?? [];
  const loads: any[] = board?.loads ?? [];
  const sets: any[] = board?.sets ?? [];
  const releasedPacks = packs.filter((p) => p.status === 'released' && !p.expired);
  const packedPacks = packs.filter((p) => p.status === 'packed');

  const tabItems: Array<{ key: 'cssd' | 'ipc'; label: string }> = [
    ...(can('cssd.read') ? [{ key: 'cssd' as const, label: 'التعقيم المركزي (CSSD)' }] : []),
    ...(can('infection.read') ? [{ key: 'ipc' as const, label: 'مكافحة العدوى (IPC)' }] : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="التعقيم المركزي (CSSD) ومكافحة العدوى (IPC)"
        subtitle="تتبع دورة حياة الأدوات الجراحية، فصل مهام الاعتماد، أوامر العزل، وترصد العدوى المرتبطة بالرعاية."
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

      {tabItems.length > 1 && <Tabs active={tab} onChange={setTab} items={tabItems} />}

      {tab === 'cssd' && board && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="قيد المعالجة" value={board.totals.in_process} />
            <StatCard label="قيد التعقيم" value={board.totals.sterilizing} tone="info" />
            <StatCard label="معقّمة جاهزة" value={board.totals.released} tone="success" />
            <StatCard label="مصروفة" value={board.totals.issued} />
            <StatCard
              label="محجوزة احترازيًا"
              value={board.totals.quarantined}
              tone={board.totals.quarantined > 0 ? 'danger' : 'default'}
            />
            <StatCard
              label="منتهية الصلاحية"
              value={board.totals.expired}
              tone={board.totals.expired > 0 ? 'warning' : 'default'}
            />
          </div>

          <Card
            title="حزم الأدوات الجراحية ودورة التعقيم"
            subtitle="سياسة الصلاحية: تغليف ورقي ٣٠ يومًا وحاوية ٩٠ يومًا؛ لا يُسمح بصرف حزمة قبل اعتماد الدورة من مستخدم آخر."
          >
            <DataTable
              caption="حزم الأدوات في قسم التعقيم"
              rows={packs}
              rowKey={(p) => p.id}
              rowClassName={(p) =>
                p.status === 'quarantined' || p.status === 'recalled'
                  ? 'bg-rose-50/60'
                  : p.expired
                    ? 'bg-amber-50/60'
                    : ''
              }
              emptyTitle="لا توجد حزم مسجلة"
              cardTitle={(p) => `${p.pack_no} — ${p.set_name}`}
              cardSubtitle={(p) => `دورة #${p.cycle_count} · ${p.instrument_count} أداة · ${p.load_no ?? 'بلا دورة'}`}
              cardBadge={(p) => <Badge value={p.status} />}
              cardActions={(p) => (
                <div className="flex flex-wrap gap-1">
                  {can('cssd.reprocess') && p.status === 'dirty' && (
                    <Button variant="ghost" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/wash`, { method: 'POST' }), 'سُجّل الغسل').catch(() => {})}>
                      غسل
                    </Button>
                  )}
                  {can('cssd.reprocess') && p.status === 'washing' && (
                    <Button variant="ghost" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/pack`, { method: 'POST' }), 'غُلّفت الحزمة').catch(() => {})}>
                      تغليف
                    </Button>
                  )}
                  {can('cssd.issue') && p.status === 'released' && !p.expired && (
                    <Button variant="primary" size="sm" onClick={() => setIssue({ ...issue, packId: p.id })}>
                      تجهيز للصرف
                    </Button>
                  )}
                  {can('cssd.issue') && p.status === 'issued' && (
                    <Button variant="primary" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/use`, { method: 'POST' }), 'سُجّل استخدام الحزمة').catch(() => {})}>
                      تسجيل استخدام
                    </Button>
                  )}
                  {can('cssd.reprocess') && ['issued', 'used'].includes(p.status) && (
                    <Button variant="ghost" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/return`, { method: 'POST' }), 'أُعيدت الحزمة للتعقيم').catch(() => {})}>
                      استرجاع
                    </Button>
                  )}
                </div>
              )}
              columns={[
                {
                  key: 'no',
                  header: 'الحزمة',
                  render: (p) => (
                    <div className="text-xs">
                      <span className="font-mono font-bold">{p.pack_no}</span>
                      <span className="block text-slate-400">دورة #{p.cycle_count}</span>
                    </div>
                  ),
                },
                {
                  key: 'set',
                  header: 'الطقم',
                  render: (p) => (
                    <div className="text-xs">
                      <span className="font-semibold">{p.set_name}</span>
                      <span className="block text-slate-400">
                        {p.set_code} · {p.instrument_count} أداة · {p.packaging === 'container' ? 'حاوية' : 'ورقي'}
                      </span>
                    </div>
                  ),
                },
                { key: 'st', header: 'الحالة', render: (p) => <Badge value={p.status} /> },
                {
                  key: 'load',
                  header: 'دورة الأوتوكلاف',
                  render: (p) =>
                    p.load_no ? (
                      <div className="text-xs">
                        <span className="font-mono">{p.load_no}</span>
                        <span className="block text-slate-400">{p.autoclave_code}</span>
                      </div>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'exp',
                  header: 'الصلاحية',
                  render: (p) =>
                    p.expires_at ? (
                      <div className="text-xs">
                        {formatIsoDate(p.expires_at)}
                        {p.expired ? (
                          <span className="block text-rose-700 font-bold">منتهية</span>
                        ) : (
                          <span className="block text-slate-400">متبقٍ {p.days_left} يوم</span>
                        )}
                      </div>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'dest',
                  header: 'الجهة / العملية',
                  render: (p) => (
                    <div className="text-xs">
                      {p.issued_to ?? '—'}
                      {p.case_no && <span className="block font-mono text-slate-400">{p.case_no}</span>}
                      {p.recall_reason && <span className="block text-rose-700">{p.recall_reason}</span>}
                    </div>
                  ),
                },
                {
                  key: 'act',
                  header: 'إجراءات',
                  hideInCard: true,
                  render: (p) => (
                    <div className="flex flex-wrap gap-1">
                      {can('cssd.reprocess') && p.status === 'dirty' && (
                        <Button variant="ghost" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/wash`, { method: 'POST' }), 'سُجّل الغسل').catch(() => {})}>
                          غسل
                        </Button>
                      )}
                      {can('cssd.reprocess') && p.status === 'washing' && (
                        <Button variant="ghost" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/pack`, { method: 'POST' }), 'غُلّفت الحزمة').catch(() => {})}>
                          تغليف
                        </Button>
                      )}
                      {can('cssd.issue') && p.status === 'released' && !p.expired && (
                        <Button variant="ghost" size="sm" onClick={() => setIssue({ ...issue, packId: p.id })}>
                          تجهيز الصرف
                        </Button>
                      )}
                      {can('cssd.issue') && p.status === 'issued' && (
                        <Button variant="primary" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/use`, { method: 'POST' }), 'سُجّل الاستخدام').catch(() => {})}>
                          استخدام
                        </Button>
                      )}
                      {can('cssd.reprocess') && ['issued', 'used'].includes(p.status) && (
                        <Button variant="ghost" size="sm" onClick={() => act(() => api(`/api/cssd/packs/${p.id}/return`, { method: 'POST' }), 'أُعيدت للتعقيم').catch(() => {})}>
                          استرجاع
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>

          <Card title="دورات أجهزة التعقيم (Autoclave Loads)">
            <DataTable
              caption="دورات التعقيم"
              rows={loads}
              rowKey={(l) => l.id}
              rowClassName={(l) => (l.status === 'failed' ? 'bg-rose-50/60' : '')}
              emptyTitle="لا توجد دورات تعقيم مسجلة"
              cardTitle={(l) => `${l.load_no} (${l.autoclave_code})`}
              cardSubtitle={(l) => `مشغّل: ${l.operator_name} · ${l.pack_count} حزمة`}
              cardBadge={(l) => <Badge value={l.status} />}
              cardActions={(l) => (
                <div className="flex flex-wrap gap-1">
                  {can('cssd.sterilize') && l.status === 'running' && (
                    <>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() =>
                          act(
                            () =>
                              api(`/api/cssd/loads/${l.id}/result`, {
                                method: 'POST',
                                body: JSON.stringify({ chemicalIndicator: 'pass', biologicalIndicator: 'pass' }),
                              }),
                            'سُجّلت نتيجة ناجحة؛ بانتظار اعتماد شخص آخر',
                          ).catch(() => {})
                        }
                      >
                        نتيجة ناجحة
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() =>
                          act(
                            () =>
                              api(`/api/cssd/loads/${l.id}/result`, {
                                method: 'POST',
                                body: JSON.stringify({
                                  chemicalIndicator: 'pass',
                                  biologicalIndicator: 'fail',
                                  notes: 'فشل المؤشر البيولوجي',
                                }),
                              }),
                            'سُجّل فشل الدورة وحُجزت جميع حزمها',
                          ).catch(() => {})
                        }
                      >
                        نتيجة فاشلة
                      </Button>
                    </>
                  )}
                  {can('cssd.release') && l.status === 'passed' && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => act(() => api(`/api/cssd/loads/${l.id}/approve`, { method: 'POST' }), 'اعتُمدت الدورة وأُفرج عن حزمها').catch(() => {})}
                    >
                      اعتماد وإفراج
                    </Button>
                  )}
                  {can('cssd.release') && !l.recalled_at && l.status !== 'running' && (
                    <Button variant="danger" size="sm" onClick={() => setRecallTarget({ id: l.id, loadNo: l.load_no })}>
                      سحب الدورة
                    </Button>
                  )}
                </div>
              )}
              columns={[
                {
                  key: 'no',
                  header: 'الدورة',
                  render: (l) => (
                    <div className="text-xs">
                      <span className="font-mono font-bold">{l.load_no}</span>
                      <span className="block text-slate-400">
                        دورة {l.cycle_no} · {l.pack_count} حزمة
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'dev',
                  header: 'الجهاز',
                  render: (l) => (
                    <div className="text-xs">
                      {l.autoclave_code}
                      <span className="block text-slate-400">{l.method_ar ?? l.method}</span>
                    </div>
                  ),
                },
                {
                  key: 'ind',
                  header: 'المؤشرات',
                  render: (l) => (
                    <div className="text-xs">
                      كيميائي: {l.chemical_indicator === 'pass' ? 'سليم' : l.chemical_indicator === 'fail' ? 'فاشل' : '—'}
                      <span className="block text-slate-400">
                        بيولوجي: {l.biological_indicator === 'pass' ? 'سليم' : l.biological_indicator === 'fail' ? 'فاشل' : 'قيد الحضانة'}
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'op',
                  header: 'المشغّل / المعتمد',
                  render: (l) => (
                    <div className="text-xs">
                      {l.operator_name}
                      <span className="block text-slate-400">
                        {l.approver_name ? `اعتمدها ${l.approver_name}` : 'بانتظار اعتماد شخص آخر'}
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'st',
                  header: 'الحالة',
                  render: (l) => (
                    <div>
                      <Badge value={l.status} />
                      {l.recalled_at && <span className="block text-xs text-rose-700 font-bold mt-0.5">مسحوبة</span>}
                    </div>
                  ),
                },
                {
                  key: 'act',
                  header: 'إجراءات',
                  hideInCard: true,
                  render: (l) => (
                    <div className="flex flex-wrap gap-1">
                      {can('cssd.sterilize') && l.status === 'running' && (
                        <>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() =>
                              act(
                                () =>
                                  api(`/api/cssd/loads/${l.id}/result`, {
                                    method: 'POST',
                                    body: JSON.stringify({ chemicalIndicator: 'pass', biologicalIndicator: 'pass' }),
                                  }),
                                'سُجّلت نتيجة ناجحة؛ يلزم اعتماد شخص آخر',
                              ).catch(() => {})
                            }
                          >
                            ناجحة
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              act(
                                () =>
                                  api(`/api/cssd/loads/${l.id}/result`, {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      chemicalIndicator: 'pass',
                                      biologicalIndicator: 'fail',
                                      notes: 'فشل المؤشر البيولوجي',
                                    }),
                                  }),
                                'سُجّل فشل الدورة وحُجزت حزمها',
                              ).catch(() => {})
                            }
                          >
                            فاشلة
                          </Button>
                        </>
                      )}
                      {can('cssd.release') && l.status === 'passed' && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => act(() => api(`/api/cssd/loads/${l.id}/approve`, { method: 'POST' }), 'اعتُمدت الدورة وأُفرج عن حزمها').catch(() => {})}
                        >
                          اعتماد
                        </Button>
                      )}
                      {can('cssd.release') && !l.recalled_at && l.status !== 'running' && (
                        <Button variant="danger" size="sm" onClick={() => setRecallTarget({ id: l.id, loadNo: l.load_no })}>
                          سحب
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>

          <div className="grid lg:grid-cols-3 gap-3">
            {can('cssd.manage') && (
              <Card title="تعريف طقم أدوات جديد">
                <div className="space-y-2">
                  <Input label="رمز الطقم" value={setForm.code} onChange={(e) => setSetForm({ ...setForm, code: e.target.value })} placeholder="CSS-SET-30" />
                  <Input label="اسم الطقم" value={setForm.nameAr} onChange={(e) => setSetForm({ ...setForm, nameAr: e.target.value })} />
                  <div className="grid grid-cols-2 gap-2">
                    <Select label="الفئة" value={setForm.category} onChange={(e) => setSetForm({ ...setForm, category: e.target.value })}>
                      <option value="minor">جراحة صغرى</option>
                      <option value="laparotomy">فتح بطن</option>
                      <option value="orthopedic">عظام</option>
                      <option value="dressing">ضمادات</option>
                      <option value="endoscopy">مناظير</option>
                      <option value="other">أخرى</option>
                    </Select>
                    <Input label="عدد الأدوات" type="number" min={1} value={setForm.instrumentCount} onChange={(e) => setSetForm({ ...setForm, instrumentCount: e.target.value })} />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={setForm.code.length < 2 || setForm.nameAr.length < 3}
                    onClick={() =>
                      act(
                        () => api('/api/cssd/sets', { method: 'POST', body: JSON.stringify({ ...setForm, instrumentCount: Number(setForm.instrumentCount) }) }),
                        'أُضيف الطقم الجراحي',
                      ).catch(() => {})
                    }
                  >
                    إضافة الطقم
                  </Button>
                </div>
              </Card>
            )}

            {can('cssd.reprocess') && (
              <Card title="استلام حزمة ملوّثة">
                <div className="space-y-2">
                  <Select label="الطقم الجراحي" value={recv.setId} onChange={(e) => setRecv({ ...recv, setId: e.target.value })}>
                    <option value="">— اختر الطقم —</option>
                    {sets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name_ar} ({s.code})
                      </option>
                    ))}
                  </Select>
                  <Select label="نوع التغليف" value={recv.packaging} onChange={(e) => setRecv({ ...recv, packaging: e.target.value })}>
                    <option value="wrap">تغليف ورقي (٣٠ يومًا)</option>
                    <option value="container">حاوية صلبة (٩٠ يومًا)</option>
                  </Select>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={!recv.setId}
                    onClick={() =>
                      act(async () => {
                        await api('/api/cssd/packs', { method: 'POST', body: JSON.stringify(recv) });
                        setRecv({ ...recv, setId: '' });
                      }, 'سُجّل استلام الحزمة الملوّثة').catch(() => {})
                    }
                  >
                    تسجيل الاستلام
                  </Button>
                </div>
              </Card>
            )}

            {can('cssd.sterilize') && (
              <Card title="فتح دورة تعقيم جديدة">
                <div className="space-y-2">
                  <Select label="جهاز الأوتوكلاف" value={loadForm.autoclaveCode} onChange={(e) => setLoadForm({ ...loadForm, autoclaveCode: e.target.value })}>
                    <option value="STM-01">STM-01 — بخار</option>
                    <option value="STM-02">STM-02 — بخار</option>
                    <option value="STM-03">STM-03 — بخار</option>
                  </Select>
                  <div className="max-h-28 overflow-y-auto border border-slate-200 rounded-lg p-2 text-xs space-y-1">
                    {packedPacks.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={loadForm.packIds.includes(p.id)}
                          onChange={(e) =>
                            setLoadForm({
                              ...loadForm,
                              packIds: e.target.checked
                                ? [...loadForm.packIds, p.id]
                                : loadForm.packIds.filter((x) => x !== p.id),
                            })
                          }
                        />
                        {p.pack_no} · {p.set_name}
                      </label>
                    ))}
                    {packedPacks.length === 0 && <p className="text-slate-400">لا توجد حزم مغلّفة جاهزة.</p>}
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={loadForm.packIds.length === 0}
                    onClick={() =>
                      act(async () => {
                        await api('/api/cssd/loads', { method: 'POST', body: JSON.stringify(loadForm) });
                        setLoadForm({ ...loadForm, packIds: [] });
                      }, 'فُتحت دورة التعقيم').catch(() => {})
                    }
                  >
                    بدء الدورة ({loadForm.packIds.length})
                  </Button>
                </div>
              </Card>
            )}
          </div>

          {can('cssd.issue') && (
            <Card title="صرف حزمة معقّمة للعمليات أو الأقسام">
              <div className="grid sm:grid-cols-4 gap-3 items-end">
                <Select label="الحزمة المعقّمة" value={issue.packId} onChange={(e) => setIssue({ ...issue, packId: e.target.value })}>
                  <option value="">— اختر حزمة مفرجًا عنها —</option>
                  {releasedPacks.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.pack_no} · {p.set_name} ({p.days_left} يوم)
                    </option>
                  ))}
                </Select>
                <Input label="الجهة المستلمة" value={issue.issuedTo} onChange={(e) => setIssue({ ...issue, issuedTo: e.target.value })} />
                <Select label="ربط بعملية جراحية (اختياري)" value={issue.caseId} onChange={(e) => setIssue({ ...issue, caseId: e.target.value })}>
                  <option value="">بدون ربط</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.case_no} · {c.procedure_name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={!issue.packId || issue.issuedTo.trim().length < 2}
                  onClick={() =>
                    act(async () => {
                      await api(`/api/cssd/packs/${issue.packId}/issue`, {
                        method: 'POST',
                        body: JSON.stringify({ issuedTo: issue.issuedTo, caseId: issue.caseId || undefined }),
                      });
                      setIssue({ ...issue, packId: '', caseId: '' });
                    }, 'صُرفت الحزمة وسُجّل تتبعها').catch(() => {})
                  }
                >
                  تأكيد الصرف
                </Button>
              </div>
            </Card>
          )}
        </>
      )}

      {tab === 'ipc' && ipc && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="أوامر عزل نشطة" value={ipc.totals.active_isolations} tone="warning" />
            <StatCard label="حالات عدوى مشتبهة" value={ipc.totals.suspected_cases} tone="danger" />
            <StatCard label="مؤكدة آخر ٣٠ يومًا" value={ipc.totals.confirmed_30d} />
            <StatCard
              label="التزام نظافة الأيدي (٣٠ يومًا)"
              value={`${ipc.totals.hygiene_compliance_30d}%`}
              tone={Number(ipc.totals.hygiene_compliance_30d) >= 80 ? 'success' : 'warning'}
            />
          </div>

          <Card title="أوامر العزل النشطة">
            <DataTable
              caption="أوامر العزل النشطة"
              rows={ipc.isolations ?? []}
              rowKey={(i) => i.id}
              emptyTitle="لا توجد أوامر عزل نشطة حاليًا"
              cardTitle={(i) => i.patient_name}
              cardSubtitle={(i) => `${i.precaution_ar} · ${i.ward_name ?? '—'}`}
              cardBadge={(i) => <Badge value={i.precaution === 'airborne' ? 'critical_high' : 'suspected'} label={i.precaution_ar} />}
              cardActions={(i) =>
                can('infection.isolate') ? (
                  <Button variant="ghost" size="sm" onClick={() => setEndIsoTarget({ id: i.id, patientName: i.patient_name })}>
                    إنهاء العزل
                  </Button>
                ) : null
              }
              columns={[
                {
                  key: 'pt',
                  header: 'المريض',
                  render: (i) => (
                    <div>
                      <span className="font-semibold">{i.patient_name}</span>
                      <span className="block text-xs text-slate-400">{i.mrn}</span>
                    </div>
                  ),
                },
                { key: 'loc', header: 'الموقع', render: (i) => `${i.ward_name ?? '—'} ${i.room_no ? `${i.room_no}/${i.bed_no ?? ''}` : ''}` },
                { key: 'prec', header: 'الاحتياط', render: (i) => <Badge value={i.precaution === 'airborne' ? 'critical_high' : 'suspected'} label={i.precaution_ar} /> },
                { key: 'org', header: 'الكائن', render: (i) => i.organism ?? '—' },
                { key: 'rsn', header: 'السبب', render: (i) => <span className="text-xs">{i.reason}</span> },
                { key: 'dt', header: 'البداية', render: (i) => formatDateTime(i.started_at) },
                {
                  key: 'act',
                  header: 'إجراء',
                  hideInCard: true,
                  render: (i) =>
                    can('infection.isolate') ? (
                      <Button variant="ghost" size="sm" onClick={() => setEndIsoTarget({ id: i.id, patientName: i.patient_name })}>
                        إنهاء العزل
                      </Button>
                    ) : null,
                },
              ]}
            />
          </Card>

          <Card
            title="ترصد العدوى المرتبطة بالرعاية الصحية (HAI — آخر ٩٠ يومًا)"
            subtitle="حد صريح: أعداد وصفية وليست معدلات معيارية معدّلة حسب NHSN/CDC؛ الاعتماد يتطلب مراجعًا مختلفًا عن المُبلّغ."
          >
            <DataTable
              caption="حالات العدوى المرتبطة بالرعاية"
              rows={ipc.cases ?? []}
              rowKey={(c) => c.id}
              emptyTitle="لا توجد حالات عدوى مسجلة"
              cardTitle={(c) => `${c.patient_name} — ${c.case_type_ar}`}
              cardSubtitle={(c) => `${c.organism ?? '—'} · بداية ${formatIsoDate(c.onset_date)}`}
              cardBadge={(c) => <Badge value={c.status} />}
              cardActions={(c) =>
                can('infection.confirm') && c.status === 'suspected' ? (
                  <div className="flex gap-1.5">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setReviewCaseTarget({ id: c.id, patientName: c.patient_name, decision: 'confirmed' })}
                    >
                      تأكيد الحالة
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setReviewCaseTarget({ id: c.id, patientName: c.patient_name, decision: 'excluded' })}
                    >
                      استبعاد
                    </Button>
                  </div>
                ) : null
              }
              columns={[
                { key: 'pt', header: 'المريض', render: (c) => `${c.patient_name} (${c.mrn})` },
                { key: 'type', header: 'النوع', render: (c) => `${c.case_type_ar} (${c.organism ?? '—'})` },
                { key: 'dt', header: 'البداية', render: (c) => formatIsoDate(c.onset_date) },
                { key: 'dev', header: 'أيام الأجهزة', render: (c) => c.device_days ?? '—' },
                { key: 'st', header: 'الحالة', render: (c) => <Badge value={c.status} /> },
                { key: 'rev', header: 'المراجع', render: (c) => c.reviewed_by_name ?? '—' },
                {
                  key: 'act',
                  header: 'إجراء',
                  hideInCard: true,
                  render: (c) =>
                    can('infection.confirm') && c.status === 'suspected' ? (
                      <div className="flex gap-1">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => setReviewCaseTarget({ id: c.id, patientName: c.patient_name, decision: 'confirmed' })}
                        >
                          تأكيد
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setReviewCaseTarget({ id: c.id, patientName: c.patient_name, decision: 'excluded' })}
                        >
                          استبعاد
                        </Button>
                      </div>
                    ) : null,
                },
              ]}
            />
          </Card>

          <div className="grid lg:grid-cols-3 gap-3">
            {can('infection.surveillance') && (
              <Card title="تسجيل اشتباه عدوى مرتبطة بالرعاية">
                <div className="space-y-2">
                  <Select label="المريض" value={hai.patientId} onChange={(e) => setHai({ ...hai, patientId: e.target.value })}>
                    <option value="">— اختر المريض —</option>
                    {patients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.fullNameAr ?? p.full_name_ar} · {p.mrn}
                      </option>
                    ))}
                  </Select>
                  <Select label="النوع" value={hai.caseType} onChange={(e) => setHai({ ...hai, caseType: e.target.value })}>
                    <option value="cauti">عدوى بولية (CAUTI)</option>
                    <option value="clabsi">عدوى مجرى الدم (CLABSI)</option>
                    <option value="vap">التهاب رئة (VAP)</option>
                    <option value="ssi">موضع جراحي (SSI)</option>
                    <option value="cdi">مطثية عسيرة (CDI)</option>
                    <option value="mrsa">MRSA</option>
                    <option value="other">أخرى</option>
                  </Select>
                  <Input label="تاريخ البدء" type="date" value={hai.onsetDate} onChange={(e) => setHai({ ...hai, onsetDate: e.target.value })} />
                  <Input label="الكائن الممرض" value={hai.organism} onChange={(e) => setHai({ ...hai, organism: e.target.value })} />
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={!hai.patientId || !hai.onsetDate}
                    onClick={() =>
                      act(async () => {
                        await api('/api/infection/cases', {
                          method: 'POST',
                          body: JSON.stringify({
                            patientId: hai.patientId,
                            caseType: hai.caseType,
                            onsetDate: hai.onsetDate,
                            organism: hai.organism || undefined,
                          }),
                        });
                        setHai({ ...hai, organism: '' });
                      }, 'سُجّلت حالة اشتباه بانتظار مراجعة شخص آخر').catch(() => {})
                    }
                  >
                    تسجيل الحالة
                  </Button>
                </div>
              </Card>
            )}

            {can('infection.isolate') && (
              <Card title="إصدار أمر عزل جديد">
                <div className="space-y-2">
                  <Select label="المريض" value={iso.patientId} onChange={(e) => setIso({ ...iso, patientId: e.target.value })}>
                    <option value="">— اختر المريض —</option>
                    {patients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.fullNameAr ?? p.full_name_ar} · {p.mrn}
                      </option>
                    ))}
                  </Select>
                  <Select label="نوع الاحتياط" value={iso.precaution} onChange={(e) => setIso({ ...iso, precaution: e.target.value })}>
                    <option value="contact">احتياط ملامسة</option>
                    <option value="droplet">احتياط رذاذ</option>
                    <option value="airborne">احتياط هوائي</option>
                    <option value="protective">حماية عكسية</option>
                  </Select>
                  <Input label="السبب السريري (5 أحرف على الأقل)" value={iso.reason} onChange={(e) => setIso({ ...iso, reason: e.target.value })} />
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={!iso.patientId || iso.reason.trim().length < 5}
                    onClick={() =>
                      act(async () => {
                        await api('/api/infection/isolations', {
                          method: 'POST',
                          body: JSON.stringify({ ...iso, organism: iso.organism || undefined }),
                        });
                        setIso({ ...iso, patientId: '', reason: '' });
                      }, 'صدر أمر العزل').catch(() => {})
                    }
                  >
                    إصدار الأمر
                  </Button>
                </div>
              </Card>
            )}

            {can('infection.audit') && (
              <Card title="تدقيق نظافة الأيدي (WHO 5 Moments)">
                <div className="space-y-2">
                  <Input label="الوحدة السريرية" value={hyg.unit} onChange={(e) => setHyg({ ...hyg, unit: e.target.value })} />
                  <Select label="اللحظة" value={hyg.moment} onChange={(e) => setHyg({ ...hyg, moment: e.target.value })}>
                    <option value="before_patient">قبل لمس المريض</option>
                    <option value="before_aseptic">قبل إجراء معقّم</option>
                    <option value="after_body_fluid">بعد سوائل الجسم</option>
                    <option value="after_patient">بعد لمس المريض</option>
                    <option value="after_surroundings">بعد محيط المريض</option>
                  </Select>
                  <div className="grid grid-cols-2 gap-2">
                    <Input label="الفرص" type="number" min={1} value={hyg.opportunities} onChange={(e) => setHyg({ ...hyg, opportunities: e.target.value })} />
                    <Input label="الملتزم بها" type="number" min={0} value={hyg.compliant} onChange={(e) => setHyg({ ...hyg, compliant: e.target.value })} />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    busy={busy}
                    disabled={Number(hyg.compliant) > Number(hyg.opportunities)}
                    onClick={() =>
                      act(
                        () =>
                          api('/api/infection/hand-hygiene', {
                            method: 'POST',
                            body: JSON.stringify({
                              ...hyg,
                              opportunities: Number(hyg.opportunities),
                              compliant: Number(hyg.compliant),
                            }),
                          }),
                        'سُجّلت ملاحظة نظافة الأيدي',
                      ).catch(() => {})
                    }
                  >
                    حفظ الملاحظة
                  </Button>
                </div>
              </Card>
            )}
          </div>
        </>
      )}

      {/* ReasonDialog #5: CSSD Load Recall */}
      <ReasonDialog
        open={!!recallTarget}
        onClose={() => setRecallTarget(null)}
        title={`سحب دورة التعقيم (${recallTarget?.loadNo ?? ''})`}
        consequenceNote="سيتم سحب جميع الحزم المرتبطة بهذه الدورة فورًا وإصدار تنبيه للحالات الجراحية المتأثرة في سجل التدقيق."
        minLength={5}
        confirmLabel="تأكيد سحب الدورة"
        variant="danger"
        onConfirm={async (reason) => {
          if (!recallTarget) return;
          await act(
            () =>
              api(`/api/cssd/loads/${recallTarget.id}/recall`, {
                method: 'POST',
                body: JSON.stringify({ reason }),
              }),
            'سُحبت دورة التعقيم وأُشعرت الأقسام المتأثرة',
          );
        }}
      />

      {/* ReasonDialog #6: End Isolation */}
      <ReasonDialog
        open={!!endIsoTarget}
        onClose={() => setEndIsoTarget(null)}
        title={`إنهاء أمر العزل — ${endIsoTarget?.patientName ?? ''}`}
        consequenceNote="سيتم إنهاء أمر العزل النشط وتوثيق مبرر الإنهاء السريري في سجل مكافحة العدوى."
        minLength={5}
        confirmLabel="تأكيد إنهاء العزل"
        variant="primary"
        onConfirm={async (reason) => {
          if (!endIsoTarget) return;
          await act(
            () =>
              api(`/api/infection/isolations/${endIsoTarget.id}/end`, {
                method: 'POST',
                body: JSON.stringify({ reason }),
              }),
            'أُنهي أمر العزل بسبب موثّق',
          );
        }}
      />

      {/* ReasonDialog #7 & #8: HAI Case Review (Confirmed or Excluded) */}
      <ReasonDialog
        open={!!reviewCaseTarget}
        onClose={() => setReviewCaseTarget(null)}
        title={
          reviewCaseTarget?.decision === 'confirmed'
            ? `اعتماد وتأكيد حالة العدوى — ${reviewCaseTarget.patientName}`
            : `استبعاد حالة العدوى — ${reviewCaseTarget?.patientName ?? ''}`
        }
        consequenceNote="تتطلب مراجعة الحالة مستخدمًا مختلفًا عن المُبلّغ (فصل مهام) ولا يمكن التراجع عنها بعد الحفظ."
        label={reviewCaseTarget?.decision === 'confirmed' ? 'ملاحظة الاعتماد السريري والمخبري' : 'مبرر استبعاد الحالة'}
        minLength={5}
        confirmLabel={reviewCaseTarget?.decision === 'confirmed' ? 'تأكيد الحالة' : 'استبعاد الحالة'}
        variant={reviewCaseTarget?.decision === 'confirmed' ? 'primary' : 'danger'}
        onConfirm={async (note) => {
          if (!reviewCaseTarget) return;
          await act(
            () =>
              api(`/api/infection/cases/${reviewCaseTarget.id}/review`, {
                method: 'POST',
                body: JSON.stringify({ decision: reviewCaseTarget.decision, note }),
              }),
            reviewCaseTarget.decision === 'confirmed' ? 'اعتُمدت حالة العدوى رسميًا' : 'استُبعدت حالة الاشتباه',
          );
        }}
      />
    </div>
  );
}

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
  Tabs,
  Textarea,
  useToast,
} from '../components';
import { usePolling } from '../hooks/usePolling';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../lib/format';
import { getBootstrapCached } from '../lib/referenceCache';

type TabKey = 'items' | 'requisitions' | 'batches' | 'warehouses' | 'movements';

const CATEGORY_LABELS: Record<string, string> = {
  consumables: 'مستهلكات طبية',
  ppe: 'معدات وقاية شخصية (PPE)',
  surgical_supplies: 'مستلزمات جراحية وعمليات',
  lab_reagents: 'كواشف ومحاليل مخبرية',
  dental_supplies: 'مستلزمات طب الأسنان',
  physio_supplies: 'مستلزمات العلاج الطبيعي',
  radiology_supplies: 'مستلزمات الأشعة والصبغات',
  general: 'إمداد تشغيلي عام',
};

const WAREHOUSE_TYPE_LABELS: Record<string, string> = {
  main: 'المستودع الطبي الرئيسي',
  medical_supplies: 'مستودع المستهلكات الطبية',
  surgical: 'مستودع العمليات والجراحة',
  dental: 'مستودع عيادة الأسنان',
  lab: 'مستودع المحاليل والمختبرات',
  rehab: 'مستودع العلاج الطبيعي',
  general: 'مستودع الإمداد العام',
};

const MOVEMENT_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  receipt: { label: 'توريد دفعة (+)', tone: 'success' },
  issue: { label: 'صرف لقسم (−)', tone: 'info' },
  adjustment: { label: 'تسوية جرد', tone: 'warning' },
  return: { label: 'مرتجع للمستودع (+)', tone: 'info' },
  writeoff: { label: 'إتلاف منتهي الصلاحية (−)', tone: 'danger' },
};

export default function InventoryPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [tab, setTab] = useState<TabKey>('items');
  const [totals, setTotals] = useState<any>(null);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [requisitions, setRequisitions] = useState<any[]>([]);
  const [movements, setMovements] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [lowOnly, setLowOnly] = useState(false);
  const [reqStatus, setReqStatus] = useState('all');
  const [whFilter, setWhFilter] = useState('all');

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Modals
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [whOpen, setWhOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<any | null>(null);

  const [itemForm, setItemForm] = useState({
    sku: '',
    nameAr: '',
    nameEn: '',
    category: 'consumables',
    unit: 'علبة',
    reorderLevel: '20',
    unitCost: '25',
  });

  const [receiveForm, setReceiveForm] = useState({
    warehouseId: '',
    itemId: '',
    batchNo: '',
    expiryDate: '',
    quantity: '50',
    unitCost: '',
    notes: '',
  });

  const [reqForm, setReqForm] = useState({
    departmentId: '',
    warehouseId: '',
    itemId: '',
    qtyRequested: '10',
    priority: 'routine',
    notes: '',
  });

  const [adjustForm, setAdjustForm] = useState({
    stockId: '',
    direction: 'minus',
    amount: '2',
    reason: '',
  });

  const [whForm, setWhForm] = useState({
    code: '',
    nameAr: '',
    nameEn: '',
    warehouseType: 'general',
  });

  const canManage = has(auth, 'inventory.manage');
  const canStock = has(auth, 'inventory.stock');
  const canRequest = hasAny(auth, ['inventory.request', 'inventory.manage', 'inventory.stock']);
  const canIssue = has(auth, 'inventory.issue');

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      const [board, boot] = await Promise.all([
        api<any>('/api/inventory/board'),
        getBootstrapCached(auth.activeFacilityId).catch(() => ({ departments: [] })),
      ]);
      const whs = board.warehouses ?? [];
      const its = board.items ?? [];
      const sts = board.stock ?? [];
      const depts = boot.departments ?? [];

      setTotals(board.totals ?? null);
      setWarehouses(whs);
      setItems(its);
      setBatches(sts);
      setRequisitions(board.requisitions ?? []);
      setMovements(board.movements ?? []);
      setDepartments(depts);

      setReceiveForm((prev) => ({
        ...prev,
        warehouseId: prev.warehouseId || whs[0]?.id || '',
        itemId: prev.itemId || its[0]?.id || '',
      }));
      setReqForm((prev) => ({
        ...prev,
        departmentId: prev.departmentId || depts[0]?.id || '',
        warehouseId: prev.warehouseId || whs[0]?.id || '',
        itemId: prev.itemId || its[0]?.id || '',
      }));
      setAdjustForm((prev) => ({
        ...prev,
        stockId: prev.stockId || sts[0]?.id || '',
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات المخازن والإمداد الطبي');
    } finally {
      setLoading(false);
    }
  }, [auth.activeFacilityId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const polling = usePolling(loadAll, { intervalMs: 30_000, enabled: true });

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (catFilter !== 'all' && it.category !== catFilter) return false;
      if (lowOnly && !it.low_stock) return false;
      if (!q) return true;
      return (
        String(it.sku ?? '').toLowerCase().includes(q) ||
        String(it.name_ar ?? '').toLowerCase().includes(q) ||
        String(it.name_en ?? '').toLowerCase().includes(q)
      );
    });
  }, [items, search, catFilter, lowOnly]);

  const filteredBatches = useMemo(() => {
    if (whFilter === 'all') return batches;
    return batches.filter((b) => b.warehouse_id === whFilter);
  }, [batches, whFilter]);

  const filteredRequisitions = useMemo(() => {
    if (reqStatus === 'all') return requisitions;
    return requisitions.filter((r) => r.status === reqStatus);
  }, [requisitions, reqStatus]);

  async function submitNewItem(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/inventory/items', {
        method: 'POST',
        body: JSON.stringify({
          sku: itemForm.sku.trim(),
          nameAr: itemForm.nameAr.trim(),
          nameEn: itemForm.nameEn.trim() || undefined,
          category: itemForm.category,
          unit: itemForm.unit.trim(),
          reorderLevel: Number(itemForm.reorderLevel),
          unitCost: Number(itemForm.unitCost),
        }),
      });
      toast.success('تمت إضافة الصنف إلى كتالوج المخازن');
      setNewItemOpen(false);
      setItemForm({
        sku: '',
        nameAr: '',
        nameEn: '',
        category: 'consumables',
        unit: 'علبة',
        reorderLevel: '20',
        unitCost: '25',
      });
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إضافة الصنف');
    } finally {
      setBusy(false);
    }
  }

  async function submitReceive(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/inventory/stock/receive', {
        method: 'POST',
        body: JSON.stringify({
          warehouseId: receiveForm.warehouseId,
          itemId: receiveForm.itemId,
          batchNo: receiveForm.batchNo.trim(),
          expiryDate: receiveForm.expiryDate || undefined,
          quantity: Number(receiveForm.quantity),
          unitCost: receiveForm.unitCost ? Number(receiveForm.unitCost) : undefined,
          notes: receiveForm.notes.trim() || undefined,
        }),
      });
      toast.success('تم استلام الدفعة وتحديث الرصيد وسجل الحركات');
      setReceiveOpen(false);
      setReceiveForm((p) => ({ ...p, batchNo: '', expiryDate: '', quantity: '50', unitCost: '', notes: '' }));
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر توريد الدفعة');
    } finally {
      setBusy(false);
    }
  }

  async function submitRequisition(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ reqNo: string }>('/api/inventory/requisitions', {
        method: 'POST',
        body: JSON.stringify({
          departmentId: reqForm.departmentId,
          warehouseId: reqForm.warehouseId,
          itemId: reqForm.itemId,
          qtyRequested: Number(reqForm.qtyRequested),
          priority: reqForm.priority,
          notes: reqForm.notes.trim() || undefined,
        }),
      });
      toast.success(`تم إنشاء طلب الصرف ${res.reqNo} — بانتظار أمين مستودع آخر للصرف (SoD)`);
      setReqOpen(false);
      setReqForm((p) => ({ ...p, qtyRequested: '10', notes: '' }));
      setTab('requisitions');
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إرسال طلب الصرف');
    } finally {
      setBusy(false);
    }
  }

  async function issueRequisition(reqRow: any) {
    setBusy(true);
    try {
      await api(`/api/inventory/requisitions/${reqRow.id}/issue`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      toast.success(`تم صرف ${reqRow.qty_requested} ${reqRow.unit} بنجاح وفق قاعدة الأقدم انتهاءً أولًا (FEFO)`);
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر صرف الطلب');
    } finally {
      setBusy(false);
    }
  }

  async function submitAdjust(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const rawAbs = Math.abs(Number(adjustForm.amount) || 1);
      const delta = adjustForm.direction === 'plus' ? rawAbs : -rawAbs;
      await api('/api/inventory/stock/adjust', {
        method: 'POST',
        body: JSON.stringify({
          stockId: adjustForm.stockId,
          delta,
          reason: adjustForm.reason.trim(),
        }),
      });
      toast.success('تمت تسوية الرصيد وتوثيق السبب في سجل الحركات غير القابل للتعديل');
      setAdjustOpen(false);
      setAdjustForm((p) => ({ ...p, amount: '2', reason: '' }));
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إجراء تسوية المخزون');
    } finally {
      setBusy(false);
    }
  }

  async function submitWarehouse(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/inventory/warehouses', {
        method: 'POST',
        body: JSON.stringify({
          code: whForm.code.trim().toUpperCase(),
          nameAr: whForm.nameAr.trim(),
          nameEn: whForm.nameEn.trim() || undefined,
          warehouseType: whForm.warehouseType,
        }),
      });
      toast.success('تم إنشاء المستودع بنجاح');
      setWhOpen(false);
      setWhForm({ code: '', nameAr: '', nameEn: '', warehouseType: 'general' });
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر إنشاء المستودع');
    } finally {
      setBusy(false);
    }
  }

  if (err && items.length === 0) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && items.length === 0) return <PageSkeleton cards={4} rows={6} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="المخازن والإمداد الطبي (Medical Stores)"
        subtitle="إدارة المستودعات المركزية والفرعية، تتبع الدفعات والصلاحيات (FEFO)، صرف طلبيات الأقسام مع فصل المهام (SoD)، ودفتر الحركات غير القابل للتعديل."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canRequest && (
              <Button variant="primary" size="sm" onClick={() => setReqOpen(true)}>
                + طلب صرف قسم
              </Button>
            )}
            {canStock && (
              <Button variant="ghost" size="sm" onClick={() => setReceiveOpen(true)}>
                + توريد دفعة
              </Button>
            )}
            {canManage && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setNewItemOpen(true)}>
                  + صنف جديد
                </Button>
                {batches.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setAdjustOpen(true)}>
                    تسوية جرد
                  </Button>
                )}
              </>
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
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatCard label="المستودعات النشطة" value={formatNumber(totals.warehouses)} tone="brand" />
          <StatCard label="أصناف الكتالوج" value={formatNumber(totals.items)} tone="info" />
          <StatCard
            label="أصناف تحت حد الطلب"
            value={formatNumber(totals.lowStock)}
            tone={Number(totals.lowStock) > 0 ? 'danger' : 'success'}
            sub="تنبيه نقص مخزون"
          />
          <StatCard
            label="دفعات قريبة الانتهاء"
            value={formatNumber(totals.expiringBatches)}
            tone={Number(totals.expiringBatches) > 0 ? 'warning' : 'success'}
            sub="خلال 90 يومًا"
          />
          <StatCard
            label="طلبات صرف معلّقة"
            value={formatNumber(totals.pendingRequisitions)}
            tone={Number(totals.pendingRequisitions) > 0 ? 'warning' : 'default'}
            sub="بانتظار الصرف (SoD)"
          />
          <StatCard
            label="قيمة المخزون الدفترية"
            value={formatMoney(totals.totalValuationSar)}
            tone="success"
          />
        </div>
      )}

      <Tabs<TabKey>
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'items', label: 'كتالوج الأصناف والأرصدة', count: items.length },
          { key: 'requisitions', label: 'طلبات صرف الأقسام (SoD)', count: requisitions.length },
          { key: 'batches', label: 'الدفعات والصلاحيات (FEFO)', count: batches.length },
          { key: 'warehouses', label: 'المستودعات', count: warehouses.length },
          { key: 'movements', label: 'سجل الحركات الثابت', count: movements.length },
        ]}
      />

      {tab === 'items' && (
        <Card
          title="دليل المستلزمات الطبية والأرصدة السارية"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="بحث برمز SKU أو الاسم..."
                aria-label="بحث في أصناف المخازن"
                className="input !w-48 text-xs"
              />
              <Select
                aria-label="تصفية فئة الصنف"
                className="!w-44 text-xs"
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
              >
                <option value="all">كل الفئات</option>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={lowOnly}
                  onChange={(e) => setLowOnly(e.target.checked)}
                />
                تحت حد الطلب فقط
              </label>
            </div>
          }
        >
          <DataTable
            caption="أصناف المستلزمات الطبية وأرصدتها"
            rows={filteredItems}
            rowKey={(r) => r.id}
            rowClassName={(r) => (r.low_stock ? 'bg-rose-50/50' : '')}
            emptyTitle="لا توجد أصناف مطابقة لمعايير التصفية"
            cardTitle={(r) => `${r.name_ar} (${r.sku})`}
            cardSubtitle={(r) => `${r.category_ar ?? CATEGORY_LABELS[r.category] ?? r.category}`}
            cardBadge={(r) =>
              r.low_stock ? (
                <Badge value="low_stock" tone="danger" label="تحت حد الطلب" />
              ) : (
                <Badge value="available" label="رصيد كافٍ" />
              )
            }
            columns={[
              {
                key: 'sku',
                header: 'رمز الصنف (SKU)',
                sortValue: (r) => r.sku,
                render: (r) => <span className="font-mono text-xs font-semibold">{r.sku}</span>,
              },
              {
                key: 'name',
                header: 'اسم الصنف',
                sortValue: (r) => r.name_ar,
                render: (r) => (
                  <div>
                    <span className="font-semibold text-slate-900">{r.name_ar}</span>
                    {r.name_en && <span className="block text-xs text-slate-500">{r.name_en}</span>}
                  </div>
                ),
              },
              {
                key: 'cat',
                header: 'الفئة',
                render: (r) => <span className="text-xs text-slate-700">{r.category_ar ?? CATEGORY_LABELS[r.category] ?? r.category}</span>,
              },
              {
                key: 'onhand',
                header: 'الرصيد الساري',
                sortValue: (r) => Number(r.total_on_hand),
                render: (r) => (
                  <span className="font-bold">
                    {formatNumber(r.total_on_hand)} <span className="text-xs font-normal text-slate-500">{r.unit}</span>
                  </span>
                ),
              },
              {
                key: 'reorder',
                header: 'حد إعادة الطلب',
                render: (r) => (
                  <span className="text-xs text-slate-600">
                    {formatNumber(r.reorder_level)} {r.unit}
                  </span>
                ),
              },
              {
                key: 'cost',
                header: 'تكلفة الوحدة',
                render: (r) => <span className="text-xs font-mono">{formatMoney(r.unit_cost)}</span>,
              },
              {
                key: 'status',
                header: 'حالة الإمداد',
                render: (r) =>
                  r.low_stock ? (
                    <Badge value="low_stock" tone="danger" label="نقص مخزون — يلزم التوريد" />
                  ) : (
                    <Badge value="available" label="متوفر" />
                  ),
              },
            ]}
          />
        </Card>
      )}

      {tab === 'requisitions' && (
        <Card
          title="طلبيات صرف المستلزمات للأقسام السريرية (تطبيق فصل المهام SoD)"
          action={
            <div className="flex items-center gap-2">
              <Select
                aria-label="حالة طلبات الصرف"
                className="!w-44 text-xs"
                value={reqStatus}
                onChange={(e) => setReqStatus(e.target.value)}
              >
                <option value="all">كل الطلبات</option>
                <option value="pending">معلّقة بانتظار الصرف</option>
                <option value="issued">مصروفة بالكامل</option>
                <option value="rejected">مرفوضة</option>
              </Select>
              {canRequest && (
                <Button variant="primary" size="sm" onClick={() => setReqOpen(true)}>
                  + طلب صرف جديد
                </Button>
              )}
            </div>
          }
        >
          <DataTable
            caption="طلبيات الصرف من المخازن"
            rows={filteredRequisitions}
            rowKey={(r) => r.id}
            emptyTitle="لا توجد طلبيات صرف في هذه الحالة"
            cardTitle={(r) => `${r.req_no} — ${r.item_name}`}
            cardSubtitle={(r) => `${r.department_name} · مستودع: ${r.warehouse_name}`}
            cardBadge={(r) => <Badge value={r.status} />}
            columns={[
              { key: 'no', header: 'رقم الطلب', render: (r) => <span className="font-mono text-xs font-bold">{r.req_no}</span> },
              {
                key: 'dept',
                header: 'القسم / المستودع',
                render: (r) => (
                  <div>
                    <span className="font-semibold">{r.department_name}</span>
                    <span className="block text-xs text-slate-500">{r.warehouse_name}</span>
                  </div>
                ),
              },
              {
                key: 'item',
                header: 'الصنف المطلوب',
                render: (r) => (
                  <div>
                    <span>{r.item_name}</span>
                    <span className="block text-xs text-slate-400 font-mono">{r.sku}</span>
                  </div>
                ),
              },
              {
                key: 'qty',
                header: 'الكمية (مطلوب / مصروف)',
                render: (r) => (
                  <span className="text-xs font-semibold">
                    {r.qty_requested} / {r.qty_issued ?? 0} {r.unit}
                  </span>
                ),
              },
              { key: 'pri', header: 'الأولوية', render: (r) => <Badge value={r.priority} /> },
              { key: 'st', header: 'الحالة', render: (r) => <Badge value={r.status} /> },
              {
                key: 'actors',
                header: 'الطالب / الصارف',
                render: (r) => (
                  <div className="text-xs">
                    <div>طالب: {r.requested_by_name}</div>
                    {r.issued_by_name && <div className="text-emerald-700">صرف: {r.issued_by_name}</div>}
                    {r.reject_reason && <div className="text-rose-700">الرفض: {r.reject_reason}</div>}
                  </div>
                ),
              },
              {
                key: 'act',
                header: 'إجراء',
                isActions: true,
                render: (r) => {
                  const isSelfRequest = r.requested_by === auth.user.id;
                  if (r.status !== 'pending' || !canIssue) return <span className="text-xs text-slate-400">—</span>;
                  return (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {isSelfRequest ? (
                        <span
                          className="text-[11px] px-2 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200"
                          title="فصل المهام (SoD): لا يمكن لمقدم الطلب اعتماد وصرف طلبه بنفسه"
                        >
                          يتطلب أمين مستودع آخر (SoD)
                        </span>
                      ) : (
                        <Button variant="primary" size="sm" busy={busy} onClick={() => issueRequisition(r)}>
                          صرف FEFO
                        </Button>
                      )}
                      <Button variant="danger" size="sm" disabled={busy} onClick={() => setRejectTarget(r)}>
                        رفض
                      </Button>
                    </div>
                  );
                },
              },
            ]}
          />
          <p className="text-xs text-slate-500 mt-3">
            ضابط فصل المهام (SoD): يُمنع برمجيًا وعلى مستوى قاعدة البيانات أن يقوم نفس الموظف بطلب المستلزمات وصرفها لنفسه، ويُسحب الرصيد تلقائيًا من الدفعة الأقرب انتهاءً (FEFO).
          </p>
        </Card>
      )}

      {tab === 'batches' && (
        <Card
          title="دفعات المخزون وتواريخ الصلاحية (FEFO)"
          action={
            <div className="flex items-center gap-2">
              <Select
                aria-label="تصفية حسب المستودع"
                className="!w-52 text-xs"
                value={whFilter}
                onChange={(e) => setWhFilter(e.target.value)}
              >
                <option value="all">كل المستودعات</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name_ar} ({w.code})
                  </option>
                ))}
              </Select>
              {canStock && (
                <Button variant="primary" size="sm" onClick={() => setReceiveOpen(true)}>
                  + توريد دفعة جديدة
                </Button>
              )}
            </div>
          }
        >
          <DataTable
            caption="دفعات المخازن مرتبة حسب تاريخ الانتهاء"
            rows={filteredBatches}
            rowKey={(b) => b.id}
            emptyTitle="لا توجد دفعات مسجلة في هذا المستودع"
            cardTitle={(b) => `${b.item_name} — دفعة ${b.batch_no}`}
            cardSubtitle={(b) => `${b.warehouse_name} · متاح: ${b.qty_on_hand} ${b.unit}`}
            columns={[
              { key: 'wh', header: 'المستودع', render: (b) => <span className="text-xs font-semibold">{b.warehouse_name}</span> },
              {
                key: 'item',
                header: 'الصنف',
                render: (b) => (
                  <div>
                    <span className="font-semibold">{b.item_name}</span>
                    <span className="block text-xs text-slate-400 font-mono">{b.sku}</span>
                  </div>
                ),
              },
              { key: 'batch', header: 'رقم التشغيلة', render: (b) => <span className="font-mono text-xs">{b.batch_no}</span> },
              {
                key: 'exp',
                header: 'تاريخ الصلاحية',
                render: (b) => {
                  if (!b.expiry_date) return <span className="text-xs text-slate-500">غير محدد الصلاحية</span>;
                  return (
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-xs">{formatDate(b.expiry_date)}</span>
                      {b.expired ? (
                        <Badge value="expired" label="منتهية" />
                      ) : b.expiring_soon ? (
                        <Badge value="expiring_soon" label={`${b.days_left} يوم`} />
                      ) : null}
                    </div>
                  );
                },
              },
              {
                key: 'qty',
                header: 'الكمية المتاحة',
                render: (b) => (
                  <span className="font-bold">
                    {formatNumber(b.qty_on_hand)} <span className="text-xs font-normal text-slate-500">{b.unit}</span>
                  </span>
                ),
              },
              { key: 'cost', header: 'تكلفة الوحدة', render: (b) => <span className="font-mono text-xs">{formatMoney(b.unit_cost)}</span> },
            ]}
          />
        </Card>
      )}

      {tab === 'warehouses' && (
        <Card
          title="المستودعات المركزية والفرعية المعتمدة"
          action={
            canManage ? (
              <Button variant="primary" size="sm" onClick={() => setWhOpen(true)}>
                + إضافة مستودع
              </Button>
            ) : undefined
          }
        >
          <DataTable
            caption="قائمة المستودعات"
            rows={warehouses}
            rowKey={(w) => w.id}
            columns={[
              { key: 'code', header: 'الرمز', render: (w) => <span className="font-mono text-xs font-bold">{w.code}</span> },
              {
                key: 'name',
                header: 'المستودع',
                render: (w) => (
                  <div>
                    <span className="font-semibold">{w.name_ar}</span>
                    {w.name_en && <span className="block text-xs text-slate-400">{w.name_en}</span>}
                  </div>
                ),
              },
              {
                key: 'type',
                header: 'التصنيف',
                render: (w) => <span className="text-xs">{w.warehouse_type_ar ?? WAREHOUSE_TYPE_LABELS[w.warehouse_type] ?? w.warehouse_type}</span>,
              },
              { key: 'batches', header: 'الدفعات النشطة', render: (w) => formatNumber(w.active_batches) },
              { key: 'val', header: 'القيمة الدفترية', render: (w) => <span className="font-mono text-xs">{formatMoney(w.valuation_sar)}</span> },
              { key: 'st', header: 'الحالة', render: (w) => <Badge value={w.is_active ? 'active' : 'inactive'} /> },
            ]}
          />
        </Card>
      )}

      {tab === 'movements' && (
        <Card title="سجل حركات المخزون غير القابل للتعديل أو الحذف (Immutable Ledger)">
          <DataTable
            caption="سجل حركات المخازن"
            rows={movements}
            rowKey={(m) => m.id}
            emptyTitle="لا توجد حركات مسجلة بعد"
            columns={[
              { key: 'dt', header: 'التوقيت', render: (m) => <span className="text-xs">{formatDateTime(m.created_at)}</span> },
              {
                key: 'type',
                header: 'نوع الحركة',
                render: (m) => {
                  const def = MOVEMENT_LABELS[m.movement_type] ?? { label: m.movement_type, tone: 'neutral' as const };
                  return <Badge value={m.movement_type} tone={def.tone} label={def.label} />;
                },
              },
              {
                key: 'item',
                header: 'الصنف والمستودع',
                render: (m) => (
                  <div>
                    <span className="font-semibold">{m.item_name}</span>
                    <span className="block text-xs text-slate-500">
                      {m.sku} · {m.warehouse_name} {m.batch_no ? `(دفعة ${m.batch_no})` : ''}
                    </span>
                  </div>
                ),
              },
              {
                key: 'delta',
                header: 'التغيّر في الرصيد',
                render: (m) => (
                  <span
                    className={`font-mono font-bold ${Number(m.quantity) > 0 ? 'text-emerald-700' : 'text-rose-700'}`}
                    dir="ltr"
                  >
                    {Number(m.quantity) > 0 ? `+${m.quantity}` : m.quantity} {m.unit}
                  </span>
                ),
              },
              { key: 'ref', header: 'السبب / المرجع', render: (m) => <span className="text-xs">{m.reason ?? m.reference_type ?? '—'}</span> },
              { key: 'by', header: 'المنفّذ', render: (m) => <span className="text-xs">{m.performed_by_name}</span> },
            ]}
          />
        </Card>
      )}

      {/* Modal: New Item */}
      <Modal open={newItemOpen} onClose={() => setNewItemOpen(false)} title="إضافة صنف مستلزمات جديد إلى الكتالوج">
        <form onSubmit={submitNewItem} className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="رمز الصنف (SKU)"
              required
              dir="ltr"
              placeholder="CON-GAUZE-10"
              value={itemForm.sku}
              onChange={(e) => setItemForm({ ...itemForm, sku: e.target.value })}
            />
            <Select
              label="الفئة"
              value={itemForm.category}
              onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })}
            >
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <Input
            label="الاسم بالعربية"
            required
            value={itemForm.nameAr}
            onChange={(e) => setItemForm({ ...itemForm, nameAr: e.target.value })}
          />
          <Input
            label="الاسم بالإنجليزية (اختياري)"
            dir="ltr"
            value={itemForm.nameEn}
            onChange={(e) => setItemForm({ ...itemForm, nameEn: e.target.value })}
          />
          <div className="grid sm:grid-cols-3 gap-3">
            <Input
              label="وحدة القياس"
              required
              placeholder="علبة / قطعة / كيس"
              value={itemForm.unit}
              onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })}
            />
            <Input
              label="حد إعادة الطلب"
              type="number"
              min="0"
              required
              value={itemForm.reorderLevel}
              onChange={(e) => setItemForm({ ...itemForm, reorderLevel: e.target.value })}
            />
            <Input
              label="تكلفة الوحدة (ر.س)"
              type="number"
              min="0"
              step="0.01"
              required
              value={itemForm.unitCost}
              onChange={(e) => setItemForm({ ...itemForm, unitCost: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setNewItemOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              حفظ الصنف
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Receive Batch */}
      <Modal open={receiveOpen} onClose={() => setReceiveOpen(false)} title="توريد واستلام دفعة مستلزمات للمستودع">
        <form onSubmit={submitReceive} className="space-y-3">
          <Select
            label="المستودع المستلم"
            required
            value={receiveForm.warehouseId}
            onChange={(e) => setReceiveForm({ ...receiveForm, warehouseId: e.target.value })}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar} ({w.code})
              </option>
            ))}
          </Select>
          <Select
            label="الصنف"
            required
            value={receiveForm.itemId}
            onChange={(e) => setReceiveForm({ ...receiveForm, itemId: e.target.value })}
          >
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name_ar} ({it.sku})
              </option>
            ))}
          </Select>
          <div className="grid sm:grid-cols-3 gap-3">
            <Input
              label="رقم التشغيلة (Batch)"
              required
              dir="ltr"
              placeholder="LOT-2027-01"
              value={receiveForm.batchNo}
              onChange={(e) => setReceiveForm({ ...receiveForm, batchNo: e.target.value })}
            />
            <Input
              label="تاريخ الانتهاء"
              type="date"
              value={receiveForm.expiryDate}
              onChange={(e) => setReceiveForm({ ...receiveForm, expiryDate: e.target.value })}
            />
            <Input
              label="الكمية المستلمة"
              type="number"
              min="1"
              required
              value={receiveForm.quantity}
              onChange={(e) => setReceiveForm({ ...receiveForm, quantity: e.target.value })}
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="تكلفة الوحدة (اختياري)"
              type="number"
              min="0"
              step="0.01"
              placeholder="يُعتمد السعر المرجعي تلقائيًا"
              value={receiveForm.unitCost}
              onChange={(e) => setReceiveForm({ ...receiveForm, unitCost: e.target.value })}
            />
            <Input
              label="ملاحظات التوريد / المورّد"
              placeholder="مثال: إذن استلام GRN-2026-12"
              value={receiveForm.notes}
              onChange={(e) => setReceiveForm({ ...receiveForm, notes: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setReceiveOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              تأكيد الاستلام
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Department Requisition */}
      <Modal open={reqOpen} onClose={() => setReqOpen(false)} title="طلب صرف مستلزمات لقسم سريري أو تشغيلي">
        <form onSubmit={submitRequisition} className="space-y-3">
          <Select
            label="القسم الطالب"
            required
            value={reqForm.departmentId}
            onChange={(e) => setReqForm({ ...reqForm, departmentId: e.target.value })}
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name_ar} ({d.code})
              </option>
            ))}
          </Select>
          <Select
            label="المستودع المطلوب الصرف منه"
            required
            value={reqForm.warehouseId}
            onChange={(e) => setReqForm({ ...reqForm, warehouseId: e.target.value })}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar} ({w.code})
              </option>
            ))}
          </Select>
          <Select
            label="الصنف المطلوب"
            required
            value={reqForm.itemId}
            onChange={(e) => setReqForm({ ...reqForm, itemId: e.target.value })}
          >
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name_ar} — متاح: {it.total_on_hand} {it.unit}
              </option>
            ))}
          </Select>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="الكمية المطلوبة"
              type="number"
              min="1"
              required
              value={reqForm.qtyRequested}
              onChange={(e) => setReqForm({ ...reqForm, qtyRequested: e.target.value })}
            />
            <Select
              label="الأولوية"
              value={reqForm.priority}
              onChange={(e) => setReqForm({ ...reqForm, priority: e.target.value })}
            >
              <option value="routine">روتيني</option>
              <option value="urgent">عاجل</option>
              <option value="stat">فوري حرج (STAT)</option>
            </Select>
          </div>
          <Textarea
            label="ملاحظات الاستخدام (اختياري)"
            rows={2}
            value={reqForm.notes}
            onChange={(e) => setReqForm({ ...reqForm, notes: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setReqOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              إرسال طلب الصرف
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Stock Adjustment */}
      <Modal open={adjustOpen} onClose={() => setAdjustOpen(false)} title="تسوية جرد مخزون بسبب موثّق">
        <form onSubmit={submitAdjust} className="space-y-3">
          <Select
            label="التشغيلة / الدفعة"
            required
            value={adjustForm.stockId}
            onChange={(e) => setAdjustForm({ ...adjustForm, stockId: e.target.value })}
          >
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.item_name} — دفعة {b.batch_no} ({b.warehouse_name} · رصيد {b.qty_on_hand})
              </option>
            ))}
          </Select>
          <div className="grid sm:grid-cols-2 gap-3">
            <Select
              label="اتجاه التسوية"
              value={adjustForm.direction}
              onChange={(e) => setAdjustForm({ ...adjustForm, direction: e.target.value })}
            >
              <option value="minus">خصم عجز جرد / تالف (−)</option>
              <option value="plus">إضافة فائض جرد (+)</option>
            </Select>
            <Input
              label="الكمية"
              type="number"
              min="1"
              required
              value={adjustForm.amount}
              onChange={(e) => setAdjustForm({ ...adjustForm, amount: e.target.value })}
            />
          </div>
          <Textarea
            label="السبب الموثّق للتسوية (5 أحرف على الأقل)"
            required
            minLength={5}
            rows={2}
            placeholder="مثال: مطابقة محضر الجرد الدوري رقم INV-11..."
            value={adjustForm.reason}
            onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setAdjustOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={adjustForm.reason.trim().length < 5}>
              اعتماد التسوية
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: New Warehouse */}
      <Modal open={whOpen} onClose={() => setWhOpen(false)} title="إضافة مستودع جديد للمنشأة">
        <form onSubmit={submitWarehouse} className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              label="رمز المستودع"
              required
              dir="ltr"
              placeholder="STR-ER"
              value={whForm.code}
              onChange={(e) => setWhForm({ ...whForm, code: e.target.value })}
            />
            <Select
              label="نوع المستودع"
              value={whForm.warehouseType}
              onChange={(e) => setWhForm({ ...whForm, warehouseType: e.target.value })}
            >
              {Object.entries(WAREHOUSE_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <Input
            label="اسم المستودع بالعربية"
            required
            value={whForm.nameAr}
            onChange={(e) => setWhForm({ ...whForm, nameAr: e.target.value })}
          />
          <Input
            label="اسم المستودع بالإنجليزية (اختياري)"
            dir="ltr"
            value={whForm.nameEn}
            onChange={(e) => setWhForm({ ...whForm, nameEn: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setWhOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" variant="primary" busy={busy}>
              إنشاء المستودع
            </Button>
          </div>
        </form>
      </Modal>

      <ReasonDialog
        open={!!rejectTarget}
        onClose={() => setRejectTarget(null)}
        title={`رفض طلب الصرف (${rejectTarget?.req_no ?? ''})`}
        consequenceNote="سيتم إغلاق طلب الصرف كمرفوض وتوثيق السبب في سجل التدقيق."
        minLength={5}
        confirmLabel="تأكيد رفض الطلب"
        variant="danger"
        onConfirm={async (reason) => {
          if (!rejectTarget) return;
          await api(`/api/inventory/requisitions/${rejectTarget.id}/reject`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
          toast.success('تم رفض طلب الصرف بسبب موثّق');
          await loadAll();
        }}
      />
    </div>
  );
}

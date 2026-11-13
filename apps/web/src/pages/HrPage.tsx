import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  PageSkeleton,
  PollingControl,
  ReasonDialog,
  SearchInput,
  Select,
  StatCard,
  Tabs,
  Textarea,
  useToast,
} from '../components';
import { useBootstrap } from '../hooks/useBootstrap';
import { usePolling } from '../hooks/usePolling';
import { formatDate, formatDateTime } from '../lib/format';

type HrTab = 'employees' | 'credentials' | 'shifts' | 'leaves' | 'self';

const EMP_TYPE_AR: Record<string, string> = {
  full_time: 'دوام كامل',
  part_time: 'دوام جزئي',
  locum: 'ممارس زائر (Locum)',
  contractor: 'تعاقد تشغيلي',
};

export default function HrPage({ auth, routeId }: { auth: Me; routeId?: string | null }) {
  const toast = useToast();
  const { boot } = useBootstrap();

  const canReadBoard = has(auth, 'hr.read');
  const canManage = has(auth, 'hr.manage');
  const canVerifyCred = has(auth, 'hr.credentials.verify');
  const canRoster = has(auth, 'hr.roster.manage');
  const canApproveLeave = has(auth, 'hr.leave.approve');
  const canSelf = has(auth, 'hr.self');

  const [tab, setTab] = useState<HrTab>(() => (canReadBoard ? 'employees' : 'self'));
  const [board, setBoard] = useState<any>(null);
  const [selfData, setSelfData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [empSearch, setEmpSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');

  // Modals
  const [empModalOpen, setEmpModalOpen] = useState(false);
  const [credModalOpen, setCredModalOpen] = useState(false);
  const [shiftModalOpen, setShiftModalOpen] = useState(false);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);

  // Reason / Confirm dialogs
  const [statusReasonTarget, setStatusReasonTarget] = useState<{
    id: string;
    name: string;
    status: 'suspended' | 'terminated';
  } | null>(null);
  const [revokeCredTarget, setRevokeCredTarget] = useState<{ id: string; licenseNo: string } | null>(null);
  const [cancelShiftTarget, setCancelShiftTarget] = useState<{ id: string; label: string } | null>(null);
  const [approveLeaveTarget, setApproveLeaveTarget] = useState<any | null>(null);
  const [rejectLeaveTarget, setRejectLeaveTarget] = useState<any | null>(null);

  const todayStr = new Date().toISOString().slice(0, 10);

  const [empForm, setEmpForm] = useState({
    fullNameAr: '',
    fullNameEn: '',
    category: 'physician',
    jobTitleAr: '',
    departmentId: '',
    employmentType: 'full_time',
    hireDate: todayStr,
    nationalId: '',
    phone: '',
  });

  const [credForm, setCredForm] = useState({
    employeeId: '',
    credentialType: 'scfhs',
    licenseNo: '',
    issuingBody: 'الهيئة السعودية للتخصصات الصحية',
    issuedDate: todayStr,
    expiryDate: '',
    notes: '',
  });

  const [shiftForm, setShiftForm] = useState({
    employeeId: '',
    departmentId: '',
    shiftDate: todayStr,
    shiftType: 'morning',
    notes: '',
  });

  const [leaveForm, setLeaveForm] = useState({
    employeeId: '',
    leaveType: 'annual',
    startDate: todayStr,
    endDate: todayStr,
    reason: '',
  });

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      const [b, s] = await Promise.all([
        canReadBoard ? api<any>('/api/hr/board') : Promise.resolve(null),
        canSelf || canReadBoard ? api<any>('/api/hr/me') : Promise.resolve(null),
      ]);
      setBoard(b);
      setSelfData(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات الموارد البشرية');
    } finally {
      setLoading(false);
    }
  }, [canReadBoard, canSelf]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (routeId && canReadBoard) {
      setTab('employees');
    }
  }, [routeId, canReadBoard]);

  const polling = usePolling(loadAll, { intervalMs: 30_000, enabled: true });

  const filteredEmployees = useMemo(() => {
    const list: any[] = board?.employees ?? [];
    const q = empSearch.trim().toLowerCase();
    return list.filter((e) => {
      if (catFilter !== 'all' && e.category !== catFilter) return false;
      if (!q) return true;
      return (
        String(e.employeeNo).toLowerCase().includes(q) ||
        String(e.fullNameAr).toLowerCase().includes(q) ||
        String(e.fullNameEn ?? '').toLowerCase().includes(q) ||
        String(e.jobTitleAr).toLowerCase().includes(q)
      );
    });
  }, [board?.employees, empSearch, catFilter]);

  async function submitEmployee(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/hr/employees', {
        method: 'POST',
        body: JSON.stringify({
          ...empForm,
          fullNameEn: empForm.fullNameEn || undefined,
          departmentId: empForm.departmentId || undefined,
          nationalId: empForm.nationalId || undefined,
          phone: empForm.phone || undefined,
        }),
      });
      toast.success('تم تسجيل ملف الموظف وتشفير بيانات الهوية والاتصال');
      setEmpModalOpen(false);
      setEmpForm({
        fullNameAr: '',
        fullNameEn: '',
        category: 'physician',
        jobTitleAr: '',
        departmentId: '',
        employmentType: 'full_time',
        hireDate: todayStr,
        nationalId: '',
        phone: '',
      });
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'فشل تسجيل الموظف');
    } finally {
      setBusy(false);
    }
  }

  async function submitCredential(e: React.FormEvent) {
    e.preventDefault();
    if (!credForm.employeeId) return;
    setBusy(true);
    try {
      await api(`/api/hr/employees/${credForm.employeeId}/credentials`, {
        method: 'POST',
        body: JSON.stringify({
          credentialType: credForm.credentialType,
          licenseNo: credForm.licenseNo,
          issuingBody: credForm.issuingBody,
          issuedDate: credForm.issuedDate,
          expiryDate: credForm.expiryDate,
          notes: credForm.notes || undefined,
        }),
      });
      toast.success('سُجّل الترخيص المهني وبانتظار مطابقة واعتماد مشرف آخر');
      setCredModalOpen(false);
      setCredForm({
        employeeId: '',
        credentialType: 'scfhs',
        licenseNo: '',
        issuingBody: 'الهيئة السعودية للتخصصات الصحية',
        issuedDate: todayStr,
        expiryDate: '',
        notes: '',
      });
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'فشل تسجيل الترخيص');
    } finally {
      setBusy(false);
    }
  }

  async function submitShift(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/hr/shifts', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: shiftForm.employeeId,
          departmentId: shiftForm.departmentId || undefined,
          shiftDate: shiftForm.shiftDate,
          shiftType: shiftForm.shiftType,
          notes: shiftForm.notes || undefined,
        }),
      });
      toast.success('تمت جدولة المناوبة بعد التحقق من سريان الترخيص الصحي وعدم التعارض');
      setShiftModalOpen(false);
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'فشلت جدولة المناوبة');
    } finally {
      setBusy(false);
    }
  }

  async function submitLeave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/hr/leaves', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: canManage && leaveForm.employeeId ? leaveForm.employeeId : undefined,
          leaveType: leaveForm.leaveType,
          startDate: leaveForm.startDate,
          endDate: leaveForm.endDate,
          reason: leaveForm.reason,
        }),
      });
      toast.success('تم إرسال طلب الإجازة للمراجعة والاعتماد');
      setLeaveModalOpen(false);
      setLeaveForm({ employeeId: '', leaveType: 'annual', startDate: todayStr, endDate: todayStr, reason: '' });
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'فشل إرسال طلب الإجازة');
    } finally {
      setBusy(false);
    }
  }

  async function quickPost(path: string, body: unknown, msg: string) {
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      toast.success(msg);
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر تنفيذ الإجراء');
    }
  }

  if (err && !board && !selfData) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && !board && !selfData) return <PageSkeleton cards={6} rows={6} />;

  const totals = board?.totals ?? {};
  const tabItems: Array<{ key: HrTab; label: string; count?: number }> = [
    ...(canReadBoard
      ? [
          { key: 'employees' as const, label: 'سجل الموظفين', count: board?.employees?.length ?? 0 },
          { key: 'credentials' as const, label: 'التراخيص الصحية (SCFHS)', count: board?.credentials?.length ?? 0 },
          { key: 'shifts' as const, label: 'جدول المناوبات', count: board?.shifts?.length ?? 0 },
          { key: 'leaves' as const, label: 'الإجازات والاعتمادات', count: totals.pending_leaves ?? 0 },
        ]
      : []),
    ...(canSelf || selfData?.employee ? [{ key: 'self' as const, label: 'ملفي الوظيفي الذاتي' }] : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="الموارد البشرية والتراخيص الطبية (HR & Credentialing)"
        description="إدارة الكوادر الصحية والإدارية، التحقق المزدوج من تراخيص مزاولة المهنة (SCFHS/MOH)، جدولة المناوبات الآمنة، والإجازات."
        limits="لا يشمل محرك مسيرات الرواتب (Payroll/WPS) أو الربط الخارجي مع التأمينات الاجتماعية (GOSI) وأجهزة البصمة."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PollingControl
              paused={polling.paused}
              onTogglePause={() => polling.setPaused((p) => !p)}
              lastUpdatedAt={polling.lastUpdatedAt}
              busy={polling.busy}
              onRefresh={polling.refreshNow}
            />
            {canManage && tab === 'employees' && (
              <Button variant="primary" onClick={() => setEmpModalOpen(true)}>
                + تسجيل موظف
              </Button>
            )}
            {canManage && tab === 'credentials' && (
              <Button variant="primary" onClick={() => setCredModalOpen(true)}>
                + إضافة ترخيص مهني
              </Button>
            )}
            {canRoster && tab === 'shifts' && (
              <Button variant="primary" onClick={() => setShiftModalOpen(true)}>
                + جدولة مناوبة
              </Button>
            )}
            {(canManage || canSelf) && (tab === 'leaves' || tab === 'self') && (
              <Button variant="primary" onClick={() => setLeaveModalOpen(true)}>
                + طلب إجازة
              </Button>
            )}
          </div>
        }
      />

      {canReadBoard && board && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <StatCard label="الموظفون النشطون" value={totals.active_employees ?? 0} />
          <StatCard label="ممارسون صحيون" value={totals.clinicians_count ?? 0} tone="brand" />
          <StatCard label="تراخيص معتمدة سارية" value={totals.verified_credentials ?? 0} tone="success" />
          <StatCard
            label="تنتهي خلال ٣٠ يومًا"
            value={totals.expiring_30d ?? 0}
            tone={(totals.expiring_30d ?? 0) > 0 ? 'warning' : 'default'}
          />
          <StatCard
            label="بانتظار تحقق / منتهية"
            value={totals.unverified_or_expired ?? 0}
            tone={(totals.unverified_or_expired ?? 0) > 0 ? 'danger' : 'default'}
          />
          <StatCard
            label="مناوبات اليوم / إجازات معلّقة"
            value={`${totals.today_shifts ?? 0} / ${totals.pending_leaves ?? 0}`}
            tone={(totals.pending_leaves ?? 0) > 0 ? 'info' : 'default'}
          />
        </div>
      )}

      <Tabs tabs={tabItems} active={tab} onChange={setTab} />

      {/* TAB 1: EMPLOYEES */}
      {tab === 'employees' && canReadBoard && (
        <Card title="سجل الكوادر البشرية في المنشأة">
          <div className="flex flex-wrap gap-3 items-end mb-4">
            <div className="flex-1 min-w-[240px]">
              <SearchInput
                value={empSearch}
                onChange={setEmpSearch}
                placeholder="ابحث بالرقم الوظيفي (EMP-)، الاسم، أو المسمى…"
              />
            </div>
            <div className="w-48">
              <Select
                aria-label="تصفية الفئة الوظيفية"
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
              >
                <option value="all">جميع الفئات</option>
                <option value="physician">أطباء</option>
                <option value="nursing">تمريض</option>
                <option value="allied_health">ممارسون مساندون</option>
                <option value="administrative">إداريون</option>
                <option value="support">خدمات مساندة</option>
              </Select>
            </div>
          </div>

          <DataTable
            caption="قائمة موظفي المنشأة"
            rows={filteredEmployees}
            rowKey={(e) => e.id}
            rowClassName={(e) => (routeId && e.id === routeId ? 'bg-brand-50 ring-2 ring-brand-500' : '')}
            emptyTitle="لا يوجد موظفون مطابقون لمعايير البحث"
            cardTitle={(e) => `${e.fullNameAr} (${e.employeeNo})`}
            cardSubtitle={(e) => `${e.jobTitleAr} · ${e.departmentName ?? 'بدون قسم'}`}
            cardBadge={(e) => <Badge value={e.status} />}
            cardActions={(e) =>
              canManage && e.status !== 'terminated' ? (
                <div className="flex flex-wrap gap-1.5">
                  {e.status !== 'active' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        api(`/api/hr/employees/${e.id}/status`, {
                          method: 'PATCH',
                          body: JSON.stringify({ status: 'active' }),
                        }).then(() => {
                          toast.success('أُعيد تفعيل ملف الموظف');
                          loadAll();
                        })
                      }
                    >
                      إعادة للعمل
                    </Button>
                  )}
                  {e.status === 'active' && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setStatusReasonTarget({ id: e.id, name: e.fullNameAr, status: 'suspended' })}
                    >
                      إيقاف مؤقت
                    </Button>
                  )}
                </div>
              ) : null
            }
            columns={[
              { key: 'no', header: 'الرقم الوظيفي', render: (e) => <span className="font-mono text-xs">{e.employeeNo}</span> },
              {
                key: 'name',
                header: 'الموظف والمسمى',
                render: (e) => (
                  <div>
                    <span className="font-semibold text-slate-900">{e.fullNameAr}</span>
                    <span className="block text-xs text-slate-500">{e.jobTitleAr}</span>
                  </div>
                ),
              },
              {
                key: 'dept',
                header: 'الفئة والقسم',
                render: (e) => (
                  <div>
                    <span>{e.categoryAr}</span>
                    <span className="block text-xs text-slate-400">{e.departmentName ?? '—'}</span>
                  </div>
                ),
              },
              { key: 'type', header: 'التعاقد', render: (e) => <span className="text-xs">{EMP_TYPE_AR[e.employmentType] ?? e.employmentType}</span> },
              {
                key: 'lic',
                header: 'التراخيص السارية',
                render: (e) => (
                  <div className="text-xs">
                    <span className="font-bold">{e.verifiedLicenses}</span>
                    {e.nearestExpiry && <span className="block text-[11px] text-slate-500">أقرب انتهاء: {e.nearestExpiry}</span>}
                  </div>
                ),
              },
              { key: 'st', header: 'الحالة', render: (e) => <Badge value={e.status} /> },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (e) =>
                  canManage && e.status !== 'terminated' ? (
                    <div className="flex gap-1.5">
                      {e.status !== 'active' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            api(`/api/hr/employees/${e.id}/status`, {
                              method: 'PATCH',
                              body: JSON.stringify({ status: 'active' }),
                            })
                              .then(() => {
                                toast.success('أُعيد تفعيل ملف الموظف');
                                loadAll();
                              })
                              .catch((ex: Error) => toast.error(ex.message))
                          }
                        >
                          تفعيل
                        </Button>
                      )}
                      {e.status === 'active' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setStatusReasonTarget({ id: e.id, name: e.fullNameAr, status: 'suspended' })}
                        >
                          إيقاف
                        </Button>
                      )}
                    </div>
                  ) : null,
              },
            ]}
          />
        </Card>
      )}

      {/* TAB 2: CREDENTIALS */}
      {tab === 'credentials' && canReadBoard && (
        <div className="space-y-4">
          {(board?.expiringLicenses?.length ?? 0) > 0 && (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950">
              <b>تنبيه امتثال التراخيص الصحية:</b> يوجد {board.expiringLicenses.length} ترخيص مزاولة ينتهي خلال ٣٠ يومًا أو أقل. يمنع النظام تلقائيًا جدولة أي ممارس صحي في مناوبة بعد انتهاء ترخيص SCFHS/وزارة الصحة الخاص به.
            </div>
          )}

          <Card title="سجل التراخيص والشهادات المهنية (SCFHS / MOH / BLS / ACLS)">
            <DataTable
              caption="جدول التراخيص المهنية"
              rows={board?.credentials ?? []}
              rowKey={(c) => c.id}
              rowClassName={(c) => (c.is_expired || c.status === 'revoked' ? 'bg-rose-50/50' : c.days_left <= 30 ? 'bg-amber-50/50' : '')}
              cardTitle={(c) => `${c.employee_name} — ${c.license_no}`}
              cardSubtitle={(c) => `${c.credential_type_ar} · تنتهي: ${c.expiry_date}`}
              cardBadge={(c) => <Badge value={c.is_expired && c.status === 'verified' ? 'expired' : c.status} />}
              cardActions={(c) => (
                <div className="flex flex-wrap gap-1.5">
                  {canVerifyCred && c.status === 'pending_verification' && c.recorded_by !== auth.user.id && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => quickPost(`/api/hr/credentials/${c.id}/verify`, {}, 'تم التحقق واعتماد الترخيص المهني')}
                    >
                      اعتماد الترخيص
                    </Button>
                  )}
                  {canVerifyCred && c.status !== 'revoked' && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setRevokeCredTarget({ id: c.id, licenseNo: c.license_no })}
                    >
                      سحب الترخيص
                    </Button>
                  )}
                </div>
              )}
              columns={[
                {
                  key: 'emp',
                  header: 'الممارس',
                  render: (c) => (
                    <div>
                      <span className="font-semibold">{c.employee_name}</span>
                      <span className="block font-mono text-xs text-slate-400">{c.employee_no}</span>
                    </div>
                  ),
                },
                {
                  key: 'type',
                  header: 'نوع الشهادة ورقمها',
                  render: (c) => (
                    <div>
                      <span>{c.credential_type_ar}</span>
                      <span className="block font-mono text-xs text-slate-500">{c.license_no}</span>
                    </div>
                  ),
                },
                {
                  key: 'exp',
                  header: 'الصلاحية',
                  render: (c) => (
                    <div className="text-xs">
                      <span>{c.expiry_date}</span>
                      <span className={`block font-semibold ${c.days_left <= 30 ? 'text-amber-700' : 'text-slate-500'}`}>
                        {c.days_left < 0 ? `منتهية منذ ${Math.abs(c.days_left)} يوم` : `متبقي ${c.days_left} يوم`}
                      </span>
                    </div>
                  ),
                },
                {
                  key: 'st',
                  header: 'الحالة والاعتماد',
                  render: (c) => (
                    <div>
                      <Badge value={c.is_expired && c.status === 'verified' ? 'expired' : c.status} />
                      {c.verified_by_name && <span className="block text-[11px] text-slate-500 mt-0.5">اعتمدها: {c.verified_by_name}</span>}
                    </div>
                  ),
                },
                {
                  key: 'act',
                  header: 'إجراء',
                  hideInCard: true,
                  render: (c) => (
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {canVerifyCred && c.status === 'pending_verification' && (
                        c.recorded_by === auth.user.id ? (
                          <span className="text-[11px] text-amber-800">بانتظار مشرف آخر (SoD)</span>
                        ) : (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => quickPost(`/api/hr/credentials/${c.id}/verify`, {}, 'تم التحقق واعتماد الترخيص المهني')}
                          >
                            اعتماد
                          </Button>
                        )
                      )}
                      {canVerifyCred && c.status !== 'revoked' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevokeCredTarget({ id: c.id, licenseNo: c.license_no })}
                        >
                          سحب
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </div>
      )}

      {/* TAB 3: SHIFTS */}
      {tab === 'shifts' && canReadBoard && (
        <Card
          title="جدول المناوبات والحضور"
          subtitle="لا يقبل الخادم جدولة أي ممارس صحي في مناوبة ما لم يكن ترخيص مزاولته معتمدًا وساريًا في تاريخ المناوبة."
        >
          <DataTable
            caption="جدول المناوبات"
            rows={board?.shifts ?? []}
            rowKey={(s) => s.id}
            emptyTitle="لا توجد مناوبات مجدولة في الفترة الحالية"
            cardTitle={(s) => `${s.employee_name} — ${s.shift_date}`}
            cardSubtitle={(s) => `${s.shift_type_ar} · ${s.department_name ?? 'عام'}`}
            cardBadge={(s) => <Badge value={s.status} />}
            cardActions={(s) => (
              <div className="flex flex-wrap gap-1.5">
                {canRoster && s.status === 'scheduled' && (
                  <>
                    <Button variant="primary" size="sm" onClick={() => quickPost(`/api/hr/shifts/${s.id}/checkin`, {}, 'سُجّل حضور المناوبة')}>
                      تسجيل حضور
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setCancelShiftTarget({ id: s.id, label: `${s.employee_name} (${s.shift_date})` })}
                    >
                      إلغاء
                    </Button>
                  </>
                )}
                {canRoster && s.status === 'checked_in' && (
                  <Button variant="primary" size="sm" onClick={() => quickPost(`/api/hr/shifts/${s.id}/complete`, {}, 'أُنهيت المناوبة بنجاح')}>
                    إتمام المناوبة
                  </Button>
                )}
              </div>
            )}
            columns={[
              { key: 'dt', header: 'التاريخ والفترة', render: (s) => <div><b className="font-mono text-xs">{s.shift_date}</b><span className="block text-xs text-slate-500">{s.shift_type_ar}</span></div> },
              { key: 'emp', header: 'الموظف', render: (s) => <div><span className="font-semibold">{s.employee_name}</span><span className="block text-xs text-slate-400">{s.job_title_ar}</span></div> },
              { key: 'dept', header: 'القسم', render: (s) => s.department_name ?? '—' },
              { key: 'st', header: 'الحالة', render: (s) => <Badge value={s.status} /> },
              { key: 'in', header: 'وقت الحضور', render: (s) => <span className="text-xs">{formatDateTime(s.checked_in_at)}</span> },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (s) => (
                  <div className="flex gap-1.5">
                    {canRoster && s.status === 'scheduled' && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => quickPost(`/api/hr/shifts/${s.id}/checkin`, {}, 'سُجّل حضور المناوبة')}>
                          حضور
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCancelShiftTarget({ id: s.id, label: `${s.employee_name} (${s.shift_date})` })}
                        >
                          إلغاء
                        </Button>
                      </>
                    )}
                    {canRoster && s.status === 'checked_in' && (
                      <Button variant="primary" size="sm" onClick={() => quickPost(`/api/hr/shifts/${s.id}/complete`, {}, 'أُنهيت المناوبة بنجاح')}>
                        إتمام
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      )}

      {/* TAB 4: LEAVES */}
      {tab === 'leaves' && canReadBoard && (
        <Card
          title="طلبات الإجازات والاعتمادات"
          subtitle="ضابط فصل المهام: لا يمكن لمقدم الطلب أو الموظف نفسه اعتماد أو رفض إجازته."
        >
          <DataTable
            caption="طلبات الإجازات"
            rows={board?.leaves ?? []}
            rowKey={(l) => l.id}
            emptyTitle="لا توجد طلبات إجازة مسجلة"
            cardTitle={(l) => `${l.request_no} — ${l.employee_name}`}
            cardSubtitle={(l) => `${l.leave_type_ar} · ${l.start_date} → ${l.end_date} (${l.days_count} أيام)`}
            cardBadge={(l) => <Badge value={l.status} />}
            cardActions={(l) =>
              canApproveLeave && l.status === 'pending' && l.requested_by !== auth.user.id && l.employee_user_id !== auth.user.id ? (
                <div className="flex gap-1.5">
                  <Button variant="primary" size="sm" onClick={() => setApproveLeaveTarget(l)}>
                    اعتماد
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setRejectLeaveTarget(l)}>
                    رفض
                  </Button>
                </div>
              ) : null
            }
            columns={[
              { key: 'no', header: 'رقم الطلب', render: (l) => <span className="font-mono text-xs">{l.request_no}</span> },
              { key: 'emp', header: 'الموظف', render: (l) => <span className="font-semibold">{l.employee_name}</span> },
              { key: 'tp', header: 'النوع والمدة', render: (l) => <div><span>{l.leave_type_ar}</span><span className="block text-xs text-slate-500">{l.start_date} ← {l.end_date} ({l.days_count} يوم)</span></div> },
              { key: 'rsn', header: 'السبب', render: (l) => <span className="text-xs">{l.reason}</span> },
              {
                key: 'st',
                header: 'الحالة',
                render: (l) => (
                  <div>
                    <Badge value={l.status} />
                    {l.reviewed_by_name && <span className="block text-[11px] text-slate-500 mt-0.5">راجعها: {l.reviewed_by_name}</span>}
                  </div>
                ),
              },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (l) =>
                  canApproveLeave && l.status === 'pending' ? (
                    l.requested_by === auth.user.id || l.employee_user_id === auth.user.id ? (
                      <span className="text-[11px] text-amber-800">بانتظار معتمد آخر (SoD)</span>
                    ) : (
                      <div className="flex gap-1.5">
                        <Button variant="primary" size="sm" onClick={() => setApproveLeaveTarget(l)}>
                          اعتماد
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => setRejectLeaveTarget(l)}>
                          رفض
                        </Button>
                      </div>
                    )
                  ) : null,
              },
            ]}
          />
        </Card>
      )}

      {/* TAB 5: EMPLOYEE SELF-SERVICE */}
      {tab === 'self' && (
        <div className="space-y-4">
          {!selfData?.employee ? (
            <Card title="البوابة الذاتية للموظف">
              <EmptyState
                title="لا يوجد ملف وظيفي مرتبط بحسابك الحالي"
                description="يمكن لقسم الموارد البشرية ربط حساب المستخدم بملف الموظف لعرض التراخيص والمناوبات وتقديم الإجازات."
              />
            </Card>
          ) : (
            <>
              <Card
                title={`${selfData.employee.fullNameAr} (${selfData.employee.employeeNo})`}
                subtitle={`${selfData.employee.jobTitleAr} · ${selfData.employee.departmentName ?? '—'} · تاريخ المباشرة: ${formatDate(selfData.employee.hireDate)}`}
                action={<Badge value={selfData.employee.status} />}
              >
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <h3 className="font-bold text-sm text-slate-900 mb-2">تراخيصي المهنية المسجلة</h3>
                    {selfData.credentials.length === 0 ? (
                      <p className="text-xs text-slate-500">لا توجد تراخيص مسجلة.</p>
                    ) : (
                      <ul className="divide-y divide-slate-100 text-xs">
                        {selfData.credentials.map((c: any) => (
                          <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                            <div>
                              <span className="font-semibold text-slate-900">{c.credential_type_ar}</span>
                              <span className="block font-mono text-slate-500">
                                {c.license_no} · ينتهي {c.expiry_date} ({c.days_left} يوم)
                              </span>
                            </div>
                            <Badge value={c.status} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h3 className="font-bold text-sm text-slate-900 mb-2">مناوباتي القادمة والحالية</h3>
                    {selfData.shifts.length === 0 ? (
                      <p className="text-xs text-slate-500">لا توجد مناوبات مجدولة.</p>
                    ) : (
                      <ul className="divide-y divide-slate-100 text-xs">
                        {selfData.shifts.map((s: any) => (
                          <li key={s.id} className="py-2 flex items-center justify-between gap-2">
                            <div>
                              <b className="font-mono">{s.shift_date}</b> — {s.shift_type_ar}
                              <span className="block text-slate-500">{s.department_name ?? '—'}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Badge value={s.status} />
                              {s.status === 'scheduled' && (
                                <Button variant="primary" size="sm" onClick={() => quickPost(`/api/hr/shifts/${s.id}/checkin`, {}, 'تم تسجيل حضورك للمناوبة')}>
                                  حضور
                                </Button>
                              )}
                              {s.status === 'checked_in' && (
                                <Button variant="ghost" size="sm" onClick={() => quickPost(`/api/hr/shifts/${s.id}/complete`, {}, 'تم إنهاء المناوبة')}>
                                  إنهاء
                                </Button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </Card>

              <Card title="طلبات إجازاتي">
                {selfData.leaves.length === 0 ? (
                  <EmptyState title="لم تتقدم بأي طلب إجازة بعد" />
                ) : (
                  <DataTable
                    caption="سجل إجازات الموظف"
                    rows={selfData.leaves}
                    rowKey={(l: any) => l.id}
                    columns={[
                      { key: 'no', header: 'الرقم', render: (l: any) => <span className="font-mono text-xs">{l.request_no}</span> },
                      { key: 'tp', header: 'النوع', render: (l: any) => l.leave_type_ar },
                      { key: 'dt', header: 'الفترة', render: (l: any) => `${l.start_date} ← ${l.end_date} (${l.days_count} يوم)` },
                      { key: 'st', header: 'الحالة', render: (l: any) => <Badge value={l.status} /> },
                      { key: 'nt', header: 'ملاحظة الإدارة', render: (l: any) => <span className="text-xs">{l.review_note ?? '—'}</span> },
                    ]}
                  />
                )}
              </Card>
            </>
          )}
        </div>
      )}

      {/* MODAL: CREATE EMPLOYEE */}
      <Modal
        open={empModalOpen}
        onClose={() => setEmpModalOpen(false)}
        title="تسجيل موظف جديد في المنشأة"
        description="تُشفّر بيانات الهوية والجوال بـ AES-256-GCM مع ربط السياق (AAD) قبل التخزين."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEmpModalOpen(false)}>إلغاء</Button>
            <Button type="submit" form="hr-emp-form" variant="primary" busy={busy}>حفظ الموظف</Button>
          </>
        }
      >
        <form id="hr-emp-form" onSubmit={submitEmployee} className="grid sm:grid-cols-2 gap-3">
          <Input label="الاسم الرباعي بالعربية" required value={empForm.fullNameAr} onChange={(e) => setEmpForm({ ...empForm, fullNameAr: e.target.value })} />
          <Input label="الاسم بالإنجليزية" dir="ltr" value={empForm.fullNameEn} onChange={(e) => setEmpForm({ ...empForm, fullNameEn: e.target.value })} />
          <Select label="الفئة الوظيفية" value={empForm.category} onChange={(e) => setEmpForm({ ...empForm, category: e.target.value })}>
            <option value="physician">أطباء</option>
            <option value="nursing">تمريض</option>
            <option value="allied_health">ممارسون صحيون مساندون</option>
            <option value="administrative">إداريون</option>
            <option value="support">خدمات مساندة</option>
          </Select>
          <Input label="المسمى الوظيفي" required value={empForm.jobTitleAr} onChange={(e) => setEmpForm({ ...empForm, jobTitleAr: e.target.value })} />
          <Select label="القسم" value={empForm.departmentId} onChange={(e) => setEmpForm({ ...empForm, departmentId: e.target.value })}>
            <option value="">— عام / غير محدد —</option>
            {(boot?.departments ?? []).map((d: any) => (
              <option key={d.id} value={d.id}>{d.name_ar}</option>
            ))}
          </Select>
          <Select label="نوع التعاقد" value={empForm.employmentType} onChange={(e) => setEmpForm({ ...empForm, employmentType: e.target.value })}>
            <option value="full_time">دوام كامل</option>
            <option value="part_time">دوام جزئي</option>
            <option value="locum">ممارس زائر (Locum)</option>
            <option value="contractor">تعاقد تشغيلي</option>
          </Select>
          <Input label="تاريخ المباشرة" type="date" required value={empForm.hireDate} onChange={(e) => setEmpForm({ ...empForm, hireDate: e.target.value })} />
          <Input label="رقم الهوية / الإقامة (10 أرقام اختياري)" dir="ltr" maxLength={10} value={empForm.nationalId} onChange={(e) => setEmpForm({ ...empForm, nationalId: e.target.value })} />
        </form>
      </Modal>

      {/* MODAL: ADD CREDENTIAL */}
      <Modal
        open={credModalOpen}
        onClose={() => setCredModalOpen(false)}
        title="تسجيل ترخيص مزاولة أو شهادة مهنية"
        description="يُحفظ الترخيص بحالة «بانتظار التحقق» ويجب اعتماده من مشرف آخر تطبيقًا لفصل المهام."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCredModalOpen(false)}>إلغاء</Button>
            <Button type="submit" form="hr-cred-form" variant="primary" busy={busy}>تسجيل الترخيص</Button>
          </>
        }
      >
        <form id="hr-cred-form" onSubmit={submitCredential} className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Select label="الموظف" required value={credForm.employeeId} onChange={(e) => setCredForm({ ...credForm, employeeId: e.target.value })}>
              <option value="">— اختر الموظف —</option>
              {(board?.employees ?? []).filter((e: any) => e.status !== 'terminated').map((e: any) => (
                <option key={e.id} value={e.id}>{e.fullNameAr} ({e.employeeNo})</option>
              ))}
            </Select>
          </div>
          <Select label="نوع الترخيص" value={credForm.credentialType} onChange={(e) => setCredForm({ ...credForm, credentialType: e.target.value })}>
            <option value="scfhs">تصنيف الهيئة السعودية للتخصصات الصحية (SCFHS)</option>
            <option value="moh_license">ترخيص مزاولة وزارة الصحة</option>
            <option value="bls">دعم الحياة الأساسي (BLS)</option>
            <option value="acls">دعم الحياة القلبي المتقدم (ACLS)</option>
            <option value="board">زمالة / بورد تخصصي</option>
            <option value="other">شهادة مهنية أخرى</option>
          </Select>
          <Input label="رقم الترخيص" required dir="ltr" value={credForm.licenseNo} onChange={(e) => setCredForm({ ...credForm, licenseNo: e.target.value })} />
          <div className="sm:col-span-2">
            <Input label="الجهة المانحة" required value={credForm.issuingBody} onChange={(e) => setCredForm({ ...credForm, issuingBody: e.target.value })} />
          </div>
          <Input label="تاريخ الإصدار" type="date" required value={credForm.issuedDate} onChange={(e) => setCredForm({ ...credForm, issuedDate: e.target.value })} />
          <Input label="تاريخ الانتهاء" type="date" required value={credForm.expiryDate} onChange={(e) => setCredForm({ ...credForm, expiryDate: e.target.value })} />
        </form>
      </Modal>

      {/* MODAL: SCHEDULE SHIFT */}
      <Modal
        open={shiftModalOpen}
        onClose={() => setShiftModalOpen(false)}
        title="جدولة مناوبة جديدة"
        description="يتحقق الخادم تلقائيًا من عدم وجود إجازة معتمدة ومن سريان ترخيص SCFHS/وزارة الصحة للممارسين الصحيين."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShiftModalOpen(false)}>إلغاء</Button>
            <Button type="submit" form="hr-shift-form" variant="primary" busy={busy}>جدولة المناوبة</Button>
          </>
        }
      >
        <form id="hr-shift-form" onSubmit={submitShift} className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Select label="الموظف" required value={shiftForm.employeeId} onChange={(e) => setShiftForm({ ...shiftForm, employeeId: e.target.value })}>
              <option value="">— اختر الموظف —</option>
              {(board?.employees ?? []).filter((e: any) => e.status === 'active').map((e: any) => (
                <option key={e.id} value={e.id}>{e.fullNameAr} — {e.jobTitleAr}</option>
              ))}
            </Select>
          </div>
          <Input label="تاريخ المناوبة" type="date" required value={shiftForm.shiftDate} onChange={(e) => setShiftForm({ ...shiftForm, shiftDate: e.target.value })} />
          <Select label="فترة المناوبة" value={shiftForm.shiftType} onChange={(e) => setShiftForm({ ...shiftForm, shiftType: e.target.value })}>
            <option value="morning">صباحية (07:00–15:00)</option>
            <option value="evening">مسائية (15:00–23:00)</option>
            <option value="night">ليلية (23:00–07:00)</option>
            <option value="on_call">مناوبة استدعاء (On-Call)</option>
          </Select>
          <div className="sm:col-span-2">
            <Select label="القسم (اختياري — يرث قسم الموظف تلقائيًا)" value={shiftForm.departmentId} onChange={(e) => setShiftForm({ ...shiftForm, departmentId: e.target.value })}>
              <option value="">— قسم الموظف الافتراضي —</option>
              {(boot?.departments ?? []).map((d: any) => (
                <option key={d.id} value={d.id}>{d.name_ar}</option>
              ))}
            </Select>
          </div>
        </form>
      </Modal>

      {/* MODAL: REQUEST LEAVE */}
      <Modal
        open={leaveModalOpen}
        onClose={() => setLeaveModalOpen(false)}
        title="تقديم طلب إجازة"
        description="يُحسب عدد الأيام تلقائيًا مع التحقق من عدم تداخل التواريخ مع إجازات سابقة."
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaveModalOpen(false)}>إلغاء</Button>
            <Button type="submit" form="hr-leave-form" variant="primary" busy={busy}>إرسال الطلب</Button>
          </>
        }
      >
        <form id="hr-leave-form" onSubmit={submitLeave} className="grid sm:grid-cols-2 gap-3">
          {canManage && tab !== 'self' && (
            <div className="sm:col-span-2">
              <Select label="الموظف" required value={leaveForm.employeeId} onChange={(e) => setLeaveForm({ ...leaveForm, employeeId: e.target.value })}>
                <option value="">— اختر الموظف —</option>
                {(board?.employees ?? []).filter((e: any) => e.status !== 'terminated').map((e: any) => (
                  <option key={e.id} value={e.id}>{e.fullNameAr} ({e.employeeNo})</option>
                ))}
              </Select>
            </div>
          )}
          <div className="sm:col-span-2">
            <Select label="نوع الإجازة" value={leaveForm.leaveType} onChange={(e) => setLeaveForm({ ...leaveForm, leaveType: e.target.value })}>
              <option value="annual">إجازة سنوية</option>
              <option value="sick">إجازة مرضية</option>
              <option value="emergency">إجازة اضطرارية</option>
              <option value="study">إجازة دراسية / مؤتمر علمي</option>
              <option value="maternity">إجازة أمومة</option>
              <option value="unpaid">إجازة بدون راتب</option>
            </Select>
          </div>
          <Input label="من تاريخ" type="date" required value={leaveForm.startDate} onChange={(e) => setLeaveForm({ ...leaveForm, startDate: e.target.value })} />
          <Input label="إلى تاريخ" type="date" required value={leaveForm.endDate} onChange={(e) => setLeaveForm({ ...leaveForm, endDate: e.target.value })} />
          <div className="sm:col-span-2">
            <Textarea label="سبب ومبررات الإجازة (5 أحرف على الأقل)" required rows={2} value={leaveForm.reason} onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })} />
          </div>
        </form>
      </Modal>

      {/* REASON & CONFIRM DIALOGS */}
      <ReasonDialog
        open={!!statusReasonTarget}
        onClose={() => setStatusReasonTarget(null)}
        title={`إيقاف الموظف (${statusReasonTarget?.name ?? ''})`}
        consequence="سيُمنع جدولة أي مناوبة جديدة للموظف الموقوف ويُوثّق القرار في سجل التدقيق."
        minLength={5}
        confirmLabel="تأكيد الإيقاف"
        onConfirm={async (reason) => {
          if (!statusReasonTarget) return;
          await api(`/api/hr/employees/${statusReasonTarget.id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status: statusReasonTarget.status, reason }),
          });
          toast.success('تم تحديث حالة الموظف بسبب موثق');
          await loadAll();
        }}
      />

      <ReasonDialog
        open={!!revokeCredTarget}
        onClose={() => setRevokeCredTarget(null)}
        title={`سحب الترخيص المهني (${revokeCredTarget?.licenseNo ?? ''})`}
        consequence="سحب الترخيص إجراء نهائي غير قابل للتراجع ويمنع جدولة الممارس إذا لم يملك ترخيصًا بديلًا ساريًا."
        minLength={5}
        confirmLabel="تأكيد السحب النهائي"
        onConfirm={async (reason) => {
          if (!revokeCredTarget) return;
          await api(`/api/hr/credentials/${revokeCredTarget.id}/revoke`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
          toast.success('تم سحب الترخيص وتوثيق السبب');
          await loadAll();
        }}
      />

      <ReasonDialog
        open={!!cancelShiftTarget}
        onClose={() => setCancelShiftTarget(null)}
        title={`إلغاء المناوبة (${cancelShiftTarget?.label ?? ''})`}
        consequence="سيتم تحرير الفترة الزمنية وتوثيق سبب الإلغاء في السجل."
        minLength={5}
        confirmLabel="إلغاء المناوبة"
        onConfirm={async (reason) => {
          if (!cancelShiftTarget) return;
          await api(`/api/hr/shifts/${cancelShiftTarget.id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason }),
          });
          toast.success('أُلغيت المناوبة');
          await loadAll();
        }}
      />

      <ConfirmDialog
        open={!!approveLeaveTarget}
        onClose={() => setApproveLeaveTarget(null)}
        title={`اعتماد طلب الإجازة (${approveLeaveTarget?.request_no ?? ''})`}
        description="سيتم اعتماد الإجازة نهائيًا ومنع جدولة مناوبات للموظف خلال فترة الإجازة."
        summary={
          approveLeaveTarget && (
            <div>
              <p><b>الموظف:</b> {approveLeaveTarget.employee_name}</p>
              <p><b>الفترة:</b> {approveLeaveTarget.start_date} ← {approveLeaveTarget.end_date} ({approveLeaveTarget.days_count} يوم)</p>
            </div>
          )
        }
        confirmLabel="تأكيد الاعتماد"
        onConfirm={async () => {
          if (!approveLeaveTarget) return;
          await api(`/api/hr/leaves/${approveLeaveTarget.id}/review`, {
            method: 'POST',
            body: JSON.stringify({ decision: 'approved', note: 'معتمد وفق رصيد الإجازات وتغطية القسم' }),
          });
          toast.success('اعتُمد طلب الإجازة');
          await loadAll();
        }}
      />

      <ReasonDialog
        open={!!rejectLeaveTarget}
        onClose={() => setRejectLeaveTarget(null)}
        title={`رفض طلب الإجازة (${rejectLeaveTarget?.request_no ?? ''})`}
        consequence="يرجى تدوين سبب الرفض ليظهر للموظف في بوابته الذاتية وفي سجل التدقيق."
        label="سبب الرفض الإداري / التشغيلي"
        minLength={5}
        confirmLabel="تأكيد الرفض"
        onConfirm={async (note) => {
          if (!rejectLeaveTarget) return;
          await api(`/api/hr/leaves/${rejectLeaveTarget.id}/review`, {
            method: 'POST',
            body: JSON.stringify({ decision: 'rejected', note }),
          });
          toast.success('تم رفض طلب الإجازة مع توثيق السبب');
          await loadAll();
        }}
      />
    </div>
  );
}

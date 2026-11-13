import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  ErrorState,
  Input,
  Modal,
  PageHeader,
  PageSkeleton,
  SearchInput,
  Select,
  Tabs,
  useToast,
} from '../components';
import { useBootstrap } from '../hooks/useBootstrap';
import { useDebounce } from '../hooks/useDebounce';
import { formatDateTime } from '../lib/format';

type AdminTab = 'users' | 'roles' | 'sessions' | 'facilities';

export default function AdminPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const { data: boot } = useBootstrap();
  const canUsers = has(auth, 'admin.users.read');
  const canManageUsers = has(auth, 'admin.users.manage');
  const canSessions = has(auth, 'admin.sessions.manage');
  const canFacilities = has(auth, 'admin.facility.manage');

  const [tab, setTab] = useState<AdminTab>(() =>
    canUsers ? 'users' : canSessions ? 'sessions' : 'facilities',
  );
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 250);

  const [users, setUsers] = useState<any[]>([]);
  const [rolesData, setRolesData] = useState<{ roles: any[]; permissions: any[] }>({ roles: [], permissions: [] });
  const [sessions, setSessions] = useState<any[]>([]);
  const [facilities, setFacilities] = useState<{ items: any[]; stats: any[] }>({ items: [], stats: [] });

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeSessionId, setRevokeSessionId] = useState<string | null>(null);
  const [userForm, setUserForm] = useState({
    email: '',
    fullNameAr: '',
    fullNameEn: '',
    jobTitleAr: '',
    roleId: 'physician',
    departmentId: '',
    temporaryPassword: '',
  });

  const loadAll = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const tasks: Promise<unknown>[] = [];
      if (canUsers) {
        tasks.push(
          api<{ items: any[] }>(`/api/admin/users?search=${encodeURIComponent(debouncedSearch)}&limit=50`).then((r) =>
            setUsers(r.items ?? []),
          ),
        );
        tasks.push(
          api<{ roles: any[]; permissions: any[] }>('/api/admin/roles').then((r) => setRolesData(r)),
        );
      }
      if (canSessions) {
        tasks.push(
          api<{ items: any[] }>('/api/admin/sessions').then((r) => setSessions(r.items ?? [])),
        );
      }
      if (canFacilities) {
        tasks.push(
          api<{ items: any[]; stats: any[] }>('/api/admin/facilities').then((r) => setFacilities(r)),
        );
      }
      await Promise.all(tasks);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات الإدارة');
    } finally {
      setLoading(false);
    }
  }, [canUsers, canSessions, canFacilities, debouncedSearch]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          ...userForm,
          jobTitleAr: userForm.jobTitleAr || undefined,
          departmentId: userForm.departmentId || undefined,
        }),
      });
      toast.success('تم إنشاء حساب المستخدم وإسناد الدور للمنشأة النشطة');
      setCreateOpen(false);
      setUserForm({
        email: '',
        fullNameAr: '',
        fullNameEn: '',
        jobTitleAr: '',
        roleId: 'physician',
        departmentId: '',
        temporaryPassword: '',
      });
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'فشل إنشاء المستخدم');
    } finally {
      setBusy(false);
    }
  }

  async function toggleUserActive(u: any) {
    try {
      await api(`/api/admin/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !u.is_active }),
      });
      toast.success(u.is_active ? 'تم تعطيل الحساب وإبطال جلساته' : 'تم إعادة تفعيل الحساب');
      await loadAll();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر تحديث حالة المستخدم');
    }
  }

  if (err && users.length === 0 && sessions.length === 0) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && users.length === 0 && sessions.length === 0) return <PageSkeleton cards={4} rows={6} />;

  const tabItems: Array<{ key: AdminTab; label: string; count?: number }> = [
    ...(canUsers
      ? [
          { key: 'users' as const, label: 'المستخدمون', count: users.length },
          { key: 'roles' as const, label: 'الأدوار والصلاحيات', count: rolesData.roles.length },
        ]
      : []),
    ...(canSessions ? [{ key: 'sessions' as const, label: 'الجلسات النشطة', count: sessions.filter((s) => !s.revoked_at).length }] : []),
    ...(canFacilities ? [{ key: 'facilities' as const, label: 'المنشآت الصحية', count: facilities.items.length }] : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="إدارة النظام، المستخدمين، والجلسات"
        subtitle="التحكم في حسابات الممارسين، مصفوفة الصلاحيات السياقية (RBAC)، إبطال الجلسات، والمنشآت."
        actions={
          canManageUsers && tab === 'users' ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              + إنشاء مستخدم جديد
            </Button>
          ) : undefined
        }
      />

      <Tabs active={tab} onChange={setTab} items={tabItems} />

      {tab === 'users' && canUsers && (
        <Card title="حسابات المستخدمين في المنشأة النشطة">
          <div className="mb-3 max-w-md">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="ابحث بالاسم أو البريد الإلكتروني…"
            />
          </div>
          <DataTable
            caption="مستخدمو النظام"
            rows={users}
            rowKey={(u) => u.id}
            cardTitle={(u) => u.full_name_ar}
            cardSubtitle={(u) => `${u.email} · ${(u.roles ?? []).join(', ')}`}
            cardBadge={(u) => <Badge value={u.is_active ? 'active' : 'inactive'} />}
            cardActions={(u) =>
              canManageUsers && u.id !== auth.user.id ? (
                <Button variant="ghost" size="sm" onClick={() => toggleUserActive(u)}>
                  {u.is_active ? 'تعطيل الحساب' : 'تفعيل الحساب'}
                </Button>
              ) : null
            }
            columns={[
              {
                key: 'name',
                header: 'المستخدم',
                render: (u) => (
                  <div>
                    <span className="font-semibold">{u.full_name_ar}</span>
                    <span className="block text-xs text-slate-400">{u.job_title_ar ?? '—'}</span>
                  </div>
                ),
              },
              { key: 'email', header: 'البريد الإلكتروني', render: (u) => <span className="font-mono text-xs" dir="ltr">{u.email}</span> },
              {
                key: 'roles',
                header: 'الأدوار المسندة',
                render: (u) => (
                  <div className="flex flex-wrap gap-1">
                    {(u.roles ?? []).map((r: string) => (
                      <span key={r} className="font-mono text-[11px] bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                        {r}
                      </span>
                    ))}
                  </div>
                ),
              },
              {
                key: 'mfa',
                header: 'MFA',
                render: (u) => (u.mfa_enabled ? <Badge value="verified" label="مفعّل" /> : <span className="text-xs text-slate-400">غير مفعّل</span>),
              },
              { key: 'login', header: 'آخر دخول', render: (u) => <span className="text-xs">{formatDateTime(u.last_login_at)}</span> },
              { key: 'st', header: 'الحالة', render: (u) => <Badge value={u.is_active ? 'active' : 'inactive'} /> },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (u) =>
                  canManageUsers && u.id !== auth.user.id ? (
                    <Button variant="ghost" size="sm" onClick={() => toggleUserActive(u)}>
                      {u.is_active ? 'تعطيل' : 'تفعيل'}
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      )}

      {tab === 'roles' && canUsers && (
        <Card title="مصفوفة الأدوار الوظيفية والصلاحيات">
          <div className="grid md:grid-cols-2 gap-3">
            {rolesData.roles.map((r) => {
              const rolePerms = rolesData.permissions.filter((p) => p.role_id === r.id);
              return (
                <div key={r.id} className="border border-slate-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">{r.name_ar}</h3>
                      <p className="text-xs font-mono text-slate-400">{r.id}</p>
                    </div>
                    <span className="badge bg-brand-50 text-brand-800">{r.users} مستخدم</span>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                    {rolePerms.map((p) => (
                      <span
                        key={p.permission_code}
                        title={p.desc_ar}
                        className="text-[11px] font-mono bg-slate-50 text-slate-700 border border-slate-200 px-1.5 py-0.5 rounded"
                      >
                        {p.permission_code}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {tab === 'sessions' && canSessions && (
        <Card title="سجل الجلسات الأمنية وإبطالها الفوري">
          <DataTable
            caption="جلسات المستخدمين"
            rows={sessions}
            rowKey={(s) => s.id}
            cardTitle={(s) => s.full_name_ar}
            cardSubtitle={(s) => `${s.email} · IP: ${s.ip ?? '—'}`}
            cardBadge={(s) => <Badge value={s.revoked_at ? 'cancelled' : 'active'} label={s.revoked_at ? 'مُبطلة' : 'نشطة'} />}
            cardActions={(s) =>
              !s.revoked_at ? (
                <Button variant="danger" size="sm" onClick={() => setRevokeSessionId(s.id)}>
                  إبطال الجلسة
                </Button>
              ) : null
            }
            columns={[
              {
                key: 'user',
                header: 'المستخدم',
                render: (s) => (
                  <div>
                    <span className="font-semibold">{s.full_name_ar}</span>
                    <span className="block text-xs text-slate-400 font-mono" dir="ltr">{s.email}</span>
                  </div>
                ),
              },
              { key: 'ip', header: 'عنوان IP', render: (s) => <span className="font-mono text-xs" dir="ltr">{s.ip ?? '—'}</span> },
              { key: 'seen', header: 'آخر نشاط', render: (s) => <span className="text-xs">{formatDateTime(s.last_seen_at)}</span> },
              {
                key: 'st',
                header: 'الحالة',
                render: (s) => (
                  <div>
                    <Badge value={s.revoked_at ? 'cancelled' : 'active'} label={s.revoked_at ? 'مُبطلة' : 'نشطة'} />
                    {s.revoked_reason && <span className="block text-[11px] text-slate-500 mt-0.5">{s.revoked_reason}</span>}
                  </div>
                ),
              },
              {
                key: 'act',
                header: 'إجراء',
                hideInCard: true,
                render: (s) =>
                  !s.revoked_at ? (
                    <Button variant="danger" size="sm" onClick={() => setRevokeSessionId(s.id)}>
                      إبطال
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      )}

      {tab === 'facilities' && canFacilities && (
        <Card title="المنشآت الصحية المسجلة وعزل المستأجرين (RLS)">
          <div className="grid md:grid-cols-2 gap-3">
            {facilities.items.map((f) => {
              const stat = facilities.stats.find((s) => s.facility_id === f.id);
              return (
                <div key={f.id} className="border border-slate-200 rounded-xl p-4 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-slate-900">{f.name_ar}</h3>
                    <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">{f.code}</span>
                  </div>
                  <p className="text-xs text-slate-500">{f.name_en} · المدينة: {f.city ?? '—'}</p>
                  <p className="text-xs font-semibold text-brand-800">
                    عدد المستخدمين المخوّلين: {stat?.users ?? 0}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Create User Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="إنشاء حساب مستخدم جديد"
        description="سيُنشأ الحساب مع إلزام تغيير كلمة المرور عند الدخول الأول وإسناد الدور للمنشأة النشطة."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              إلغاء
            </Button>
            <Button type="submit" form="create-user-form" variant="primary" busy={busy}>
              إنشاء الحساب
            </Button>
          </>
        }
      >
        <form id="create-user-form" onSubmit={createUser} className="grid sm:grid-cols-2 gap-3">
          <Input
            label="الاسم الكامل بالعربية"
            required
            value={userForm.fullNameAr}
            onChange={(e) => setUserForm({ ...userForm, fullNameAr: e.target.value })}
          />
          <Input
            label="الاسم بالإنجليزية"
            required
            dir="ltr"
            value={userForm.fullNameEn}
            onChange={(e) => setUserForm({ ...userForm, fullNameEn: e.target.value })}
          />
          <Input
            label="البريد الإلكتروني"
            type="email"
            required
            dir="ltr"
            value={userForm.email}
            onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
          />
          <Input
            label="المسمى الوظيفي"
            value={userForm.jobTitleAr}
            onChange={(e) => setUserForm({ ...userForm, jobTitleAr: e.target.value })}
          />
          <Select
            label="الدور الوظيفي"
            required
            value={userForm.roleId}
            onChange={(e) => setUserForm({ ...userForm, roleId: e.target.value })}
          >
            {rolesData.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name_ar} ({r.id})
              </option>
            ))}
          </Select>
          <Select
            label="القسم (اختياري)"
            value={userForm.departmentId}
            onChange={(e) => setUserForm({ ...userForm, departmentId: e.target.value })}
          >
            <option value="">— بدون قسم محدد —</option>
            {(boot?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name_ar}
              </option>
            ))}
          </Select>
          <div className="sm:col-span-2">
            <Input
              label="كلمة المرور المؤقتة (12 حرفًا على الأقل)"
              type="password"
              required
              minLength={12}
              dir="ltr"
              value={userForm.temporaryPassword}
              onChange={(e) => setUserForm({ ...userForm, temporaryPassword: e.target.value })}
            />
          </div>
        </form>
      </Modal>

      {/* Confirm Session Revoke */}
      <ConfirmDialog
        open={!!revokeSessionId}
        onClose={() => setRevokeSessionId(null)}
        title="إبطال الجلسة الأمنية"
        description="سيتم إخراج المستخدم من هذه الجلسة فورًا وتسجيل عملية الإبطال الإداري في سجل التدقيق."
        confirmLabel="تأكيد إبطال الجلسة"
        variant="danger"
        onConfirm={async () => {
          if (!revokeSessionId) return;
          await api(`/api/admin/sessions/${revokeSessionId}/revoke`, { method: 'POST' });
          toast.success('تم إبطال الجلسة بنجاح');
          await loadAll();
        }}
      />
    </div>
  );
}

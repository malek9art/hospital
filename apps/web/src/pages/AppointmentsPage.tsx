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
  SearchInput,
  Select,
  useToast,
} from '../components';
import { useBootstrap } from '../hooks/useBootstrap';
import { formatDateTime } from '../lib/format';

export default function AppointmentsPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const { data: boot } = useBootstrap();
  const [items, setItems] = useState<any[]>([]);
  const [patients, setPatients] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    patientId: '',
    departmentId: '',
    doctorId: '',
    scheduledAt: '',
  });

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setErr(null);
    Promise.all([
      api<{ items: any[] }>('/api/appointments?limit=50', { signal }),
      has(auth, 'patient.read')
        ? api<{ items: any[] }>('/api/patients?limit=100', { signal })
        : Promise.resolve({ items: [] }),
    ])
      .then(([a, p]) => {
        setItems(a.items ?? []);
        setPatients(p.items ?? []);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setErr(e.message);
      })
      .finally(() => setLoading(false));
  }, [auth]);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  async function book(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ appointmentNo: string }>('/api/appointments', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          scheduledAt: new Date(form.scheduledAt).toISOString(),
        }),
      });
      toast.success(`تم حجز الموعد ${r.appointmentNo}`);
      setForm({ ...form, patientId: '', scheduledAt: '' });
      load();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر حجز الموعد');
    } finally {
      setBusy(false);
    }
  }

  async function checkin(id: string) {
    try {
      await api(`/api/appointments/${id}/check-in`, { method: 'POST' });
      toast.success('تم تسجيل حضور المريض');
      load();
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : 'تعذّر تسجيل الحضور');
    }
  }

  if (err && items.length === 0) return <ErrorState message={err} onRetry={() => load()} />;
  if (loading && items.length === 0) return <PageSkeleton cards={2} rows={6} />;

  const filtered = items.filter((a) => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      String(a.appointmentNo ?? '').toLowerCase().includes(q) ||
      String(a.patientName ?? '').toLowerCase().includes(q) ||
      String(a.mrn ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="المواعيد والاستقبال"
        subtitle="حجز المواعيد في العيادات الخارجية ومنع تعارض جدول الطبيب تلقائيًا."
      />

      {has(auth, 'appointment.create') && boot && (
        <Card title="حجز موعد جديد">
          <form onSubmit={book} className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <Select
              label="المريض"
              required
              value={form.patientId}
              onChange={(e) => setForm({ ...form, patientId: e.target.value })}
            >
              <option value="">— اختر المريض —</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullNameAr} · {p.mrn}
                </option>
              ))}
            </Select>
            <Select
              label="القسم"
              required
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
            >
              <option value="">— اختر القسم —</option>
              {boot.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name_ar}
                </option>
              ))}
            </Select>
            <Select
              label="الطبيب المعالج"
              required
              value={form.doctorId}
              onChange={(e) => setForm({ ...form, doctorId: e.target.value })}
            >
              <option value="">— اختر الطبيب —</option>
              {boot.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name_ar}
                </option>
              ))}
            </Select>
            <Input
              label="تاريخ ووقت الموعد"
              type="datetime-local"
              required
              value={form.scheduledAt}
              onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
            />
            <div className="flex items-end">
              <Button type="submit" variant="primary" className="w-full" busy={busy}>
                تأكيد الحجز
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="جدول المواعيد">
        <div className="flex flex-wrap gap-3 mb-3">
          <div className="flex-1 min-w-[220px] max-w-md">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="ابحث برقم الموعد، اسم المريض، أو MRN…"
            />
          </div>
          <Select
            aria-label="تصفية حسب الحالة"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="!w-44"
          >
            <option value="all">كل الحالات</option>
            <option value="booked">محجوز</option>
            <option value="checked_in">حضر</option>
            <option value="in_consultation">في الاستشارة</option>
            <option value="completed">مكتمل</option>
            <option value="cancelled">ملغى</option>
          </Select>
        </div>

        <DataTable
          caption="قائمة المواعيد"
          rows={filtered}
          rowKey={(a) => a.id}
          emptyTitle="لا توجد مواعيد مطابقة"
          cardTitle={(a) => a.patientName}
          cardSubtitle={(a) => `${a.appointmentNo} · ${a.department} · ${a.doctor}`}
          cardBadge={(a) => <Badge value={a.status} />}
          cardActions={(a) =>
            a.status === 'booked' && has(auth, 'appointment.checkin') ? (
              <Button variant="primary" size="sm" onClick={() => checkin(a.id)}>
                تسجيل حضور
              </Button>
            ) : null
          }
          columns={[
            { key: 'no', header: 'رقم الموعد', render: (a) => <span className="font-mono text-xs">{a.appointmentNo}</span> },
            {
              key: 'patient',
              header: 'المريض',
              render: (a) => (
                <div>
                  <span className="font-semibold">{a.patientName}</span>
                  <span className="block text-xs text-slate-400 font-mono">{a.mrn}</span>
                </div>
              ),
            },
            { key: 'dept', header: 'القسم', render: (a) => a.department },
            { key: 'doc', header: 'الطبيب', render: (a) => a.doctor },
            { key: 'time', header: 'الموعد', render: (a) => formatDateTime(a.scheduledAt) },
            { key: 'st', header: 'الحالة', render: (a) => <Badge value={a.status} /> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (a) =>
                a.status === 'booked' && has(auth, 'appointment.checkin') ? (
                  <Button variant="ghost" size="sm" onClick={() => checkin(a.id)}>
                    تسجيل حضور
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
    </div>
  );
}

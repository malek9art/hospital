import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  Pagination,
} from '../components';
import { formatDateTime } from '../lib/format';

export default function AuditPage() {
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAtId?: number } | null>(null);
  const [filters, setFilters] = useState({ action: '', from: '', to: '' });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const limit = 25;

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (filters.action.trim()) qs.set('action', filters.action.trim());
      if (filters.from) qs.set('from', filters.from);
      if (filters.to) qs.set('to', filters.to);
      const res = await api<{ items: any[]; total: number }>(`/api/audit?${qs.toString()}`);
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل سجل التدقيق');
    } finally {
      setLoading(false);
    }
  }, [page, filters.action, filters.from, filters.to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ ok: boolean; checked: number; brokenAtId?: number }>('/api/audit/verify')
      .then(setVerify)
      .catch(() => {});
  }, []);

  if (err && items.length === 0) return <ErrorState message={err} onRetry={load} />;
  if (loading && items.length === 0) return <PageSkeleton cards={2} rows={8} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="سجل التدقيق الأمني والسريري (Audit Trail)"
        subtitle="سجل غير قابل للتعديل أو الحذف محمي بمشغّل قاعدة بيانات وسلسلة تجزئة SHA-256 مترابطة."
      />

      {verify && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm font-semibold flex items-center justify-between ${
            verify.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span>
            {verify.ok
              ? `✓ سلسلة تجزئة التدقيق سليمة ومتصلة بالكامل (تم فحص ${verify.checked} سجلًا)`
              : `⚠ تحذير: انقطاع في سلسلة التجزئة عند السجل رقم ${verify.brokenAtId}`}
          </span>
          <Badge value={verify.ok ? 'verified' : 'failed'} label={verify.ok ? 'متحقق منه' : 'تلاعب محتمل'} />
        </div>
      )}

      <Card title="تصفية واستعراض الأحداث">
        <div className="flex flex-wrap gap-3 items-end mb-4">
          <div className="min-w-[220px]">
            <Input
              label="نوع الإجراء (Action)"
              placeholder="مثال: auth.login أو patient"
              dir="ltr"
              value={filters.action}
              onChange={(e) => {
                setPage(1);
                setFilters({ ...filters, action: e.target.value });
              }}
            />
          </div>
          <Input
            label="من تاريخ"
            type="date"
            value={filters.from}
            onChange={(e) => {
              setPage(1);
              setFilters({ ...filters, from: e.target.value });
            }}
          />
          <Input
            label="إلى تاريخ"
            type="date"
            value={filters.to}
            onChange={(e) => {
              setPage(1);
              setFilters({ ...filters, to: e.target.value });
            }}
          />
          <Button
            variant="ghost"
            onClick={() => {
              setPage(1);
              setFilters({ action: '', from: '', to: '' });
            }}
          >
            مسح التصفية
          </Button>
        </div>

        <DataTable
          caption="سجل أحداث التدقيق"
          rows={items}
          rowKey={(a) => a.id}
          emptyTitle="لا توجد أحداث مطابقة لمعايير البحث"
          cardTitle={(a) => a.action}
          cardSubtitle={(a) => `${a.actor_name ?? 'النظام'} · ${formatDateTime(a.created_at)}`}
          cardBadge={(a) => <Badge value={a.outcome === 'success' ? 'verified' : 'cancelled'} label={a.outcome} />}
          columns={[
            { key: 'time', header: 'التوقيت', render: (a) => <span className="text-xs">{formatDateTime(a.created_at)}</span> },
            { key: 'actor', header: 'المستخدم المنفّذ', render: (a) => a.actor_name ?? '—' },
            { key: 'act', header: 'الإجراء', render: (a) => <span className="font-mono text-xs">{a.action}</span> },
            {
              key: 'ent',
              header: 'الكيان المتأثر',
              render: (a) => (
                <span className="text-xs font-mono">
                  {a.entity_type ?? '—'} {a.entity_id ? `/ ${String(a.entity_id).slice(0, 8)}` : ''}
                </span>
              ),
            },
            {
              key: 'out',
              header: 'النتيجة',
              render: (a) => (
                <Badge
                  value={a.outcome === 'success' ? 'verified' : 'cancelled'}
                  label={a.outcome === 'success' ? 'نجاح' : a.outcome}
                />
              ),
            },
            { key: 'rsn', header: 'السبب الموثّق', render: (a) => <span className="text-xs">{a.reason ?? '—'}</span> },
          ]}
        />

        <Pagination page={page} limit={limit} total={total} onPageChange={setPage} />
      </Card>
    </div>
  );
}

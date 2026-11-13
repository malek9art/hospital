import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Card, EmptyState, ErrorState, PageHeader, PageSkeleton } from '../components';
import { formatDateTime, formatMoney } from '../lib/format';

export default function PortalPage() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    api('/api/portal/summary')
      .then(setD)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (err) return <ErrorState message={err} onRetry={load} />;
  if (loading || !d) return <PageSkeleton cards={4} rows={4} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`بوابة المريض الذاتية — ${d.patient?.full_name_ar ?? ''}`}
        subtitle={d.notice}
      />

      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="مواعيدي القادمة والسابقة">
          {(d.appointments ?? []).length === 0 ? (
            <EmptyState title="لا توجد مواعيد مسجلة" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.appointments.map((a: any) => (
                <li key={a.id} className="py-2 flex items-center justify-between gap-2">
                  <span>
                    {formatDateTime(a.scheduled_at)} — {a.department} ({a.doctor})
                  </span>
                  <Badge value={a.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="نتائج المختبر المعتمدة فقط">
          {(d.results ?? []).length === 0 ? (
            <EmptyState title="لا توجد نتائج معتمدة متاحة للعرض حاليًا" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.results.map((r: any) => (
                <li key={r.id} className="py-2 flex items-center justify-between gap-2">
                  <span>
                    <b>{r.test_name}:</b> {r.value_numeric ?? r.value_text} {r.unit}
                  </span>
                  {r.flag && r.flag !== 'normal' && <Badge value={r.flag} />}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="الوصفات الطبية">
          {(d.prescriptions ?? []).length === 0 ? (
            <EmptyState title="لا توجد وصفات طبية" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.prescriptions.map((p: any) => (
                <li key={p.prescription_no} className="py-2 flex items-center justify-between">
                  <span className="font-mono text-xs">{p.prescription_no}</span>
                  <Badge value={p.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="الفواتير والمدفوعات">
          {(d.invoices ?? []).length === 0 ? (
            <EmptyState title="لا توجد فواتير" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.invoices.map((i: any) => (
                <li key={i.invoice_no} className="py-2 flex items-center justify-between">
                  <span>
                    <span className="font-mono text-xs">{i.invoice_no}</span> — {formatMoney(i.total)}
                  </span>
                  <Badge value={i.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

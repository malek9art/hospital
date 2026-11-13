import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  PageSkeleton,
  PrintHeader,
  Select,
  useToast,
} from '../components';

export default function ReportsPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [reports, setReports] = useState<any[]>([]);
  const [key, setKey] = useState('visits');
  const [data, setData] = useState<any>(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ reports: any[] }>('/api/reports')
      .then((r) => setReports(r.reports ?? []))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (range.from) qs.set('from', range.from);
      if (range.to) qs.set('to', range.to);
      setData(await api(`/api/reports/${key}?${qs.toString()}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل التقرير');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [key, range.from, range.to]);

  useEffect(() => {
    load();
  }, [key]);

  async function downloadCsv() {
    try {
      const qs = new URLSearchParams({ format: 'csv' });
      if (range.from) qs.set('from', range.from);
      if (range.to) qs.set('to', range.to);
      const res = await fetch(`/api/reports/${key}?${qs.toString()}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? 'فشل تصدير ملف CSV');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hms-${key}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('تم تصدير ملف CSV وتوثيق العملية في سجل التدقيق');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر التصدير');
    }
  }

  if (err && !data) return <ErrorState message={err} onRetry={load} />;
  if (loading && !data) return <PageSkeleton cards={2} rows={6} />;

  const activeFacility = auth.facilities.find((f) => f.id === auth.activeFacilityId);

  return (
    <div className="space-y-4">
      <div className="no-print">
        <PageHeader
          title="التقارير التشغيلية والمالية والسريرية"
          subtitle="تقارير مستخرجة مباشرة من قاعدة البيانات مع تدقيق عمليات التصدير."
        />
      </div>

      <Card title="معايير التقرير" className="no-print">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="min-w-[220px]">
            <Select label="نوع التقرير" value={key} onChange={(e) => setKey(e.target.value)}>
              {reports.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.ar}
                </option>
              ))}
            </Select>
          </div>
          <Input
            label="من تاريخ"
            type="date"
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
          <Input
            label="إلى تاريخ"
            type="date"
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
          <Button variant="ghost" onClick={load}>
            تحديث البيانات
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>
            طباعة التقرير
          </Button>
          {has(auth, 'report.export') && (
            <Button variant="primary" onClick={downloadCsv}>
              تصدير CSV (مُدقَّق)
            </Button>
          )}
        </div>
        {!has(auth, 'report.export') && (
          <p className="text-xs text-slate-500 mt-2">وضع العرض فقط — دورك الحالي لا يملك صلاحية تصدير CSV.</p>
        )}
      </Card>

      {data && (
        <div className="print-sheet">
          <PrintHeader
            facilityName={activeFacility?.name_ar}
            documentTitle={data.title}
            documentNo={`RPT-${key.toUpperCase()}`}
          />
          <Card title={`${data.title} · إجمالي ${data.total} صف`}>
            {data.rows.length === 0 ? (
              <EmptyState title="لا توجد بيانات مطابقة للفترة الزمنية المحددة" />
            ) : (
              <div className="overflow-x-auto max-h-[540px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr>
                      {data.columns.map((c: any) => (
                        <th key={c.key} className="th">
                          {c.ar}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r: any, idx: number) => (
                      <tr key={idx}>
                        {data.columns.map((c: any) => (
                          <td key={c.key} className="td whitespace-nowrap">
                            {r[c.key] ?? '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

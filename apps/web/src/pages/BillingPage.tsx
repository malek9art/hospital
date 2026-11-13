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
  PrintHeader,
  Select,
  StatCard,
  useToast,
} from '../components';
import { navigate } from '../hooks/useHashRoute';
import { formatMoney } from '../lib/format';

export default function BillingPage({ auth, routeId }: { auth: Me; routeId: string | null }) {
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState({ amount: '', method: 'cash' });

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, b] = await Promise.all([
        api<any>('/api/billing/invoices?limit=50'),
        api<any>('/api/billing/summary'),
      ]);
      setItems(a.items ?? []);
      setSummary(b);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل بيانات الفوترة');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link support: #/billing/:invoiceId
  useEffect(() => {
    if (!routeId) {
      setDetail(null);
      return;
    }
    api(`/api/billing/invoices/${routeId}`)
      .then((d: any) => {
        setDetail(d);
        const rem = Math.max(0, Number(d.invoice.total) - Number(d.invoice.paid_amount));
        setPay((p) => ({ ...p, amount: rem > 0 ? String(rem) : '' }));
      })
      .catch((e: Error) => toast.error(e.message));
  }, [routeId, toast]);

  async function collect() {
    if (!detail) return;
    setBusy(true);
    try {
      await api(`/api/billing/invoices/${detail.invoice.id}/payments`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ amount: Number(pay.amount), method: pay.method }),
      });
      toast.success('تم تسجيل الدفعة المالية وتحديث رصيد الفاتورة');
      const fresh = await api<any>(`/api/billing/invoices/${detail.invoice.id}`);
      setDetail(fresh);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'فشل تسجيل الدفعة');
    } finally {
      setBusy(false);
    }
  }

  if (err && items.length === 0) return <ErrorState message={err} onRetry={load} />;
  if (loading && items.length === 0) return <PageSkeleton cards={4} rows={6} />;

  const activeFacility = auth.facilities.find((f) => f.id === auth.activeFacilityId);

  return (
    <div className="space-y-4">
      <div className="no-print">
        <PageHeader
          title="الفوترة والتحصيل المالي"
          subtitle="إدارة الفواتير والدفعات النقدية والبطاقات بحماية مفاتيح منع التكرار. (بدون ربط نفيس أو فوترة ZATCA)"
        />
      </div>

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 no-print">
          <StatCard label="إجمالي فواتير اليوم" value={formatMoney(summary.today_billed)} />
          <StatCard label="المحصّل الفعلي اليوم" value={formatMoney(summary.today_collected)} tone="success" />
          <StatCard label="ذمم مستحقة غير محصّلة" value={formatMoney(summary.outstanding)} tone="warning" />
          <StatCard label="فواتير مفتوحة" value={summary.open_invoices} />
        </div>
      )}

      <Card title="سجل الفواتير" className="no-print">
        <DataTable
          caption="جدول الفواتير"
          rows={items}
          rowKey={(i) => i.id}
          emptyTitle="لا توجد فواتير مسجلة"
          cardTitle={(i) => `${i.invoice_no} — ${i.patient_name}`}
          cardSubtitle={(i) => `الإجمالي: ${formatMoney(i.total)} · المدفوع: ${formatMoney(i.paid_amount)}`}
          cardBadge={(i) => <Badge value={i.status} />}
          cardActions={(i) => (
            <Button variant="primary" size="sm" onClick={() => navigate(`#/billing/${i.id}`)}>
              تفاصيل الفاتورة
            </Button>
          )}
          columns={[
            { key: 'no', header: 'رقم الفاتورة', render: (i) => <span className="font-mono text-xs">{i.invoice_no}</span> },
            {
              key: 'pt',
              header: 'المريض',
              render: (i) => (
                <div>
                  <span className="font-semibold">{i.patient_name}</span>
                  <span className="block text-xs text-slate-400 font-mono">{i.mrn}</span>
                </div>
              ),
            },
            { key: 'tot', header: 'الإجمالي', render: (i) => <span className="font-semibold">{formatMoney(i.total)}</span> },
            { key: 'paid', header: 'المدفوع', render: (i) => formatMoney(i.paid_amount) },
            { key: 'st', header: 'الحالة', render: (i) => <Badge value={i.status} /> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (i) => (
                <Button variant="ghost" size="sm" onClick={() => navigate(`#/billing/${i.id}`)}>
                  تفاصيل وطباعة
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {detail && (
        <div className="print-sheet">
          <PrintHeader
            facilityName={activeFacility?.name_ar}
            documentTitle={`فاتورة خدمات طبية — ${detail.invoice.patient_name ?? ''}`}
            documentNo={detail.invoice.invoice_no}
          />
          <Card
            title={`تفاصيل الفاتورة ${detail.invoice.invoice_no}`}
            action={
              <div className="flex gap-2 no-print">
                <Button variant="ghost" size="sm" onClick={() => window.print()}>
                  طباعة الفاتورة
                </Button>
                <Button variant="ghost" size="sm" onClick={() => navigate('#/billing')}>
                  إغلاق
                </Button>
              </div>
            }
          >
            <DataTable
              caption="بنود الفاتورة"
              rows={detail.items ?? []}
              rowKey={(it: any) => it.id}
              cardTitle={(it: any) => it.description}
              cardSubtitle={(it: any) => `${it.category} · ${it.quantity} × ${formatMoney(it.unit_price)}`}
              cardBadge={(it: any) => <span className="font-bold text-xs">{formatMoney(it.line_total)}</span>}
              columns={[
                { key: 'desc', header: 'الخدمة / البند', render: (it: any) => it.description },
                { key: 'cat', header: 'الفئة', render: (it: any) => it.category },
                { key: 'qty', header: 'الكمية', render: (it: any) => it.quantity },
                { key: 'unit', header: 'سعر الوحدة', render: (it: any) => formatMoney(it.unit_price) },
                { key: 'tot', header: 'الإجمالي', render: (it: any) => <span className="font-semibold">{formatMoney(it.line_total)}</span> },
              ]}
            />

            <div className="mt-4 pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm space-x-3 space-x-reverse">
                <span>
                  الإجمالي: <b>{formatMoney(detail.invoice.total)}</b>
                </span>
                <span>·</span>
                <span>
                  المدفوع: <b className="text-emerald-700">{formatMoney(detail.invoice.paid_amount)}</b>
                </span>
                <span>·</span>
                <span>
                  المتبقي:{' '}
                  <b className="text-rose-700">
                    {formatMoney(Number(detail.invoice.total) - Number(detail.invoice.paid_amount))}
                  </b>
                </span>
              </div>
              <Badge value={detail.invoice.status} />
            </div>

            {detail.invoice.status !== 'paid' && detail.invoice.status !== 'void' && has(auth, 'billing.payment.record') && (
              <div className="flex flex-wrap items-end gap-2 mt-4 pt-3 border-t border-slate-100 no-print">
                <div className="w-40">
                  <Input
                    label="مبلغ الدفعة (SAR)"
                    type="number"
                    step="0.01"
                    value={pay.amount}
                    onChange={(e) => setPay({ ...pay, amount: e.target.value })}
                  />
                </div>
                <div className="w-40">
                  <Select
                    label="طريقة الدفع"
                    value={pay.method}
                    onChange={(e) => setPay({ ...pay, method: e.target.value })}
                  >
                    <option value="cash">نقدي</option>
                    <option value="card">بطاقة مدى / ائتمان</option>
                    <option value="transfer">تحويل بنكي</option>
                    <option value="insurance">تغطية تأمينية</option>
                  </Select>
                </div>
                <Button variant="primary" busy={busy} disabled={!pay.amount || Number(pay.amount) <= 0} onClick={collect}>
                  تسجيل التحصيل
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

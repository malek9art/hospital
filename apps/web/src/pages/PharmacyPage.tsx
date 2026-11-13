import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  PageHeader,
  PageSkeleton,
  ReasonDialog,
  useToast,
} from '../components';

export default function PharmacyPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api<any>('/api/pharmacy/prescriptions');
      setItems(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل الوصفات الطبية');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openRx(id: string) {
    try {
      setDetail(await api(`/api/pharmacy/prescriptions/${id}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر فتح الوصفة');
    }
  }

  async function executeDispense(overrideReason?: string) {
    if (!detail) return;
    setBusy(true);
    try {
      const pending = detail.items
        .filter((i: any) => i.status === 'pending')
        .map((i: any) => ({ itemId: i.id, quantity: Number(i.quantity) }));
      await api('/api/pharmacy/dispense', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          prescriptionId: detail.prescription.id,
          items: pending,
          acknowledgedWarnings: detail.warnings.length > 0,
          overrideReason: overrideReason || undefined,
        }),
      });
      toast.success('تم صرف الأدوية وخصم المخزون بنظام FEFO بمعاملة ذرية واحدة');
      setDetail(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'فشل صرف الوصفة');
      throw e;
    } finally {
      setBusy(false);
    }
  }

  if (err && items.length === 0) return <ErrorState message={err} onRetry={load} />;
  if (loading && items.length === 0) return <PageSkeleton cards={2} rows={6} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="الصيدلية وصرف الوصفات الطبية"
        subtitle="فحص الحساسية والتداخلات الدوائية، الصرف وفق الأقرب انتهاءً (FEFO)، وحماية منع التكرار (Idempotency)."
      />

      <Card title="الوصفات الطبية بانتظار المراجعة والصرف">
        <DataTable
          caption="قائمة الوصفات الطبية"
          rows={items}
          rowKey={(p) => p.id}
          emptyTitle="لا توجد وصفات معلّقة حاليًا"
          cardTitle={(p) => p.patient_name}
          cardSubtitle={(p) => `${p.prescription_no} · د. ${p.prescriber}`}
          cardBadge={(p) => <Badge value={p.status} />}
          cardActions={(p) => (
            <Button variant="primary" size="sm" onClick={() => openRx(p.id)}>
              مراجعة وصرف
            </Button>
          )}
          columns={[
            { key: 'no', header: 'رقم الوصفة', render: (p) => <span className="font-mono text-xs">{p.prescription_no}</span> },
            { key: 'pt', header: 'المريض', render: (p) => <span className="font-semibold">{p.patient_name}</span> },
            { key: 'doc', header: 'الطبيب الواصف', render: (p) => p.prescriber },
            { key: 'st', header: 'الحالة', render: (p) => <Badge value={p.status} /> },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (p) => (
                <Button variant="ghost" size="sm" onClick={() => openRx(p.id)}>
                  مراجعة وصرف
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {detail && (
        <Card
          title={`مراجعة وصرف الوصفة ${detail.prescription.prescription_no} — ${detail.prescription.patient_name}`}
          action={
            <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
              إغلاق
            </Button>
          }
        >
          {detail.warnings.length > 0 && (
            <div role="alert" className="bg-rose-50 border border-rose-200 p-3 rounded-xl mb-3 text-sm text-rose-900 space-y-1">
              <p className="font-bold text-xs">تنبيهات سلامة دوائية تتطلب توثيق مبرر الصيدلي قبل الصرف:</p>
              {detail.warnings.map((w: any, i: number) => (
                <p key={i} className="text-xs">
                  ⚠ {w.message}
                </p>
              ))}
            </div>
          )}

          <DataTable
            caption="بنود الوصفة"
            rows={detail.items ?? []}
            rowKey={(i: any) => i.id}
            cardTitle={(i: any) => i.drug_name}
            cardSubtitle={(i: any) => `${i.dose} — ${i.frequency} · الكمية: ${i.quantity}`}
            cardBadge={(i: any) => <Badge value={i.status} />}
            columns={[
              { key: 'drug', header: 'الدواء', render: (i: any) => <span className="font-semibold">{i.drug_name}</span> },
              { key: 'dose', header: 'الجرعة والتكرار', render: (i: any) => `${i.dose} — ${i.frequency}` },
              { key: 'qty', header: 'الكمية', render: (i: any) => i.quantity },
              { key: 'st', header: 'الحالة', render: (i: any) => <Badge value={i.status} /> },
            ]}
          />

          {has(auth, 'pharmacy.dispense') && detail.items.some((i: any) => i.status === 'pending') && (
            <div className="mt-4">
              <Button
                variant="primary"
                busy={busy}
                onClick={() => {
                  if (detail.warnings.length > 0) {
                    setOverrideOpen(true);
                  } else {
                    executeDispense().catch(() => {});
                  }
                }}
              >
                صرف البنود المعلّقة (FEFO + معاملة ذرية)
              </Button>
            </div>
          )}
        </Card>
      )}

      <ReasonDialog
        open={overrideOpen}
        onClose={() => setOverrideOpen(false)}
        title="توثيق مبرر الصرف مع وجود تنبيه دوائي"
        consequenceNote="تحتوي هذه الوصفة على تنبيه حساسية أو تداخل دوائي؛ يشترط توثيق مراجعة الصيدلي والطبيب قبل إتمام الصرف."
        label="مبرر التجاوز الصيدلاني"
        placeholder="مثال: تمت مراجعة الطبيب المعالج وتعديل المراقبة السريرية…"
        minLength={5}
        confirmLabel="تأكيد التجاوز والصرف"
        variant="danger"
        onConfirm={async (reason) => {
          await executeDispense(reason);
        }}
      />
    </div>
  );
}

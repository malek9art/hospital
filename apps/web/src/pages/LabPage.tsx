import { useCallback, useEffect, useState } from 'react';
import { api, has, type Me } from '../api';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  PageSkeleton,
  PollingControl,
  ReasonDialog,
  Select,
  useToast,
} from '../components';
import { usePolling } from '../hooks/usePolling';
import { formatDateTime } from '../lib/format';

export default function LabPage({ auth }: { auth: Me }) {
  const toast = useToast();
  const [status, setStatus] = useState('all');
  const [items, setItems] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ackTarget, setAckTarget] = useState<{ id: string; message: string } | null>(null);

  const canAck = has(auth, 'lab.critical.ack');

  const loadAll = useCallback(async () => {
    setErr(null);
    try {
      const [wl, al] = await Promise.all([
        api<any>(`/api/lab/worklist?status=${status}`),
        canAck ? api<any>('/api/lab/alerts') : Promise.resolve({ items: [] }),
      ]);
      setItems(wl.items ?? []);
      setAlerts(al.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'تعذّر تحميل قائمة المختبر');
    } finally {
      setLoading(false);
    }
  }, [status, canAck]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const polling = usePolling(loadAll, { intervalMs: 25_000, enabled: true });

  async function act(path: string, body: unknown, msg: string) {
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      toast.success(msg);
      await loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'تعذّر تنفيذ الإجراء');
    }
  }

  if (err && items.length === 0) return <ErrorState message={err} onRetry={loadAll} />;
  if (loading && items.length === 0) return <PageSkeleton cards={2} rows={6} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="المختبر الطبي وقائمة العمل"
        subtitle="جمع العينات، إدخال النتائج، فصل مهام الاعتماد (SoD)، وتنبيهات القيم الحرجة."
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

      <Card
        title="قائمة عمل التحاليل المخبرية"
        action={
          <Select
            aria-label="تصفية حالة التحاليل"
            className="!w-44"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">كل الحالات</option>
            <option value="ordered">بانتظار العينة</option>
            <option value="collected">بانتظار النتيجة</option>
            <option value="resulted">بانتظار الاعتماد</option>
            <option value="verified">معتمدة</option>
          </Select>
        }
      >
        <DataTable
          caption="قائمة عمل التحاليل المخبرية"
          rows={items}
          rowKey={(i) => i.id}
          emptyTitle="لا توجد تحاليل مطابقة لحالة التصفية"
          cardTitle={(i) => `${i.test_name} (${i.test_code})`}
          cardSubtitle={(i) => `${i.order_no} · ${i.patient_name} (${i.mrn})`}
          cardBadge={(i) => <Badge value={i.status} />}
          cardActions={(i) => (
            <div className="flex flex-wrap gap-1.5 items-center">
              {i.status === 'ordered' && has(auth, 'lab.sample.collect') && (
                <Button variant="ghost" size="sm" onClick={() => act(`/api/lab/items/${i.id}/collect`, {}, 'تم جمع العينة')}>
                  جمع عينة
                </Button>
              )}
              {i.status === 'collected' && has(auth, 'lab.result.enter') && (
                <div className="flex gap-1.5">
                  <input
                    aria-label="قيمة التحليل"
                    className="input !w-24 text-xs"
                    type="number"
                    step="0.01"
                    placeholder="القيمة"
                    value={values[i.id] ?? ''}
                    onChange={(e) => setValues({ ...values, [i.id]: e.target.value })}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!values[i.id]}
                    onClick={() => act(`/api/lab/items/${i.id}/result`, { valueNumeric: Number(values[i.id]) }, 'تم حفظ النتيجة')}
                  >
                    حفظ
                  </Button>
                </div>
              )}
              {i.status === 'resulted' && has(auth, 'lab.result.verify') && (
                <Button variant="primary" size="sm" onClick={() => act(`/api/lab/items/${i.id}/verify`, {}, 'تم اعتماد النتيجة المخبرية')}>
                  اعتماد
                </Button>
              )}
            </div>
          )}
          columns={[
            { key: 'no', header: 'الطلب', render: (i) => <span className="font-mono text-xs">{i.order_no}</span> },
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
            {
              key: 'test',
              header: 'التحليل',
              render: (i) => (
                <div>
                  <span>{i.test_name}</span>
                  <span className="block text-xs text-slate-400 font-mono">{i.test_code}</span>
                </div>
              ),
            },
            { key: 'pri', header: 'الأولوية', render: (i) => <Badge value={i.priority === 'stat' ? 'stat' : i.priority === 'urgent' ? 'urgent' : 'open'} label={i.priority} /> },
            { key: 'st', header: 'الحالة', render: (i) => <Badge value={i.status} /> },
            {
              key: 'val',
              header: 'النتيجة',
              render: (i) => (
                <div className="flex items-center gap-1.5">
                  <span>
                    {i.value_numeric ?? i.value_text ?? '—'} {i.unit ?? ''}
                  </span>
                  {i.flag && i.flag !== 'normal' && <Badge value={i.flag} />}
                </div>
              ),
            },
            {
              key: 'act',
              header: 'إجراء',
              hideInCard: true,
              render: (i) => (
                <div className="flex gap-1.5 items-center">
                  {i.status === 'ordered' && has(auth, 'lab.sample.collect') && (
                    <Button variant="ghost" size="sm" onClick={() => act(`/api/lab/items/${i.id}/collect`, {}, 'تم جمع العينة')}>
                      جمع عينة
                    </Button>
                  )}
                  {i.status === 'collected' && has(auth, 'lab.result.enter') && (
                    <div className="flex gap-1">
                      <input
                        aria-label="قيمة التحليل"
                        className="input !w-24 text-xs"
                        type="number"
                        step="0.01"
                        placeholder="القيمة"
                        value={values[i.id] ?? ''}
                        onChange={(e) => setValues({ ...values, [i.id]: e.target.value })}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!values[i.id]}
                        onClick={() => act(`/api/lab/items/${i.id}/result`, { valueNumeric: Number(values[i.id]) }, 'تم حفظ النتيجة')}
                      >
                        حفظ
                      </Button>
                    </div>
                  )}
                  {i.status === 'resulted' && has(auth, 'lab.result.verify') && (
                    <Button variant="primary" size="sm" onClick={() => act(`/api/lab/items/${i.id}/verify`, {}, 'تم اعتماد النتيجة المخبرية')}>
                      اعتماد
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
        <p className="text-xs text-slate-500 mt-3">
          ضابط فصل المهام: اعتماد النتيجة يتطلب مشرفًا أو أخصائيًا مختلفًا عن مدخل النتيجة. القيم الحرجة تُطلق تنبيهًا فوريًا.
        </p>
      </Card>

      {canAck && (
        <Card title="تنبيهات القيم الحرجة (Critical Value Alerts)">
          {alerts.length === 0 ? (
            <EmptyState title="لا توجد تنبيهات قيم حرجة مسجلة" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {alerts.map((a) => (
                <li key={a.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-900">{a.message}</p>
                    <p className="text-xs text-slate-500">{formatDateTime(a.created_at)}</p>
                  </div>
                  {a.acknowledged_at ? (
                    <Badge value="verified" label="تم الإقرار والتبليغ" />
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setAckTarget({ id: a.id, message: a.message })}
                    >
                      إقرار وتوثيق التبليغ
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <ReasonDialog
        open={!!ackTarget}
        onClose={() => setAckTarget(null)}
        title="إقرار وتوثيق تبليغ نتيجة مخبرية حرجة"
        consequenceNote={`سيتم توثيق استلام وإبلاغ النتيجة الحرجة: «${ackTarget?.message ?? ''}» باسمك وتوقيتك في السجل السريري.`}
        label="ملاحظة التبليغ والإجراء السريري"
        placeholder="مثال: تم إبلاغ الطبيب المناوب هاتفيًا وإعادة السحب للتأكيد…"
        minLength={5}
        confirmLabel="توثيق الإقرار"
        onConfirm={async (note) => {
          if (!ackTarget) return;
          await api(`/api/lab/alerts/${ackTarget.id}/ack`, {
            method: 'POST',
            body: JSON.stringify({ note }),
          });
          toast.success('تم الإقرار بالقيمة الحرجة دون إعادة تحميل الصفحة');
          await loadAll();
        }}
      />
    </div>
  );
}

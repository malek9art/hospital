import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  PageSkeleton,
  StatCard,
} from '../components';
import { formatDateTime, formatMoney, formatShortDate } from '../lib/format';
import { navigate } from '../hooks/useHashRoute';

interface DashboardData {
  days: number;
  kpis: {
    appointmentsToday: number;
    encountersToday: number;
    openEncounters: number;
    pendingLabs: number;
    criticalAlerts: number;
    pendingPrescriptions: number;
    bedsAvailable: number;
    bedsOccupied: number;
    bedsCleaning: number;
    bedsMaintenance: number;
    bedsTotal: number;
    occupancyPct: number;
    collectedToday: number;
    outstanding: number;
  };
  byDepartment: Array<{ name_ar: string; visits: string | number }>;
  trend: Array<{ day: string; visits: number; encounters: number; admissions: number; collected: number }>;
  bedsByStatus: Record<string, number>;
  bedsByWard: Array<{ ward_name: string; ward_type: string; total: number; occupied: number; available: number }>;
  actionableAlerts: Array<{
    key: string;
    title: string;
    count: number;
    severity: 'danger' | 'warning' | 'info';
    route: string;
  }>;
  notifications: Array<{ id: string; subject: string; body: string; created_at: string }>;
}

const BED_STATUS_AR: Record<string, string> = {
  available: 'متاح',
  occupied: 'مشغول',
  cleaning: 'تنظيف',
  maintenance: 'صيانة',
};

export default function DashboardPage() {
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setErr(null);
      api<DashboardData>(`/api/dashboard?days=${days}`, { signal })
        .then((res) => setData(res))
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setErr(e.message);
        })
        .finally(() => setLoading(false));
    },
    [days],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  if (err) {
    return <ErrorState message={err} onRetry={() => load()} />;
  }
  if (loading && !data) {
    return <PageSkeleton cards={8} rows={5} />;
  }
  if (!data) return null;

  const k = data.kpis;
  const maxEnc = Math.max(1, ...data.trend.map((t) => Math.max(t.encounters ?? t.visits ?? 0, t.admissions ?? 0)));

  return (
    <div className="space-y-4">
      <PageHeader
        title="لوحة القيادة التشغيلية والسريرية"
        subtitle="مؤشرات فورية محسوبة مباشرة من قاعدة البيانات للمنشأة النشطة."
        actions={
          <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label="نطاق الاتجاه الزمني">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md cursor-pointer ${
                  days === d ? 'bg-brand-700 text-white' : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                آخر {d} يومًا
              </button>
            ))}
          </div>
        }
      />

      {/* Top KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="زيارات اليوم" value={k.encountersToday} sub={`${k.openEncounters} زيارة مفتوحة حاليًا`} />
        <StatCard label="مواعيد اليوم" value={k.appointmentsToday} />
        <StatCard
          label="تنبيهات حرجة غير مقروءة"
          value={k.criticalAlerts}
          tone={k.criticalAlerts > 0 ? 'danger' : 'success'}
          sub={k.criticalAlerts > 0 ? 'تستلزم مراجعة سريرية فورية' : 'لا توجد قيم حرجة معلّقة'}
        />
        <StatCard
          label="إشغال الأسرّة"
          value={`${k.occupancyPct}%`}
          tone={k.occupancyPct >= 85 ? 'warning' : 'default'}
          sub={`${k.bedsOccupied} مشغول من أصل ${k.bedsTotal} (${k.bedsAvailable} متاح)`}
        />
        <StatCard label="تحاليل معلّقة" value={k.pendingLabs} />
        <StatCard label="وصفات بانتظار الصرف" value={k.pendingPrescriptions} />
        <StatCard label="أسرّة قيد التنظيف/الصيانة" value={(k.bedsCleaning ?? 0) + (k.bedsMaintenance ?? 0)} />
        <StatCard label="المحصّل المالي اليوم" value={formatMoney(k.collectedToday)} tone="success" />
      </div>

      {/* Actionable Clinical & Operational Alerts */}
      {data.actionableAlerts.length > 0 && (
        <Card
          title={`تنبيهات قابلة للمتابعة الفورية (${data.actionableAlerts.length})`}
          subtitle="انقر على أي تنبيه للانتقال مباشرة إلى القسم المختص ومعالجته."
        >
          <div className="grid md:grid-cols-2 gap-2">
            {data.actionableAlerts.map((al) => (
              <button
                key={al.key}
                type="button"
                onClick={() => navigate(al.route)}
                className={`text-start rounded-xl border p-3 transition flex items-center justify-between gap-3 cursor-pointer ${
                  al.severity === 'danger'
                    ? 'bg-rose-50/80 border-rose-200 hover:bg-rose-100/70'
                    : al.severity === 'warning'
                      ? 'bg-amber-50/80 border-amber-200 hover:bg-amber-100/70'
                      : 'bg-sky-50/80 border-sky-200 hover:bg-sky-100/70'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-900 truncate">{al.title}</p>
                  <p className="text-[11px] text-slate-600 mt-0.5">عدد الحالات النشطة: {al.count}</p>
                </div>
                <Badge
                  value={al.severity === 'danger' ? 'critical_high' : al.severity === 'warning' ? 'suspected' : 'open'}
                  label={`${al.count}`}
                />
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Trend Chart + Bed Occupancy Breakdown */}
      <div className="grid lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7">
          <Card
            title={`اتجاه الزيارات والتنويم (آخر ${data.days} يومًا)`}
            subtitle="الأعمدة: الزيارات السريرية · النقاط الخضراء: حالات التنويم الجديدة"
          >
            <div className="pt-2">
              <svg
                role="img"
                aria-label={`مخطط الزيارات والتنويم لآخر ${data.days} يومًا`}
                viewBox="0 0 640 190"
                className="w-full h-48 overflow-visible"
              >
                {[0, 0.5, 1].map((ratio) => {
                  const y = 155 - ratio * 130;
                  return (
                    <g key={ratio}>
                      <line x1={28} x2={630} y1={y} y2={y} stroke="#e2e8f0" strokeDasharray="3 3" />
                      <text x={22} y={y + 4} textAnchor="end" className="fill-slate-400 text-[10px]">
                        {Math.round(maxEnc * ratio)}
                      </text>
                    </g>
                  );
                })}
                {data.trend.map((pt, idx) => {
                  const slot = 590 / Math.max(1, data.trend.length);
                  const barW = Math.max(6, Math.min(24, slot * 0.58));
                  const cx = 36 + idx * slot + slot / 2;
                  const encCount = pt.encounters ?? pt.visits ?? 0;
                  const admCount = pt.admissions ?? 0;
                  const encH = (encCount / maxEnc) * 130;
                  const admY = 155 - (admCount / maxEnc) * 130;
                  const showLabel = data.trend.length <= 10 || idx % 4 === 0 || idx === data.trend.length - 1;
                  return (
                    <g key={pt.day}>
                      <rect
                        x={cx - barW / 2}
                        y={155 - encH}
                        width={barW}
                        height={Math.max(2, encH)}
                        rx={3}
                        className="fill-brand-600/85 hover:fill-brand-700 transition"
                      >
                        <title>{`${pt.day}: ${encCount} زيارة، ${admCount} تنويم، ${formatMoney(pt.collected ?? 0)}`}</title>
                      </rect>
                      {admCount > 0 && (
                        <circle cx={cx} cy={admY} r={4} className="fill-emerald-600 stroke-white stroke-2" />
                      )}
                      {showLabel && (
                        <text x={cx} y={175} textAnchor="middle" className="fill-slate-500 text-[10px]">
                          {formatShortDate(pt.day)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>
          </Card>
        </div>

        <div className="lg:col-span-5">
          <Card
            title="تفصيل إشغال الأسرّة حسب الأجنحة"
            action={
              <Button variant="ghost" size="sm" onClick={() => navigate('#/inpatient')}>
                خريطة الأسرّة ←
              </Button>
            }
          >
            <div className="flex flex-wrap gap-2 mb-3">
              {Object.entries(data.bedsByStatus ?? {}).map(([status, count]) => (
                <span key={status} className="text-xs bg-slate-100 rounded-lg px-2.5 py-1 text-slate-700">
                  {BED_STATUS_AR[status] ?? status}: <b>{count}</b>
                </span>
              ))}
            </div>
            {data.bedsByWard.length === 0 ? (
              <EmptyState title="لا أجنحة مسجلة" />
            ) : (
              <div className="space-y-2.5">
                {data.bedsByWard.map((w) => {
                  const pct = w.total > 0 ? Math.round((w.occupied / w.total) * 100) : 0;
                  return (
                    <div key={w.ward_name} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="font-semibold text-slate-800">{w.ward_name}</span>
                        <span className="text-slate-500">
                          {w.occupied}/{w.total} مشغول ({pct}%) · {w.available} متاح
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            pct >= 85 ? 'bg-rose-600' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-600'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Bottom Row: Visits by Department + Notifications */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="الزيارات حسب القسم (اليوم)">
          {data.byDepartment.length === 0 ? (
            <EmptyState title="لا زيارات مسجلة اليوم" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="th">القسم</th>
                  <th className="th">عدد الزيارات</th>
                </tr>
              </thead>
              <tbody>
                {data.byDepartment.map((d) => (
                  <tr key={d.name_ar}>
                    <td className="td font-medium">{d.name_ar}</td>
                    <td className="td font-bold">{d.visits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="إشعارات النظام الداخلية (In-App Outbox)">
          {data.notifications.length === 0 ? (
            <EmptyState title="لا توجد إشعارات جديدة" />
          ) : (
            <ul className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
              {data.notifications.map((n) => (
                <li key={n.id} className="py-2 text-sm">
                  <p className="font-semibold text-slate-800">{n.subject}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {n.body} · <span className="text-slate-400">{formatDateTime(n.created_at)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

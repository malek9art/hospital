import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Button, ErrorState, PageHeader, PageSkeleton, Tabs } from '../components';
import { navigate } from '../hooks/useHashRoute';

interface ModuleMeta {
  key: string;
  ar: string;
  status: 'implemented' | 'partial' | 'not_implemented';
  route?: string | null;
  note: string;
  missing?: string;
}

export default function ModulesPage() {
  const [mods, setMods] = useState<ModuleMeta[]>([]);
  const [filter, setFilter] = useState<'all' | 'implemented' | 'partial' | 'not_implemented'>('all');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setErr(null);
    api<{ modules: ModuleMeta[] }>('/api/meta/modules')
      .then((r) => setMods(r.modules ?? []))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  if (err) return <ErrorState message={err} onRetry={load} />;
  if (loading) return <PageSkeleton cards={6} rows={4} />;

  const counts = {
    all: mods.length,
    implemented: mods.filter((m) => m.status === 'implemented').length,
    partial: mods.filter((m) => m.status === 'partial').length,
    not_implemented: mods.filter((m) => m.status === 'not_implemented').length,
  };

  const visible = filter === 'all' ? mods : mods.filter((m) => m.status === filter);

  return (
    <div className="space-y-4">
      <PageHeader
        title="خريطة حالة الوحدات والنطاق الوظيفي"
        subtitle="تُعرض حالة كل وحدة بشفافية مباشرة من الخادم مع بيان الوظائف المنجزة والحدود الصريحة غير المنفذة."
      />

      <Tabs
        active={filter}
        onChange={setFilter}
        items={[
          { key: 'all', label: 'الكل', count: counts.all },
          { key: 'implemented', label: 'منفّذ تشغيليًا', count: counts.implemented },
          { key: 'partial', label: 'جزئي', count: counts.partial },
          { key: 'not_implemented', label: 'غير منفّذ بعد', count: counts.not_implemented },
        ]}
      />

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {visible.map((m) => (
          <div key={m.key} className="card p-4 flex flex-col justify-between gap-3">
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-bold text-slate-900 text-sm">{m.ar}</h2>
                <Badge value={m.status} />
              </div>
              <p className="text-xs text-slate-700 leading-relaxed">{m.note}</p>
              {m.missing && (
                <div className="rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-2 text-[11px] text-slate-600">
                  <span className="font-bold text-slate-700">خارج النطاق الحالي / المتبقي: </span>
                  {m.missing}
                </div>
              )}
            </div>

            {m.route && (
              <div className="pt-1 border-t border-slate-100 flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => navigate(m.route!)}>
                  فتح القسم ←
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

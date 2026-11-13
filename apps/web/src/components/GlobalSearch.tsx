import { useEffect, useState } from 'react';
import { api } from '../api';
import { useDebounce } from '../hooks/useDebounce';
import { navigate } from '../hooks/useHashRoute';
import { Modal } from './Modal';
import { EmptyState } from './EmptyState';

interface SearchHit {
  category: string;
  categoryAr: string;
  id: string;
  code: string;
  title: string;
  subtitle: string;
  route: string;
}

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query, 240);
  const [items, setItems] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const q = debounced.trim();
    if (!q) {
      setItems([]);
      setErr(null);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    setErr(null);
    api<{ items: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
      .then((res) => setItems(res.items ?? []))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setErr(e.message);
      })
      .finally(() => setBusy(false));

    return () => ctrl.abort();
  }, [debounced, open]);

  // Group results by categoryAr
  const grouped = items.reduce<Record<string, SearchHit[]>>((acc, hit) => {
    (acc[hit.categoryAr] ??= []).push(hit);
    return acc;
  }, {});

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="البحث الشامل في النظام"
      description="ابحث برقم الملف الطبي (MRN)، اسم المريض، رقم الموعد، رقم الفاتورة، الحزمة، أو رقم الموظف."
      size="lg"
    >
      <div className="space-y-3">
        <label htmlFor="global-search-input" className="sr-only">
          عبارة البحث
        </label>
        <input
          id="global-search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="مثال: MRN-0001، محمد، INV-، CSS-، EMP-…"
          className="input text-base"
        />

        {err && (
          <p role="alert" className="text-xs text-rose-700">
            {err}
          </p>
        )}

        {busy && <p className="text-xs text-slate-500">جارٍ البحث…</p>}

        {!busy && query.trim().length > 0 && items.length === 0 && !err && (
          <EmptyState
            title="لا توجد نتائج مطابقة"
            description="تأكد من رقم الملف أو الاسم، مع مراعاة صلاحيات دورك الحالي والمنشأة النشطة."
          />
        )}

        {Object.entries(grouped).map(([cat, list]) => (
          <div key={cat} className="space-y-1">
            <h3 className="text-xs font-bold text-slate-500 px-1">{cat}</h3>
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
              {list.map((hit) => (
                <li key={`${hit.category}-${hit.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      navigate(hit.route);
                      onClose();
                    }}
                    className="w-full px-3.5 py-2.5 text-start hover:bg-brand-50/60 flex items-center justify-between gap-3 cursor-pointer"
                  >
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{hit.title}</p>
                      <p className="text-xs text-slate-500">{hit.subtitle}</p>
                    </div>
                    <span className="font-mono text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded border border-slate-200">
                      {hit.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}

        {query.trim().length === 0 && (
          <p className="text-xs text-slate-500">
            اختصار لوحة المفاتيح: اضغط <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border font-mono">Ctrl+K</kbd> من أي شاشة لفتح البحث السريع.
          </p>
        )}
      </div>
    </Modal>
  );
}

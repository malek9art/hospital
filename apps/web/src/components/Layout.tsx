import { useEffect, useState, type ReactNode } from 'react';
import { api, type Me } from '../api';
import {
  allowedNavItems,
  NAV_GROUPS,
  type NavGroupKey,
  type NavItem,
  type PageKey,
} from '../lib/navigation';
import { usePreferences } from '../lib/preferences';
import { clearReferenceCache } from '../lib/referenceCache';
import { navigate } from '../hooks/useHashRoute';
import { Breadcrumbs } from './Breadcrumbs';
import { GlobalSearch } from './GlobalSearch';
import { Modal, Sheet } from './Modal';
import { Select } from './Field';
import { Button } from './Button';
import { useToast } from './Toast';

export function EphemeralBanner() {
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => setMode(h?.persistence ?? null))
      .catch(() => setMode(null));
  }, []);
  if (mode !== 'ephemeral') return null;
  return (
    <div
      role="region"
      aria-label="تنبيه بيئة العرض المؤقتة"
      className="bg-amber-100 text-amber-950 text-[11px] sm:text-xs px-4 py-1.5 text-center border-b border-amber-300 no-print"
    >
      نسخة استعراض على Vercel: قاعدة البيانات مؤقتة داخل الدالة (<span className="font-mono">persistence: ephemeral</span>) وتُعاد تهيئتها عند إعادة التشغيل.
      للحفظ الدائم شغّل نسخة الخادم أو اربط PostgreSQL عبر <span className="font-mono">DATABASE_URL</span>.
    </div>
  );
}

function NavIcon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4 shrink-0 fill-current">
      <path d={d} />
    </svg>
  );
}

export interface LayoutProps {
  auth: Me;
  activePage: PageKey | null;
  routeId: string | null;
  onRefreshMe: () => Promise<void>;
  onLogout: () => Promise<void>;
  children: ReactNode;
}

export function Layout({ auth, activePage, routeId, onRefreshMe, onLogout, children }: LayoutProps) {
  const { prefs, updatePrefs } = usePreferences();
  const toast = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [switchingFacility, setSwitchingFacility] = useState(false);

  const allowed = allowedNavItems(auth);
  const lang = prefs.language;

  // Global keyboard shortcut Ctrl+K / Cmd+K for search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const grouped = allowed.reduce<Record<NavGroupKey, NavItem[]>>(
    (acc, item) => {
      acc[item.group].push(item);
      return acc;
    },
    { overview: [], clinical: [], operations: [], financial: [], governance: [] },
  );

  const activeNav = allowed.find((n) => n.key === activePage);
  const activeFacility = auth.facilities.find((f) => f.id === auth.activeFacilityId) ?? auth.facilities[0];

  async function switchFacility(facilityId: string) {
    if (!facilityId || facilityId === auth.activeFacilityId) return;
    setSwitchingFacility(true);
    try {
      await api('/api/auth/context', { method: 'POST', body: JSON.stringify({ facilityId }) });
      clearReferenceCache();
      await onRefreshMe();
      toast.success('تم تبديل المنشأة النشطة بنجاح');
    } catch (e: any) {
      toast.error(e?.message ?? 'تعذّر تبديل المنشأة');
    } finally {
      setSwitchingFacility(false);
    }
  }

  async function handleLanguageChange(nextLang: 'ar' | 'en') {
    updatePrefs({ language: nextLang });
    try {
      await api('/api/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ preferredLanguage: nextLang }),
      });
      toast.success(nextLang === 'ar' ? 'تم حفظ اللغة العربية' : 'Language preference saved');
    } catch {
      /* local preference still saved */
    }
  }

  const crumbs = activeNav
    ? [
        { label: lang === 'en' ? NAV_GROUPS[activeNav.group].en : NAV_GROUPS[activeNav.group].ar },
        {
          label: lang === 'en' ? activeNav.labelEn : activeNav.labelAr,
          href: routeId ? `#/${activeNav.key}` : undefined,
        },
        ...(routeId ? [{ label: routeId.slice(0, 12) }] : []),
      ]
    : [];

  const renderGroupLinks = (onSelect?: () => void, collapsed = false) =>
    (Object.keys(NAV_GROUPS) as NavGroupKey[]).map((gk) => {
      const list = grouped[gk];
      if (!list.length) return null;
      return (
        <div key={gk} className="mb-3">
          {!collapsed && (
            <p className="px-3 mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              {lang === 'en' ? NAV_GROUPS[gk].en : NAV_GROUPS[gk].ar}
            </p>
          )}
          <ul className="space-y-0.5">
            {list.map((item) => {
              const selected = item.key === activePage;
              const label = lang === 'en' ? item.labelEn : item.labelAr;
              return (
                <li key={item.key}>
                  <a
                    href={`#/${item.key}`}
                    onClick={() => onSelect?.()}
                    title={collapsed ? label : undefined}
                    aria-current={selected ? 'page' : undefined}
                    className={`min-h-[40px] flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                      selected
                        ? 'bg-brand-700 text-white shadow-xs'
                        : 'text-slate-700 hover:bg-slate-100'
                    } ${collapsed ? 'justify-center px-2' : ''}`}
                  >
                    <NavIcon d={item.icon} />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      );
    });

  const mobileQuickItems = allowed.slice(0, 4);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Accessibility Skip Link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:bg-brand-800 focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:font-bold"
      >
        تخطي إلى المحتوى الرئيسي
      </a>

      <EphemeralBanner />

      {/* Top Sticky Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 no-print">
        <div className="px-3 sm:px-5 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              aria-label="فتح قائمة الأقسام"
              onClick={() => setDrawerOpen(true)}
              className="lg:hidden btn-ghost !px-2.5"
            >
              ☰
            </button>
            <button
              type="button"
              aria-label={prefs.sidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
              onClick={() => updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed })}
              className="hidden lg:inline-flex btn-ghost !px-2.5 text-slate-600"
            >
              ☰
            </button>

            <a href="#/dashboard" className="flex items-center gap-2 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-brand-700 text-white grid place-items-center font-bold shrink-0 shadow-xs">
                <svg aria-hidden="true" viewBox="0 0 24 24" className="w-5 h-5 fill-current">
                  <path d="M10.5 4h3v6.5H20v3h-6.5V20h-3v-6.5H4v-3h6.5V4z" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="font-bold text-sm sm:text-base text-slate-900 truncate leading-tight">
                  {lang === 'en' ? 'Hospital Management System' : 'نظام إدارة المستشفى'}
                </p>
                <p className="text-[11px] text-slate-500 truncate">
                  {activeFacility?.name_ar ?? 'المنشأة الرئيسية'}
                </p>
              </div>
            </a>
          </div>

          <div className="flex items-center gap-2">
            {/* Global Search Trigger */}
            {!auth.user.isPortal && (
              <button
                type="button"
                aria-label="فتح البحث الشامل (Ctrl+K)"
                onClick={() => setSearchOpen(true)}
                className="btn-ghost text-xs sm:text-sm !px-3 text-slate-600"
              >
                <span aria-hidden="true">⌕</span>
                <span className="hidden md:inline">بحث شامل (MRN / اسم / مستند)…</span>
                <kbd className="hidden xl:inline text-[10px] font-mono bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                  Ctrl+K
                </kbd>
              </button>
            )}

            {/* Multi-facility Switcher */}
            {auth.facilities.length > 1 && (
              <div>
                <label htmlFor="facility-switcher" className="sr-only">
                  تبديل المنشأة النشطة
                </label>
                <select
                  id="facility-switcher"
                  disabled={switchingFacility}
                  value={auth.activeFacilityId}
                  onChange={(e) => switchFacility(e.target.value)}
                  className="input !w-auto text-xs !py-1.5 max-w-[180px]"
                >
                  {auth.facilities.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name_ar} ({f.code})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Preferences Button */}
            <button
              type="button"
              aria-label="تفضيلات العرض واللغة"
              onClick={() => setPrefsOpen(true)}
              className="btn-ghost text-xs !px-2.5"
              title="تفضيلات العرض واللغة"
            >
              ⚙ <span className="hidden sm:inline">{lang === 'en' ? 'Prefs' : 'تفضيلات'}</span>
            </button>

            {/* User & Role */}
            <div className="hidden md:flex flex-col items-end leading-tight px-1">
              <span className="text-xs font-bold text-slate-800">{auth.user.fullNameAr}</span>
              <span className="text-[11px] text-slate-500">{auth.user.jobTitle ?? auth.primaryRole}</span>
            </div>

            <Button variant="ghost" size="sm" onClick={onLogout} aria-label="تسجيل الخروج">
              {lang === 'en' ? 'Logout' : 'خروج'}
            </Button>
          </div>
        </div>
      </header>

      {/* Main Body with Desktop Sidebar */}
      <div className="flex-1 flex min-h-0">
        <aside
          aria-label="القائمة الجانبية"
          className={`hidden lg:block bg-white border-e border-slate-200 shrink-0 transition-all duration-150 no-print ${
            prefs.sidebarCollapsed ? 'w-16 p-2' : 'w-64 p-3'
          }`}
        >
          <nav aria-label="أقسام النظام" className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto">
            {renderGroupLinks(undefined, prefs.sidebarCollapsed)}
          </nav>
        </aside>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 min-w-0 p-3 sm:p-5 pb-20 lg:pb-6 max-w-[1440px] w-full mx-auto"
        >
          <Breadcrumbs items={crumbs} />
          {children}
        </main>
      </div>

      {/* Footer */}
      <footer className="text-center text-xs text-slate-400 py-3 border-t border-slate-200/70 bg-white pb-20 lg:pb-3 no-print">
        بيانات تجريبية اصطناعية بالكامل · لا يُدّعى أي اعتماد تنظيمي (PDPL / CBAHI / JCI / HIPAA) قبل تقييم مستقل
      </footer>

      {/* Mobile Bottom Quick Bar */}
      <nav
        aria-label="التنقل السريع للجوال"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-slate-200 flex items-stretch justify-around px-1 py-1 no-print"
      >
        {mobileQuickItems.map((item) => {
          const selected = item.key === activePage;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(`#/${item.key}`)}
              aria-current={selected ? 'page' : undefined}
              className={`min-h-[44px] flex-1 flex flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-semibold cursor-pointer ${
                selected ? 'text-brand-700 bg-brand-50' : 'text-slate-600'
              }`}
            >
              <NavIcon d={item.icon} />
              <span className="truncate max-w-[72px]">
                {lang === 'en' ? item.labelEn : item.labelAr.split(' ')[0]}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="عرض جميع الأقسام"
          className="min-h-[44px] flex-1 flex flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-semibold text-slate-600 cursor-pointer"
        >
          <span aria-hidden="true" className="text-base leading-none">☰</span>
          <span>{lang === 'en' ? 'More' : 'الأقسام'}</span>
        </button>
      </nav>

      {/* Mobile Navigation Sheet */}
      <Sheet
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="أقسام النظام"
        description={`${auth.user.fullNameAr} — ${auth.user.jobTitle ?? auth.primaryRole}`}
      >
        <nav aria-label="قائمة الأقسام للجوال">{renderGroupLinks(() => setDrawerOpen(false), false)}</nav>
      </Sheet>

      {/* Global Search Modal */}
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* User Preferences Modal */}
      <Modal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        title="تفضيلات الواجهة والعرض"
        description="تُحفظ تفضيلاتك تلقائيًا لحسابك الحالي، ويُحفظ اختيار اللغة على الخادم."
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setPrefsOpen(false)}>
            تم
          </Button>
        }
      >
        <div className="space-y-3">
          <Select
            label="اللغة المفضلة (Preferred Language)"
            value={prefs.language}
            onChange={(e) => handleLanguageChange(e.target.value as 'ar' | 'en')}
          >
            <option value="ar">العربية (RTL — الافتراضي)</option>
            <option value="en">English (LTR)</option>
          </Select>

          <Select
            label="طريقة عرض الجداول"
            value={prefs.tableView}
            onChange={(e) => updatePrefs({ tableView: e.target.value as 'auto' | 'table' | 'cards' })}
          >
            <option value="auto">تلقائي (بطاقات على الجوال وجدول على الحاسب)</option>
            <option value="table">جدول دائمًا</option>
            <option value="cards">بطاقات دائمًا</option>
          </Select>

          <Select
            label="كثافة الواجهة"
            value={prefs.density}
            onChange={(e) => updatePrefs({ density: e.target.value as 'comfortable' | 'compact' })}
          >
            <option value="comfortable">مريحة (قياسية)</option>
            <option value="compact">مضغوطة (بيانات أكثر على الشاشة)</option>
          </Select>
        </div>
      </Modal>
    </div>
  );
}

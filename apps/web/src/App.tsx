import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, me, resetCsrf, setUnauthorizedHandler, type Me } from './api';
import { ErrorBoundary, Layout, PageSkeleton, ToastProvider } from './components';
import { useHashRoute } from './hooks/useHashRoute';
import { setFormatLanguage } from './lib/format';
import { canAccessPage, defaultLandingPage, findNavItem } from './lib/navigation';
import {
  DEFAULT_PREFS,
  loadUserPreferences,
  PreferencesContext,
  saveUserPreferences,
  type UserPreferences,
} from './lib/preferences';
import { clearReferenceCache } from './lib/referenceCache';
import LoginPage from './pages/LoginPage';
import ForbiddenPage from './pages/ForbiddenPage';
import NotFoundPage from './pages/NotFoundPage';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const PatientsPage = lazy(() => import('./pages/PatientsPage'));
const AppointmentsPage = lazy(() => import('./pages/AppointmentsPage'));
const ClinicPage = lazy(() => import('./pages/ClinicPage'));
const EmergencyPage = lazy(() => import('./pages/EmergencyPage'));
const InpatientPage = lazy(() => import('./pages/InpatientPage'));
const NursingPage = lazy(() => import('./pages/NursingPage'));
const SurgeryPage = lazy(() => import('./pages/SurgeryPage'));
const IcuPage = lazy(() => import('./pages/IcuPage'));
const BloodBankPage = lazy(() => import('./pages/BloodBankPage'));
const NutritionPage = lazy(() => import('./pages/NutritionPage'));
const CssdPage = lazy(() => import('./pages/CssdPage'));
const LabPage = lazy(() => import('./pages/LabPage'));
const RadiologyPage = lazy(() => import('./pages/RadiologyPage'));
const PharmacyPage = lazy(() => import('./pages/PharmacyPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const ModulesPage = lazy(() => import('./pages/ModulesPage'));
const PortalPage = lazy(() => import('./pages/PortalPage'));
const HrPage = lazy(() => import('./pages/HrPage'));

function AppContent() {
  const [auth, setAuth] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);

  const updatePrefs = useCallback(
    (patch: Partial<UserPreferences>) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        saveUserPreferences(auth?.user.id, next);
        return next;
      });
    },
    [auth?.user.id],
  );

  const handleSaveLastHash = useCallback(
    (h: string) => {
      if (h !== prefs.lastHash) {
        updatePrefs({ lastHash: h });
      }
    },
    [prefs.lastHash, updatePrefs],
  );

  const { route } = useHashRoute(auth, prefs.lastHash, handleSaveLastHash);

  const applyUserSession = useCallback((m: Me) => {
    const loaded = loadUserPreferences(m.user.id, m.user.preferredLanguage);
    setPrefs(loaded);
    saveUserPreferences(m.user.id, loaded);
    setAuth(m);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    me(ctrl.signal)
      .then((m) => applyUserSession(m))
      .catch(() => setAuth(null))
      .finally(() => setLoading(false));

    setUnauthorizedHandler(() => {
      resetCsrf();
      clearReferenceCache();
      setAuth(null);
    });

    return () => ctrl.abort();
  }, [applyUserSession]);

  // Sync HTML dir, lang, format locale, and data-density attributes
  useEffect(() => {
    const html = document.documentElement;
    html.lang = prefs.language;
    html.dir = prefs.language === 'en' ? 'ltr' : 'rtl';
    html.dataset.density = prefs.density;
    setFormatLanguage(prefs.language);
  }, [prefs.language, prefs.density]);

  const refreshMe = useCallback(async () => {
    const m = await me();
    setAuth(m);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    resetCsrf();
    clearReferenceCache();
    setAuth(null);
  }, []);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <PageSkeleton cards={4} rows={5} />
      </div>
    );
  }

  if (!auth) {
    return <LoginPage onLogin={applyUserSession} />;
  }

  const fallbackRoute = `#/${defaultLandingPage(auth)}`;
  const activeNav = route.page ? findNavItem(route.page) : undefined;
  const isUnknown = Boolean(route.segment && !route.page);
  const permitted = route.page ? canAccessPage(auth, route.page) : false;

  const renderPage = () => {
    if (!route.segment) {
      return <PageSkeleton cards={4} rows={5} />;
    }
    if (isUnknown || !route.page) {
      return <NotFoundPage fallbackRoute={fallbackRoute} />;
    }
    if (!permitted) {
      return <ForbiddenPage pageTitle={activeNav?.labelAr} fallbackRoute={fallbackRoute} />;
    }
    switch (route.page) {
      case 'dashboard':
        return <DashboardPage />;
      case 'patients':
        return <PatientsPage auth={auth} routeId={route.id} />;
      case 'appointments':
        return <AppointmentsPage auth={auth} />;
      case 'clinic':
        return <ClinicPage auth={auth} routeId={route.id} />;
      case 'emergency':
        return <EmergencyPage auth={auth} />;
      case 'inpatient':
        return <InpatientPage auth={auth} routeId={route.id} />;
      case 'nursing':
        return <NursingPage auth={auth} />;
      case 'surgery':
        return <SurgeryPage auth={auth} />;
      case 'icu':
        return <IcuPage auth={auth} />;
      case 'bloodbank':
        return <BloodBankPage auth={auth} />;
      case 'nutrition':
        return <NutritionPage auth={auth} />;
      case 'cssd':
        return <CssdPage auth={auth} />;
      case 'lab':
        return <LabPage auth={auth} />;
      case 'radiology':
        return <RadiologyPage auth={auth} />;
      case 'pharmacy':
        return <PharmacyPage auth={auth} />;
      case 'billing':
        return <BillingPage auth={auth} routeId={route.id} />;
      case 'reports':
        return <ReportsPage auth={auth} />;
      case 'audit':
        return <AuditPage />;
      case 'admin':
        return <AdminPage auth={auth} />;
      case 'modules':
        return <ModulesPage />;
      case 'portal':
        return <PortalPage />;
      case 'hr':
        return <HrPage />;
    }
  };

  return (
    <PreferencesContext.Provider value={{ prefs, updatePrefs }}>
      <Layout
        auth={auth}
        activePage={permitted ? route.page : null}
        routeId={route.id}
        onRefreshMe={refreshMe}
        onLogout={logout}
      >
        <ErrorBoundary resetKey={route.raw}>
          <Suspense fallback={<PageSkeleton cards={4} rows={5} />}>{renderPage()}</Suspense>
        </ErrorBoundary>
      </Layout>
    </PreferencesContext.Provider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ErrorBoundary>
  );
}

import { createContext, useContext } from 'react';
import type { Lang } from './format';

export type Density = 'comfortable' | 'compact';
export type TableViewMode = 'auto' | 'table' | 'cards';

export interface UserPreferences {
  language: Lang;
  density: Density;
  tableView: TableViewMode;
  sidebarCollapsed: boolean;
  lastHash?: string;
}

export const DEFAULT_PREFS: UserPreferences = {
  language: 'ar',
  density: 'comfortable',
  tableView: 'auto',
  sidebarCollapsed: false,
};

function storageKey(userId?: string | null) {
  return `hms.prefs.${userId ?? 'anon'}`;
}

export function loadUserPreferences(userId?: string | null, serverLang?: string): UserPreferences {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const parsed = raw ? (JSON.parse(raw) as Partial<UserPreferences>) : {};
    const language: Lang =
      parsed.language === 'en' || parsed.language === 'ar'
        ? parsed.language
        : serverLang === 'en'
          ? 'en'
          : 'ar';
    return {
      language,
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      tableView: parsed.tableView === 'table' || parsed.tableView === 'cards' ? parsed.tableView : 'auto',
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      lastHash: typeof parsed.lastHash === 'string' ? parsed.lastHash : undefined,
    };
  } catch {
    return { ...DEFAULT_PREFS, language: serverLang === 'en' ? 'en' : 'ar' };
  }
}

export function saveUserPreferences(userId: string | null | undefined, prefs: UserPreferences) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(prefs));
  } catch {
    /* ignore storage quota errors */
  }
}

export interface PreferencesContextValue {
  prefs: UserPreferences;
  updatePrefs: (patch: Partial<UserPreferences>) => void;
}

export const PreferencesContext = createContext<PreferencesContextValue>({
  prefs: DEFAULT_PREFS,
  updatePrefs: () => {},
});

export const loadPreferences = loadUserPreferences;
export const savePreferences = saveUserPreferences;

export function usePreferences() {
  return useContext(PreferencesContext);
}

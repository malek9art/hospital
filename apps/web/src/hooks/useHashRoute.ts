import { useCallback, useEffect, useState } from 'react';
import { canAccessPage, defaultPageForUser, isKnownPage, type PageKey } from '../lib/navigation';
import type { Me } from '../api';

export interface ParsedRoute {
  raw: string;
  segment: string;
  id: string | null;
  page: PageKey | null;
}

export function parseHash(hash: string): ParsedRoute {
  const cleaned = hash.replace(/^#\/?/, '').split('?')[0].trim();
  if (!cleaned) {
    return { raw: '', segment: '', id: null, page: null };
  }
  const parts = cleaned.split('/').filter(Boolean);
  const segment = parts[0] ?? '';
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  return {
    raw: cleaned,
    segment,
    id,
    page: isKnownPage(segment) ? segment : null,
  };
}

export function navigate(path: string, replace = false) {
  const normalized = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  if (window.location.hash === normalized) return;
  if (replace) {
    window.history.replaceState(null, '', normalized);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = normalized;
  }
}

export function useHashRoute(auth: Me | null, lastSavedHash?: string, onSaveLastHash?: (h: string) => void) {
  const [route, setRoute] = useState<ParsedRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const handler = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  // Initialize default route when authenticated and hash is empty
  useEffect(() => {
    if (!auth) return;
    const current = parseHash(window.location.hash);
    if (!current.segment) {
      if (lastSavedHash) {
        const saved = parseHash(lastSavedHash);
        if (saved.page && canAccessPage(auth, saved.page)) {
          navigate(lastSavedHash, true);
          return;
        }
      }
      const fallback = defaultPageForUser(auth);
      navigate(`#/${fallback}`, true);
    }
  }, [auth, lastSavedHash]);

  // Save valid accessible route per user
  useEffect(() => {
    if (!auth || !route.page) return;
    if (canAccessPage(auth, route.page)) {
      const currentHash = `#/${route.raw}`;
      onSaveLastHash?.(currentHash);
    }
  }, [auth, route.page, route.raw]);

  const go = useCallback((page: PageKey, id?: string | null) => {
    navigate(id ? `#/${page}/${encodeURIComponent(id)}` : `#/${page}`);
  }, []);

  return { route, go };
}

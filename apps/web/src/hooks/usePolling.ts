import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingOptions {
  intervalMs?: number;
  enabled?: boolean;
}

export function usePolling(fn: () => Promise<unknown> | unknown, opts: PollingOptions = {}) {
  const { intervalMs = 25_000, enabled = true } = opts;
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const markUpdated = useCallback(() => {
    setLastUpdatedAt(new Date().toISOString());
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setPaused(!next);
  }, []);

  const refreshNow = useCallback(async () => {
    setBusy(true);
    try {
      await fnRef.current();
      setLastUpdatedAt(new Date().toISOString());
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || paused) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      Promise.resolve(fnRef.current())
        .then(() => setLastUpdatedAt(new Date().toISOString()))
        .catch(() => {
          /* individual loaders report errors */
        });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, paused, intervalMs]);

  return {
    paused,
    setPaused,
    enabled: !paused,
    setEnabled,
    busy,
    lastUpdatedAt,
    markUpdated,
    refreshNow,
  };
}

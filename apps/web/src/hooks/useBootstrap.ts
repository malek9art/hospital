import { useEffect, useState } from 'react';
import { getBootstrapCached, type BootstrapData } from '../lib/referenceCache';

export function useBootstrap(facilityId?: string, enabled = true) {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cacheKey = facilityId ?? 'active';

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getBootstrapCached(cacheKey)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, enabled]);

  return { boot: data, data, bootError: error, error };
}

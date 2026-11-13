import { api } from '../api';

export interface BootstrapData {
  departments: { id: string; code: string; name_ar: string; name_en: string; dept_type: string }[];
  doctors: { id: string; full_name_ar: string; department_id: string | null; role_id: string }[];
  labTests: { code: string; name_ar: string; name_en: string; specimen: string; unit: string; ref_low: number; ref_high: number; price: number }[];
  drugs: { id: string; code: string; name_ar: string; name_en: string; form: string; strength: string; price: number }[];
  pricing: Record<string, unknown>;
  serverTime: string;
}

let cachedFacilityId = '';
let cachedBootstrap: BootstrapData | null = null;
let cachedAt = 0;
let inflight: Promise<BootstrapData> | null = null;

const TTL_MS = 90_000;

export async function getBootstrapCached(facilityId: string, force = false): Promise<BootstrapData> {
  const now = Date.now();
  if (!force && cachedBootstrap && cachedFacilityId === facilityId && now - cachedAt < TTL_MS) {
    return cachedBootstrap;
  }
  if (!force && inflight && cachedFacilityId === facilityId) {
    return inflight;
  }
  cachedFacilityId = facilityId;
  inflight = api<BootstrapData>('/api/meta/bootstrap')
    .then((res) => {
      cachedBootstrap = res;
      cachedAt = Date.now();
      inflight = null;
      return res;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

export function clearReferenceCache() {
  cachedFacilityId = '';
  cachedBootstrap = null;
  cachedAt = 0;
  inflight = null;
}

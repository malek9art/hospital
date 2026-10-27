export type Me = {
  user: { id: string; email: string; fullNameAr: string; jobTitle: string | null; preferredLanguage: string; isPortal: boolean; patientId: string | null };
  roles: { role_id: string; facility_id: string }[];
  primaryRole: string;
  permissions: string[];
  facilities: { id: string; name_ar: string; code: string }[];
  activeFacilityId: string;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  csrfToken: string;
};

let csrf = '';
let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: any) { super(message); }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.status === 401) { onUnauthorized(); }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `فشل الطلب (${res.status})`, err.details);
  }
  return data as T;
}

export async function login(email: string, password: string) {
  const res = await api<{ csrfToken: string; mfaRequired: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  csrf = res.csrfToken;
  return res;
}

export async function me(): Promise<Me> {
  const res = await api<Me>('/api/auth/me');
  csrf = res.csrfToken;
  return res;
}

export function resetCsrf() { csrf = ''; }
export function has(me: Me | null, perm: string) { return Boolean(me?.permissions.includes(perm)); }

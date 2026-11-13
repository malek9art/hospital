export type Me = {
  user: {
    id: string;
    email: string;
    fullNameAr: string;
    fullNameEn?: string | null;
    jobTitle: string | null;
    preferredLanguage: string;
    isPortal: boolean;
    patientId: string | null;
  };
  roles: { role_id: string; facility_id: string }[];
  primaryRole: string;
  permissions: string[];
  facilities: { id: string; name_ar: string; name_en?: string; code: string }[];
  activeFacilityId: string;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  csrfToken: string;
  sessionId?: string;
};

let csrf = '';
let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> | string | null = null,
  ) {
    super(message);
  }
}

function normalizeHeaders(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(init)) {
      if (v !== undefined) out[k.toLowerCase()] = v;
    }
  }
  return out;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init.headers);
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = csrf;

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await res.text();
  let data: Record<string, any> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (res.status === 401 && path !== '/api/auth/login') {
    onUnauthorized();
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `فشل الطلب (${res.status})`, err.details ?? null);
  }
  return data as T;
}

export async function login(email: string, password: string) {
  const res = await api<{ csrfToken: string; mfaRequired: boolean }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  csrf = res.csrfToken;
  return res;
}

export async function me(signal?: AbortSignal): Promise<Me> {
  const res = await api<Me>('/api/auth/me', { signal });
  csrf = res.csrfToken;
  return res;
}

export function resetCsrf() {
  csrf = '';
}

export function has(m: Me | null, perm: string): boolean {
  return Boolean(m?.permissions.includes(perm));
}

export function hasAny(m: Me | null, perms: readonly string[]): boolean {
  return perms.some((p) => has(m, p));
}

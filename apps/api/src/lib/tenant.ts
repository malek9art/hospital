import type { AuthContext } from '../auth/context';
import { getDb, type Queryable } from '../db';
import { writeAudit, type AuditEntry } from './audit';
import { conflict } from './errors';
import crypto from 'node:crypto';

/**
 * Opens a transaction that runs as the restricted database role with the
 * session's tenant settings. RLS then constrains every statement.
 */
export async function withTenant<T>(auth: AuthContext, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const db = await getDb();
  const facilityIds = auth.facilities.map((f) => f.id).join(',');
  if (auth.isPortal && auth.user.patient_id) {
    return db.asRole('hms_portal', { 'app.patient_id': auth.user.patient_id, 'app.facility_ids': facilityIds }, fn);
  }
  return db.asRole('hms_app', {
    'app.facility_ids': facilityIds,
    'app.facility_id': auth.activeFacilityId,
  }, fn);
}

/** Tenant transaction that also appends an audit entry atomically. */
export async function withTenantAudited<T>(
  auth: AuthContext,
  fn: (q: Queryable) => Promise<T>,
  audit: (result: T) => AuditEntry | null,
): Promise<T> {
  return withTenant(auth, async (q) => {
    const result = await fn(q);
    const entry = audit(result);
    if (entry) {
      await writeAudit(q, {
        facilityId: auth.activeFacilityId,
        actorUserId: auth.user.id,
        actorRole: auth.roles[0]?.role_id ?? 'patient',
        ...entry,
      });
    }
    return result;
  });
}

export function hashRequest(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

export interface IdempotencyOptions {
  key: string | undefined;
  userId: string;
  endpoint: string;
  body: unknown;
}

/**
 * Executes `run` at most once per (key,user,endpoint). Replays the stored
 * response when the same key is retried, which prevents double payments.
 */
export async function idempotent<T>(
  q: Queryable,
  opts: IdempotencyOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (!opts.key) return run();
  if (opts.key.length < 8 || opts.key.length > 128) throw conflict('مفتاح منع التكرار غير صالح');
  const reqHash = hashRequest(opts.body);
  const existing = await q.query<{ request_hash: string; response_json: T }>(
    'SELECT request_hash, response_json FROM idempotency_keys WHERE key = $1 AND user_id = $2 AND endpoint = $3',
    [opts.key, opts.userId, opts.endpoint],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].request_hash !== reqHash) {
      throw conflict('تم استخدام مفتاح منع التكرار بطلب مختلف');
    }
    return { ...existing.rows[0].response_json, replayed: true } as T;
  }
  const result = await run();
  await q.query(
    `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, status_code, response_json)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [opts.key, opts.userId, opts.endpoint, reqHash, 200, JSON.stringify(result)],
  );
  return result;
}

export async function nextSequence(q: Queryable, facilityId: string, name: string): Promise<number> {
  const res = await q.query<{ next_value: string }>(
    `INSERT INTO number_sequences (facility_id, name, next_value) VALUES ($1, $2, 2)
     ON CONFLICT (facility_id, name) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value - 1 AS next_value`,
    [facilityId, name],
  );
  return Number(res.rows[0]?.next_value);
}

export async function nextDocumentNo(q: Queryable, facilityId: string, name: string, prefix: string) {
  const seq = await nextSequence(q, facilityId, name);
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

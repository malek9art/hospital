import crypto from 'node:crypto';
import type { Queryable } from '../db';

export interface AuditEntry {
  facilityId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  patientId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * PostgreSQL jsonb stores object keys in its own order (by length, then bytes),
 * so the hash must be computed over a canonical form that is stable across the
 * write and the later verification read.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonical(entry: AuditEntry, createdAt: string, prevHash: string) {
  // Stable key order so an independent verifier can recompute the digest.
  const payload = {
    prevHash,
    createdAt,
    facilityId: entry.facilityId ?? null,
    actorUserId: entry.actorUserId ?? null,
    actorRole: entry.actorRole ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    patientId: entry.patientId ?? null,
    outcome: entry.outcome ?? 'success',
    reason: entry.reason ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    requestId: entry.requestId ?? null,
    detail: entry.detail ?? {},
  };
  return canonicalJson(payload);
}

export function computeAuditHash(entry: AuditEntry, createdAt: string, prevHash: string) {
  return crypto.createHash('sha256').update(canonical(entry, createdAt, prevHash)).digest('hex');
}

/**
 * Appends one audit record and advances the hash chain. Must run inside the same
 * transaction as the business change so an operation and its audit trail commit
 * (or roll back) together.
 */
export async function writeAudit(q: Queryable, entry: AuditEntry): Promise<void> {
  const head = await q.query<{ last_hash: string }>(
    'SELECT last_hash FROM audit_chain_state WHERE id = 1 FOR UPDATE',
  );
  const prevHash = head.rows[0]?.last_hash;
  if (!prevHash) throw new Error('Audit chain state is missing');
  const createdAt = new Date().toISOString();
  const hash = computeAuditHash(entry, createdAt, prevHash);

  await q.query(
    `INSERT INTO audit_log
      (facility_id, actor_user_id, actor_role, action, entity_type, entity_id, patient_id,
       outcome, reason, ip, user_agent, request_id, detail, prev_hash, hash, hash_version, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      entry.facilityId ?? null,
      entry.actorUserId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.patientId ?? null,
      entry.outcome ?? 'success',
      entry.reason ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
      JSON.stringify(entry.detail ?? {}),
      prevHash,
      hash,
      AUDIT_HASH_VERSION,
      createdAt,
    ],
  );
  await q.query('UPDATE audit_chain_state SET last_hash = $1, last_id = last_id + 1, updated_at = now() WHERE id = 1', [hash]);
}

export const AUDIT_HASH_VERSION = 1;

export interface AuditRow {
  id: string;
  facility_id: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  patient_id: string | null;
  outcome: string;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  detail: Record<string, unknown>;
  hash_version: number;
  prev_hash: string;
  hash: string;
  created_at: string;
}

/** Recomputes the whole chain. Returns the index of the first broken link, if any. */
export async function verifyAuditChain(q: Queryable, limit = 100000) {
  const res = await q.query<AuditRow>(
    `SELECT * FROM audit_log ORDER BY id ASC LIMIT ${Number(limit)}`,
  );
  let prev = '0'.repeat(64);
  let checked = 0;
  for (const row of res.rows) {
    if (row.hash_version !== AUDIT_HASH_VERSION) {
      return { ok: false as const, checked, brokenAtId: row.id, reason: `unsupported_hash_version_${row.hash_version}` };
    }
    const entry: AuditEntry = {
      facilityId: row.facility_id,
      actorUserId: row.actor_user_id,
      actorRole: row.actor_role,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      patientId: row.patient_id,
      outcome: row.outcome as AuditEntry['outcome'],
      reason: row.reason,
      ip: row.ip,
      userAgent: row.user_agent,
      requestId: row.request_id,
      detail: row.detail,
    };
    const createdAt = new Date(row.created_at).toISOString();
    const expected = computeAuditHash(entry, createdAt, prev);
    if (expected !== row.hash || row.prev_hash !== prev) {
      return { ok: false as const, checked: checked + 1, brokenAtId: row.id };
    }
    prev = row.hash;
    checked += 1;
  }
  return { ok: true as const, checked };
}

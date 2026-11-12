import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Password hashing: Argon2id with OWASP-recommended parameters (19 MiB, t=2).
// ---------------------------------------------------------------------------
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Keyed hash (blind index) - deterministic, used for equality search only. */
export function blindIndex(value: string): string {
  return crypto.createHmac('sha256', config().searchHashKey).update(normalize(value)).digest('hex');
}

export function hmacToken(token: string): string {
  return crypto.createHmac('sha256', config().sessionSecret).update(token).digest('hex');
}

export function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, '') // Arabic diacritics + tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Field encryption: AES-256-GCM, versioned ciphertext "v1:<iv>:<tag>:<data>".
// AAD binds ciphertext to its column, so values cannot be swapped between fields.
// ---------------------------------------------------------------------------
export function encryptField(plain: string | null | undefined, aad: string): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config().encryptionKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decryptField(payload: string | null | undefined, aad: string): string | null {
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length !== 4) throw new Error('Malformed ciphertext');
  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== 'v1') throw new Error(`Unsupported ciphertext version ${version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', config().encryptionKey, Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function maskId(value: string | null): string {
  if (!value) return '—';
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

export function maskPhone(value: string | null): string {
  if (!value) return '—';
  return value.length <= 4 ? '****' : `${value.slice(0, 3)}****${value.slice(-3)}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

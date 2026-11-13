import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DB_MODE: z.enum(['pglite', 'postgres']).optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  DATABASE_URL: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  SUPABASE_DB_URL: z.string().optional(),
  SUPABASE_DB_HOST: z.string().optional(),
  SUPABASE_DB_PORT: z.coerce.number().default(5432),
  SUPABASE_DB_USER: z.string().optional(),
  SUPABASE_DB_NAME: z.string().default('postgres'),
  SUPABASE_DB_PASSWORD: z.string().optional(),
  DATABASE_SSL: z.enum(['auto', 'true', 'false']).default('auto'),
  SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  DB_SET_ROLE: z.string().default('hms_app'),
  SESSION_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  SEARCH_HASH_KEY: z.string().optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().default(12),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().default(15),
  COOKIE_SECURE: z.string().default('false').transform((v) => v === 'true'),
  SEED_DEMO: z.string().default('true').transform((v) => v === 'true'),
  RATE_LIMIT_MAX: z.coerce.number().default(600),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(25),
  WEB_DIR: z.string().default(path.resolve(__dirname, '../../web/dist')),
  TRUST_PROXY: z.string().default('false').transform((v) => v === 'true'),
  // Serverless only: migrate + seed automatically when the database is empty.
  AUTO_BOOTSTRAP: z.string().default('false').transform((v) => v === 'true'),
});

export type AppConfig = Omit<z.infer<typeof EnvSchema>, 'DB_MODE'> & {
  DB_MODE: 'pglite' | 'postgres';
  databaseUrl: string | undefined;
  supabaseUrl: string | undefined;
  sessionSecret: Buffer;
  encryptionKey: Buffer;
  searchHashKey: Buffer;
};

function loadSecrets(env: z.infer<typeof EnvSchema>) {
  // Production must supply secrets explicitly. Development/demo generates strong
  // random secrets persisted under .data (git-ignored) so sessions survive restarts.
  const file = path.resolve('.data/dev-secrets.json');
  let stored: Record<string, string> = {};
  try {
    if (fs.existsSync(file)) stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = {};
  }
  const generate = () => crypto.randomBytes(32).toString('base64');
  // All three keys feed AES-256-GCM / HMAC-SHA256, so they must decode to
  // exactly 32 bytes. Anything else fails deep inside node:crypto with the
  // unhelpful "Invalid key length" - validate it here with a clear message.
  const decodeKey = (name: string, value: string) => {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(value, 'base64');
    } catch {
      throw new Error(`${name} must be base64-encoded`);
    }
    if (bytes.length !== 32) {
      throw new Error(`${name} must be base64 of exactly 32 random bytes (got ${bytes.length} bytes). Generate with: openssl rand -base64 32`);
    }
    return value;
  };
  const resolveKey = (name: 'SESSION_SECRET' | 'ENCRYPTION_KEY' | 'SEARCH_HASH_KEY') => {
    const fromEnv = env[name];
    if (fromEnv && fromEnv.length >= 32 && !fromEnv.startsWith('REPLACE')) return decodeKey(name, fromEnv);
    if (env.NODE_ENV === 'production') {
      throw new Error(`${name} must be set (32 random bytes, base64) when NODE_ENV=production`);
    }
    if (!stored[name]) {
      stored[name] = generate();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    }
    return stored[name];
  };
  return {
    sessionSecret: Buffer.from(resolveKey('SESSION_SECRET'), 'base64'),
    encryptionKey: Buffer.from(resolveKey('ENCRYPTION_KEY'), 'base64'),
    searchHashKey: Buffer.from(resolveKey('SEARCH_HASH_KEY'), 'base64'),
  };
}

/**
 * Safely normalizes PostgreSQL connection URIs even when a user pastes a raw
 * password containing `@`, `#`, or `?` into `postgresql://user:pass@host:port/db`.
 * Returns `undefined` if the URI still contains a literal template placeholder
 * such as `[YOUR-PASSWORD]` or `CHANGE_ME`.
 */
export function normalizePostgresUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes('[YOUR-PASSWORD]') || trimmed.includes('<YOUR-PASSWORD>') || trimmed.includes(':CHANGE_ME@')) {
    return undefined;
  }
  const schemeMatch = trimmed.match(/^(postgres(?:ql)?:\/\/)(.+)$/i);
  if (!schemeMatch) return trimmed;
  const [, scheme, rest] = schemeMatch;
  const atIdx = rest.lastIndexOf('@');
  if (atIdx === -1) return trimmed;
  const userInfo = rest.slice(0, atIdx);
  const hostAndPath = rest.slice(atIdx + 1);
  const colonIdx = userInfo.indexOf(':');
  if (colonIdx === -1) return trimmed;
  const user = userInfo.slice(0, colonIdx);
  const rawPass = userInfo.slice(colonIdx + 1);
  let decodedPass = rawPass;
  try {
    decodedPass = decodeURIComponent(rawPass);
  } catch {
    decodedPass = rawPass;
  }
  return `${scheme}${user}:${encodeURIComponent(decodedPass)}@${hostAndPath}`;
}

export function loadConfig(): AppConfig {
  const env = EnvSchema.parse(process.env);
  const secrets = loadSecrets(env);
  const builtFromParts =
    env.SUPABASE_DB_HOST?.trim() && env.SUPABASE_DB_USER?.trim() && env.SUPABASE_DB_PASSWORD?.trim()
      ? `postgresql://${encodeURIComponent(env.SUPABASE_DB_USER.trim())}:${encodeURIComponent(env.SUPABASE_DB_PASSWORD.trim())}@${env.SUPABASE_DB_HOST.trim()}:${env.SUPABASE_DB_PORT}/${encodeURIComponent(env.SUPABASE_DB_NAME.trim())}`
      : undefined;
  const databaseUrl = [env.DATABASE_URL, env.SUPABASE_DB_URL, env.POSTGRES_URL, builtFromParts]
    .map((u) => normalizePostgresUrl(u))
    .find((u): u is string => Boolean(u));
  const dbMode: 'pglite' | 'postgres' =
    env.DB_MODE ?? (env.NODE_ENV !== 'test' && databaseUrl ? 'postgres' : 'pglite');
  if (dbMode === 'postgres' && !databaseUrl) {
    throw new Error(
      'Valid DATABASE_URL (without [YOUR-PASSWORD] placeholder) or SUPABASE_DB_PASSWORD is required when DB_MODE=postgres',
    );
  }
  const supabaseUrl = (env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL)?.trim() || undefined;
  return { ...env, DB_MODE: dbMode, databaseUrl, supabaseUrl, ...secrets };
}

let cached: AppConfig | null = null;
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export type Params = unknown[];
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  /**
   * Runs fn inside a single database transaction after switching to a restricted
   * database role and injecting session settings consumed by RLS policies.
   */
  asRole<T>(
    role: string,
    settings: Record<string, string>,
    fn: (q: Queryable) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

// PGlite is single-connection; serialize transactions so two requests never
// interleave and leak session settings between each other.
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

class PgliteDb implements Db {
  private mutex = new Mutex();
  constructor(private db: any) {}

  async query<T>(sql: string, params: Params = []): Promise<QueryResult<T>> {
    const res = await this.db.query(sql, params);
    // UPDATE/DELETE return no rows but do report affectedRows; SELECTs report rows.
    const affected = res.rows.length > 0 ? res.rows.length : typeof res.affectedRows === 'number' ? res.affectedRows : 0;
    return { rows: res.rows as T[], rowCount: affected };
  }
  async exec(sql: string) {
    await this.db.exec(sql);
  }
  async asRole<T>(role: string, settings: Record<string, string>, fn: (q: Queryable) => Promise<T>) {
    return this.mutex.run(async () => {
      let out: T;
      await this.db.exec('BEGIN');
      try {
        // Role and settings are transaction-local: they cannot leak to the next request.
        await this.db.exec(`SET LOCAL ROLE ${safeRole(role)}`);
        for (const [k, v] of Object.entries(settings)) {
          await this.db.query('SELECT set_config($1, $2, true)', [k, v]);
        }
        out = await fn({ query: this.query.bind(this) });
        await this.db.exec('COMMIT');
      } catch (err) {
        try {
          await this.db.exec('ROLLBACK');
        } catch {
          /* connection already reset */
        }
        throw err;
      }
      return out;
    });
  }
  async close() {
    await this.db.close();
  }
}

function safeRole(role: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(role)) throw new Error(`Invalid database role: ${role}`);
  return role;
}

class PgDb implements Db {
  constructor(private pool: any) {}

  async query<T>(sql: string, params: Params = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async asRole<T>(role: string, settings: Record<string, string>, fn: (q: Queryable) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${safeRole(role)}`);
      for (const [k, v] of Object.entries(settings)) {
        await client.query('SELECT set_config($1, $2, true)', [k, v]);
      }
      const q: Queryable = {
        query: async <R>(sql: string, params: Params = []) => {
          const res = await client.query(sql, params);
          return { rows: res.rows as R[], rowCount: res.rowCount ?? 0 };
        },
      };
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

let instance: Db | null = null;

/**
 * Serverless bundlers copy the package files but rewrite `import.meta.url`, so
 * PGlite cannot find pglite.wasm / initdb.wasm / pglite.data on its own. Locate
 * them explicitly and hand them to PGlite; fall back to its default resolution
 * (normal Node installs) when they are not found.
 */
function toBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  // Copy into a plain ArrayBuffer-backed view so WebAssembly/Blob APIs accept it.
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}

function resolvePgliteAssets(): { wasm: Uint8Array<ArrayBuffer>; initdb: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> } | null {
  const candidates: string[] = [];
  if (process.env.PGLITE_DIST_DIR) candidates.push(process.env.PGLITE_DIST_DIR);
  try {
    candidates.push(path.dirname(require.resolve('@electric-sql/pglite')));
  } catch {
    /* package exports may block require.resolve; ignore */
  }
  candidates.push(path.join(process.cwd(), 'node_modules/@electric-sql/pglite/dist'));
  candidates.push(path.resolve(__dirname, '../../../node_modules/@electric-sql/pglite/dist'));
  for (const dir of candidates) {
    const files = ['pglite.wasm', 'initdb.wasm', 'pglite.data'].map((f) => path.join(dir, f));
    if (files.every((f) => fs.existsSync(f))) {
      return {
        wasm: toBytes(fs.readFileSync(files[0])),
        initdb: toBytes(fs.readFileSync(files[1])),
        data: toBytes(fs.readFileSync(files[2])),
      };
    }
  }
  return null;
}

export async function getDb(): Promise<Db> {
  if (instance) return instance;
  const cfg = config();
  if (cfg.DB_MODE === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    fs.mkdirSync(cfg.PGLITE_DIR, { recursive: true });
    const assets = resolvePgliteAssets();
    const db = assets
      ? await PGlite.create({
          dataDir: cfg.PGLITE_DIR,
          pgliteWasmModule: new WebAssembly.Module(assets.wasm),
          initdbWasmModule: new WebAssembly.Module(assets.initdb),
          fsBundle: new Blob([assets.data]),
        })
      : await PGlite.create(cfg.PGLITE_DIR);
    instance = new PgliteDb(db);
  } else {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: cfg.DATABASE_URL, max: 20 });
    instance = new PgDb(pool);
  }
  return instance;
}

export async function closeDb() {
  if (instance) await instance.close();
  instance = null;
}

function resolveMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(__dirname, '../../../../db/migrations'),
    path.join(process.cwd(), 'db/migrations'),
    path.join(process.cwd(), '..', 'db/migrations'),
  ].filter((x): x is string => Boolean(x));
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.sql'))) return dir;
  }
  throw new Error(`Migrations directory not found (looked in: ${candidates.join(', ')})`);
}

export async function runMigrations(db: Db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text NOT NULL
  )`);

  // Restricted roles used by the API (NOLOGIN: only reachable via SET ROLE).
  for (const role of ['hms_app', 'hms_portal']) {
    try {
      await db.exec(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
    } catch (err: any) {
      if (!/already exists/i.test(String(err?.message))) throw err;
    }
  }

  const dir = resolveMigrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const existing = await db.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map(existing.rows.map((r) => [r.filename, r.checksum]));

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = require('node:crypto').createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(file);
    if (prev) {
      if (prev !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      }
      continue;
    }
    const started = Date.now();
    await db.exec('BEGIN');
    try {
      await db.exec(sql);
      await db.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
      await db.exec('COMMIT');
      // eslint-disable-next-line no-console
      console.log(`[migrate] applied ${file} (${Date.now() - started}ms)`);
    } catch (err) {
      await db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return files.length;
}

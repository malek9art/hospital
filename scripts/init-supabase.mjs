#!/usr/bin/env node
/**
 * Supabase Initialization & SQL Bundle Generator for HMS
 * Target Project : https://pxawcoccgcuzoustyugh.supabase.co
 * Shared Pooler  : aws-0-ap-northeast-2.pooler.supabase.com:5432
 * Database / User: postgres / postgres.pxawcoccgcuzoustyugh
 *
 * Modes:
 *   1. `npm run db:supabase:sql` (`node scripts/init-supabase.mjs --emit-sql`)
 *      Generates:
 *        - `db/supabase-schema.sql`    : All 19 migrations (89 tables, RLS, roles, anon lockdown)
 *        - `db/supabase-full-init.sql` : All 19 migrations + 2 facilities, 8 departments,
 *                                        25 roles, 98 permissions, all 29 demo login accounts
 *                                        (Argon2id), wards/rooms/beds, lab tests, drugs & batches,
 *                                        and CSSD sets — ready to paste into Supabase SQL Editor!
 *
 *   2. `npm run db:supabase:init`
 *      Connects to `aws-0-ap-northeast-2.pooler.supabase.com:5432` via `DATABASE_URL` or
 *      `SUPABASE_DB_PASSWORD`, applies all 19 migrations, and seeds full demo clinical data.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const migrationsDir = path.join(rootDir, 'db', 'migrations');
const outSchemaPath = path.join(rootDir, 'db', 'supabase-schema.sql');
const outFullPath = path.join(rootDir, 'db', 'supabase-full-init.sql');

function sqlVal(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  return `'${String(val).replace(/'/g, "''")}'`;
}

function buildSchemaSqlCore() {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const chunks = [];
  chunks.push(`CREATE TABLE IF NOT EXISTS public.schema_migrations (`);
  chunks.push(`  filename text PRIMARY KEY,`);
  chunks.push(`  applied_at timestamptz NOT NULL DEFAULT now(),`);
  chunks.push(`  checksum text NOT NULL`);
  chunks.push(`);\n`);

  chunks.push(`DO $$`);
  chunks.push(`BEGIN`);
  chunks.push(`  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_app') THEN`);
  chunks.push(`    CREATE ROLE hms_app NOLOGIN NOBYPASSRLS;`);
  chunks.push(`  END IF;`);
  chunks.push(`  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_portal') THEN`);
  chunks.push(`    CREATE ROLE hms_portal NOLOGIN NOBYPASSRLS;`);
  chunks.push(`  END IF;`);
  chunks.push(`  BEGIN`);
  chunks.push(`    EXECUTE format('GRANT hms_app TO %I', current_user);`);
  chunks.push(`    EXECUTE format('GRANT hms_portal TO %I', current_user);`);
  chunks.push(`  EXCEPTION WHEN OTHERS THEN NULL;`);
  chunks.push(`  END;`);
  chunks.push(`  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN`);
  chunks.push(`    BEGIN`);
  chunks.push(`      GRANT hms_app TO postgres;`);
  chunks.push(`      GRANT hms_portal TO postgres;`);
  chunks.push(`    EXCEPTION WHEN OTHERS THEN NULL;`);
  chunks.push(`    END;`);
  chunks.push(`  END IF;`);
  chunks.push(`END $$;\n`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    chunks.push(`-- ----------------------------------------------------------------------------`);
    chunks.push(`-- Migration: ${file} (sha256: ${checksum})`);
    chunks.push(`-- ----------------------------------------------------------------------------`);
    chunks.push(sql.trimEnd());
    chunks.push(
      `\nINSERT INTO public.schema_migrations (filename, checksum)\nVALUES (${sqlVal(file)}, ${sqlVal(checksum)})\nON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;\n`,
    );
  }

  return { files, coreSql: chunks.join('\n') };
}

async function generateSqlBundles() {
  const { files, coreSql } = buildSchemaSqlCore();

  const schemaDoc = [
    `-- ============================================================================`,
    `-- HMS Enterprise — Supabase Schema & RLS Bootstrap (Schema Only)`,
    `-- Project : https://pxawcoccgcuzoustyugh.supabase.co`,
    `-- Pooler  : aws-0-ap-northeast-2.pooler.supabase.com:5432 (user: postgres.pxawcoccgcuzoustyugh)`,
    `-- Includes: ${files.length} migrations (${files[0]} .. ${files[files.length - 1]})`,
    `-- Use this file when connecting Vercel with SEED_DEMO=true so the API seeds`,
    `-- encrypted demo records using Vercel's ENCRYPTION_KEY & SEARCH_HASH_KEY.`,
    `-- ============================================================================\n`,
    `BEGIN;\n`,
    coreSql,
    `COMMIT;\n`,
  ].join('\n');
  fs.writeFileSync(outSchemaPath, schemaDoc, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[supabase] wrote ${path.relative(rootDir, outSchemaPath)} (${files.length} migrations, ${(schemaDoc.length / 1024).toFixed(1)} KiB)`);

  // Also build `db/supabase-full-init.sql` by running our real PGlite seed and exporting
  // non-key-dependent operational & auth tables (29 demo accounts, roles, permissions, facilities, beds, drugs, labs).
  const tmpDir = path.join(rootDir, 'apps', 'api', '.data', 'supabase-export-tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const exportScript = `
    process.env.NODE_ENV = 'development';
    process.env.DB_MODE = 'pglite';
    process.env.PGLITE_DIR = ${JSON.stringify(tmpDir)};
    (async () => {
      const { getDb, runMigrations, closeDb } = await import('./src/db/index.ts');
      const { seedDatabase } = await import('./src/db/seed.ts');
      const db = await getDb();
      await runMigrations(db);
      await seedDatabase();
      const tableNames = [
        'facilities',
        'departments',
        'operating_theatres',
        'roles',
        'permissions',
        'role_permissions',
        'users',
        'user_facilities',
        'user_roles',
        'wards',
        'rooms',
        'beds',
        'lab_tests',
        'drugs',
        'drug_batches',
        'drug_interactions',
        'cssd_instrument_sets',
        'app_settings',
      ];
      const dump = {};
      for (const name of tableNames) {
        const colRes = await db.query(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position",
          [name],
        );
        const cols = colRes.rows
          .map((r) => r.column_name)
          .filter((c) => name !== 'users' || c !== 'patient_id');
        const res = await db.query('SELECT ' + cols.join(', ') + ' FROM ' + name);
        dump[name] = { cols, rows: res.rows };
      }
      await closeDb();
      console.log('__DUMP_START__' + JSON.stringify(dump) + '__DUMP_END__');
    })().catch((e) => { console.error(e); process.exit(1); });
  `;

  const proc = spawnSync('npx', ['tsx', '-e', exportScript], {
    cwd: path.join(rootDir, 'apps', 'api'),
    encoding: 'utf8',
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(path.join(rootDir, 'apps', 'api', '.data'), { recursive: true, force: true });

  if (proc.status !== 0) {
    throw new Error(`Failed to export seed SQL: ${proc.stderr || proc.stdout}`);
  }
  const match = proc.stdout.match(/__DUMP_START__([\s\S]+)__DUMP_END__/);
  if (!match) throw new Error('Missing dump payload from seed exporter');
  const dump = JSON.parse(match[1]);

  const seedLines = [];
  seedLines.push(`\n-- ============================================================================`);
  seedLines.push(`-- Operational & Authentication Seed (29 Demo Accounts + Reference Catalog)`);
  seedLines.push(`-- ============================================================================\n`);
  for (const [tableName, { cols, rows }] of Object.entries(dump)) {
    if (!rows.length) continue;
    seedLines.push(`-- Table: ${tableName} (${rows.length} rows)`);
    for (const row of rows) {
      const vals = cols.map((c) => sqlVal(row[c])).join(', ');
      seedLines.push(`INSERT INTO public.${tableName} (${cols.join(', ')}) VALUES (${vals}) ON CONFLICT DO NOTHING;`);
    }
    seedLines.push('');
  }

  const fullDoc = [
    `-- ============================================================================`,
    `-- HMS Enterprise — Complete 1-Click Supabase SQL Editor Bootstrap`,
    `-- Project : https://pxawcoccgcuzoustyugh.supabase.co`,
    `-- Pooler  : aws-0-ap-northeast-2.pooler.supabase.com:5432 (user: postgres.pxawcoccgcuzoustyugh)`,
    `-- Includes: All ${files.length} migrations (89 tables + RLS + PostgREST anon lockdown)`,
    `--           + 2 facilities, 8 departments, 25 roles, 98 permissions,`,
    `--           + ALL 29 demo login accounts (Argon2id), wards/beds, lab tests, drugs & CSSD sets.`,
    `--`,
    `-- Paste into: https://supabase.com/dashboard/project/pxawcoccgcuzoustyugh/sql/new -> Run`,
    `-- ============================================================================\n`,
    `BEGIN;\n`,
    coreSql,
    seedLines.join('\n'),
    `COMMIT;\n`,
  ].join('\n');

  fs.writeFileSync(outFullPath, fullDoc, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[supabase] wrote ${path.relative(rootDir, outFullPath)} (${files.length} migrations + 29 demo users, ${(fullDoc.length / 1024).toFixed(1)} KiB)`);
}

const args = process.argv.slice(2);
if (args.includes('--emit-sql')) {
  await generateSqlBundles();
  process.exit(0);
}

const pass = process.env.SUPABASE_DB_PASSWORD?.trim();
const host = process.env.SUPABASE_DB_HOST?.trim() || 'aws-0-ap-northeast-2.pooler.supabase.com';
const port = process.env.SUPABASE_DB_PORT?.trim() || '5432';
const user = process.env.SUPABASE_DB_USER?.trim() || 'postgres.pxawcoccgcuzoustyugh';
const dbName = process.env.SUPABASE_DB_NAME?.trim() || 'postgres';

const rawUrl =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL ||
  (pass ? `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(dbName)}` : '');

if (!rawUrl || rawUrl.includes('[YOUR-PASSWORD]')) {
  await generateSqlBundles();
  // eslint-disable-next-line no-console
  console.error(
    '\n[supabase] Database password is still set to the [YOUR-PASSWORD] placeholder.\n' +
      '  • Ready-to-run SQL files have been generated:\n' +
      '      1) db/supabase-full-init.sql (19 migrations + 29 demo users + facilities/beds/drugs/labs)\n' +
      '      2) db/supabase-schema.sql    (19 migrations schema-only)\n' +
      '  • Set SUPABASE_DB_PASSWORD (or DATABASE_URL with your real DB password) in Vercel\n' +
      '    Environment Variables to connect https://hospital-hms-cyan.vercel.app directly.\n',
  );
  process.exit(1);
}

await generateSqlBundles();

const env = {
  ...process.env,
  DB_MODE: 'postgres',
  DATABASE_URL: rawUrl,
};

for (const step of ['migrate', 'seed']) {
  // eslint-disable-next-line no-console
  console.log(`[supabase] running db:${step} against ${host}:${port}...`);
  const res = spawnSync('npx', ['tsx', 'src/db/cli.ts', step], {
    cwd: path.join(rootDir, 'apps', 'api'),
    env,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

// eslint-disable-next-line no-console
console.log('[supabase] database initialized and seeded successfully.');

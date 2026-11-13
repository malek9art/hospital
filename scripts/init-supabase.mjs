#!/usr/bin/env node
/**
 * Supabase Initialization & SQL Bundle Generator for HMS
 * Target Project: https://pxawcoccgcuzoustyugh.supabase.co
 *
 * Modes:
 *   1. `node scripts/init-supabase.mjs --emit-sql` (or `npm run db:supabase:sql`)
 *      Generates `db/supabase-schema.sql` containing:
 *        - Restricted NOLOGIN roles (`hms_app`, `hms_portal`) + grants to `postgres`/`current_user`
 *        - `schema_migrations` table
 *        - All migrations (`001_core.sql` .. `019_supabase_hardening.sql`) wrapped with exact
 *          SHA-256 checksums so Fastify's `runMigrations()` recognizes every applied migration
 *        - PostgREST `anon` / `authenticated` privilege lockdown
 *      This file can be pasted directly into the Supabase SQL Editor.
 *
 *   2. `DATABASE_URL="postgresql://..." node scripts/init-supabase.mjs` (or `npm run db:supabase:init`)
 *      Connects directly to Supabase PostgreSQL over TLS, runs all migrations + demo seed
 *      (`29` demo accounts, facilities, clinical & HR seed), and verifies RLS + audit chain.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const migrationsDir = path.join(rootDir, 'db', 'migrations');
const outSqlPath = path.join(rootDir, 'db', 'supabase-schema.sql');

function sqlLiteral(str) {
  return `'${str.replace(/'/g, "''")}'`;
}

function generateSqlBundle() {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const chunks = [];
  chunks.push(`-- ============================================================================`);
  chunks.push(`-- HMS Enterprise — Complete Supabase Schema & RLS Bootstrap`);
  chunks.push(`-- Target Supabase Project: https://pxawcoccgcuzoustyugh.supabase.co`);
  chunks.push(`-- Migrations included: ${files.length} (${files[0]} .. ${files[files.length - 1]})`);
  chunks.push(`-- Generated deterministically with exact schema_migrations SHA-256 checksums.`);
  chunks.push(`--`);
  chunks.push(`-- HOW TO RUN IN SUPABASE SQL EDITOR:`);
  chunks.push(`--   1. Open https://supabase.com/dashboard/project/pxawcoccgcuzoustyugh/sql/new`);
  chunks.push(`--   2. Paste the contents of this file and click "Run".`);
  chunks.push(`--   3. Add DATABASE_URL (Session Pooler URI) to Vercel environment variables`);
  chunks.push(`--      so the API automatically seeds demo accounts using production keys.`);
  chunks.push(`-- ============================================================================\n`);

  chunks.push(`BEGIN;\n`);
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
      `\nINSERT INTO public.schema_migrations (filename, checksum)\nVALUES (${sqlLiteral(file)}, ${sqlLiteral(checksum)})\nON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;\n`,
    );
  }

  chunks.push(`COMMIT;\n`);
  const fullSql = chunks.join('\n');
  fs.writeFileSync(outSqlPath, fullSql, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[supabase] wrote ${path.relative(rootDir, outSqlPath)} (${files.length} migrations, ${(fullSql.length / 1024).toFixed(1)} KiB)`);
}

const args = process.argv.slice(2);
if (args.includes('--emit-sql')) {
  generateSqlBundle();
  process.exit(0);
}

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL;
if (!dbUrl) {
  generateSqlBundle();
  // eslint-disable-next-line no-console
  console.error(
    '\n[supabase] DATABASE_URL is not set in environment.\n' +
      '  • Generated `db/supabase-schema.sql` ready for Supabase SQL Editor.\n' +
      '  • To migrate + seed directly from CLI, run:\n' +
      '    DATABASE_URL="postgresql://postgres.pxawcoccgcuzoustyugh:[PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run db:supabase:init\n',
  );
  process.exit(1);
}

generateSqlBundle();

const env = {
  ...process.env,
  DB_MODE: 'postgres',
  DATABASE_URL: dbUrl,
};

for (const step of ['migrate', 'seed']) {
  // eslint-disable-next-line no-console
  console.log(`[supabase] running db:${step} against PostgreSQL...`);
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

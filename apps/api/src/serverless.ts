import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { config } from './config';
import { getDb, runMigrations } from './db';
import { seedDatabase } from './db/seed';
import { buildServer } from './server';

/**
 * Serverless entry point (Vercel). A single Fastify instance is built lazily and
 * reused across invocations of the same warm function. On a cold start the demo
 * database is migrated and seeded when it is empty (HMS_AUTO_BOOTSTRAP).
 */
let appPromise: Promise<FastifyInstance> | null = null;

async function bootstrap(): Promise<FastifyInstance> {
  const cfg = config();
  const db = await getDb();
  const check = await db.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`);
  if (!check.rows[0]?.t) {
    if (!cfg.AUTO_BOOTSTRAP) {
      throw new Error('Database is not migrated. Run "npm run db:migrate" before starting.');
    }
    const started = Date.now();
    await runMigrations(db);
    if (cfg.SEED_DEMO) await seedDatabase();
    // eslint-disable-next-line no-console
    console.log(`[serverless] bootstrapped database in ${Date.now() - started}ms`);
  }
  const app = await buildServer({ serveWeb: false, logger: cfg.NODE_ENV === 'production' });
  await app.ready();
  return app;
}

export function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = bootstrap().catch((err) => {
      appPromise = null; // allow the next invocation to retry
      throw err;
    });
  }
  return appPromise;
}

export async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await getApp();
    app.server.emit('request', req, res);
  } catch (err) {
    // Never turn a bootstrap failure into an opaque platform 500: the reason is
    // logged server-side and a short, non-sensitive code is returned to clients.
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[serverless] bootstrap failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: { code: 'bootstrap_failed', message: 'تعذر تهيئة الخدمة', details: message },
        }),
      );
    }
  }
}

export default handler;

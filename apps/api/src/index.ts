import { config } from './config';
import { getDb, closeDb, runMigrations } from './db';
import { seedDatabase } from './db/seed';
import { buildServer } from './server';

async function main() {
  const cfg = config();
  const db = await getDb();

  if (cfg.NODE_ENV !== 'production') {
    await runMigrations(db);
    if (cfg.SEED_DEMO) {
      const result = await seedDatabase();
      if (result.seeded) console.log('[seed] synthetic demo data created');
    }
  } else {
    const check = await db.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    if (!(check.rows[0] as any)?.t) {
      throw new Error('Database is not migrated. Run "npm run db:migrate" before starting in production.');
    }
  }

  const app = await buildServer();
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  console.log(`[api] listening on http://${cfg.HOST}:${cfg.PORT} (db=${cfg.DB_MODE})`);

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} received, shutting down`);
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[api] fatal', err);
  process.exit(1);
});

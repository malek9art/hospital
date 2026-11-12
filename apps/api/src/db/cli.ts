import fs from 'node:fs';
import { config } from '../config';
import { getDb, closeDb, runMigrations } from './index';
import { seedDatabase } from './seed';

async function main() {
  const cmd = process.argv[2] ?? 'migrate';
  const cfg = config();
  if (cmd === 'reset') {
    if (cfg.DB_MODE === 'pglite') {
      if (fs.existsSync(cfg.PGLITE_DIR)) fs.rmSync(cfg.PGLITE_DIR, { recursive: true, force: true });
      console.log(`[db] removed ${cfg.PGLITE_DIR}`);
    } else {
      throw new Error('reset is only supported for DB_MODE=pglite');
    }
    const db = await getDb();
    await runMigrations(db);
    if (cfg.SEED_DEMO) console.log('[db] seed:', await seedDatabase());
    await closeDb();
    return;
  }
  const db = await getDb();
  if (cmd === 'migrate' || cmd === 'up') {
    const count = await runMigrations(db);
    console.log(`[db] migrations up to date (${count} files)`);
  } else if (cmd === 'seed') {
    console.log('[db] seed:', await seedDatabase({ force: process.argv.includes('--force') }));
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
  await closeDb();
}
main().catch((err) => {
  console.error('[db] failed:', err.message);
  process.exit(1);
});

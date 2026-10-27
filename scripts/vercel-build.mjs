// Build helper for Vercel: the SPA is served as static files from /public while
// all /api/* traffic is handled by the single serverless function in api/index.ts.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'apps/web/dist');
const out = path.join(root, 'public');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('[vercel-build] apps/web/dist/index.html is missing - run the web build first');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

const files = fs.readdirSync(out);
console.log(`[vercel-build] copied ${files.length} entries from apps/web/dist to public/`);

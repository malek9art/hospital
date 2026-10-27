// Local harness for the serverless entry point: wraps the Vercel handler in a
// plain HTTP server so the deployment path can be verified before deploying.
//   npx tsx scripts/serverless-dev.ts
import http from 'node:http';
import { handler } from '../apps/api/src/serverless';

const port = Number(process.env.PORT ?? 8099);
http
  .createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('[serverless-dev]', err);
      if (!res.headersSent) res.writeHead(500).end('internal error');
    });
  })
  .listen(port, '0.0.0.0', () => console.log(`[serverless-dev] http://0.0.0.0:${port}`));

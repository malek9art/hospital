#!/usr/bin/env node
/**
 * Reproducible API latency benchmark across 20 key endpoints.
 * Reports min / avg / p50 / p95 / max in milliseconds against a live server.
 *
 * Usage:
 *   node scripts/perf-bench.mjs [--url=http://127.0.0.1:8080] [--samples=7]
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const BASE_URL = (args.url ?? process.env.BENCH_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const SAMPLES = Math.max(3, Number(args.samples ?? 7));

async function login(email, password) {
  const r = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Login failed for ${email}: ${r.status}`);
  const setCookie = r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return cookie;
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const cookies = {
    admin: await login('admin@demo.hms', 'Admin#Demo2026'),
    doctor: await login('dr.ahmed@demo.hms', 'Doctor#Demo2026'),
    intensivist: await login('intensivist@demo.hms', 'ICU#Demo2026'),
    nurse: await login('nurse@demo.hms', 'Nurse#Demo2026'),
    dietitian: await login('dietitian@demo.hms', 'Nutrition#Demo2026'),
    cssd: await login('cssd@demo.hms', 'CSSD#Demo2026'),
    infection: await login('infection@demo.hms', 'Infection#Demo2026'),
    bloodbank: await login('bloodbank@demo.hms', 'Blood#Demo2026'),
    accountant: await login('accountant@demo.hms', 'Account#Demo2026'),
    patient: await login('patient@demo.hms', 'Patient#Demo2026'),
  };

  const routes = [
    { name: 'GET /api/health', path: '/api/health', role: null },
    { name: 'GET /api/auth/me', path: '/api/auth/me', role: 'doctor' },
    { name: 'GET /api/meta/bootstrap', path: '/api/meta/bootstrap', role: 'doctor' },
    { name: 'GET /api/dashboard?days=7', path: '/api/dashboard?days=7', role: 'admin' },
    { name: 'GET /api/dashboard?days=30', path: '/api/dashboard?days=30', role: 'admin' },
    { name: 'GET /api/search?q=MRN', path: '/api/search?q=MRN', role: 'doctor' },
    { name: 'GET /api/patients', path: '/api/patients?limit=25', role: 'doctor' },
    { name: 'GET /api/appointments', path: '/api/appointments?limit=25', role: 'doctor' },
    { name: 'GET /api/emergency/board', path: '/api/emergency/board', role: 'doctor' },
    { name: 'GET /api/inpatient/beds', path: '/api/inpatient/beds', role: 'doctor' },
    { name: 'GET /api/nursing/board', path: '/api/nursing/board', role: 'nurse' },
    { name: 'GET /api/surgery/board', path: '/api/surgery/board?status=active', role: 'doctor' },
    { name: 'GET /api/icu/board', path: '/api/icu/board', role: 'intensivist' },
    { name: 'GET /api/bloodbank/stock', path: '/api/bloodbank/stock', role: 'bloodbank' },
    { name: 'GET /api/nutrition/board', path: '/api/nutrition/board', role: 'dietitian' },
    { name: 'GET /api/cssd/board', path: '/api/cssd/board', role: 'cssd' },
    { name: 'GET /api/infection/board', path: '/api/infection/board', role: 'infection' },
    { name: 'GET /api/billing/summary', path: '/api/billing/summary', role: 'accountant' },
    { name: 'GET /api/audit/verify', path: '/api/audit/verify', role: 'admin' },
    { name: 'GET /api/portal/summary', path: '/api/portal/summary', role: 'patient' },
  ];

  // Warmup pass
  for (const r of routes) {
    const res = await fetch(`${BASE_URL}${r.path}`, {
      headers: r.role ? { cookie: cookies[r.role] } : {},
    });
    if (res.status !== 200) {
      throw new Error(`Warmup failed on ${r.name}: HTTP ${res.status}`);
    }
    await res.arrayBuffer();
  }

  const results = [];
  for (const r of routes) {
    const times = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      const res = await fetch(`${BASE_URL}${r.path}`, {
        headers: r.role ? { cookie: cookies[r.role] } : {},
      });
      await res.arrayBuffer();
      const dt = performance.now() - t0;
      if (res.status !== 200) throw new Error(`${r.name} returned HTTP ${res.status}`);
      times.push(dt);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    results.push({
      route: r.name,
      min: Number(times[0].toFixed(1)),
      avg: Number(avg.toFixed(1)),
      p50: Number(pct(times, 50).toFixed(1)),
      p95: Number(pct(times, 95).toFixed(1)),
      max: Number(times[times.length - 1].toFixed(1)),
    });
  }

  console.table(results);
}

main().catch((e) => {
  console.error('[perf-bench FAILED]', e);
  process.exit(1);
});

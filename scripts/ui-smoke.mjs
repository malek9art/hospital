#!/usr/bin/env node
/**
 * Headless UI/API smoke verification across all demo roles and visible pages.
 *
 * Verifies without a browser (Playwright is unavailable in offline sandboxes):
 *  1. /api/health returns { ok: true, mode, persistence } as JSON.
 *  2. Unauthenticated requests to protected /api/* routes return 401 JSON (never HTML),
 *     and unknown /api/* routes return 404 JSON.
 *  3. Static SPA index (/) serves HTML when built.
 *  4. Every demo role logs in, loads /api/auth/me, visits every page permitted to
 *     that role, fetches the page's backing endpoints, validates required fields,
 *     checks zero 5xx and zero "undefined"/"NaN" in display fields, and logs out.
 *
 * Usage:
 *   node scripts/ui-smoke.mjs [--url=http://127.0.0.1:8080] [--batch=1|2|3|all]
 *
 * Note on rate limits: /api/auth/login enforces 10 requests/minute per IP.
 * Run batches 1, 2, 3 across fresh server restarts (recommended in CI/dev), or
 * run --batch=all which respects x-ratelimit-reset automatically.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const BASE_URL = (args.url ?? process.env.SMOKE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const BATCH = args.batch ?? 'all';

/** All demo accounts from Section 1 + role-specific clinical accounts. */
const ACCOUNTS = [
  // Batch 1 (9 accounts <= 10/min auth rate limit)
  { batch: '1', label: 'مدير النظام', email: 'admin@demo.hms', password: 'Admin#Demo2026' },
  { batch: '1', label: 'طبيب', email: 'dr.ahmed@demo.hms', password: 'Doctor#Demo2026' },
  { batch: '1', label: 'استقبال', email: 'reception@demo.hms', password: 'Reception#Demo2026' },
  { batch: '1', label: 'سجلات', email: 'records@demo.hms', password: 'Records#Demo2026' },
  { batch: '1', label: 'مختبر (إدخال)', email: 'lab@demo.hms', password: 'Lab#Demo2026' },
  { batch: '1', label: 'مختبر (اعتماد)', email: 'lab2@demo.hms', password: 'Lab#Demo2026' },
  { batch: '1', label: 'صيدلي', email: 'pharmacist@demo.hms', password: 'Pharma#Demo2026' },
  { batch: '1', label: 'محاسب', email: 'accountant@demo.hms', password: 'Account#Demo2026' },
  { batch: '1', label: 'بنك الدم', email: 'bloodbank@demo.hms', password: 'Blood#Demo2026' },
  // Batch 2 (9 accounts <= 10/min auth rate limit)
  { batch: '2', label: 'أخصائي تغذية', email: 'dietitian@demo.hms', password: 'Nutrition#Demo2026' },
  { batch: '2', label: 'مطبخ', email: 'kitchen@demo.hms', password: 'Kitchen#Demo2026' },
  { batch: '2', label: 'تعقيم', email: 'cssd@demo.hms', password: 'CSSD#Demo2026' },
  { batch: '2', label: 'اعتماد التعقيم', email: 'cssd2@demo.hms', password: 'CSSD#Demo2026' },
  { batch: '2', label: 'مكافحة العدوى', email: 'infection@demo.hms', password: 'Infection#Demo2026' },
  { batch: '2', label: 'جراح', email: 'surgeon@demo.hms', password: 'Surgeon#Demo2026' },
  { batch: '2', label: 'تخدير', email: 'anesthesia@demo.hms', password: 'Anesthesia#Demo2026' },
  { batch: '2', label: 'تمريض عمليات', email: 'ornurse@demo.hms', password: 'Nurse#Demo2026' },
  { batch: '2', label: 'طبيب عناية مركزة', email: 'intensivist@demo.hms', password: 'ICU#Demo2026' },
  // Batch 3 (8 accounts <= 10/min auth rate limit)
  { batch: '3', label: 'تمريض عناية مركزة', email: 'icunurse@demo.hms', password: 'ICU#Demo2026' },
  { batch: '3', label: 'تمريض جناح', email: 'nurse@demo.hms', password: 'Nurse#Demo2026' },
  { batch: '3', label: 'فني أشعة', email: 'radiology@demo.hms', password: 'Radiology#Demo2026' },
  { batch: '3', label: 'استشاري أشعة', email: 'radiologist@demo.hms', password: 'Radiology#Demo2026' },
  { batch: '3', label: 'موارد بشرية (إدخال)', email: 'hr@demo.hms', password: 'HR#Demo2026' },
  { batch: '3', label: 'مشرف تراخيص وإجازات', email: 'hr2@demo.hms', password: 'HR#Demo2026' },
  { batch: '3', label: 'مدقق', email: 'auditor@demo.hms', password: 'Auditor#Demo2026' },
  { batch: '3', label: 'مريض (بوابة)', email: 'patient@demo.hms', password: 'Patient#Demo2026' },
];

/**
 * Page definitions mirroring the web navigation and the exact API calls each page makes on mount.
 */
const PAGES = [
  {
    key: 'dashboard',
    perms: ['report.read'],
    checks: [
      { path: '/api/dashboard?days=7', keys: ['kpis', 'byDepartment', 'trend', 'bedsByWard', 'actionableAlerts', 'notifications'] },
      { path: '/api/dashboard?days=30', keys: ['days', 'trend'] },
    ],
  },
  {
    key: 'patients',
    perms: ['patient.read'],
    checks: [
      { path: '/api/patients?search=', keys: ['items'] },
      { path: '/api/search?q=MRN', keys: ['items'] },
    ],
  },
  {
    key: 'appointments',
    perms: ['appointment.read'],
    checks: [
      { path: '/api/appointments?limit=50', keys: ['items'] },
      { path: '/api/meta/bootstrap', keys: ['departments', 'doctors', 'labTests', 'drugs'] },
    ],
  },
  {
    key: 'clinic',
    perms: ['clinical.encounter.read'],
    checks: [{ path: '/api/meta/bootstrap', keys: ['departments', 'doctors'] }],
  },
  {
    key: 'emergency',
    perms: ['emergency.triage'],
    checks: [{ path: '/api/emergency/board', keys: ['items', 'byLevel'] }],
  },
  {
    key: 'inpatient',
    perms: ['inpatient.admit', 'inpatient.bed.manage'],
    checks: [{ path: '/api/inpatient/beds', keys: ['beds', 'wards', 'summary'] }],
  },
  {
    key: 'nursing',
    perms: ['nursing.read'],
    checks: [{ path: '/api/nursing/board', keys: ['items', 'totals'] }],
  },
  {
    key: 'surgery',
    perms: ['surgery.read'],
    checks: [
      { path: '/api/surgery/board?status=active', keys: ['items', 'totals', 'checklist'] },
      { path: '/api/surgery/theatres', keys: ['items'] },
    ],
  },
  {
    key: 'icu',
    perms: ['icu.read'],
    checks: [{ path: '/api/icu/board', keys: ['items', 'totals'] }],
  },
  {
    key: 'bloodbank',
    perms: ['bloodbank.read'],
    checks: [
      { path: '/api/bloodbank/stock', keys: ['grid', 'units', 'totals'] },
      { path: '/api/bloodbank/requests?status=active', keys: ['items'] },
    ],
  },
  {
    key: 'nutrition',
    perms: ['nutrition.read', 'nutrition.kitchen'],
    checks: [
      { path: '/api/nutrition/board', perm: 'nutrition.read', keys: ['items', 'totals'] },
      { path: '/api/nutrition/kitchen', perm: 'nutrition.kitchen', keys: ['items', 'totals'] },
    ],
  },
  {
    key: 'cssd',
    perms: ['cssd.read', 'infection.read'],
    checks: [
      { path: '/api/cssd/board', perm: 'cssd.read', keys: ['packs', 'loads', 'sets', 'totals'] },
      { path: '/api/infection/board', perm: 'infection.read', keys: ['isolations', 'cases', 'hygiene', 'totals'] },
    ],
  },
  {
    key: 'lab',
    perms: ['lab.sample.collect'],
    checks: [{ path: '/api/lab/worklist?status=all', keys: ['items'] }],
  },
  {
    key: 'radiology',
    perms: ['radiology.read', 'radiology.perform', 'radiology.report', 'radiology.verify'],
    checks: [{ path: '/api/radiology/worklist?status=active', keys: ['items'] }],
  },
  {
    key: 'pharmacy',
    perms: ['pharmacy.prescription.read'],
    checks: [{ path: '/api/pharmacy/prescriptions', keys: ['items'] }],
  },
  {
    key: 'billing',
    perms: ['billing.invoice.read'],
    checks: [
      { path: '/api/billing/invoices?limit=50', keys: ['items'] },
      { path: '/api/billing/summary', keys: ['today_billed', 'today_collected', 'outstanding'] },
    ],
  },
  {
    key: 'hr',
    perms: ['hr.read', 'hr.self'],
    checks: [
      { path: '/api/hr/board', perm: 'hr.read', keys: ['totals', 'employees', 'credentials', 'shifts', 'leaves', 'expiringLicenses'] },
      { path: '/api/hr/me', perm: 'hr.self', keys: ['employee', 'credentials', 'shifts', 'leaves'] },
    ],
  },
  {
    key: 'reports',
    perms: ['report.read'],
    checks: [
      { path: '/api/reports', keys: ['reports'] },
      { path: '/api/reports/visits', keys: ['title', 'columns', 'rows'] },
    ],
  },
  {
    key: 'audit',
    perms: ['audit.read'],
    checks: [
      { path: '/api/audit?limit=20', keys: ['items'] },
      { path: '/api/audit/verify', keys: ['ok', 'checked'] },
    ],
  },
  {
    key: 'admin',
    perms: ['admin.users.read', 'admin.sessions.manage', 'admin.facility.manage'],
    checks: [
      { path: '/api/admin/users?limit=25', perm: 'admin.users.read', keys: ['items'] },
      { path: '/api/admin/roles', perm: 'admin.users.read', keys: ['roles', 'permissions'] },
      { path: '/api/admin/sessions', perm: 'admin.sessions.manage', keys: ['items'] },
      { path: '/api/admin/facilities', perm: 'admin.facility.manage', keys: ['items', 'stats'] },
    ],
  },
  {
    key: 'modules',
    perms: ['patient.read'],
    checks: [{ path: '/api/meta/modules', keys: ['modules'] }],
  },
  {
    key: 'portal',
    perms: ['portal.self'],
    checks: [{ path: '/api/portal/summary', keys: ['patient', 'appointments', 'results', 'prescriptions', 'invoices'] }],
  },
];

const SENSITIVE_DISPLAY_KEYS = new Set([
  'fullNameAr', 'full_name_ar', 'patient_name', 'patientName', 'mrn',
  'appointmentNo', 'appointment_no', 'encounter_no', 'order_no', 'invoice_no',
  'prescription_no', 'admission_no', 'case_no', 'stay_no', 'unit_no',
  'request_no', 'pack_no', 'load_no', 'employee_no',
]);

function scanBadStrings(val, path = 'root', issues = []) {
  if (val === null || val === undefined) return issues;
  if (typeof val === 'string') {
    const leaf = path.split('.').pop() ?? '';
    if (val === 'undefined' || val === 'NaN' || (SENSITIVE_DISPLAY_KEYS.has(leaf) && val.includes('undefined'))) {
      issues.push(`${path}="${val}"`);
    }
    return issues;
  }
  if (Array.isArray(val)) {
    for (let i = 0; i < Math.min(val.length, 25); i++) scanBadStrings(val[i], `${path}[${i}]`, issues);
    return issues;
  }
  if (typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) scanBadStrings(v, `${path}.${k}`, issues);
  }
  return issues;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reqJson(path, { method = 'GET', cookie = '', csrf = '', body } = {}) {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const ms = Math.round(performance.now() - t0);
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let json = null;
  if (contentType.includes('application/json')) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { status: res.status, ms, contentType, json, text, headers: res.headers };
}

async function runPreAuthProbes(results, failures) {
  // 1. Health
  const h = await reqJson('/api/health');
  const healthOk =
    h.status === 200 &&
    h.json?.ok === true &&
    ['pglite', 'postgres'].includes(h.json?.mode) &&
    ['ephemeral', 'durable'].includes(h.json?.persistence);
  results.push({
    role: 'بدون جلسة',
    page: `GET /api/health (${h.json?.mode}/${h.json?.persistence})`,
    status: healthOk ? '200 OK' : `FAIL ${h.status}`,
    ms: h.ms,
  });
  if (!healthOk) failures.push(`/api/health invalid: status=${h.status} body=${h.text.slice(0, 160)}`);

  // 2. SPA HTML shell
  const root = await fetch(`${BASE_URL}/`);
  const rootCt = root.headers.get('content-type') ?? '';
  const rootText = await root.text();
  const spaOk = root.status === 200 && rootCt.includes('text/html') && rootText.includes('<div id="root">');
  results.push({
    role: 'بدون جلسة',
    page: 'GET / (SPA HTML)',
    status: spaOk ? '200 HTML' : `WARN ${root.status}`,
    ms: 0,
  });

  // 3. Unauthenticated protected routes must return 401 JSON (never HTML)
  for (const p of ['/api/auth/me', '/api/dashboard', '/api/patients', '/api/cssd/board']) {
    const r = await reqJson(p);
    const ok401 = r.status === 401 && r.contentType.includes('application/json') && r.json?.error?.code === 'unauthorized';
    results.push({
      role: 'بدون جلسة',
      page: `حماية ${p}`,
      status: ok401 ? '401 JSON' : `FAIL ${r.status}`,
      ms: r.ms,
    });
    if (!ok401) failures.push(`Expected 401 JSON on ${p}, got status=${r.status} ct=${r.contentType}`);
  }

  // 4. Unknown API route must return 404 JSON (never SPA fallback HTML)
  const nf = await reqJson('/api/__nonexistent_probe__');
  const ok404 = nf.status === 404 && nf.contentType.includes('application/json');
  results.push({
    role: 'بدون جلسة',
    page: 'مسار مجهول /api/__nonexistent__',
    status: ok404 ? '404 JSON' : `FAIL ${nf.status}`,
    ms: nf.ms,
  });
  if (!ok404) failures.push(`Expected 404 JSON on unknown /api/* route, got status=${nf.status} ct=${nf.contentType}`);
}

async function loginWithRateLimitRespect(account) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await reqJson('/api/auth/login', {
      method: 'POST',
      body: { email: account.email, password: account.password },
    });
    if (res.status === 429 && attempt < 3) {
      const resetSec = Number(res.headers.get('x-ratelimit-reset') ?? 61);
      const waitMs = Math.min(Math.max(resetSec, 5), 65) * 1000 + 500;
      console.log(`[rate-limit] 429 on login for ${account.email}; waiting ${Math.round(waitMs / 1000)}s for window reset...`);
      await sleep(waitMs);
      continue;
    }
    const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
    const sessionPair = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('hms_session='));
    const remaining = res.headers.get('x-ratelimit-remaining');
    return { ...res, cookie: sessionPair ?? '', remaining: remaining !== null ? Number(remaining) : null };
  }
  throw new Error(`Failed login after retries for ${account.email}`);
}

async function main() {
  const selected = BATCH === 'all' ? ACCOUNTS : ACCOUNTS.filter((a) => a.batch === String(BATCH));
  if (selected.length === 0) {
    console.error(`No accounts matched --batch=${BATCH}`);
    process.exit(1);
  }

  console.log(`\n=== HMS UI/API Smoke Suite ===`);
  console.log(`Target: ${BASE_URL} | Batch: ${BATCH} (${selected.length} accounts)\n`);

  const results = [];
  const failures = [];

  if (BATCH === 'all' || BATCH === '1') {
    await runPreAuthProbes(results, failures);
  }

  for (let idx = 0; idx < selected.length; idx++) {
    const acc = selected[idx];
    const loginRes = await loginWithRateLimitRespect(acc);
    if (loginRes.status !== 200 || !loginRes.cookie || !loginRes.json?.csrfToken) {
      results.push({ role: acc.label, page: 'auth/login', status: `FAIL ${loginRes.status}`, ms: loginRes.ms });
      failures.push(`${acc.email} login failed: status=${loginRes.status} body=${loginRes.text.slice(0, 140)}`);
      continue;
    }

    const cookie = loginRes.cookie;
    const csrf = loginRes.json.csrfToken;

    const meRes = await reqJson('/api/auth/me', { cookie });
    if (meRes.status !== 200 || !meRes.json?.user?.id || !Array.isArray(meRes.json?.permissions)) {
      results.push({ role: acc.label, page: 'auth/me', status: `FAIL ${meRes.status}`, ms: meRes.ms });
      failures.push(`${acc.email} /api/auth/me invalid: status=${meRes.status}`);
      continue;
    }
    const badMe = scanBadStrings(meRes.json);
    if (badMe.length) failures.push(`${acc.email} /api/auth/me bad strings: ${badMe.join(', ')}`);

    const perms = new Set(meRes.json.permissions);
    const visiblePages = PAGES.filter((p) => p.perms.some((perm) => perms.has(perm)));

    for (const page of visiblePages) {
      let pageMs = 0;
      let pageOk = true;
      let statusLabel = '200 OK';

      for (const chk of page.checks) {
        if (chk.perm && !perms.has(chk.perm)) continue;
        const r = await reqJson(chk.path, { cookie });
        pageMs += r.ms;
        if (r.status >= 500) {
          pageOk = false;
          statusLabel = `5XX (${r.status})`;
          failures.push(`[5XX] ${acc.email} ${page.key} -> ${chk.path}: ${r.status} ${r.text.slice(0, 140)}`);
          continue;
        }
        if (r.status !== 200) {
          pageOk = false;
          statusLabel = `ERR ${r.status}`;
          failures.push(`${acc.email} ${page.key} -> ${chk.path}: expected 200, got ${r.status}`);
          continue;
        }
        for (const k of chk.keys) {
          if (!(r.json && k in r.json)) {
            pageOk = false;
            statusLabel = `MISSING_KEY:${k}`;
            failures.push(`${acc.email} ${page.key} -> ${chk.path}: missing required key "${k}"`);
          }
        }
        const bad = scanBadStrings(r.json);
        if (bad.length > 0) {
          pageOk = false;
          statusLabel = 'BAD_DISPLAY_VAL';
          failures.push(`${acc.email} ${page.key} -> ${chk.path}: undefined/NaN in ${bad.join(', ')}`);
        }
      }

      results.push({
        role: `${acc.label} (${meRes.json.primaryRole})`,
        page: page.key,
        status: pageOk ? statusLabel : statusLabel,
        ms: pageMs,
      });
    }

    await reqJson('/api/auth/logout', { method: 'POST', cookie, csrf });

    // If running --batch=all and remaining login quota hit 0 with more accounts left, wait cleanly.
    if (BATCH === 'all' && loginRes.remaining === 0 && idx < selected.length - 1) {
      console.log(`[rate-limit] Login bucket exhausted after ${idx + 1} accounts; waiting 61s for fresh window...`);
      await sleep(61_500);
    }
  }

  // Print formatted table
  const colRole = 34;
  const colPage = 34;
  const colStatus = 16;
  const pad = (s, n) => String(s).padEnd(n, ' ');
  console.log(`${pad('Role / الدور', colRole)} | ${pad('Page / الصفحة', colPage)} | ${pad('Status / الحالة', colStatus)} | Time`);
  console.log(`${'-'.repeat(colRole)}-+-${'-'.repeat(colPage)}-+-${'-'.repeat(colStatus)}-+-------`);
  for (const r of results) {
    console.log(`${pad(r.role, colRole)} | ${pad(r.page, colPage)} | ${pad(r.status, colStatus)} | ${r.ms}ms`);
  }

  const totalChecks = results.length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, totalChecks));
  console.log(`\nSummary: ${totalChecks - failures.length}/${totalChecks} checks passed | avg ${avgMs}ms | failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal smoke error:', err);
  process.exit(1);
});

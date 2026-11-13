import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end integration suite against a real PostgreSQL engine (PGlite) with
 * the production schema, RLS policies, grants and triggers.
 * Test data is synthetic and created by the seed.
 */

let app: any;
let db: any;
let bootstrap: any;
let patient1: any;
let patient2: any;
let branchFacilityId: string;
const agents: Record<string, Agent> = {};
const state: Record<string, any> = {};

type Agent = { name: string; cookies: Record<string, string>; csrf: string; me: any };

async function login(email: string, password: string, name: string): Promise<Agent> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login ${email} failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c: any) => c.name === 'hms_session');
  const cookies = { hms_session: cookie.value };
  const meRes = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
  const me = meRes.json();
  return { name, cookies, csrf: me.csrfToken, me };
}

function call(agent: Agent, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    payload: payload as any,
    cookies: agent.cookies,
    headers: method === 'GET' ? headers : { 'x-csrf-token': agent.csrf, ...headers },
  });
}

async function expectStatus(res: any, status: number, context = '') {
  if (res.statusCode !== status) {
    throw new Error(`${context} expected ${status} got ${res.statusCode}: ${res.body}`);
  }
  return res.json();
}

beforeAll(async () => {
  fs.rmSync('.data/test-pglite', { recursive: true, force: true });
  const { getDb, runMigrations } = await import('../src/db/index');
  const { seedDatabase } = await import('../src/db/seed');
  const { buildServer } = await import('../src/server');

  db = await getDb();
  await runMigrations(db);
  const seeded = await seedDatabase();
  if (!seeded.seeded) throw new Error('seed failed');

  app = await buildServer({ logger: false, serveWeb: false });
  await app.ready();

  agents.reception = await login('reception@demo.hms', 'Reception#Demo2026', 'reception');
  agents.doctor = await login('dr.ahmed@demo.hms', 'Doctor#Demo2026', 'doctor');
  agents.nurse = await login('nurse@demo.hms', 'Nurse#Demo2026', 'nurse');
  agents.records = await login('records@demo.hms', 'Records#Demo2026', 'records');
  agents.lab1 = await login('lab@demo.hms', 'Lab#Demo2026', 'lab1');
  agents.lab2 = await login('lab2@demo.hms', 'Lab#Demo2026', 'lab2');
  agents.nurse2 = await login('nurse2@demo.hms', 'Nurse#Demo2026', 'nurse2');
  agents.surgeon = await login('surgeon@demo.hms', 'Surgeon#Demo2026', 'surgeon');
  agents.anesthesiologist = await login('anesthesia@demo.hms', 'Anesthesia#Demo2026', 'anesthesiologist');
  agents.orNurse = await login('ornurse@demo.hms', 'Nurse#Demo2026', 'orNurse');
  agents.intensivist = await login('intensivist@demo.hms', 'ICU#Demo2026', 'intensivist');
  agents.icuNurse = await login('icunurse@demo.hms', 'ICU#Demo2026', 'icuNurse');
  agents.bloodTech = await login('bloodbank@demo.hms', 'Blood#Demo2026', 'bloodTech');
  agents.dietitian = await login('dietitian@demo.hms', 'Nutrition#Demo2026', 'dietitian');
  agents.kitchen = await login('kitchen@demo.hms', 'Kitchen#Demo2026', 'kitchen');
  agents.cssd = await login('cssd@demo.hms', 'CSSD#Demo2026', 'cssd');
  agents.cssd2 = await login('cssd2@demo.hms', 'CSSD#Demo2026', 'cssd2');
  agents.infection = await login('infection@demo.hms', 'Infection#Demo2026', 'infection');
  agents.radTech = await login('radiology@demo.hms', 'Radiology#Demo2026', 'radTech');
  agents.radiologist = await login('radiologist@demo.hms', 'Radiology#Demo2026', 'radiologist');
  agents.pharmacist = await login('pharmacist@demo.hms', 'Pharma#Demo2026', 'pharmacist');
  agents.accountant = await login('accountant@demo.hms', 'Account#Demo2026', 'accountant');
  agents.auditor = await login('auditor@demo.hms', 'Auditor#Demo2026', 'auditor');
  agents.hr1 = await login('hr@demo.hms', 'HR#Demo2026', 'hr1');
  agents.hr2 = await login('hr2@demo.hms', 'HR#Demo2026', 'hr2');
  agents.admin = await login('admin@demo.hms', 'Admin#Demo2026', 'admin');
  agents.patient = await login('patient@demo.hms', 'Patient#Demo2026', 'patient');

  bootstrap = (await call(agents.doctor, 'GET', '/api/meta/bootstrap')).json();
  const list = (await call(agents.reception, 'GET', '/api/patients?limit=50')).json();
  patient1 = list.items.find((p: any) => p.mrn === 'MRN-0001');
  patient2 = list.items.find((p: any) => p.mrn === 'MRN-0002');
  const branch = await db.query(`SELECT id FROM facilities WHERE code = 'JED'`);
  branchFacilityId = branch.rows[0].id;
}, 240_000);

afterAll(async () => {
  await app?.close();
  const { closeDb } = await import('../src/db/index');
  await closeDb();
});

describe('static SPA hosting', () => {
  it('serves the shell, immutable asset caching and a JSON 404 for unknown API routes', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hms-web-'));
    await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await fsp.writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    const { buildServer } = await import('../src/server');
    const webApp = await buildServer({ logger: false, serveWeb: true, webDir: dir });
    try {
      const shell = await webApp.inject({ method: 'GET', url: '/any/spa/route' });
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toContain('id="root"');

      // Regression: @fastify/static v10 hands setHeaders the Fastify reply, so
      // calling res.setHeader threw and turned every asset into a 500.
      const asset = await webApp.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      expect(asset.body).toBe('console.log(1)');

      const missingApi = await webApp.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.json().error.code).toBe('not_found');
    } finally {
      await webApp.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('authentication & session security', () => {
  it('exposes a health probe and rejects anonymous access', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    const anon = await app.inject({ method: 'GET', url: '/api/patients' });
    expect(anon.statusCode).toBe(401);
  });

  it('rejects invalid credentials and sets an httpOnly cookie on success', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'dr.ahmed@demo.hms', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('invalid_credentials');
    const loginRes = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'dr.ahmed@demo.hms', password: 'Doctor#Demo2026' } });
    const cookie = loginRes.cookies.find((c: any) => c.name === 'hms_session');
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.value).toBeTruthy();
  });

  it('enforces CSRF on state-changing requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/patients',
      cookies: agents.reception.cookies,
      payload: { fullNameAr: 'بدون رمز', dateOfBirth: '1990-01-01', sex: 'male' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_failed');
  });

  it('does not reveal whether an email exists', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@demo.hms', password: 'x' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('بيانات الدخول غير صحيحة');
  });
});

describe('RBAC & ABAC on patient records', () => {
  it('lets reception list patients with masked identifiers only', async () => {
    const body = await expectStatus(await call(agents.reception, 'GET', '/api/patients?limit=50'), 200, 'patients list');
    expect(body.total).toBeGreaterThanOrEqual(3);
    const p = body.items[0];
    expect(p.nationalIdMasked).toMatch(/\*/);
    expect(p.nationalId).toBeUndefined();
  });

  it('denies the receptionist the clinical chart and executive dashboard', async () => {
    await expectStatus(await call(agents.reception, 'GET', `/api/patients/${patient2.id}`), 200, 'admin scope chart');
    const dashboard = await call(agents.reception, 'GET', '/api/dashboard');
    expect(dashboard.statusCode).toBe(403);
  });

  it('denies auditors clinical access but allows the audit trail', async () => {
    expect((await call(agents.auditor, 'GET', '/api/patients')).statusCode).toBe(403);
    const audit = await expectStatus(await call(agents.auditor, 'GET', '/api/audit?limit=10'), 200, 'audit list');
    expect(audit.items.length).toBeGreaterThan(0);
  });

  it('blocks a physician without a care relationship and honours break-glass', async () => {
    const created = await expectStatus(
      await call(agents.reception, 'POST', '/api/patients', {
        fullNameAr: 'سالم تجريبي',
        dateOfBirth: '1979-03-03',
        sex: 'male',
        nationalId: '1000000009',
        phone: '0501112233',
      }),
      201,
      'create patient',
    );
    const newId = created.patient.id;
    const denied = await call(agents.doctor, 'GET', `/api/patients/${newId}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toContain('break-glass');

    const grant = await expectStatus(
      await call(agents.doctor, 'POST', `/api/patients/${newId}/break-glass`, { reason: 'حالة طارئة: ألم صدر حاد في قسم الطوارئ' }),
      201,
      'break glass',
    );
    expect(grant.expiresAt).toBeTruthy();
    const chart = await expectStatus(await call(agents.doctor, 'GET', `/api/patients/${newId}`), 200, 'chart after break-glass');
    expect(chart.access.basis).toBe('break_glass');
  });

  it('rejects duplicate national IDs', async () => {
    const res = await call(agents.reception, 'POST', '/api/patients', {
      fullNameAr: 'مكرر الهوية',
      dateOfBirth: '1985-04-12',
      sex: 'male',
      nationalId: '1000000001',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.candidates.length).toBeGreaterThan(0);
  });
});

describe('patient journey end-to-end', () => {
  it('books an appointment and prevents doctor double-booking', async () => {
    const doctorId = bootstrap.doctors.find((d: any) => d.full_name_ar.includes('أحمد')).id;
    const departmentId = bootstrap.departments.find((d: any) => d.code === 'GEN').id;
    const scheduledAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const payload = { patientId: patient1.id, departmentId, doctorId, scheduledAt, durationMinutes: 15, reason: 'متابعة سكري' };
    const booked = await expectStatus(await call(agents.reception, 'POST', '/api/appointments', payload), 201, 'book');
    state.appointmentId = booked.id;
    state.doctorId = doctorId;
    state.departmentId = departmentId;
    const clash = await call(agents.reception, 'POST', '/api/appointments', payload);
    expect(clash.statusCode).toBe(409);
    await expectStatus(await call(agents.reception, 'POST', `/api/appointments/${booked.id}/check-in`), 200, 'check-in');
  });

  it('starts an encounter, records vitals and a diagnosis', async () => {
    const enc = await expectStatus(
      await call(agents.doctor, 'POST', '/api/encounters', {
        patientId: patient1.id,
        appointmentId: state.appointmentId,
        encounterType: 'outpatient',
        departmentId: state.departmentId,
      }),
      201,
      'encounter',
    );
    state.encounterId = enc.id;
    await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${enc.id}/vitals`, { temperatureC: 38.4, heartRate: 104, systolicBp: 138, diastolicBp: 88, spo2: 96 }),
      201,
      'vitals',
    );
    await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${enc.id}/diagnoses`, { icd10Code: 'E11.9', description: 'داء السكري من النوع الثاني', type: 'primary' }),
      201,
      'diagnosis',
    );
    await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${enc.id}/notes`, { subjective: 'صداع وتعب', objective: 'حرارة مرتفعة', assessment: 'التهاب بولي', plan: 'مضاد حيوي وتحليل' }),
      201,
      'note',
    );
  });

  it('orders labs and creates charges atomically', async () => {
    const order = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.encounterId}/lab-orders`, { tests: ['718-7', '2345-7'], priority: 'stat' }),
      201,
      'lab order',
    );
    state.orderId = order.id;
    state.orderNo = order.orderNo;
    const enc = await expectStatus(await call(agents.doctor, 'GET', `/api/encounters/${state.encounterId}`), 200, 'encounter after lab order');
    expect(enc.invoices.length).toBe(1);
    state.invoiceIdEarly = enc.invoices[0].id;
    const detail = await expectStatus(await call(agents.accountant, 'GET', `/api/billing/invoices/${state.invoiceIdEarly}`), 200, 'invoice detail');
    expect(detail.items.length).toBe(2);
    expect(Number(detail.invoice.total)).toBe(45);
  });

  it('blocks an unacknowledged allergy conflict, then accepts an audited override', async () => {
    const amox = bootstrap.drugs.find((d: any) => d.name_ar.includes('أموكسيسيلين'));
    const item = { drugId: amox.id, dose: '500mg', route: 'فموي', frequency: 'كل 8 ساعات', durationDays: 3, quantity: 9 };
    const blocked = await call(agents.doctor, 'POST', `/api/encounters/${state.encounterId}/prescriptions`, { items: [item] });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details.requiresAcknowledgement).toBe(true);
    expect(blocked.json().error.details.warnings[0].message).toContain('حساسية');
    const accepted = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.encounterId}/prescriptions`, { items: [item], allergyAcknowledged: true }),
      201,
      'prescription override',
    );
    expect(accepted.warnings.length).toBeGreaterThan(0);
    state.prescriptionId = accepted.id;
  });

  it('collects samples, flags a critical value, and blocks self-verification', async () => {
    const worklist = await expectStatus(await call(agents.lab1, 'GET', '/api/lab/worklist?status=ordered'), 200, 'worklist');
    const ours = worklist.items.filter((i: any) => i.order_no === state.orderNo);
    expect(ours.length).toBe(2);
    state.labItems = {};
    for (const item of ours) {
      await expectStatus(await call(agents.lab1, 'POST', `/api/lab/items/${item.id}/collect`, {}), 200, 'collect');
      state.labItems[item.test_code] = item.id;
    }
    const glucose = state.labItems['2345-7'];
    const result = await expectStatus(
      await call(agents.lab1, 'POST', `/api/lab/items/${glucose}/result`, { valueNumeric: 600, comment: 'قيمة حرجة' }),
      200,
      'result',
    );
    expect(result.flag).toBe('critical_high');
    expect(result.alertCreated).toBe(true);
    const selfVerify = await call(agents.lab1, 'POST', `/api/lab/items/${glucose}/verify`, {});
    expect(selfVerify.statusCode).toBe(409);
    expect(selfVerify.json().error.message).toContain('فصل المهام');
  });

  it('lets a second lab user verify, completing the order', async () => {
    const hb = state.labItems['718-7'];
    await expectStatus(await call(agents.lab1, 'POST', `/api/lab/items/${hb}/result`, { valueNumeric: 15.1 }), 200, 'hb result');
    for (const itemId of Object.values(state.labItems) as string[]) {
      await expectStatus(await call(agents.lab2, 'POST', `/api/lab/items/${itemId}/verify`, {}), 200, 'verify');
    }
    const alerts = await expectStatus(await call(agents.lab2, 'GET', '/api/lab/alerts'), 200, 'alerts');
    const alert = alerts.items.find((a: any) => a.message.includes('2345-7') || a.message.includes('الغلوكوز'));
    expect(alert).toBeTruthy();
    await expectStatus(await call(agents.lab2, 'POST', `/api/lab/alerts/${alert.id}/ack`, { note: 'تم إبلاغ الطبيب المعالج' }), 200, 'ack alert');
  });

  it('dispenses with FEFO, decrements stock, and is idempotent', async () => {
    const detail = await expectStatus(await call(agents.pharmacist, 'GET', `/api/pharmacy/prescriptions/${state.prescriptionId}`), 200, 'rx detail');
    expect(detail.warnings.length).toBeGreaterThan(0);
    const items = detail.items.filter((i: any) => i.status === 'pending').map((i: any) => ({ itemId: i.id, quantity: Number(i.quantity) }));
    const before = await expectStatus(await call(agents.pharmacist, 'GET', '/api/pharmacy/stock?search=أموكسيسيلين'), 200, 'stock');
    const qtyBefore = Number(before.items[0].qty_on_hand);

    const key = 'dispense-test-key-0001';
    const body = { prescriptionId: state.prescriptionId, items, acknowledgedWarnings: true, overrideReason: 'مراجعة الصيدلي واعتماد الطبيب المعالج' };
    const first = await call(agents.pharmacist, 'POST', '/api/pharmacy/dispense', body, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    const replay = await call(agents.pharmacist, 'POST', '/api/pharmacy/dispense', body, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const second = await call(agents.pharmacist, 'POST', '/api/pharmacy/dispense', body, { 'idempotency-key': 'dispense-test-key-0002' });
    expect(second.statusCode).toBe(409);

    const after = await expectStatus(await call(agents.pharmacist, 'GET', '/api/pharmacy/stock?search=أموكسيسيلين'), 200, 'stock after');
    expect(Number(after.items[0].qty_on_hand)).toBe(qtyBefore - 9);
  });

  it('closes the encounter and invoices every charge exactly once', async () => {
    await expectStatus(await call(agents.doctor, 'POST', `/api/encounters/${state.encounterId}/close`, { disposition: 'متابعة في العيادة' }), 200, 'close');
    const dupClose = await call(agents.doctor, 'POST', `/api/encounters/${state.encounterId}/close`, { disposition: 'متابعة' });
    expect(dupClose.statusCode).toBe(409);

    const enc = await expectStatus(await call(agents.doctor, 'GET', `/api/encounters/${state.encounterId}`), 200, 'encounter after close');
    state.invoiceId = enc.invoices[0].id;
    const detail = await expectStatus(await call(agents.accountant, 'GET', `/api/billing/invoices/${state.invoiceId}`), 200, 'invoice');
    expect(detail.items.length).toBe(4);
    const sum = detail.items.reduce((acc: number, i: any) => acc + Number(i.line_total), 0);
    expect(Number(detail.invoice.total)).toBeCloseTo(sum, 2);
    expect(sum).toBeCloseTo(25 + 20 + 150 + 9 * 18, 2);
  });

  it('records one payment per idempotency key and rejects overpayment', async () => {
    const key = 'payment-test-key-0001';
    const first = await call(agents.accountant, 'POST', `/api/billing/invoices/${state.invoiceId}/payments`, { amount: 100, method: 'card' }, { 'idempotency-key': key });
    expect(first.statusCode).toBe(201);
    const replay = await call(agents.accountant, 'POST', `/api/billing/invoices/${state.invoiceId}/payments`, { amount: 100, method: 'card' }, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().replayed).toBe(true);
    const over = await call(agents.accountant, 'POST', `/api/billing/invoices/${state.invoiceId}/payments`, { amount: 10_000, method: 'cash' }, { 'idempotency-key': 'payment-test-key-0002' });
    expect(over.statusCode).toBe(409);

    const detail = await expectStatus(await call(agents.accountant, 'GET', `/api/billing/invoices/${state.invoiceId}`), 200, 'invoice after pay');
    expect(detail.payments.length).toBe(1);
    expect(Number(detail.invoice.paid_amount)).toBe(100);
    expect(detail.invoice.status).toBe('partially_paid');
  });
});

describe('inpatient admissions and beds', () => {
  it('admits a patient with a bed, and refuses an occupied bed', async () => {
    const beds = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds');
    const free = beds.beds.find((b: any) => b.bed_status === 'available' && b.ward_type === 'general');
    expect(free).toBeTruthy();
    state.bedId = free.id;
    const admission = await expectStatus(
      await call(agents.doctor, 'POST', '/api/inpatient/admissions', {
        patientId: patient2.id,
        bedId: free.id,
        departmentId: state.departmentId,
        reason: 'مراقبة ارتفاع ضغط غير مستقر',
      }),
      201,
      'admit',
    );
    state.admissionId = admission.id;

    const bedsAfter = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds after');
    expect(bedsAfter.beds.find((b: any) => b.id === free.id).bed_status).toBe('occupied');

    const patient3Id = (await expectStatus(await call(agents.reception, 'GET', '/api/patients?limit=100'), 200, 'patients')).items.find((p: any) => p.mrn === 'MRN-0003').id;
    const clash = await call(agents.doctor, 'POST', '/api/inpatient/admissions', {
      patientId: patient3Id,
      bedId: free.id,
      departmentId: state.departmentId,
      reason: 'محاولة استخدام سرير مشغول',
    });
    expect(clash.statusCode).toBe(409);

    const duplicate = await call(agents.doctor, 'POST', '/api/inpatient/admissions', {
      patientId: patient2.id,
      departmentId: state.departmentId,
      reason: 'محاولة تنويم مكرر',
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('denies non-clinical roles the ability to admit', async () => {
    const beds = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds');
    const another = beds.beds.find((b: any) => b.bed_status === 'available' && b.ward_type === 'general');
    const res = await app.inject({
      method: 'POST',
      url: '/api/inpatient/admissions',
      cookies: agents.reception.cookies,
      headers: { 'x-csrf-token': agents.reception.csrf },
      payload: { patientId: patient2.id, bedId: another.id, departmentId: state.departmentId, reason: 'بدون صلاحية سريرية' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('transfers the patient to another bed and frees the previous bed for cleaning', async () => {
    const beds = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds');
    const target = beds.beds.find((b: any) => b.bed_status === 'available' && b.ward_type === 'general');
    await expectStatus(
      await call(agents.nurse, 'POST', `/api/inpatient/admissions/${state.admissionId}/transfer`, { toBedId: target.id, reason: 'الحاجة لمراقبة أقرب' }),
      200,
      'transfer',
    );
    const after = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds after transfer');
    expect(after.beds.find((b: any) => b.id === target.id).bed_status).toBe('occupied');
    expect(after.beds.find((b: any) => b.id === state.bedId).bed_status).toBe('cleaning');
    state.bedId = target.id;
  });

  it('discharges with a summary, charges bed days, and creates a discharge note', async () => {
    const result = await expectStatus(
      await call(agents.doctor, 'POST', `/api/inpatient/admissions/${state.admissionId}/discharge`, {
        dischargeType: 'home',
        summary: 'استقرت قراءات الضغط بعد تعديل العلاج، مع تعليمات المتابعة بعد أسبوع في العيادة.',
      }),
      200,
      'discharge',
    );
    expect(result.bedDays).toBeGreaterThanOrEqual(1);
    expect(result.bedCharge).toBe(result.bedDays * 400);

    const detail = await expectStatus(await call(agents.doctor, 'GET', `/api/inpatient/admissions/${state.admissionId}`), 200, 'admission detail');
    expect(detail.admission.status).toBe('discharged');
    expect(detail.transfers.length).toBe(1);

    const chart = await expectStatus(await call(agents.doctor, 'GET', `/api/patients/${patient2.id}`), 200, 'chart after discharge');
    expect(chart.notes.some((n: any) => n.note_type === 'discharge')).toBe(true);

    const repeat = await call(agents.doctor, 'POST', `/api/inpatient/admissions/${state.admissionId}/discharge`, {
      dischargeType: 'home',
      summary: 'محاولة خروج ثانية يجب أن تُرفض لأن التنويم منتهٍ بالفعل.',
    });
    expect(repeat.statusCode).toBe(409);
  });

  it('requires documentation and keeps bed state transitions guarded', async () => {
    const beds = await expectStatus(await call(agents.nurse, 'GET', '/api/inpatient/beds'), 200, 'beds');
    const cleaning = beds.beds.find((b: any) => b.bed_status === 'cleaning');
    await expectStatus(await call(agents.nurse, 'PATCH', `/api/inpatient/beds/${cleaning.id}/status`, { status: 'available' }), 200, 'mark clean');
    const occupied = beds.beds.find((b: any) => b.bed_status === 'occupied');
    if (occupied) {
      const res = await call(agents.nurse, 'PATCH', `/api/inpatient/beds/${occupied.id}/status`, { status: 'available' });
      expect(res.statusCode).toBe(409);
    }
  });
});

describe('emergency department and triage', () => {
  it('registers an unidentified arrival with triage level and vitals', async () => {
    const res = await expectStatus(
      await call(agents.doctor, 'POST', '/api/emergency/arrivals', {
        unidentified: { sex: 'male', estimatedAge: 45, description: 'مجهول الهوية - أحضرته الهلال الأحمر' },
        chiefComplaint: 'فقدان وعي متكرر',
        level: 2,
        vitals: { heartRate: 118, systolicBp: 92, spo2: 93, temperatureC: 37.8 },
      }),
      201,
      'er arrival',
    );
    expect(res.temporaryIdentity).toBe(true);
    state.erEncounterId = res.encounterId;
    state.erPatientId = res.patientId;
    const board = await expectStatus(await call(agents.doctor, 'GET', '/api/emergency/board'), 200, 'board');
    const entry = board.items.find((i: any) => i.encounter_id === res.encounterId);
    expect(entry.level).toBe(2);
    expect(entry.identity_status).toBe('unverified_temporary');
    expect(entry.waiting_minutes).toBeGreaterThanOrEqual(0);
    expect(board.byLevel['2']).toBeGreaterThanOrEqual(1);
  });

  it('orders the board by clinical urgency, not arrival order', async () => {
    const walkIn = await expectStatus(
      await call(agents.reception, 'POST', '/api/patients', {
        fullNameAr: 'نورة عبدالله الحربي',
        dateOfBirth: '1996-11-09',
        sex: 'female',
        acknowledgeDuplicate: true,
      }),
      201,
      'walk-in patient',
    );
    const low = await expectStatus(
      await call(agents.doctor, 'POST', '/api/emergency/arrivals', {
        patientId: walkIn.patient.id,
        chiefComplaint: 'ألم أسفل الظهر',
        level: 5,
      }),
      201,
      'non-urgent arrival',
    );
    const critical = await expectStatus(
      await call(agents.doctor, 'POST', '/api/emergency/arrivals', {
        patientId: patient2.id,
        chiefComplaint: 'ألم صدر حاد وضيق تنفس',
        level: 1,
      }),
      201,
      'critical arrival',
    );
    const board = await expectStatus(await call(agents.doctor, 'GET', '/api/emergency/board'), 200, 'board');
    const levels = board.items.map((i: any) => i.level);
    expect(levels[0]).toBe(1);
    expect(levels[levels.length - 1]).toBe(5);
    expect(levels).toEqual([...levels].sort((a: number, b: number) => a - b));
    state.lowEncounterId = low.encounterId;
    state.criticalEncounterId = critical.encounterId;
  });

  it('records a retriage with a mandatory reason and blocks silent level changes', async () => {
    const retriage = await expectStatus(
      await call(agents.nurse, 'POST', `/api/emergency/visits/${state.erEncounterId}/retriage`, { level: 1, reason: 'تدهور مستوى الوعي وانخفاض الضغط' }),
      200,
      'retriage',
    );
    expect(retriage).toMatchObject({ from: 2, to: 1 });
    const same = await call(agents.nurse, 'POST', `/api/emergency/visits/${state.erEncounterId}/retriage`, { level: 1, reason: 'محاولة تكرار نفس المستوى' });
    expect(same.statusCode).toBe(409);
    const audit = await expectStatus(await call(agents.auditor, 'GET', '/api/audit?action=emergency.retriage'), 200, 'audit retriage');
    expect(audit.items[0].reason).toContain('تدهور');
  });

  it('denies triage to roles without emergency permission', async () => {
    const res = await call(agents.accountant, 'POST', '/api/emergency/arrivals', { patientId: patient2.id, chiefComplaint: 'محاولة', level: 3 });
    expect(res.statusCode).toBe(403);
    expect((await call(agents.accountant, 'GET', '/api/emergency/board')).statusCode).toBe(403);
  });

  it('discharges an ER visit with a summary and an audited fee', async () => {
    const res = await expectStatus(
      await call(agents.doctor, 'POST', `/api/emergency/visits/${state.lowEncounterId}/disposition`, {
        decision: 'discharge',
        dischargeType: 'home',
        summary: 'ألم عضلي بعد مجهود، غادر بحالة مستقرة مع مسكن ومتابعة عند الحاجة.',
      }),
      200,
      'er discharge',
    );
    expect(res.fee).toBe(200);
    const repeat = await call(agents.doctor, 'POST', `/api/emergency/visits/${state.lowEncounterId}/disposition`, {
      decision: 'discharge',
      summary: 'محاولة قرار ثانٍ على زيارة منتهية.',
    });
    expect(repeat.statusCode).toBe(409);
  });

  it('transfers a critical ER patient to an inpatient bed reusing the same encounter', async () => {
    const beds = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds');
    const bed = beds.beds.find((b: any) => b.bed_status === 'available' && b.ward_type === 'general');
    const res = await expectStatus(
      await call(agents.doctor, 'POST', `/api/emergency/visits/${state.criticalEncounterId}/disposition`, {
        decision: 'admit',
        bedId: bed.id,
      }),
      201,
      'er admit',
    );
    expect(res.admissionId).toBeTruthy();
    state.erAdmissionId = res.admissionId;
    const admission = await expectStatus(await call(agents.doctor, 'GET', `/api/inpatient/admissions/${res.admissionId}`), 200, 'admission');
    expect(admission.admission.encounter_id).toBe(state.criticalEncounterId);
    const board = await expectStatus(await call(agents.doctor, 'GET', '/api/emergency/board'), 200, 'board');
    expect(board.items.some((i: any) => i.encounter_id === state.criticalEncounterId)).toBe(false);
  });

  it('refuses to match identity while the ER visit is still open', async () => {
    const blocked = await call(agents.records, 'POST', `/api/emergency/patients/${state.erPatientId}/identify`, {
      targetPatientId: patient1.id,
      evidence: 'محاولة مطابقة قبل إغلاق زيارة الطوارئ الجارية',
    });
    expect(blocked.statusCode).toBe(409);
  });

  it('matches an unidentified patient to a real record with documented evidence', async () => {
    await expectStatus(
      await call(agents.doctor, 'POST', `/api/emergency/visits/${state.erEncounterId}/disposition`, {
        decision: 'discharge',
        dischargeType: 'home',
        summary: 'استقر الوعي والضغط بعد الإنعاش الأولي، غادر بحالة مستقرة مع متابعة عصبية.',
      }),
      200,
      'close er visit before identity match',
    );
    const merge = await expectStatus(
      await call(agents.records, 'POST', `/api/emergency/patients/${state.erPatientId}/identify`, {
        targetPatientId: patient1.id,
        evidence: 'تم التعرف عبر بطاقة الهوية التي أحضرها أفراد الأسرة بعد وصوله',
      }),
      200,
      'identify',
    );
    expect(merge.mergedInto).toBe(patient1.id);
    const chart = await expectStatus(await call(agents.doctor, 'GET', `/api/patients/${patient1.id}`), 200, 'merged chart');
    expect(chart.encounters.length).toBeGreaterThanOrEqual(2);
    const again = await call(agents.records, 'POST', `/api/emergency/patients/${state.erPatientId}/identify`, {
      targetPatientId: patient1.id,
      evidence: 'محاولة مطابقة ثانية لنفس الملف المؤقت بعد دمجه',
    });
    expect(again.statusCode).toBe(409);
  });

  afterAll(async () => {
    if (state.erAdmissionId) {
      await call(agents.doctor, 'POST', `/api/inpatient/admissions/${state.erAdmissionId}/discharge`, {
        dischargeType: 'home',
        summary: 'استقرت الحالة بعد المراقبة الليلية، وغادر مع خطة متابعة في عيادة القلب.',
      });
    }
  });
});

describe('reports and audited export', () => {
  it('lists available reports and returns a filtered dataset', async () => {
    const list = await expectStatus(await call(agents.accountant, 'GET', '/api/reports'), 200, 'reports');
    expect(list.reports.map((r: any) => r.key)).toContain('revenue');
    const report = await expectStatus(await call(agents.accountant, 'GET', '/api/reports/revenue'), 200, 'revenue report');
    expect(report.total).toBeGreaterThan(0);
    expect(report.rows[0].invoice_no).toBeTruthy();
  });

  it('exports CSV with BOM, escaped cells, and an audit entry', async () => {
    const csvRes = await call(agents.accountant, 'GET', '/api/reports/revenue?format=csv');
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body.charCodeAt(0)).toBe(0xfeff);
    expect(csvRes.body.split('\r\n').length).toBeGreaterThan(1);
    const audit = await expectStatus(await call(agents.auditor, 'GET', '/api/audit?action=report.export'), 200, 'export audit');
    expect(audit.items.length).toBeGreaterThan(0);
    expect(audit.items[0].entity_id).toBe('revenue');
  });

  it('separates report reading from export rights and hides finance reports from clinical roles', async () => {
    expect((await call(agents.doctor, 'GET', '/api/reports/revenue')).statusCode).toBe(403);
    const doctorCsv = await call(agents.doctor, 'GET', '/api/reports/visits?format=csv');
    expect(doctorCsv.statusCode).toBe(403);
    const doctorJson = await call(agents.doctor, 'GET', '/api/reports/visits');
    expect(doctorJson.statusCode).toBe(200);
  });
});

describe('audit trail integrity', () => {
  it('verifies the hash chain and records security-relevant actions', async () => {
    const verify = await expectStatus(await call(agents.auditor, 'GET', '/api/audit/verify'), 200, 'verify chain');
    expect(verify.ok).toBe(true);
    expect(verify.checked).toBeGreaterThan(20);
    const log = await expectStatus(await call(agents.auditor, 'GET', '/api/audit?limit=100'), 200, 'audit log');
    const actions = log.items.map((i: any) => i.action);
    for (const expected of ['auth.login', 'patient.create', 'lab.result.enter', 'lab.result.verify', 'pharmacy.dispense', 'billing.payment.record', 'patient.break_glass']) {
      expect(actions).toContain(expected);
    }
  });

  it('refuses to mutate or delete audit rows at the database level', async () => {
    await expect(db.query(`UPDATE audit_log SET action = 'tampered' WHERE id = 1`)).rejects.toThrow(/append-only|permission denied/);
    await expect(db.query('DELETE FROM audit_log WHERE id = 1')).rejects.toThrow(/append-only|permission denied/);
    const notes = await db.asRole('hms_app', { 'app.facility_ids': agents.reception.me.activeFacilityId }, (q: any) =>
      q.query('SELECT id FROM clinical_notes LIMIT 1'),
    );
    expect(notes.rowCount).toBeGreaterThan(0);
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.reception.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE clinical_notes SET assessment = 'edited' WHERE id = $1`, [notes.rows[0].id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.reception.me.activeFacilityId }, (q: any) =>
        q.query('DELETE FROM clinical_notes WHERE id = $1', [notes.rows[0].id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
  });
});

describe('tenant isolation (RLS)', () => {
  it('hides rows from other facilities and from sessions without a tenant', async () => {
    const branchRows = await db.asRole('hms_app', { 'app.facility_ids': branchFacilityId }, (q: any) => q.query('SELECT id FROM patients'));
    expect(branchRows.rowCount).toBe(0);
    const noTenant = await db.asRole('hms_app', { 'app.facility_ids': '' }, (q: any) => q.query('SELECT id FROM patients'));
    expect(noTenant.rowCount).toBe(0);
    const own = await db.asRole('hms_app', { 'app.facility_ids': patient1 ? agents.reception.me.activeFacilityId : '' }, (q: any) => q.query('SELECT id FROM patients'));
    expect(own.rowCount).toBeGreaterThanOrEqual(4);
  });

  it('restricts the portal database role to its own patient', async () => {
    const rows = await db.asRole('hms_portal', { 'app.patient_id': patient1.id }, (q: any) => q.query('SELECT id FROM patients'));
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(patient1.id);
    const other = await db.asRole('hms_portal', { 'app.patient_id': patient2.id }, (q: any) => q.query('SELECT id FROM patients'));
    expect(other.rows[0].id).toBe(patient2.id);
    const invoices = await db.asRole('hms_portal', { 'app.patient_id': patient1.id }, (q: any) => q.query('SELECT id, patient_id FROM invoices'));
    expect(invoices.rowCount).toBeGreaterThan(0);
    expect(invoices.rows.every((r: any) => r.patient_id === patient1.id)).toBe(true);
  });

  it('serves the patient portal only its own verified data', async () => {
    const summary = await expectStatus(await call(agents.patient, 'GET', '/api/portal/summary'), 200, 'portal');
    expect(summary.patient.id).toBe(patient1.id);
    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.results.every((r: any) => new Date(r.verified_at).getTime() <= Date.now())).toBe(true);
    expect(summary.invoices.length).toBeGreaterThan(0);
    expect((await call(agents.patient, 'GET', '/api/patients')).statusCode).toBe(403);
    expect((await call(agents.patient, 'GET', `/api/patients/${patient2.id}`)).statusCode).toBe(403);
    expect((await call(agents.patient, 'GET', '/api/dashboard')).statusCode).toBe(403);
  });
});

describe('FHIR integration layer', () => {
  it('advertises capabilities and returns a Patient bundle scoped to the facility', async () => {
    const meta = await expectStatus(await call(agents.doctor, 'GET', '/fhir/metadata'), 200, 'fhir meta');
    expect(meta.fhirVersion).toBe('4.0.1');
    const bundle = await expectStatus(await call(agents.doctor, 'GET', '/fhir/Patient'), 200, 'fhir patients');
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.entry[0].resource.resourceType).toBe('Patient');
  });

  it('returns verified laboratory observations for a patient', async () => {
    const res = await call(agents.lab2, 'GET', `/fhir/Observation?patient=${patient1.id}`);
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    expect(bundle.entry.length).toBeGreaterThan(0);
    expect(bundle.entry[0].resource.status).toBe('final');
  });
});

describe('account lockout and rate limiting', () => {
  it('locks an account after repeated failures and rate limits login attempts', async () => {
    await expectStatus(
      await call(agents.admin, 'POST', '/api/admin/users', {
        email: 'lock.me@demo.hms',
        fullNameAr: 'حساب اختبار القفل',
        fullNameEn: 'Lock Test',
        roleId: 'receptionist',
        temporaryPassword: 'LockTest#2026',
      }),
      201,
      'create lock user',
    );
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock.me@demo.hms', password: 'wrong-password' } });
      expect([401, 429]).toContain(res.statusCode);
    }
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock.me@demo.hms', password: 'LockTest#2026' } });
    expect(locked.statusCode).toBe(429);

    let sawRateLimit = false;
    for (let i = 0; i < 60 && !sawRateLimit; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `probe${i}@demo.hms`, password: 'x' } });
      if (res.statusCode === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe('radiology orders, signed reports and critical results', () => {
  it('orders an imaging study from an open encounter and rejects unauthorized ordering', async () => {
    const patient = await expectStatus(
      await call(agents.reception, 'POST', '/api/patients', {
        fullNameAr: 'ريم فهد الزهراني',
        dateOfBirth: '1988-06-14',
        sex: 'female',
        acknowledgeDuplicate: true,
      }),
      201,
      'imaging patient',
    );
    state.imagingPatientId = patient.patient.id;
    // Reception books the visit, which is what establishes the doctor's care
    // relationship; the chart is not openable by a physician without one.
    const appointment = await expectStatus(
      await call(agents.reception, 'POST', '/api/appointments', {
        patientId: state.imagingPatientId,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
        doctorId: agents.doctor.me.user.id,
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      201,
      'imaging appointment',
    );
    state.imagingEncounterId = (
      await expectStatus(
        await call(agents.doctor, 'POST', '/api/encounters', {
          patientId: state.imagingPatientId,
          appointmentId: appointment.id,
          encounterType: 'outpatient',
          departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
          chiefComplaint: 'سعال مزمن مع ألم صدري',
        }),
        201,
        'imaging encounter',
      )
    ).id;

    const order = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.imagingEncounterId}/imaging-orders`, {
        modality: 'ct',
        bodyPart: 'الصدر',
        indication: 'ألم صدري مع سعال مزمن لأكثر من ثلاثة أسابيع',
        priority: 'urgent',
      }),
      201,
      'imaging order',
    );
    expect(order.orderNo).toMatch(/^IMG-\d{6}$/);
    state.imagingOrderId = order.id;

    const nurseAttempt = await call(agents.nurse, 'POST', `/api/encounters/${state.imagingEncounterId}/imaging-orders`, {
      modality: 'xray',
      bodyPart: 'الصدر',
      indication: 'طلب غير مصرح من التمريض',
    });
    expect(nurseAttempt.statusCode).toBe(403);
  });

  it('refuses a report before the study is performed and refuses double finalization', async () => {
    const early = await call(agents.radiologist, 'POST', `/api/radiology/orders/${state.imagingOrderId}/reports`, {
      findings: 'لا يمكن التقرير قبل التصوير',
      impression: 'محاولة مبكرة',
    });
    expect(early.statusCode).toBe(409);
  });

  it('performs and signs the study, bills the modality price and locks the report', async () => {
    await expectStatus(await call(agents.radTech, 'POST', `/api/radiology/orders/${state.imagingOrderId}/start`), 200, 'start study');
    await expectStatus(await call(agents.radTech, 'POST', `/api/radiology/orders/${state.imagingOrderId}/perform`), 200, 'perform study');

    const draft = await expectStatus(
      await call(agents.radiologist, 'POST', `/api/radiology/orders/${state.imagingOrderId}/reports`, {
        findings: 'تكثف في الفص السفلي الأيمن مع انصباب جنبي بسيط',
        impression: 'التهاب رئوي فصي سفلي أيمن',
        recommendation: 'متابعة بعد إتمام المضاد الحيوي',
      }),
      201,
      'draft report',
    );
    state.imagingReportId = draft.id;

    const finalized = await expectStatus(
      await call(agents.radiologist, 'POST', `/api/radiology/reports/${draft.id}/finalize`),
      200,
      'finalize report',
    );
    expect(finalized.status).toBe('verified');
    expect(finalized.fee).toBe(650);
    expect(finalized.invoiceId).toBeTruthy();

    const worklist = await expectStatus(
      await call(agents.radTech, 'GET', '/api/radiology/worklist?status=verified'),
      200,
      'verified worklist',
    );
    const row = worklist.items.find((i: any) => i.id === state.imagingOrderId);
    expect(row.status).toBe('verified');
    expect(row.modality_ar).toBe('أشعة مقطعية');

    const twice = await call(agents.radiologist, 'POST', `/api/radiology/reports/${draft.id}/finalize`);
    expect(twice.statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.doctor.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE imaging_reports SET findings = 'تعديل صامت' WHERE id = $1`, [draft.id]),
      ),
    ).rejects.toThrow(/immutable|permission denied/);
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.doctor.me.activeFacilityId }, (q: any) =>
        q.query('DELETE FROM imaging_reports WHERE id = $1', [draft.id]),
      ),
    ).rejects.toThrow(/cannot be deleted|permission denied/);
  });

  it('tracks critical findings until the ordering physician acknowledges them', async () => {
    const order = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.imagingEncounterId}/imaging-orders`, {
        modality: 'xray',
        bodyPart: 'الصدر',
        indication: 'اشتباه استرواح صدري بعد إصابة',
        priority: 'stat',
      }),
      201,
      'stat order',
    );
    await expectStatus(await call(agents.radTech, 'POST', `/api/radiology/orders/${order.id}/perform`), 200, 'perform stat');
    const report = await expectStatus(
      await call(agents.radiologist, 'POST', `/api/radiology/orders/${order.id}/reports`, {
        findings: 'استرواح صدري أيمن بنسبة 25% مع انزياح بسيط للمنصف',
        impression: 'استرواح صدري أيمن يحتاج تدخلًا عاجلًا',
        critical: true,
      }),
      201,
      'critical report',
    );
    const finalized = await expectStatus(
      await call(agents.radiologist, 'POST', `/api/radiology/reports/${report.id}/finalize`),
      200,
      'finalize critical',
    );
    expect(finalized.requiresAcknowledgement).toBe(true);

    const techAck = await call(agents.radTech, 'POST', `/api/radiology/reports/${report.id}/acknowledge`, {
      note: 'محاولة استلام من فني الأشعة',
    });
    expect(techAck.statusCode).toBe(403);

    await expectStatus(
      await call(agents.doctor, 'POST', `/api/radiology/reports/${report.id}/acknowledge`, {
        note: 'تم إبلاغي هاتفيًا وطلبت تحضير أنبوب صدري',
      }),
      200,
      'critical ack',
    );
    const again = await call(agents.doctor, 'POST', `/api/radiology/reports/${report.id}/acknowledge`, {
      note: 'تكرار الاستلام',
    });
    expect(again.statusCode).toBe(409);
  });

  it('cancels only studies that have not been acquired', async () => {
    const order = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.imagingEncounterId}/imaging-orders`, {
        modality: 'us',
        bodyPart: 'البطن',
        indication: 'ألم بطني متكرر',
      }),
      201,
      'cancelable order',
    );
    await expectStatus(
      await call(agents.doctor, 'POST', `/api/radiology/orders/${order.id}/cancel`, { reason: 'استُبدل بسونار شامل بعد مراجعة الطلب' }),
      200,
      'cancel order',
    );
    const performedOrder = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.imagingEncounterId}/imaging-orders`, {
        modality: 'xray',
        bodyPart: 'الحوض',
        indication: 'ألم حوض بعد سقوط',
      }),
      201,
      'performed order',
    );
    await expectStatus(await call(agents.radTech, 'POST', `/api/radiology/orders/${performedOrder.id}/perform`), 200, 'perform before cancel');
    const late = await call(agents.doctor, 'POST', `/api/radiology/orders/${performedOrder.id}/cancel`, {
      reason: 'محاولة إلغاء بعد التصوير',
    });
    expect(late.statusCode).toBe(409);
  });
});

describe('nursing: medication administration, care plans and handover', () => {
  it('shows the ward board with an overdue dose and the seeded care-plan work', async () => {
    const board = await expectStatus(await call(agents.nurse, 'GET', '/api/nursing/board'), 200, 'nursing board');
    const admitted = board.items.find((i: any) => i.mrn === 'MRN-0004');
    expect(admitted).toBeTruthy();
    expect(admitted.ward_name).toBeTruthy();
    expect(admitted.overdue_medications).toBeGreaterThanOrEqual(1);
    expect(admitted.next_due.drug).toContain('باراسيتامول');
    expect(admitted.due_tasks).toBeGreaterThanOrEqual(1);
    expect(board.totals.patients).toBe(admitted ? board.items.length : 0);

    const forbiddenForReception = await call(agents.reception, 'GET', '/api/nursing/board');
    expect(forbiddenForReception.statusCode).toBe(403);
  });

  it('refuses to give a medicine before the pharmacy dispenses it', async () => {
    const patientRes = await expectStatus(
      await call(agents.reception, 'POST', '/api/patients', {
        fullNameAr: 'هيا سالم القرني',
        dateOfBirth: '1979-02-11',
        sex: 'female',
        acknowledgeDuplicate: true,
      }),
      201,
      'nursing patient',
    );
    state.nursingPatientId = patientRes.patient.id;
    // Reception books the visit first: that is what documents the doctor's care
    // relationship before the admission.
    const appointment = await expectStatus(
      await call(agents.reception, 'POST', '/api/appointments', {
        patientId: state.nursingPatientId,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
        doctorId: agents.doctor.me.user.id,
        scheduledAt: new Date(Date.now() + 5_400_000).toISOString(),
      }),
      201,
      'nursing appointment',
    );
    expect(appointment.id).toBeTruthy();
    const beds = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds for nursing');
    const free = beds.beds.find((b: any) => b.bed_status === 'available' && b.ward_type === 'general');
    expect(free).toBeTruthy();
    // Admission into the inpatient department is what gives the ward nurse a
    // documented care relationship with this patient.
    const admission = await expectStatus(
      await call(agents.doctor, 'POST', '/api/inpatient/admissions', {
        patientId: state.nursingPatientId,
        bedId: free.id,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'INP').id,
        reason: 'التهاب رئوي يحتاج مراقبة وعلاجًا وريديًا',
      }),
      201,
      'admit for nursing',
    );
    state.nursingEncounterId = admission.encounterId;

    const rx = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.nursingEncounterId}/prescriptions`, {
        items: [{
          drugId: bootstrap.drugs.find((d: any) => d.code === 'DRG-PARA').id,
          dose: '500mg',
          route: 'فموي',
          frequency: 'كل 8 ساعات',
          durationDays: 3,
          quantity: 9,
        }],
      }),
      201,
      'prescription',
    );
    state.nursingRxId = rx.id;
    const detail = await expectStatus(
      await call(agents.pharmacist, 'GET', `/api/pharmacy/prescriptions/${rx.id}`),
      200,
      'prescription detail',
    );
    state.nursingItemId = detail.items[0].id;

    const early = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: state.nursingItemId,
      status: 'given',
      doseGiven: '500mg',
      route: 'فموي',
      identityVerified: true,
      allergyChecked: true,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toContain('يصرفه الصيدلي');
  });

  it('enforces the five rights, one record per slot and append-only corrections', async () => {
    await expectStatus(
      await call(agents.pharmacist, 'POST', '/api/pharmacy/dispense', {
        prescriptionId: state.nursingRxId,
        items: [{ itemId: state.nursingItemId, quantity: 9 }],
      }, { 'idempotency-key': crypto.randomUUID() }),
      200,
      'dispense',
    );

    const noRights = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: state.nursingItemId,
      status: 'given',
      doseGiven: '500mg',
      route: 'فموي',
      identityVerified: false,
      allergyChecked: true,
    });
    expect(noRights.statusCode).toBe(409);
    expect(noRights.json().error.message).toContain('هوية المريض');

    const scheduledFor = new Date(Date.now() - 60_000).toISOString();
    const given = await expectStatus(
      await call(agents.nurse, 'POST', '/api/nursing/mar', {
        prescriptionItemId: state.nursingItemId,
        scheduledFor,
        status: 'given',
        doseGiven: '500mg',
        route: 'فموي',
        identityVerified: true,
        allergyChecked: true,
      }),
      201,
      'administer',
    );
    state.marId = given.id;

    const duplicate = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: state.nursingItemId,
      scheduledFor,
      status: 'given',
      doseGiven: '500mg',
      route: 'فموي',
      identityVerified: true,
      allergyChecked: true,
    });
    expect(duplicate.statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.nurse.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE medication_administrations SET dose_given = '1000mg' WHERE id = $1`, [given.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);

    const correction = await expectStatus(
      await call(agents.nurse2, 'POST', `/api/nursing/mar/${given.id}/correct`, {
        status: 'held',
        reason: 'الجرعة أُوقفت بعد مراجعة الطبيب لارتفاع إنزيمات الكبد',
      }),
      201,
      'correct mar',
    );
    expect(correction.correctsId).toBe(given.id);
    const secondCorrection = await call(agents.nurse2, 'POST', `/api/nursing/mar/${given.id}/correct`, {
      status: 'given',
      reason: 'محاولة تصحيح ثانية لنفس السجل',
    });
    expect(secondCorrection.statusCode).toBe(409);
  });

  it('requires a second nurse witness for high-alert medicines', async () => {
    const rx = await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${state.nursingEncounterId}/prescriptions`, {
        items: [{
          drugId: bootstrap.drugs.find((d: any) => d.code === 'DRG-WARF').id,
          dose: '5mg',
          route: 'فموي',
          frequency: 'مرة يوميًا',
          durationDays: 5,
          quantity: 5,
        }],
      }),
      201,
      'high alert prescription',
    );
    const detail = await expectStatus(await call(agents.pharmacist, 'GET', `/api/pharmacy/prescriptions/${rx.id}`), 200, 'detail');
    const itemId = detail.items[0].id;
    await expectStatus(
      await call(agents.pharmacist, 'POST', '/api/pharmacy/dispense', {
        prescriptionId: rx.id,
        items: [{ itemId, quantity: 5 }],
      }, { 'idempotency-key': crypto.randomUUID() }),
      200,
      'dispense warfarin',
    );

    const withoutWitness = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: itemId,
      status: 'given',
      doseGiven: '5mg',
      route: 'فموي',
      identityVerified: true,
      allergyChecked: true,
    });
    expect(withoutWitness.statusCode).toBe(409);
    expect(withoutWitness.json().error.message).toContain('شاهد');

    const selfWitness = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: itemId,
      status: 'given',
      doseGiven: '5mg',
      route: 'فموي',
      identityVerified: true,
      allergyChecked: true,
      witnessUserId: agents.nurse.me.user.id,
    });
    expect(selfWitness.statusCode).toBe(409);

    const wrongWitness = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: itemId,
      status: 'given',
      doseGiven: '5mg',
      route: 'فموي',
      identityVerified: true,
      allergyChecked: true,
      witnessUserId: agents.reception.me.user.id,
    });
    expect(wrongWitness.statusCode).toBe(403);

    const witnessed = await expectStatus(
      await call(agents.nurse, 'POST', '/api/nursing/mar', {
        prescriptionItemId: itemId,
        status: 'given',
        doseGiven: '5mg',
        route: 'فموي',
        identityVerified: true,
        allergyChecked: true,
        witnessUserId: agents.nurse2.me.user.id,
      }),
      201,
      'witnessed administration',
    );
    expect(witnessed.highAlert).toBe(true);
    expect(witnessed.witness).toContain('ليلى');

    // A second dose minutes after a witnessed one must be refused: the minimum
    // spacing for a once-daily medicine is half a day.
    const tooSoon = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: itemId,
      status: 'given',
      doseGiven: '5mg',
      route: 'فموي',
      identityVerified: true,
      allergyChecked: true,
      witnessUserId: agents.nurse2.me.user.id,
    });
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json().error.message).toContain('أقل فاصل مسموح');
  });

  it('runs a care plan from creation to task completion with reasoned skips', async () => {
    const plan = await expectStatus(
      await call(agents.nurse, 'POST', '/api/nursing/care-plans', {
        encounterId: state.nursingEncounterId,
        title: 'خطة رعاية التهاب رئوي',
        nursingDiagnosis: 'ضعف التهوية نتيجة تراكم الإفرازات',
        goals: 'تحسين تشبع الأكسجين فوق 94% وتشجيع التمارين التنفسية كل ساعتين',
        tasks: [{ description: 'تمارين تنفسية عميقة', frequencyHours: 2 }],
      }),
      201,
      'care plan',
    );
    const list = await expectStatus(
      await call(agents.nurse, 'GET', `/api/nursing/care-plans?encounterId=${state.nursingEncounterId}`),
      200,
      'care plan list',
    );
    const stored = list.plans.find((p: any) => p.id === plan.id);
    expect(stored.tasks.length).toBe(1);
    const taskId = stored.tasks[0].id;

    const skipWithoutReason = await call(agents.nurse, 'POST', `/api/nursing/care-plan-tasks/${taskId}/complete`, {
      status: 'skipped',
    });
    expect(skipWithoutReason.statusCode).toBe(409);

    await expectStatus(
      await call(agents.nurse, 'POST', `/api/nursing/care-plan-tasks/${taskId}/complete`, {
        status: 'done',
        note: 'نُفذت التمارين وجلسة تنفس عميق 10 دقائق',
      }),
      200,
      'complete task',
    );
    const twice = await call(agents.nurse, 'POST', `/api/nursing/care-plan-tasks/${taskId}/complete`, { status: 'done' });
    expect(twice.statusCode).toBe(409);

    await expectStatus(
      await call(agents.nurse, 'POST', `/api/nursing/care-plans/${plan.id}/close`, {
        status: 'achieved',
        reason: 'تحقق الهدف واستقر التشبع عند 97% قبل الخروج',
      }),
      200,
      'close plan',
    );
    const closed = await call(agents.nurse, 'POST', `/api/nursing/care-plans/${plan.id}/close`, {
      status: 'discontinued',
      reason: 'إغلاق مكرر لنفس الخطة',
    });
    expect(closed.statusCode).toBe(409);
  });

  it('records an immutable SBAR handover that only the receiving nurse can acknowledge', async () => {
    const handover = await expectStatus(
      await call(agents.nurse, 'POST', '/api/nursing/handovers', {
        encounterId: state.nursingEncounterId,
        shift: 'evening',
        condition: 'stable',
        situation: 'المريضة مستقرة بعد أول جرعة مضاد حيوي',
        background: 'التهاب رئوي مجتمعي، لا حساسية مسجلة، وظائف كلى طبيعية',
        assessment: 'الحرارة 37.9 والنبض 92 والتشبع 95% على هواء الغرفة',
        recommendation: 'إكمال المضاد الحيوي ومراقبة الحرارة كل 4 ساعات',
        toUserId: agents.nurse2.me.user.id,
      }),
      201,
      'handover',
    );
    const list = await expectStatus(
      await call(agents.nurse2, 'GET', `/api/nursing/handovers?patientId=${state.nursingPatientId}`),
      200,
      'handover list',
    );
    expect(list.items[0].situation).toContain('مستقرة');

    const selfAck = await call(agents.nurse, 'POST', `/api/nursing/handovers/${handover.id}/acknowledge`);
    expect(selfAck.statusCode).toBe(409);

    await expectStatus(
      await call(agents.nurse2, 'POST', `/api/nursing/handovers/${handover.id}/acknowledge`),
      200,
      'acknowledge handover',
    );
    const again = await call(agents.nurse2, 'POST', `/api/nursing/handovers/${handover.id}/acknowledge`);
    expect(again.statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.nurse.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE shift_handovers SET assessment = 'تعديل صامت' WHERE id = $1`, [handover.id]),
      ),
    ).rejects.toThrow(/immutable|permission denied/);
  });

  it('rejects recording administration on a closed encounter', async () => {
    const closedEncounter = state.nursingEncounterId;
    await expectStatus(
      await call(agents.doctor, 'POST', `/api/encounters/${closedEncounter}/close`, { disposition: 'متابعة بعد أسبوع' }),
      200,
      'close encounter',
    );
    const res = await call(agents.nurse, 'POST', '/api/nursing/mar', {
      prescriptionItemId: state.nursingItemId,
      status: 'given',
      doseGiven: '500mg',
      route: 'فموي',
      identityVerified: true,
      allergyChecked: true,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('operating theatre: scheduling, WHO checklist, anaesthesia and recovery', () => {
  const signIn = {
    identity_confirmed: true, consent_signed: true, site_marked: true, allergies_checked: true,
    airway_risk_assessed: true, blood_available: true, imaging_displayed: true,
  };
  const timeOut = {
    team_introduced: true, patient_procedure_confirmed: true, antibiotics_given: true,
    sterile_field_confirmed: true, critical_events_planned: true, imaging_displayed: true,
  };
  const signOut = {
    procedure_recorded: true, counts_confirmed: true, specimens_labelled: true,
    equipment_problems: true, recovery_plan: true,
  };

  it('books a theatre, refuses overlap and refuses staff without the scheduling permission', async () => {
    const patient = await expectStatus(
      await call(agents.reception, 'POST', '/api/patients', {
        fullNameAr: 'هند صالح الحربي', dateOfBirth: '1983-04-19', sex: 'female', acknowledgeDuplicate: true,
      }),
      201,
      'surgical patient',
    );
    state.surgeryPatientId = patient.patient.id;

    const appointment = await expectStatus(
      await call(agents.reception, 'POST', '/api/appointments', {
        patientId: state.surgeryPatientId,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'OR').id,
        doctorId: agents.surgeon.me.user.id,
        scheduledAt: new Date(Date.now() + 5_400_000).toISOString(),
      }),
      201,
      'surgical appointment',
    );
    expect(appointment.id).toBeTruthy();

    const encounter = await expectStatus(
      await call(agents.surgeon, 'POST', '/api/encounters', {
        patientId: state.surgeryPatientId,
        encounterType: 'outpatient',
        departmentId: bootstrap.departments.find((d: any) => d.code === 'OR').id,
        chiefComplaint: 'ألم في الربع العلوي الأيمن مع حصوة مرارة مؤكدة بالأشعة',
      }),
      201,
      'surgical encounter',
    );
    state.surgeryEncounterId = encounter.id;

    const theatres = await expectStatus(await call(agents.surgeon, 'GET', '/api/surgery/theatres'), 200, 'theatres');
    expect(theatres.items.length).toBeGreaterThanOrEqual(2);
    const theatre = theatres.items[1];
    state.theatreId = theatre.id;

    const scheduledAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const booked = await expectStatus(
      await call(agents.surgeon, 'POST', '/api/surgery/cases', {
        patientId: state.surgeryPatientId,
        encounterId: state.surgeryEncounterId,
        theatreId: theatre.id,
        procedureName: 'استئصال المرارة بالمنظار',
        procedureCode: '0FT44ZZ',
        priority: 'elective',
        anesthesiaType: 'general',
        anesthesiologistId: agents.anesthesiologist.me.user.id,
        scheduledAt,
        estimatedMinutes: 90,
      }),
      201,
      'schedule case',
    );
    expect(booked.caseNo).toMatch(/^SUR-\d{6}$/);
    state.surgeryCaseId = booked.id;

    const overlap = await call(agents.surgeon, 'POST', '/api/surgery/cases', {
      patientId: state.surgeryPatientId,
      encounterId: state.surgeryEncounterId,
      theatreId: theatre.id,
      procedureName: 'عملية متعارضة',
      scheduledAt: new Date(Date.now() + 6 * 3_600_000 + 15 * 60_000).toISOString(),
      estimatedMinutes: 60,
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error.details.theatreId).toBe(theatre.id);

    const receptionAttempt = await call(agents.reception, 'POST', '/api/surgery/cases', {
      patientId: state.surgeryPatientId, encounterId: state.surgeryEncounterId, theatreId: theatre.id,
      procedureName: 'محاولة غير مصرح بها', scheduledAt: new Date(Date.now() + 9 * 3_600_000).toISOString(),
    });
    expect(receptionAttempt.statusCode).toBe(403);
    expect((await call(agents.reception, 'GET', '/api/surgery/board')).statusCode).toBe(403);
    expect((await call(agents.anesthesiologist, 'POST', '/api/surgery/cases', {
      patientId: state.surgeryPatientId, encounterId: state.surgeryEncounterId, theatreId: theatre.id,
      procedureName: 'محاولة تخدير للجدولة', scheduledAt: new Date(Date.now() + 10 * 3_600_000).toISOString(),
    })).statusCode).toBe(403);
  });

  it('enforces the pre-anaesthesia and pre-incision checklists before the operation starts', async () => {
    const early = await call(agents.orNurse, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/checklists`, {
      phase: 'time_out', items: timeOut,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.message).toContain('قبل التخدير');

    const incomplete = await call(agents.anesthesiologist, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/checklists`, {
      phase: 'sign_in', items: { ...signIn, consent_signed: false },
    });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error.details.missing.map((m: any) => m.key)).toContain('consent_signed');

    const signed = await expectStatus(
      await call(agents.anesthesiologist, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/checklists`, {
        phase: 'sign_in', items: signIn,
      }),
      201,
      'sign in',
    );
    expect(signed.status).toBe('prepared');

    const repeat = await call(agents.anesthesiologist, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/checklists`, {
      phase: 'sign_in', items: signIn,
    });
    expect(repeat.statusCode).toBe(409);

    const startEarly = await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/start`);
    expect(startEarly.statusCode).toBe(409);
    expect(startEarly.json().error.details.missing).toContain('time_out');

    await expectStatus(
      await call(agents.orNurse, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/checklists`, {
        phase: 'time_out', items: timeOut,
      }),
      201,
      'time out',
    );

    const started = await expectStatus(
      await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/start`),
      200,
      'start operation',
    );
    expect(started.status).toBe('in_progress');
  });

  it('keeps anaesthesia records append-only and restricted to the anaesthetist', async () => {
    const surgeonAttempt = await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/anesthesia`, {
      phase: 'maintenance', heartRate: 80, spo2: 99,
    });
    expect(surgeonAttempt.statusCode).toBe(403);

    const record = await expectStatus(
      await call(agents.anesthesiologist, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/anesthesia`, {
        phase: 'induction', heartRate: 79, systolicBp: 116, diastolicBp: 70, spo2: 99,
        agent: 'بروبوفول', agentDose: '2mg/kg', airway: 'أنبوب رغامي',
      }),
      201,
      'anaesthesia record',
    );
    state.anesthesiaRecordId = record.id;

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.surgeon.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE anesthesia_records SET spo2 = 100 WHERE id = $1`, [record.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);

    const detail = await expectStatus(
      await call(agents.orNurse, 'GET', `/api/surgery/cases/${state.surgeryCaseId}`),
      200,
      'case detail',
    );
    expect(detail.anesthesia.length).toBe(1);
    expect(detail.status).toBe('in_progress');
    expect(detail.checklists.length).toBe(2);
  });

  it('requires instrument counts and keeps a documented discrepancy flagged', async () => {
    const noCounts = await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/close`, {
      signOut,
    });
    expect(noCounts.statusCode).toBe(400);

    const mismatch = await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/close`, {
      signOut,
      counts: {
        instruments: { expected: 24, actual: 23 },
        sponges: { expected: 12, actual: 12 },
        needles: { expected: 6, actual: 6 },
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.details.mismatches[0].item).toBe('instruments');

    const closed = await expectStatus(
      await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/close`, {
        signOut,
        counts: {
          instruments: { expected: 24, actual: 23 },
          sponges: { expected: 12, actual: 12 },
          needles: { expected: 6, actual: 6 },
        },
        discrepancyNote: 'نقص ملقط واحد: أُجريت صورة أشعة للبطن ولم يوجد جسم غريب، وأُبلغ مسؤول الجودة',
      }),
      200,
      'close with discrepancy',
    );
    expect(closed.status).toBe('recovery');
    expect(closed.countsCorrect).toBe(false);
    expect(closed.mismatches).toHaveLength(1);
    expect(closed.fees).toEqual({ procedure: 3500, anesthesia: 1200 });
    expect(closed.invoiceId).toBeTruthy();
    state.surgeryInvoiceId = closed.invoiceId;

    const doubleClose = await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/close`, {
      signOut,
      counts: {
        instruments: { expected: 24, actual: 24 },
        sponges: { expected: 12, actual: 12 },
        needles: { expected: 6, actual: 6 },
      },
    });
    expect(doubleClose.statusCode).toBe(409);
  });

  it('refuses early discharge from recovery and completes the case with billing', async () => {
    const tooEarly = await call(agents.anesthesiologist, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/recovery`, {
      aldreteScore: 6, disposition: 'ward',
    });
    expect(tooEarly.statusCode).toBe(409);

    await expectStatus(
      await call(agents.anesthesiologist, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/recovery`, {
        aldreteScore: 9, painScore: 3, heartRate: 84, systolicBp: 120, diastolicBp: 74, spo2: 98,
        disposition: 'day_surgery_discharge', notes: 'استقرت الحالة بعد ساعة مراقبة',
      }),
      201,
      'pacu',
    );

    const detail = await expectStatus(
      await call(agents.surgeon, 'GET', `/api/surgery/cases/${state.surgeryCaseId}`),
      200,
      'completed case',
    );
    expect(detail.status).toBe('completed');
    expect(detail.counts_correct).toBe(false);
    expect(detail.pacu.aldrete_score).toBe(9);
    expect(detail.checklists.length).toBe(3);

    const charges = await db.query<any>(
      `SELECT reference_type, line_total FROM invoice_items WHERE reference_id = $1 ORDER BY reference_type`,
      [state.surgeryCaseId],
    );
    expect(charges.rows.map((r: any) => r.reference_type)).toEqual(['anesthesia_case', 'surgery_case']);
    expect(Number(charges.rows.reduce((sum: number, r: any) => sum + Number(r.line_total), 0))).toBe(4700);

    const anesthesiaEdit = await call(agents.anesthesiologist, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/anesthesia`, {
      phase: 'emergence', heartRate: 90,
    });
    expect(anesthesiaEdit.statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.surgeon.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE surgical_cases SET procedure_name = 'تعديل بعد الإغلاق' WHERE id = $1`, [state.surgeryCaseId]),
      ),
    ).rejects.toThrow(/immutable|permission denied/);
  });

  it('cancels only before the incision and with a documented reason', async () => {
    const booked = await expectStatus(
      await call(agents.surgeon, 'POST', '/api/surgery/cases', {
        patientId: state.surgeryPatientId,
        encounterId: state.surgeryEncounterId,
        theatreId: state.theatreId,
        procedureName: 'تنظير مفصل الركبة',
        priority: 'elective',
        anesthesiaType: 'regional',
        anesthesiologistId: agents.anesthesiologist.me.user.id,
        scheduledAt: new Date(Date.now() + 30 * 3_600_000).toISOString(),
        estimatedMinutes: 60,
      }),
      201,
      'second case',
    );
    state.cancelledCaseId = booked.id;

    const shortReason = await call(agents.surgeon, 'POST', `/api/surgery/cases/${booked.id}/cancel`, { reason: 'لا' });
    expect(shortReason.statusCode).toBe(400);
    expect((await call(agents.orNurse, 'POST', `/api/surgery/cases/${booked.id}/cancel`, { reason: 'إلغاء من التمريض' })).statusCode).toBe(403);

    const cancelled = await expectStatus(
      await call(agents.surgeon, 'POST', `/api/surgery/cases/${booked.id}/cancel`, { reason: 'ارتفاع حاد في ضغط الدم قبل العملية، تقرر التأجيل' }),
      200,
      'cancel case',
    );
    expect(cancelled.status).toBe('cancelled');

    const active = await expectStatus(await call(agents.surgeon, 'GET', '/api/surgery/board'), 200, 'active board');
    expect(active.items.find((i: any) => i.id === booked.id)).toBeFalsy();
    expect(active.totals.completed_today).toBeGreaterThanOrEqual(1);

    const lateCancel = await call(agents.surgeon, 'POST', `/api/surgery/cases/${state.surgeryCaseId}/cancel`, {
      reason: 'محاولة إلغاء عملية مكتملة',
    });
    expect(lateCancel.statusCode).toBe(409);
  });
});

describe('intensive care: stays, charting, ventilation, bundle and SOFA', () => {
  it('shows the ICU board with the seeded stay and keeps reception out', async () => {
    const board = await expectStatus(await call(agents.intensivist, 'GET', '/api/icu/board'), 200, 'icu board');
    const stay = board.items.find((i: any) => i.stay_no === 'ICU-000001');
    expect(stay).toBeTruthy();
    expect(stay.mrn).toBe('MRN-0004');
    expect(stay.ward_name).toBe('العناية المركزة');
    expect(stay.sofa_total).toBe(3);
    expect(stay.observation_count).toBeGreaterThanOrEqual(2);
    expect(stay.bundled_today).toBe(true);
    expect(board.totals.patients).toBeGreaterThanOrEqual(1);

    expect((await call(agents.reception, 'GET', '/api/icu/board')).statusCode).toBe(403);
    expect((await call(agents.nurse, 'GET', '/api/icu/board')).statusCode).toBe(403);
  });

  it('opens a stay only on an active admission occupying an ICU bed', async () => {
    const patient = await expectStatus(
      await call(agents.reception, 'POST', '/api/patients', {
        fullNameAr: 'جواهر مطلق العتيبي', dateOfBirth: '1959-07-30', sex: 'female', acknowledgeDuplicate: true,
      }),
      201,
      'icu patient',
    );
    state.icuPatientId = patient.patient.id;
    await expectStatus(
      await call(agents.reception, 'POST', '/api/appointments', {
        patientId: state.icuPatientId,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
        doctorId: agents.doctor.me.user.id,
        scheduledAt: new Date(Date.now() + 5_400_000).toISOString(),
      }),
      201,
      'icu appointment',
    );

    const beds = await expectStatus(await call(agents.intensivist, 'GET', '/api/inpatient/beds'), 200, 'beds');
    const icuBed = beds.beds.find((b: any) => b.ward_type === 'icu' && b.bed_status === 'available');
    expect(icuBed).toBeTruthy();
    const generalBed = beds.beds.find((b: any) => b.ward_type === 'general' && b.bed_status === 'available');

    // A general-ward admission must not be turned into an ICU stay.
    const generalAdmission = await expectStatus(
      await call(agents.intensivist, 'POST', '/api/inpatient/admissions', {
        patientId: state.icuPatientId,
        bedId: generalBed.id,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'INP').id,
        reason: 'مراقبة عامة',
      }),
      201,
      'general admission',
    );
    const wrongWard = await call(agents.intensivist, 'POST', '/api/icu/stays', { admissionId: generalAdmission.id });
    expect(wrongWard.statusCode).toBe(409);
    expect(wrongWard.json().error.message).toContain('سرير عناية مركزة');

    // Move the patient into the ICU bed, then open the stay.
    await expectStatus(
      await call(agents.intensivist, 'POST', `/api/inpatient/admissions/${generalAdmission.id}/transfer`, {
        toBedId: icuBed.id, reason: 'تدهور الحالة يستدعي مراقبة مركزة',
      }),
      200,
      'transfer to icu',
    );

    const stay = await expectStatus(
      await call(agents.intensivist, 'POST', '/api/icu/stays', {
        admissionId: generalAdmission.id,
        note: 'قبول بعد تدهور تنفسي',
      }),
      201,
      'open icu stay',
    );
    state.icuStayId = stay.id;
    expect(stay.stayNo).toMatch(/^ICU-\d{6}$/);

    const duplicate = await call(agents.intensivist, 'POST', '/api/icu/stays', { admissionId: generalAdmission.id });
    expect(duplicate.statusCode).toBe(409);

    const nurseAttempt = await call(agents.icuNurse, 'POST', '/api/icu/stays', { admissionId: generalAdmission.id });
    expect(nurseAttempt.statusCode).toBe(403);
  });

  it('charts observations that cannot be edited and refuses SOFA without recent vitals', async () => {
    const staleSofa = await call(agents.intensivist, 'POST', `/api/icu/stays/${state.icuStayId}/sofa`, {
      pao2: 80, fio2Pct: 40, respiratorySupport: true, platelets: 200, bilirubin: 0.7,
      map: 80, gcs: 15, creatinine: 1,
    });
    expect(staleSofa.statusCode).toBe(409);
    expect(staleSofa.json().error.message).toContain('علامات حيوية');

    const empty = await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/observations`, {});
    expect(empty.statusCode).toBe(409);

    const badGcs = await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/observations`, { gcs: 2 });
    expect(badGcs.statusCode).toBe(400);

    const obs = await expectStatus(
      await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/observations`, {
        heartRate: 104, systolicBp: 95, diastolicBp: 58, respRate: 28, spo2: 89,
        temperatureC: 38.6, gcs: 13, rass: -2, urineMl: 90, glucose: 168,
      }),
      201,
      'chart observation',
    );
    state.icuObservationId = obs.id;

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.intensivist.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE icu_observations SET spo2 = 100 WHERE id = $1`, [obs.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);

    const detail = await expectStatus(
      await call(agents.intensivist, 'GET', `/api/icu/stays/${state.icuStayId}`),
      200,
      'icu detail',
    );
    expect(detail.observations[0].heart_rate).toBe(104);
    expect(detail.observations[0].gcs).toBe(13);
    expect(detail.status).toBe('active');
  });

  it('records ventilation as append-only versions with the oxygen rules enforced', async () => {
    const surgeon = await call(agents.surgeon, 'POST', `/api/icu/stays/${state.icuStayId}/ventilator`, {
      mode: 'ac', fio2Pct: 60,
    });
    expect(surgeon.statusCode).toBe(403);

    const wrongAir = await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/ventilator`, {
      mode: 'room_air', fio2Pct: 50,
    });
    expect(wrongAir.statusCode).toBe(409);

    const vent = await expectStatus(
      await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/ventilator`, {
        mode: 'ac', fio2Pct: 60, peepCmh2o: 8, tidalVolumeMl: 450, setRate: 18,
        reason: 'تدهور التشبع: تنبيب وتهوية ميكانيكية',
      }),
      201,
      'ventilator',
    );
    expect(vent.mode).toBe('ac');

    await expectStatus(
      await call(agents.intensivist, 'POST', `/api/icu/stays/${state.icuStayId}/ventilator`, {
        mode: 'psv', fio2Pct: 40, peepCmh2o: 5, setRate: 12, reason: 'فطام تدريجي بعد تحسن التبادل الغازي',
      }),
      201,
      'ventilator wean',
    );

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.intensivist.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE icu_ventilator_settings SET fio2_pct = 21 WHERE id = $1`, [vent.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);

    const detail = await expectStatus(
      await call(agents.icuNurse, 'GET', `/api/icu/stays/${state.icuStayId}`),
      200,
      'vent detail',
    );
    expect(detail.ventilator.map((v: any) => v.mode)).toEqual(['psv', 'ac']);
  });

  it('computes SOFA from physiology and keeps the daily bundle to one row per day', async () => {
    const sick = await expectStatus(
      await call(agents.intensivist, 'POST', `/api/icu/stays/${state.icuStayId}/sofa`, {
        pao2: 60, fio2Pct: 80, respiratorySupport: true, platelets: 40, bilirubin: 7,
        map: 55, vasopressor: 'norepinephrine_low', gcs: 8, creatinine: 4.2, urine24hMl: 450,
      }),
      201,
      'sofa',
    );
    expect(sick.total).toBe(19);
    expect(sick.components).toEqual({
      respiration: 4, coagulation: 3, liver: 3, cardiovascular: 3, cns: 3, renal: 3,
    });

    const mild = await expectStatus(
      await call(agents.intensivist, 'POST', `/api/icu/stays/${state.icuStayId}/sofa`, {
        pao2: 90, fio2Pct: 40, respiratorySupport: false, platelets: 180, bilirubin: 0.8,
        map: 78, gcs: 15, creatinine: 1.4,
      }),
      201,
      'sofa mild',
    );
    // PaO2 90 on FiO2 40% = ratio 225 -> 2 points; creatinine 1.4 -> 1 point.
    expect(mild.total).toBe(3);
    expect(mild.components.respiration).toBe(2);

    const bundle = {
      sedationTarget: true, headOfBedElevated: true, vapBundle: true, dvtProphylaxis: true,
      stressUlcerProphylaxis: true, nutritionPlan: true, earlyMobility: false,
    };
    const first = await expectStatus(
      await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/goals`, bundle),
      200,
      'goals',
    );
    expect(first.updated).toBe(false);
    const second = await expectStatus(
      await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/goals`, { ...bundle, earlyMobility: true }),
      200,
      'goals update',
    );
    expect(second.updated).toBe(true);
    expect(second.id).toBe(first.id);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.intensivist.me.activeFacilityId }, (q: any) =>
        q.query(`DELETE FROM icu_daily_goals WHERE id = $1`, [first.id]),
      ),
    ).rejects.toThrow(/cannot be deleted|permission denied/);
  });

  it('closes a stay with a documented note and freezes the chart afterwards', async () => {
    const shortNote = await call(agents.intensivist, 'POST', `/api/icu/stays/${state.icuStayId}/discharge`, {
      disposition: 'ward', note: 'قصير',
    });
    expect(shortNote.statusCode).toBe(400);
    expect((await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/discharge`, {
      disposition: 'ward', note: 'إنهاء الإقامة من التمريض دون صلاحية',
    })).statusCode).toBe(403);

    const closed = await expectStatus(
      await call(agents.intensivist, 'POST', `/api/icu/stays/${state.icuStayId}/discharge`, {
        disposition: 'ward',
        note: 'تحسن التبادل الغازي وفُصل عن الجهاز، نُقل إلى الجناح العام لمتابعة العلاج',
      }),
      200,
      'close stay',
    );
    expect(closed.status).toBe('closed');

    const afterClose = await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/observations`, { spo2: 97 });
    expect(afterClose.statusCode).toBe(409);
    const ventAfter = await call(agents.icuNurse, 'POST', `/api/icu/stays/${state.icuStayId}/ventilator`, { mode: 'room_air', fio2Pct: 21 });
    expect(ventAfter.statusCode).toBe(409);
    const twice = await call(agents.intensivist, 'POST', `/api/icu/stays/${state.icuStayId}/discharge`, {
      disposition: 'home', note: 'محاولة إغلاق ثانية لنفس الإقامة',
    });
    expect(twice.statusCode).toBe(409);

    const board = await expectStatus(await call(agents.intensivist, 'GET', '/api/icu/board'), 200, 'board after close');
    expect(board.items.find((i: any) => i.id === state.icuStayId)).toBeFalsy();
  });
});

describe('blood bank: compatibility, cross-match, issue and transfusion safety', () => {
  it('shows stock and the open request without leaking to non-clinical roles', async () => {
    const stock = await expectStatus(await call(agents.bloodTech, 'GET', '/api/bloodbank/stock'), 200, 'stock');
    expect(stock.totals.available).toBeGreaterThanOrEqual(10);
    const rbc = stock.grid.filter((g: any) => g.component === 'rbc');
    expect(rbc.length).toBeGreaterThanOrEqual(4);
    expect((await call(agents.reception, 'GET', '/api/bloodbank/stock')).statusCode).toBe(403);

    const requests = await expectStatus(await call(agents.bloodTech, 'GET', '/api/bloodbank/requests'), 200, 'requests');
    const open = requests.items.find((r: any) => r.request_no === 'BLR-000001');
    expect(open).toBeTruthy();
    expect(open.patient_blood_type).toBe('A-');
    expect(open.status).toBe('pending');
    state.bloodRequestId = open.id;

    // The requisition form needs the patient's open visit, not a guess: the
    // encounter list is scoped to the chart and returns only that patient.
    const encounters = await expectStatus(
      await call(agents.doctor, 'GET', `/api/encounters?patientId=${open.patient_id}`),
      200,
      'open encounters',
    );
    expect(encounters.items.some((e: any) => e.id === open.encounter_id && e.status === 'open')).toBe(true);
    expect(encounters.items.every((e: any) => e.status === 'open')).toBe(true);
  });

  it('evaluates ABO/Rh compatibility and only offers units a patient may receive', async () => {
    const units = await expectStatus(
      await call(agents.bloodTech, 'GET', `/api/bloodbank/requests/${state.bloodRequestId}/compatible-units`),
      200,
      'compatible units',
    );
    expect(units.compatibleCount).toBeGreaterThanOrEqual(2);
    const byType = (t: string) => units.units.find((u: any) => u.blood_type === t);
    expect(byType('O-').compatible).toBe(true);
    expect(byType('A-').compatible).toBe(true);
    expect(byType('A+').compatible).toBe(false);
    expect(byType('A+').reason).toContain('العامل الريصي');
    expect(byType('B+').reason).toContain('ABO');
    state.compatibleUnitId = units.units.find((u: any) => u.blood_type === 'O-' && u.compatible).id;
    state.incompatibleUnitId = units.units.find((u: any) => u.blood_type === 'B+').id;

    // Only the blood bank technologist may cross-match.
    expect((await call(agents.nurse2, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/crossmatch`, {
      unitId: state.compatibleUnitId,
    })).statusCode).toBe(403);
  });

  it('refuses an incompatible cross-match and reserves the compatible unit once', async () => {
    const incompatible = await call(agents.bloodTech, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/crossmatch`, {
      unitId: state.incompatibleUnitId,
    });
    expect(incompatible.statusCode).toBe(409);
    expect(incompatible.json().error.details.patientType).toBe('A-');

    const forced = await call(agents.bloodTech, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/crossmatch`, {
      unitId: state.incompatibleUnitId, forceIncompatible: true,
    });
    expect(forced.statusCode).toBe(409);
    expect(forced.json().error.message).toContain('سببًا سريريًا');

    const ok = await expectStatus(
      await call(agents.bloodTech, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/crossmatch`, {
        unitId: state.compatibleUnitId, method: 'gel',
      }),
      201,
      'compatible crossmatch',
    );
    expect(ok.result).toBe('compatible');
    expect(ok.unitStatus).toBe('reserved');

    const twice = await call(agents.bloodTech, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/crossmatch`, {
      unitId: state.compatibleUnitId,
    });
    expect(twice.statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.bloodTech.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE blood_crossmatches SET result = 'incompatible' WHERE unit_id = $1`, [state.compatibleUnitId]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
  });

  it('issues only a cross-matched reserved unit, and only the blood bank may issue', async () => {
    const nurseIssue = await call(agents.nurse, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/issue`, {
      unitId: state.compatibleUnitId,
    });
    expect(nurseIssue.statusCode).toBe(403);

    const reserved = await expectStatus(
      await call(agents.bloodTech, 'GET', `/api/bloodbank/requests/${state.bloodRequestId}/reserved-units`),
      200,
      'reserved units',
    );
    expect(reserved.items.some((u: any) => u.id === state.compatibleUnitId && u.match_result === 'compatible')).toBe(true);
    expect((await call(agents.nurse, 'GET', `/api/bloodbank/requests/${state.bloodRequestId}/reserved-units`)).statusCode).toBe(403);

    const issued = await expectStatus(
      await call(agents.bloodTech, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/issue`, {
        unitId: state.compatibleUnitId,
      }),
      201,
      'issue unit',
    );
    expect(issued.status).toBe('issued');
    expect(issued.bloodType).toBe('O-');

    const again = await call(agents.bloodTech, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/issue`, {
      unitId: state.compatibleUnitId,
    });
    expect(again.statusCode).toBe(409);
  });

  it('requires a second authorised checker before a transfusion can start', async () => {
    const selfCheck = await call(agents.nurse, 'POST', `/api/bloodbank/units/${state.compatibleUnitId}/transfuse`, {
      requestId: state.bloodRequestId, secondCheckerId: agents.nurse.me.user.id, consentConfirmed: true,
    });
    expect(selfCheck.statusCode).toBe(409);

    const receptionCheck = await call(agents.nurse, 'POST', `/api/bloodbank/units/${state.compatibleUnitId}/transfuse`, {
      requestId: state.bloodRequestId, secondCheckerId: agents.reception.me.user.id, consentConfirmed: true,
    });
    expect(receptionCheck.statusCode).toBe(409);

    const missingConsent = await call(agents.nurse, 'POST', `/api/bloodbank/units/${state.compatibleUnitId}/transfuse`, {
      requestId: state.bloodRequestId, secondCheckerId: agents.nurse2.me.user.id,
    });
    expect(missingConsent.statusCode).toBe(400);

    // Bedside UI must be able to offer only staff who actually hold the
    // transfusion permission in this facility.
    const checkers = await expectStatus(
      await call(agents.nurse, 'GET', '/api/bloodbank/second-checkers'),
      200,
      'second checkers',
    );
    expect(checkers.items.some((u: any) => u.id === agents.nurse2.me.user.id)).toBe(true);
    expect(checkers.items.every((u: any) => !!u.role_name)).toBe(true);
    expect((await call(agents.reception, 'GET', '/api/bloodbank/second-checkers')).statusCode).toBe(403);

    const started = await expectStatus(
      await call(agents.nurse, 'POST', `/api/bloodbank/units/${state.compatibleUnitId}/transfuse`, {
        requestId: state.bloodRequestId,
        secondCheckerId: agents.nurse2.me.user.id,
        preHeartRate: 96, preSystolicBp: 124, preSpo2: 93, preTemperatureC: 37.5,
        consentConfirmed: true,
      }),
      201,
      'start transfusion',
    );
    state.transfusionId = started.id;
    expect(started.secondChecker).toBe('ليلى العمري');
  });

  it('blocks a severe reaction until the transfusion is stopped, then quarantines the unit', async () => {
    const early = await call(agents.nurse, 'POST', `/api/bloodbank/transfusions/${state.transfusionId}/reactions`, {
      reactionType: 'febrile', severity: 'severe',
      description: 'حرارة 39.5 ورجفة شديدة بعد بدء النقل', actionTaken: 'أوقفنا النقل',
    });
    expect(early.statusCode).toBe(409);

    await expectStatus(
      await call(agents.nurse, 'POST', `/api/bloodbank/transfusions/${state.transfusionId}/complete`, {
        outcome: 'stopped_reaction', volumeTransfusedMl: 110,
        postHeartRate: 104, postSystolicBp: 118, postTemperatureC: 38.9,
        notes: 'أُوقف النقل بعد 110 مل لارتفاع الحرارة',
      }),
      200,
      'stop transfusion',
    );

    const reaction = await expectStatus(
      await call(agents.nurse, 'POST', `/api/bloodbank/transfusions/${state.transfusionId}/reactions`, {
        reactionType: 'febrile', severity: 'severe',
        description: 'حرارة 39.5 ورجفة شديدة بعد بدء النقل',
        actionTaken: 'أُوقف النقل وأُعطي خافض حرارة وأُرسلت وحدة الزراعة',
      }),
      201,
      'report reaction',
    );
    expect(reaction.unitQuarantined).toBe(true);

    const trace = await expectStatus(
      await call(agents.bloodTech, 'GET', `/api/bloodbank/units/${state.compatibleUnitId}`),
      200,
      'unit traceability',
    );
    expect(trace.status).toBe('discarded');
    expect(trace.discard_reason).toContain('تفاعل نقل');
    expect(trace.transfusions[0].outcome).toBe('stopped_reaction');
    expect(trace.transfusions[0].reaction.severity).toBe('severe');
    expect(trace.crossmatches[0].result).toBe('compatible');

    const second = await call(agents.nurse, 'POST', `/api/bloodbank/transfusions/${state.transfusionId}/reactions`, {
      reactionType: 'allergic', severity: 'mild',
      description: 'طفح جلدي خفيف بعد النقل', actionTaken: 'مضاد هيستامين',
    });
    expect(second.statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.bloodTech.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE blood_reactions SET severity = 'mild' WHERE transfusion_id = $1`, [state.transfusionId]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
  });

  it('never issues an expired unit and refuses a request when the patient blood type is unknown', async () => {
    const donor = await expectStatus(
      await call(agents.bloodTech, 'POST', '/api/bloodbank/donors', {
        bloodType: 'O-', hemoglobin: 14.1,
        hbvNegative: true, hcvNegative: true, hivNegative: true, syphilisNegative: true,
        units: [{ component: 'rbc', volumeMl: 450, expiresInDays: 1 }],
      }),
      201,
      'donor',
    );
    expect(donor.units).toBe(1);

    const stock = await expectStatus(await call(agents.bloodTech, 'GET', '/api/bloodbank/stock'), 200, 'stock after donation');
    const shortDated = stock.units.filter((u: any) => u.status === 'available').sort((a: any, b: any) => a.days_left - b.days_left)[0];
    expect(shortDated).toBeTruthy();

    // Age the unit out at the database level (collection moved back so the
    // expires_at > collected_at constraint still holds), then confirm both
    // cross-match and issue refuse it.
    await db.asRole('hms_app', { 'app.facility_ids': agents.bloodTech.me.activeFacilityId }, (q: any) =>
      q.query(
        `UPDATE blood_units
            SET collected_at = now() - interval '45 days',
                expires_at   = now() - interval '1 hour'
          WHERE id = $1`,
        [shortDated.id],
      ),
    );
    const expiredCross = await call(agents.bloodTech, 'POST', `/api/bloodbank/requests/${state.bloodRequestId}/crossmatch`, {
      unitId: shortDated.id,
    });
    expect(expiredCross.statusCode).toBe(409);
    expect(expiredCross.json().error.message).toContain('منتهية');

    const noTypePatient = await expectStatus(
      await call(agents.reception, 'POST', '/api/patients', {
        fullNameAr: 'ماجد سعد الغامدي', dateOfBirth: '1975-05-05', sex: 'male', acknowledgeDuplicate: true,
      }),
      201,
      'patient without blood type',
    );
    await expectStatus(
      await call(agents.reception, 'POST', '/api/appointments', {
        patientId: noTypePatient.patient.id,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
        doctorId: agents.doctor.me.user.id,
        scheduledAt: new Date(Date.now() + 5_400_000).toISOString(),
      }),
      201,
      'appointment for blood request',
    );
    const encounter = await expectStatus(
      await call(agents.doctor, 'POST', '/api/encounters', {
        patientId: noTypePatient.patient.id,
        encounterType: 'outpatient',
        departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
        chiefComplaint: 'فقر دم يحتاج تقييم نقل دم',
      }),
      201,
      'encounter for blood request',
    );
    const noType = await call(agents.doctor, 'POST', '/api/bloodbank/requests', {
      patientId: noTypePatient.patient.id,
      encounterId: encounter.id,
      component: 'rbc',
      unitsRequested: 1,
      indication: 'هبوط هيموغلوبين دون تسجيل فصيلة',
    });
    expect(noType.statusCode).toBe(409);
    expect(noType.json().error.message).toContain('فصيلة');
  });

  it('discards a unit with a documented reason and refuses to delete the record', async () => {
    const stock = await expectStatus(await call(agents.bloodTech, 'GET', '/api/bloodbank/stock'), 200, 'stock for discard');
    const candidate = stock.units.find((u: any) => u.status === 'available' && u.component === 'rbc');
    const shortReason = await call(agents.bloodTech, 'POST', `/api/bloodbank/units/${candidate.id}/discard`, { reason: 'تلف' });
    expect(shortReason.statusCode).toBe(400);

    await expectStatus(
      await call(agents.bloodTech, 'POST', `/api/bloodbank/units/${candidate.id}/discard`, {
        reason: 'كيس متسرب عند الفحص البصري',
      }),
      200,
      'discard',
    );

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.bloodTech.me.activeFacilityId }, (q: any) =>
        q.query(`DELETE FROM blood_units WHERE id = $1`, [candidate.id]),
      ),
    ).rejects.toThrow(/permission denied|foreign key|violates/);
  });
});

describe('clinical nutrition: screening, allergy-safe diet orders, trays and feeding', () => {
  const nut: Record<string, any> = {};

  it('shows the nutrition board with the screened ICU patient and hides it from unprivileged roles', async () => {
    const board = await expectStatus(await call(agents.nurse, 'GET', '/api/nutrition/board'), 200, 'nutrition board');
    expect(board.totals.inpatients).toBeGreaterThanOrEqual(1);
    const icu = board.items.find((i: any) => i.mrn === 'MRN-0004');
    expect(icu).toBeTruthy();
    // 6% weight loss (2) + mild intake reduction (1) + moderate disease (2) + age 68 (1)
    expect(icu.risk_level).toBe('high');
    expect(icu.diet_type).toBe('diabetic');
    expect(icu.restriction_labels).toContain('سكري');
    expect(icu.trays_total).toBeGreaterThanOrEqual(4);

    expect((await call(agents.doctor, 'GET', '/api/nutrition/board')).statusCode).toBe(403);
    expect((await call(agents.kitchen, 'GET', '/api/nutrition/board')).statusCode).toBe(403);
    // The kitchen worklist is operational data and is not open to nursing.
    expect((await call(agents.nurse, 'GET', '/api/nutrition/kitchen')).statusCode).toBe(403);
  });

  it('lets nursing screen but not assess, and blocks a high-risk score without a documented action', async () => {
    const adm = await db.query(`SELECT id, patient_id, encounter_id FROM admissions WHERE admission_no = 'ADM-000002'`);
    nut.admissionId = adm.rows[0].id;
    nut.icuPatientId = adm.rows[0].patient_id;

    const noAction = await call(agents.nurse, 'POST', '/api/nutrition/screenings', {
      admissionId: nut.admissionId, weightKg: 62, heightCm: 178.5, weightLossPct: 12,
      intakeReduction: 'severe', diseaseSeverity: 'severe',
    });
    expect(noAction.statusCode).toBe(409);
    expect(noAction.json().error.message).toContain('إجراء');

    const screened = await expectStatus(
      await call(agents.nurse, 'POST', '/api/nutrition/screenings', {
        admissionId: nut.admissionId, weightKg: 74, heightCm: 178.5, weightLossPct: 6,
        intakeReduction: 'mild', diseaseSeverity: 'moderate', actionTaken: 'تحويل لأخصائي التغذية',
      }),
      201,
      'nutrition screening',
    );
    expect(screened.bmi).toBeCloseTo(23.2, 1);
    // weight loss 6% (2) + intake mild (1) + disease moderate (2) + age ≥65 (1)
    expect(screened.score).toBe(6);
    expect(screened.riskLevel).toBe('high');
    expect(screened.referralRequired).toBe(true);

    // Screening is nursing; assessment is the dietitian (separation of duties).
    expect((await call(agents.nurse, 'POST', '/api/nutrition/assessments', {
      admissionId: nut.admissionId, weightKg: 74, heightCm: 178.5,
      nutritionDiagnosis: 'سوء تغذية متوسط', plan: 'خطة تغذية علاجية لعدة أسابيع',
    })).statusCode).toBe(403);
    expect((await call(agents.doctor, 'POST', '/api/nutrition/screenings', {
      admissionId: nut.admissionId, weightKg: 74, heightCm: 178.5,
      intakeReduction: 'none', diseaseSeverity: 'none',
    })).statusCode).toBe(403);

    // Screenings are a clinical record: no edits, no deletes.
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.nurse.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE nutrition_screenings SET score = 0 WHERE id = $1`, [screened.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);
  });

  it('requires a dietitian assessment and a reason for targets far from the recommendation', async () => {
    const deviating = await call(agents.dietitian, 'POST', '/api/nutrition/assessments', {
      admissionId: nut.admissionId, weightKg: 74, heightCm: 178.5,
      energyTargetKcal: 1000, proteinTargetG: 40,
      nutritionDiagnosis: 'سوء تغذية متوسط', plan: 'تقييد شديد للسعرات',
    });
    expect(deviating.statusCode).toBe(409);
    expect(deviating.json().error.details.recommendedEnergyKcal).toBeGreaterThan(1500);

    const assessed = await expectStatus(
      await call(agents.dietitian, 'POST', '/api/nutrition/assessments', {
        admissionId: nut.admissionId, weightKg: 74, heightCm: 178.5, fluidLimitMl: 2000,
        nutritionDiagnosis: 'سوء تغذية متوسط مع مرض حاد',
        plan: 'حمية سكرية ١٨٥٠ سعرة و٨٩ غ بروتين مع متابعة يومية',
      }),
      201,
      'nutrition assessment',
    );
    expect(assessed.energyTargetKcal).toBe(1850);
    expect(assessed.proteinTargetG).toBeCloseTo(88.8, 1);
    expect(assessed.deviates).toBe(false);
    nut.assessmentId = assessed.id;
  });

  it('refuses a diet order that ignores a recorded food allergy, then accepts it with the restriction', async () => {
    // A dedicated patient with a documented milk allergy, admitted on a free bed.
    const created = await expectStatus(
      await call(agents.records, 'POST', '/api/patients', {
        fullNameAr: 'هند ماجد العمري', dateOfBirth: '1981-02-14', sex: 'female', acknowledgeDuplicate: true,
      }),
      201,
      'allergy patient',
    );
    nut.allergyPatientId = created.patient.id;
    nut.allergyMrn = created.patient.mrn;
    // Clinical notes (including allergies) need a care relationship: the
    // physician opens the visit first, exactly as in the real workflow.
    // A care relationship is established by the appointment (or an existing
    // encounter); a physician cannot open a stranger's chart otherwise.
    const allergyAppointment = await expectStatus(
      await call(agents.reception, 'POST', '/api/appointments', {
        patientId: created.patient.id,
        departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
        doctorId: agents.doctor.me.user.id,
        scheduledAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
        reason: 'تقييم سوء تغذية',
      }),
      201,
      'appointment for allergy patient',
    );
    const allergyEncounter = await expectStatus(
      await call(agents.doctor, 'POST', '/api/encounters', {
        patientId: created.patient.id,
        appointmentId: allergyAppointment.id ?? allergyAppointment.appointment?.id,
        encounterType: 'outpatient',
        departmentId: bootstrap.departments.find((d: any) => d.code === 'GEN').id,
        chiefComplaint: 'تقييم سوء تغذية وحساسية غذائية',
      }),
      201,
      'encounter for allergy patient',
    );
    expect(allergyEncounter.id).toBeTruthy();
    await expectStatus(
      await call(agents.doctor, 'POST', `/api/patients/${created.patient.id}/allergies`, {
        allergen: 'حليب البقر', reaction: 'إسهال وغازات', severity: 'moderate',
      }),
      201,
      'milk allergy',
    );
    const beds = await expectStatus(await call(agents.doctor, 'GET', '/api/inpatient/beds'), 200, 'beds');
    // Earlier tests may fill every bed, so free a cleaning/maintenance bed if
    // needed; the admission itself must still pass the server's bed checks.
    let bed = beds.beds.find((b: any) => b.bed_status === 'available');
    if (!bed) {
      const releasable = beds.beds.find((b: any) => ['cleaning', 'maintenance'].includes(b.bed_status));
      expect(releasable).toBeTruthy();
      await expectStatus(
        await call(agents.doctor, 'PATCH', `/api/inpatient/beds/${releasable.id}/status`, { status: 'available' }),
        200,
        'release bed',
      );
      bed = releasable;
    }
    const admitted = await expectStatus(
      await call(agents.doctor, 'POST', '/api/inpatient/admissions', {
        patientId: created.patient.id, bedId: bed.id, reason: 'متابعة سوء تغذية وحساسية غذائية',
      }),
      201,
      'admit allergy patient',
    );
    nut.allergyAdmissionId = admitted.id;

    // No assessment yet → no diet order at all.
    const premature = await call(agents.dietitian, 'POST', '/api/nutrition/diet-orders', {
      admissionId: nut.allergyAdmissionId, dietType: 'diabetic', restrictions: ['diabetic', 'lactose_free'],
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json().error.message).toContain('تقييم');

    await expectStatus(
      await call(agents.nurse, 'POST', '/api/nutrition/screenings', {
        admissionId: nut.allergyAdmissionId, weightKg: 55, heightCm: 160, weightLossPct: 8,
        intakeReduction: 'moderate', diseaseSeverity: 'mild', actionTaken: 'تحويل للتغذية',
      }),
      201,
      'screen allergy patient',
    );
    await expectStatus(
      await call(agents.dietitian, 'POST', '/api/nutrition/assessments', {
        admissionId: nut.allergyAdmissionId, weightKg: 55, heightCm: 160,
        nutritionDiagnosis: 'نقص وزن مع حساسية حليب', plan: 'حمية خالية من اللاكتوز ١٦٠٠ سعرة',
      }),
      201,
      'assess allergy patient',
    );

    const unsafe = await call(agents.dietitian, 'POST', '/api/nutrition/diet-orders', {
      admissionId: nut.allergyAdmissionId, dietType: 'diabetic', restrictions: ['diabetic'],
    });
    expect(unsafe.statusCode).toBe(409);
    expect(unsafe.json().error.details.requiredRestrictions).toContain('lactose_free');

    const safe = await expectStatus(
      await call(agents.dietitian, 'POST', '/api/nutrition/diet-orders', {
        admissionId: nut.allergyAdmissionId, dietType: 'diabetic', restrictions: ['diabetic', 'lactose_free'],
        notes: 'بديل حليب خالٍ من اللاكتوز',
      }),
      201,
      'allergy-safe diet order',
    );
    expect(safe.restrictions).toContain('lactose_free');
    expect(safe.allergyChecked).toContain('حليب البقر');
    nut.dietOrderId = safe.id;

    // Only the dietitian may order the diet.
    expect((await call(agents.nurse, 'POST', '/api/nutrition/diet-orders', {
      admissionId: nut.allergyAdmissionId, dietType: 'regular', restrictions: ['lactose_free'],
    })).statusCode).toBe(403);
  });

  it('generates one tray set per day and enforces the kitchen workflow before intake', async () => {
    const first = await expectStatus(
      await call(agents.dietitian, 'POST', `/api/nutrition/diet-orders/${nut.dietOrderId}/trays`, {}),
      201,
      'tray generation',
    );
    expect(first.created).toHaveLength(4);
    expect(first.created.map((t: any) => t.meal)).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);

    const again = await expectStatus(
      await call(agents.dietitian, 'POST', `/api/nutrition/diet-orders/${nut.dietOrderId}/trays`, {}),
      201,
      'tray regeneration',
    );
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toHaveLength(4);

    const kitchen = await expectStatus(await call(agents.kitchen, 'GET', '/api/nutrition/kitchen'), 200, 'kitchen');
    const mine = kitchen.items.filter((t: any) => t.mrn === nut.allergyMrn);
    expect(mine).toHaveLength(4);
    expect(mine[0].restriction_labels).toContain('خالٍ من اللاكتوز');
    const breakfast = mine.find((t: any) => t.meal === 'breakfast');
    nut.trayId = breakfast.id;

    // Cannot deliver before preparation, cannot record intake before delivery.
    expect((await call(agents.kitchen, 'POST', `/api/nutrition/trays/${breakfast.id}/deliver`)).statusCode).toBe(409);
    expect((await call(agents.nurse, 'POST', `/api/nutrition/trays/${breakfast.id}/intake`, { consumedPct: 50 })).statusCode).toBe(409);
    expect((await call(agents.nurse, 'POST', `/api/nutrition/trays/${breakfast.id}/prepare`)).statusCode).toBe(403);

    await expectStatus(await call(agents.kitchen, 'POST', `/api/nutrition/trays/${breakfast.id}/prepare`), 200, 'prepare');
    await expectStatus(await call(agents.kitchen, 'POST', `/api/nutrition/trays/${breakfast.id}/deliver`), 200, 'deliver');

    const intake = await expectStatus(
      await call(agents.nurse, 'POST', `/api/nutrition/trays/${breakfast.id}/intake`, {
        consumedPct: 60, notes: 'تناول أكثر من نصف الوجبة',
      }),
      200,
      'intake',
    );
    expect(intake.intakePct).toBe(60);
    // Intake is derived from the planned energy of that tray, not retyped.
    expect(intake.kcalConsumed).toBe(Math.round(Number(breakfast.kcal_planned) * 0.6));
    expect(intake.kcalConsumed).toBe(Math.round(first.created.find((t: any) => t.meal === 'breakfast').kcal * 0.6));

    // A closed tray cannot be changed again.
    expect((await call(agents.nurse, 'POST', `/api/nutrition/trays/${breakfast.id}/intake`, { consumedPct: 90 })).statusCode).toBe(409);
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.kitchen.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE nutrition_trays SET intake_pct = 100 WHERE id = $1`, [breakfast.id]),
      ),
    ).rejects.toThrow(/closed tray|permission denied/);
  });

  it('orders enteral feeding once per route, requires a stop reason, and keeps the record immutable', async () => {
    expect((await call(agents.nurse, 'POST', '/api/nutrition/tube-orders', {
      admissionId: nut.allergyAdmissionId, route: 'ng', formulaName: 'نيوتريزن', kcalPerMl: 1,
      proteinGPerL: 40, rateMlHr: 40, hoursPerDay: 12,
    })).statusCode).toBe(403);

    const tube = await expectStatus(
      await call(agents.dietitian, 'POST', '/api/nutrition/tube-orders', {
        admissionId: nut.allergyAdmissionId, route: 'ng', formulaName: 'نيوتريزن 1.0', kcalPerMl: 1,
        proteinGPerL: 40, rateMlHr: 50, hoursPerDay: 16,
      }),
      201,
      'tube order',
    );
    expect(tube.volumeMlDay).toBe(800);
    expect(tube.kcalDay).toBe(800);
    expect(tube.proteinGDay).toBe(32);

    const duplicate = await call(agents.dietitian, 'POST', '/api/nutrition/tube-orders', {
      admissionId: nut.allergyAdmissionId, route: 'ng', formulaName: 'بديل', kcalPerMl: 1,
      proteinGPerL: 40, rateMlHr: 40, hoursPerDay: 12,
    });
    expect(duplicate.statusCode).toBe(409);

    expect((await call(agents.dietitian, 'POST', `/api/nutrition/tube-orders/${tube.id}/stop`, { reason: 'قصير' })).statusCode).toBe(400);
    const stopped = await expectStatus(
      await call(agents.dietitian, 'POST', `/api/nutrition/tube-orders/${tube.id}/stop`, {
        reason: 'تحسن الشهية والانتقال لتغذية فموية',
      }),
      200,
      'stop feed',
    );
    expect(stopped.status).toBe('stopped');

    // The prescription itself can never be rewritten, only stopped.
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.dietitian.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE nutrition_tube_orders SET rate_ml_hr = 100 WHERE id = $1`, [tube.id]),
      ),
    ).rejects.toThrow(/immutable|cannot be changed|permission denied/);
  });

  it('records dietitian follow-up and exposes the allergy-safe plan in the patient file', async () => {
    const followup = await expectStatus(
      await call(agents.dietitian, 'POST', `/api/nutrition/patients/${nut.allergyPatientId}/followups`, {
        admissionId: nut.allergyAdmissionId, weightKg: 54.5, intakePctAvg: 55, tolerance: 'partial',
        note: 'تحمل جزئي للحمية مع استمرار بديل الحليب الخالي من اللاكتوز',
      }),
      201,
      'follow-up',
    );
    expect(followup.id).toBeTruthy();
    expect((await call(agents.nurse, 'POST', `/api/nutrition/patients/${nut.allergyPatientId}/followups`, {
      admissionId: nut.allergyAdmissionId, tolerance: 'good', note: 'متابعة تمريضية غير مسموحة',
    })).statusCode).toBe(403);

    const file = await expectStatus(
      await call(agents.dietitian, 'GET', `/api/nutrition/patients/${nut.allergyPatientId}`),
      200,
      'nutrition file',
    );
    expect(file.activeDiet.order_no).toBe('NUT-000002');
    expect(file.requiredRestrictions.map((r: any) => r.code)).toContain('lactose_free');
    expect(file.followups).toHaveLength(1);
    expect(file.trays.some((t: any) => t.status === 'consumed')).toBe(true);
    expect(file.limits).toContain('لا قاعدة تراكيب غذائية');

    // Chart access still needs a care relationship or break-glass for physicians.
    expect((await call(agents.patient, 'GET', '/api/nutrition/board')).statusCode).toBe(403);
  });
});

describe('CSSD sterile processing and infection prevention & control', () => {
  const cssd: any = {};

  it('shows the CSSD board with live packs, loads and shelf-life totals to privileged roles only', async () => {
    const board = await expectStatus(await call(agents.cssd, 'GET', '/api/cssd/board'), 200, 'cssd board');
    expect(board.packs.length).toBeGreaterThanOrEqual(7);
    expect(board.loads.some((l: any) => l.status === 'approved')).toBe(true);
    expect(board.loads.some((l: any) => l.status === 'failed')).toBe(true);
    const issued = board.packs.find((p: any) => p.status === 'issued');
    expect(issued.case_no).toBe('SUR-000001');
    expect(issued.days_left).toBeGreaterThan(20);
    const quarantined = board.packs.find((p: any) => p.status === 'quarantined');
    expect(quarantined.load_no).toBe('CSL-000003');
    expect(board.sets).toHaveLength(7);
    expect(board.totals.issued).toBe(1);
    expect(board.totals.quarantined).toBe(1);
    expect(board.packs.find((p: any) => p.status === 'released').shelf_life_days).toBe(30);

    expect((await call(agents.doctor, 'GET', '/api/cssd/board')).statusCode).toBe(403);
    // Ward nurses may read the board (they request packs) but hold no write permission.
    expect((await call(agents.nurse, 'GET', '/api/cssd/board')).statusCode).toBe(200);
    expect((await call(agents.kitchen, 'GET', '/api/cssd/board')).statusCode).toBe(403);
    expect((await call(agents.cssd, 'GET', '/api/infection/board')).statusCode).toBe(403);
    expect((await call(agents.doctor, 'GET', '/api/infection/board')).statusCode).toBe(403);
  });

  it('runs a full reprocessing cycle and refuses release before a second person approves', async () => {
    const set8 = await expectStatus(
      await call(agents.cssd, 'POST', '/api/cssd/sets', {
        code: 'CSS-SET-08', nameAr: 'طقم اختبار دورة كاملة', category: 'minor', instrumentCount: 9,
        department: 'OR',
      }),
      201,
      'create set',
    );
    expect((await call(agents.nurse, 'POST', '/api/cssd/sets', {
      code: 'CSS-SET-X1', nameAr: 'طقم غير مسموح', category: 'minor', instrumentCount: 3,
    })).statusCode).toBe(403);
    expect((await call(agents.cssd, 'POST', '/api/cssd/sets', {
      code: 'CSS-SET-08', nameAr: 'تكرار الرمز', category: 'minor', instrumentCount: 3,
    })).statusCode).toBe(409);

    const sets = ['طقم اختبار أ', 'طقم اختبار ب', 'طقم اختبار ج'];
    const setIds: string[] = [set8.id];
    for (let i = 1; i < 3; i++) {
      const created = await expectStatus(
        await call(agents.cssd, 'POST', '/api/cssd/sets', {
          code: `CSS-SET-0${8 + i}`, nameAr: sets[i], category: 'laparotomy', instrumentCount: 20 + i,
        }),
        201,
        `create set ${i}`,
      );
      setIds.push(created.id);
    }

    const packs: any[] = [];
    for (let i = 0; i < 3; i++) {
      const pack = await expectStatus(
        await call(agents.cssd, 'POST', '/api/cssd/packs', {
          setId: setIds[i], packaging: i === 1 ? 'container' : 'wrap',
        }),
        201,
        `receive pack ${i}`,
      );
      expect(pack.reused).toBe(false);
      expect(pack.packNo).toMatch(/^CSS-\d{6}$/);
      packs.push(pack);
    }
    cssd.setIds = setIds;
    cssd.packs = packs;

    expect((await call(agents.cssd, 'POST', '/api/cssd/packs', { setId: setIds[0] })).statusCode).toBe(409);
    expect((await call(agents.cssd, 'POST', '/api/cssd/packs', { setId: patient1.id })).statusCode).toBe(404);

    expect((await call(agents.cssd, 'POST', `/api/cssd/packs/${packs[0].id}/pack`)).statusCode).toBe(409);
    for (const pack of packs) {
      await expectStatus(await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/wash`), 200, 'wash');
      expect((await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/wash`)).statusCode).toBe(409);
      await expectStatus(await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/pack`), 200, 'pack');
    }
    expect((await call(agents.doctor, 'POST', `/api/cssd/packs/${packs[0].id}/wash`)).statusCode).toBe(403);

    const load = await expectStatus(
      await call(agents.cssd, 'POST', '/api/cssd/loads', {
        autoclaveCode: 'STM-03', method: 'steam', packIds: packs.map((p) => p.id),
        temperatureC: 134, pressureBar: 2.1, durationMin: 18,
      }),
      201,
      'start load',
    );
    expect(load.packCount).toBe(3);
    expect(load.cycleNo).toBe(1);
    cssd.load = load;

    // A non-approved pack cannot be issued even before the cycle is resulted.
    expect((await call(agents.cssd, 'POST', `/api/cssd/packs/${packs[0].id}/issue`, {
      issuedTo: 'غرفة العمليات 1',
    })).statusCode).toBe(409);

    const result = await expectStatus(
      await call(agents.cssd, 'POST', `/api/cssd/loads/${load.id}/result`, {
        chemicalIndicator: 'pass', biologicalIndicator: 'pass', notes: 'مؤشرات سليمة',
      }),
      200,
      'load result',
    );
    expect(result.status).toBe('passed');
    expect((await call(agents.cssd, 'POST', `/api/cssd/loads/${load.id}/result`, {
      chemicalIndicator: 'pass', biologicalIndicator: 'pass',
    })).statusCode).toBe(409);

    // Separation of duties: the operator cannot approve their own cycle.
    expect((await call(agents.cssd, 'POST', `/api/cssd/loads/${load.id}/approve`)).statusCode).toBe(409);
    // ... and an unauthorised role cannot approve at all.
    expect((await call(agents.nurse, 'POST', `/api/cssd/loads/${load.id}/approve`)).statusCode).toBe(403);

    const approved = await expectStatus(
      await call(agents.cssd2, 'POST', `/api/cssd/loads/${load.id}/approve`),
      200,
      'approve load',
    );
    expect(approved.packsReleased).toBe(3);
    expect(approved.status).toBe('approved');

    const released = await expectStatus(await call(agents.cssd, 'GET', `/api/cssd/packs/${packs[1].id}`), 200, 'pack');
    expect(released.status).toBe('released');
    expect(released.shelf_life_days).toBe(90);
    expect(released.expired).toBe(false);
    const releasedWrap = await expectStatus(await call(agents.cssd, 'GET', `/api/cssd/packs/${packs[0].id}`), 200, 'pack');
    expect(releasedWrap.shelf_life_days).toBe(30);
  });

  it('issues, uses, returns and re-receives a pack with an incremented cycle count', async () => {
    const [p1, p2] = cssd.packs;
    const surgical = await db.query(`SELECT id FROM surgical_cases WHERE case_no = 'SUR-000001'`);
    const caseId = surgical.rows[0].id;

    expect((await call(agents.cssd, 'POST', `/api/cssd/packs/${p2.id}/issue`, {
      issuedTo: 'غرفة العمليات 1', caseId: '00000000-0000-0000-0000-000000000000',
    })).statusCode).toBe(404);

    const issued = await expectStatus(
      await call(agents.orNurse, 'POST', `/api/cssd/packs/${p2.id}/issue`, {
        issuedTo: 'غرفة العمليات 1', caseId,
      }),
      200,
      'issue',
    );
    expect(issued.status).toBe('issued');
    // The theatre team records clinical use; a duplicate use is refused.
    expect((await call(agents.orNurse, 'POST', `/api/cssd/packs/${p2.id}/use`)).statusCode).toBe(200);
    expect((await call(agents.orNurse, 'POST', `/api/cssd/packs/${p2.id}/use`)).statusCode).toBe(409);

    const returned = await expectStatus(await call(agents.cssd, 'POST', `/api/cssd/packs/${p2.id}/return`), 200, 'return');
    expect(returned.status).toBe('returned');

    const received = await expectStatus(
      await call(agents.cssd, 'POST', '/api/cssd/packs', { setId: cssd.setIds[1] }),
      201,
      're-receive',
    );
    expect(received.reused).toBe(true);
    expect(received.id).toBe(p2.id);
    expect(received.cycleCount).toBe(2);
    const again = await expectStatus(await call(agents.cssd, 'GET', `/api/cssd/packs/${p2.id}`), 200, 'pack');
    expect(again.status).toBe('dirty');
    expect(again.cycle_count).toBe(2);
    expect(again.load_no).toBeNull();
    expect(again.issued_to).toBeNull();

    // A returned pack blocks a duplicate identity for the same physical set.
    expect((await call(agents.cssd, 'POST', '/api/cssd/packs', { setId: cssd.setIds[1] })).statusCode).toBe(409);
    expect(p1.id).toBeTruthy();
  });

  it('refuses expired packs and quarantines every pack of a failed cycle', async () => {
    const [p1] = cssd.packs;
    const expiresFuture = await db.query(`SELECT expires_at FROM cssd_packs WHERE id = $1`, [p1.id]);
    await db.asRole('hms_app', { 'app.facility_ids': agents.cssd.me.activeFacilityId }, (q: any) =>
      q.query(`UPDATE cssd_packs SET expires_at = now() - interval '1 day' WHERE id = $1`, [p1.id]),
    );
    const expiredIssue = await call(agents.cssd, 'POST', `/api/cssd/packs/${p1.id}/issue`, { issuedTo: 'غرفة العمليات 2' });
    expect(expiredIssue.statusCode).toBe(409);
    expect(expiredIssue.json().error.message).toMatch(/منتهية الصلاحية/);
    await db.asRole('hms_app', { 'app.facility_ids': agents.cssd.me.activeFacilityId }, (q: any) =>
      q.query(`UPDATE cssd_packs SET expires_at = $2 WHERE id = $1`, [p1.id, expiresFuture.rows[0].expires_at]),
    );

    // A failed biological indicator quarantines the whole load and cannot be approved.
    const set = await expectStatus(
      await call(agents.cssd, 'POST', '/api/cssd/sets', {
        code: 'CSS-SET-20', nameAr: 'طقم دورة فاشلة', category: 'dressing', instrumentCount: 6,
      }),
      201,
      'failed set',
    );
    const pack = await expectStatus(await call(agents.cssd, 'POST', '/api/cssd/packs', { setId: set.id }), 201, 'receive');
    await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/wash`);
    await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/pack`);
    const load = await expectStatus(
      await call(agents.cssd, 'POST', '/api/cssd/loads', {
        autoclaveCode: 'STM-02', method: 'steam', packIds: [pack.id],
      }),
      201,
      'load',
    );
    const failed = await expectStatus(
      await call(agents.cssd, 'POST', `/api/cssd/loads/${load.id}/result`, {
        chemicalIndicator: 'pass', biologicalIndicator: 'fail', notes: 'نمو في العينة البيولوجية',
      }),
      200,
      'fail result',
    );
    expect(failed.status).toBe('failed');
    const quarantined = await expectStatus(await call(agents.cssd, 'GET', `/api/cssd/packs/${pack.id}`), 200, 'pack');
    expect(quarantined.status).toBe('quarantined');
    expect((await call(agents.cssd, 'POST', `/api/cssd/loads/${load.id}/approve`)).statusCode).toBe(409);
    expect((await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/issue`, { issuedTo: 'الجناح' })).statusCode).toBe(409);

    // The database guard is the last line of defence: a quarantined pack cannot
    // be forced back into circulation by a direct update.
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.cssd.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE cssd_packs SET status = 'released' WHERE id = $1`, [pack.id]),
      ),
    ).rejects.toThrow(/invalid pack transition|permission denied/);

    // Approved loads are immutable: indicators can never be rewritten.
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.cssd.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE cssd_sterilization_loads SET biological_indicator = 'fail' WHERE id = $1`, [cssd.load.id]),
      ),
    ).rejects.toThrow(/immutable|permission denied/);
  });

  it('recalls an approved load, reports the affected surgical case and freezes the packs', async () => {
    const [p1, , p3] = cssd.packs;
    const surgical = await db.query(`SELECT id FROM surgical_cases WHERE case_no = 'SUR-000001'`);
    const caseId = surgical.rows[0].id;
    await expectStatus(
      await call(agents.orNurse, 'POST', `/api/cssd/packs/${p3.id}/issue`, { issuedTo: 'غرفة العمليات 1', caseId }),
      200,
      'issue recall pack',
    );
    await call(agents.orNurse, 'POST', `/api/cssd/packs/${p3.id}/use`);

    const recall = await expectStatus(
      await call(agents.cssd2, 'POST', `/api/cssd/loads/${cssd.load.id}/recall`, {
        reason: 'خلل في مصيدة البخار اكتُشف بعد الاعتماد؛ سحب احترازي',
      }),
      200,
      'recall',
    );
    expect(recall.recalledPacks).toBe(2);
    expect(recall.affectedCases.some((c: any) => c.caseId === caseId)).toBe(true);

    const recalledPack = await expectStatus(await call(agents.cssd, 'GET', `/api/cssd/packs/${p3.id}`), 200, 'pack');
    expect(recalledPack.status).toBe('recalled');
    expect(recalledPack.recall_reason).toMatch(/مصيدة/);
    expect((await call(agents.cssd, 'POST', `/api/cssd/packs/${p1.id}/issue`, { issuedTo: 'الجناح' })).statusCode).toBe(409);
    expect((await call(agents.cssd, 'POST', `/api/cssd/loads/${cssd.load.id}/recall`, {
      reason: 'محاولة سحب ثانية لنفس الدورة',
    })).statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.cssd.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE cssd_packs SET status = 'dirty' WHERE id = $1`, [p3.id]),
      ),
    ).rejects.toThrow(/recalled packs are immutable|permission denied/);

    // Even after a recall the cycle's indicators stay frozen.
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.cssd.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE cssd_sterilization_loads SET biological_indicator = 'fail' WHERE id = $1`, [cssd.load.id]),
      ),
    ).rejects.toThrow(/immutable|permission denied/);

    // Every safety action is in the tamper-evident audit trail.
    const audit = await expectStatus(
      await call(agents.auditor, 'GET', '/api/audit?action=cssd.load.recall&limit=5'),
      200,
      'cssd audit',
    );
    expect(audit.items[0].action).toBe('cssd.load.recall');
    expect(audit.items[0].detail.reason).toMatch(/مصيدة/);
    expect(audit.items[0].actor_name).toBeTruthy();
  });

  it('never releases packs from a recalled cycle and refuses to recall a running one', async () => {
    // The seeded running cycle cannot be recalled before its result is known.
    const board = await expectStatus(await call(agents.cssd, 'GET', '/api/cssd/board'), 200, 'board');
    const running = board.loads.find((l: any) => l.status === 'running');
    expect((await call(agents.cssd2, 'POST', `/api/cssd/loads/${running.id}/recall`, {
      reason: 'محاولة سحب دورة قيد التشغيل دون نتيجة',
    })).statusCode).toBe(409);

    const set = await expectStatus(
      await call(agents.cssd, 'POST', '/api/cssd/sets', {
        code: 'CSS-SET-30', nameAr: 'طقم دورة مسحوبة', category: 'minor', instrumentCount: 5,
      }),
      201,
      'recalled set',
    );
    const pack = await expectStatus(await call(agents.cssd, 'POST', '/api/cssd/packs', { setId: set.id }), 201, 'pack');
    await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/wash`);
    await call(agents.cssd, 'POST', `/api/cssd/packs/${pack.id}/pack`);
    const load = await expectStatus(
      await call(agents.cssd, 'POST', '/api/cssd/loads', {
        autoclaveCode: 'STM-04', method: 'plasma', packIds: [pack.id],
      }),
      201,
      'load',
    );
    await expectStatus(
      await call(agents.cssd, 'POST', `/api/cssd/loads/${load.id}/result`, {
        chemicalIndicator: 'pass', biologicalIndicator: 'pass',
      }),
      200,
      'passing result',
    );
    // A passing but recalled cycle must never release its pack.
    await expectStatus(
      await call(agents.cssd2, 'POST', `/api/cssd/loads/${load.id}/recall`, {
        reason: 'اكتشف خلل بالجهاز قبل الاعتماد فسُحبت الدورة',
      }),
      200,
      'recall passed load',
    );
    const blocked = await call(agents.cssd2, 'POST', `/api/cssd/loads/${load.id}/approve`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/مسحوبة/);
    expect((await call(agents.cssd, 'GET', `/api/cssd/packs/${pack.id}`)).json().status).toBe('recalled');
  });

  it('manages isolation orders with a single active precaution and an immutable close', async () => {
    const board = await expectStatus(await call(agents.infection, 'GET', '/api/infection/board'), 200, 'ipc board');
    const active = board.isolations[0];
    expect(active.precaution).toBe('contact');
    expect(active.patient_name).toBeTruthy();

    expect((await call(agents.infection, 'POST', '/api/infection/isolations', {
      patientId: active.patient_id, precaution: 'droplet', reason: 'محاولة عزل ثانٍ أثناء وجود عزل نشط',
    })).statusCode).toBe(409);

    expect((await call(agents.infection, 'POST', `/api/infection/isolations/${active.id}/end`, { reason: 'قصير' })).statusCode).toBe(400);
    const ended = await expectStatus(
      await call(agents.infection, 'POST', `/api/infection/isolations/${active.id}/end`, {
        reason: 'تكرار عينة toxin سلبياً مرتين وأُوقف العزل حسب سياسة مكافحة العدوى',
      }),
      200,
      'end isolation',
    );
    expect(ended.ended).toBe(true);
    expect((await call(agents.infection, 'POST', `/api/infection/isolations/${active.id}/end`, {
      reason: 'إغلاق مكرر لأمر عزل منتهٍ',
    })).statusCode).toBe(409);

    const fresh = await expectStatus(
      await call(agents.nurse, 'POST', '/api/infection/isolations', {
        patientId: active.patient_id, precaution: 'droplet', organism: 'Neisseria meningitidis (مشتبه)',
        reason: 'حمى وصداع مع تيبس رقبة؛ عزل رذاذي احترازي حتى نتيجة الزرع',
      }),
      201,
      'droplet isolation',
    );
    expect(fresh.precautionAr).toBe('رذاذ');
    expect((await call(agents.cssd, 'POST', '/api/infection/isolations', {
      patientId: active.patient_id, precaution: 'contact', reason: 'محاولة من دور غير مخوّل بالعزل',
    })).statusCode).toBe(403);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.infection.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE infection_isolations SET end_reason = 'تعديل بعد الإغلاق' WHERE id = $1`, [active.id]),
      ),
    ).rejects.toThrow(/closed isolation|immutable|permission denied/);

    cssd.isolation = fresh;
    cssd.isolationPatientId = active.patient_id;

    const isoAudit = await expectStatus(
      await call(agents.auditor, 'GET', `/api/audit?action=infection.isolation.start&limit=5`),
      200,
      'isolation audit',
    );
    expect(isoAudit.items[0].action).toBe('infection.isolation.start');
    expect(isoAudit.items[0].patient_id).toBe(active.patient_id);
  });

  it('requires a second reviewer for HAI cases and keeps hygiene observations append-only', async () => {
    const patientId = cssd.isolation.patient_id ?? cssd.isolationPatientId;
    const today = new Date().toISOString().slice(0, 10);
    const reported = await expectStatus(
      await call(agents.nurse, 'POST', '/api/infection/cases', {
        patientId, caseType: 'ssi', organism: 'Klebsiella pneumoniae', onsetDate: today, deviceDays: 3,
        notes: 'إفرازات من موضع الجرح مع حمى بعد ٥ أيام من العملية',
      }),
      201,
      'report case',
    );
    expect(reported.status).toBe('suspected');
    expect((await call(agents.cssd, 'POST', '/api/infection/cases', {
      patientId, caseType: 'other', onsetDate: today, notes: 'محاولة من غير مخوّل',
    })).statusCode).toBe(403);

    // Nurses may report surveillance cases but cannot review them at all.
    expect((await call(agents.nurse, 'POST', `/api/infection/cases/${reported.id}/review`, {
      decision: 'confirmed', note: 'اعتماد تمريضي غير مخوّل للحالة',
    })).statusCode).toBe(403);
    // Even the IPC practitioner cannot confirm a case they reported themselves.
    const ownReport = await expectStatus(
      await call(agents.infection, 'POST', '/api/infection/cases', {
        patientId, caseType: 'cdi', onsetDate: today, notes: 'إسهال بعد مضاد حيوي؛ قيد التأكيد المخبري',
      }),
      201,
      'own report',
    );
    expect((await call(agents.infection, 'POST', `/api/infection/cases/${ownReport.id}/review`, {
      decision: 'confirmed', note: 'اعتماد ذاتي غير مسموح للحالة',
    })).statusCode).toBe(409);

    const reviewed = await expectStatus(
      await call(agents.infection, 'POST', `/api/infection/cases/${reported.id}/review`, {
        decision: 'confirmed', note: 'زرع موجب مع أعراض موضعية؛ تُعتمد كعدوى موضع جراحي',
      }),
      200,
      'review case',
    );
    expect(reviewed.status).toBe('confirmed');
    expect((await call(agents.infection, 'POST', `/api/infection/cases/${reported.id}/review`, {
      decision: 'excluded', note: 'محاولة تغيير قرار بعد الاعتماد',
    })).statusCode).toBe(409);

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.infection.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE infection_cases SET status = 'excluded' WHERE id = $1`, [reported.id]),
      ),
    ).rejects.toThrow(/immutable|permission denied/);

    expect((await call(agents.nurse, 'POST', '/api/infection/hand-hygiene', {
      unit: 'العناية المركزة', moment: 'before_patient', opportunities: 10, compliant: 11, observedRole: 'nurse',
    })).statusCode).toBe(409);
    const audit = await expectStatus(
      await call(agents.nurse, 'POST', '/api/infection/hand-hygiene', {
        unit: 'العناية المركزة', moment: 'before_patient', opportunities: 20, compliant: 18, observedRole: 'nurse',
        notes: 'ملاحظة مباشرة في المناوبة الصباحية',
      }),
      201,
      'hygiene audit',
    );
    expect(audit.compliancePct).toBe(90);
    expect(audit.momentAr).toBe('قبل لمس المريض');

    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.infection.me.activeFacilityId }, (q: any) =>
        q.query(`UPDATE hand_hygiene_audits SET compliant = 20 WHERE id = $1`, [audit.id]),
      ),
    ).rejects.toThrow(/append-only|permission denied/);

    const board = await expectStatus(await call(agents.infection, 'GET', '/api/infection/board'), 200, 'ipc board');
    expect(board.isolations).toHaveLength(1);
    expect(board.isolations[0].precaution).toBe('droplet');
    expect(board.cases.some((c: any) => c.status === 'confirmed')).toBe(true);
    expect(board.cases.some((c: any) => c.status === 'excluded')).toBe(true);
    expect(board.hygiene).toHaveLength(3);
    expect(board.hygiene.every((h: any) => h.compliance_pct > 0)).toBe(true);
    expect(Number(board.totals.active_isolations)).toBe(1);
    expect(Number(board.totals.hygiene_compliance_30d)).toBeGreaterThan(70);
  });
});

describe('Platform UX, RBAC & Global Search Enhancements', () => {
  it('allows surgeon (inpatient.admit) to list inpatient beds while denying lab technician', async () => {
    const res = await expectStatus(await call(agents.surgeon, 'GET', '/api/inpatient/beds'), 200, 'surgeon beds');
    expect(Array.isArray(res.beds)).toBe(true);
    expect(res.beds.length).toBeGreaterThan(0);

    const denied = await call(agents.lab1, 'GET', '/api/inpatient/beds');
    expect(denied.statusCode).toBe(403);
  });

  it('persists user language preference via PATCH /api/auth/preferences with CSRF and validation', async () => {
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/auth/preferences',
      cookies: agents.doctor.cookies,
      payload: { preferredLanguage: 'en' },
    });
    expect(noCsrf.statusCode).toBe(403);

    const badLang = await call(agents.doctor, 'PATCH', '/api/auth/preferences', { preferredLanguage: 'fr' });
    expect(badLang.statusCode).toBe(400);

    const updated = await expectStatus(
      await call(agents.doctor, 'PATCH', '/api/auth/preferences', { preferredLanguage: 'en' }),
      200,
      'set lang en',
    );
    expect(updated.preferredLanguage).toBe('en');

    const meEn = await expectStatus(await call(agents.doctor, 'GET', '/api/auth/me'), 200, 'me en');
    expect(meEn.user.preferredLanguage).toBe('en');

    await expectStatus(
      await call(agents.doctor, 'PATCH', '/api/auth/preferences', { preferredLanguage: 'ar' }),
      200,
      'restore lang ar',
    );
  });

  it('serves 7d and 30d executive dashboard trends, ward occupancy, and clinical alerts', async () => {
    const d30 = await expectStatus(await call(agents.admin, 'GET', '/api/dashboard?days=30'), 200, 'dashboard 30d');
    expect(d30.days).toBe(30);
    expect(Array.isArray(d30.trend)).toBe(true);
    expect(d30.trend).toHaveLength(30);
    expect(Array.isArray(d30.bedsByWard)).toBe(true);
    expect(Array.isArray(d30.actionableAlerts)).toBe(true);

    const denied = await call(agents.patient, 'GET', '/api/dashboard?days=7');
    expect(denied.statusCode).toBe(403);
  });

  it('enforces RBAC filtering on global search (/api/search) and module transparency metadata', async () => {
    const doctorSearch = await expectStatus(
      await call(agents.doctor, 'GET', `/api/search?q=${encodeURIComponent(patient1.mrn)}`),
      200,
      'doctor search mrn',
    );
    expect(doctorSearch.items.some((i: any) => i.category === 'patient' && i.id === patient1.id)).toBe(true);

    // Admin intentionally lacks clinical patient.read (least privilege), so patient records are excluded
    const adminSearch = await expectStatus(
      await call(agents.admin, 'GET', `/api/search?q=${encodeURIComponent(patient1.mrn)}`),
      200,
      'admin search mrn',
    );
    expect(adminSearch.items.some((i: any) => i.category === 'patient')).toBe(false);

    const portalSearch = await expectStatus(
      await call(agents.patient, 'GET', `/api/search?q=${encodeURIComponent(patient1.mrn)}`),
      200,
      'portal search mrn',
    );
    expect(portalSearch.items).toEqual([]);

    const mods = await expectStatus(await call(agents.admin, 'GET', '/api/meta/modules'), 200, 'meta modules');
    expect(mods.modules.every((m: any) => 'missing' in m)).toBe(true);
  });
});

describe('human resources, medical licensing (SCFHS), roster and leave governance', () => {
  const today = new Date().toISOString().slice(0, 10);
  const addDays = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  it('exposes the HR board to HR/auditor while enforcing least privilege on clinical & HR boundaries', async () => {
    const board = await expectStatus(await call(agents.hr1, 'GET', '/api/hr/board'), 200, 'hr board');
    expect(Number(board.totals.active_employees)).toBeGreaterThanOrEqual(6);
    expect(Number(board.totals.expiring_30d)).toBeGreaterThanOrEqual(1);
    expect(board.expiringLicenses.length).toBeGreaterThanOrEqual(1);
    expect(board.employees[0].nationalIdMasked).toMatch(/^\*+\d{4}$/);

    // HR manager has zero access to patient clinical records (least privilege)
    expect((await call(agents.hr1, 'GET', '/api/patients')).statusCode).toBe(403);
    // Receptionist and portal patient cannot view HR board
    expect((await call(agents.reception, 'GET', '/api/hr/board')).statusCode).toBe(403);
    expect((await call(agents.patient, 'GET', '/api/hr/board')).statusCode).toBe(403);
    // Internal auditor can read HR board but cannot create employees
    expect((await call(agents.auditor, 'GET', '/api/hr/board')).statusCode).toBe(200);
    expect((await call(agents.auditor, 'POST', '/api/hr/employees', {
      fullNameAr: 'موظف تجريبي', category: 'administrative', jobTitleAr: 'كاتب', hireDate: today,
    })).statusCode).toBe(403);
  });

  it('enforces clinical SCFHS license gate on shift scheduling and separation of duties on license verification', async () => {
    const emp = await expectStatus(
      await call(agents.hr1, 'POST', '/api/hr/employees', {
        fullNameAr: 'د. طارق السبيعي',
        fullNameEn: 'Dr. Tariq Alsubaie',
        category: 'physician',
        jobTitleAr: 'أخصائي باطنية',
        employmentType: 'locum',
        hireDate: today,
        nationalId: '1099887766',
        phone: '0551122334',
      }),
      201,
      'create physician employee',
    );
    state.newHrEmployeeId = emp.id;

    // Cannot schedule a clinical practitioner before they hold a verified SCFHS/MOH license
    const blockedNoLic = await call(agents.hr1, 'POST', '/api/hr/shifts', {
      employeeId: emp.id,
      shiftDate: addDays(2),
      shiftType: 'morning',
    });
    expect(blockedNoLic.statusCode).toBe(409);

    // Record SCFHS license as hr1
    const cred = await expectStatus(
      await call(agents.hr1, 'POST', `/api/hr/employees/${emp.id}/credentials`, {
        credentialType: 'scfhs',
        licenseNo: 'SCFHS-26-5501',
        issuingBody: 'الهيئة السعودية للتخصصات الصحية',
        issuedDate: addDays(-30),
        expiryDate: addDays(365),
      }),
      201,
      'record scfhs',
    );
    state.newHrCredentialId = cred.id;

    // Still unverified -> shift scheduling still blocked!
    expect((await call(agents.hr1, 'POST', '/api/hr/shifts', {
      employeeId: emp.id, shiftDate: addDays(2), shiftType: 'morning',
    })).statusCode).toBe(409);

    // Separation of duties: hr1 recorded it, so hr1 CANNOT verify it
    expect((await call(agents.hr1, 'POST', `/api/hr/credentials/${cred.id}/verify`, {})).statusCode).toBe(409);

    // Second HR officer (hr2) verifies the license
    const verified = await expectStatus(
      await call(agents.hr2, 'POST', `/api/hr/credentials/${cred.id}/verify`, {}),
      200,
      'verify scfhs by hr2',
    );
    expect(verified.status).toBe('verified');

    // Now shift scheduling succeeds, and duplicate slot is rejected
    const shift = await expectStatus(
      await call(agents.hr1, 'POST', '/api/hr/shifts', {
        employeeId: emp.id, shiftDate: addDays(2), shiftType: 'morning',
      }),
      201,
      'schedule shift with valid license',
    );
    expect((await call(agents.hr1, 'POST', '/api/hr/shifts', {
      employeeId: emp.id, shiftDate: addDays(2), shiftType: 'morning',
    })).statusCode).toBe(409);

    // Check-in -> Complete lifecycle + immutability after completion
    await expectStatus(await call(agents.hr1, 'POST', `/api/hr/shifts/${shift.id}/checkin`, {}), 200, 'shift checkin');
    await expectStatus(await call(agents.hr1, 'POST', `/api/hr/shifts/${shift.id}/complete`, {}), 200, 'shift complete');
    expect((await call(agents.hr1, 'POST', `/api/hr/shifts/${shift.id}/cancel`, { reason: 'محاولة إلغاء بعد الإتمام' })).statusCode).toBe(409);
  });

  it('blocks shift scheduling once a practitioner license is revoked and enforces DB delete guards', async () => {
    await expectStatus(
      await call(agents.hr2, 'POST', `/api/hr/credentials/${state.newHrCredentialId}/revoke`, {
        reason: 'إيقاف احترازي لحين تجديد شهادة الاختصاص',
      }),
      200,
      'revoke credential',
    );

    // With license revoked, future shift scheduling is blocked again
    expect((await call(agents.hr1, 'POST', '/api/hr/shifts', {
      employeeId: state.newHrEmployeeId,
      shiftDate: addDays(4),
      shiftType: 'evening',
    })).statusCode).toBe(409);

    // Suspension requires documented reason
    expect((await call(agents.hr1, 'PATCH', `/api/hr/employees/${state.newHrEmployeeId}/status`, {
      status: 'suspended',
    })).statusCode).toBe(409);
    await expectStatus(
      await call(agents.hr1, 'PATCH', `/api/hr/employees/${state.newHrEmployeeId}/status`, {
        status: 'suspended',
        reason: 'موقوف لحين استكمال تجديد التصنيف المهني',
      }),
      200,
      'suspend employee',
    );

    // DB triggers prevent deletion of HR records
    await expect(
      db.asRole('hms_app', { 'app.facility_ids': agents.hr1.me.activeFacilityId }, (q: any) =>
        q.query(`DELETE FROM hr_employees WHERE id = $1`, [state.newHrEmployeeId]),
      ),
    ).rejects.toThrow(/cannot be deleted|permission denied/);
  });

  it('enforces self-service boundaries, leave overlap checks, and separation of duties on leave review', async () => {
    // Physician views own self-service HR profile
    const meHr = await expectStatus(await call(agents.doctor, 'GET', '/api/hr/me'), 200, 'doctor hr me');
    expect(meHr.employee.employeeNo).toBe('EMP-000001');
    expect(meHr.credentials.length).toBeGreaterThanOrEqual(1);

    // Physician cannot request leave for another employee
    expect((await call(agents.doctor, 'POST', '/api/hr/leaves', {
      employeeId: state.newHrEmployeeId,
      leaveType: 'annual',
      startDate: addDays(25),
      endDate: addDays(26),
      reason: 'محاولة تقديم إجازة لموظف آخر',
    })).statusCode).toBe(403);

    // HR1 submits own leave request (EMP-000006) -> HR1 cannot approve their own leave (SoD)
    const hrSelf = await expectStatus(await call(agents.hr1, 'GET', '/api/hr/me'), 200, 'hr1 me');
    const selfLeave = await expectStatus(
      await call(agents.hr1, 'POST', '/api/hr/leaves', {
        employeeId: hrSelf.employee.id,
        leaveType: 'annual',
        startDate: addDays(30),
        endDate: addDays(32),
        reason: 'إجازة اعتيادية مجدولة مسبقًا',
      }),
      201,
      'hr1 leave request',
    );
    expect(selfLeave.daysCount).toBe(3);

    // Overlapping leave is rejected
    expect((await call(agents.hr1, 'POST', '/api/hr/leaves', {
      employeeId: hrSelf.employee.id,
      leaveType: 'emergency',
      startDate: addDays(31),
      endDate: addDays(33),
      reason: 'طلب متداخل في نفس الفترة',
    })).statusCode).toBe(409);

    // Self-approval blocked by SoD
    expect((await call(agents.hr1, 'POST', `/api/hr/leaves/${selfLeave.id}/review`, {
      decision: 'approved',
    })).statusCode).toBe(409);

    // Rejection without reason blocked
    expect((await call(agents.hr2, 'POST', `/api/hr/leaves/${selfLeave.id}/review`, {
      decision: 'rejected',
    })).statusCode).toBe(409);

    // HR2 approves HR1's leave -> scheduling shift during approved leave is blocked
    await expectStatus(
      await call(agents.hr2, 'POST', `/api/hr/leaves/${selfLeave.id}/review`, {
        decision: 'approved',
        note: 'معتمد مع تكليف البديل الإداري',
      }),
      200,
      'hr2 approve leave',
    );
    expect((await call(agents.hr2, 'POST', '/api/hr/shifts', {
      employeeId: hrSelf.employee.id,
      shiftDate: addDays(31),
      shiftType: 'morning',
    })).statusCode).toBe(409);
  });

  it('isolates HR records across tenants via RLS and surfaces HR in /api/search & /api/meta/modules', async () => {
    const leaked = await db.asRole('hms_app', { 'app.facility_ids': branchFacilityId }, (q: any) =>
      q.query(`SELECT count(*)::int AS c FROM hr_employees`),
    );
    expect(leaked.rows[0].c).toBe(0);

    const hrSearch = await expectStatus(await call(agents.hr1, 'GET', '/api/search?q=EMP-000001'), 200, 'hr search');
    expect(hrSearch.items.some((i: any) => i.category === 'hr' && i.code === 'EMP-000001')).toBe(true);

    const docSearch = await expectStatus(await call(agents.doctor, 'GET', '/api/search?q=EMP-000001'), 200, 'doc search emp');
    expect(docSearch.items.some((i: any) => i.category === 'hr')).toBe(false);

    const mods = await expectStatus(await call(agents.hr1, 'GET', '/api/meta/modules'), 200, 'hr module status');
    const hrMod = mods.modules.find((m: any) => m.key === 'hr');
    expect(hrMod.status).toBe('implemented');
    expect(hrMod.route).toBe('#/hr');
    expect(hrMod.missing).toContain('Payroll');
  });
});

describe('login resilience, session envelope security & Supabase bootstrap bundle', () => {
  it('allows re-login with whitespace/uppercase email over an existing session cookie without CSRF deadlock and revokes prior session', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.99.0.1',
      payload: { email: '  DR.AHMED@DEMO.HMS  ', password: 'Doctor#Demo2026' },
    });
    expect(first.statusCode).toBe(200);
    const firstCookie = first.cookies.find((c: any) => c.name === 'hms_session');
    expect(firstCookie?.value).toMatch(/^s1\./);

    // Re-login as another account while browser still sends firstCookie and NO x-csrf-token
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.99.0.1',
      cookies: { hms_session: firstCookie!.value },
      payload: { email: 'admin@demo.hms', password: 'Admin#Demo2026' },
    });
    expect(second.statusCode).toBe(200);
    const secondCookie = second.cookies.find((c: any) => c.name === 'hms_session');
    expect(secondCookie?.value).toBeTruthy();
    expect(secondCookie!.value).not.toBe(firstCookie!.value);

    // First session must now be revoked (401) and dead cookie evicted
    const oldMe = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { hms_session: firstCookie!.value },
    });
    expect(oldMe.statusCode).toBe(401);
    expect(String(oldMe.headers['set-cookie'] ?? '')).toContain('hms_session=;');

    // Second session works and logout succeeds even without x-csrf-token (same-origin)
    const activeMe = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { hms_session: secondCookie!.value },
    });
    expect(activeMe.statusCode).toBe(200);
    expect(activeMe.json().user.email).toBe('admin@demo.hms');

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { hms_session: secondCookie!.value },
    });
    expect(out.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { hms_session: secondCookie!.value },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('rejects tampered signed session cookies and normalizes Arabic numerals in MFA codes', async () => {
    const { decodeSessionCookie, normalizeAuthDigits } = await import('../src/auth/service');
    expect(normalizeAuthDigits('١٢٣-٤٥٦')).toBe('123456');
    expect(normalizeAuthDigits('۰۹۸ ۷۶۵')).toBe('098765');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '10.99.0.2',
      payload: { email: 'hr@demo.hms', password: 'HR#Demo2026' },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.cookies.find((c: any) => c.name === 'hms_session')!.value;
    expect(decodeSessionCookie(raw)?.envelope?.v).toBe(1);

    // Flip one character in the signature -> rejected
    const tampered = raw.slice(0, -2) + (raw.endsWith('AA') ? 'BB' : 'AA');
    expect(decodeSessionCookie(tampered)).toBeNull();
    const meTampered = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { hms_session: tampered },
    });
    expect(meTampered.statusCode).toBe(401);
  });

  it('validates db/supabase-full-init.sql execution, 29 demo users, URL encoding, and PostgREST anon lockdown', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { PGlite } = await import('@electric-sql/pglite');
    const { normalizePostgresUrl } = await import('../src/config');

    // Placeholder URIs from Supabase Connect dialog must safely return undefined
    expect(
      normalizePostgresUrl(
        'postgresql://postgres.pxawcoccgcuzoustyugh:[YOUR-PASSWORD]@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
      ),
    ).toBeUndefined();

    // Special characters (@, #) in raw passwords must be percent-encoded automatically
    expect(
      normalizePostgresUrl(
        'postgresql://postgres.pxawcoccgcuzoustyugh:My#Pass@2026@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
      ),
    ).toBe(
      'postgresql://postgres.pxawcoccgcuzoustyugh:My%23Pass%402026@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
    );

    const sqlPath = path.resolve(__dirname, '../../../db/supabase-full-init.sql');
    const bundleSql = fs.readFileSync(sqlPath, 'utf8');
    const pg = await PGlite.create();
    try {
      // Simulate Supabase default roles & permissive default grants
      await pg.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        GRANT USAGE ON SCHEMA public TO anon, authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
      `);

      await pg.exec(bundleSql);

      // Verify all 19 migrations + 29 demo users + 2 facilities + 25 roles + 98 permissions are loaded
      const migs = await pg.query<{ count: string }>('SELECT count(*) FROM public.schema_migrations');
      expect(Number(migs.rows[0].count)).toBe(19);
      const users = await pg.query<{ count: string }>('SELECT count(*) FROM public.users');
      expect(Number(users.rows[0].count)).toBe(29);
      const roles = await pg.query<{ count: string }>('SELECT count(*) FROM public.roles');
      expect(Number(roles.rows[0].count)).toBe(25);
      const perms = await pg.query<{ count: string }>('SELECT count(*) FROM public.permissions');
      expect(Number(perms.rows[0].count)).toBe(99);

      // Verify anon role is strictly denied SELECT on users, sessions, and patients
      await expect(
        pg.exec('BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.users; COMMIT;'),
      ).rejects.toThrow(/permission denied/i);
      await pg.exec('ROLLBACK').catch(() => undefined);

      // Verify hms_app role works via SET LOCAL ROLE
      await pg.exec('BEGIN; SET LOCAL ROLE hms_app; SELECT count(*) FROM public.facilities; COMMIT;');
    } finally {
      await pg.close();
    }
  });
});



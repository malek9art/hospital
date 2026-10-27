import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';

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
  agents.lab1 = await login('lab@demo.hms', 'Lab#Demo2026', 'lab1');
  agents.lab2 = await login('lab2@demo.hms', 'Lab#Demo2026', 'lab2');
  agents.pharmacist = await login('pharmacist@demo.hms', 'Pharma#Demo2026', 'pharmacist');
  agents.accountant = await login('accountant@demo.hms', 'Account#Demo2026', 'accountant');
  agents.auditor = await login('auditor@demo.hms', 'Auditor#Demo2026', 'auditor');
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

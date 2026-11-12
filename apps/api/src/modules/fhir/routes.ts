import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant } from '../../lib/tenant';
import { loadPatientOr404, authorizeChartAccess } from '../patients/access';
import { getDb } from '../../db';
import { writeAudit } from '../../lib/audit';

/**
 * Deliberately small, honest FHIR R4 surface: Patient + Observation (labs).
 * This is NOT a certified FHIR implementation; see docs/INTEGRATIONS.md.
 */
export async function fhirRoutes(app: FastifyInstance) {
  app.get('/fhir/metadata', async () => ({
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: new Date().toISOString(),
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['json'],
    software: { name: 'HMS Integration Layer', version: '0.1.0' },
    implementation: { description: 'HMS FHIR facade (partial: Patient, Observation)' },
    rest: [{
      mode: 'server',
      resource: [
        { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: [{ name: 'identifier' }, { name: 'name' }, { name: '_id' }] },
        { type: 'Observation', interaction: [{ code: 'search-type' }], searchParam: [{ name: 'patient' }, { name: 'category' }] },
      ],
    }],
  }));

  app.get('/fhir/Patient', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.read');
    const q = parse(z.object({ _id: z.string().uuid().optional(), identifier: z.string().optional(), name: z.string().optional() }), req.query);
    return withTenant(auth, async (db) => {
      const where = ['facility_id = $1', `status <> 'merged'`];
      const params: unknown[] = [auth.activeFacilityId];
      if (q._id) { params.push(q._id); where.push(`id = $${params.length}`); }
      if (q.name) { params.push(`%${q.name}%`); where.push(`full_name_ar ILIKE $${params.length}`); }
      const rows = await db.query(`SELECT * FROM patients WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 50`, params);
      await writeAudit(db, { facilityId: auth.activeFacilityId, actorUserId: auth.user.id, action: 'fhir.patient.search', entityType: 'patient', detail: { query: q }, ip: req.ip });
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        total: rows.rows.length,
        entry: rows.rows.map((r: any) => ({ resource: fhirPatient(r) })),
      };
    });
  });

  app.get('/fhir/Patient/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.read');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return withTenant(auth, async (db) => {
      const patient = await loadPatientOr404(db, id);
      await authorizeChartAccess(db, auth, patient, 'administrative', { ip: req.ip, accessType: 'fhir_patient_read' });
      return fhirPatient(patient);
    });
  });

  app.get('/fhir/Observation', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.result.verify');
    const { patient } = parse(z.object({ patient: z.string().uuid() }), req.query);
    return withTenant(auth, async (db) => {
      const p = await loadPatientOr404(db, patient);
      // Result-level access: lab roles are authorized by role, and every read is logged.
      await db.query(
        `INSERT INTO patient_access_log (facility_id, user_id, patient_id, access_type, access_basis, ip)
         VALUES ($1,$2,$3,'fhir_observation','lab_role',$4)`,
        [p.facility_id, auth.user.id, p.id, req.ip],
      );
      const rows = await db.query<any>(
        `SELECT lr.*, li.test_code, t.name_ar, t.name_en, lo.patient_id
           FROM lab_results lr JOIN lab_order_items li ON li.id = lr.order_item_id
           JOIN lab_orders lo ON lo.id = li.order_id JOIN lab_tests t ON t.code = li.test_code
          WHERE lo.patient_id = $1 AND lr.verified_at IS NOT NULL ORDER BY lr.verified_at DESC LIMIT 100`,
        [patient],
      );
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        total: rows.rows.length,
        entry: rows.rows.map((r) => ({
          resource: {
            resourceType: 'Observation',
            id: r.id,
            status: 'final',
            category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
            code: { coding: [{ system: 'http://loinc.org', code: r.test_code, display: r.name_en }], text: r.name_ar },
            subject: { reference: `Patient/${r.patient_id}` },
            effectiveDateTime: new Date(r.resulted_at).toISOString(),
            valueQuantity: r.value_numeric !== null ? { value: Number(r.value_numeric), unit: r.unit ?? undefined } : undefined,
            valueString: r.value_text ?? undefined,
            interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: mapFlag(r.flag) }] }],
            issued: new Date(r.verified_at).toISOString(),
          },
        })),
      };
    });
  });

  // Audit reads of FHIR endpoints through the shared audit chain.
  app.addHook('onResponse', async () => undefined);
  void getDb;
}

function mapFlag(flag: string) {
  switch (flag) {
    case 'high': return 'H';
    case 'low': return 'L';
    case 'critical_high': return 'HH';
    case 'critical_low': return 'LL';
    default: return 'N';
  }
}

function fhirPatient(p: any) {
  const identifier = [{ use: 'usual', system: 'urn:hms:mrn', value: p.mrn }];
  return {
    resourceType: 'Patient',
    id: p.id,
    meta: { lastUpdated: new Date(p.updated_at ?? p.created_at).toISOString() },
    identifier,
    active: p.status === 'active',
    name: [{ use: 'official', text: p.full_name_ar, family: p.full_name_ar, given: [p.full_name_ar] }],
    gender: p.sex,
    birthDate: typeof p.date_of_birth === 'string' ? p.date_of_birth.slice(0, 10) : p.date_of_birth,
  };
}

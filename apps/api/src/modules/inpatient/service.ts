import type { Queryable } from '../../db';
import { nextDocumentNo } from '../../lib/tenant';
import { conflict, notFound } from '../../lib/errors';
import { ensureCharge } from '../billing/service';

export interface AdmitInput {
  facilityId: string;
  patientId: string;
  userId: string;
  bedId?: string | null;
  wardId?: string | null;
  departmentId?: string | null;
  attendingDoctorId?: string | null;
  reason: string;
  /** Optional pre-existing encounter (e.g. the ER visit being converted). */
  reuseEncounterId?: string | null;
}

export interface AdmitResult {
  admissionId: string;
  admissionNo: string;
  encounterId: string;
  bedId: string | null;
}

/**
 * Creates an admission atomically: encounter (or reuses the ER encounter),
 * bed allocation, assessment charge and the admission record.
 * Callers must already have enforced clinical authorization on the patient.
 */
export async function createAdmission(q: Queryable, input: AdmitInput): Promise<AdmitResult> {
  const active = await q.query<{ id: string }>(
    `SELECT id FROM admissions WHERE patient_id = $1 AND status = 'active'`,
    [input.patientId],
  );
  if (active.rows[0]) throw conflict('المريض منوّم بالفعل', { admissionId: active.rows[0].id });

  let bedId: string | null = input.bedId ?? null;
  if (bedId) {
    const bed = await q.query<{ status: string }>('SELECT status FROM beds WHERE id = $1', [bedId]);
    if (!bed.rows[0]) throw notFound('السرير غير موجود');
    if (bed.rows[0].status !== 'available') throw conflict(`السرير غير متاح حاليًا (${bed.rows[0].status})`);
  } else if (input.wardId) {
    const free = await q.query<{ id: string }>(
      `SELECT id FROM beds WHERE ward_id = $1 AND status = 'available' ORDER BY bed_no LIMIT 1 FOR UPDATE`,
      [input.wardId],
    );
    if (!free.rows[0]) throw conflict('لا يوجد سرير متاح في الجناح المحدد');
    bedId = free.rows[0].id;
  }

  let departmentId = input.departmentId ?? null;
  if (!departmentId) {
    const dept = await q.query<{ id: string }>(
      `SELECT id FROM departments WHERE facility_id = $1 AND is_active = true
        ORDER BY (dept_type = 'inpatient') DESC, name_ar LIMIT 1`,
      [input.facilityId],
    );
    departmentId = dept.rows[0]?.id ?? null;
  }
  if (!departmentId) throw conflict('لا يوجد قسم متاح لتسجيل التنويم');

  let encounterId = input.reuseEncounterId ?? null;
  if (encounterId) {
    const enc = await q.query<{ id: string }>(`SELECT id FROM encounters WHERE id = $1 AND status = 'open'`, [encounterId]);
    if (!enc.rows[0]) throw conflict('لا يمكن تحويل زيارة مغلقة إلى تنويم');
    await q.query(`UPDATE encounters SET encounter_type = 'inpatient', department_id = $1 WHERE id = $2`, [departmentId, encounterId]);
  } else {
    encounterId = crypto.randomUUID();
    const encounterNo = await nextDocumentNo(q, input.facilityId, 'encounter', 'ENC');
    await q.query(
      `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, encounter_type, department_id, doctor_id,
         status, chief_complaint, created_by)
       VALUES ($1,$2,$3,$4,'inpatient',$5,$6,'open',$7,$8)`,
      [encounterId, input.facilityId, encounterNo, input.patientId, departmentId,
        input.attendingDoctorId ?? input.userId, input.reason, input.userId],
    );
    await ensureCharge(q, {
      facilityId: input.facilityId,
      patientId: input.patientId,
      encounterId,
      category: 'consultation',
      description: 'تقييم تنويم',
      referenceType: 'encounter_consultation',
      referenceId: encounterId,
      quantity: 1,
      unitPrice: await priceFor(q, input.facilityId, 'pricing.consultation', 150),
      createdBy: input.userId,
    });
  }

  const admissionId = crypto.randomUUID();
  const admissionNo = await nextDocumentNo(q, input.facilityId, 'admission', 'ADM');
  await q.query(
    `INSERT INTO admissions (id, facility_id, admission_no, patient_id, encounter_id, bed_id,
       attending_doctor_id, admitted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [admissionId, input.facilityId, admissionNo, input.patientId, encounterId, bedId,
      input.attendingDoctorId ?? input.userId, input.userId],
  );
  if (bedId) await q.query(`UPDATE beds SET status = 'occupied' WHERE id = $1`, [bedId]);

  return { admissionId, admissionNo, encounterId, bedId };
}

export async function priceFor(q: Queryable, facilityId: string, key: string, fallback: number): Promise<number> {
  const row = await q.query<{ value: { amount: number } }>(
    `SELECT value FROM app_settings WHERE facility_id = $1 AND key = $2`,
    [facilityId, key],
  );
  return Number(row.rows[0]?.value?.amount ?? fallback);
}

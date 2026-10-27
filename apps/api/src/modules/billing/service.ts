import type { Queryable } from '../../db';
import { nextDocumentNo } from '../../lib/tenant';

export interface ChargeInput {
  facilityId: string;
  patientId: string;
  encounterId: string | null;
  category: 'consultation' | 'lab' | 'radiology' | 'pharmacy' | 'bed' | 'procedure' | 'other';
  description: string;
  referenceType: string;
  referenceId: string;
  quantity: number;
  unitPrice: number;
  createdBy: string;
}

/**
 * Adds a charge to the encounter's open invoice, creating the invoice when
 * needed. The unique index on (reference_type, reference_id) makes retries safe:
 * a duplicate charge is rejected instead of billing the patient twice.
 */
export async function ensureCharge(q: Queryable, input: ChargeInput): Promise<{ invoiceId: string; itemId: string }> {
  const existingItem = await q.query<{ invoice_id: string }>(
    'SELECT invoice_id FROM invoice_items WHERE reference_type = $1 AND reference_id = $2',
    [input.referenceType, input.referenceId],
  );
  if (existingItem.rows[0]) {
    return { invoiceId: existingItem.rows[0].invoice_id, itemId: '' };
  }

  let invoice = input.encounterId
    ? (
        await q.query<{ id: string }>(
          `SELECT id FROM invoices WHERE encounter_id = $1 AND status IN ('open','partially_paid') ORDER BY created_at DESC LIMIT 1`,
          [input.encounterId],
        )
      ).rows[0]
    : undefined;

  if (!invoice) {
    const invoiceId = crypto.randomUUID();
    const invoiceNo = await nextDocumentNo(q, input.facilityId, 'invoice', 'INV');
    await q.query(
      `INSERT INTO invoices (id, facility_id, invoice_no, patient_id, encounter_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'open',$6)`,
      [invoiceId, input.facilityId, invoiceNo, input.patientId, input.encounterId, input.createdBy],
    );
    invoice = { id: invoiceId };
  }

  const itemId = crypto.randomUUID();
  const lineTotal = Math.round(input.quantity * input.unitPrice * 100) / 100;
  await q.query(
    `INSERT INTO invoice_items (id, facility_id, invoice_id, category, description, reference_type,
       reference_id, quantity, unit_price, line_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [itemId, input.facilityId, invoice.id, input.category, input.description, input.referenceType, input.referenceId, input.quantity, input.unitPrice, lineTotal],
  );
  await recalculateInvoice(q, invoice.id);
  return { invoiceId: invoice.id, itemId };
}

export async function recalculateInvoice(q: Queryable, invoiceId: string) {
  const items = await q.query<{ total: string }>(
    'SELECT COALESCE(sum(line_total), 0) AS total FROM invoice_items WHERE invoice_id = $1',
    [invoiceId],
  );
  const subtotal = Number(items.rows[0]?.total ?? 0);
  const inv = await q.query<{ discount: string; tax: string; paid_amount: string; status: string; encounter_id: string | null }>(
    'SELECT discount, tax, paid_amount, status, encounter_id FROM invoices WHERE id = $1',
    [invoiceId],
  );
  const row = inv.rows[0];
  if (!row) return;
  const total = Math.max(0, subtotal - Number(row.discount) + Number(row.tax));
  const paid = Number(row.paid_amount);
  let status = row.status;
  if (!['void', 'draft'].includes(status)) {
    status = paid <= 0 ? 'open' : paid + 0.001 >= total ? 'paid' : 'partially_paid';
  }
  await q.query('UPDATE invoices SET subtotal = $1, total = $2, status = $3 WHERE id = $4', [subtotal, total, status, invoiceId]);
}

/** Applies a payment and refreshes the invoice balance inside the same transaction. */
export async function applyPayment(
  q: Queryable,
  invoiceId: string,
  amount: number,
  method: string,
  reference: string | null,
  userId: string,
) {
  const inv = await q.query<{ total: string; paid_amount: string; status: string; facility_id: string }>(
    'SELECT total, paid_amount, status, facility_id FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId],
  );
  const invoice = inv.rows[0];
  if (!invoice) throw new Error('INVOICE_NOT_FOUND');
  if (invoice.status === 'void') throw new Error('INVOICE_VOID');
  const paid = Number(invoice.paid_amount);
  const total = Number(invoice.total);
  if (paid + amount > total + 0.001) throw new Error('OVERPAYMENT');

  const paymentId = crypto.randomUUID();
  await q.query(
    `INSERT INTO payments (id, facility_id, invoice_id, amount, method, reference, received_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [paymentId, invoice.facility_id, invoiceId, amount, method, reference, userId],
  );
  const newPaid = Math.round((paid + amount) * 100) / 100;
  const status = newPaid + 0.001 >= total ? 'paid' : 'partially_paid';
  await q.query('UPDATE invoices SET paid_amount = $1, status = $2 WHERE id = $3', [newPaid, status, invoiceId]);
  return { paymentId, paidAmount: newPaid, total, status };
}

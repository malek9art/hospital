-- ============================================================================
-- 003_security_rls.sql | Row-Level Security, least-privilege grants, immutability
-- The API always runs business queries inside a transaction after SET ROLE
-- hms_app (or hms_portal) and setting app.facility_ids / app.patient_id, so RLS
-- is enforced by the database even if an application filter is forgotten.
-- ============================================================================

-- ---------------------------------------------------------------- Grants -----
GRANT USAGE ON SCHEMA public TO hms_app, hms_portal;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  facilities, departments, user_facilities, roles, permissions, role_permissions,
  user_roles, sessions, user_recovery_codes, idempotency_keys, number_sequences,
  app_settings, notifications_outbox, break_glass_grants, patient_access_log,
  patients, patient_allergies, patient_conditions, consents,
  appointments, encounters, vitals, clinical_notes, diagnoses,
  lab_tests, lab_orders, lab_order_items, lab_results, lab_result_amendments,
  critical_alerts, drugs, drug_batches, drug_interactions, prescriptions,
  prescription_items, dispenses, stock_movements, insurance_policies, invoices,
  invoice_items, payments, insurance_claims, wards, rooms, beds, admissions,
  bed_transfers, users
TO hms_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hms_app;

-- App may only append/read the audit trail.
GRANT SELECT, INSERT ON audit_log TO hms_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO hms_app;

-- Portal: read-only, patient-scoped.
GRANT SELECT ON
  patients, patient_allergies, patient_conditions, appointments, encounters,
  vitals, diagnoses, clinical_notes, lab_orders, lab_order_items, lab_results,
  prescriptions, prescription_items, invoices, invoice_items, payments,
  facilities, departments
TO hms_portal;

-- ------------------------------------------------------------- RLS setup -----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'departments','patients','patient_allergies','patient_conditions','consents',
    'appointments','encounters','vitals','clinical_notes','diagnoses',
    'lab_orders','lab_order_items','lab_results','lab_result_amendments','critical_alerts',
    'drug_batches','prescriptions','prescription_items','dispenses','stock_movements',
    'insurance_policies','invoices','invoice_items','payments','insurance_claims',
    'wards','rooms','beds','admissions','bed_transfers',
    'break_glass_grants','patient_access_log','notifications_outbox','app_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Tenant isolation for staff sessions: facility must be in the session's allowed set.
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL TO hms_app
        USING (
          facility_id::text = ANY (
            string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')
          )
        )
        WITH CHECK (
          facility_id::text = ANY (
            string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')
          )
        )
    $f$, t);
  END LOOP;
END $$;

-- ------------------------------------------------------- Patient portal RLS --
CREATE POLICY portal_self ON patients FOR SELECT TO hms_portal
  USING (id::text = nullif(current_setting('app.patient_id', true), ''));

CREATE POLICY portal_self ON patient_allergies FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON patient_conditions FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON appointments FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON encounters FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON vitals FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON diagnoses FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON lab_orders FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON lab_order_items FOR SELECT TO hms_portal
  USING (EXISTS (SELECT 1 FROM lab_orders o WHERE o.id = order_id AND o.patient_id::text = nullif(current_setting('app.patient_id', true), '')));
CREATE POLICY portal_self ON lab_results FOR SELECT TO hms_portal
  USING (verified_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM lab_order_items i JOIN lab_orders o ON o.id = i.order_id
    WHERE i.id = order_item_id AND o.patient_id::text = nullif(current_setting('app.patient_id', true), '')));
CREATE POLICY portal_self ON prescriptions FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON prescription_items FOR SELECT TO hms_portal
  USING (EXISTS (SELECT 1 FROM prescriptions p WHERE p.id = prescription_id AND p.patient_id::text = nullif(current_setting('app.patient_id', true), '')));
CREATE POLICY portal_self ON invoices FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), ''));
CREATE POLICY portal_self ON invoice_items FOR SELECT TO hms_portal
  USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND i.patient_id::text = nullif(current_setting('app.patient_id', true), '')));
CREATE POLICY portal_self ON payments FOR SELECT TO hms_portal
  USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id AND i.patient_id::text = nullif(current_setting('app.patient_id', true), '')));
CREATE POLICY portal_self ON clinical_notes FOR SELECT TO hms_portal
  USING (patient_id::text = nullif(current_setting('app.patient_id', true), '') AND signed_at IS NOT NULL);

-- ------------------------------------------------------------ Immutability ---
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER clinical_notes_immutable
  BEFORE UPDATE OR DELETE ON clinical_notes
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER lab_amendments_immutable
  BEFORE UPDATE OR DELETE ON lab_result_amendments
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Belt and braces: privileges revoked as well.
REVOKE UPDATE, DELETE ON audit_log FROM hms_app;
REVOKE UPDATE, DELETE ON clinical_notes FROM hms_app;
REVOKE UPDATE, DELETE ON lab_result_amendments FROM hms_app;
REVOKE UPDATE, DELETE ON stock_movements FROM hms_app;

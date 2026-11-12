-- Portal accounts are bound to exactly one patient record.
ALTER TABLE users ADD COLUMN patient_id uuid REFERENCES patients(id);
CREATE UNIQUE INDEX users_patient_uq ON users (patient_id) WHERE patient_id IS NOT NULL;
-- Tenant-level switch forcing MFA enrolment for this account.
ALTER TABLE users ADD COLUMN mfa_enforced boolean NOT NULL DEFAULT false;
GRANT SELECT, UPDATE ON users TO hms_app;

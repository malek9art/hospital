-- Human Resources, Medical Licensing (SCFHS/MOH), Duty Roster & Leave Management.
--
-- Safety & Governance invariants:
--  * Tenant-isolated via Row-Level Security (FORCE ROW LEVEL SECURITY) on facility_id.
--  * Separation of duties on medical license verification (verified_by <> recorded_by).
--  * Separation of duties on leave approval/rejection (reviewed_by <> requested_by).
--  * Terminated employees, revoked licenses, completed/cancelled shifts, and reviewed
--    leave requests are immutable; no HR record may be deleted (audit preservation).

CREATE TABLE hr_employees (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  user_id         uuid REFERENCES users(id),
  employee_no     text NOT NULL,
  full_name_ar    text NOT NULL,
  full_name_en    text,
  category        text NOT NULL CHECK (category IN ('physician','nursing','allied_health','administrative','support')),
  job_title_ar    text NOT NULL,
  department_id   uuid REFERENCES departments(id),
  employment_type text NOT NULL CHECK (employment_type IN ('full_time','part_time','locum','contractor')),
  hire_date       date NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_leave','suspended','terminated')),
  status_reason   text,
  national_id_enc text,
  phone_enc       text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, employee_no),
  UNIQUE (facility_id, user_id),
  CHECK (status NOT IN ('suspended','terminated') OR (status_reason IS NOT NULL AND length(status_reason) >= 5))
);
CREATE INDEX hr_employees_facility_status_idx ON hr_employees (facility_id, status, category);

CREATE TABLE hr_credentials (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  employee_id     uuid NOT NULL REFERENCES hr_employees(id),
  credential_type text NOT NULL CHECK (credential_type IN ('scfhs','bls','acls','moh_license','board','other')),
  license_no      text NOT NULL,
  issuing_body    text NOT NULL,
  issued_date     date NOT NULL,
  expiry_date     date NOT NULL CHECK (expiry_date > issued_date),
  status          text NOT NULL DEFAULT 'pending_verification'
                  CHECK (status IN ('pending_verification','verified','expired','revoked')),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  verified_by     uuid REFERENCES users(id),
  verified_at     timestamptz,
  revoke_reason   text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, credential_type, license_no),
  CHECK (verified_by IS NULL OR verified_by <> recorded_by),
  CHECK (status <> 'revoked' OR (revoke_reason IS NOT NULL AND length(revoke_reason) >= 5))
);
CREATE INDEX hr_credentials_expiry_idx ON hr_credentials (facility_id, status, expiry_date);
CREATE INDEX hr_credentials_employee_idx ON hr_credentials (employee_id, status);

CREATE TABLE hr_shifts (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  employee_id     uuid NOT NULL REFERENCES hr_employees(id),
  department_id   uuid REFERENCES departments(id),
  shift_date      date NOT NULL,
  shift_type      text NOT NULL CHECK (shift_type IN ('morning','evening','night','on_call')),
  status          text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','checked_in','completed','absent','cancelled')),
  checked_in_at   timestamptz,
  completed_at    timestamptz,
  cancel_reason   text,
  notes           text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND length(cancel_reason) >= 5))
);
CREATE UNIQUE INDEX hr_shifts_active_slot_idx ON hr_shifts (employee_id, shift_date, shift_type)
  WHERE status <> 'cancelled';
CREATE INDEX hr_shifts_board_idx ON hr_shifts (facility_id, shift_date DESC, status);

CREATE TABLE hr_leave_requests (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  request_no      text NOT NULL,
  employee_id     uuid NOT NULL REFERENCES hr_employees(id),
  leave_type      text NOT NULL CHECK (leave_type IN ('annual','sick','emergency','maternity','study','unpaid')),
  start_date      date NOT NULL,
  end_date        date NOT NULL CHECK (end_date >= start_date),
  days_count      integer NOT NULL CHECK (days_count BETWEEN 1 AND 180),
  reason          text NOT NULL CHECK (length(reason) >= 5),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by    uuid NOT NULL REFERENCES users(id),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, request_no),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),
  CHECK (status <> 'rejected' OR (review_note IS NOT NULL AND length(review_note) >= 5))
);
CREATE INDEX hr_leaves_board_idx ON hr_leave_requests (facility_id, status, start_date DESC);

-- --------------------------------------------------------- Integrity Guards --
CREATE OR REPLACE FUNCTION hr_employees_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employee records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'terminated' THEN
    RAISE EXCEPTION 'terminated employee records are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.employee_no <> OLD.employee_no OR NEW.facility_id <> OLD.facility_id THEN
    RAISE EXCEPTION 'employee identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hr_employees_guard
  BEFORE UPDATE OR DELETE ON hr_employees
  FOR EACH ROW EXECUTE FUNCTION hr_employees_guard_fn();

CREATE OR REPLACE FUNCTION hr_credentials_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'professional credentials cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'revoked credentials are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.employee_id <> OLD.employee_id OR NEW.credential_type <> OLD.credential_type
     OR NEW.license_no <> OLD.license_no OR NEW.recorded_by <> OLD.recorded_by THEN
    RAISE EXCEPTION 'credential identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.verified_by IS NOT NULL AND NEW.verified_by = OLD.recorded_by THEN
    RAISE EXCEPTION 'credential recorder cannot verify their own entry' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hr_credentials_guard
  BEFORE UPDATE OR DELETE ON hr_credentials
  FOR EACH ROW EXECUTE FUNCTION hr_credentials_guard_fn();

CREATE OR REPLACE FUNCTION hr_shifts_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shift records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'completed or cancelled shifts are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.employee_id <> OLD.employee_id OR NEW.shift_date <> OLD.shift_date OR NEW.shift_type <> OLD.shift_type THEN
    RAISE EXCEPTION 'shift slot identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hr_shifts_guard
  BEFORE UPDATE OR DELETE ON hr_shifts
  FOR EACH ROW EXECUTE FUNCTION hr_shifts_guard_fn();

CREATE OR REPLACE FUNCTION hr_leave_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'leave requests cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'decided leave requests are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.employee_id <> OLD.employee_id OR NEW.start_date <> OLD.start_date
     OR NEW.end_date <> OLD.end_date OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'leave request identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by = OLD.requested_by THEN
    RAISE EXCEPTION 'requester cannot review their own leave request' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hr_leave_requests_guard
  BEFORE UPDATE OR DELETE ON hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr_leave_guard_fn();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_employees','hr_credentials','hr_shifts','hr_leave_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL TO hms_app
        USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
        WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
    $f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON hr_employees TO hms_app;
GRANT SELECT, INSERT, UPDATE ON hr_credentials TO hms_app;
GRANT SELECT, INSERT, UPDATE ON hr_shifts TO hms_app;
GRANT SELECT, INSERT, UPDATE ON hr_leave_requests TO hms_app;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'hr_employee', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'hr_leave', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

-- ============================================================================
-- HMS Enterprise — Complete Supabase Schema & RLS Bootstrap
-- Target Supabase Project: https://pxawcoccgcuzoustyugh.supabase.co
-- Migrations included: 19 (001_core.sql .. 019_supabase_hardening.sql)
-- Generated deterministically with exact schema_migrations SHA-256 checksums.
--
-- HOW TO RUN IN SUPABASE SQL EDITOR:
--   1. Open https://supabase.com/dashboard/project/pxawcoccgcuzoustyugh/sql/new
--   2. Paste the contents of this file and click "Run".
--   3. Add DATABASE_URL (Session Pooler URI) to Vercel environment variables
--      so the API automatically seeds demo accounts using production keys.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_app') THEN
    CREATE ROLE hms_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hms_portal') THEN
    CREATE ROLE hms_portal NOLOGIN NOBYPASSRLS;
  END IF;
  BEGIN
    EXECUTE format('GRANT hms_app TO %I', current_user);
    EXECUTE format('GRANT hms_portal TO %I', current_user);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    BEGIN
      GRANT hms_app TO postgres;
      GRANT hms_portal TO postgres;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Migration: 001_core.sql (sha256: fd6eef3fb6583c66cfb4b1cc85f756752865ebb0048ff43d040a14cf609a84d4)
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 001_core.sql  |  Facilities, identity, RBAC, sessions, audit, infrastructure
-- Target: PostgreSQL 14+ (tested on PostgreSQL 18 / PGlite)
-- All tenant-scoped tables carry facility_id and are protected by RLS (003).
-- ============================================================================

CREATE TABLE facilities (
  id            uuid PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name_ar       text NOT NULL,
  name_en       text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Riyadh',
  currency      text NOT NULL DEFAULT 'SAR',
  locale        text NOT NULL DEFAULT 'ar-SA',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  name_ar      text NOT NULL,
  name_en      text NOT NULL,
  dept_type    text NOT NULL CHECK (dept_type IN ('outpatient','emergency','inpatient','icu','lab','radiology','pharmacy','administration','other')),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY,
  email                 text NOT NULL,
  password_hash         text NOT NULL,
  full_name_ar          text NOT NULL,
  full_name_en          text NOT NULL,
  job_title_ar          text,
  phone_enc             text,
  is_active             boolean NOT NULL DEFAULT true,
  is_super_admin        boolean NOT NULL DEFAULT false,
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_enc        text,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  preferred_language    text NOT NULL DEFAULT 'ar',
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE user_facilities (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  PRIMARY KEY (user_id, facility_id)
);

CREATE TABLE roles (
  id           text PRIMARY KEY,
  name_ar      text NOT NULL,
  name_en      text NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT true
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  module      text NOT NULL,
  desc_ar     text NOT NULL
);

CREATE TABLE role_permissions (
  role_id          text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- Department and facility scoped role assignment (least privilege, multi-facility).
CREATE TABLE user_roles (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id        text NOT NULL REFERENCES roles(id),
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  department_id  uuid REFERENCES departments(id),
  assigned_by    uuid REFERENCES users(id),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id, facility_id)
);

CREATE TABLE sessions (
  id                   uuid PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash           text NOT NULL UNIQUE,
  csrf_token           text NOT NULL,
  facility_id          uuid REFERENCES facilities(id),
  ip                   text,
  user_agent           text,
  mfa_verified         boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoked_reason       text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_recovery_codes (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tamper-evident audit log (hash chain). UPDATE/DELETE are blocked by trigger + grants.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  facility_id    uuid,
  actor_user_id  uuid,
  actor_role     text,
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  patient_id     uuid,
  outcome        text NOT NULL DEFAULT 'success',
  reason         text,
  ip             text,
  user_agent     text,
  request_id     text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      text NOT NULL,
  hash           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_patient_idx ON audit_log (patient_id, created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, created_at DESC);

CREATE TABLE idempotency_keys (
  key            text NOT NULL,
  user_id        uuid NOT NULL,
  endpoint       text NOT NULL,
  request_hash   text NOT NULL,
  status_code    integer NOT NULL,
  response_json  jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id, endpoint)
);

CREATE TABLE number_sequences (
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  name         text NOT NULL,
  next_value   bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (facility_id, name)
);

CREATE TABLE app_settings (
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  key          text NOT NULL,
  value        jsonb NOT NULL,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, key)
);

-- Outbox for notifications. Delivery is attempted by a background worker; rows are
-- never reported as "sent" unless a provider transport acknowledged them.
CREATE TABLE notifications_outbox (
  id             bigserial PRIMARY KEY,
  facility_id    uuid NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email','sms','in_app')),
  recipient      text,
  subject        text,
  body           text NOT NULL,
  patient_id     uuid,
  related_type   text,
  related_id     text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  scheduled_at   timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_pending_idx ON notifications_outbox (status, scheduled_at);

-- Emergency ("break-glass") access grants: time-boxed, reason-bound, audited.
CREATE TABLE break_glass_grants (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  facility_id  uuid NOT NULL,
  patient_id   uuid NOT NULL,
  reason       text NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  reviewed_by  uuid,
  reviewed_at  timestamptz
);

-- Every read of a patient chart is recorded (PDPL / HIPAA-style access log).
CREATE TABLE patient_access_log (
  id             bigserial PRIMARY KEY,
  facility_id    uuid NOT NULL,
  user_id        uuid,
  patient_id     uuid NOT NULL,
  access_type    text NOT NULL,
  access_basis   text NOT NULL,
  reason         text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_access_log_patient_idx ON patient_access_log (patient_id, created_at DESC);

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('001_core.sql', 'fd6eef3fb6583c66cfb4b1cc85f756752865ebb0048ff43d040a14cf609a84d4')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 002_clinical.sql (sha256: b76922695b1a7b8a9e9b040e9f5eb3b3227fe561070293a1305964ed16e5ed20)
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 002_clinical.sql | Master patient index, outpatient, clinical, labs, pharmacy,
--                   billing, insurance, inventory, inpatient beds
-- ============================================================================

-- ---------------------------------------------------------------- Patients ---
CREATE TABLE patients (
  id                uuid PRIMARY KEY,
  facility_id       uuid NOT NULL REFERENCES facilities(id),
  mrn               text NOT NULL,
  national_id_enc   text,               -- AES-256-GCM (app layer)
  national_id_hash  text,               -- keyed blind index for duplicate detection
  full_name_ar      text NOT NULL,
  full_name_en      text,
  date_of_birth     date NOT NULL,
  sex               text NOT NULL CHECK (sex IN ('male','female','other')),
  phone_enc         text,
  email             text,
  address_enc       text,
  nationality       text,
  marital_status    text,
  blood_type        text CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-') OR blood_type IS NULL),
  next_of_kin_name  text,
  next_of_kin_phone_enc text,
  is_deceased       boolean NOT NULL DEFAULT false,
  duplicate_of_id   uuid REFERENCES patients(id),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','archived')),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  UNIQUE (facility_id, mrn)
);
CREATE UNIQUE INDEX patients_national_id_uq ON patients (national_id_hash)
  WHERE national_id_hash IS NOT NULL AND status <> 'merged';
CREATE INDEX patients_name_idx ON patients (facility_id, full_name_ar);

CREATE TABLE patient_allergies (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  patient_id  uuid NOT NULL REFERENCES patients(id),
  allergen    text NOT NULL,
  reaction    text,
  severity    text NOT NULL CHECK (severity IN ('mild','moderate','severe','anaphylaxis')),
  is_active   boolean NOT NULL DEFAULT true,
  noted_by    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_conditions (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  patient_id  uuid NOT NULL REFERENCES patients(id),
  icd10_code  text NOT NULL,
  description text NOT NULL,
  onset_date  date,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','inactive')),
  noted_by    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  patient_id  uuid NOT NULL REFERENCES patients(id),
  consent_type text NOT NULL,
  granted     boolean NOT NULL,
  evidence    text,
  recorded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- Reception / OPD ---
CREATE TABLE appointments (
  id                 uuid PRIMARY KEY,
  facility_id        uuid NOT NULL REFERENCES facilities(id),
  appointment_no     text NOT NULL,
  patient_id         uuid NOT NULL REFERENCES patients(id),
  department_id      uuid NOT NULL REFERENCES departments(id),
  doctor_id          uuid NOT NULL REFERENCES users(id),
  scheduled_at       timestamptz NOT NULL,
  duration_minutes   integer NOT NULL DEFAULT 15 CHECK (duration_minutes BETWEEN 5 AND 240),
  status             text NOT NULL DEFAULT 'booked'
                     CHECK (status IN ('booked','checked_in','in_consultation','completed','cancelled','no_show')),
  reason             text,
  checked_in_at      timestamptz,
  cancelled_at       timestamptz,
  cancellation_reason text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, appointment_no)
);
-- A doctor cannot be double-booked for the same slot while the visit is live.
CREATE UNIQUE INDEX appointments_no_double_booking ON appointments (doctor_id, scheduled_at)
  WHERE status IN ('booked','checked_in','in_consultation');
CREATE INDEX appointments_day_idx ON appointments (facility_id, scheduled_at);
CREATE INDEX appointments_patient_idx ON appointments (patient_id, scheduled_at DESC);

CREATE TABLE encounters (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  encounter_no    text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id),
  appointment_id  uuid REFERENCES appointments(id),
  encounter_type  text NOT NULL CHECK (encounter_type IN ('outpatient','emergency','inpatient','telemedicine')),
  department_id   uuid NOT NULL REFERENCES departments(id),
  doctor_id       uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  chief_complaint text,
  triage_level    integer CHECK (triage_level BETWEEN 1 AND 5),
  started_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  disposition     text,
  created_by      uuid REFERENCES users(id),
  UNIQUE (facility_id, encounter_no)
);
CREATE UNIQUE INDEX encounters_one_open_per_patient ON encounters (patient_id)
  WHERE status = 'open' AND encounter_type <> 'inpatient';
CREATE INDEX encounters_patient_idx ON encounters (patient_id, started_at DESC);

CREATE TABLE vitals (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  patient_id    uuid NOT NULL REFERENCES patients(id),
  encounter_id  uuid REFERENCES encounters(id),
  recorded_by   uuid REFERENCES users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  temperature_c numeric(4,1),
  heart_rate    integer,
  resp_rate     integer,
  systolic_bp   integer,
  diastolic_bp  integer,
  spo2          integer,
  pain_score    integer CHECK (pain_score BETWEEN 0 AND 10),
  weight_kg     numeric(5,2),
  height_cm     numeric(5,2),
  notes         text
);
CREATE INDEX vitals_patient_idx ON vitals (patient_id, recorded_at DESC);

-- Clinical notes are append-only; corrections are new amendment records.
CREATE TABLE clinical_notes (
  id               uuid PRIMARY KEY,
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  encounter_id     uuid NOT NULL REFERENCES encounters(id),
  note_type        text NOT NULL CHECK (note_type IN ('consultation','progress','nursing','discharge')),
  subjective       text,
  objective        text,
  assessment       text,
  plan             text,
  author_id        uuid NOT NULL REFERENCES users(id),
  signed_at        timestamptz,
  amends_note_id   uuid REFERENCES clinical_notes(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clinical_notes_encounter_idx ON clinical_notes (encounter_id, created_at);

CREATE TABLE diagnoses (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  patient_id    uuid NOT NULL REFERENCES patients(id),
  encounter_id  uuid REFERENCES encounters(id),
  icd10_code    text NOT NULL,
  description   text NOT NULL,
  diagnosis_type text NOT NULL DEFAULT 'primary' CHECK (diagnosis_type IN ('primary','secondary')),
  recorded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------- Labs ---
CREATE TABLE lab_tests (
  code           text PRIMARY KEY,          -- LOINC code
  name_ar        text NOT NULL,
  name_en        text NOT NULL,
  specimen       text NOT NULL,
  unit           text,
  ref_low        numeric,
  ref_high       numeric,
  critical_low   numeric,
  critical_high  numeric,
  price          numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE lab_orders (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  order_no        text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id),
  encounter_id    uuid REFERENCES encounters(id),
  ordered_by      uuid NOT NULL REFERENCES users(id),
  ordered_at      timestamptz NOT NULL DEFAULT now(),
  priority        text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
  status          text NOT NULL DEFAULT 'ordered'
                  CHECK (status IN ('ordered','collected','partial','completed','cancelled')),
  clinical_notes  text,
  cancelled_at    timestamptz,
  cancellation_reason text,
  UNIQUE (facility_id, order_no)
);
CREATE INDEX lab_orders_patient_idx ON lab_orders (patient_id, ordered_at DESC);
CREATE INDEX lab_orders_worklist_idx ON lab_orders (facility_id, status, priority);

CREATE TABLE lab_order_items (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  order_id      uuid NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  test_code     text NOT NULL REFERENCES lab_tests(code),
  status        text NOT NULL DEFAULT 'ordered'
                CHECK (status IN ('ordered','collected','resulted','verified','cancelled')),
  specimen_barcode text,
  collected_by  uuid REFERENCES users(id),
  collected_at  timestamptz,
  verified_by   uuid REFERENCES users(id),
  verified_at   timestamptz,
  price         numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX lab_items_order_idx ON lab_order_items (order_id);

CREATE TABLE lab_results (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  order_item_id uuid NOT NULL UNIQUE REFERENCES lab_order_items(id),
  value_numeric numeric,
  value_text    text,
  unit          text,
  flag          text NOT NULL DEFAULT 'normal'
                CHECK (flag IN ('normal','high','low','critical_high','critical_low')),
  comment       text,
  resulted_by   uuid NOT NULL REFERENCES users(id),
  resulted_at   timestamptz NOT NULL DEFAULT now(),
  verified_by   uuid REFERENCES users(id),
  verified_at   timestamptz
);

CREATE TABLE lab_result_amendments (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  result_id     uuid NOT NULL REFERENCES lab_results(id),
  previous_value text,
  new_value     text,
  reason        text NOT NULL,
  amended_by    uuid NOT NULL REFERENCES users(id),
  amended_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE critical_alerts (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  patient_id      uuid NOT NULL,
  result_id       uuid NOT NULL REFERENCES lab_results(id),
  message         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  ack_note        text
);

-- --------------------------------------------------------------- Pharmacy ---
CREATE TABLE drugs (
  id           uuid PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  name_ar      text NOT NULL,
  name_en      text NOT NULL,
  form         text NOT NULL,
  strength     text,
  is_controlled boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE drug_batches (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  drug_id       uuid NOT NULL REFERENCES drugs(id),
  batch_no      text NOT NULL,
  expiry_date   date NOT NULL,
  qty_on_hand   numeric(12,2) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  unit_cost     numeric(12,2) NOT NULL DEFAULT 0,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, drug_id, batch_no, expiry_date)
);
CREATE INDEX drug_batches_fefo_idx ON drug_batches (facility_id, drug_id, expiry_date);

-- Deliberately small seeded rule set; NOT a substitute for a licensed clinical
-- decision-support database. Every warning is shown to the pharmacist as advice.
CREATE TABLE drug_interactions (
  id          uuid PRIMARY KEY,
  drug_a_code text NOT NULL,
  drug_b_code text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('minor','moderate','major','contraindicated')),
  description text NOT NULL
);

CREATE TABLE prescriptions (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  prescription_no text NOT NULL,
  patient_id     uuid NOT NULL REFERENCES patients(id),
  encounter_id   uuid NOT NULL REFERENCES encounters(id),
  prescribed_by  uuid NOT NULL REFERENCES users(id),
  prescribed_at  timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'issued'
                 CHECK (status IN ('draft','issued','partially_dispensed','dispensed','cancelled')),
  notes          text,
  UNIQUE (facility_id, prescription_no)
);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, prescribed_at DESC);

CREATE TABLE prescription_items (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  prescription_id uuid NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  drug_id         uuid NOT NULL REFERENCES drugs(id),
  dose            text NOT NULL,
  route           text NOT NULL,
  frequency       text NOT NULL,
  duration_days   integer NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
  quantity        numeric(10,2) NOT NULL CHECK (quantity > 0),
  instructions    text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispensed','cancelled')),
  price           numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE dispenses (
  id                   uuid PRIMARY KEY,
  facility_id          uuid NOT NULL REFERENCES facilities(id),
  prescription_item_id uuid NOT NULL REFERENCES prescription_items(id),
  drug_batch_id        uuid NOT NULL REFERENCES drug_batches(id),
  quantity             numeric(10,2) NOT NULL CHECK (quantity > 0),
  dispensed_by         uuid NOT NULL REFERENCES users(id),
  dispensed_at         timestamptz NOT NULL DEFAULT now(),
  note                 text
);

CREATE TABLE stock_movements (
  id             bigserial PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  drug_id        uuid NOT NULL REFERENCES drugs(id),
  batch_id       uuid REFERENCES drug_batches(id),
  movement_type  text NOT NULL CHECK (movement_type IN ('receipt','dispense','return','adjustment','write_off')),
  quantity       numeric(12,2) NOT NULL,   -- signed
  reference_type text,
  reference_id   text,
  performed_by   uuid REFERENCES users(id),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Billing ---
CREATE TABLE insurance_policies (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  patient_id    uuid NOT NULL REFERENCES patients(id),
  payer_name    text NOT NULL,
  policy_no_enc text NOT NULL,
  policy_no_hash text NOT NULL,
  coverage_pct  numeric(5,2) NOT NULL DEFAULT 80 CHECK (coverage_pct BETWEEN 0 AND 100),
  valid_from    date NOT NULL,
  valid_to      date,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX insurance_policy_uq ON insurance_policies (policy_no_hash);

CREATE TABLE invoices (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  invoice_no   text NOT NULL,
  patient_id   uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','partially_paid','paid','void')),
  subtotal     numeric(14,2) NOT NULL DEFAULT 0,
  discount     numeric(14,2) NOT NULL DEFAULT 0,
  tax          numeric(14,2) NOT NULL DEFAULT 0,
  total        numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount  numeric(14,2) NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'SAR',
  void_reason  text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, invoice_no)
);
CREATE INDEX invoices_patient_idx ON invoices (patient_id, created_at DESC);
CREATE INDEX invoices_open_idx ON invoices (facility_id, status);

CREATE TABLE invoice_items (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  invoice_id     uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  category       text NOT NULL CHECK (category IN ('consultation','lab','radiology','pharmacy','bed','procedure','other')),
  description    text NOT NULL,
  reference_type text,
  reference_id   text,
  quantity       numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price     numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total     numeric(14,2) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);
-- One charge per source document line (prevents double billing on retries).
CREATE UNIQUE INDEX invoice_items_reference_uq ON invoice_items (reference_type, reference_id)
  WHERE reference_type IS NOT NULL;

CREATE TABLE payments (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  invoice_id     uuid NOT NULL REFERENCES invoices(id),
  amount         numeric(14,2) NOT NULL CHECK (amount > 0),
  method         text NOT NULL CHECK (method IN ('cash','card','transfer','insurance','online')),
  reference      text,
  received_by    uuid NOT NULL REFERENCES users(id),
  received_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded','reversed')),
  reversed_reason text
);

CREATE TABLE insurance_claims (
  id               uuid PRIMARY KEY,
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  claim_no         text NOT NULL,
  invoice_id       uuid NOT NULL REFERENCES invoices(id),
  policy_id        uuid NOT NULL REFERENCES insurance_policies(id),
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','approved','partially_approved','rejected','paid')),
  submitted_at     timestamptz,
  decided_at       timestamptz,
  claimed_amount   numeric(14,2) NOT NULL DEFAULT 0,
  approved_amount  numeric(14,2),
  rejection_reason text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, claim_no)
);

-- ------------------------------------------------------------- Inpatient ----
CREATE TABLE wards (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  ward_type   text NOT NULL CHECK (ward_type IN ('general','icu','isolation','maternity','pediatric','surgical')),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE rooms (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  ward_id     uuid NOT NULL REFERENCES wards(id),
  room_no     text NOT NULL,
  room_type   text NOT NULL DEFAULT 'standard' CHECK (room_type IN ('standard','private','isolation','icu')),
  UNIQUE (ward_id, room_no)
);

CREATE TABLE beds (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  ward_id     uuid NOT NULL REFERENCES wards(id),
  room_id     uuid NOT NULL REFERENCES rooms(id),
  bed_no      text NOT NULL,
  status      text NOT NULL DEFAULT 'available'
              CHECK (status IN ('available','occupied','cleaning','maintenance')),
  UNIQUE (room_id, bed_no)
);

CREATE TABLE admissions (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  admission_no   text NOT NULL,
  patient_id     uuid NOT NULL REFERENCES patients(id),
  encounter_id   uuid NOT NULL REFERENCES encounters(id),
  bed_id         uuid REFERENCES beds(id),
  attending_doctor_id uuid NOT NULL REFERENCES users(id),
  admitted_by    uuid REFERENCES users(id),
  admitted_at    timestamptz NOT NULL DEFAULT now(),
  discharged_at  timestamptz,
  discharge_type text CHECK (discharge_type IN ('home','transfer','deceased','against_advice') OR discharge_type IS NULL),
  discharge_summary text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','discharged','transferred','cancelled')),
  UNIQUE (facility_id, admission_no)
);
CREATE UNIQUE INDEX admissions_one_active_per_patient ON admissions (patient_id) WHERE status = 'active';
CREATE UNIQUE INDEX admissions_one_active_per_bed ON admissions (bed_id) WHERE status = 'active';

CREATE TABLE bed_transfers (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  admission_id  uuid NOT NULL REFERENCES admissions(id),
  from_bed_id   uuid REFERENCES beds(id),
  to_bed_id     uuid NOT NULL REFERENCES beds(id),
  reason        text,
  transferred_by uuid REFERENCES users(id),
  transferred_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------- Indexes for scoping ----
CREATE INDEX patients_facility_idx ON patients (facility_id);
CREATE INDEX encounters_facility_idx ON encounters (facility_id, status);
CREATE INDEX lab_results_facility_idx ON lab_results (facility_id, verified_at);

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('002_clinical.sql', 'b76922695b1a7b8a9e9b040e9f5eb3b3227fe561070293a1305964ed16e5ed20')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 003_security_rls.sql (sha256: fc219410bbec432d2d151178d85471bd77134ea789593785b88309b1981bf6ec)
-- ----------------------------------------------------------------------------
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

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('003_security_rls.sql', 'fc219410bbec432d2d151178d85471bd77134ea789593785b88309b1981bf6ec')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 004_audit_chain.sql (sha256: af4b02c5a56ca0eff3d764c97cc89b0a75540f50d5dad65a12132c4fc916cb20)
-- ----------------------------------------------------------------------------
-- Serializes construction of the tamper-evident audit hash chain.
CREATE TABLE audit_chain_state (
  id         integer PRIMARY KEY CHECK (id = 1),
  last_hash  text NOT NULL,
  last_id    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO audit_chain_state (id, last_hash) VALUES (1, repeat('0', 64));
GRANT SELECT, UPDATE ON audit_chain_state TO hms_app;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('004_audit_chain.sql', 'af4b02c5a56ca0eff3d764c97cc89b0a75540f50d5dad65a12132c4fc916cb20')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 005_auth_extras.sql (sha256: b058370c562183510a39019cce4e6274e6d95bf54beb1efd70f7bfa7ee039fc1)
-- ----------------------------------------------------------------------------
-- Portal accounts are bound to exactly one patient record.
ALTER TABLE users ADD COLUMN patient_id uuid REFERENCES patients(id);
CREATE UNIQUE INDEX users_patient_uq ON users (patient_id) WHERE patient_id IS NOT NULL;
-- Tenant-level switch forcing MFA enrolment for this account.
ALTER TABLE users ADD COLUMN mfa_enforced boolean NOT NULL DEFAULT false;
GRANT SELECT, UPDATE ON users TO hms_app;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('005_auth_extras.sql', 'b058370c562183510a39019cce4e6274e6d95bf54beb1efd70f7bfa7ee039fc1')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 006_pricing.sql (sha256: 66a8bb1ce6424d3a39e119ffee4591070c90cc5a749f09fd8b1fd979ae4e4792)
-- ----------------------------------------------------------------------------
ALTER TABLE drugs ADD COLUMN price numeric(12,2) NOT NULL DEFAULT 0;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('006_pricing.sql', '66a8bb1ce6424d3a39e119ffee4591070c90cc5a749f09fd8b1fd979ae4e4792')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 007_portal_access.sql (sha256: 22e23887c8238ed79b87ed5e6567334c8b77558f571d38c0fe69198ce94a0ee8)
-- ----------------------------------------------------------------------------
-- Portal (patient) role needs limited read access to shared reference data.
GRANT SELECT ON departments, facilities, drugs, lab_tests TO hms_portal;

-- Departments and pricing are not tenant-private reference data.
CREATE POLICY portal_read_departments ON departments FOR SELECT TO hms_portal USING (true);
CREATE POLICY portal_read_settings ON app_settings FOR SELECT TO hms_portal USING (key = 'pricing.consultation');

-- Patients may see the display name of clinicians involved in their care, but
-- must never read the users table (emails, hashes, MFA secrets) directly.
CREATE VIEW portal_clinicians AS
  SELECT id, full_name_ar, job_title_ar FROM users WHERE is_active = true;
GRANT SELECT ON portal_clinicians TO hms_portal;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('007_portal_access.sql', '22e23887c8238ed79b87ed5e6567334c8b77558f571d38c0fe69198ce94a0ee8')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 008_audit_version.sql (sha256: d8def3e25cbb00adb1f551fcb764e35440d5001b723e2b5a0efecb1441a3b46e)
-- ----------------------------------------------------------------------------
-- The audit hash canonicalisation is versioned so the algorithm can evolve
-- without silently invalidating existing chains.
ALTER TABLE audit_log ADD COLUMN hash_version smallint NOT NULL DEFAULT 1;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('008_audit_version.sql', 'd8def3e25cbb00adb1f551fcb764e35440d5001b723e2b5a0efecb1441a3b46e')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 009_emergency.sql (sha256: 61f5e5b5275b41d1fd84cf4dd984a62a4efa3fc4f65ed4a0ea7cacc90cf65bd9)
-- ----------------------------------------------------------------------------
-- Emergency department: arrival registration, triage (ESI 1-5), retriage history,
-- and disposition (admit / discharge / transfer / observation).
CREATE TABLE triage_records (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  patient_id     uuid NOT NULL REFERENCES patients(id),
  encounter_id   uuid NOT NULL REFERENCES encounters(id),
  level          integer NOT NULL CHECK (level BETWEEN 1 AND 5),  -- 1 = resuscitation
  chief_complaint text NOT NULL,
  notes          text,
  arrived_at     timestamptz NOT NULL DEFAULT now(),
  triaged_at     timestamptz NOT NULL DEFAULT now(),
  triaged_by     uuid REFERENCES users(id),
  previous_level integer,
  reason         text,          -- reason for retriage / level change
  status         text NOT NULL DEFAULT 'waiting'
                 CHECK (status IN ('waiting','in_treatment','observation','admitted','discharged','transferred','left_without_being_seen')),
  disposition_at timestamptz,
  UNIQUE (encounter_id, triaged_at)
);
CREATE INDEX triage_board_idx ON triage_records (facility_id, status, level, arrived_at);
CREATE INDEX triage_patient_idx ON triage_records (patient_id, arrived_at DESC);

-- Unidentified ("John Doe") ER patients are registered under a temporary MRN and
-- later merged; flagged explicitly so staff know identity is unverified.
ALTER TABLE patients ADD COLUMN identity_status text NOT NULL DEFAULT 'verified'
  CHECK (identity_status IN ('verified','unverified_temporary'));

-- Observation / ER bed type support.
ALTER TABLE beds DROP CONSTRAINT IF EXISTS beds_status_check;
ALTER TABLE beds ADD CONSTRAINT beds_status_check
  CHECK (status IN ('available','occupied','cleaning','maintenance'));

ALTER TABLE triage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON triage_records FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

GRANT SELECT, INSERT, UPDATE ON triage_records TO hms_app;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('009_emergency.sql', '61f5e5b5275b41d1fd84cf4dd984a62a4efa3fc4f65ed4a0ea7cacc90cf65bd9')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 010_note_reparent.sql (sha256: 4f5e93278c6575756c50b88db4a14a610b0946affabbb54235e917cc3fce6811)
-- ----------------------------------------------------------------------------
-- Patient merge must re-parent signed clinical notes without altering their
-- content. Rather than weakening append-only guarantees, permit exactly one
-- mutation: changing patient_id while every other column stays identical.
CREATE OR REPLACE FUNCTION allow_note_reparent_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(OLD) - 'patient_id') = (to_jsonb(NEW) - 'patient_id') THEN
    RETURN NEW;   -- identity correction during a documented merge
  END IF;
  RAISE EXCEPTION 'Table % is append-only: only patient_id may be corrected, % with other changes is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER clinical_notes_immutable ON clinical_notes;
CREATE TRIGGER clinical_notes_immutable
  BEFORE UPDATE OR DELETE ON clinical_notes
  FOR EACH ROW EXECUTE FUNCTION allow_note_reparent_only();

-- Column-level privilege for the same narrow operation.
GRANT UPDATE (patient_id) ON clinical_notes TO hms_app;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('010_note_reparent.sql', '4f5e93278c6575756c50b88db4a14a610b0946affabbb54235e917cc3fce6811')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 011_radiology.sql (sha256: b1fb7d30a51709d6d38b61d7bef79d18bd031837310b03f147d6a298090b928d)
-- ----------------------------------------------------------------------------
-- Radiology / medical imaging requests, reports and critical-result traceability.
-- Image acquisition itself stays outside this system (no DICOM/PACS link yet);
-- what is modelled is the order, the technical performance and the signed report.

CREATE TABLE imaging_orders (
  id                  uuid PRIMARY KEY,
  facility_id         uuid NOT NULL REFERENCES facilities(id),
  order_no            text NOT NULL,
  encounter_id        uuid NOT NULL REFERENCES encounters(id),
  patient_id          uuid NOT NULL REFERENCES patients(id),
  modality            text NOT NULL CHECK (modality IN ('xray','ct','mri','us','mammography','fluoroscopy')),
  body_part           text NOT NULL,
  clinical_indication text NOT NULL,
  priority            text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
  status              text NOT NULL DEFAULT 'ordered'
                      CHECK (status IN ('ordered','in_progress','performed','reported','verified','cancelled')),
  ordered_by          uuid NOT NULL REFERENCES users(id),
  ordered_at          timestamptz NOT NULL DEFAULT now(),
  performed_by        uuid REFERENCES users(id),
  performed_at        timestamptz,
  cancel_reason       text,
  cancelled_by        uuid REFERENCES users(id),
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, order_no)
);
CREATE INDEX imaging_orders_worklist_idx ON imaging_orders (facility_id, status, priority, ordered_at);
CREATE INDEX imaging_orders_patient_idx ON imaging_orders (patient_id, ordered_at DESC);
CREATE INDEX imaging_orders_encounter_idx ON imaging_orders (encounter_id);

CREATE TABLE imaging_reports (
  id                 uuid PRIMARY KEY,
  facility_id        uuid NOT NULL REFERENCES facilities(id),
  order_id           uuid NOT NULL REFERENCES imaging_orders(id),
  version            integer NOT NULL DEFAULT 1,
  findings           text NOT NULL,
  impression         text NOT NULL,
  recommendation     text,
  is_critical        boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  reported_by        uuid NOT NULL REFERENCES users(id),
  reported_at        timestamptz NOT NULL DEFAULT now(),
  finalized_by       uuid REFERENCES users(id),
  finalized_at       timestamptz,
  amendments         integer NOT NULL DEFAULT 0,
  amended_from       uuid REFERENCES imaging_reports(id),
  acknowledged_by    uuid REFERENCES users(id),
  acknowledged_at    timestamptz,
  UNIQUE (order_id, version)
);
CREATE INDEX imaging_reports_order_idx ON imaging_reports (order_id, version DESC);

-- A finalized report is a medical record: it can never be edited or deleted.
-- Corrections are appended as a new version linked through amended_from.
CREATE OR REPLACE FUNCTION imaging_report_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'imaging reports are medical records and cannot be deleted'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'final' THEN
    -- The only permitted post-signature change is the critical-result receipt
    -- (acknowledgement), which is a fact about delivery, not about the report.
    IF OLD.acknowledged_at IS NULL
       AND NEW.acknowledged_at IS NOT NULL
       AND (to_jsonb(OLD) - 'acknowledged_by' - 'acknowledged_at') = (to_jsonb(NEW) - 'acknowledged_by' - 'acknowledged_at')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'finalized imaging reports are immutable; append a new version instead'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.order_id <> NEW.order_id OR OLD.reported_by <> NEW.reported_by THEN
    RAISE EXCEPTION 'imaging report authorship cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER imaging_reports_guard
  BEFORE UPDATE OR DELETE ON imaging_reports
  FOR EACH ROW EXECUTE FUNCTION imaging_report_guard();

ALTER TABLE imaging_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE imaging_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON imaging_orders FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE imaging_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE imaging_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON imaging_reports FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

GRANT SELECT, INSERT, UPDATE ON imaging_orders TO hms_app;
GRANT SELECT, INSERT, UPDATE ON imaging_reports TO hms_app;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'imaging', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('011_radiology.sql', 'b1fb7d30a51709d6d38b61d7bef79d18bd031837310b03f147d6a298090b928d')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 012_nursing.sql (sha256: 5f6519c1dbd75d6f73869d379de8fcfd77d115730f2d0b2f401a2e7d4847cdf2)
-- ----------------------------------------------------------------------------
-- Nursing: care plans, shift handover (SBAR) and the medication administration
-- record (MAR). The MAR is a legal record of what was actually given, so it is
-- append-only: errors are corrected by appending a correction, never by editing.

-- Dosing interval in hours, so the MAR can compute what is due rather than
-- parsing free text on every request.
ALTER TABLE prescription_items ADD COLUMN interval_hours integer
  CHECK (interval_hours BETWEEN 1 AND 168);
UPDATE prescription_items SET interval_hours = CASE
  WHEN frequency LIKE '%مرتين%' OR frequency LIKE '%twice%' THEN 12
  WHEN frequency LIKE '%ثلاث%' OR frequency LIKE '%three times%' THEN 8
  WHEN frequency LIKE '%أربع%' OR frequency LIKE '%four times%' THEN 6
  WHEN frequency LIKE '%كل 4 ساع%' THEN 4
  WHEN frequency LIKE '%كل 6 ساع%' THEN 6
  WHEN frequency LIKE '%كل 8 ساع%' THEN 8
  WHEN frequency LIKE '%كل 12 ساع%' THEN 12
  ELSE 24
END
WHERE interval_hours IS NULL;

-- High-alert medications (ISMP): a second nurse must witness administration.
ALTER TABLE drugs ADD COLUMN is_high_alert boolean NOT NULL DEFAULT false;
UPDATE drugs SET is_high_alert = true WHERE is_controlled = true;

CREATE TABLE care_plans (
  id                uuid PRIMARY KEY,
  facility_id       uuid NOT NULL REFERENCES facilities(id),
  patient_id        uuid NOT NULL REFERENCES patients(id),
  encounter_id      uuid NOT NULL REFERENCES encounters(id),
  admission_id      uuid REFERENCES admissions(id),
  title             text NOT NULL,
  nursing_diagnosis text NOT NULL,
  goals             text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','discontinued')),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_at       timestamptz,
  ended_at          timestamptz,
  end_reason        text
);
CREATE INDEX care_plans_admission_idx ON care_plans (admission_id, status);
CREATE INDEX care_plans_patient_idx ON care_plans (patient_id, created_at DESC);

CREATE TABLE care_plan_tasks (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  care_plan_id   uuid NOT NULL REFERENCES care_plans(id),
  description    text NOT NULL,
  due_at         timestamptz,
  frequency_hours integer CHECK (frequency_hours BETWEEN 1 AND 168),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  completed_by   uuid REFERENCES users(id),
  completed_at   timestamptz,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_plan_tasks_due_idx ON care_plan_tasks (facility_id, status, due_at);

CREATE TABLE shift_handovers (
  id                uuid PRIMARY KEY,
  facility_id       uuid NOT NULL REFERENCES facilities(id),
  patient_id        uuid NOT NULL REFERENCES patients(id),
  encounter_id      uuid NOT NULL REFERENCES encounters(id),
  admission_id      uuid REFERENCES admissions(id),
  shift             text NOT NULL CHECK (shift IN ('morning','evening','night')),
  patient_condition text NOT NULL CHECK (patient_condition IN ('stable','improving','deteriorating','critical')),
  situation         text NOT NULL,
  background        text NOT NULL,
  assessment        text NOT NULL,
  recommendation    text NOT NULL,
  from_user_id      uuid NOT NULL REFERENCES users(id),
  to_user_id        uuid REFERENCES users(id),
  handed_over_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_by   uuid REFERENCES users(id),
  acknowledged_at   timestamptz
);
CREATE INDEX shift_handovers_admission_idx ON shift_handovers (admission_id, handed_over_at DESC);
CREATE INDEX shift_handovers_patient_idx ON shift_handovers (patient_id, handed_over_at DESC);

CREATE TABLE medication_administrations (
  id                   uuid PRIMARY KEY,
  facility_id          uuid NOT NULL REFERENCES facilities(id),
  patient_id           uuid NOT NULL REFERENCES patients(id),
  encounter_id         uuid NOT NULL REFERENCES encounters(id),
  admission_id         uuid REFERENCES admissions(id),
  prescription_item_id uuid NOT NULL REFERENCES prescription_items(id),
  scheduled_for        timestamptz NOT NULL,
  administered_at      timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL CHECK (status IN ('given','held','refused','missed')),
  dose_given           text,
  route                text,
  site                 text,
  identity_verified    boolean NOT NULL DEFAULT false,
  allergy_checked      boolean NOT NULL DEFAULT false,
  administered_by      uuid NOT NULL REFERENCES users(id),
  witness_by           uuid REFERENCES users(id),
  reason               text,
  corrects_id          uuid REFERENCES medication_administrations(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- One record per scheduled slot; corrections are additional rows linked to the
-- record they replace, so an administered dose can never be silently changed.
CREATE UNIQUE INDEX mar_one_record_per_slot
  ON medication_administrations (prescription_item_id, scheduled_for)
  WHERE corrects_id IS NULL;
CREATE INDEX mar_patient_idx ON medication_administrations (patient_id, administered_at DESC);
CREATE INDEX mar_admission_idx ON medication_administrations (admission_id, scheduled_for DESC);

-- Append-only triggers ---------------------------------------------------------
CREATE OR REPLACE FUNCTION mar_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'medication administration records are append-only; append a correction instead'
    USING ERRCODE = '42501';
END $$;
CREATE TRIGGER mar_no_update BEFORE UPDATE OR DELETE ON medication_administrations
  FOR EACH ROW EXECUTE FUNCTION mar_append_only();

-- A handover can only gain its acknowledgement; the clinical text is frozen.
CREATE OR REPLACE FUNCTION handover_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'handover records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.acknowledged_at IS NULL
     AND NEW.acknowledged_at IS NOT NULL
     AND (to_jsonb(OLD) - 'acknowledged_by' - 'acknowledged_at') = (to_jsonb(NEW) - 'acknowledged_by' - 'acknowledged_at')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'handover records are immutable once written' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER shift_handovers_guard BEFORE UPDATE OR DELETE ON shift_handovers
  FOR EACH ROW EXECUTE FUNCTION handover_guard();

-- Row level security -----------------------------------------------------------
ALTER TABLE care_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON care_plans FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE care_plan_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_plan_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON care_plan_tasks FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE shift_handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_handovers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_handovers FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE medication_administrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_administrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON medication_administrations FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

GRANT SELECT, INSERT, UPDATE ON care_plans TO hms_app;
GRANT SELECT, INSERT, UPDATE ON care_plan_tasks TO hms_app;
GRANT SELECT, INSERT, UPDATE ON shift_handovers TO hms_app;
GRANT SELECT, INSERT ON medication_administrations TO hms_app;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('012_nursing.sql', '5f6519c1dbd75d6f73869d379de8fcfd77d115730f2d0b2f401a2e7d4847cdf2')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 013_surgery.sql (sha256: cdbff9956e1cbe32121d1e9f86ce104d8c5a6bd14f03c4c4a291e45faf3d9eee)
-- ----------------------------------------------------------------------------
-- Operating theatres, surgical cases, WHO surgical-safety checklists,
-- intra-operative anaesthesia records and post-anaesthesia recovery.
--
-- Safety model enforced in the database as well as in the API:
--  * each safety phase (sign-in / time-out / sign-out) is written once and can
--    never be edited or deleted;
--  * anaesthesia observations and PACU records are append-only;
--  * a completed or cancelled case is a closed record and rejects updates;
--  * theatre slots are unique at the minute level (API rejects overlaps too).

ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_dept_type_check;
ALTER TABLE departments ADD CONSTRAINT departments_dept_type_check
  CHECK (dept_type IN ('outpatient','emergency','inpatient','icu','lab','radiology','pharmacy',
                       'administration','surgery','anesthesia','other'));

CREATE TABLE operating_theatres (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  dept_id     uuid REFERENCES departments(id),
  code        text NOT NULL,
  name_ar     text NOT NULL,
  name_en     text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);

CREATE TABLE surgical_cases (
  id                  uuid PRIMARY KEY,
  facility_id         uuid NOT NULL REFERENCES facilities(id),
  case_no             text NOT NULL,
  patient_id          uuid NOT NULL REFERENCES patients(id),
  encounter_id        uuid NOT NULL REFERENCES encounters(id),
  admission_id        uuid REFERENCES admissions(id),
  theatre_id          uuid NOT NULL REFERENCES operating_theatres(id),
  procedure_name      text NOT NULL CHECK (length(procedure_name) >= 3),
  procedure_code      text,
  laterality          text NOT NULL DEFAULT 'none' CHECK (laterality IN ('none','left','right','bilateral')),
  priority            text NOT NULL DEFAULT 'elective' CHECK (priority IN ('elective','urgent','emergency')),
  status              text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled','prepared','in_progress','recovery','completed','cancelled')),
  anesthesia_type     text NOT NULL DEFAULT 'general'
                      CHECK (anesthesia_type IN ('general','regional','local','sedation','none')),
  surgeon_id          uuid NOT NULL REFERENCES users(id),
  anesthesiologist_id uuid REFERENCES users(id),
  scheduled_at        timestamptz NOT NULL,
  estimated_minutes   integer NOT NULL DEFAULT 60 CHECK (estimated_minutes BETWEEN 15 AND 720),
  started_at          timestamptz,
  closed_at           timestamptz,
  completed_at        timestamptz,
  counts_correct      boolean,
  count_discrepancy   text,
  cancel_reason       text,
  cancelled_by        uuid REFERENCES users(id),
  cancelled_at        timestamptz,
  notes               text,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, case_no),
  UNIQUE (theatre_id, scheduled_at)
);
CREATE INDEX surgical_cases_board_idx ON surgical_cases (facility_id, status, scheduled_at);
CREATE INDEX surgical_cases_patient_idx ON surgical_cases (patient_id, scheduled_at DESC);
CREATE INDEX surgical_cases_encounter_idx ON surgical_cases (encounter_id);

CREATE TABLE surgical_checklists (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  case_id      uuid NOT NULL REFERENCES surgical_cases(id),
  phase        text NOT NULL CHECK (phase IN ('sign_in','time_out','sign_out')),
  items        jsonb NOT NULL,
  completed_by uuid NOT NULL REFERENCES users(id),
  completed_at timestamptz NOT NULL DEFAULT now(),
  notes        text,
  UNIQUE (case_id, phase)
);

CREATE TABLE anesthesia_records (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  case_id        uuid NOT NULL REFERENCES surgical_cases(id),
  phase          text NOT NULL CHECK (phase IN ('induction','maintenance','emergence')),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  heart_rate     integer CHECK (heart_rate BETWEEN 20 AND 250),
  systolic_bp    integer CHECK (systolic_bp BETWEEN 40 AND 300),
  diastolic_bp   integer CHECK (diastolic_bp BETWEEN 20 AND 200),
  spo2           integer CHECK (spo2 BETWEEN 50 AND 100),
  etco2          integer CHECK (etco2 BETWEEN 10 AND 100),
  temperature_c  numeric(4,1) CHECK (temperature_c BETWEEN 30 AND 45),
  agent          text,
  agent_dose     text,
  airway         text,
  notes          text,
  recorded_by    uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX anesthesia_records_case_idx ON anesthesia_records (case_id, recorded_at);

CREATE TABLE pacu_records (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  case_id      uuid NOT NULL REFERENCES surgical_cases(id),
  aldrete_score integer NOT NULL CHECK (aldrete_score BETWEEN 0 AND 10),
  pain_score   integer CHECK (pain_score BETWEEN 0 AND 10),
  heart_rate   integer CHECK (heart_rate BETWEEN 20 AND 250),
  systolic_bp  integer CHECK (systolic_bp BETWEEN 40 AND 300),
  diastolic_bp integer CHECK (diastolic_bp BETWEEN 20 AND 200),
  spo2         integer CHECK (spo2 BETWEEN 50 AND 100),
  nausea       boolean NOT NULL DEFAULT false,
  disposition  text NOT NULL CHECK (disposition IN ('ward','icu','day_surgery_discharge')),
  notes        text,
  recorded_by  uuid NOT NULL REFERENCES users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id)
);

-- ---------------------------------------------------------------- guards ----
CREATE OR REPLACE FUNCTION surgical_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'surgical safety records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'surgical safety records are append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER surgical_checklists_guard
  BEFORE UPDATE OR DELETE ON surgical_checklists
  FOR EACH ROW EXECUTE FUNCTION surgical_record_guard();

CREATE TRIGGER anesthesia_records_guard
  BEFORE UPDATE OR DELETE ON anesthesia_records
  FOR EACH ROW EXECUTE FUNCTION surgical_record_guard();

CREATE TRIGGER pacu_records_guard
  BEFORE UPDATE OR DELETE ON pacu_records
  FOR EACH ROW EXECUTE FUNCTION surgical_record_guard();

-- A finished case is closed: only the completion/cancellation facts already
-- written are retained, no clinical or scheduling field may change afterwards.
CREATE OR REPLACE FUNCTION surgical_case_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'surgical cases cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'closed surgical cases are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'in_progress' AND (
       OLD.patient_id <> NEW.patient_id OR OLD.encounter_id <> NEW.encounter_id
    OR OLD.theatre_id <> NEW.theatre_id OR OLD.surgeon_id <> NEW.surgeon_id
    OR OLD.scheduled_at <> NEW.scheduled_at OR OLD.procedure_name <> NEW.procedure_name
  ) THEN
    RAISE EXCEPTION 'the surgical site and team cannot change once the operation started' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER surgical_cases_guard
  BEFORE UPDATE OR DELETE ON surgical_cases
  FOR EACH ROW EXECUTE FUNCTION surgical_case_guard();

-- ------------------------------------------------------------------- RLS ----
ALTER TABLE operating_theatres ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_theatres FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operating_theatres FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE surgical_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE surgical_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surgical_cases FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE surgical_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE surgical_checklists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surgical_checklists FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE anesthesia_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE anesthesia_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON anesthesia_records FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

ALTER TABLE pacu_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pacu_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pacu_records FOR ALL TO hms_app
  USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
  WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')));

GRANT SELECT, INSERT, UPDATE ON surgical_cases TO hms_app;
GRANT SELECT, INSERT ON surgical_checklists TO hms_app;
GRANT SELECT, INSERT ON anesthesia_records TO hms_app;
GRANT SELECT, INSERT ON pacu_records TO hms_app;
GRANT SELECT, INSERT, UPDATE ON operating_theatres TO hms_app;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'surgery', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('013_surgery.sql', 'cdbff9956e1cbe32121d1e9f86ce104d8c5a6bd14f03c4c4a291e45faf3d9eee')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 014_icu.sql (sha256: d91b440462d65fac001e08367cf35a7633c9e449bfe1869e3c71600959b2a1b0)
-- ----------------------------------------------------------------------------
-- Intensive care: ICU stays, hourly observations, mechanical ventilation
-- settings, the daily care bundle and SOFA severity scores.
--
-- The ICU chart is a legal record: observations, ventilator changes and scores
-- are append-only. A stay is closed exactly once and cannot be edited after.

CREATE TABLE icu_stays (
  id                    uuid PRIMARY KEY,
  facility_id           uuid NOT NULL REFERENCES facilities(id),
  stay_no               text NOT NULL,
  admission_id          uuid NOT NULL REFERENCES admissions(id),
  patient_id            uuid NOT NULL REFERENCES patients(id),
  encounter_id          uuid NOT NULL REFERENCES encounters(id),
  bed_id                uuid REFERENCES beds(id),
  intensivist_id        uuid REFERENCES users(id),
  opened_by             uuid NOT NULL REFERENCES users(id),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  discharge_disposition text CHECK (discharge_disposition IN ('ward','transfer','home','deceased','against_advice')),
  closing_note          text,
  admission_note        text,
  closed_by             uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, stay_no)
);
CREATE UNIQUE INDEX icu_one_active_stay_per_admission ON icu_stays (admission_id) WHERE status = 'active';
CREATE UNIQUE INDEX icu_one_active_stay_per_bed ON icu_stays (bed_id) WHERE status = 'active' AND bed_id IS NOT NULL;
CREATE INDEX icu_stays_board_idx ON icu_stays (facility_id, status, opened_at);

CREATE TABLE icu_observations (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  stay_id      uuid NOT NULL REFERENCES icu_stays(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  heart_rate   integer CHECK (heart_rate BETWEEN 20 AND 250),
  systolic_bp  integer CHECK (systolic_bp BETWEEN 40 AND 300),
  diastolic_bp integer CHECK (diastolic_bp BETWEEN 20 AND 200),
  resp_rate    integer CHECK (resp_rate BETWEEN 4 AND 80),
  spo2         integer CHECK (spo2 BETWEEN 50 AND 100),
  temperature_c numeric(4,1) CHECK (temperature_c BETWEEN 30 AND 45),
  gcs          integer CHECK (gcs BETWEEN 3 AND 15),
  rass         integer CHECK (rass BETWEEN -5 AND 1),
  urine_ml     integer CHECK (urine_ml BETWEEN 0 AND 5000),
  glucose      integer CHECK (glucose BETWEEN 20 AND 900),
  pain_score   integer CHECK (pain_score BETWEEN 0 AND 10),
  notes        text,
  recorded_by  uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX icu_observations_stay_idx ON icu_observations (stay_id, recorded_at DESC);

CREATE TABLE icu_ventilator_settings (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  stay_id        uuid NOT NULL REFERENCES icu_stays(id),
  mode           text NOT NULL CHECK (mode IN ('ac','simv','psv','cpap','hfnc','room_air')),
  fio2_pct       integer NOT NULL CHECK (fio2_pct BETWEEN 21 AND 100),
  peep_cmh2o     numeric(4,1) CHECK (peep_cmh2o BETWEEN 0 AND 30),
  tidal_volume_ml integer CHECK (tidal_volume_ml BETWEEN 100 AND 1200),
  set_rate       integer CHECK (set_rate BETWEEN 4 AND 60),
  reason         text,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  recorded_by    uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX icu_vent_stay_idx ON icu_ventilator_settings (stay_id, recorded_at DESC);

-- One daily bundle per stay per calendar day. It may be corrected during the
-- round (audited by the API) but never deleted.
CREATE TABLE icu_daily_goals (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  stay_id        uuid NOT NULL REFERENCES icu_stays(id),
  goal_date      date NOT NULL,
  sedation_target boolean NOT NULL DEFAULT false,
  head_of_bed_elevated boolean NOT NULL DEFAULT false,
  vap_bundle     boolean NOT NULL DEFAULT false,
  dvt_prophylaxis boolean NOT NULL DEFAULT false,
  stress_ulcer_prophylaxis boolean NOT NULL DEFAULT false,
  nutrition_plan boolean NOT NULL DEFAULT false,
  early_mobility boolean NOT NULL DEFAULT false,
  notes          text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz,
  UNIQUE (stay_id, goal_date)
);

CREATE TABLE icu_scores (
  id          uuid PRIMARY KEY,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  stay_id     uuid NOT NULL REFERENCES icu_stays(id),
  kind        text NOT NULL DEFAULT 'sofa' CHECK (kind IN ('sofa')),
  components  jsonb NOT NULL,
  total       integer NOT NULL CHECK (total BETWEEN 0 AND 24),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX icu_scores_stay_idx ON icu_scores (stay_id, recorded_at DESC);

-- ---------------------------------------------------------------- guards ----
CREATE OR REPLACE FUNCTION icu_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ICU chart records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'ICU chart records are append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER icu_observations_guard
  BEFORE UPDATE OR DELETE ON icu_observations
  FOR EACH ROW EXECUTE FUNCTION icu_append_only_guard();

CREATE TRIGGER icu_ventilator_guard
  BEFORE UPDATE OR DELETE ON icu_ventilator_settings
  FOR EACH ROW EXECUTE FUNCTION icu_append_only_guard();

CREATE TRIGGER icu_scores_guard
  BEFORE UPDATE OR DELETE ON icu_scores
  FOR EACH ROW EXECUTE FUNCTION icu_append_only_guard();

CREATE OR REPLACE FUNCTION icu_stay_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ICU stays cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'closed ICU stays are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.admission_id <> NEW.admission_id OR OLD.patient_id <> NEW.patient_id THEN
    RAISE EXCEPTION 'the patient of an ICU stay cannot be changed' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER icu_stays_guard
  BEFORE UPDATE OR DELETE ON icu_stays
  FOR EACH ROW EXECUTE FUNCTION icu_stay_guard();

CREATE OR REPLACE FUNCTION icu_goals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ICU daily goals cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.stay_id <> NEW.stay_id OR OLD.goal_date <> NEW.goal_date THEN
    RAISE EXCEPTION 'the bundle day cannot be moved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER icu_daily_goals_guard
  BEFORE UPDATE OR DELETE ON icu_daily_goals
  FOR EACH ROW EXECUTE FUNCTION icu_goals_guard();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['icu_stays','icu_observations','icu_ventilator_settings','icu_daily_goals','icu_scores'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL TO hms_app
        USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
        WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
    $f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON icu_stays TO hms_app;
GRANT SELECT, INSERT ON icu_observations TO hms_app;
GRANT SELECT, INSERT ON icu_ventilator_settings TO hms_app;
GRANT SELECT, INSERT, UPDATE ON icu_daily_goals TO hms_app;
GRANT SELECT, INSERT ON icu_scores TO hms_app;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'icu_stay', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('014_icu.sql', 'd91b440462d65fac001e08367cf35a7633c9e449bfe1869e3c71600959b2a1b0')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 015_bloodbank.sql (sha256: d1199e2a86390a2e2a5a5105088c4b850d5e93866d771a2bbc653dd4bac4beca)
-- ----------------------------------------------------------------------------
-- Blood bank: donors, screened units, requests, cross-match, issue,
-- transfusion with two-person verification, and reported reactions.
--
-- What is modelled is the traceability chain from a synthetic donation to a
-- patient, with the safety rules a real blood bank enforces:
--  * ABO/Rh compatibility is evaluated server-side against a fixed matrix;
--  * an expired, discarded, reserved or already-used unit cannot be issued;
--  * issue requires a compatible cross-match recorded for that request;
--  * transfusion needs a second checker who is not the person starting it;
--  * cross-matches, transfusions and reactions are append-only records.

CREATE TABLE blood_donors (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  donor_no       text NOT NULL,
  blood_type     text NOT NULL CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  donated_at     timestamptz NOT NULL DEFAULT now(),
  -- Screening outcomes; a positive marker makes the donor ineligible.
  hbv_negative   boolean NOT NULL DEFAULT true,
  hcv_negative   boolean NOT NULL DEFAULT true,
  hiv_negative   boolean NOT NULL DEFAULT true,
  syphilis_negative boolean NOT NULL DEFAULT true,
  hemoglobin     numeric(4,1) CHECK (hemoglobin BETWEEN 5 AND 25),
  is_eligible    boolean NOT NULL DEFAULT true,
  deferral_reason text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, donor_no)
);

CREATE TABLE blood_units (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  unit_no      text NOT NULL,
  donor_id     uuid NOT NULL REFERENCES blood_donors(id),
  component    text NOT NULL CHECK (component IN ('rbc','ffp','platelets','cryo')),
  blood_type   text NOT NULL CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  volume_ml    integer CHECK (volume_ml BETWEEN 50 AND 600),
  collected_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'available'
               CHECK (status IN ('available','reserved','issued','transfused','discarded')),
  reserved_for_patient_id uuid REFERENCES patients(id),
  issued_to_patient_id    uuid REFERENCES patients(id),
  discard_reason text,
  discarded_by   uuid REFERENCES users(id),
  discarded_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, unit_no),
  CHECK (expires_at > collected_at)
);
CREATE INDEX blood_units_stock_idx ON blood_units (facility_id, component, blood_type, status, expires_at);
CREATE INDEX blood_units_patient_idx ON blood_units (issued_to_patient_id, created_at DESC);

CREATE TABLE blood_requests (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  request_no      text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id),
  encounter_id    uuid NOT NULL REFERENCES encounters(id),
  component       text NOT NULL CHECK (component IN ('rbc','ffp','platelets','cryo')),
  units_requested integer NOT NULL CHECK (units_requested BETWEEN 1 AND 20),
  urgency         text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','urgent','emergency')),
  indication      text NOT NULL CHECK (length(indication) >= 5),
  hb_value        numeric(4,1),
  platelets_value integer,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','crossmatched','issued','completed','cancelled')),
  requested_by    uuid NOT NULL REFERENCES users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_reason text,
  cancelled_by    uuid REFERENCES users(id),
  cancelled_at    timestamptz,
  UNIQUE (facility_id, request_no)
);
CREATE INDEX blood_requests_worklist_idx ON blood_requests (facility_id, status, urgency, requested_at);

CREATE TABLE blood_crossmatches (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  request_id    uuid NOT NULL REFERENCES blood_requests(id),
  unit_id       uuid NOT NULL REFERENCES blood_units(id),
  method        text NOT NULL DEFAULT 'gel' CHECK (method IN ('gel','tube','electronic')),
  result        text NOT NULL CHECK (result IN ('compatible','incompatible')),
  note          text,
  performed_by  uuid NOT NULL REFERENCES users(id),
  performed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unit_id)
);
CREATE INDEX blood_crossmatches_request_idx ON blood_crossmatches (request_id, performed_at DESC);

CREATE TABLE blood_transfusions (
  id               uuid PRIMARY KEY,
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  unit_id          uuid NOT NULL REFERENCES blood_units(id),
  request_id       uuid NOT NULL REFERENCES blood_requests(id),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  encounter_id     uuid NOT NULL REFERENCES encounters(id),
  started_by       uuid NOT NULL REFERENCES users(id),
  second_checker_id uuid NOT NULL REFERENCES users(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  pre_vitals       jsonb NOT NULL DEFAULT '{}'::jsonb,
  post_vitals      jsonb,
  volume_transfused_ml integer CHECK (volume_transfused_ml BETWEEN 0 AND 600),
  outcome          text CHECK (outcome IN ('completed','stopped_reaction','stopped_other')),
  notes            text,
  UNIQUE (unit_id)
);
CREATE INDEX blood_transfusions_patient_idx ON blood_transfusions (patient_id, started_at DESC);

CREATE TABLE blood_reactions (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  transfusion_id  uuid NOT NULL REFERENCES blood_transfusions(id),
  reaction_type   text NOT NULL
                  CHECK (reaction_type IN ('febrile','allergic','hemolytic','trali','taco','septic','other')),
  severity        text NOT NULL CHECK (severity IN ('mild','moderate','severe','life_threatening')),
  description     text NOT NULL CHECK (length(description) >= 10),
  action_taken    text NOT NULL CHECK (length(action_taken) >= 5),
  reported_by     uuid NOT NULL REFERENCES users(id),
  reported_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz
);

-- ---------------------------------------------------------------- guards ----
CREATE OR REPLACE FUNCTION blood_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'blood bank records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'blood bank records are append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER blood_crossmatches_guard
  BEFORE UPDATE OR DELETE ON blood_crossmatches
  FOR EACH ROW EXECUTE FUNCTION blood_append_only_guard();

-- A transfusion row is created when the unit is started; only the completion
-- facts (end time, outcome, post vitals, volume) may be filled in afterwards.
CREATE OR REPLACE FUNCTION blood_transfusion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfusion records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed transfusions are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.unit_id <> NEW.unit_id OR OLD.patient_id <> NEW.patient_id
     OR OLD.request_id <> NEW.request_id OR OLD.started_by <> NEW.started_by
     OR OLD.second_checker_id <> NEW.second_checker_id OR OLD.started_at <> NEW.started_at THEN
    RAISE EXCEPTION 'transfusion identity and start facts cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER blood_transfusions_guard
  BEFORE UPDATE OR DELETE ON blood_transfusions
  FOR EACH ROW EXECUTE FUNCTION blood_transfusion_guard();

-- The reaction review is the only post-hoc edit allowed on a reaction.
CREATE OR REPLACE FUNCTION blood_reaction_review_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'blood bank records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.reviewed_at IS NULL AND NEW.reviewed_at IS NOT NULL
     AND (to_jsonb(OLD) - 'reviewed_by' - 'reviewed_at') = (to_jsonb(NEW) - 'reviewed_by' - 'reviewed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'blood bank records are append-only' USING ERRCODE = '42501';
END $$;

DROP TRIGGER IF EXISTS blood_reactions_guard ON blood_reactions;
CREATE TRIGGER blood_reactions_guard
  BEFORE UPDATE OR DELETE ON blood_reactions
  FOR EACH ROW EXECUTE FUNCTION blood_reaction_review_guard();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['blood_donors','blood_units','blood_requests','blood_crossmatches','blood_transfusions','blood_reactions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL TO hms_app
        USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
        WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
    $f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON blood_donors TO hms_app;
GRANT SELECT, INSERT, UPDATE ON blood_units TO hms_app;
GRANT SELECT, INSERT, UPDATE ON blood_requests TO hms_app;
GRANT SELECT, INSERT ON blood_crossmatches TO hms_app;
GRANT SELECT, INSERT, UPDATE ON blood_transfusions TO hms_app;
GRANT SELECT, INSERT, UPDATE ON blood_reactions TO hms_app;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'blood_request', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('015_bloodbank.sql', 'd1199e2a86390a2e2a5a5105088c4b850d5e93866d771a2bbc653dd4bac4beca')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 016_nutrition.sql (sha256: 13fe9ba26fcde5a5fed6729e76435a49ebe91174be84d4d96f639cf31c9e1c34)
-- ----------------------------------------------------------------------------
-- Clinical nutrition: screening, dietitian assessment, diet orders, tray
-- production/delivery, intake monitoring, enteral/parenteral feeding and
-- dietitian follow-up.
--
-- Safety model:
--  * nursing screens; the dietitian assesses, sets targets and orders the diet
--    (separation of duties between screening and prescribing);
--  * a diet order must be checked against the patient's recorded allergies;
--  * screenings, assessments and follow-ups are append-only (clinical record);
--  * trays move forward only (ordered → prepared → delivered → consumed/refused)
--    and intake can only be recorded after delivery;
--  * one active diet order and one active feed per route per admission.

CREATE TABLE nutrition_screenings (
  id               uuid PRIMARY KEY,
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  admission_id     uuid NOT NULL REFERENCES admissions(id),
  encounter_id     uuid NOT NULL REFERENCES encounters(id),
  screening_date   date NOT NULL DEFAULT current_date,
  weight_kg        numeric(5,1) NOT NULL CHECK (weight_kg BETWEEN 20 AND 400),
  height_cm        numeric(5,1) NOT NULL CHECK (height_cm BETWEEN 80 AND 250),
  bmi              numeric(4,1) NOT NULL CHECK (bmi BETWEEN 8 AND 80),
  weight_loss_pct  numeric(4,1) NOT NULL DEFAULT 0 CHECK (weight_loss_pct BETWEEN 0 AND 50),
  intake_reduction text NOT NULL CHECK (intake_reduction IN ('none','mild','moderate','severe')),
  disease_severity text NOT NULL CHECK (disease_severity IN ('none','mild','moderate','severe')),
  age_years        integer NOT NULL CHECK (age_years BETWEEN 0 AND 120),
  score            integer NOT NULL CHECK (score BETWEEN 0 AND 12),
  risk_level       text NOT NULL CHECK (risk_level IN ('low','medium','high')),
  action_taken     text,
  notes            text,
  recorded_by      uuid NOT NULL REFERENCES users(id),
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nutrition_screenings_patient_idx ON nutrition_screenings (patient_id, recorded_at DESC);
CREATE INDEX nutrition_screenings_admission_idx ON nutrition_screenings (admission_id, recorded_at DESC);

CREATE TABLE nutrition_assessments (
  id                     uuid PRIMARY KEY,
  facility_id            uuid NOT NULL REFERENCES facilities(id),
  patient_id             uuid NOT NULL REFERENCES patients(id),
  admission_id           uuid NOT NULL REFERENCES admissions(id),
  screening_id           uuid REFERENCES nutrition_screenings(id),
  weight_kg              numeric(5,1) NOT NULL CHECK (weight_kg BETWEEN 20 AND 400),
  height_cm              numeric(5,1) NOT NULL CHECK (height_cm BETWEEN 80 AND 250),
  bmi                    numeric(4,1) NOT NULL CHECK (bmi BETWEEN 8 AND 80),
  ideal_weight_kg        numeric(5,1) NOT NULL CHECK (ideal_weight_kg BETWEEN 20 AND 150),
  energy_target_kcal     integer NOT NULL CHECK (energy_target_kcal BETWEEN 600 AND 5000),
  protein_target_g       numeric(5,1) NOT NULL CHECK (protein_target_g BETWEEN 20 AND 300),
  fluid_limit_ml         integer CHECK (fluid_limit_ml BETWEEN 500 AND 6000),
  recommended_energy_kcal integer NOT NULL,
  recommended_protein_g  numeric(5,1) NOT NULL,
  variance_reason        text,
  nutrition_diagnosis    text NOT NULL CHECK (length(nutrition_diagnosis) >= 5),
  plan                   text NOT NULL CHECK (length(plan) >= 10),
  assessed_by            uuid NOT NULL REFERENCES users(id),
  assessed_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nutrition_assessments_admission_idx ON nutrition_assessments (admission_id, assessed_at DESC);

CREATE TABLE nutrition_diet_orders (
  id                 uuid PRIMARY KEY,
  facility_id        uuid NOT NULL REFERENCES facilities(id),
  patient_id         uuid NOT NULL REFERENCES patients(id),
  admission_id       uuid NOT NULL REFERENCES admissions(id),
  encounter_id       uuid NOT NULL REFERENCES encounters(id),
  order_no           text NOT NULL,
  assessment_id      uuid NOT NULL REFERENCES nutrition_assessments(id),
  diet_type          text NOT NULL CHECK (diet_type IN ('regular','diabetic','renal','low_sodium','soft','liquid','npo','enteral','parenteral')),
  texture            text CHECK (texture IN ('normal','soft','minced','pureed','liquid')),
  restrictions       text[] NOT NULL DEFAULT '{}'::text[],
  energy_target_kcal integer CHECK (energy_target_kcal BETWEEN 600 AND 5000),
  protein_target_g   numeric(5,1) CHECK (protein_target_g BETWEEN 20 AND 300),
  fluid_limit_ml     integer CHECK (fluid_limit_ml BETWEEN 500 AND 6000),
  allergen_snapshot  jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued')),
  ordered_by         uuid NOT NULL REFERENCES users(id),
  started_at         timestamptz NOT NULL DEFAULT now(),
  discontinued_at    timestamptz,
  discontinued_by    uuid REFERENCES users(id),
  discontinue_reason text,
  notes              text,
  UNIQUE (facility_id, order_no)
);
CREATE UNIQUE INDEX nutrition_one_active_diet ON nutrition_diet_orders (admission_id) WHERE status = 'active';
CREATE INDEX nutrition_diet_orders_admission_idx ON nutrition_diet_orders (admission_id, started_at DESC);

CREATE TABLE nutrition_trays (
  id                  uuid PRIMARY KEY,
  facility_id         uuid NOT NULL REFERENCES facilities(id),
  diet_order_id       uuid NOT NULL REFERENCES nutrition_diet_orders(id),
  patient_id          uuid NOT NULL REFERENCES patients(id),
  admission_id        uuid NOT NULL REFERENCES admissions(id),
  tray_no             text NOT NULL,
  tray_date           date NOT NULL,
  meal                text NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snack')),
  status              text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','prepared','delivered','consumed','refused','cancelled')),
  kcal_planned        integer NOT NULL CHECK (kcal_planned BETWEEN 0 AND 3000),
  protein_planned_g   numeric(5,1) NOT NULL CHECK (protein_planned_g >= 0),
  prepared_by         uuid REFERENCES users(id),
  prepared_at         timestamptz,
  delivered_by        uuid REFERENCES users(id),
  delivered_at        timestamptz,
  intake_pct          integer CHECK (intake_pct BETWEEN 0 AND 100),
  kcal_consumed       integer CHECK (kcal_consumed BETWEEN 0 AND 3000),
  protein_consumed_g  numeric(5,1) CHECK (protein_consumed_g >= 0),
  intake_recorded_by  uuid REFERENCES users(id),
  intake_recorded_at  timestamptz,
  notes               text,
  UNIQUE (diet_order_id, tray_date, meal),
  UNIQUE (facility_id, tray_no)
);
CREATE INDEX nutrition_trays_day_idx ON nutrition_trays (facility_id, tray_date, status);

CREATE TABLE nutrition_tube_orders (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  patient_id     uuid NOT NULL REFERENCES patients(id),
  admission_id   uuid NOT NULL REFERENCES admissions(id),
  encounter_id   uuid NOT NULL REFERENCES encounters(id),
  order_no       text NOT NULL,
  route          text NOT NULL CHECK (route IN ('ng','og','peg','pej','tpn','ppn')),
  formula_name   text NOT NULL CHECK (length(formula_name) >= 2),
  kcal_per_ml    numeric(4,2) NOT NULL CHECK (kcal_per_ml BETWEEN 0.3 AND 3),
  protein_g_per_l numeric(5,1) NOT NULL CHECK (protein_g_per_l BETWEEN 0 AND 150),
  rate_ml_hr     numeric(4,1) NOT NULL CHECK (rate_ml_hr BETWEEN 1 AND 300),
  hours_per_day  integer NOT NULL CHECK (hours_per_day BETWEEN 1 AND 24),
  volume_ml_day  integer NOT NULL CHECK (volume_ml_day BETWEEN 1 AND 7200),
  kcal_day       integer NOT NULL CHECK (kcal_day BETWEEN 1 AND 6000),
  protein_g_day  numeric(6,1) NOT NULL CHECK (protein_g_day >= 0),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','stopped','completed')),
  ordered_by     uuid NOT NULL REFERENCES users(id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  stopped_at     timestamptz,
  stopped_by     uuid REFERENCES users(id),
  stop_reason    text,
  notes          text,
  UNIQUE (facility_id, order_no)
);
CREATE UNIQUE INDEX nutrition_one_active_tube_per_route ON nutrition_tube_orders (admission_id, route) WHERE status = 'active';
CREATE INDEX nutrition_tube_admission_idx ON nutrition_tube_orders (admission_id, started_at DESC);

CREATE TABLE nutrition_followups (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  patient_id      uuid NOT NULL REFERENCES patients(id),
  admission_id    uuid NOT NULL REFERENCES admissions(id),
  weight_kg       numeric(5,1) CHECK (weight_kg BETWEEN 20 AND 400),
  intake_pct_avg  integer CHECK (intake_pct_avg BETWEEN 0 AND 100),
  tolerance       text NOT NULL CHECK (tolerance IN ('good','partial','poor')),
  note            text NOT NULL CHECK (length(note) >= 10),
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nutrition_followups_admission_idx ON nutrition_followups (admission_id, recorded_at DESC);

-- ---------------------------------------------------------------- guards ----
CREATE OR REPLACE FUNCTION nutrition_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'nutrition records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  RAISE EXCEPTION 'nutrition records are append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER nutrition_screenings_guard
  BEFORE UPDATE OR DELETE ON nutrition_screenings
  FOR EACH ROW EXECUTE FUNCTION nutrition_append_only_guard();

CREATE TRIGGER nutrition_assessments_guard
  BEFORE UPDATE OR DELETE ON nutrition_assessments
  FOR EACH ROW EXECUTE FUNCTION nutrition_append_only_guard();

CREATE TRIGGER nutrition_followups_guard
  BEFORE UPDATE OR DELETE ON nutrition_followups
  FOR EACH ROW EXECUTE FUNCTION nutrition_append_only_guard();

-- A diet order is started once and can only be discontinued; the prescription
-- itself (targets, restrictions, diet type) is never rewritten in place.
CREATE OR REPLACE FUNCTION nutrition_diet_order_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'diet orders cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'discontinued' THEN
    RAISE EXCEPTION 'discontinued diet orders are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'discontinued'
     OR NEW.patient_id <> OLD.patient_id OR NEW.admission_id <> OLD.admission_id
     OR NEW.diet_type <> OLD.diet_type OR NEW.restrictions <> OLD.restrictions
     OR NEW.energy_target_kcal IS DISTINCT FROM OLD.energy_target_kcal
     OR NEW.protein_target_g IS DISTINCT FROM OLD.protein_target_g
     OR NEW.assessment_id <> OLD.assessment_id THEN
    RAISE EXCEPTION 'only discontinuation is allowed on a diet order' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nutrition_diet_orders_guard
  BEFORE UPDATE OR DELETE ON nutrition_diet_orders
  FOR EACH ROW EXECUTE FUNCTION nutrition_diet_order_guard();

-- Trays advance through the kitchen workflow only; intake is final.
CREATE OR REPLACE FUNCTION nutrition_tray_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'trays cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('consumed','refused','cancelled') THEN
    RAISE EXCEPTION 'a closed tray cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF OLD.diet_order_id <> NEW.diet_order_id OR OLD.meal <> NEW.meal
     OR OLD.tray_date <> NEW.tray_date OR OLD.kcal_planned <> NEW.kcal_planned THEN
    RAISE EXCEPTION 'tray identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  allowed := (
    (OLD.status = 'ordered' AND NEW.status IN ('ordered','prepared','cancelled')) OR
    (OLD.status = 'prepared' AND NEW.status IN ('prepared','delivered','cancelled')) OR
    (OLD.status = 'delivered' AND NEW.status IN ('delivered','consumed','refused'))
  );
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid tray status transition from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nutrition_trays_guard
  BEFORE UPDATE OR DELETE ON nutrition_trays
  FOR EACH ROW EXECUTE FUNCTION nutrition_tray_guard();

-- A feed order is fixed when created; only stopping/completing it is allowed.
CREATE OR REPLACE FUNCTION nutrition_tube_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'feeding orders cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'closed feeding orders are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('stopped','completed') OR NEW.stop_reason IS NULL THEN
    RAISE EXCEPTION 'a feeding order can only be stopped with a reason' USING ERRCODE = '42501';
  END IF;
  IF NEW.rate_ml_hr <> OLD.rate_ml_hr OR NEW.formula_name <> OLD.formula_name
     OR NEW.kcal_per_ml <> OLD.kcal_per_ml OR NEW.route <> OLD.route THEN
    RAISE EXCEPTION 'feeding prescription cannot be changed, stop and re-order' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nutrition_tube_orders_guard
  BEFORE UPDATE OR DELETE ON nutrition_tube_orders
  FOR EACH ROW EXECUTE FUNCTION nutrition_tube_guard();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['nutrition_screenings','nutrition_assessments','nutrition_diet_orders',
                           'nutrition_trays','nutrition_tube_orders','nutrition_followups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL TO hms_app
        USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
        WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
    $f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON nutrition_screenings TO hms_app;
GRANT SELECT, INSERT ON nutrition_assessments TO hms_app;
GRANT SELECT, INSERT, UPDATE ON nutrition_diet_orders TO hms_app;
GRANT SELECT, INSERT, UPDATE ON nutrition_trays TO hms_app;
GRANT SELECT, INSERT, UPDATE ON nutrition_tube_orders TO hms_app;
GRANT SELECT, INSERT ON nutrition_followups TO hms_app;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'nutrition_order', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'nutrition_tray', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('016_nutrition.sql', '13fe9ba26fcde5a5fed6729e76435a49ebe91174be84d4d96f639cf31c9e1c34')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 017_cssd.sql (sha256: 72140776e3b52fe5c495a40a41a8e87ee30353b689f7cf4ea4660d905e57f503)
-- ----------------------------------------------------------------------------
-- CSSD (central sterile services) and infection prevention & control.
--
-- Sterile-pack lifecycle:
--   dirty → washing → packed → sterilizing (inside a load) → released
--   released → issued → used → returned → dirty (next reprocessing cycle)
--   any live pack → quarantined (failed load) → recalled (traceability action)
--
-- Safety model:
--  * a pack can only join a load while packed, and only one load at a time;
--  * the operator of a sterilization load may not approve it (separation);
--  * packs are released only from an approved load with a passed biological
--    indicator, and never after expiry (checked in the API as well);
--  * a failed load quarantines its packs; a recall marks every pack of the load
--    and keeps the affected case linkage for follow-up;
--  * loads become immutable once their result is recorded and approved;
--  * isolation orders are append-only except for the documented end;
--  * infection cases may only move suspected → confirmed/excluded;
--  * hand-hygiene observations are append-only (audit evidence).

CREATE TABLE cssd_instrument_sets (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  code           text NOT NULL,
  name_ar        text NOT NULL,
  category       text NOT NULL CHECK (category IN ('minor','laparotomy','orthopedic','dressing','endoscopy','other')),
  instrument_count integer NOT NULL CHECK (instrument_count BETWEEN 1 AND 500),
  department     text,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);

CREATE TABLE cssd_sterilization_loads (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  load_no        text NOT NULL,
  autoclave_code text NOT NULL,
  method         text NOT NULL CHECK (method IN ('steam','plasma','eto')),
  cycle_no       integer NOT NULL CHECK (cycle_no > 0),
  temperature_c  numeric(4,1) CHECK (temperature_c BETWEEN 100 AND 200),
  pressure_bar   numeric(4,2) CHECK (pressure_bar BETWEEN -1 AND 5),
  duration_min   integer CHECK (duration_min BETWEEN 1 AND 600),
  pack_count     integer NOT NULL CHECK (pack_count > 0),
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed','approved')),
  chemical_indicator  text CHECK (chemical_indicator IN ('pass','fail')),
  biological_indicator text CHECK (biological_indicator IN ('pending','pass','fail')),
  result_notes   text,
  operator_id    uuid NOT NULL REFERENCES users(id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  resulted_at    timestamptz,
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  recalled_at    timestamptz,
  recalled_by    uuid REFERENCES users(id),
  recall_reason  text,
  UNIQUE (facility_id, load_no),
  UNIQUE (autoclave_code, cycle_no),
  CHECK (approved_by IS NULL OR approved_by <> operator_id)
);
CREATE INDEX cssd_loads_board_idx ON cssd_sterilization_loads (facility_id, started_at DESC);

CREATE TABLE cssd_packs (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  pack_no        text NOT NULL,
  set_id         uuid NOT NULL REFERENCES cssd_instrument_sets(id),
  load_id        uuid REFERENCES cssd_sterilization_loads(id),
  status         text NOT NULL DEFAULT 'dirty'
                 CHECK (status IN ('dirty','washing','packed','sterilizing','released','issued','used','returned','quarantined','recalled')),
  packaging      text NOT NULL DEFAULT 'wrap' CHECK (packaging IN ('wrap','container')),
  cycle_count    integer NOT NULL DEFAULT 1 CHECK (cycle_count BETWEEN 1 AND 500),
  washed_by      uuid REFERENCES users(id),
  washed_at      timestamptz,
  packed_by      uuid REFERENCES users(id),
  packed_at      timestamptz,
  released_at    timestamptz,
  expires_at     timestamptz,
  issued_to      text,
  issued_to_case_id uuid REFERENCES surgical_cases(id),
  issued_by      uuid REFERENCES users(id),
  issued_at      timestamptz,
  used_at        timestamptz,
  returned_at    timestamptz,
  recall_reason  text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, pack_no)
);
CREATE UNIQUE INDEX cssd_pack_open_cycle ON cssd_packs (facility_id, set_id)
  WHERE status IN ('dirty','washing','packed','sterilizing','released','issued','used');
CREATE INDEX cssd_packs_status_idx ON cssd_packs (facility_id, status, expires_at);

CREATE TABLE infection_isolations (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  patient_id     uuid NOT NULL REFERENCES patients(id),
  admission_id   uuid REFERENCES admissions(id),
  precaution     text NOT NULL CHECK (precaution IN ('contact','droplet','airborne','protective')),
  organism       text,
  reason         text NOT NULL CHECK (length(reason) >= 5),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ordered_by     uuid NOT NULL REFERENCES users(id),
  ended_at       timestamptz,
  ended_by       uuid REFERENCES users(id),
  end_reason     text
);
CREATE UNIQUE INDEX infection_one_active_precaution ON infection_isolations (patient_id)
  WHERE ended_at IS NULL;
CREATE INDEX infection_isolations_active_idx ON infection_isolations (facility_id, started_at DESC);

CREATE TABLE infection_cases (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  patient_id     uuid NOT NULL REFERENCES patients(id),
  admission_id   uuid REFERENCES admissions(id),
  case_type      text NOT NULL CHECK (case_type IN ('cauti','clabsi','vap','ssi','cdi','mrsa','other')),
  organism       text,
  onset_date     date NOT NULL,
  device_days    integer CHECK (device_days BETWEEN 0 AND 365),
  status         text NOT NULL DEFAULT 'suspected' CHECK (status IN ('suspected','confirmed','excluded')),
  reported_by    uuid NOT NULL REFERENCES users(id),
  reported_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  review_note    text,
  notes          text
);
CREATE INDEX infection_cases_board_idx ON infection_cases (facility_id, status, onset_date DESC);

CREATE TABLE hand_hygiene_audits (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  unit          text NOT NULL,
  moment        text NOT NULL CHECK (moment IN ('before_patient','before_aseptic','after_body_fluid','after_patient','after_surroundings')),
  opportunities integer NOT NULL CHECK (opportunities BETWEEN 1 AND 100),
  compliant     integer NOT NULL CHECK (compliant BETWEEN 0 AND 100),
  observed_role text NOT NULL CHECK (observed_role IN ('physician','nurse','tech','other')),
  observed_date date NOT NULL DEFAULT current_date,
  observer_id   uuid NOT NULL REFERENCES users(id),
  observed_at   timestamptz NOT NULL DEFAULT now(),
  notes         text,
  CHECK (compliant <= opportunities)
);
CREATE INDEX hand_hygiene_unit_idx ON hand_hygiene_audits (facility_id, observed_date DESC, unit);

-- ---------------------------------------------------------------- guards ----
CREATE OR REPLACE FUNCTION cssd_pack_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sterile packs cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('recalled') THEN
    RAISE EXCEPTION 'recalled packs are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.set_id <> NEW.set_id OR OLD.pack_no <> NEW.pack_no THEN
    RAISE EXCEPTION 'pack identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.cycle_count <> OLD.cycle_count AND NOT (OLD.status = 'returned' AND NEW.status = 'dirty' AND NEW.cycle_count = OLD.cycle_count + 1) THEN
    RAISE EXCEPTION 'cycle count only increments when a returned pack re-enters reprocessing' USING ERRCODE = '42501';
  END IF;
  allowed := (
    (OLD.status = 'dirty' AND NEW.status IN ('dirty','washing','quarantined')) OR
    (OLD.status = 'washing' AND NEW.status IN ('washing','packed','quarantined')) OR
    (OLD.status = 'packed' AND NEW.status IN ('packed','sterilizing','quarantined')) OR
    (OLD.status = 'sterilizing' AND NEW.status IN ('sterilizing','released','quarantined','recalled')) OR
    (OLD.status = 'released' AND NEW.status IN ('released','issued','quarantined','recalled')) OR
    (OLD.status = 'issued' AND NEW.status IN ('issued','used','recalled')) OR
    (OLD.status = 'used' AND NEW.status IN ('used','returned','recalled')) OR
    (OLD.status = 'returned' AND NEW.status IN ('returned','dirty','recalled')) OR
    (OLD.status = 'quarantined' AND NEW.status IN ('quarantined','recalled','dirty'))
  );
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid pack transition from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cssd_packs_guard
  BEFORE UPDATE OR DELETE ON cssd_packs
  FOR EACH ROW EXECUTE FUNCTION cssd_pack_guard();

-- A load is fixed while running; only the result, approval and recall fields may
-- be filled afterwards, and an approved load is frozen.
CREATE OR REPLACE FUNCTION cssd_load_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sterilization loads cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'approved' THEN
    -- Only the recall annotations may be filled after approval. Comparing the
    -- whole row (minus those three columns) also protects a recalled load from
    -- having its indicators rewritten after the fact.
    IF (to_jsonb(NEW) - 'recalled_at' - 'recalled_by' - 'recall_reason')
       IS DISTINCT FROM (to_jsonb(OLD) - 'recalled_at' - 'recalled_by' - 'recall_reason') THEN
      RAISE EXCEPTION 'approved loads are immutable apart from recall' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD.status IN ('passed','failed') AND NEW.status = 'running' THEN
    RAISE EXCEPTION 'a resulted load cannot restart' USING ERRCODE = '42501';
  END IF;
  IF NEW.pack_count <> OLD.pack_count OR NEW.autoclave_code <> OLD.autoclave_code
     OR NEW.cycle_no <> OLD.cycle_no OR NEW.operator_id <> OLD.operator_id THEN
    RAISE EXCEPTION 'load identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.approved_by IS NOT NULL AND NEW.approved_by = OLD.operator_id THEN
    RAISE EXCEPTION 'the load operator cannot approve the load' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cssd_loads_guard
  BEFORE UPDATE OR DELETE ON cssd_sterilization_loads
  FOR EACH ROW EXECUTE FUNCTION cssd_load_guard();

CREATE OR REPLACE FUNCTION infection_isolation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'isolation orders cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a closed isolation order is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.precaution <> OLD.precaution
     OR NEW.started_at <> OLD.started_at OR NEW.ordered_by <> OLD.ordered_by THEN
    RAISE EXCEPTION 'isolation identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.ended_at IS NULL OR NEW.end_reason IS NULL THEN
    RAISE EXCEPTION 'an isolation order can only be closed with a reason' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER infection_isolations_guard
  BEFORE UPDATE OR DELETE ON infection_isolations
  FOR EACH ROW EXECUTE FUNCTION infection_isolation_guard();

CREATE OR REPLACE FUNCTION infection_case_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'infection cases cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'suspected' THEN
    RAISE EXCEPTION 'a reviewed infection case is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('confirmed','excluded') OR NEW.reviewed_by IS NULL THEN
    RAISE EXCEPTION 'an infection case can only be confirmed or excluded with a reviewer' USING ERRCODE = '42501';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.case_type <> OLD.case_type OR NEW.onset_date <> OLD.onset_date THEN
    RAISE EXCEPTION 'infection case identity cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER infection_cases_guard
  BEFORE UPDATE OR DELETE ON infection_cases
  FOR EACH ROW EXECUTE FUNCTION infection_case_guard();

CREATE OR REPLACE FUNCTION hand_hygiene_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hand hygiene observations are append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER hand_hygiene_audits_guard
  BEFORE UPDATE OR DELETE ON hand_hygiene_audits
  FOR EACH ROW EXECUTE FUNCTION hand_hygiene_guard();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cssd_instrument_sets','cssd_sterilization_loads','cssd_packs',
                           'infection_isolations','infection_cases','hand_hygiene_audits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL TO hms_app
        USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
        WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
    $f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON cssd_instrument_sets TO hms_app;
GRANT SELECT, INSERT, UPDATE ON cssd_packs TO hms_app;
GRANT SELECT, INSERT, UPDATE ON cssd_sterilization_loads TO hms_app;
GRANT SELECT, INSERT, UPDATE ON infection_isolations TO hms_app;
GRANT SELECT, INSERT, UPDATE ON infection_cases TO hms_app;
GRANT SELECT, INSERT ON hand_hygiene_audits TO hms_app;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'cssd_pack', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, 'cssd_load', 10 FROM facilities
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('017_cssd.sql', '72140776e3b52fe5c495a40a41a8e87ee30353b689f7cf4ea4660d905e57f503')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 018_hr.sql (sha256: 0caff3c4f8f88f9eb843373bc0cf9b3c8ad11d061a05f7b38996c68dccac6953)
-- ----------------------------------------------------------------------------
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

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('018_hr.sql', '0caff3c4f8f88f9eb843373bc0cf9b3c8ad11d061a05f7b38996c68dccac6953')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

-- ----------------------------------------------------------------------------
-- Migration: 019_supabase_hardening.sql (sha256: e1ca43696f30d8cb1886d61eae00f0d308cbdd49575e5d4753985cda24e8d02e)
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 019_supabase_hardening.sql | Supabase / Managed PostgreSQL Role & PostgREST Hardening
-- 1. Ensures the migration connection user (e.g. `postgres` on Supabase) holds
--    membership in `hms_app` and `hms_portal` so transaction-scoped
--    `SET LOCAL ROLE hms_app` / `SET LOCAL ROLE hms_portal` always succeeds on
--    PostgreSQL 16/17 non-superuser setups.
-- 2. Locks down Supabase PostgREST `anon` and `authenticated` roles so public
--    `anon` JWT keys cannot query HMS tables, sequences, or functions directly.
-- ============================================================================

DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT hms_app TO %I', current_user);
    EXECUTE format('GRANT hms_portal TO %I', current_user);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    BEGIN
      GRANT hms_app TO postgres;
      GRANT hms_portal TO postgres;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  -- Lock down Supabase PostgREST roles (`anon`, `authenticated`) while keeping
  -- `USAGE ON SCHEMA public` intact so Supabase's `/rest/v1/` health probe passes.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM authenticated;
  END IF;
END $$;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('019_supabase_hardening.sql', 'e1ca43696f30d8cb1886d61eae00f0d308cbdd49575e5d4753985cda24e8d02e')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;

COMMIT;

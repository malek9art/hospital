-- ============================================================================
-- HMS Enterprise — Complete 1-Click Supabase SQL Editor Bootstrap
-- Project : https://pxawcoccgcuzoustyugh.supabase.co
-- Pooler  : aws-0-ap-northeast-2.pooler.supabase.com:5432 (user: postgres.pxawcoccgcuzoustyugh)
-- Includes: All 20 migrations (98 tables + RLS + PostgREST anon lockdown)
--           + 2 facilities, 30 departments (15 per facility), 28 roles, 110 permissions,
--           + ALL 33 demo login accounts (Argon2id), wards/beds, lab tests, drugs, CSSD & Stores.
--
-- Paste into: https://supabase.com/dashboard/project/pxawcoccgcuzoustyugh/sql/new -> Run
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

-- ----------------------------------------------------------------------------
-- Migration: 020_stores_dental_physio.sql (sha256: 667effc70ef6225e1ecaf2513d84e08536922ba5ecedc401e81518574fb9ab86)
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 020_stores_dental_physio.sql
-- Medical Stores & Warehouses (المخازن), Dental Clinic (عيادة الأسنان),
-- Physical Therapy & Rehabilitation (العلاج الطبيعي), and Department/Radiology
-- expansions.
--
-- Safety & Governance invariants:
--  * Tenant-isolated via Row-Level Security (FORCE ROW LEVEL SECURITY) on facility_id.
--  * Separation of duties on warehouse stock requisitions (issued_by <> requested_by).
--  * Append-only inventory_movements & dental_chart_entries (medical/financial ledger).
--  * Completed/cancelled requisitions, dental procedures, physio referrals, and
--    physio sessions are immutable; no record may be deleted.
-- ============================================================================

-- Expand department types to cover stores, dental, physiotherapy, blood bank, cssd, nutrition
ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_dept_type_check;
ALTER TABLE departments ADD CONSTRAINT departments_dept_type_check
  CHECK (dept_type IN (
    'outpatient','emergency','inpatient','icu','lab','radiology','pharmacy',
    'administration','surgery','anesthesia','stores','dental','physiotherapy',
    'bloodbank','cssd','nutrition','other'
  ));

-- Expand imaging modalities to support Dental Panoramic (OPG) radiographs
ALTER TABLE imaging_orders DROP CONSTRAINT IF EXISTS imaging_orders_modality_check;
ALTER TABLE imaging_orders ADD CONSTRAINT imaging_orders_modality_check
  CHECK (modality IN ('xray','ct','mri','us','mammography','fluoroscopy','panoramic'));

-- ============================================================================
-- 1. Medical Stores & Warehouses (المخازن والإمداد الطبي)
-- ============================================================================

CREATE TABLE inventory_warehouses (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  code           text NOT NULL,
  name_ar        text NOT NULL,
  name_en        text,
  warehouse_type text NOT NULL CHECK (warehouse_type IN (
    'main','medical_supplies','surgical','dental','lab','rehab','general'
  )),
  department_id  uuid REFERENCES departments(id),
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);

CREATE TABLE inventory_items (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  sku           text NOT NULL,
  name_ar       text NOT NULL,
  name_en       text,
  category      text NOT NULL CHECK (category IN (
    'consumables','ppe','surgical_supplies','lab_reagents',
    'dental_supplies','physio_supplies','radiology_supplies','general'
  )),
  unit          text NOT NULL DEFAULT 'قطعة',
  reorder_level numeric(12,2) NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  unit_cost     numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, sku)
);
CREATE INDEX inventory_items_facility_cat_idx ON inventory_items (facility_id, category);

CREATE TABLE inventory_stock (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  warehouse_id uuid NOT NULL REFERENCES inventory_warehouses(id),
  item_id      uuid NOT NULL REFERENCES inventory_items(id),
  batch_no     text NOT NULL,
  expiry_date  date,
  qty_on_hand  numeric(12,2) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  unit_cost    numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  received_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, item_id, batch_no)
);
CREATE INDEX inventory_stock_fefo_idx ON inventory_stock (facility_id, warehouse_id, item_id, expiry_date);

CREATE TABLE inventory_requisitions (
  id            uuid PRIMARY KEY,
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  req_no        text NOT NULL,
  warehouse_id  uuid NOT NULL REFERENCES inventory_warehouses(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  item_id       uuid NOT NULL REFERENCES inventory_items(id),
  qty_requested numeric(12,2) NOT NULL CHECK (qty_requested > 0),
  qty_issued    numeric(12,2) NOT NULL DEFAULT 0 CHECK (qty_issued >= 0),
  priority      text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','issued','rejected','cancelled')),
  notes         text,
  requested_by  uuid NOT NULL REFERENCES users(id),
  issued_by     uuid REFERENCES users(id),
  issued_at     timestamptz,
  reject_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, req_no),
  CHECK (issued_by IS NULL OR issued_by <> requested_by),
  CHECK (status <> 'rejected' OR (reject_reason IS NOT NULL AND length(reject_reason) >= 5))
);
CREATE INDEX inventory_requisitions_board_idx ON inventory_requisitions (facility_id, status, created_at DESC);

CREATE TABLE inventory_movements (
  id             uuid PRIMARY KEY,
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  warehouse_id   uuid NOT NULL REFERENCES inventory_warehouses(id),
  item_id        uuid NOT NULL REFERENCES inventory_items(id),
  stock_id       uuid REFERENCES inventory_stock(id),
  movement_type  text NOT NULL CHECK (movement_type IN ('receipt','issue','adjustment','transfer_in','transfer_out')),
  quantity       numeric(12,2) NOT NULL CHECK (quantity <> 0),
  reference_type text,
  reference_id   text,
  reason         text,
  performed_by   uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_facility_idx ON inventory_movements (facility_id, created_at DESC);

CREATE OR REPLACE FUNCTION inventory_movements_append_only_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory movements ledger is append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION inventory_movements_append_only_fn();

CREATE OR REPLACE FUNCTION inventory_requisitions_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory requisitions cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'processed inventory requisitions are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.issued_by IS NOT NULL AND NEW.issued_by = OLD.requested_by THEN
    RAISE EXCEPTION 'requester cannot self-issue warehouse requisition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inventory_requisitions_guard
  BEFORE UPDATE OR DELETE ON inventory_requisitions
  FOR EACH ROW EXECUTE FUNCTION inventory_requisitions_guard_fn();

-- ============================================================================
-- 2. Dental Clinic & FDI Odontogram (عيادة الأسنان والفم)
-- ============================================================================

CREATE TABLE dental_chart_entries (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  patient_id   uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  tooth_number integer NOT NULL CHECK (tooth_number IN (
    11,12,13,14,15,16,17,18,
    21,22,23,24,25,26,27,28,
    31,32,33,34,35,36,37,38,
    41,42,43,44,45,46,47,48,
    51,52,53,54,55,
    61,62,63,64,65,
    71,72,73,74,75,
    81,82,83,84,85
  )),
  surface      text NOT NULL DEFAULT 'whole' CHECK (surface IN (
    'whole','occlusal','mesial','distal','buccal','lingual','incisal'
  )),
  condition    text NOT NULL CHECK (condition IN (
    'healthy','caries','filled','crown','root_canal','missing','extracted','implant','fracture','periodontal'
  )),
  notes        text,
  recorded_by  uuid NOT NULL REFERENCES users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dental_chart_patient_idx ON dental_chart_entries (patient_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION dental_chart_append_only_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dental odontogram entries are append-only medical records' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER dental_chart_append_only
  BEFORE UPDATE OR DELETE ON dental_chart_entries
  FOR EACH ROW EXECUTE FUNCTION dental_chart_append_only_fn();

CREATE TABLE dental_procedures (
  id              uuid PRIMARY KEY,
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  procedure_no    text NOT NULL,
  patient_id      uuid NOT NULL REFERENCES patients(id),
  encounter_id    uuid NOT NULL REFERENCES encounters(id),
  tooth_number    integer CHECK (tooth_number IS NULL OR tooth_number IN (
    11,12,13,14,15,16,17,18,
    21,22,23,24,25,26,27,28,
    31,32,33,34,35,36,37,38,
    41,42,43,44,45,46,47,48,
    51,52,53,54,55,
    61,62,63,64,65,
    71,72,73,74,75,
    81,82,83,84,85
  )),
  procedure_code  text NOT NULL,
  category        text NOT NULL CHECK (category IN (
    'exam','restorative','endodontic','extraction','periodontic',
    'prosthodontic','orthodontic','preventive','oral_surgery'
  )),
  description     text NOT NULL CHECK (length(description) >= 3),
  anesthesia_used text,
  status          text NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','in_progress','completed','cancelled')),
  fee             numeric(12,2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  dentist_id      uuid NOT NULL REFERENCES users(id),
  performed_at    timestamptz,
  clinical_notes  text,
  cancel_reason   text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, procedure_no),
  CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND length(cancel_reason) >= 5))
);
CREATE INDEX dental_procedures_board_idx ON dental_procedures (facility_id, status, created_at DESC);
CREATE INDEX dental_procedures_patient_idx ON dental_procedures (patient_id, created_at DESC);

CREATE OR REPLACE FUNCTION dental_procedures_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dental procedures cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'completed or cancelled dental procedures are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.patient_id <> OLD.patient_id OR NEW.encounter_id <> OLD.encounter_id THEN
    RAISE EXCEPTION 'dental procedure patient/encounter cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER dental_procedures_guard
  BEFORE UPDATE OR DELETE ON dental_procedures
  FOR EACH ROW EXECUTE FUNCTION dental_procedures_guard_fn();

-- ============================================================================
-- 3. Physical Therapy & Rehabilitation (العلاج الطبيعي والتأهيل الطبي)
-- ============================================================================

CREATE TABLE physio_referrals (
  id                      uuid PRIMARY KEY,
  facility_id             uuid NOT NULL REFERENCES facilities(id),
  referral_no             text NOT NULL,
  patient_id              uuid NOT NULL REFERENCES patients(id),
  encounter_id            uuid NOT NULL REFERENCES encounters(id),
  admission_id            uuid REFERENCES admissions(id),
  diagnosis_summary       text NOT NULL CHECK (length(diagnosis_summary) >= 5),
  body_region             text NOT NULL,
  modality_plan           text NOT NULL CHECK (modality_plan IN (
    'therapeutic_exercise','manual_therapy','electrotherapy','ultrasound_therapy',
    'hydrotherapy','gait_training','neuro_rehab','post_op_rehab','chest_physio'
  )),
  precautions             text,
  total_sessions          integer NOT NULL DEFAULT 6 CHECK (total_sessions BETWEEN 1 AND 60),
  completed_sessions      integer NOT NULL DEFAULT 0 CHECK (completed_sessions >= 0),
  priority                text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
  status                  text NOT NULL DEFAULT 'referred'
                          CHECK (status IN ('referred','active','completed','cancelled')),
  referred_by             uuid NOT NULL REFERENCES users(id),
  assigned_therapist_id   uuid REFERENCES users(id),
  initial_assessment      text,
  rehab_goals             text,
  baseline_pain_score     integer CHECK (baseline_pain_score IS NULL OR baseline_pain_score BETWEEN 0 AND 10),
  baseline_mobility_score integer CHECK (baseline_mobility_score IS NULL OR baseline_mobility_score BETWEEN 1 AND 10),
  assessed_at             timestamptz,
  closed_at               timestamptz,
  cancel_reason           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, referral_no),
  CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND length(cancel_reason) >= 5))
);
CREATE INDEX physio_referrals_board_idx ON physio_referrals (facility_id, status, created_at DESC);
CREATE INDEX physio_referrals_patient_idx ON physio_referrals (patient_id, created_at DESC);

CREATE TABLE physio_sessions (
  id                   uuid PRIMARY KEY,
  facility_id          uuid NOT NULL REFERENCES facilities(id),
  session_no           text NOT NULL,
  referral_id          uuid NOT NULL REFERENCES physio_referrals(id),
  patient_id           uuid NOT NULL REFERENCES patients(id),
  session_number       integer NOT NULL CHECK (session_number >= 1),
  scheduled_at         timestamptz NOT NULL DEFAULT now(),
  duration_minutes     integer NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 15 AND 180),
  modalities_performed text[] NOT NULL DEFAULT '{}',
  pain_before          integer CHECK (pain_before IS NULL OR pain_before BETWEEN 0 AND 10),
  pain_after           integer CHECK (pain_after IS NULL OR pain_after BETWEEN 0 AND 10),
  rom_notes            text,
  patient_tolerance    text CHECK (patient_tolerance IS NULL OR patient_tolerance IN ('excellent','good','fair','poor')),
  progress_notes       text,
  status               text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','completed','no_show','cancelled')),
  fee                  numeric(12,2) NOT NULL DEFAULT 180 CHECK (fee >= 0),
  therapist_id         uuid NOT NULL REFERENCES users(id),
  performed_at         timestamptz,
  cancel_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, session_no),
  CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND length(cancel_reason) >= 5))
);
CREATE INDEX physio_sessions_board_idx ON physio_sessions (facility_id, status, scheduled_at DESC);
CREATE INDEX physio_sessions_referral_idx ON physio_sessions (referral_id, session_number);

CREATE OR REPLACE FUNCTION physio_referrals_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'physiotherapy referrals cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'closed physiotherapy referrals are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER physio_referrals_guard
  BEFORE UPDATE OR DELETE ON physio_referrals
  FOR EACH ROW EXECUTE FUNCTION physio_referrals_guard_fn();

CREATE OR REPLACE FUNCTION physio_sessions_guard_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'physiotherapy sessions cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'completed or cancelled physiotherapy sessions are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER physio_sessions_guard
  BEFORE UPDATE OR DELETE ON physio_sessions
  FOR EACH ROW EXECUTE FUNCTION physio_sessions_guard_fn();

-- ============================================================================
-- 4. Row-Level Security, Role Grants & PostgREST Lockdown
-- ============================================================================

DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY[
    'inventory_warehouses',
    'inventory_items',
    'inventory_stock',
    'inventory_requisitions',
    'inventory_movements',
    'dental_chart_entries',
    'dental_procedures',
    'physio_referrals',
    'physio_sessions'
  ];
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL TO hms_app
        USING (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
        WITH CHECK (facility_id::text = ANY (string_to_array(coalesce(nullif(current_setting('app.facility_ids', true), ''), '-'), ',')))
    $f$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hms_app', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM authenticated;
  END IF;
END $$;

INSERT INTO number_sequences (facility_id, name, next_value)
SELECT id, seq_name, 10
  FROM facilities
 CROSS JOIN (VALUES ('inv_req'), ('dental_proc'), ('physio_ref'), ('physio_sess')) AS s(seq_name)
ON CONFLICT (facility_id, name) DO NOTHING;

INSERT INTO public.schema_migrations (filename, checksum)
VALUES ('020_stores_dental_physio.sql', '667effc70ef6225e1ecaf2513d84e08536922ba5ecedc401e81518574fb9ab86')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum;


-- ============================================================================
-- Operational & Authentication Seed (33 Demo Accounts + Reference Catalog)
-- ============================================================================

-- Table: facilities (2 rows)
INSERT INTO public.facilities (id, code, name_ar, name_en, timezone, currency, locale, is_active, created_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'OBR', 'المستشفى السعودي الميداني - العبر', 'Saudi Field Hospital - Obar', 'Asia/Riyadh', 'SAR', 'ar-SA', true, '2026-11-13T22:16:09.034Z') ON CONFLICT DO NOTHING;
INSERT INTO public.facilities (id, code, name_ar, name_en, timezone, currency, locale, is_active, created_at) VALUES ('827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'JED', 'فرع جدة', 'Jeddah Branch', 'Asia/Riyadh', 'SAR', 'ar-SA', true, '2026-11-13T22:16:09.035Z') ON CONFLICT DO NOTHING;

-- Table: departments (30 rows)
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('146e591e-3576-4888-b548-183b7632f10b', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'GEN', 'الطب العام', 'General Medicine', 'outpatient', true, '2026-11-13T22:16:09.036Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('18e76ac3-0c70-43c2-a24a-a3d86fd1c4d0', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'GEN', 'الطب العام', 'General Medicine', 'outpatient', true, '2026-11-13T22:16:09.039Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('1ee5d6e2-5834-4948-9de7-2707b1861154', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'ER', 'الطوارئ', 'Emergency', 'emergency', true, '2026-11-13T22:16:09.040Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('01fd7648-15a9-4f13-b388-99e267a3e768', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'ER', 'الطوارئ', 'Emergency', 'emergency', true, '2026-11-13T22:16:09.040Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('42880db0-7b02-4474-84e0-05ad76f4d2c7', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'LAB', 'المختبرات الطبية', 'Medical Laboratories', 'lab', true, '2026-11-13T22:16:09.041Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('620042e4-c116-4e9a-b1c6-571d149d7cab', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'LAB', 'المختبرات الطبية', 'Medical Laboratories', 'lab', true, '2026-11-13T22:16:09.041Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('77b7fc2b-5283-4fef-8b19-2b32cc00039e', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'PHR', 'الصيدلية', 'Pharmacy', 'pharmacy', true, '2026-11-13T22:16:09.042Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('eaa25e5a-5a8a-4290-856b-d1c7ede18033', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'PHR', 'الصيدلية', 'Pharmacy', 'pharmacy', true, '2026-11-13T22:16:09.043Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('0f1b3335-94c3-40b1-8555-a0cd433a00b5', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'ADM', 'الإدارة', 'Administration', 'administration', true, '2026-11-13T22:16:09.043Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('578d63fb-7f0e-4a4e-a5ad-2ac0940cb357', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'ADM', 'الإدارة', 'Administration', 'administration', true, '2026-11-13T22:16:09.044Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('fad18ad1-e9ab-49cf-8761-2498bcfd84a8', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'INP', 'التنويم', 'Inpatient', 'inpatient', true, '2026-11-13T22:16:09.044Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('86fe5588-b29d-42b9-b96b-db17821ab65d', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'INP', 'التنويم', 'Inpatient', 'inpatient', true, '2026-11-13T22:16:09.045Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('6f1bb862-9549-4359-860b-99375b5098fc', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'RAD', 'الأشعة والتصوير الطبي', 'Radiology & Medical Imaging', 'radiology', true, '2026-11-13T22:16:09.045Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('556facbb-3dca-421a-b5d5-030553e2a154', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'RAD', 'الأشعة والتصوير الطبي', 'Radiology & Medical Imaging', 'radiology', true, '2026-11-13T22:16:09.046Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('b0c453f6-4ec8-45ff-b3c5-8d196b295818', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'OR', 'العمليات والتخدير', 'Operating Theatres', 'surgery', true, '2026-11-13T22:16:09.046Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('721aa522-4ba4-461e-8b1e-bb4384e9e0a0', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'OR', 'العمليات والتخدير', 'Operating Theatres', 'surgery', true, '2026-11-13T22:16:09.047Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('24554214-4af9-4ac3-8473-370258d81c2b', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'STR', 'المخازن والإمداد الطبي', 'Medical Stores & Warehouses', 'stores', true, '2026-11-13T22:16:09.048Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('d3099055-6391-4479-93e2-ae31ed0bdbd2', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'STR', 'المخازن والإمداد الطبي', 'Medical Stores & Warehouses', 'stores', true, '2026-11-13T22:16:09.048Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('bcdff471-b704-4102-838c-e87d85160e15', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'DNT', 'عيادة الأسنان والفم', 'Dental & Oral Clinic', 'dental', true, '2026-11-13T22:16:09.049Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('347f87d5-3be6-478a-afef-808a611fcf58', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'DNT', 'عيادة الأسنان والفم', 'Dental & Oral Clinic', 'dental', true, '2026-11-13T22:16:09.049Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('ce2e69a2-8077-45d5-ab08-ee41211388cc', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'BBK', 'بنك الدم وطب نقل الدم', 'Blood Bank & Transfusion', 'bloodbank', true, '2026-11-13T22:16:09.050Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('fd30e1bd-38a6-4aa8-b807-1a9d753b7b16', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'BBK', 'بنك الدم وطب نقل الدم', 'Blood Bank & Transfusion', 'bloodbank', true, '2026-11-13T22:16:09.050Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('4f781551-abe9-45ac-aa2c-5b98e012d81c', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'PT', 'العلاج الطبيعي والتأهيل الطبي', 'Physical Therapy & Rehabilitation', 'physiotherapy', true, '2026-11-13T22:16:09.051Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('d24f6c92-70ac-4ddc-a920-e873d5fa6319', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'PT', 'العلاج الطبيعي والتأهيل الطبي', 'Physical Therapy & Rehabilitation', 'physiotherapy', true, '2026-11-13T22:16:09.052Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('83d05cb7-f214-4784-9c45-7c2bec139fb3', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'ICU', 'العناية المركزة', 'Intensive Care Unit', 'icu', true, '2026-11-13T22:16:09.053Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('612cc5d3-93f2-4120-91cf-672fc9cefeac', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'ICU', 'العناية المركزة', 'Intensive Care Unit', 'icu', true, '2026-11-13T22:16:09.054Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('aa2e3834-1cf5-478b-a755-21cdba4f1a8d', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS', 'التعقيم المركزي', 'Central Sterile Supply (CSSD)', 'cssd', true, '2026-11-13T22:16:09.054Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('224641b6-72c6-4d86-87dc-e3cc90e114f9', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'CSS', 'التعقيم المركزي', 'Central Sterile Supply (CSSD)', 'cssd', true, '2026-11-13T22:16:09.055Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('adb84318-da2e-4790-ab20-6e6265a3ab1b', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'NUT', 'التغذية العلاجية', 'Clinical Nutrition', 'nutrition', true, '2026-11-13T22:16:09.056Z') ON CONFLICT DO NOTHING;
INSERT INTO public.departments (id, facility_id, code, name_ar, name_en, dept_type, is_active, created_at) VALUES ('8c035504-d9b5-4844-b22f-e6e8b1a141fb', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'NUT', 'التغذية العلاجية', 'Clinical Nutrition', 'nutrition', true, '2026-11-13T22:16:09.056Z') ON CONFLICT DO NOTHING;

-- Table: operating_theatres (2 rows)
INSERT INTO public.operating_theatres (id, facility_id, dept_id, code, name_ar, name_en, is_active, created_at) VALUES ('ea61dc51-eab9-4aad-bafe-b5c58b358e7d', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b0c453f6-4ec8-45ff-b3c5-8d196b295818', 'OR-1', 'غرفة عمليات ١', 'Theatre 1', true, '2026-11-13T22:16:09.057Z') ON CONFLICT DO NOTHING;
INSERT INTO public.operating_theatres (id, facility_id, dept_id, code, name_ar, name_en, is_active, created_at) VALUES ('89c67372-a593-4b4e-bcdd-ee4213d08551', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b0c453f6-4ec8-45ff-b3c5-8d196b295818', 'OR-2', 'غرفة عمليات ٢', 'Theatre 2', true, '2026-11-13T22:16:09.059Z') ON CONFLICT DO NOTHING;

-- Table: roles (28 rows)
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('system_admin', 'مدير النظام', 'System administrator', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('hospital_director', 'الإدارة التنفيذية', 'Executive management', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('hr_manager', 'مدير الموارد البشرية', 'Human resources manager', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('storekeeper', 'أمين المخازن والإمداد', 'Medical storekeeper', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('dentist', 'طبيب أسنان', 'Dentist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('physiotherapist', 'أخصائي علاج طبيعي', 'Physiotherapist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('department_manager', 'مدير قسم', 'Department manager', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('physician', 'طبيب', 'Physician', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('nurse', 'تمريض', 'Nurse', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('surgeon', 'جراح', 'Surgeon', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('anesthesiologist', 'طبيب تخدير', 'Anesthesiologist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('or_nurse', 'تمريض عمليات', 'Operating-room nurse', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('intensivist', 'طبيب عناية مركزة', 'Intensivist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('icu_nurse', 'تمريض عناية مركزة', 'ICU nurse', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('blood_bank_tech', 'فني بنك دم', 'Blood bank technologist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('dietitian', 'أخصائي تغذية', 'Clinical dietitian', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('kitchen_staff', 'موظف تغذية', 'Nutrition services', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('cssd_tech', 'فني تعقيم', 'CSSD technician', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('infection_control', 'مكافحة العدوى', 'Infection prevention & control', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('receptionist', 'استقبال', 'Receptionist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('records_officer', 'السجلات الطبية', 'Medical records', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('lab_tech', 'فني مختبر', 'Lab technician', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('radiology_tech', 'فني أشعة', 'Radiology technologist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('radiologist', 'استشاري أشعة', 'Radiologist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('pharmacist', 'صيدلي', 'Pharmacist', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('accountant', 'محاسب', 'Accountant', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('auditor', 'مدقق', 'Auditor', NULL, true) ON CONFLICT DO NOTHING;
INSERT INTO public.roles (id, name_ar, name_en, description, is_system) VALUES ('patient', 'مريض', 'Patient', NULL, true) ON CONFLICT DO NOTHING;

-- Table: permissions (110 rows)
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('patient.read', 'patients', 'عرض قائمة المرضى') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('patient.create', 'patients', 'تسجيل مرضى') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('patient.update', 'patients', 'تعديل بيانات مريض') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('patient.chart.clinical', 'patients', 'الاطلاع على السجل السريري') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('patient.chart.administrative', 'patients', 'الاطلاع على البيانات الإدارية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('patient.merge', 'patients', 'دمج ملفات المرضى') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('patient.break_glass', 'patients', 'الوصول الطارئ') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('appointment.read', 'appointments', 'عرض المواعيد') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('appointment.create', 'appointments', 'حجز مواعيد') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('appointment.update', 'appointments', 'تعديل/إلغاء مواعيد') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('appointment.checkin', 'appointments', 'تسجيل حضور') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('clinical.encounter.read', 'clinical', 'عرض الزيارات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('clinical.encounter.create', 'clinical', 'فتح/إغلاق زيارة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('clinical.note.write', 'clinical', 'كتابة ملاحظات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('clinical.diagnose', 'clinical', 'تسجيل تشخيص') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('clinical.vitals.write', 'clinical', 'تسجيل علامات حيوية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('clinical.order.create', 'clinical', 'طلب تحاليل') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('clinical.prescription.create', 'clinical', 'وصف أدوية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('lab.sample.collect', 'lab', 'جمع العينات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('lab.result.enter', 'lab', 'إدخال النتائج') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('lab.result.verify', 'lab', 'اعتماد النتائج') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('lab.result.amend', 'lab', 'تصحيح النتائج') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('lab.critical.ack', 'lab', 'معالجة القيم الحرجة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('pharmacy.prescription.read', 'pharmacy', 'عرض الوصفات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('pharmacy.dispense', 'pharmacy', 'صرف الأدوية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('pharmacy.stock.manage', 'pharmacy', 'إدارة المخزون') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('billing.invoice.read', 'billing', 'عرض الفواتير') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('billing.invoice.create', 'billing', 'إنشاء فواتير') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('billing.payment.record', 'billing', 'تحصيل مدفوعات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('billing.invoice.void', 'billing', 'إلغاء فواتير') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('billing.discount.apply', 'billing', 'تطبيق خصومات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('insurance.claim.manage', 'insurance', 'إدارة المطالبات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inpatient.admit', 'inpatient', 'تنويم المرضى') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inpatient.discharge', 'inpatient', 'خروج المرضى') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inpatient.bed.manage', 'inpatient', 'إدارة الأسرة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('emergency.triage', 'emergency', 'فرز وتشغيل الطوارئ') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('radiology.order', 'radiology', 'طلب أشعة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('radiology.read', 'radiology', 'عرض طلبات وتقارير الأشعة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('radiology.perform', 'radiology', 'تنفيذ التصوير') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('radiology.report', 'radiology', 'كتابة تقرير الأشعة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('radiology.verify', 'radiology', 'اعتماد تقرير الأشعة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('radiology.critical.ack', 'radiology', 'استلام النتائج الحرجة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nursing.read', 'nursing', 'عرض لوحة التمريض') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nursing.mar.administer', 'nursing', 'تسجيل إعطاء الأدوية وإتمام مهام الرعاية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nursing.careplan.manage', 'nursing', 'إنشاء وإغلاق خطط الرعاية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nursing.handover.write', 'nursing', 'كتابة تسليم المناوبة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nursing.witness', 'nursing', 'الشهادة على إعطاء الأدوية عالية الخطورة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('surgery.read', 'surgery', 'عرض جدول العمليات والملف الجراحي') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('surgery.schedule', 'surgery', 'جدولة العمليات وإلغاؤها') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('surgery.perform', 'surgery', 'بدء العملية وإغلاقها وتوقيع المسار الجراحي') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('surgery.checklist', 'surgery', 'إتمام قوائم التحقق الجراحية وتسجيل الإفاقة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('anesthesia.perform', 'anesthesia', 'تسجيل قوائم ما قبل التخدير وقياسات التخدير') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('icu.read', 'icu', 'عرض لوحة العناية المركزة والملف') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('icu.chart', 'icu', 'تسجيل علامات حيوية وSOFA وحزمة الرعاية اليومية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('icu.ventilator', 'icu', 'إدارة إعدادات التنفس الصناعي') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('icu.manage', 'icu', 'فتح إقامة عناية مركزة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('icu.discharge', 'icu', 'إغلاق إقامة العناية المركزة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('bloodbank.read', 'bloodbank', 'عرض مخزون الدم والطلبات وتتبع الوحدات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('bloodbank.request', 'bloodbank', 'طلب وحدات دم للمريض') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('bloodbank.crossmatch', 'bloodbank', 'إجراء فحص التوافق وحجز الوحدات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('bloodbank.issue', 'bloodbank', 'صرف وحدات الدم للجناح') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('bloodbank.transfuse', 'bloodbank', 'بدء النقل والتحقق الثاني وإغلاقه') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('bloodbank.reaction', 'bloodbank', 'الإبلاغ عن تفاعلات نقل الدم') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('bloodbank.stock', 'bloodbank', 'تسجيل المتبرعين والوحدات واستبعادها') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nutrition.read', 'nutrition', 'عرض لوحة التغذية وملف المريض الغذائي') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nutrition.screen', 'nutrition', 'إجراء فحص خطر التغذية (تمريض)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nutrition.assess', 'nutrition', 'تقييم التغذية والمتابعة (أخصائي تغذية)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nutrition.order', 'nutrition', 'إصدار أمر التغذية وتوليد وجبات اليوم') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nutrition.kitchen', 'nutrition', 'تحضير وتسليم صواني الوجبات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nutrition.intake', 'nutrition', 'تسجيل ما تناوله المريض') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('nutrition.tube', 'nutrition', 'أوامر التغذية الأنبوبية والوريدية وإيقافها') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('cssd.read', 'cssd', 'عرض لوحة التعقيم والأطقم والحزم') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('cssd.manage', 'cssd', 'تعريف الأطقم واستلام الحزم الملوّثة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('cssd.reprocess', 'cssd', 'الغسل والتغليف وتجهيز دورات التعقيم') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('cssd.sterilize', 'cssd', 'تسجيل نتيجة دورة التعقيم والمؤشرات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('cssd.release', 'cssd', 'اعتماد الدورة والإفراج عن الحزم (شخص مختلف عن المنفذ)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('cssd.issue', 'cssd', 'صرف الحزم المعقمة وربطها بالعمليات وسحبها') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('infection.read', 'infection', 'عرض لوحة مكافحة العدوى وأوامر العزل') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('infection.isolate', 'infection', 'إصدار أوامر العزل وإنهاؤها') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('infection.surveillance', 'infection', 'تسجيل حالات الاشتباه بالعدوى المرتبطة بالرعاية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('infection.confirm', 'infection', 'مراجعة واعتماد أو استبعاد حالات العدوى (شخص مختلف عن المسجل)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('infection.audit', 'infection', 'تدقيق نظافة الأيدي') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('hr.read', 'hr', 'عرض سجل الموارد البشرية والتراخيص والمناوبات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('hr.manage', 'hr', 'إضافة وتحديث ملفات الموظفين وتغيير حالتهم') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('hr.credentials.verify', 'hr', 'توثيق واعتماد وسحب التراخيص المهنية (فصل مهام)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('hr.roster.manage', 'hr', 'جدولة المناوبات ومتابعة الحضور') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('hr.leave.approve', 'hr', 'مراجعة واعتماد أو رفض طلبات الإجازات (فصل مهام)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('hr.self', 'hr', 'بوابة الموظف الذاتية للمناوبات والإجازات والتراخيص') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inventory.read', 'inventory', 'عرض المخازن الطبية والأصناف والأرصدة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inventory.manage', 'inventory', 'إدارة المستودعات وكتالوج الأصناف والتسويات الجردية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inventory.stock', 'inventory', 'توريد واستلام دفعات المستلزمات الطبية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inventory.request', 'inventory', 'طلب صرف مستلزمات مخزنية للقسم') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('inventory.issue', 'inventory', 'اعتماد وصرف طلبات الأقسام من المخازن (فصل مهام)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('dental.read', 'dental', 'عرض عيادة الأسنان ومخطط الأسنان (FDI)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('dental.chart', 'dental', 'تسجيل حالة الأسنان على المخطط السني (Odontogram)') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('dental.perform', 'dental', 'إجراء وإتمام المعالجات السنية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('physio.read', 'physio', 'عرض لوحة العلاج الطبيعي والخطط التأهيلية') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('physio.refer', 'physio', 'تحويل المرضى للعلاج الطبيعي والتأهيل') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('physio.perform', 'physio', 'تقييم المرضى وتنفيذ جلسات العلاج الطبيعي') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('admin.users.read', 'admin', 'عرض المستخدمين') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('admin.users.manage', 'admin', 'إدارة المستخدمين') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('admin.roles.manage', 'admin', 'إدارة الأدوار') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('admin.facility.manage', 'admin', 'إدارة المنشآت') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('admin.sessions.manage', 'admin', 'إدارة الجلسات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('admin.settings.manage', 'admin', 'إدارة الإعدادات') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('audit.read', 'audit', 'الاطلاع على سجل التدقيق') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('report.read', 'reports', 'عرض التقارير') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('report.export', 'reports', 'تصدير التقارير') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('report.finance', 'reports', 'تقارير مالية على مستوى المنشأة') ON CONFLICT DO NOTHING;
INSERT INTO public.permissions (code, module, desc_ar) VALUES ('portal.self', 'portal', 'بوابة المريض') ON CONFLICT DO NOTHING;

-- Table: role_permissions (405 rows)
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'admin.users.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'admin.users.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'admin.roles.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'admin.facility.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'admin.sessions.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'admin.settings.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'audit.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('system_admin', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'report.export') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'report.finance') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'audit.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'admin.sessions.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'admin.users.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'hr.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'hr.credentials.verify') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'hr.leave.approve') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'dental.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hospital_director', 'bloodbank.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hr_manager', 'hr.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hr_manager', 'hr.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hr_manager', 'hr.credentials.verify') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hr_manager', 'hr.roster.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hr_manager', 'hr.leave.approve') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hr_manager', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('hr_manager', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('storekeeper', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('storekeeper', 'inventory.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('storekeeper', 'inventory.stock') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('storekeeper', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('storekeeper', 'inventory.issue') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('storekeeper', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('storekeeper', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'appointment.update') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'clinical.encounter.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'clinical.diagnose') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'clinical.order.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'clinical.prescription.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'radiology.order') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'dental.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'dental.chart') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'dental.perform') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dentist', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'physio.perform') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physiotherapist', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'clinical.encounter.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'clinical.diagnose') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'clinical.order.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'clinical.prescription.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'inpatient.admit') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'inpatient.discharge') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'surgery.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'surgery.schedule') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'surgery.perform') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'radiology.order') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'cssd.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'cssd.issue') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'physio.refer') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('surgeon', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'clinical.order.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'surgery.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'surgery.checklist') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'anesthesia.perform') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'cssd.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('anesthesiologist', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'surgery.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'surgery.checklist') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'cssd.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'cssd.issue') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('or_nurse', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'clinical.encounter.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'clinical.diagnose') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'clinical.order.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'clinical.prescription.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'inpatient.admit') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'inpatient.discharge') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'inpatient.bed.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'icu.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'icu.chart') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'icu.ventilator') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'icu.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'icu.discharge') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'radiology.order') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'surgery.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'bloodbank.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'bloodbank.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'bloodbank.reaction') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'nutrition.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'nutrition.intake') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'physio.refer') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('intensivist', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'pharmacy.prescription.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'icu.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'icu.chart') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'icu.ventilator') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'nursing.mar.administer') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'nursing.witness') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'bloodbank.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'bloodbank.transfuse') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'bloodbank.reaction') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'nutrition.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'nutrition.intake') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'infection.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'cssd.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('icu_nurse', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'nutrition.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'nutrition.assess') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'nutrition.order') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'nutrition.tube') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('dietitian', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('kitchen_staff', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('kitchen_staff', 'patient.chart.administrative') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('kitchen_staff', 'nutrition.kitchen') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('kitchen_staff', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'patient.chart.administrative') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'cssd.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'cssd.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'cssd.reprocess') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'cssd.sterilize') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'cssd.release') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'cssd.issue') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('cssd_tech', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'infection.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'infection.isolate') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'infection.surveillance') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'infection.confirm') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'infection.audit') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'cssd.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'report.export') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('infection_control', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'patient.chart.administrative') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'bloodbank.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'bloodbank.crossmatch') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'bloodbank.issue') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'bloodbank.stock') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'bloodbank.reaction') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('blood_bank_tech', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'appointment.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'appointment.update') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'clinical.encounter.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'clinical.diagnose') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'clinical.prescription.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'clinical.order.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'lab.result.verify') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'lab.result.amend') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'radiology.order') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'radiology.critical.ack') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'report.export') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'inpatient.admit') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'inpatient.discharge') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'inpatient.bed.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'nursing.careplan.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'surgery.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'surgery.schedule') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'bloodbank.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'bloodbank.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'bloodbank.reaction') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'dental.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'physio.refer') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'hr.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'hr.roster.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'hr.leave.approve') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('department_manager', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'patient.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'patient.update') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'patient.break_glass') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'appointment.update') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'clinical.encounter.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'clinical.diagnose') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'clinical.order.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'clinical.prescription.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'pharmacy.prescription.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'inpatient.admit') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'inpatient.discharge') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'inpatient.bed.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'emergency.triage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'radiology.order') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'radiology.critical.ack') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'surgery.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'surgery.schedule') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'bloodbank.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'bloodbank.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'dental.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'physio.refer') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('physician', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'appointment.checkin') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'clinical.vitals.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'clinical.note.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'lab.sample.collect') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'pharmacy.prescription.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'inpatient.bed.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'emergency.triage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nursing.mar.administer') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nursing.careplan.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nursing.handover.write') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nursing.witness') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'bloodbank.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'bloodbank.transfuse') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'bloodbank.reaction') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nutrition.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nutrition.screen') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'nutrition.intake') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'cssd.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'infection.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'infection.isolate') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'infection.surveillance') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'infection.audit') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'physio.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('nurse', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'patient.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'patient.chart.administrative') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'appointment.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'appointment.update') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'appointment.checkin') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'billing.payment.record') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('receptionist', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'patient.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'patient.update') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'patient.merge') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'patient.chart.administrative') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'appointment.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'report.export') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('records_officer', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'lab.sample.collect') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'lab.result.enter') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'lab.result.verify') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'lab.result.amend') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'lab.critical.ack') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('lab_tech', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'radiology.perform') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiology_tech', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiologist', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiologist', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiologist', 'clinical.encounter.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiologist', 'radiology.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiologist', 'radiology.report') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiologist', 'radiology.verify') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('radiologist', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'patient.chart.clinical') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'pharmacy.prescription.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'pharmacy.dispense') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'pharmacy.stock.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'inventory.request') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('pharmacist', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'patient.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'patient.chart.administrative') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'billing.invoice.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'billing.invoice.create') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'billing.payment.record') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'billing.invoice.void') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'billing.discount.apply') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'insurance.claim.manage') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'report.export') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'report.finance') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('accountant', 'hr.self') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'audit.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'report.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'report.export') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'report.finance') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'admin.users.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'nursing.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'hr.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('auditor', 'inventory.read') ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_code) VALUES ('patient', 'portal.self') ON CONFLICT DO NOTHING;

-- Table: users (33 rows)
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('51448ee2-3ca8-453a-8219-41a7b1ba33da', 'admin@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$khxiqsknUp62bCQjt0z9OA$ApvDcEdrkGhZCQzndXMQtBqnd+HYoSoD9V0m8iBFKMg', 'مدير النظام', 'System Admin', 'مدير النظام', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.494Z', '2026-11-13T22:16:09.494Z', '2026-11-13T22:16:09.494Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('a45ac955-41f2-4ccc-9bb7-b4d6a73d4a9f', 'director@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$ZOCh3W3Y1QY0JnuaRTAgLA$2i6BTTmxH3FZirQH+yAGuJGXxB6Pu6dDJd1G1R72iQY', 'د. خالد العتيبي', 'Dr. Khalid Alotaibi', 'المدير التنفيذي', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.529Z', '2026-11-13T22:16:09.529Z', '2026-11-13T22:16:09.529Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('0adfcfa9-a60f-4206-bf4e-4b1f61411294', 'hr@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$t22y1NZjI+shEobJtIjo2Q$mGsRwx2QL+aEVK4XfsyVgfe4XCO9+CMn3/4FEn81wPc', 'ماجد المالكي', 'Majed Almalki', 'أخصائي الموارد البشرية', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.531Z', '2026-11-13T22:16:09.531Z', '2026-11-13T22:16:09.531Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('5429e3a8-0ca6-4cb1-9e88-4a0420cd20e5', 'hr2@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$t22y1NZjI+shEobJtIjo2Q$mGsRwx2QL+aEVK4XfsyVgfe4XCO9+CMn3/4FEn81wPc', 'مها الشمراني', 'Maha Alshamrani', 'مشرفة شؤون الممارسين والتراخيص', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.534Z', '2026-11-13T22:16:09.534Z', '2026-11-13T22:16:09.534Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('6ee88313-d715-4dc2-83dc-9b8020d277b1', 'stores@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$Ez3kJNHFW+grM8vNi1jjQw$Pc5om7MRJ0DeF8kGUnwqQro54LxnWTyq/WacAIC/NoA', 'فارس القحطاني', 'Fares Alqahtani', 'أمين المخازن الطبية', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.536Z', '2026-11-13T22:16:09.536Z', '2026-11-13T22:16:09.536Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('57283d40-fa50-4749-ab26-4ff0b379cb24', 'stores2@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$Ez3kJNHFW+grM8vNi1jjQw$Pc5om7MRJ0DeF8kGUnwqQro54LxnWTyq/WacAIC/NoA', 'بندر السبيعي', 'Bandar Alsubaie', 'مشرف الإمداد والتموين الطبي', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.538Z', '2026-11-13T22:16:09.538Z', '2026-11-13T22:16:09.538Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('c2f1ad62-9cf9-4acc-80d8-860fe4ff350c', 'dentist@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$7PVsWWQkEIscy+mWPq9+Gg$vI8RXBxZK2tQDIZajlESHEI2pH7BKnp0pyF+XrZMh9U', 'د. طارق الغامدي', 'Dr. Tariq Alghamdi', 'استشاري طب وجراحة الأسنان', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.540Z', '2026-11-13T22:16:09.540Z', '2026-11-13T22:16:09.540Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('de15cd6f-f1f3-4a29-94f1-0792f43ff04d', 'physio@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$bWBOcGI3aQ4l0kc4Aqzm2Q$uUeK42SaWhwlJ8JqV+exMYVHRqURJeDTUy6wnhBr7YU', 'ريان الشهري', 'Rayan Alshehri', 'أخصائي أول علاج طبيعي وتأهيل', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.541Z', '2026-11-13T22:16:09.541Z', '2026-11-13T22:16:09.541Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('812015e7-0075-402c-a28b-3074dbae5456', 'dr.ahmed@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$SsvYW9vBe7sygzGPyMJy4A$TEsItGia7o6UwHUm0gOlEC2cfnjSbcMWNrQPX7JgQTM', 'د. أحمد الحربي', 'Dr. Ahmed Alharbi', 'استشاري طب باطني', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.542Z', '2026-11-13T22:16:09.542Z', '2026-11-13T22:16:09.542Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('61649ac5-ae60-408b-89e8-9d0a62b7f600', 'dr.sara@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$SsvYW9vBe7sygzGPyMJy4A$TEsItGia7o6UwHUm0gOlEC2cfnjSbcMWNrQPX7JgQTM', 'د. سارة القحطاني', 'Dr. Sara Alqahtani', 'استشارية طوارئ', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.543Z', '2026-11-13T22:16:09.543Z', '2026-11-13T22:16:09.543Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('ba10cda4-3731-4331-946a-d5b1fa8bc2b1', 'nurse@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$Zq2VotiJkgE8WL05GBOUTg$GnKqjYM+37E8oS5FEzzrU9dR3PnYdZ7sRUcx6coKXpI', 'مريم الزهراني', 'Mariam Alzahrani', 'ممرضة أولى', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.545Z', '2026-11-13T22:16:09.545Z', '2026-11-13T22:16:09.545Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('8b6b260e-89c4-4dfe-8878-5dc8d842c74f', 'nurse2@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$Zq2VotiJkgE8WL05GBOUTg$GnKqjYM+37E8oS5FEzzrU9dR3PnYdZ7sRUcx6coKXpI', 'ليلى العمري', 'Layla Alamri', 'ممرضة مناوبة', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.546Z', '2026-11-13T22:16:09.546Z', '2026-11-13T22:16:09.546Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('fa56c1cc-765b-4513-b0c9-91e7de28a6a5', 'surgeon@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$oV9BnciCh8tBDjE7kzbQwQ$Ju0XTSrT224/atA2i2LrExG46t4XOpEq+kPuPUQ7f5o', 'د. عبدالله الغامدي', 'Dr. Abdullah Alghamdi', 'استشاري جراحة عامة', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.547Z', '2026-11-13T22:16:09.547Z', '2026-11-13T22:16:09.547Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('3286eb2b-bd8b-4e54-8288-73725f2e7551', 'anesthesia@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$5JRhnDEfGXs31lCMSPvlJw$ZEIqZ33/kxj2mgMrBYZfUSWVpIrOeRpCvJlNJI6o74g', 'د. هدى المطيري', 'Dr. Huda Almutairi', 'استشارية تخدير', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.549Z', '2026-11-13T22:16:09.549Z', '2026-11-13T22:16:09.549Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('9b107731-91a9-4f59-a8f6-f69aa269c2cb', 'ornurse@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$Zq2VotiJkgE8WL05GBOUTg$GnKqjYM+37E8oS5FEzzrU9dR3PnYdZ7sRUcx6coKXpI', 'سارة الدوسري', 'Sara Aldosari', 'ممرضة غرفة عمليات', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.550Z', '2026-11-13T22:16:09.550Z', '2026-11-13T22:16:09.550Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('4dccd026-a622-4144-af61-544a128e7476', 'intensivist@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$uy3XrW54HWVkrhBfpXNxyw$TPo2fxbZaM3H/WtXSM2sYAt6MNW87DgGQk1CRj4thYc', 'د. فيصل الحربي', 'Dr. Faisal Alharbi', 'استشاري عناية مركزة', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.551Z', '2026-11-13T22:16:09.551Z', '2026-11-13T22:16:09.551Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('5a915839-fbd0-44de-9d73-7bb4db13a8b4', 'icunurse@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$uy3XrW54HWVkrhBfpXNxyw$TPo2fxbZaM3H/WtXSM2sYAt6MNW87DgGQk1CRj4thYc', 'أمل الجهني', 'Amal Aljohani', 'ممرضة عناية مركزة', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.554Z', '2026-11-13T22:16:09.554Z', '2026-11-13T22:16:09.554Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('2295120b-56c8-4ea9-9310-8704d88563a2', 'bloodbank@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$uZAp1bU6YkF3kQfLS2YbLA$2b1SC+YtT5XC0XvnRUv6SywNTXUAiiS3t06UWiqGXT8', 'نورة الحربي', 'Noura Alharbi', 'فنية بنك دم', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.555Z', '2026-11-13T22:16:09.555Z', '2026-11-13T22:16:09.555Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('d9bb83ac-0edc-489a-9416-54fdb607f3d6', 'dietitian@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$YnZnK1Bac1zltlDQpwBfNA$U+BBWgXJU5NlEsJDeiKy3ldDT9s1BN6yRDUmRTpXwqg', 'هيفاء الزهراني', 'Haifa Alzahrani', 'أخصائية تغذية علاجية', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.557Z', '2026-11-13T22:16:09.557Z', '2026-11-13T22:16:09.557Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('2ced6de5-730d-4038-b3e1-1429e7e84344', 'kitchen@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$TMPemITIrDhqeUNhbyTXZA$ZAL/bth7hAHlihsnZPpKW0sRGU+Ku2bRrPqxOj2d510', 'ماجد الشهري', 'Majed Alshehri', 'مسؤول خدمات التغذية', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.559Z', '2026-11-13T22:16:09.559Z', '2026-11-13T22:16:09.559Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('d7649f7b-2b1c-4c16-95a9-805418d0856a', 'cssd@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$5QaKdh1DQS9UW789wQWanA$9Fb/I3PxhGZ3KJS2BVVoRjksg/sjXjKL09nyEQi/ahs', 'عمر باوزير', 'Omar Bawazir', 'فني تعقيم مركزي', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.561Z', '2026-11-13T22:16:09.561Z', '2026-11-13T22:16:09.561Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('b9a4049d-bc59-4f04-b712-b5c829441a29', 'cssd2@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$5QaKdh1DQS9UW789wQWanA$9Fb/I3PxhGZ3KJS2BVVoRjksg/sjXjKL09nyEQi/ahs', 'خديجة عسيري', 'Khadija Asiri', 'مشرفة التعقيم المركزي', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.562Z', '2026-11-13T22:16:09.562Z', '2026-11-13T22:16:09.562Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('07761178-3a94-4ffb-8097-1d676f8c998d', 'infection@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$Nk15mHLL7URPqWz7duQYlw$WNyI3g4v1sM8siL5x4JW/0jBNeIgP1iPoucl7/HuDtI', 'د. رقية الأنصاري', 'Dr. Ruqaya Alansari', 'استشارية مكافحة العدوى', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.563Z', '2026-11-13T22:16:09.563Z', '2026-11-13T22:16:09.563Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('5b596af5-c1bd-4008-9664-bb86d1fea2ee', 'reception@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$knySkVCFUtyOJevGYqpkug$pCQIQNl9nubYWo7/7VCfUetB3mImJ9KBwEvpj0b3dKc', 'عبدالله الشهري', 'Abdullah Alshehri', 'موظف استقبال', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.565Z', '2026-11-13T22:16:09.565Z', '2026-11-13T22:16:09.565Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('b7c8143f-46b6-4223-8ced-75ed50ee5192', 'records@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$G8x3SePoI5ViIjKZ9D1DWw$7zzy5c2lV5ExX9L83J23nHdxsOobXv7KHYXFLlP6qiE', 'نورة السبيعي', 'Noura Alsubaie', 'أخصائي سجلات طبية', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.566Z', '2026-11-13T22:16:09.566Z', '2026-11-13T22:16:09.566Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('1e192547-ef57-47e0-a612-c2734f02ef63', 'lab@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$gx1/Ukg6t5XZxKRhca3cMA$KAA9i0FIZqJd64a6ZAfiuKBbSd+SPpo3tBMLBt32ghQ', 'فهد الدوسري', 'Fahad Aldosari', 'فني مختبر', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.568Z', '2026-11-13T22:16:09.568Z', '2026-11-13T22:16:09.568Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('bfca792e-2368-49fa-b151-00eccbeeaaa0', 'lab2@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$gx1/Ukg6t5XZxKRhca3cMA$KAA9i0FIZqJd64a6ZAfiuKBbSd+SPpo3tBMLBt32ghQ', 'هند الغامدي', 'Hind Alghamdi', 'أخصائية مختبر', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.569Z', '2026-11-13T22:16:09.569Z', '2026-11-13T22:16:09.569Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('0a46bd63-2214-45ab-9fed-faa4ef96c2f1', 'radiology@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$R5MFWuUPZ2hvCZu57LaAGw$6gnU+zj0UJObz57cMkVVwc6g6F2XU3Eg7Q91PMtbzJ0', 'طلال البلوي', 'Talal Albalawi', 'فني أشعة', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.570Z', '2026-11-13T22:16:09.570Z', '2026-11-13T22:16:09.570Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('2395396e-0df8-4bd4-a219-21f1a744bb5a', 'radiologist@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$R5MFWuUPZ2hvCZu57LaAGw$6gnU+zj0UJObz57cMkVVwc6g6F2XU3Eg7Q91PMtbzJ0', 'د. منى الشريف', 'Dr. Mona Alsharif', 'استشارية أشعة', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.572Z', '2026-11-13T22:16:09.572Z', '2026-11-13T22:16:09.572Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('e10cd18c-de02-4cbd-ac55-1d370d928437', 'pharmacist@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$qcFhtasxrIz1MxRxN0nreg$wcREhW1hwMqukHCsuybg6s/P2+D+7TisBlOOP5v+v9Q', 'ريم المالكي', 'Reem Almalki', 'صيدلانية', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.574Z', '2026-11-13T22:16:09.574Z', '2026-11-13T22:16:09.574Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('dfea080f-a30a-4543-a3a3-8af84de0a253', 'accountant@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$L6u+gpVTMQh2FqDsGXSmPw$CEonjcI9eWpNRn4zXm3N2qnK5G4vXN38oDLvcNFx9PU', 'سلمان القحطاني', 'Salman Alqahtani', 'محاسب', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.575Z', '2026-11-13T22:16:09.575Z', '2026-11-13T22:16:09.575Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('a78b9983-2ea3-441b-8963-47b93d41fc72', 'auditor@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$rwPyIQiuesfU1Arx/saDHw$x7n4t87CXdQn9yyrHRkMOcFbHints+3YdljnDCPVW/A', 'لمى الحمد', 'Lama Alhamd', 'مدققة داخلية', NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.576Z', '2026-11-13T22:16:09.576Z', '2026-11-13T22:16:09.576Z', false) ON CONFLICT DO NOTHING;
INSERT INTO public.users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, phone_enc, is_active, is_super_admin, mfa_enabled, mfa_secret_enc, must_change_password, failed_login_count, locked_until, last_login_at, preferred_language, password_changed_at, created_at, updated_at, mfa_enforced) VALUES ('c2a0c6aa-1575-4092-8555-64463d7887d3', 'patient@demo.hms', '$argon2id$v=19$m=19456,t=2,p=1$08Dw+m1JZO4MF+xDCOZxcA$ZJenocN+uAd/1PpvneuHdYaITOWtYBxsn4II6SFNKtE', 'محمد العسيري', 'Mohammed Alaseeri', NULL, NULL, true, false, false, NULL, false, 0, NULL, NULL, 'ar', '2026-11-13T22:16:09.578Z', '2026-11-13T22:16:09.578Z', '2026-11-13T22:16:09.578Z', false) ON CONFLICT DO NOTHING;

-- Table: user_facilities (35 rows)
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('51448ee2-3ca8-453a-8219-41a7b1ba33da', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('51448ee2-3ca8-453a-8219-41a7b1ba33da', '827238b5-70ce-49fc-9c35-5d97ba97fb9d') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('a45ac955-41f2-4ccc-9bb7-b4d6a73d4a9f', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('a45ac955-41f2-4ccc-9bb7-b4d6a73d4a9f', '827238b5-70ce-49fc-9c35-5d97ba97fb9d') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('0adfcfa9-a60f-4206-bf4e-4b1f61411294', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('5429e3a8-0ca6-4cb1-9e88-4a0420cd20e5', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('6ee88313-d715-4dc2-83dc-9b8020d277b1', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('57283d40-fa50-4749-ab26-4ff0b379cb24', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('c2f1ad62-9cf9-4acc-80d8-860fe4ff350c', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('de15cd6f-f1f3-4a29-94f1-0792f43ff04d', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('812015e7-0075-402c-a28b-3074dbae5456', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('61649ac5-ae60-408b-89e8-9d0a62b7f600', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('ba10cda4-3731-4331-946a-d5b1fa8bc2b1', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('8b6b260e-89c4-4dfe-8878-5dc8d842c74f', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('fa56c1cc-765b-4513-b0c9-91e7de28a6a5', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('3286eb2b-bd8b-4e54-8288-73725f2e7551', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('9b107731-91a9-4f59-a8f6-f69aa269c2cb', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('4dccd026-a622-4144-af61-544a128e7476', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('5a915839-fbd0-44de-9d73-7bb4db13a8b4', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('2295120b-56c8-4ea9-9310-8704d88563a2', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('d9bb83ac-0edc-489a-9416-54fdb607f3d6', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('2ced6de5-730d-4038-b3e1-1429e7e84344', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('d7649f7b-2b1c-4c16-95a9-805418d0856a', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('b9a4049d-bc59-4f04-b712-b5c829441a29', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('07761178-3a94-4ffb-8097-1d676f8c998d', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('5b596af5-c1bd-4008-9664-bb86d1fea2ee', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('b7c8143f-46b6-4223-8ced-75ed50ee5192', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('1e192547-ef57-47e0-a612-c2734f02ef63', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('bfca792e-2368-49fa-b151-00eccbeeaaa0', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('0a46bd63-2214-45ab-9fed-faa4ef96c2f1', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('2395396e-0df8-4bd4-a219-21f1a744bb5a', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('e10cd18c-de02-4cbd-ac55-1d370d928437', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('dfea080f-a30a-4543-a3a3-8af84de0a253', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('a78b9983-2ea3-441b-8963-47b93d41fc72', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;
INSERT INTO public.user_facilities (user_id, facility_id) VALUES ('c2a0c6aa-1575-4092-8555-64463d7887d3', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a') ON CONFLICT DO NOTHING;

-- Table: user_roles (33 rows)
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('51448ee2-3ca8-453a-8219-41a7b1ba33da', 'system_admin', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.499Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('a45ac955-41f2-4ccc-9bb7-b4d6a73d4a9f', 'hospital_director', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.531Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('0adfcfa9-a60f-4206-bf4e-4b1f61411294', 'hr_manager', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.533Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('5429e3a8-0ca6-4cb1-9e88-4a0420cd20e5', 'hr_manager', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.535Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('6ee88313-d715-4dc2-83dc-9b8020d277b1', 'storekeeper', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '24554214-4af9-4ac3-8473-370258d81c2b', NULL, '2026-11-13T22:16:09.537Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('57283d40-fa50-4749-ab26-4ff0b379cb24', 'storekeeper', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '24554214-4af9-4ac3-8473-370258d81c2b', NULL, '2026-11-13T22:16:09.539Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('c2f1ad62-9cf9-4acc-80d8-860fe4ff350c', 'dentist', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'bcdff471-b704-4102-838c-e87d85160e15', NULL, '2026-11-13T22:16:09.540Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('de15cd6f-f1f3-4a29-94f1-0792f43ff04d', 'physiotherapist', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '4f781551-abe9-45ac-aa2c-5b98e012d81c', NULL, '2026-11-13T22:16:09.542Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('812015e7-0075-402c-a28b-3074dbae5456', 'physician', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '146e591e-3576-4888-b548-183b7632f10b', NULL, '2026-11-13T22:16:09.543Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('61649ac5-ae60-408b-89e8-9d0a62b7f600', 'physician', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '1ee5d6e2-5834-4948-9de7-2707b1861154', NULL, '2026-11-13T22:16:09.544Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('ba10cda4-3731-4331-946a-d5b1fa8bc2b1', 'nurse', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'fad18ad1-e9ab-49cf-8761-2498bcfd84a8', NULL, '2026-11-13T22:16:09.546Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('8b6b260e-89c4-4dfe-8878-5dc8d842c74f', 'nurse', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'fad18ad1-e9ab-49cf-8761-2498bcfd84a8', NULL, '2026-11-13T22:16:09.547Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('fa56c1cc-765b-4513-b0c9-91e7de28a6a5', 'surgeon', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b0c453f6-4ec8-45ff-b3c5-8d196b295818', NULL, '2026-11-13T22:16:09.548Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('3286eb2b-bd8b-4e54-8288-73725f2e7551', 'anesthesiologist', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b0c453f6-4ec8-45ff-b3c5-8d196b295818', NULL, '2026-11-13T22:16:09.549Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('9b107731-91a9-4f59-a8f6-f69aa269c2cb', 'or_nurse', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b0c453f6-4ec8-45ff-b3c5-8d196b295818', NULL, '2026-11-13T22:16:09.551Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('4dccd026-a622-4144-af61-544a128e7476', 'intensivist', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '83d05cb7-f214-4784-9c45-7c2bec139fb3', NULL, '2026-11-13T22:16:09.553Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('5a915839-fbd0-44de-9d73-7bb4db13a8b4', 'icu_nurse', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '83d05cb7-f214-4784-9c45-7c2bec139fb3', NULL, '2026-11-13T22:16:09.555Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('2295120b-56c8-4ea9-9310-8704d88563a2', 'blood_bank_tech', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'ce2e69a2-8077-45d5-ab08-ee41211388cc', NULL, '2026-11-13T22:16:09.556Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('d9bb83ac-0edc-489a-9416-54fdb607f3d6', 'dietitian', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'adb84318-da2e-4790-ab20-6e6265a3ab1b', NULL, '2026-11-13T22:16:09.558Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('2ced6de5-730d-4038-b3e1-1429e7e84344', 'kitchen_staff', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'adb84318-da2e-4790-ab20-6e6265a3ab1b', NULL, '2026-11-13T22:16:09.560Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('d7649f7b-2b1c-4c16-95a9-805418d0856a', 'cssd_tech', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'aa2e3834-1cf5-478b-a755-21cdba4f1a8d', NULL, '2026-11-13T22:16:09.561Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('b9a4049d-bc59-4f04-b712-b5c829441a29', 'cssd_tech', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'aa2e3834-1cf5-478b-a755-21cdba4f1a8d', NULL, '2026-11-13T22:16:09.563Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('07761178-3a94-4ffb-8097-1d676f8c998d', 'infection_control', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'fad18ad1-e9ab-49cf-8761-2498bcfd84a8', NULL, '2026-11-13T22:16:09.564Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('5b596af5-c1bd-4008-9664-bb86d1fea2ee', 'receptionist', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.566Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('b7c8143f-46b6-4223-8ced-75ed50ee5192', 'records_officer', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.567Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('1e192547-ef57-47e0-a612-c2734f02ef63', 'lab_tech', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '42880db0-7b02-4474-84e0-05ad76f4d2c7', NULL, '2026-11-13T22:16:09.569Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('bfca792e-2368-49fa-b151-00eccbeeaaa0', 'lab_tech', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '42880db0-7b02-4474-84e0-05ad76f4d2c7', NULL, '2026-11-13T22:16:09.570Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('0a46bd63-2214-45ab-9fed-faa4ef96c2f1', 'radiology_tech', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '6f1bb862-9549-4359-860b-99375b5098fc', NULL, '2026-11-13T22:16:09.571Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('2395396e-0df8-4bd4-a219-21f1a744bb5a', 'radiologist', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '6f1bb862-9549-4359-860b-99375b5098fc', NULL, '2026-11-13T22:16:09.573Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('e10cd18c-de02-4cbd-ac55-1d370d928437', 'pharmacist', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '77b7fc2b-5283-4fef-8b19-2b32cc00039e', NULL, '2026-11-13T22:16:09.575Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('dfea080f-a30a-4543-a3a3-8af84de0a253', 'accountant', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.576Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('a78b9983-2ea3-441b-8963-47b93d41fc72', 'auditor', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '0f1b3335-94c3-40b1-8555-a0cd433a00b5', NULL, '2026-11-13T22:16:09.577Z') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role_id, facility_id, department_id, assigned_by, assigned_at) VALUES ('c2a0c6aa-1575-4092-8555-64463d7887d3', 'patient', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', NULL, NULL, '2026-11-13T22:16:09.578Z') ON CONFLICT DO NOTHING;

-- Table: wards (2 rows)
INSERT INTO public.wards (id, facility_id, name_ar, name_en, ward_type, is_active) VALUES ('df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'جناح عام', 'General Ward', 'general', true) ON CONFLICT DO NOTHING;
INSERT INTO public.wards (id, facility_id, name_ar, name_en, ward_type, is_active) VALUES ('36d00fe8-1112-4540-8980-23952ee9e5a9', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'العناية المركزة', 'ICU', 'icu', true) ON CONFLICT DO NOTHING;

-- Table: rooms (8 rows)
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('b213407c-eacb-4f58-bbcf-eea3a58179c3', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'G-01', 'standard') ON CONFLICT DO NOTHING;
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('48063f43-e7b8-4477-a321-9b3782666807', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'G-02', 'standard') ON CONFLICT DO NOTHING;
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('b09b1d27-0b55-4780-9e67-be2ea054ab11', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'G-03', 'standard') ON CONFLICT DO NOTHING;
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('a2731956-9cb9-4853-8b73-06c21089c19f', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'G-04', 'standard') ON CONFLICT DO NOTHING;
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('beadabff-0f23-4c0e-a35c-4f84afcc98a0', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', 'ICU-01', 'standard') ON CONFLICT DO NOTHING;
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('2edd70ae-ad4b-4ca5-869f-55bcea8d3ee5', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', 'ICU-02', 'standard') ON CONFLICT DO NOTHING;
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('49f7c315-7a7d-4170-b077-316020a55bd8', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', 'ICU-03', 'standard') ON CONFLICT DO NOTHING;
INSERT INTO public.rooms (id, facility_id, ward_id, room_no, room_type) VALUES ('799765fe-e66a-4943-b04f-3a2e18f79279', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', 'ICU-04', 'standard') ON CONFLICT DO NOTHING;

-- Table: beds (8 rows)
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('716617f0-e22b-4d46-a299-ea3ea2ad9926', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'b213407c-eacb-4f58-bbcf-eea3a58179c3', 'A', 'available') ON CONFLICT DO NOTHING;
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('2978f8c8-3b26-4b1e-be06-11223675d990', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', '48063f43-e7b8-4477-a321-9b3782666807', 'A', 'available') ON CONFLICT DO NOTHING;
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('51bd05ee-2bfa-4976-8f87-8430fc65d3bf', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'b09b1d27-0b55-4780-9e67-be2ea054ab11', 'A', 'available') ON CONFLICT DO NOTHING;
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('6c493198-6f0a-485a-bd28-aec5a420ce09', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'df5aaa3e-b2c2-4bad-b8a7-e50e2c84b498', 'a2731956-9cb9-4853-8b73-06c21089c19f', 'A', 'available') ON CONFLICT DO NOTHING;
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('b4ebd4a3-ddd5-4bc2-a2d0-669213a5ecf1', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', '2edd70ae-ad4b-4ca5-869f-55bcea8d3ee5', 'A', 'available') ON CONFLICT DO NOTHING;
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('93ad0d95-6962-41ed-a218-6fd761fefa22', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', '49f7c315-7a7d-4170-b077-316020a55bd8', 'A', 'available') ON CONFLICT DO NOTHING;
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('4229d5de-74a7-45ea-9f11-a4b7ee0e21de', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', '799765fe-e66a-4943-b04f-3a2e18f79279', 'A', 'available') ON CONFLICT DO NOTHING;
INSERT INTO public.beds (id, facility_id, ward_id, room_id, bed_no, status) VALUES ('16446b66-89fa-47c2-be92-0c1e9fd47941', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '36d00fe8-1112-4540-8980-23952ee9e5a9', 'beadabff-0f23-4c0e-a35c-4f84afcc98a0', 'A', 'occupied') ON CONFLICT DO NOTHING;

-- Table: lab_tests (5 rows)
INSERT INTO public.lab_tests (code, name_ar, name_en, specimen, unit, ref_low, ref_high, critical_low, critical_high, price) VALUES ('718-7', 'الهيموغلوبين', 'Hemoglobin', 'blood', 'g/dL', '13', '17', '7', '20', '25.00') ON CONFLICT DO NOTHING;
INSERT INTO public.lab_tests (code, name_ar, name_en, specimen, unit, ref_low, ref_high, critical_low, critical_high, price) VALUES ('6690-2', 'كرات الدم البيضاء', 'WBC', 'blood', '10^3/uL', '4', '11', '1.5', '30', '25.00') ON CONFLICT DO NOTHING;
INSERT INTO public.lab_tests (code, name_ar, name_en, specimen, unit, ref_low, ref_high, critical_low, critical_high, price) VALUES ('2345-7', 'الغلوكوز صائم', 'Fasting Glucose', 'blood', 'mg/dL', '70', '110', '40', '500', '20.00') ON CONFLICT DO NOTHING;
INSERT INTO public.lab_tests (code, name_ar, name_en, specimen, unit, ref_low, ref_high, critical_low, critical_high, price) VALUES ('2160-0', 'الكرياتينين', 'Creatinine', 'blood', 'mg/dL', '0.6', '1.3', '0.2', '6', '25.00') ON CONFLICT DO NOTHING;
INSERT INTO public.lab_tests (code, name_ar, name_en, specimen, unit, ref_low, ref_high, critical_low, critical_high, price) VALUES ('4548-4', 'الهيموغلوبين السكري', 'HbA1c', 'blood', '%', '4', '5.7', NULL, '12', '60.00') ON CONFLICT DO NOTHING;

-- Table: drugs (6 rows)
INSERT INTO public.drugs (id, code, name_ar, name_en, form, strength, is_controlled, is_active, price, is_high_alert) VALUES ('bf785000-061e-4248-b2c7-8a94628ff5df', 'DRG-PARA', 'باراسيتامول 500 ملغ', 'Paracetamol 500mg', 'tablet', '500mg', false, true, '5.00', false) ON CONFLICT DO NOTHING;
INSERT INTO public.drugs (id, code, name_ar, name_en, form, strength, is_controlled, is_active, price, is_high_alert) VALUES ('e4965b65-aa8b-437b-a94a-fc4b0a231a9b', 'DRG-AMOX', 'أموكسيسيلين 500 ملغ', 'Amoxicillin 500mg', 'capsule', '500mg', false, true, '18.00', false) ON CONFLICT DO NOTHING;
INSERT INTO public.drugs (id, code, name_ar, name_en, form, strength, is_controlled, is_active, price, is_high_alert) VALUES ('2ebf6eb5-8a30-407b-89d4-0b2d2f38eade', 'DRG-IBU', 'إيبوبروفين 400 ملغ', 'Ibuprofen 400mg', 'tablet', '400mg', false, true, '8.00', false) ON CONFLICT DO NOTHING;
INSERT INTO public.drugs (id, code, name_ar, name_en, form, strength, is_controlled, is_active, price, is_high_alert) VALUES ('062d3260-5a1b-443f-a643-44179d7cefc5', 'DRG-WARF', 'وارفارين 5 ملغ', 'Warfarin 5mg', 'tablet', '5mg', true, true, '22.00', true) ON CONFLICT DO NOTHING;
INSERT INTO public.drugs (id, code, name_ar, name_en, form, strength, is_controlled, is_active, price, is_high_alert) VALUES ('b3a2ba77-27bb-47ce-99dd-2db515a8f3c8', 'DRG-ASP', 'أسبرين 81 ملغ', 'Aspirin 81mg', 'tablet', '81mg', false, true, '7.00', false) ON CONFLICT DO NOTHING;
INSERT INTO public.drugs (id, code, name_ar, name_en, form, strength, is_controlled, is_active, price, is_high_alert) VALUES ('9ed60a89-f47d-4b98-94dc-8aafb4bb38d1', 'DRG-METF', 'ميتفورمين 500 ملغ', 'Metformin 500mg', 'tablet', '500mg', false, true, '12.00', false) ON CONFLICT DO NOTHING;

-- Table: drug_batches (6 rows)
INSERT INTO public.drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at) VALUES ('21a423c5-6f57-4317-bfef-f20b54a10620', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'e4965b65-aa8b-437b-a94a-fc4b0a231a9b', 'B-AMOX-001', '2027-12-18T00:00:00.000Z', '500.00', '12.60', '2026-11-13T22:16:09.631Z') ON CONFLICT DO NOTHING;
INSERT INTO public.drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at) VALUES ('1d261204-a4b8-495d-b071-5653db97dbe8', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '2ebf6eb5-8a30-407b-89d4-0b2d2f38eade', 'B-IBU-001', '2027-12-18T00:00:00.000Z', '500.00', '5.60', '2026-11-13T22:16:09.632Z') ON CONFLICT DO NOTHING;
INSERT INTO public.drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at) VALUES ('1517cd6d-abaa-412e-933d-d9e6a15196c2', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3a2ba77-27bb-47ce-99dd-2db515a8f3c8', 'B-ASP-001', '2027-12-18T00:00:00.000Z', '500.00', '4.90', '2026-11-13T22:16:09.635Z') ON CONFLICT DO NOTHING;
INSERT INTO public.drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at) VALUES ('f864e5cc-ad18-478b-8d90-93c297bcdc6e', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '9ed60a89-f47d-4b98-94dc-8aafb4bb38d1', 'B-METF-001', '2027-12-18T00:00:00.000Z', '440.00', '8.40', '2026-11-13T22:16:09.636Z') ON CONFLICT DO NOTHING;
INSERT INTO public.drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at) VALUES ('316dbf29-3de6-4cd6-bca0-179f35a467c1', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'bf785000-061e-4248-b2c7-8a94628ff5df', 'B-PARA-001', '2027-12-18T00:00:00.000Z', '472.00', '3.50', '2026-11-13T22:16:09.629Z') ON CONFLICT DO NOTHING;
INSERT INTO public.drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at) VALUES ('db1566ea-950c-4940-9208-6d63deef9631', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '062d3260-5a1b-443f-a643-44179d7cefc5', 'B-WARF-001', '2027-12-18T00:00:00.000Z', '472.00', '15.40', '2026-11-13T22:16:09.634Z') ON CONFLICT DO NOTHING;

-- Table: drug_interactions (1 rows)
INSERT INTO public.drug_interactions (id, drug_a_code, drug_b_code, severity, description) VALUES ('47b45217-6b2f-4d2b-9fdf-a639c3d91de2', 'DRG-WARF', 'DRG-ASP', 'major', 'زيادة خطر النزف عند الجمع بين الوارفارين والأسبرين') ON CONFLICT DO NOTHING;

-- Table: cssd_instrument_sets (7 rows)
INSERT INTO public.cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, is_active, created_by, created_at) VALUES ('6a8d6ada-ba2e-46cd-bc3a-f3a1aa9bf2ba', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS-SET-01', 'طقم جراحة عامة أساسي', 'laparotomy', 42, 'OR', true, 'b9a4049d-bc59-4f04-b712-b5c829441a29', '2026-11-13T22:16:09.769Z') ON CONFLICT DO NOTHING;
INSERT INTO public.cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, is_active, created_by, created_at) VALUES ('e522f468-9942-42e9-9a47-de308ceda784', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS-SET-02', 'طقم استئصال مرارة بالمنظار', 'laparotomy', 28, 'OR', true, 'b9a4049d-bc59-4f04-b712-b5c829441a29', '2026-11-13T22:16:09.770Z') ON CONFLICT DO NOTHING;
INSERT INTO public.cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, is_active, created_by, created_at) VALUES ('4c762742-c520-4a9e-89ab-555ffb3de114', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS-SET-03', 'طقم جراحة عظام صغرى', 'orthopedic', 55, 'OR', true, 'b9a4049d-bc59-4f04-b712-b5c829441a29', '2026-11-13T22:16:09.770Z') ON CONFLICT DO NOTHING;
INSERT INTO public.cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, is_active, created_by, created_at) VALUES ('8694a37e-e408-481a-9afb-9f14331dbf56', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS-SET-04', 'طقم تضميد جروح', 'dressing', 12, 'INP', true, 'b9a4049d-bc59-4f04-b712-b5c829441a29', '2026-11-13T22:16:09.771Z') ON CONFLICT DO NOTHING;
INSERT INTO public.cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, is_active, created_by, created_at) VALUES ('5dfa9dde-0f18-4622-93c0-ecedcb903235', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS-SET-05', 'طقم ولادة', 'other', 24, 'OR', true, 'b9a4049d-bc59-4f04-b712-b5c829441a29', '2026-11-13T22:16:09.772Z') ON CONFLICT DO NOTHING;
INSERT INTO public.cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, is_active, created_by, created_at) VALUES ('69e9f4a3-209f-43c9-b6cd-044479f3ae89', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS-SET-06', 'طقم جراحة عامة احتياطي', 'laparotomy', 40, 'OR', true, 'b9a4049d-bc59-4f04-b712-b5c829441a29', '2026-11-13T22:16:09.772Z') ON CONFLICT DO NOTHING;
INSERT INTO public.cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, is_active, created_by, created_at) VALUES ('3fbf5bbb-9245-46ec-8584-4e58a7ea5716', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'CSS-SET-07', 'طقم قسطرة قلبية', 'endoscopy', 18, 'OR', true, 'b9a4049d-bc59-4f04-b712-b5c829441a29', '2026-11-13T22:16:09.773Z') ON CONFLICT DO NOTHING;

-- Table: inventory_warehouses (4 rows)
INSERT INTO public.inventory_warehouses (id, facility_id, code, name_ar, name_en, warehouse_type, department_id, is_active, created_by, created_at) VALUES ('b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'WH-MAIN', 'المستودع الطبي الرئيسي', 'Main Medical Warehouse', 'main', '24554214-4af9-4ac3-8473-370258d81c2b', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.836Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_warehouses (id, facility_id, code, name_ar, name_en, warehouse_type, department_id, is_active, created_by, created_at) VALUES ('64078600-5b74-418d-a4b6-ff37c229c9b5', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'WH-SURG', 'مستودع العمليات والجراحة', 'Surgical & OR Store', 'surgical', 'b0c453f6-4ec8-45ff-b3c5-8d196b295818', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.836Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_warehouses (id, facility_id, code, name_ar, name_en, warehouse_type, department_id, is_active, created_by, created_at) VALUES ('ee603741-9c0e-4ef6-8441-0e2ec77ec55f', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'WH-DENT', 'مستودع عيادة الأسنان', 'Dental Supplies Store', 'dental', 'bcdff471-b704-4102-838c-e87d85160e15', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.836Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_warehouses (id, facility_id, code, name_ar, name_en, warehouse_type, department_id, is_active, created_by, created_at) VALUES ('9b028170-e19c-441d-9fe1-4388278765a2', '827238b5-70ce-49fc-9c35-5d97ba97fb9d', 'WH-JED-MAIN', 'المستودع الرئيسي — فرع جدة', 'Jeddah Branch Main Store', 'main', NULL, true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.836Z') ON CONFLICT DO NOTHING;

-- Table: inventory_items (6 rows)
INSERT INTO public.inventory_items (id, facility_id, sku, name_ar, name_en, category, unit, reorder_level, unit_cost, is_active, created_by, created_at) VALUES ('b89dc0c5-ceaf-4b4b-9922-5ccb0c78be07', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'SKU-PPE-001', 'قفازات فحص نيتريل معقمة (علبة ١٠٠)', 'Sterile Nitrile Gloves (100/box)', 'ppe', 'علبة', '30.00', '28.00', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.838Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_items (id, facility_id, sku, name_ar, name_en, category, unit, reorder_level, unit_cost, is_active, created_by, created_at) VALUES ('afc024bc-4fae-467a-9a8e-58851581f92a', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'SKU-CNS-002', 'قثاطر وريدية طرفية مقاس 20G', 'IV Cannula 20G', 'consumables', 'قطعة', '50.00', '4.50', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.845Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_items (id, facility_id, sku, name_ar, name_en, category, unit, reorder_level, unit_cost, is_active, created_by, created_at) VALUES ('dd0f449c-113d-49f5-99f2-4ab51951d85a', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'SKU-SRG-003', 'خيوط جراحية قابلة للامتصاص Vicryl 2-0', 'Vicryl Suture 2-0', 'surgical_supplies', 'علبة', '15.00', '165.00', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.848Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_items (id, facility_id, sku, name_ar, name_en, category, unit, reorder_level, unit_cost, is_active, created_by, created_at) VALUES ('a4f78a8e-ad29-440e-8c2a-d268ccda6c2f', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'SKU-LAB-004', 'أنابيب سحب دم EDTA بنفسجية', 'EDTA Blood Collection Tubes', 'lab_reagents', 'حزمة', '20.00', '42.00', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.850Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_items (id, facility_id, sku, name_ar, name_en, category, unit, reorder_level, unit_cost, is_active, created_by, created_at) VALUES ('cf86dd3c-adab-4c76-9a44-1e1b65cf7e2a', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'SKU-DNT-005', 'كبسولات كومبوزيت ضوئي ترميمي للأسنان', 'Light-Cure Dental Composite Capsules', 'dental_supplies', 'علبة', '10.00', '210.00', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.852Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_items (id, facility_id, sku, name_ar, name_en, category, unit, reorder_level, unit_cost, is_active, created_by, created_at) VALUES ('9a822776-b38e-4c02-a5ba-9726f934fa05', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'SKU-PHY-006', 'أقطاب تحفيز كهربائي لاصقة (TENS Electrodes)', 'TENS Adhesive Electrodes Pack', 'physio_supplies', 'طقم', '12.00', '35.00', true, '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.854Z') ON CONFLICT DO NOTHING;

-- Table: inventory_stock (6 rows)
INSERT INTO public.inventory_stock (id, facility_id, warehouse_id, item_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at, updated_at) VALUES ('57513e5e-9f38-4291-9ab1-e2a50fd13a9d', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'b89dc0c5-ceaf-4b4b-9922-5ccb0c78be07', 'LOT-GLV-26A', '2027-09-29T00:00:00.000Z', '120.00', '28.00', '2026-11-13T22:16:09.840Z', '2026-11-13T22:16:09.840Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_stock (id, facility_id, warehouse_id, item_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at, updated_at) VALUES ('7930799a-786a-46ab-94bd-941fed4cab1b', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'afc024bc-4fae-467a-9a8e-58851581f92a', 'LOT-IVC-26B', '2027-12-18T00:00:00.000Z', '200.00', '4.50', '2026-11-13T22:16:09.846Z', '2026-11-13T22:16:09.846Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_stock (id, facility_id, warehouse_id, item_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at, updated_at) VALUES ('78e2de5c-c0ba-4c35-99fb-ed86869ced82', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '64078600-5b74-418d-a4b6-ff37c229c9b5', 'dd0f449c-113d-49f5-99f2-4ab51951d85a', 'LOT-VIC-26C', '2027-08-20T00:00:00.000Z', '8.00', '165.00', '2026-11-13T22:16:09.849Z', '2026-11-13T22:16:09.849Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_stock (id, facility_id, warehouse_id, item_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at, updated_at) VALUES ('83a6e77b-0cfc-4616-9df5-fc3218028a14', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'a4f78a8e-ad29-440e-8c2a-d268ccda6c2f', 'LOT-EDT-26D', '2027-07-21T00:00:00.000Z', '65.00', '42.00', '2026-11-13T22:16:09.851Z', '2026-11-13T22:16:09.851Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_stock (id, facility_id, warehouse_id, item_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at, updated_at) VALUES ('24e38052-05fb-486a-b4fd-e64839e721c9', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'ee603741-9c0e-4ef6-8441-0e2ec77ec55f', 'cf86dd3c-adab-4c76-9a44-1e1b65cf7e2a', 'LOT-CMP-26E', '2027-11-08T00:00:00.000Z', '24.00', '210.00', '2026-11-13T22:16:09.853Z', '2026-11-13T22:16:09.853Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_stock (id, facility_id, warehouse_id, item_id, batch_no, expiry_date, qty_on_hand, unit_cost, received_at, updated_at) VALUES ('58de4b0d-da4b-419b-a500-95c623b0eed2', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', '9a822776-b38e-4c02-a5ba-9726f934fa05', 'LOT-TNS-26F', '2028-03-27T00:00:00.000Z', '40.00', '35.00', '2026-11-13T22:16:09.855Z', '2026-11-13T22:16:09.855Z') ON CONFLICT DO NOTHING;

-- Table: inventory_requisitions (2 rows)
INSERT INTO public.inventory_requisitions (id, facility_id, req_no, warehouse_id, department_id, item_id, qty_requested, qty_issued, priority, status, notes, requested_by, issued_by, issued_at, reject_reason, created_at) VALUES ('7d454b99-d052-4ae6-9e2a-9ab82d5eb98b', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'REQ-000001', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'fad18ad1-e9ab-49cf-8761-2498bcfd84a8', 'afc024bc-4fae-467a-9a8e-58851581f92a', '15.00', '15.00', 'routine', 'issued', 'تزويد جناح التنويم بمستلزمات القثاطر الوريدية الأسبوعية', 'ba10cda4-3731-4331-946a-d5b1fa8bc2b1', '57283d40-fa50-4749-ab26-4ff0b379cb24', '2026-11-13T16:16:09.856Z', NULL, '2026-11-13T22:16:09.856Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_requisitions (id, facility_id, req_no, warehouse_id, department_id, item_id, qty_requested, qty_issued, priority, status, notes, requested_by, issued_by, issued_at, reject_reason, created_at) VALUES ('a85d8cb8-152a-4d44-aa78-c5835ba2aec4', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'REQ-000002', 'ee603741-9c0e-4ef6-8441-0e2ec77ec55f', 'bcdff471-b704-4102-838c-e87d85160e15', 'cf86dd3c-adab-4c76-9a44-1e1b65cf7e2a', '4.00', '0.00', 'urgent', 'pending', 'احتياج عيادة الأسنان لحشوات كومبوزيت إضافية لجدول الغد', 'c2f1ad62-9cf9-4acc-80d8-860fe4ff350c', NULL, NULL, NULL, '2026-11-13T22:16:09.856Z') ON CONFLICT DO NOTHING;

-- Table: inventory_movements (6 rows)
INSERT INTO public.inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reference_id, reason, performed_by, created_at) VALUES ('7dba59e3-8f29-4ee4-ac9d-629b8558c9ef', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'b89dc0c5-ceaf-4b4b-9922-5ccb0c78be07', '57513e5e-9f38-4291-9ab1-e2a50fd13a9d', 'receipt', '120.00', 'initial_stock', NULL, 'رصيد افتتاحي معتمد للمستودع', '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.842Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reference_id, reason, performed_by, created_at) VALUES ('c2300d23-90d1-4837-8d95-7d1f9dcf31b2', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'afc024bc-4fae-467a-9a8e-58851581f92a', '7930799a-786a-46ab-94bd-941fed4cab1b', 'receipt', '200.00', 'initial_stock', NULL, 'رصيد افتتاحي معتمد للمستودع', '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.846Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reference_id, reason, performed_by, created_at) VALUES ('c51c0b83-1ffa-4e49-8824-aa5e6aee947e', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', '64078600-5b74-418d-a4b6-ff37c229c9b5', 'dd0f449c-113d-49f5-99f2-4ab51951d85a', '78e2de5c-c0ba-4c35-99fb-ed86869ced82', 'receipt', '8.00', 'initial_stock', NULL, 'رصيد افتتاحي معتمد للمستودع', '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.850Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reference_id, reason, performed_by, created_at) VALUES ('113f644e-8e99-4e72-9fe4-7189df770ced', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', 'a4f78a8e-ad29-440e-8c2a-d268ccda6c2f', '83a6e77b-0cfc-4616-9df5-fc3218028a14', 'receipt', '65.00', 'initial_stock', NULL, 'رصيد افتتاحي معتمد للمستودع', '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.851Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reference_id, reason, performed_by, created_at) VALUES ('8227c1c9-ce0a-4c1b-a556-9182de483243', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'ee603741-9c0e-4ef6-8441-0e2ec77ec55f', 'cf86dd3c-adab-4c76-9a44-1e1b65cf7e2a', '24e38052-05fb-486a-b4fd-e64839e721c9', 'receipt', '24.00', 'initial_stock', NULL, 'رصيد افتتاحي معتمد للمستودع', '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.853Z') ON CONFLICT DO NOTHING;
INSERT INTO public.inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reference_id, reason, performed_by, created_at) VALUES ('90e8ad80-4044-40cb-81d3-2cb04e0c8159', 'dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'b3470f77-dbd3-4dd1-8e3f-314d39b1ab21', '9a822776-b38e-4c02-a5ba-9726f934fa05', '58de4b0d-da4b-419b-a500-95c623b0eed2', 'receipt', '40.00', 'initial_stock', NULL, 'رصيد افتتاحي معتمد للمستودع', '6ee88313-d715-4dc2-83dc-9b8020d277b1', '2026-11-13T22:16:09.855Z') ON CONFLICT DO NOTHING;

-- Table: number_sequences (25 rows)
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'appointment', 4) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'mrn', 6) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'er_mrn', 1) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'encounter', 6) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'lab_order', 3) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'prescription', 3) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'invoice', 2) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'claim', 1) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'admission', 3) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'surgery', 2) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'icu_stay', 2) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'imaging', 4) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'blood_donor', 8) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'blood_unit', 15) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'blood_request', 2) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'nutrition_order', 2) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'nutrition_tray', 5) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'cssd_pack', 8) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'cssd_load', 4) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'hr_employee', 10) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'hr_leave', 3) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'inv_req', 3) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'dental_proc', 3) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'physio_ref', 3) ON CONFLICT DO NOTHING;
INSERT INTO public.number_sequences (facility_id, name, next_value) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'physio_sess', 3) ON CONFLICT DO NOTHING;

-- Table: app_settings (12 rows)
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.consultation', '{"amount":150}'::jsonb, NULL, '2026-11-13T22:16:09.597Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.bed_day', '{"amount":400}'::jsonb, NULL, '2026-11-13T22:16:09.598Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.er_visit', '{"amount":200}'::jsonb, NULL, '2026-11-13T22:16:09.599Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.surgery_case', '{"amount":3500}'::jsonb, NULL, '2026-11-13T22:16:09.599Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.anesthesia_case', '{"amount":1200}'::jsonb, NULL, '2026-11-13T22:16:09.600Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.imaging_xray', '{"amount":150}'::jsonb, NULL, '2026-11-13T22:16:09.600Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.imaging_ct', '{"amount":650}'::jsonb, NULL, '2026-11-13T22:16:09.601Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.imaging_mri', '{"amount":1100}'::jsonb, NULL, '2026-11-13T22:16:09.601Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.imaging_us', '{"amount":300}'::jsonb, NULL, '2026-11-13T22:16:09.602Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.imaging_mammography', '{"amount":400}'::jsonb, NULL, '2026-11-13T22:16:09.602Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.imaging_fluoroscopy', '{"amount":500}'::jsonb, NULL, '2026-11-13T22:16:09.603Z') ON CONFLICT DO NOTHING;
INSERT INTO public.app_settings (facility_id, key, value, updated_by, updated_at) VALUES ('dc9b5128-7621-4788-98d3-f5ebc70ea03a', 'pricing.imaging_panoramic', '{"amount":180}'::jsonb, NULL, '2026-11-13T22:16:09.603Z') ON CONFLICT DO NOTHING;

COMMIT;

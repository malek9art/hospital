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

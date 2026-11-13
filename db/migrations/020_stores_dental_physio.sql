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

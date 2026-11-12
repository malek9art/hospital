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

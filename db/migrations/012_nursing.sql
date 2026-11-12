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

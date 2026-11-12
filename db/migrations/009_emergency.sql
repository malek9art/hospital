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

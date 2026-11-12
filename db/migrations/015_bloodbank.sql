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

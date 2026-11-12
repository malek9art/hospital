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

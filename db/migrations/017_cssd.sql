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

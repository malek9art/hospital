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

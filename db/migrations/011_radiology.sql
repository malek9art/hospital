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

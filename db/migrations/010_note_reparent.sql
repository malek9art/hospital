-- Patient merge must re-parent signed clinical notes without altering their
-- content. Rather than weakening append-only guarantees, permit exactly one
-- mutation: changing patient_id while every other column stays identical.
CREATE OR REPLACE FUNCTION allow_note_reparent_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(OLD) - 'patient_id') = (to_jsonb(NEW) - 'patient_id') THEN
    RETURN NEW;   -- identity correction during a documented merge
  END IF;
  RAISE EXCEPTION 'Table % is append-only: only patient_id may be corrected, % with other changes is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER clinical_notes_immutable ON clinical_notes;
CREATE TRIGGER clinical_notes_immutable
  BEFORE UPDATE OR DELETE ON clinical_notes
  FOR EACH ROW EXECUTE FUNCTION allow_note_reparent_only();

-- Column-level privilege for the same narrow operation.
GRANT UPDATE (patient_id) ON clinical_notes TO hms_app;

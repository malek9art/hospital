-- Portal (patient) role needs limited read access to shared reference data.
GRANT SELECT ON departments, facilities, drugs, lab_tests TO hms_portal;

-- Departments and pricing are not tenant-private reference data.
CREATE POLICY portal_read_departments ON departments FOR SELECT TO hms_portal USING (true);
CREATE POLICY portal_read_settings ON app_settings FOR SELECT TO hms_portal USING (key = 'pricing.consultation');

-- Patients may see the display name of clinicians involved in their care, but
-- must never read the users table (emails, hashes, MFA secrets) directly.
CREATE VIEW portal_clinicians AS
  SELECT id, full_name_ar, job_title_ar FROM users WHERE is_active = true;
GRANT SELECT ON portal_clinicians TO hms_portal;

-- ============================================================================
-- 001_core.sql  |  Facilities, identity, RBAC, sessions, audit, infrastructure
-- Target: PostgreSQL 14+ (tested on PostgreSQL 18 / PGlite)
-- All tenant-scoped tables carry facility_id and are protected by RLS (003).
-- ============================================================================

CREATE TABLE facilities (
  id            uuid PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name_ar       text NOT NULL,
  name_en       text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Riyadh',
  currency      text NOT NULL DEFAULT 'SAR',
  locale        text NOT NULL DEFAULT 'ar-SA',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id           uuid PRIMARY KEY,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  code         text NOT NULL,
  name_ar      text NOT NULL,
  name_en      text NOT NULL,
  dept_type    text NOT NULL CHECK (dept_type IN ('outpatient','emergency','inpatient','icu','lab','radiology','pharmacy','administration','other')),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY,
  email                 text NOT NULL,
  password_hash         text NOT NULL,
  full_name_ar          text NOT NULL,
  full_name_en          text NOT NULL,
  job_title_ar          text,
  phone_enc             text,
  is_active             boolean NOT NULL DEFAULT true,
  is_super_admin        boolean NOT NULL DEFAULT false,
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_enc        text,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  preferred_language    text NOT NULL DEFAULT 'ar',
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE user_facilities (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  PRIMARY KEY (user_id, facility_id)
);

CREATE TABLE roles (
  id           text PRIMARY KEY,
  name_ar      text NOT NULL,
  name_en      text NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT true
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  module      text NOT NULL,
  desc_ar     text NOT NULL
);

CREATE TABLE role_permissions (
  role_id          text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- Department and facility scoped role assignment (least privilege, multi-facility).
CREATE TABLE user_roles (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id        text NOT NULL REFERENCES roles(id),
  facility_id    uuid NOT NULL REFERENCES facilities(id),
  department_id  uuid REFERENCES departments(id),
  assigned_by    uuid REFERENCES users(id),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id, facility_id)
);

CREATE TABLE sessions (
  id                   uuid PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash           text NOT NULL UNIQUE,
  csrf_token           text NOT NULL,
  facility_id          uuid REFERENCES facilities(id),
  ip                   text,
  user_agent           text,
  mfa_verified         boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoked_reason       text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_recovery_codes (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tamper-evident audit log (hash chain). UPDATE/DELETE are blocked by trigger + grants.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  facility_id    uuid,
  actor_user_id  uuid,
  actor_role     text,
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  patient_id     uuid,
  outcome        text NOT NULL DEFAULT 'success',
  reason         text,
  ip             text,
  user_agent     text,
  request_id     text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      text NOT NULL,
  hash           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_patient_idx ON audit_log (patient_id, created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, created_at DESC);

CREATE TABLE idempotency_keys (
  key            text NOT NULL,
  user_id        uuid NOT NULL,
  endpoint       text NOT NULL,
  request_hash   text NOT NULL,
  status_code    integer NOT NULL,
  response_json  jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id, endpoint)
);

CREATE TABLE number_sequences (
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  name         text NOT NULL,
  next_value   bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (facility_id, name)
);

CREATE TABLE app_settings (
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  key          text NOT NULL,
  value        jsonb NOT NULL,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, key)
);

-- Outbox for notifications. Delivery is attempted by a background worker; rows are
-- never reported as "sent" unless a provider transport acknowledged them.
CREATE TABLE notifications_outbox (
  id             bigserial PRIMARY KEY,
  facility_id    uuid NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email','sms','in_app')),
  recipient      text,
  subject        text,
  body           text NOT NULL,
  patient_id     uuid,
  related_type   text,
  related_id     text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  scheduled_at   timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_pending_idx ON notifications_outbox (status, scheduled_at);

-- Emergency ("break-glass") access grants: time-boxed, reason-bound, audited.
CREATE TABLE break_glass_grants (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  facility_id  uuid NOT NULL,
  patient_id   uuid NOT NULL,
  reason       text NOT NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  reviewed_by  uuid,
  reviewed_at  timestamptz
);

-- Every read of a patient chart is recorded (PDPL / HIPAA-style access log).
CREATE TABLE patient_access_log (
  id             bigserial PRIMARY KEY,
  facility_id    uuid NOT NULL,
  user_id        uuid,
  patient_id     uuid NOT NULL,
  access_type    text NOT NULL,
  access_basis   text NOT NULL,
  reason         text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_access_log_patient_idx ON patient_access_log (patient_id, created_at DESC);

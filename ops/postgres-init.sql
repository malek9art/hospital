-- Run once by the database administrator on a fresh PostgreSQL instance.
-- The application connects as hms_owner ONLY to run migrations; business traffic
-- switches to hms_app/hms_portal inside each transaction (RLS is FORCED).
CREATE ROLE hms_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER CREATEDB;
CREATE ROLE hms_app   NOLOGIN NOBYPASSRLS;
CREATE ROLE hms_portal NOLOGIN NOBYPASSRLS;
CREATE DATABASE hms OWNER hms_owner;
\connect hms
GRANT CONNECT ON DATABASE hms TO hms_owner;
-- Note: app and portal role creation is also idempotently handled by migrations.

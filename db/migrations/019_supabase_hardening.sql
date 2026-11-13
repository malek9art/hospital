-- ============================================================================
-- 019_supabase_hardening.sql | Supabase / Managed PostgreSQL Role & PostgREST Hardening
-- 1. Ensures the migration connection user (e.g. `postgres` on Supabase) holds
--    membership in `hms_app` and `hms_portal` so transaction-scoped
--    `SET LOCAL ROLE hms_app` / `SET LOCAL ROLE hms_portal` always succeeds on
--    PostgreSQL 16/17 non-superuser setups.
-- 2. Locks down Supabase PostgREST `anon` and `authenticated` roles so public
--    `anon` JWT keys cannot query HMS tables, sequences, or functions directly.
-- ============================================================================

DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT hms_app TO %I', current_user);
    EXECUTE format('GRANT hms_portal TO %I', current_user);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    BEGIN
      GRANT hms_app TO postgres;
      GRANT hms_portal TO postgres;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  -- Lock down Supabase PostgREST roles (`anon`, `authenticated`) while keeping
  -- `USAGE ON SCHEMA public` intact so Supabase's `/rest/v1/` health probe passes.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM authenticated;
  END IF;
END $$;

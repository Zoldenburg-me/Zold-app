-- zold_grant_app (0006), corrected:
-- - the schema is read as pg_namespace.nspname, the bare name. Its regnamespace
--   text keeps the quotes a mixed-case name needs, and %I then quoted it again,
--   naming a schema that does not exist.
-- - it refuses, rather than warns, when the application role can still create
--   temporary objects: REVOKE TEMPORARY ON DATABASE takes effect only when the
--   caller owns the database, and from anyone else is a warning that leaves
--   the grant in place. Run it as the database's owner (§7).
CREATE OR REPLACE FUNCTION zold_grant_app(app name) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  -- The schema this function lives in: its search path starts at pg_catalog.
  s name := (
    SELECT n.nspname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = 'zold_grant_app(name)'::regprocedure
  );
  t name;
  kept name[] := ARRAY['ledger', 'organisations', 'accounts', 'invoices', 'documents', 'transfers'];
BEGIN
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, app);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, app);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s, app);
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', s);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, %I', current_database(), app);
  IF has_database_privilege(app, current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'zold_grant_app: % can still create temporary tables in %; run this as the database owner', app, current_database();
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, app);
  FOR t IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = s LOOP
    IF t IN ('schema_migrations', 'ledger_history') THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO %I', s, t, app);
    ELSIF t = 'audit' THEN
      EXECUTE format('GRANT SELECT, INSERT ON %I.%I TO %I', s, t, app);
    ELSIF t = ANY (kept) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO %I', s, t, app);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I', s, t, app);
    END IF;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION zold_grant_app(name) FROM PUBLIC;

-- CREATE OR REPLACE resets the function's settings: its search path again.
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION zold_grant_app(name) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$$;

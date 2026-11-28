-- zold_grant_app (0009) with DELETE on users: the operator's user deletion
-- (store.deleteUser) removes the row, for a GDPR erasure request. Money rows
-- keep the bare userId and stay undeletable.
CREATE OR REPLACE FUNCTION zold_grant_app(app name) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  -- The schema this function lives in: its search path starts at pg_catalog.
  s name := (
    SELECT n.nspname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = 'zold_grant_app(name)'::regprocedure
  );
  t name;
  deletable name[] := ARRAY[
    'quotes', 'sessions', 'operator_sessions', 'operator_credentials',
    'shopify_connections', 'shopify_deliveries', 'contacts', 'imported_wallets',
    'account_rules', 'cap_holds', 'pending_executions', 'outbox', 'payment_handles',
    'users'
  ];
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
    ELSIF t = ANY (deletable) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I', s, t, app);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO %I', s, t, app);
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

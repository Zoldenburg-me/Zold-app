-- The provisioning and restore checks (docs/postgres-store-design.md §7.1
-- step 3, §7.2). Same variables as database.sql, plus:
--
--   host_cluster (0|1)   whole-cluster checks: no TCP listener, reserved
--                        connections, UTF-8, archiving on, no other
--                        superuser (a host cluster; not a shared test server)
--   hub_ported (0|1)     the hub's tables exist (S9); before that hub must
--                        hold no table at all
--
-- Run as the cluster's OS user. Any failed check raises, so psql exits 1.
-- Changes nothing: the one write (the grant comparison) is rolled back.

\set ON_ERROR_STOP 1
SELECT set_config('zc.zold_db', :'zold_db', false), set_config('zc.zold_owner', :'zold_owner', false),
       set_config('zc.zold_app', :'zold_app', false), set_config('zc.with_hub', :'with_hub', false),
       set_config('zc.hub_db', :'hub_db', false), set_config('zc.hub_owner', :'hub_owner', false),
       set_config('zc.hub_app', :'hub_app', false), set_config('zc.host_cluster', :'host_cluster', false),
       set_config('zc.hub_ported', :'hub_ported', false) \g /dev/null
\if :{?hub_limit}
SELECT set_config('zc.hub_limit', :'hub_limit', false) \g /dev/null
\else
SELECT set_config('zc.hub_limit', '', false) \g /dev/null
\endif

DO $check$
DECLARE
  zdb name := current_setting('zc.zold_db');
  hub bool := current_setting('zc.with_hub') = '1';
  hdb name := current_setting('zc.hub_db');
  zroles name[] := ARRAY[current_setting('zc.zold_owner'), current_setting('zc.zold_app')]::name[];
  hroles name[] := ARRAY[current_setting('zc.hub_owner'), current_setting('zc.hub_app')]::name[];
  happ name := current_setting('zc.hub_app');
  want_limit text := current_setting('zc.hub_limit');
  r record;
  bad text;
BEGIN
  -- Each role exists, logs in, and holds none of the cluster-wide powers.
  FOR r IN SELECT x AS name, p.* FROM unnest(zroles || CASE WHEN hub THEN hroles ELSE '{}' END) x
             LEFT JOIN pg_roles p ON p.rolname = x LOOP
    IF r.rolname IS NULL THEN RAISE EXCEPTION 'role % does not exist', r.name; END IF;
    IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR NOT r.rolcanlogin THEN
      RAISE EXCEPTION 'role % has the wrong attributes (superuser, createdb, createrole, replication, bypassrls or nologin)', r.name;
    END IF;
  END LOOP;

  -- CONNECT on a database: only its two roles (superusers bypass it).
  FOR r IN SELECT d, rs FROM (VALUES (zdb, zroles), (CASE WHEN hub THEN hdb END, hroles)) v(d, rs) WHERE d IS NOT NULL LOOP
    SELECT string_agg(coalesce(g.rolname, 'PUBLIC'), ', ') INTO bad
      FROM pg_database db, aclexplode(coalesce(db.datacl, acldefault('d', db.datdba))) a
      LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE db.datname = r.d AND a.privilege_type IN ('CONNECT', 'TEMPORARY')
       AND NOT (a.privilege_type = 'CONNECT' AND coalesce(g.rolname = ANY (r.rs), false))
       AND NOT (a.privilege_type = 'TEMPORARY' AND a.grantee = db.datdba);
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = r.d) THEN RAISE EXCEPTION 'database % does not exist', r.d; END IF;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'database % grants CONNECT or TEMPORARY to %', r.d, bad; END IF;
    IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = r.d) <> r.rs[1] THEN
      RAISE EXCEPTION 'database % is not owned by %', r.d, r.rs[1];
    END IF;
    IF (SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = r.d) <> 'UTF8' THEN
      RAISE EXCEPTION 'database % is not UTF8', r.d;
    END IF;
  END LOOP;
  IF hub THEN
    FOR r IN SELECT a.x AS who, b.y AS db FROM unnest(hroles) a(x), unnest(ARRAY[zdb]) b(y)
             UNION ALL SELECT a.x, hdb FROM unnest(zroles) a(x) LOOP
      IF has_database_privilege(r.who, r.db, 'CONNECT') THEN RAISE EXCEPTION '% may connect to %', r.who, r.db; END IF;
    END LOOP;
  END IF;

  -- Zold's roles hold the reserved slots and nothing else; the hub's hold
  -- no membership at all.
  SELECT string_agg(pg_get_userbyid(member) || ' in ' || pg_get_userbyid(roleid), ', ') INTO bad FROM pg_auth_members
   WHERE (pg_get_userbyid(member) = ANY (zroles) AND pg_get_userbyid(roleid) <> 'pg_use_reserved_connections')
      OR (hub AND (pg_get_userbyid(member) = ANY (hroles) OR pg_get_userbyid(roleid) = ANY (hroles)))
      OR (pg_get_userbyid(roleid) = ANY (zroles));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'unexpected role membership: %', bad; END IF;
  FOR r IN SELECT x FROM unnest(zroles) x LOOP
    IF NOT pg_has_role(r.x, 'pg_use_reserved_connections', 'MEMBER') THEN
      RAISE EXCEPTION '% may not use the reserved connections', r.x;
    END IF;
  END LOOP;

  IF hub THEN
    IF (SELECT rolconnlimit FROM pg_roles WHERE rolname = happ) <> 20 THEN RAISE EXCEPTION '% connection limit is not 20', happ; END IF;
    SELECT string_agg(w, ', ') INTO bad FROM unnest(ARRAY['statement_timeout=5s', 'lock_timeout=2s',
        'idle_in_transaction_session_timeout=10s', 'temp_file_limit=256MB', 'work_mem=4MB']) w
     WHERE NOT EXISTS (SELECT 1 FROM pg_db_role_setting s WHERE s.setrole = happ::regrole AND s.setdatabase = 0
                         AND w = ANY (s.setconfig));
    IF bad IS NOT NULL THEN RAISE EXCEPTION '% is missing its settings: %', happ, bad; END IF;
    IF EXISTS (SELECT 1 FROM pg_db_role_setting WHERE setrole = happ::regrole AND setdatabase <> 0) THEN
      RAISE EXCEPTION '% has per-database settings that override its role settings', happ;
    END IF;
    SELECT datconnlimit::text INTO bad FROM pg_database WHERE datname = hdb;
    IF want_limit <> '' AND bad <> want_limit THEN
      RAISE EXCEPTION 'hub connection limit is %, expected %', bad, want_limit;
    ELSIF want_limit = '' AND bad NOT IN ('25', '0') THEN
      RAISE EXCEPTION 'hub connection limit is %, expected 25 (or 0 while stopped)', bad;
    ELSIF bad = '0' THEN
      RAISE NOTICE 'hub is stopped (CONNECTION LIMIT 0)';
    END IF;
  END IF;

  IF current_setting('zc.host_cluster') = '1' THEN
    IF current_setting('listen_addresses') <> '' THEN RAISE EXCEPTION 'listen_addresses is %, must be empty', current_setting('listen_addresses'); END IF;
    IF current_setting('reserved_connections')::int < 10 THEN RAISE EXCEPTION 'reserved_connections is under 10'; END IF;
    IF current_setting('server_encoding') <> 'UTF8' THEN RAISE EXCEPTION 'the cluster is not UTF8'; END IF;
    -- The email key's \u escapes and lower() depend on a UTF-8 locale (0003).
    SELECT string_agg(format('%s (%s, %s)', datname, datctype, datcollate), ', ') INTO bad FROM pg_database
     WHERE datname IN ('template1', zdb, CASE WHEN hub THEN hdb END) AND (datctype !~* 'utf-?8' OR datcollate !~* 'utf-?8');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'not a UTF-8 locale: %', bad; END IF;
    IF current_setting('archive_mode') <> 'on' OR current_setting('archive_timeout') <> '1min' THEN
      RAISE EXCEPTION 'archiving is not on with archive_timeout 60s';
    END IF;
    SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles WHERE rolsuper AND rolname <> current_user;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'other superusers: %', bad; END IF;
  END IF;
END
$check$;

-- Per database: no dblink or postgres_fdw anywhere, and what each role owns.
\connect :"zold_db"
SELECT set_config('zc.zold_app', :'zold_app', false) \g /dev/null
DO $check$
DECLARE
  app name := current_setting('zc.zold_app');
  bad text;
BEGIN
  SELECT string_agg(extname, ', ') INTO bad FROM pg_extension WHERE extname IN ('dblink', 'postgres_fdw');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '% installed in %', bad, current_database(); END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = app::regrole) OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = app::regrole)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = app::regrole) THEN
    RAISE EXCEPTION '% owns objects in %', app, current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(app, oid, 'CREATE')) THEN
    RAISE EXCEPTION '% may create in a schema of %', app, current_database();
  END IF;
  -- Once migrated: the application role has exactly the grants of
  -- zold_grant_app (§5), checked by running it and comparing; rolled back.
  IF to_regprocedure('zold_grant_app(name)') IS NOT NULL THEN
    CREATE TEMP TABLE zc_grants ON COMMIT DROP AS
      SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = app;
    PERFORM zold_grant_app(app);
    SELECT string_agg(format('%s %s.%s %s', w, table_schema, table_name, privilege_type), ', ') INTO bad FROM (
      (SELECT 'extra' AS w, * FROM zc_grants
        EXCEPT SELECT 'extra', table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = app)
      UNION ALL
      (SELECT 'missing', table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = app
        EXCEPT SELECT 'missing', * FROM zc_grants)) d;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'the grants of % are not those of zold_grant_app: %', app, bad;
    END IF;
    IF has_database_privilege(app, current_database(), 'TEMPORARY') THEN RAISE EXCEPTION '% may create temporary tables', app; END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZC000', MESSAGE = 'rollback';
  END IF;
EXCEPTION WHEN SQLSTATE 'ZC000' THEN NULL;
END
$check$;

\if :with_hub
\connect :"hub_db"
SELECT set_config('zc.hub_app', :'hub_app', false), set_config('zc.hub_ported', :'hub_ported', false) \g /dev/null
DO $check$
DECLARE
  app name := current_setting('zc.hub_app');
  bad text;
BEGIN
  SELECT string_agg(extname, ', ') INTO bad FROM pg_extension WHERE extname IN ('dblink', 'postgres_fdw');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '% installed in %', bad, current_database(); END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = app::regrole) OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = app::regrole) THEN
    RAISE EXCEPTION '% owns objects in %', app, current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(app, oid, 'CREATE')) THEN
    RAISE EXCEPTION '% may create in a schema of %', app, current_database();
  END IF;
  IF current_setting('zc.hub_ported') <> '1' THEN
    SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r', 'p', 'v', 'm', 'S');
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'hub is not ported yet (S9) but holds %', bad; END IF;
  END IF;
END
$check$;
\endif

\connect postgres
\echo 'checks passed'

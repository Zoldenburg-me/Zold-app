-- The provisioning script's database step (docs/postgres-store-design.md §7,
-- §7.1, §7.2): the roles, the databases, the CONNECT grants and the limits.
-- Run by the cluster's OS user, the bootstrap superuser, connected to
-- `postgres`, with psql -v ON_ERROR_STOP=1 and these variables:
--
--   zold_db zold_owner zold_app        Zold's database and its two roles
--   with_hub (0|1)                     whether this cluster holds the hub
--   hub_db hub_owner hub_app           the hub's database and its two roles
--   hub_conn_limit                     the provisioned limit on hub (25)
--   maintenance_dbs (0|1)              also take CONNECT on postgres and
--                                      template1 from PUBLIC (a host cluster;
--                                      not on a shared test server)
--   hub_limit (optional)               set hub's limit to exactly this; the
--                                      hub-only restore passes the limit it
--                                      recorded before the restore (§7.2)
--
-- Idempotent: a re-run changes nothing that is already right. It also runs
-- after every pg_restore, because a restore without --create carries no
-- database-level settings (§7.1). It never lifts a hub write stop: a hub at
-- CONNECTION LIMIT 0 stays at 0 unless hub_limit says otherwise (a database
-- this step never opened, from a first run cut short, is opened).
--
-- Pinned settings (§7.2). temp_file_limit is superuser-only, so the
-- ALTER ROLE value below is a cap hub_app cannot raise. statement_timeout,
-- lock_timeout, idle_in_transaction_session_timeout and work_mem are
-- user-settable in Postgres: no grant can stop a session's own SET (REVOKE
-- SET ON PARAMETER applies only to superuser-only settings). The ALTER ROLE
-- values are the defaults every hub_app login starts with (S9's pool sets
-- them per connection too); the bound behind the two timeouts is
-- watchdog.sql, which as superuser ends any hub_app session past twice its
-- statement or idle-in-transaction timeout. work_mem has no server-side bound:
-- hub_app runs only the hub's own SQL (agents send HTTP, not SQL), so raising
-- it takes a change to the hub's code, reviewed in S9, and hub_app has at most
-- 20 connections.

\set ON_ERROR_STOP 1
SET client_min_messages = warning;

-- Roles. LOGIN for all four: each is reached by peer authentication as its
-- OS user (§7), never with a password. None may create roles or databases.
SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY[:'zold_owner', :'zold_app']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE :"zold_owner" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
ALTER ROLE :"zold_app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
-- reserved_connections (postgresql.conf, 10) is for these two: a hub flood
-- cannot lock the API or the deploy out of max_connections.
GRANT pg_use_reserved_connections TO :"zold_owner", :"zold_app";

SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'zold_db') AS zold_new \gset
\if :zold_new
CREATE DATABASE :"zold_db" OWNER :"zold_owner" ENCODING 'UTF8' TEMPLATE template0;
\endif
ALTER DATABASE :"zold_db" OWNER TO :"zold_owner";
-- PUBLIC gets CONNECT and TEMP on a new database; neither stays.
REVOKE ALL ON DATABASE :"zold_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"zold_db" TO :"zold_owner", :"zold_app";

\if :with_hub
SELECT format('CREATE ROLE %I', r) FROM unnest(ARRAY[:'hub_owner', :'hub_app']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE :"hub_owner" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
ALTER ROLE :"hub_app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL CONNECTION LIMIT 20;
ALTER ROLE :"hub_app" SET statement_timeout = '5s';
ALTER ROLE :"hub_app" SET lock_timeout = '2s';
ALTER ROLE :"hub_app" SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE :"hub_app" SET temp_file_limit = '256MB';
ALTER ROLE :"hub_app" SET work_mem = '4MB';

-- A new hub is created closed (limit 0, no PUBLIC CONNECT) and opened only
-- at the end of this step, so no hub_app session sees it half made.
SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'hub_db') AS hub_new \gset
\if :hub_new
CREATE DATABASE :"hub_db" OWNER :"hub_owner" ENCODING 'UTF8' TEMPLATE template0 CONNECTION LIMIT 0;
\endif
ALTER DATABASE :"hub_db" OWNER TO :"hub_owner";
REVOKE ALL ON DATABASE :"hub_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"hub_db" TO :"hub_owner", :"hub_app";

\if :{?hub_limit}
SELECT :'hub_limit'::int AS hub_final \gset
\elif :hub_new
SELECT :'hub_conn_limit'::int AS hub_final \gset
\else
-- A 0 on a hub this step has opened before (its comment says so) is a write
-- stop and stays. A 0 on one it never opened is a first run that failed
-- before the end, and is opened now.
SELECT CASE WHEN d.datconnlimit = 0 AND c.description IS NOT NULL THEN 0 ELSE :'hub_conn_limit'::int END AS hub_final,
       d.datconnlimit = 0 AND c.description IS NOT NULL AS hub_stopped
  FROM pg_database d LEFT JOIN pg_shdescription c ON c.objoid = d.oid AND c.classoid = 'pg_database'::regclass
 WHERE d.datname = :'hub_db' \gset
\if :hub_stopped
\echo 'hub is stopped (CONNECTION LIMIT 0): left as it is; the owner lifts it by hand (§7.2)'
\endif
\endif
ALTER DATABASE :"hub_db" CONNECTION LIMIT :hub_final;
COMMENT ON DATABASE :"hub_db" IS 'opened by scripts/oracle-host/database.sql';
\endif

\if :maintenance_dbs
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
\endif

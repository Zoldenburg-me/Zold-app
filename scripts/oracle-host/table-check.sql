-- The table check (docs/postgres-store-design.md §7): per table, the row
-- count and a SHA-256 over every row as to_jsonb(row)::text, the rows sorted
-- by that text COLLATE "C". It needs no primary key and no btree order on a
-- json column, and it fits every table (documents, payment_handles,
-- schema_migrations, outbox, ledger_history, cap_holds, pending_executions,
-- the hub's).
--
-- One line per table, sorted: "<schema>.<table> <rows> <sha256>". The same
-- rows print the same lines on the live host, a drill instance and a fresh
-- initdb: the session settings below fix the text form of timestamps,
-- intervals, floats and bytea, and COLLATE "C" fixes the order. Run as the
-- cluster's OS user, read-only (pgops.sh runs it inside the dump's own
-- REPEATABLE READ snapshot):
--
--   psql -X -q -At -d <db> -f table-check.sql
--
-- shortcut: each table's text is aggregated in memory, so a table past 1 GB of
-- row text fails the check (it does not pass wrongly); move to a running hash
-- when one gets near that.

SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET IntervalStyle = 'postgres';
SET extra_float_digits = 1;
SET bytea_output = 'hex';
SELECT format(
  $q$SELECT %L || ' ' || count(*) || ' ' || encode(sha256(convert_to(coalesce(string_agg(r, E'\n' ORDER BY r COLLATE "C"), ''), 'UTF8')), 'hex') FROM (SELECT to_jsonb(zold_row.*)::text AS r FROM %I.%I zold_row) s$q$,
  n.nspname || '.' || c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_'
 ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C" \gexec

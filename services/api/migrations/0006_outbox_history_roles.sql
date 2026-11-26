-- The outbox, the ledger's history, the rows the database will not let go,
-- and the application role's grants (docs/postgres-store-design.md §5).

-- Notifications written in the same transaction as the change they report
-- (outbox.ts). `id` is the receiver's idempotency key; `key`, when set, keeps
-- a second row for the same event out. A worker claims due rows with
-- FOR UPDATE SKIP LOCKED until `claimed_until`, counting the attempt.
CREATE TABLE outbox (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL,
  key text UNIQUE,
  payload json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  delivered_at timestamptz,
  dead_at timestamptz,
  last_error text
);
CREATE INDEX outbox_due ON outbox (next_attempt_at, seq) WHERE delivered_at IS NULL AND dead_at IS NULL;
CREATE INDEX outbox_delivered_at ON outbox (delivered_at) WHERE delivered_at IS NOT NULL;

-- Every change of a ledger row keeps the row as it was. The books can change;
-- the change cannot be hidden. Written by the trigger only: the application
-- role may read it and nothing else.
CREATE TABLE ledger_history (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id text NOT NULL,
  org_id text,
  doc json NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_history_entry ON ledger_history (entry_id, seq);

-- SECURITY DEFINER: it runs as the owner role, which may insert into
-- ledger_history; the application role may not. The search path is the
-- migration's, so the function cannot be pointed at another table.
CREATE FUNCTION zold_keep_ledger_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO ledger_history (entry_id, org_id, doc) VALUES (OLD.id, OLD.org_id, OLD.doc);
  RETURN NEW;
END
$$;
-- json has no equality: a save that writes the same text is not a change.
CREATE TRIGGER ledger_keep_history AFTER UPDATE ON ledger
  FOR EACH ROW WHEN (OLD.doc::text IS DISTINCT FROM NEW.doc::text OR OLD.id IS DISTINCT FROM NEW.id)
  EXECUTE FUNCTION zold_keep_ledger_history();

-- Refused for every role, the owner too: no store method deletes these rows
-- (store.ts), and the database holds it as well.
CREATE FUNCTION zold_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is refused: these rows are kept', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER organisations_no_delete BEFORE DELETE ON organisations FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER organisations_no_truncate BEFORE TRUNCATE ON organisations FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON accounts FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER invoices_no_truncate BEFORE TRUNCATE ON invoices FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON documents FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER transfers_no_delete BEFORE DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER transfers_no_truncate BEFORE TRUNCATE ON transfers FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();
-- Append-only: neither changed nor deleted.
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER ledger_history_append_only BEFORE UPDATE OR DELETE ON ledger_history FOR EACH ROW EXECUTE FUNCTION zold_refuse_change();
CREATE TRIGGER ledger_history_no_truncate BEFORE TRUNCATE ON ledger_history FOR EACH STATEMENT EXECUTE FUNCTION zold_refuse_change();

-- The application role's grants, least privilege, run by the owner role at
-- deploy after the migrations: `SELECT zold_grant_app('<role>')`. It resets
-- the role's table grants in this schema, so running it again after a new
-- migration grants the new tables too. No DDL: the role owns nothing and may
-- not create in the schema. Never TRUNCATE. Reads only on schema_migrations
-- (assertSchemaCurrent) and ledger_history; SELECT and INSERT only on audit;
-- no DELETE on the tables whose rows are kept.
CREATE FUNCTION zold_grant_app(app name) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  s name := current_schema();
  t name;
  kept name[] := ARRAY['ledger', 'organisations', 'accounts', 'invoices', 'documents', 'transfers'];
BEGIN
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, app);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, app);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s, app);
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', s);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, app);
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = s LOOP
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

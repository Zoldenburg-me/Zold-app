-- The store's collections, one table each (docs/postgres-store-design.md §1).
--
-- `doc` is the row exactly as the JSON backend holds it. Every key column is
-- GENERATED from `doc`, so it cannot disagree with it. `seq` is the row's
-- position in the JSON array (insertion order): a store method that returns
-- "the first match" reads ORDER BY seq. Ids stay the text ids the code mints.
--
-- Timestamps stay ISO text inside `doc`: a cast to timestamptz depends on the
-- session's time zone, so Postgres refuses it in a generated column.
--
-- Unique keys are the ones today's store methods already rely on. Foreign
-- keys, and the unique keys §2 gives to a later slice (one account per
-- address, invoice numbers, one transfer per quote, one GRACE_PERIOD
-- recovery per user), come with the importer's duplicate and orphan report
-- (S5) or with that slice.

CREATE TABLE users (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  address_lc text GENERATED ALWAYS AS (lower(doc->>'address')) STORED,
  safe_address_lc text GENERATED ALWAYS AS (lower(doc->'passkeySafe'->>'address')) STORED,
  credential_id text GENERATED ALWAYS AS (doc->'passkey'->>'credentialId') STORED,
  email_lc text GENERATED ALWAYS AS (lower(regexp_replace(doc->>'email', '^\s+|\s+$', '', 'g'))) STORED,
  page_handle text GENERATED ALWAYS AS (doc->'paymentPage'->>'handle') STORED,
  iban_bare text GENERATED ALWAYS AS (upper(regexp_replace(doc->>'iban', '\s', '', 'g'))) STORED
);
CREATE UNIQUE INDEX users_credential_id ON users (credential_id);
CREATE UNIQUE INDEX users_page_handle ON users (lower(page_handle));
CREATE INDEX users_address_lc ON users (address_lc);
CREATE INDEX users_safe_address_lc ON users (safe_address_lc);
CREATE INDEX users_email_lc ON users (email_lc);
CREATE INDEX users_iban_bare ON users (iban_bare);

-- A user's and an organisation's payment pages share one namespace, and
-- /pay/:handle tries the user first: the key refuses a second claim from
-- either table (§1.2).
CREATE TABLE payment_handles (
  handle_lc text PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('user', 'organisation')),
  owner_id text NOT NULL
);
CREATE INDEX payment_handles_owner ON payment_handles (owner_kind, owner_id);

CREATE TABLE quotes (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  status text GENERATED ALWAYS AS (doc->>'status') STORED,
  expires_at text GENERATED ALWAYS AS (doc->>'expiresAt') STORED
);
CREATE INDEX quotes_user_id ON quotes (user_id);
CREATE INDEX quotes_status_expires ON quotes (status, expires_at);

CREATE TABLE transfers (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  quote_id text GENERATED ALWAYS AS (doc->>'quoteId') STORED,
  state text GENERATED ALWAYS AS (doc->>'state') STORED,
  created_at text GENERATED ALWAYS AS (doc->>'createdAt') STORED
);
CREATE INDEX transfers_user_id ON transfers (user_id);
CREATE INDEX transfers_quote_id ON transfers (quote_id);
CREATE INDEX transfers_state ON transfers (state);
CREATE INDEX transfers_created_at ON transfers (created_at);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  token_hash text GENERATED ALWAYS AS (doc->>'tokenHash') STORED,
  expires_at text GENERATED ALWAYS AS (doc->>'expiresAt') STORED
);
CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash);
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

CREATE TABLE operators (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  email text GENERATED ALWAYS AS (doc->>'email') STORED
);
CREATE UNIQUE INDEX operators_email_lc ON operators (lower(email));

-- The operator's `credentials` stay in its doc; this table is their key,
-- written in the same transaction as every operator write, so one passkey
-- cannot belong to two operators.
CREATE TABLE operator_credentials (
  credential_id text PRIMARY KEY,
  operator_id text NOT NULL
);
CREATE INDEX operator_credentials_operator_id ON operator_credentials (operator_id);

CREATE TABLE operator_sessions (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  operator_id text GENERATED ALWAYS AS (doc->>'operatorId') STORED,
  token_hash text GENERATED ALWAYS AS (doc->>'tokenHash') STORED
);
CREATE UNIQUE INDEX operator_sessions_token_hash ON operator_sessions (token_hash);
CREATE INDEX operator_sessions_operator_id ON operator_sessions (operator_id);

CREATE TABLE service_credentials (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  service text GENERATED ALWAYS AS (doc->>'service') STORED
);
CREATE INDEX service_credentials_service ON service_credentials (service);

CREATE TABLE receipt_shares (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  slug text GENERATED ALWAYS AS (doc->>'slug') STORED,
  transfer_id text GENERATED ALWAYS AS (doc->>'transferId') STORED,
  revoked_at text GENERATED ALWAYS AS (doc->>'revokedAt') STORED
);
CREATE UNIQUE INDEX receipt_shares_slug ON receipt_shares (slug);
CREATE UNIQUE INDEX receipt_shares_live ON receipt_shares (transfer_id) WHERE revoked_at IS NULL;
CREATE INDEX receipt_shares_transfer_id ON receipt_shares (transfer_id);

CREATE TABLE documents (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  code text GENERATED ALWAYS AS (doc->>'code') STORED,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED
);
CREATE UNIQUE INDEX documents_code ON documents (code);
CREATE INDEX documents_user_id ON documents (user_id);
CREATE INDEX documents_org_id ON documents (org_id);

CREATE TABLE payment_requests (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  code text GENERATED ALWAYS AS (doc->>'code') STORED,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  state text GENERATED ALWAYS AS (doc->>'state') STORED,
  source_kind text GENERATED ALWAYS AS (doc->'source'->>'kind') STORED,
  source_shop text GENERATED ALWAYS AS (doc->'source'->>'shop') STORED,
  source_external_id text GENERATED ALWAYS AS (doc->'source'->>'externalId') STORED
);
CREATE UNIQUE INDEX payment_requests_code ON payment_requests (code);
CREATE UNIQUE INDEX payment_requests_source ON payment_requests (source_kind, source_shop, source_external_id);
CREATE INDEX payment_requests_user_id ON payment_requests (user_id);
CREATE INDEX payment_requests_state ON payment_requests (state);

CREATE TABLE shopify_connections (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  shop text GENERATED ALWAYS AS (doc->>'shop') STORED,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED
);
CREATE UNIQUE INDEX shopify_connections_shop ON shopify_connections (shop);
CREATE INDEX shopify_connections_org_id ON shopify_connections (org_id);

CREATE TABLE shopify_deliveries (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  at text GENERATED ALWAYS AS (doc->>'at') STORED
);
CREATE INDEX shopify_deliveries_at ON shopify_deliveries (at);

CREATE TABLE merchant_links (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  shop text GENERATED ALWAYS AS (doc->>'shop') STORED,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  revoked_at text GENERATED ALWAYS AS (doc->>'revokedAt') STORED
);
CREATE UNIQUE INDEX merchant_links_live_shop ON merchant_links (shop) WHERE revoked_at IS NULL;
CREATE INDEX merchant_links_org_id ON merchant_links (org_id);

CREATE TABLE processed_monerium_orders (
  order_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processed_monerium_webhooks (
  webhook_id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE monerium_issue_orders (
  order_id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  account_id text GENERATED ALWAYS AS (doc->>'accountId') STORED
);
CREATE INDEX monerium_issue_orders_user_id ON monerium_issue_orders (user_id);
CREATE INDEX monerium_issue_orders_account_id ON monerium_issue_orders (account_id);

CREATE TABLE conversion_sweeps (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED
);
CREATE INDEX conversion_sweeps_user_id ON conversion_sweeps (user_id);

CREATE TABLE crypto_deposits (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  chain_id text GENERATED ALWAYS AS (doc->>'chainId') STORED,
  tx_hash_lc text GENERATED ALWAYS AS (lower(doc->>'txHash')) STORED,
  log_index integer GENERATED ALWAYS AS ((doc->>'logIndex')::integer) STORED,
  holding text GENERATED ALWAYS AS (doc->>'holding') STORED,
  invoice_id text GENERATED ALWAYS AS (doc->>'invoiceId') STORED,
  payment_request_id text GENERATED ALWAYS AS (doc->>'paymentRequestId') STORED
);
CREATE UNIQUE INDEX crypto_deposits_chain_tx_log ON crypto_deposits (chain_id, tx_hash_lc, log_index);
CREATE INDEX crypto_deposits_tx_log ON crypto_deposits (tx_hash_lc, log_index);
CREATE INDEX crypto_deposits_user_id ON crypto_deposits (user_id);
CREATE INDEX crypto_deposits_holding ON crypto_deposits (holding);
CREATE INDEX crypto_deposits_invoice_id ON crypto_deposits (invoice_id);
CREATE INDEX crypto_deposits_payment_request_id ON crypto_deposits (payment_request_id);

CREATE TABLE crypto_sends (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  state text GENERATED ALWAYS AS (doc->>'state') STORED,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED
);
CREATE INDEX crypto_sends_user_id ON crypto_sends (user_id);
CREATE INDEX crypto_sends_state ON crypto_sends (state);
CREATE INDEX crypto_sends_org_id ON crypto_sends (org_id);

CREATE TABLE audit (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  at text GENERATED ALWAYS AS (doc->>'at') STORED
);
CREATE INDEX audit_user_id ON audit (user_id, seq);
CREATE INDEX audit_at ON audit (at);

CREATE TABLE recovery_requests (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  mode text GENERATED ALWAYS AS (doc->>'mode') STORED,
  status text GENERATED ALWAYS AS (doc->>'status') STORED
);
CREATE INDEX recovery_requests_user_id ON recovery_requests (user_id);
CREATE INDEX recovery_requests_status ON recovery_requests (status);

CREATE TABLE safe_ops (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  state text GENERATED ALWAYS AS (doc->>'state') STORED
);
CREATE INDEX safe_ops_org_id ON safe_ops (org_id);
CREATE INDEX safe_ops_state ON safe_ops (state);

CREATE TABLE crypto_deposit_cursor (
  chain_key text PRIMARY KEY,
  block numeric NOT NULL
);

CREATE TABLE organisations (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  page_handle text GENERATED ALWAYS AS (doc->'paymentPage'->>'handle') STORED
);
CREATE UNIQUE INDEX organisations_page_handle ON organisations (lower(page_handle));

CREATE TABLE members (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  user_id text GENERATED ALWAYS AS (doc->>'userId') STORED,
  status text GENERATED ALWAYS AS (doc->>'status') STORED,
  invite_token_hash text GENERATED ALWAYS AS (doc->'invite'->>'tokenHash') STORED
);
CREATE UNIQUE INDEX members_invite_token_hash ON members (invite_token_hash);
CREATE UNIQUE INDEX members_live ON members (org_id, user_id) WHERE status <> 'deactivated';
CREATE INDEX members_org_id ON members (org_id);
CREATE INDEX members_user_id ON members (user_id);

CREATE TABLE accounts (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  address_lc text GENERATED ALWAYS AS (lower(doc->>'address')) STORED,
  backing_user_id text GENERATED ALWAYS AS (doc->>'backingUserId') STORED
);
CREATE INDEX accounts_org_id ON accounts (org_id);
CREATE INDEX accounts_address_lc ON accounts (address_lc);
CREATE INDEX accounts_backing_user_id ON accounts (backing_user_id);

CREATE TABLE imported_wallets (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED
);
CREATE INDEX imported_wallets_org_id ON imported_wallets (org_id);

CREATE TABLE contacts (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED
);
CREATE INDEX contacts_org_id ON contacts (org_id);

CREATE TABLE drafts (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  state text GENERATED ALWAYS AS (doc->>'state') STORED
);
CREATE INDEX drafts_org_id ON drafts (org_id);
CREATE INDEX drafts_state ON drafts (state);

CREATE TABLE invoices (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  state text GENERATED ALWAYS AS (doc->>'state') STORED,
  link_token_hash text GENERATED ALWAYS AS (doc->>'linkTokenHash') STORED,
  number text GENERATED ALWAYS AS (doc->'issued'->>'number') STORED
);
CREATE UNIQUE INDEX invoices_link_token_hash ON invoices (link_token_hash);
CREATE INDEX invoices_org_id ON invoices (org_id);
CREATE INDEX invoices_state ON invoices (state);
CREATE INDEX invoices_org_number ON invoices (org_id, number);

CREATE TABLE chart_accounts (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  code text GENERATED ALWAYS AS (doc->>'code') STORED
);
CREATE UNIQUE INDEX chart_accounts_org_code ON chart_accounts (org_id, code);

CREATE TABLE account_rules (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED
);
CREATE INDEX account_rules_org_id ON account_rules (org_id);

CREATE TABLE ledger (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  org_id text GENERATED ALWAYS AS (doc->>'orgId') STORED,
  tx_hash_lc text GENERATED ALWAYS AS (lower(doc->>'txHash')) STORED,
  statement_key text GENERATED ALWAYS AS (doc->'statement'->>'key') STORED
);
CREATE UNIQUE INDEX ledger_org_statement_key ON ledger (org_id, statement_key) WHERE statement_key IS NOT NULL;
CREATE INDEX ledger_org_id ON ledger (org_id);
CREATE INDEX ledger_tx_hash_lc ON ledger (tx_hash_lc);

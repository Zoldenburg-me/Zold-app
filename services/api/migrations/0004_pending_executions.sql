-- Approvals waiting for a passkey (docs/postgres-store-design.md §2): a
-- transfer's or a crypto send's prepared UserOperation, its challenge and its
-- plan, until the passkey approves it. In memory before, so a restart answered
-- the approval 410. The claim that submits one deletes it in the same
-- transaction; expired rows are pruned when the next one is written.
CREATE TABLE pending_executions (
  kind text NOT NULL CHECK (kind IN ('transfer', 'cryptoSend')),
  id text NOT NULL,
  user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  doc json NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX pending_executions_expires_at ON pending_executions (expires_at);

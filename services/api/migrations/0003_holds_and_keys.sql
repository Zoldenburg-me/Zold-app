-- Cap holds in the database, and the unique keys §2 gives to S3
-- (docs/postgres-store-design.md §1.2, §2).

-- Part of a daily cap held for a transfer or crypto send still being
-- prepared (store.holdDailyCap). A hold is counted only until `expires_at`:
-- one left by a process that died is ignored by the sum, then pruned.
CREATE TABLE cap_holds (
  id text PRIMARY KEY,
  cap_key text NOT NULL,
  day text NOT NULL,
  eur numeric NOT NULL CHECK (eur >= 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX cap_holds_key_day ON cap_holds (cap_key, day);
CREATE INDEX cap_holds_expires_at ON cap_holds (expires_at);

-- One transfer per quote, whatever the code does: the quote is the terms.
DROP INDEX transfers_quote_id;
CREATE UNIQUE INDEX transfers_quote_id ON transfers (quote_id);

-- One account per company Safe (no backing user): two would book its money
-- twice (bookkeeping/money-in.ts reports them as unbookable). A person's Safe
-- may back several accounts, their personal one and their sole-trader
-- business's, so those are not in the key; routes/orgs.ts keeps a person's
-- Safe to one business under a lock.
CREATE UNIQUE INDEX accounts_address_unbacked ON accounts (address_lc) WHERE backing_user_id IS NULL;

-- One Zoldenburg recovery in its grace period per user.
CREATE UNIQUE INDEX recovery_requests_one_grace ON recovery_requests (user_id) WHERE mode = 'zoldenburg' AND status = 'GRACE_PERIOD';

-- The email key trims what JavaScript's String.prototype.trim() trims
-- (WhiteSpace and LineTerminator: TAB, LF, VT, FF, CR, SPACE, NBSP, the Zs
-- spaces, LS, PS, BOM), so it matches store.usersByEmail. `\s` alone misses
-- NBSP and the Unicode spaces.
ALTER TABLE users ALTER COLUMN email_lc SET EXPRESSION AS (
  lower(regexp_replace(doc->>'email', '^[\u0009-\u000d    -     　﻿]+|[\u0009-\u000d    -     　﻿]+$', '', 'g'))
);

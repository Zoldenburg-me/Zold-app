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

-- One account per address: two accounts at one Safe would book its money
-- twice (bookkeeping/money-in.ts reports them as unbookable).
DROP INDEX accounts_address_lc;
CREATE UNIQUE INDEX accounts_address_lc ON accounts (address_lc);

-- One Zoldenburg recovery in its grace period per user.
CREATE UNIQUE INDEX recovery_requests_one_grace ON recovery_requests (user_id) WHERE mode = 'zoldenburg' AND status = 'GRACE_PERIOD';

-- The email key trims what JavaScript's String.prototype.trim() trims
-- (WhiteSpace and LineTerminator: TAB, LF, VT, FF, CR, SPACE, NBSP, the Zs
-- spaces, LS, PS, BOM), so it matches store.usersByEmail. `\s` alone misses
-- NBSP and the Unicode spaces.
ALTER TABLE users ALTER COLUMN email_lc SET EXPRESSION AS (
  lower(regexp_replace(doc->>'email', '^[\u0009-\u000d    -     　﻿]+|[\u0009-\u000d    -     　﻿]+$', '', 'g'))
);

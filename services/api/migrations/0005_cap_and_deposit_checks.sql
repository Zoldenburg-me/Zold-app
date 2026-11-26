-- Database-side backing for two checks store/rules.ts makes before a write
-- (assertCapAmounts, assertDepositKey).

-- 'NaN'::numeric sorts above every number, so it passes `eur >= 0`; one NaN
-- hold would make the cap's sum NaN and every later cap check pass.
ALTER TABLE cap_holds ADD CONSTRAINT cap_holds_eur_finite CHECK (eur <> 'NaN');

-- A deposit's idempotency key is (chain_id, tx_hash_lc, log_index). A NULL
-- log_index is distinct from every other in the unique index, so the same
-- on-chain transfer could be inserted twice.
ALTER TABLE crypto_deposits ALTER COLUMN log_index SET NOT NULL;

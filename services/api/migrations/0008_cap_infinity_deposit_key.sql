-- The rest of what 0005 backs (store/rules.ts assertCapAmounts,
-- assertDepositKey).

-- Postgres numeric has 'Infinity', which passes `eur >= 0` and `<> 'NaN'`.
-- One such hold would make the cap's sum Infinity and refuse every later
-- send: a denial of the cap, not a bypass, but not a number either.
ALTER TABLE cap_holds ADD CONSTRAINT cap_holds_eur_not_infinite CHECK (eur <> 'Infinity');

-- The other two columns of the deposit key: a NULL in either is as distinct
-- in the unique index as a NULL log_index (0005).
ALTER TABLE crypto_deposits ALTER COLUMN chain_id SET NOT NULL;
ALTER TABLE crypto_deposits ALTER COLUMN tx_hash_lc SET NOT NULL;

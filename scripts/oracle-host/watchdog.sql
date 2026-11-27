-- The hub watchdog (pgops.sh <dep>-watchdog, every 10 s, as the cluster's OS
-- user): hub_app's statement_timeout and idle_in_transaction_session_timeout
-- are user-settable (database.sql), so this is the bound a session cannot
-- lift. Ends any hub_app session running one statement for over 10 s or idle
-- in a transaction for over 20 s (twice its 5 s and 10 s), and prints how many.
--
--   psql -X -q -At -v hub_app=hub_app -f watchdog.sql
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
 WHERE usename = :'hub_app' AND backend_type = 'client backend'
   AND ((state = 'active' AND now() - query_start > interval '10 seconds')
     OR (state LIKE 'idle in transaction%' AND now() - state_change > interval '20 seconds'));

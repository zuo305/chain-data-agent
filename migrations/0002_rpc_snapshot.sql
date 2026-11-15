-- Last good raw JSON-RPC answers, written by the cron trigger every 10
-- minutes and read only when every RPC endpoint refuses and the edge cache of
-- the serving location has nothing. One row per method and params; the body
-- is the endpoint's response text, stored unparsed to save CPU.
CREATE TABLE IF NOT EXISTS rpc_snapshot (
  call_key TEXT PRIMARY KEY,        -- method + JSON params, see snapshotKey()
  fetched_at INTEGER NOT NULL,      -- ms since epoch
  body TEXT NOT NULL                -- JSON-RPC response text
) WITHOUT ROWID;

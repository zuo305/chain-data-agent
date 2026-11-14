-- Platform tables shared by every dataset: request log, partner API keys,
-- free MCP call counters and data requests. Consolidated from the schema of
-- agent-data-platform as of 2026-11 (usage_log has no secondary indexes on
-- purpose: index writes count against D1's daily write limit).

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  path TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  caller_type TEXT NOT NULL,     -- human | agent | bot | unknown
  caller_name TEXT,              -- e.g. ClaudeBot, GPTBot
  tier TEXT NOT NULL,            -- free | api_key | x402
  wants_markdown INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  user_agent TEXT,
  detail TEXT,
  api_key_id INTEGER,
  referer_host TEXT,
  client_id TEXT,
  -- Sampled rows stand for this many requests; stats sum weight, not rows
  weight INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS mcp_free_calls (
  day TEXT NOT NULL,      -- yyyy-mm-dd (UTC)
  client TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (day, client)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS data_request (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  request TEXT NOT NULL,
  use_case TEXT,
  channel TEXT NOT NULL,            -- mcp or http
  caller_name TEXT,
  client_id TEXT
);

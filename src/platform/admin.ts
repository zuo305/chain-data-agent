import { Hono } from "hono";
import type { AppEnv } from "../types";
import { createApiKey, listApiKeys, revokeApiKey } from "./apikeys";

// Owner endpoints: usage statistics and API key management. Protected by the
// ADMIN_TOKEN secret (Authorization: Bearer <token>); returns 404 when it is
// not set. Queries scan usage_log, so keep these endpoints private. Request
// counts sum usage_log.weight, since bot requests are logged as a sample.

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// usage_log has no ts index (each index would add a row write per request),
// but ids grow with ts, so the first id inside a time window is found by
// binary search on the primary key: about 20 one-row reads instead of a scan
// of the whole table per stats query.
export async function firstIdSince(db: D1Database, modifier: string): Promise<number> {
  const bounds = await db
    .prepare("SELECT datetime('now', ?) AS cutoff, MIN(id) AS lo, MAX(id) AS hi FROM usage_log")
    .bind(modifier)
    .first<{ cutoff: string; lo: number | null; hi: number | null }>();
  if (!bounds || bounds.lo === null || bounds.hi === null) return 0;
  const tsAtOrAfter = db.prepare("SELECT id, ts FROM usage_log WHERE id >= ? ORDER BY id LIMIT 1");
  let lo = bounds.lo;
  let hi = bounds.hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const row = await tsAtOrAfter.bind(mid).first<{ id: number; ts: string }>();
    if (row && row.ts < bounds.cutoff) lo = row.id + 1;
    else hi = mid;
  }
  return lo;
}

// The anonymous id is a keyed hash of the network address, so the funnel
// counts network identifiers, not people: unrelated clients behind one
// shared egress look like one returning id, and one client on two networks
// looks like two. Each rate is given with its numerator and denominator.
const FUNNEL_NOTE =
  "Counts anonymous network identifiers (keyed hash of the address, IPv6 by /64) with no bot request, not people: " +
  "clients sharing an egress merge, and a client on another network counts as new. Returning = seen on another UTC day.";

function rate(numerator: number, denominator: number): string {
  return `${numerator}/${denominator} (${denominator ? Math.round((numerator / denominator) * 100) : 0}%)`;
}

export function networkIdFunnel(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const n = (key: string) => Number(row[key] ?? 0);
  const total = n("network_ids");
  return {
    ...Object.fromEntries(Object.keys(row).map((key) => [key, n(key)])),
    rates: {
      tool: rate(n("tool_network_ids"), total),
      free: rate(n("free_network_ids"), total),
      paid: rate(n("paid_network_ids"), total),
      returning: rate(n("returning_network_ids"), total),
    },
    note: FUNNEL_NOTE,
  };
}

export const admin = new Hono<AppEnv>();

admin.use("/admin/*", async (c, next) => {
  const expected = c.env.ADMIN_TOKEN?.trim();
  if (!expected) return c.json({ error: "not_found" }, 404);
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!timingSafeEqual(token, expected)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

admin.get("/admin/usage", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 90);
  const db = c.env.DB;
  // Stats scan the id range of the window instead of the whole table
  const fromId = await firstIdSince(db, `-${days} days`);
  const [byCaller, byPath, byAgent, mcp, paid, errors, recent, referers, funnel, mcpClients, dataRequests] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT caller_type, caller_name, SUM(weight) AS n, MIN(ts) AS first_seen, MAX(ts) AS last_seen
         FROM usage_log WHERE id >= ? GROUP BY caller_type, caller_name ORDER BY n DESC`
      )
      .bind(fromId),
    db
      .prepare(
        `SELECT method, path, status, tier, SUM(weight) AS n FROM usage_log WHERE id >= ?
         GROUP BY method, path, status, tier ORDER BY n DESC LIMIT 40`
      )
      .bind(fromId),
    db
      .prepare(
        `SELECT user_agent, caller_type, SUM(weight) AS n, MAX(ts) AS last_seen FROM usage_log
         WHERE id >= ? AND user_agent IS NOT NULL
         GROUP BY user_agent, caller_type ORDER BY n DESC LIMIT 40`
      )
      .bind(fromId),
    db
      .prepare(
        `SELECT detail, SUM(weight) AS n, MAX(ts) AS last_seen FROM usage_log
         WHERE id >= ? AND detail IS NOT NULL GROUP BY detail ORDER BY n DESC LIMIT 40`
      )
      .bind(fromId),
    db
      .prepare(
        `SELECT ts, path, status, tier, api_key_id, caller_type, caller_name, user_agent, detail FROM usage_log
         WHERE id >= ? AND (tier = 'x402' OR api_key_id IS NOT NULL OR detail LIKE '%[paid]%')
         ORDER BY id DESC LIMIT 50`
      )
      .bind(fromId),
    db
      .prepare(
        `SELECT ts, method, path, status, caller_type, caller_name, user_agent, detail FROM usage_log
         WHERE id >= ? AND status >= 500 ORDER BY id DESC LIMIT 50`
      )
      .bind(fromId),
    db.prepare(
      `SELECT ts, method, path, status, caller_type, caller_name, tier, user_agent, detail
       FROM usage_log ORDER BY id DESC LIMIT 50`
    ),
    db
      .prepare(
        `SELECT referer_host, caller_type, SUM(weight) AS n, MIN(ts) AS first_seen, MAX(ts) AS last_seen FROM usage_log
         WHERE id >= ? AND referer_host IS NOT NULL
         GROUP BY referer_host, caller_type ORDER BY n DESC LIMIT 40`
      )
      .bind(fromId),
    // Per anonymous client, excluding clients with any self-identified bot
    // request: did it call a tool, use a free call, pay, and come back on
    // another day?
    db
      .prepare(
        `SELECT COUNT(*) AS network_ids,
                SUM(tool_calls > 0) AS tool_network_ids,
                SUM(free_calls > 0) AS free_network_ids,
                SUM(paid_calls > 0) AS paid_network_ids,
                SUM(days > 1) AS returning_network_ids,
                SUM(free_calls > 0 AND days > 1) AS returning_free_network_ids
         FROM (SELECT client_id, COUNT(DISTINCT substr(ts, 1, 10)) AS days,
                      SUM(detail LIKE 'tools/call%') AS tool_calls,
                      SUM(detail LIKE '%[free]%') AS free_calls,
                      SUM(tier = 'x402' OR detail LIKE '%[paid]%') AS paid_calls
               FROM usage_log WHERE id >= ? AND client_id IS NOT NULL
               GROUP BY client_id HAVING SUM(caller_type = 'bot') = 0)`
      )
      .bind(fromId),
    // MCP clients by the name they send in initialize (clientInfo)
    db
      .prepare(
        `SELECT substr(detail, 12) AS mcp_client, caller_type, SUM(weight) AS n,
                COUNT(DISTINCT client_id) AS clients, MAX(ts) AS last_seen
         FROM usage_log WHERE id >= ? AND detail LIKE 'initialize %'
         GROUP BY mcp_client, caller_type ORDER BY n DESC LIMIT 40`
      )
      .bind(fromId),
    // Data callers asked for (request_data tool, POST /v1/data-requests)
    db
      .prepare(
        `SELECT created_at, request, use_case, channel, caller_name, client_id FROM data_request
         WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 50`
      )
      .bind(`-${days} days`),
  ]);
  return c.json({
    days,
    by_caller: byCaller.results,
    by_path: byPath.results,
    by_user_agent: byAgent.results,
    mcp_calls: mcp.results,
    paid_calls: paid.results,
    server_errors: errors.results,
    recent: recent.results,
    by_referer: referers.results,
    network_id_funnel: networkIdFunnel(funnel.results[0]),
    by_mcp_client: mcpClients.results,
    data_requests: dataRequests.results,
  });
});

const MAX_KEY_NAME_LENGTH = 80;

// Creates a key and returns it once; only its hash is stored.
admin.post("/admin/api-keys", async (c) => {
  let body: { name?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    // name is validated below
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_KEY_NAME_LENGTH) {
    return c.json({ error: "bad_request", message: `Pass {"name": "..."} (1-${MAX_KEY_NAME_LENGTH} characters).` }, 400);
  }
  const created = await createApiKey(c.env.DB, name);
  return c.json({ ...created, note: "Store the key now; it cannot be shown again." }, 201);
});

admin.get("/admin/api-keys", async (c) => c.json({ api_keys: await listApiKeys(c.env.DB) }));

admin.post("/admin/api-keys/:id/revoke", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_request", message: "id must be a positive integer" }, 400);
  if (!(await revokeApiKey(c.env.DB, id))) return c.json({ error: "not_found", message: "No active key with this id." }, 404);
  return c.json({ id, revoked: true });
});

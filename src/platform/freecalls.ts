// Free daily calls of paid MCP tools. Most MCP clients (Claude, Codex, ...)
// cannot pay via x402 yet and stop at the payment error, so each client gets
// a few successful paid-tool calls per UTC day before payment is required.
// Clients are told apart by IP address (IPv6 by its /64 network), stored only
// as a truncated hash of day and address. Self-identified bots (crawlers,
// uptime and trust probes) get no free calls, so they keep seeing the x402
// payment flow they check for. A caller rotating addresses could still farm
// the per-client allowance, so each tool also has a daily cap shared by all
// callers: the worst case is bounded whatever the number of addresses.

export const MCP_FREE_CALLS_PER_DAY = 3;
export const MCP_FREE_CALLS_PER_TOOL_PER_DAY = 25;

// Counter row for a tool's shared cap; client hashes are hex, so no clash
export const toolCapKey = (toolName: string) => `tool:${toolName}`;

// IPv6 hosts usually get a whole /64 and can pick any address in it
export function clientAddress(ip: string | undefined): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function freeCallClient(ip: string | undefined, day: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}|${clientAddress(ip)}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Free calls used today by the client and, across all callers, of the tool
export async function freeCallsUsed(
  db: D1Database,
  day: string,
  client: string,
  toolName: string
): Promise<{ client: number; tool: number }> {
  const { results } = await db
    .prepare("SELECT client, calls FROM mcp_free_calls WHERE day = ? AND client IN (?, ?)")
    .bind(day, client, toolCapKey(toolName))
    .all<{ client: string; calls: number }>();
  const calls = (key: string) => results.find((r) => r.client === key)?.calls ?? 0;
  return { client: calls(client), tool: calls(toolCapKey(toolName)) };
}

export function hasFreeCall(used: { client: number; tool: number }): boolean {
  return used.client < MCP_FREE_CALLS_PER_DAY && used.tool < MCP_FREE_CALLS_PER_TOOL_PER_DAY;
}

export async function recordFreeCall(db: D1Database, day: string, client: string, toolName: string): Promise<void> {
  const upsert = db.prepare(
    `INSERT INTO mcp_free_calls (day, client, calls) VALUES (?, ?, 1)
     ON CONFLICT (day, client) DO UPDATE SET calls = calls + 1`
  );
  await db.batch([upsert.bind(day, client), upsert.bind(day, toolCapKey(toolName))]);
}

// Deletes counters from earlier days; writes nothing when there are none.
export async function pruneFreeCalls(db: D1Database, today = utcDay()): Promise<void> {
  await db.prepare("DELETE FROM mcp_free_calls WHERE day < ?").bind(today).run();
}

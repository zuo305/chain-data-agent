import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { type Attribution, type Dataset, badRequest, dataResponse } from "../../platform/dataset";
import { type LockupSnapshot, keyToB64, loadLockups, storeLockups, validateSnapshot } from "./lockups";
import { GROUPS, type Group, calendar, isoTime, summary, unlockList } from "./stats";
import { CALENDAR_EXAMPLE, SUMMARY_EXAMPLE, UNLOCKS_EXAMPLE } from "./examples";

// Calendar of SOL that becomes withdrawable when stake account lockups
// expire. An hourly GitHub Actions workflow reads mainnet-beta stake accounts
// (lockup.unix_timestamp still in the future) and pushes them to
// /internal/ingest/solana-unlocks, stored as one D1 row; requests filter and
// aggregate it.

export const ATTRIBUTION: Attribution = {
  publisher: "Solana mainnet-beta (stake account lockups via JSON-RPC)",
  licence: "Public on-chain data",
  licenceUrl: "https://solana.com/docs/rpc/http/getprogramaccounts",
  text:
    "Computed from Solana mainnet-beta stake accounts (Stake program, lockup.unix_timestamp in the future), " +
    "refreshed hourly; meta.refreshed_at gives the time of the last refresh.",
};

const DAY = 86_400;
const MAX_SPAN_DAYS = 1_500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const NOTES = [
  "A lockup end makes the SOL withdrawable, not sold: delegated stake must also be deactivated (about one epoch, " +
    "2-3 days) before withdrawal.",
  "The lockup custodian can change or lift a lockup before its date, so dates are the current on-chain values.",
];

const q = (c: Context<AppEnv>, name: string) => c.req.query(name)?.trim() || undefined;
const today = () => Math.floor(Date.now() / 1000 / DAY) * DAY;

// YYYY-MM-DD at 00:00 UTC, or an error message
function readDate(c: Context<AppEnv>, name: string, fallback: number): number | string {
  const raw = q(c, name);
  if (raw === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    return `${name} must be a date as YYYY-MM-DD.`;
  }
  return Date.parse(`${raw}T00:00:00Z`) / 1000;
}

// [from, to) in unix seconds; `to` is inclusive as a date
function readRange(c: Context<AppEnv>, defaultDays: number): { from: number; to: number } | string {
  const from = readDate(c, "from", today());
  if (typeof from === "string") return from;
  const to = readDate(c, "to", from + (defaultDays - 1) * DAY);
  if (typeof to === "string") return to;
  if (to < from) return "to must not be before from.";
  if ((to - from) / DAY > MAX_SPAN_DAYS) return `The range may span at most ${MAX_SPAN_DAYS} days.`;
  return { from, to: to + DAY };
}

function readKey(c: Context<AppEnv>, name: string): string | undefined | { error: string } {
  const raw = q(c, name);
  if (raw === undefined) return undefined;
  const b64 = BASE58.test(raw) ? keyToB64(raw) : null;
  return b64 ?? { error: `${name} must be a base58 Solana public key.` };
}

type CalendarInput = { from: number; to: number; group: Group };

function readCalendarInput(c: Context<AppEnv>): CalendarInput | string {
  const range = readRange(c, 90);
  if (typeof range === "string") return range;
  const group = (q(c, "group") ?? "day") as Group;
  if (!GROUPS.includes(group)) return `group must be one of ${GROUPS.join(", ")}.`;
  return { ...range, group };
}

type ListInput = { from: number; to: number; minLamports: number; withdrawer?: string; custodian?: string; limit: number };

function readListInput(c: Context<AppEnv>): ListInput | string {
  const range = readRange(c, 30);
  if (typeof range === "string") return range;
  const minRaw = q(c, "min_sol");
  const minSol = minRaw === undefined ? 0 : Number(minRaw);
  if (!Number.isFinite(minSol) || minSol < 0) return "min_sol must be a non-negative number.";
  const limitRaw = q(c, "limit");
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return `limit must be an integer from 1 to ${MAX_LIMIT}.`;
  const withdrawer = readKey(c, "withdraw_authority");
  if (typeof withdrawer === "object") return withdrawer.error;
  const custodian = readKey(c, "custodian");
  if (typeof custodian === "object") return custodian.error;
  return { ...range, minLamports: Math.round(minSol * 1e9), withdrawer, custodian, limit };
}

function freshness(s: LockupSnapshot) {
  return {
    refreshed_at: isoTime(Math.floor(s.refreshedAt / 1000)),
    data_age_seconds: Math.max(0, Math.round((Date.now() - s.refreshedAt) / 1000)),
  };
}

async function withLockups(c: Context<AppEnv>, fn: (s: LockupSnapshot) => Response): Promise<Response> {
  const snapshot = await loadLockups(c.env);
  if (!snapshot) {
    return c.json(
      { error: "data_unavailable", message: "The lockup snapshot has not been refreshed recently; retry later." },
      503,
      { "Retry-After": "600" }
    );
  }
  return fn(snapshot);
}

const nowSec = () => Math.floor(Date.now() / 1000);

export const solanaUnlocks: Dataset = {
  id: "solana-unlocks",
  title: "SOL stake unlock calendar",
  description:
    "When locked SOL becomes withdrawable: every mainnet stake account whose lockup has not expired, with " +
    "amount, unlock time, withdraw authority, custodian and delegation. Daily, weekly or monthly totals, and " +
    "the individual unlocks with filters. Read from chain state hourly.",
  attribution: ATTRIBUTION,
  tags: ["solana", "unlocks", "vesting", "supply", "staking"],
  ingest: async (c, body) => {
    const snapshot = validateSnapshot(body);
    if (typeof snapshot === "string") return badRequest(c, snapshot);
    await storeLockups(c.env, snapshot);
    return c.json({ stored: snapshot.lockups.length });
  },
  status: async (env) => {
    const s = await loadLockups(env);
    return s ? { lockups: s.lockups.length, ...freshness(s) } : { lockups: 0, refreshed_at: null };
  },
  endpoints: [
    {
      method: "GET",
      path: "/summary",
      toolName: "get_unlock_summary",
      summary: "Get how much SOL is still locked in stake account lockups and how much unlocks soon.",
      details:
        "Returns the locked SOL total (and the delegated part), the next unlock day, the SOL unlocking in the next " +
        "7, 30, 90 and 365 days, and the last unlock date. Use solana_unlocks_get_unlock_calendar for the schedule.",
      outputExample: SUMMARY_EXAMPLE,
      handler: (c) =>
        withLockups(c, (s) => dataResponse(c, solanaUnlocks, summary(s.lockups, nowSec()), { ...freshness(s), notes: NOTES })),
    },
    {
      method: "GET",
      path: "/calendar",
      toolName: "get_unlock_calendar",
      summary: "Get the SOL unlock schedule by day, week or month for a date range.",
      details:
        "Dates from and to are YYYY-MM-DD, inclusive (default today and 90 days on, span up to 1,500 days). The " +
        "group parameter is day (default), week (starting Monday) or month. Each period gives the SOL whose stake lockup ends then, " +
        "the number of stake accounts, the delegated part (needs about one epoch to deactivate before withdrawal) " +
        "and the largest single account. Periods with nothing unlocking are left out.",
      price: "$0.002",
      params: [
        { name: "from", description: "First date, YYYY-MM-DD (default today)", example: "2026-12-01" },
        { name: "to", description: "Last date, YYYY-MM-DD (default from + 89 days)", example: "2027-05-31" },
        { name: "group", description: "day, week or month (default day)", example: "month" },
      ],
      exampleInput: { from: "2026-12-01", to: "2027-05-31", group: "month" },
      outputExample: CALENDAR_EXAMPLE,
      handler: async (c) => {
        const input = readCalendarInput(c);
        if (typeof input === "string") return badRequest(c, input);
        return withLockups(c, (s) => {
          const periods = calendar(s.lockups, nowSec(), input.from, input.to, input.group);
          return dataResponse(c, solanaUnlocks, periods, {
            group: input.group,
            from: isoTime(input.from).slice(0, 10),
            to: isoTime(input.to - DAY).slice(0, 10),
            periods: periods.length,
            ...freshness(s),
            notes: NOTES,
          });
        });
      },
      preview: async (c) => {
        const input = readCalendarInput(c);
        if (typeof input === "string") return { valid: false, error: "bad_request", message: input };
        const s = await loadLockups(c.env);
        if (!s) return null;
        return {
          valid: true,
          periods: calendar(s.lockups, nowSec(), input.from, input.to, input.group).length,
          note: "Free preview of this call; pay to get the amounts.",
        };
      },
    },
    {
      method: "GET",
      path: "/unlocks",
      toolName: "list_unlocks",
      summary: "List individual SOL stake account unlocks in a date range, largest first within each time.",
      details:
        "Dates from and to are YYYY-MM-DD, inclusive (default today and 30 days on). Filters: min_sol, " +
        "withdraw_authority (whose SOL it is) and custodian (who can lift the lockup). Each row gives the stake " +
        `account, SOL, unlock time, withdraw authority, custodian and the vote account it is delegated to (null if ` +
        `not delegated). Returns up to limit rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) and the matched count and SOL.`,
      price: "$0.002",
      params: [
        { name: "from", description: "First date, YYYY-MM-DD (default today)", example: "2026-12-01" },
        { name: "to", description: "Last date, YYYY-MM-DD (default from + 29 days)", example: "2026-12-31" },
        { name: "min_sol", description: "Only unlocks of at least this many SOL", example: "10000" },
        { name: "withdraw_authority", description: "Only stake accounts with this withdraw authority (base58)" },
        { name: "custodian", description: "Only lockups with this custodian (base58)" },
        { name: "limit", description: `Rows to return, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`, example: "20" },
      ],
      exampleInput: { from: "2026-12-01", to: "2026-12-31", min_sol: "10000", limit: "20" },
      outputExample: UNLOCKS_EXAMPLE,
      handler: async (c) => {
        const input = readListInput(c);
        if (typeof input === "string") return badRequest(c, input);
        return withLockups(c, (s) => {
          const { matched, matched_sol, unlocks } = unlockList(s.lockups, nowSec(), input);
          return dataResponse(c, solanaUnlocks, unlocks, {
            matched,
            matched_sol,
            returned: unlocks.length,
            ...freshness(s),
            notes: NOTES,
          });
        });
      },
      preview: async (c) => {
        const input = readListInput(c);
        if (typeof input === "string") return { valid: false, error: "bad_request", message: input };
        const s = await loadLockups(c.env);
        if (!s) return null;
        const { matched, matched_sol } = unlockList(s.lockups, nowSec(), { ...input, limit: 0 });
        return { valid: true, matched, matched_sol, note: "Free preview of this call; pay to get the unlocks." };
      },
    },
  ],
  prompts: [
    {
      name: "solana_unlock_outlook",
      title: "SOL supply unlocks ahead",
      description: "Summarise how much locked SOL becomes withdrawable in the coming months and the largest unlocks.",
      args: [{ name: "months", description: "How many months ahead, e.g. 6" }],
      text: ({ months }) =>
        `Summarise the SOL stake lockups ending in the next ${months || "6"} months. Call ` +
        "solana_unlocks_get_unlock_summary (free) first, then solana_unlocks_get_unlock_calendar with group=month for " +
        "that range, and solana_unlocks_list_unlocks with min_sol=50000 for the largest single unlocks. Point out that " +
        "an unlock makes SOL withdrawable, not sold, and that delegated stake needs about an epoch to deactivate. " +
        "Include the attribution from the results.",
    },
  ],
};

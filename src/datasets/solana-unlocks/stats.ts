import { type StoredLockup, keyFromB64 } from "./lockups";

// Pure computations over the stored lockups. Times are unix seconds; periods
// are UTC.

const LAMPORTS_PER_SOL = 1_000_000_000;
const DAY = 86_400;

export const toSol = (lamports: number) => Math.round((lamports / LAMPORTS_PER_SOL) * 1000) / 1000;
export const isoDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
export const isoTime = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");

export const GROUPS = ["day", "week", "month"] as const;
export type Group = (typeof GROUPS)[number];

// Formatting a date per row costs more CPU than the rest of a request, so
// rows are grouped by integer day number and only group keys are formatted.
const dayNumber = (ts: number) => Math.floor(ts / DAY);

export function periodOf(ts: number, group: Group): string {
  return periodOfDay(dayNumber(ts), group);
}

function periodOfDay(day: number, group: Group): string {
  const text = isoDay(day * DAY);
  if (group === "day") return text;
  if (group === "month") return text.slice(0, 7);
  // Week starting on Monday (day 0, 1970-01-01, was a Thursday)
  const back = (day + 3) % 7;
  return isoDay((day - back) * DAY);
}

export function pending(lockups: StoredLockup[], now: number): StoredLockup[] {
  return lockups.filter((l) => l[2] > now);
}

const sum = (rows: StoredLockup[]) => rows.reduce((a, l) => a + l[1], 0);

export function summary(lockups: StoredLockup[], now: number) {
  const rows = pending(lockups, now);
  const within = (days: number) => {
    const r = rows.filter((l) => l[2] <= now + days * DAY);
    return { sol: toSol(sum(r)), accounts: r.length };
  };
  const first = rows.reduce((m, l) => Math.min(m, l[2]), Infinity);
  const firstDay = Number.isFinite(first) ? isoDay(first) : null;
  const nextDay = Number.isFinite(first) ? rows.filter((l) => dayNumber(l[2]) === dayNumber(first)) : [];
  const last = rows.reduce((m, l) => Math.max(m, l[2]), 0);
  return {
    locked: {
      sol: toSol(sum(rows)),
      accounts: rows.length,
      delegated_sol: toSol(sum(rows.filter((l) => l[5] !== ""))),
    },
    next_unlock_day: firstDay ? { date: firstDay, sol: toSol(sum(nextDay)), accounts: nextDay.length } : null,
    next_7_days: within(7),
    next_30_days: within(30),
    next_90_days: within(90),
    next_365_days: within(365),
    last_unlock_date: last ? isoDay(last) : null,
  };
}

export function calendar(lockups: StoredLockup[], now: number, from: number, to: number, group: Group) {
  const buckets = new Map<string, { sol: number; accounts: number; delegated: number; largest: number }>();
  const keys = new Map<number, string>();
  for (const l of pending(lockups, now)) {
    if (l[2] < from || l[2] >= to) continue;
    const day = dayNumber(l[2]);
    let key = keys.get(day);
    if (key === undefined) {
      key = periodOfDay(day, group);
      keys.set(day, key);
    }
    const b = buckets.get(key) ?? { sol: 0, accounts: 0, delegated: 0, largest: 0 };
    b.sol += l[1];
    b.accounts += 1;
    if (l[5] !== "") b.delegated += l[1];
    b.largest = Math.max(b.largest, l[1]);
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, b]) => ({
      period,
      sol: toSol(b.sol),
      accounts: b.accounts,
      delegated_sol: toSol(b.delegated),
      largest_account_sol: toSol(b.largest),
    }));
}

export type ListOptions = {
  from: number;
  to: number;
  minLamports: number;
  withdrawer?: string; // base64
  custodian?: string; // base64
  limit: number;
};

export function unlockList(lockups: StoredLockup[], now: number, opts: ListOptions) {
  const rows = pending(lockups, now)
    .filter((l) => l[2] >= opts.from && l[2] < opts.to && l[1] >= opts.minLamports)
    .filter((l) => !opts.withdrawer || l[3] === opts.withdrawer)
    .filter((l) => !opts.custodian || l[4] === opts.custodian)
    .sort((a, b) => a[2] - b[2] || b[1] - a[1]);
  return {
    matched: rows.length,
    matched_sol: toSol(sum(rows)),
    unlocks: rows.slice(0, opts.limit).map((l) => ({
      stake_account: l[0],
      sol: toSol(l[1]),
      unlocks_at: isoTime(l[2]),
      withdraw_authority: keyFromB64(l[3]),
      custodian: keyFromB64(l[4]),
      delegated_to: keyFromB64(l[5]),
    })),
  };
}

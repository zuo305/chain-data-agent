import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { solanaUnlocks } from "../src/datasets/solana-unlocks";
import {
  LOCKUPS_KEY,
  type LockupSnapshot,
  base58,
  decodeBase58,
  keyFromB64,
  keyToB64,
  loadLockups,
  parseLockup,
  refreshLockups,
} from "../src/datasets/solana-unlocks/lockups";
import { calendar, periodOf, summary, unlockList } from "../src/datasets/solana-unlocks/stats";
import { mountDatasets, syncDatasets, type Dataset } from "../src/platform/dataset";
import type { AppEnv } from "../src/types";
import { createTestD1 } from "./helpers/d1";

// Real mainnet-beta lockups (2026-11-15), 40 rows spread over time
const fixture = JSON.parse(readFileSync("fixtures/solana/lockups.json", "utf8")) as LockupSnapshot;
const DAY = 86_400;
const ts = (iso: string) => Date.parse(iso) / 1000;

// Raw StakeStateV2 prefix as getProgramAccounts returns it with dataSlice 0..156
function rawAccount(opts: { state: number; unlocksAt: number; seed: number }) {
  const data = new Uint8Array(156);
  const view = new DataView(data.buffer);
  view.setUint32(0, opts.state, true);
  data.fill(opts.seed, 44, 76); // withdrawer
  view.setBigInt64(76, BigInt(opts.unlocksAt), true);
  data.fill(opts.seed + 1, 92, 124); // custodian
  data.fill(opts.seed + 2, 124, 156); // voter
  return {
    pubkey: base58(new Uint8Array(32).fill(opts.seed + 3)),
    account: { lamports: 5_000_000_000_000, data: [btoa(String.fromCharCode(...data)), "base64"] as [string, string] },
  };
}

describe("lockup parsing", () => {
  it("reads the withdrawer, unlock time, custodian and voter of a delegated account", () => {
    const now = ts("2026-11-15T00:00:00Z");
    const row = parseLockup(rawAccount({ state: 2, unlocksAt: now + 10 * DAY, seed: 7 }), now)!;
    expect(row[1]).toBe(5_000_000_000_000);
    expect(row[2]).toBe(now + 10 * DAY);
    expect(keyFromB64(row[3])).toBe(base58(new Uint8Array(32).fill(7)));
    expect(keyFromB64(row[4])).toBe(base58(new Uint8Array(32).fill(8)));
    expect(keyFromB64(row[5])).toBe(base58(new Uint8Array(32).fill(9)));
  });

  it("leaves out expired lockups and has no voter for undelegated accounts", () => {
    const now = ts("2026-11-15T00:00:00Z");
    expect(parseLockup(rawAccount({ state: 2, unlocksAt: now - 1, seed: 1 }), now)).toBeNull();
    expect(parseLockup(rawAccount({ state: 1, unlocksAt: now + 1, seed: 1 }), now)![5]).toBe("");
  });

  it("encodes and decodes base58 keys", () => {
    for (const key of [
      "Stake11111111111111111111111111111111111111",
      "11111111111111111111111111111111",
      "D1iUaddNCTu2HsinYefkNb8CurCSHM48wzvfGmntUuew",
    ]) {
      expect(base58(decodeBase58(key)!)).toBe(key);
      expect(keyFromB64(keyToB64(key)!)).toBe(key);
    }
    expect(keyToB64("0OIl")).toBeNull();
  });
});

describe("lockup refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("stores one snapshot row from all windows and keeps it when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls++;
      const filters = JSON.parse(String(init.body)).params[1].filters;
      const window = Uint8Array.from(atob(filters[1].memcmp.bytes), (ch) => ch.charCodeAt(0))[0];
      // Two lockups in the window holding "now", one already expired
      const result =
        window === Math.floor(now / 2 ** 24)
          ? [
              rawAccount({ state: 2, unlocksAt: now + DAY, seed: 10 }),
              rawAccount({ state: 1, unlocksAt: now + 2 * DAY, seed: 20 }),
              rawAccount({ state: 2, unlocksAt: now - DAY, seed: 30 }),
            ]
          : [];
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    });
    const db = createTestD1();
    expect(await refreshLockups({ DB: db } as never)).toBe(2);
    expect(calls).toBe(9);
    const snapshot = (await loadLockups({ DB: db } as never))!;
    expect(snapshot.lockups.map((l) => l[2])).toEqual([now + DAY, now + 2 * DAY]);

    vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await refreshLockups({ DB: db } as never)).toBe(0);
    expect((await loadLockups({ DB: db } as never))!.lockups).toHaveLength(2);
  });

  it("is not served once it is more than a week old", async () => {
    const db = createTestD1();
    db.sqlite
      .prepare("INSERT INTO rpc_snapshot (call_key, fetched_at, body) VALUES (?, ?, ?)")
      .run(LOCKUPS_KEY, Date.now() - 8 * DAY * 1000, JSON.stringify(fixture));
    expect(await loadLockups({ DB: db } as never)).toBeNull();
  });
});

describe("lockup statistics", () => {
  const now = ts("2026-11-15T12:00:00Z");
  const rows = fixture.lockups;

  it("groups by day, Monday week and month", () => {
    const t = ts("2026-12-03T15:00:00Z"); // a Thursday
    expect(periodOf(t, "day")).toBe("2026-12-03");
    expect(periodOf(t, "week")).toBe("2026-11-30");
    expect(periodOf(t, "month")).toBe("2026-12");
  });

  it("summarises pending lockups and keeps calendar and list totals consistent", () => {
    const s = summary(rows, now);
    const pending = rows.filter((l) => l[2] > now);
    expect(s.locked.accounts).toBe(pending.length);
    const from = now;
    const to = now + 365 * DAY;
    const months = calendar(rows, now, from, to, "month");
    const list = unlockList(rows, now, { from, to, minLamports: 0, limit: 1000 });
    const monthSum = months.reduce((a, m) => a + m.sol, 0);
    expect(Math.abs(monthSum - list.matched_sol)).toBeLessThan(0.01);
    expect(Math.abs(s.next_365_days.sol - list.matched_sol)).toBeLessThan(0.01);
    expect(months.map((m) => m.period)).toEqual([...months.map((m) => m.period)].sort());
  });

  it("filters the list by size and withdraw authority, sorted by time", () => {
    const from = now;
    const to = now + 1500 * DAY;
    const big = unlockList(rows, now, { from, to, minLamports: 100_000e9, limit: 1000 });
    expect(big.unlocks.every((u) => u.sol >= 100_000)).toBe(true);
    const times = big.unlocks.map((u) => u.unlocks_at);
    expect(times).toEqual([...times].sort());
    const owner = rows.find((l) => l[2] > now)![3];
    const own = unlockList(rows, now, { from, to, minLamports: 0, withdrawer: owner, limit: 1000 });
    expect(own.matched).toBe(rows.filter((l) => l[2] > now && l[3] === owner).length);
  });
});

describe("unlock endpoints", () => {
  async function appWith(snapshot: LockupSnapshot | null) {
    const db = createTestD1();
    if (snapshot) {
      db.sqlite
        .prepare("INSERT INTO rpc_snapshot (call_key, fetched_at, body) VALUES (?, ?, ?)")
        .run(LOCKUPS_KEY, Date.now(), JSON.stringify(snapshot));
    }
    const app = new Hono<AppEnv>();
    mountDatasets(app, [solanaUnlocks]);
    return (path: string) => app.request(path, {}, { DB: db });
  }

  it("serves the summary, calendar and list with freshness", async () => {
    // Shift the fixture so it lies ahead of today
    const shift = Math.floor(Date.now() / 1000) - ts("2026-11-15T00:00:00Z");
    const get = await appWith({ ...fixture, lockups: fixture.lockups.map((l) => [l[0], l[1], l[2] + shift, l[3], l[4], l[5]]) });
    const summaryRes = await get("/v1/solana-unlocks/summary");
    expect(summaryRes.status).toBe(200);
    const s = (await summaryRes.json()) as any;
    expect(s.data.locked.accounts).toBeGreaterThan(0);
    expect(s.meta.refreshed_at).toMatch(/Z$/);
    expect(s.meta.notes.length).toBe(2);

    const cal = (await (await get("/v1/solana-unlocks/calendar?group=month&to=" + new Date(Date.now() + 1400 * DAY * 1000).toISOString().slice(0, 10))).json()) as any;
    expect(cal.meta.group).toBe("month");
    expect(cal.data.length).toBeGreaterThan(1);

    const list = (await (await get("/v1/solana-unlocks/unlocks?min_sol=1&limit=3")).json()) as any;
    expect(list.data.length).toBeLessThanOrEqual(3);
    expect(list.data[0]).toHaveProperty("withdraw_authority");
  });

  it("rejects bad input and answers 503 without a snapshot", async () => {
    const get = await appWith(fixture);
    expect((await get("/v1/solana-unlocks/calendar?group=year")).status).toBe(400);
    expect((await get("/v1/solana-unlocks/calendar?from=2026-13-01")).status).toBe(400);
    expect((await get("/v1/solana-unlocks/calendar?from=2026-12-01&to=2026-11-01")).status).toBe(400);
    expect((await get("/v1/solana-unlocks/calendar?from=2026-01-01&to=2031-01-01")).status).toBe(400);
    expect((await get("/v1/solana-unlocks/unlocks?limit=500")).status).toBe(400);
    expect((await get("/v1/solana-unlocks/unlocks?withdraw_authority=nope")).status).toBe(400);
    const empty = await appWith(null);
    const res = await empty("/v1/solana-unlocks/summary");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("600");
  });
});

describe("sync schedules", () => {
  it("runs a dataset's sync only on its own cron", async () => {
    const ran: string[] = [];
    const ds = (id: string, syncCron?: string): Dataset => ({
      id,
      title: id,
      description: "",
      attribution: { publisher: "", licence: "", licenceUrl: "", text: "" },
      endpoints: [],
      sync: async () => void ran.push(id),
      syncCron,
    });
    const all = [ds("every"), ds("ten", "*/10 * * * *"), ds("hourly", "5 * * * *")];
    await syncDatasets(all, {} as never, "5 * * * *");
    expect(ran).toEqual(["every", "hourly"]);
    ran.length = 0;
    await syncDatasets(all, {} as never, "*/10 * * * *");
    expect(ran).toEqual(["every", "ten"]);
  });
});

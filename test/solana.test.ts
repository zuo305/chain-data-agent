import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { solanaValidators } from "../src/datasets/solana-validators";
import { mountDatasets } from "../src/platform/dataset";
import {
  LAMPORTS_PER_SOL,
  blockProduction,
  creditsEarned,
  creditsPerSol,
  epochCredits,
  findValidator,
  listValidators,
  median,
  medianCreditsPerSol,
  nakamotoCoefficient,
  networkSummary,
  recentEpochs,
  validatorStats,
} from "../src/datasets/solana-validators/stats";
import type { AppEnv } from "../src/types";
import { createTestD1 } from "./helpers/d1";
import { FIXTURE_DELINQUENT_VOTE, FIXTURE_IDENTITY, FIXTURE_VOTE, solanaSnapshot, stubSolanaRpc } from "./helpers/solana";

const snapshot = solanaSnapshot();

describe("stats helpers", () => {
  it("computes medians", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("counts the fewest validators holding over a third of stake", () => {
    expect(nakamotoCoefficient([10, 10, 10])).toBe(2);
    expect(nakamotoCoefficient([50, 1, 1, 1])).toBe(1);
    expect(nakamotoCoefficient([1, 1, 1, 1, 1, 1])).toBe(3);
    expect(nakamotoCoefficient([])).toBe(0);
  });

  it("derives credits per epoch and per SOL from epochCredits", () => {
    const v = {
      votePubkey: "v",
      nodePubkey: "n",
      activatedStake: 1_000 * LAMPORTS_PER_SOL,
      commission: 0,
      epochVoteAccount: true,
      epochCredits: [
        [9, 150, 100],
        [10, 400, 150],
      ] as Array<[number, number, number]>,
      lastVote: 0,
      rootSlot: 0,
    };
    expect(creditsEarned(v, 10)).toBe(250);
    expect(creditsEarned(v, 8)).toBeNull();
    expect(creditsPerSol(v, 10)).toBe(0.25);
    expect(creditsPerSol({ ...v, activatedStake: 0 }, 10)).toBeNull();
    // Twice the credits per SOL of the median validator
    const peer = { ...v, votePubkey: "p", epochCredits: [[10, 125, 0]] as Array<[number, number, number]> };
    const medians = medianCreditsPerSol([v, peer, { ...peer, votePubkey: "q" }], [10]);
    expect(medians.get(10)).toBe(0.125);
    const [current, previous] = epochCredits(v, recentEpochs(10, 2), medians, 10);
    expect(current).toEqual({ epoch: 10, credits: 250, credits_per_sol: 0.3, pct_of_median: 200, complete: false });
    expect(previous).toMatchObject({ epoch: 9, credits: 50, pct_of_median: null, complete: true });
  });

  it("leaves small validators out of the median", () => {
    const tiny = {
      votePubkey: "t",
      nodePubkey: "t",
      activatedStake: 10 * LAMPORTS_PER_SOL,
      commission: 0,
      epochVoteAccount: true,
      epochCredits: [[5, 1_000_000, 0]] as Array<[number, number, number]>,
      lastVote: 0,
      rootSlot: 0,
    };
    expect(medianCreditsPerSol([tiny], [5]).size).toBe(0);
  });

  it("computes skip rates from leader slots", () => {
    expect(blockProduction(snapshot)).toEqual({ leader_slots: 32668, blocks_produced: 32663, skip_rate_pct: 0.02 });
    expect(blockProduction(snapshot, FIXTURE_IDENTITY)).toEqual({ leader_slots: 3536, blocks_produced: 3536, skip_rate_pct: 0 });
    expect(blockProduction(snapshot, "unknown")).toEqual({ leader_slots: 0, blocks_produced: 0, skip_rate_pct: null });
  });
});

describe("network summary", () => {
  it("summarises the fixture snapshot", () => {
    const s = networkSummary(snapshot);
    expect(s.epoch).toEqual({ epoch: 1086, slot: 469241436, slot_index: 89436, slots_in_epoch: 432000, progress_pct: 20.7 });
    expect(s.validators).toEqual({ total: 31, active: 28, delinquent: 3 });
    expect(s.stake.nakamoto_coefficient).toBe(4);
    expect(s.stake.delinquent_pct).toBe(0.03);
    expect(s.commission).toEqual({ median_pct: 5, zero_commission_validators: 7 });
    expect(s.vote_credits_last_epoch).toEqual({ epoch: 1085, median_credits_per_sol: 143486 });
  });
});

describe("validator stats", () => {
  it("finds validators by vote account or identity", () => {
    expect(findValidator(snapshot, { vote: FIXTURE_VOTE })?.nodePubkey).toBe(FIXTURE_IDENTITY);
    expect(findValidator(snapshot, { identity: FIXTURE_IDENTITY })?.votePubkey).toBe(FIXTURE_VOTE);
    expect(findValidator(snapshot, { vote: FIXTURE_IDENTITY })).toBeUndefined();
  });

  it("reports stake, voting and block production for one validator", () => {
    const stats = validatorStats(snapshot, findValidator(snapshot, { vote: FIXTURE_VOTE })!);
    expect(stats.stake).toMatchObject({ rank: 1, of_validators: 31, share_pct: 10.9284 });
    expect(stats.commission_pct).toBe(0);
    expect(stats.voting.slots_behind_tip).toBe(0);
    expect(stats.voting.epoch_credits).toHaveLength(5);
    expect(stats.voting.epoch_credits[1]).toMatchObject({ epoch: 1085, complete: true, pct_of_median: 99.2 });
    expect(stats.block_production_current_epoch).toEqual({
      leader_slots: 3536,
      blocks_produced: 3536,
      skip_rate_pct: 0,
      cluster_skip_rate_pct: 0.02,
    });
  });

  it("shows a delinquent validator lagging with no recent credits", () => {
    const stats = validatorStats(snapshot, findValidator(snapshot, { vote: FIXTURE_DELINQUENT_VOTE })!);
    expect(stats.delinquent).toBe(true);
    expect(stats.voting.slots_behind_tip).toBeGreaterThan(1_000_000);
    expect(stats.voting.epoch_credits.every((c) => c.pct_of_median === null)).toBe(true);
    expect(stats.block_production_current_epoch.skip_rate_pct).toBeNull();
  });
});

describe("validator list", () => {
  it("excludes delinquent validators unless asked", () => {
    expect(listValidators(snapshot, { sort: "stake", includeDelinquent: false, limit: 50 }).matched).toBe(28);
    expect(listValidators(snapshot, { sort: "stake", includeDelinquent: true, limit: 50 }).matched).toBe(31);
  });

  it("filters by commission and stake and applies the limit", () => {
    const res = listValidators(snapshot, { sort: "stake", includeDelinquent: false, maxCommission: 0, minStakeSol: 1e6, limit: 2 });
    expect(res.matched).toBe(5);
    expect(res.validators).toHaveLength(2);
    expect(res.validators.every((v) => v.commission_pct === 0 && v.active_stake_sol >= 1e6)).toBe(true);
    expect(res.credits_epoch).toBe(1085);
  });

  it("sorts by each key, best first", () => {
    const rows = (sort: "stake" | "credits" | "skip_rate" | "commission") =>
      listValidators(snapshot, { sort, includeDelinquent: false, limit: 50 }).validators;
    const isSorted = (values: number[], dir: 1 | -1) => values.every((v, i) => i === 0 || (v - values[i - 1]) * dir >= 0);
    expect(isSorted(rows("stake").map((v) => v.active_stake_sol), -1)).toBe(true);
    expect(rows("stake")[0].stake_rank).toBe(1);
    expect(isSorted(rows("commission").map((v) => v.commission_pct), 1)).toBe(true);
    const credits = rows("credits").map((v) => v.last_epoch_credits_pct_of_median).filter((v): v is number => v !== null);
    expect(isSorted(credits, -1)).toBe(true);
    const skip = rows("skip_rate");
    const withSlots = skip.filter((v) => v.skip_rate_pct !== null).map((v) => v.skip_rate_pct!);
    expect(isSorted(withSlots, 1)).toBe(true);
    // Validators without leader slots this epoch come last
    const firstNull = skip.findIndex((v) => v.skip_rate_pct === null);
    if (firstNull >= 0) expect(skip.slice(firstNull).every((v) => v.skip_rate_pct === null)).toBe(true);
  });
});

describe("solana-validators endpoints", () => {
  afterEach(() => vi.unstubAllGlobals());
  const bare = new Hono<AppEnv>();
  mountDatasets(bare, [solanaValidators]);
  const get = (path: string) => bare.request(`https://example.test${path}`, {}, { DB: createTestD1() });

  it("validates validator keys before calling the RPC", async () => {
    const rpc = stubSolanaRpc();
    expect((await get("/v1/solana-validators/validator")).status).toBe(400);
    expect((await get(`/v1/solana-validators/validator?vote=${FIXTURE_VOTE}&identity=${FIXTURE_IDENTITY}`)).status).toBe(400);
    const bad = await get("/v1/solana-validators/validator?vote=0OIl-not-base58");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).message).toContain("base58");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown validator", async () => {
    stubSolanaRpc();
    const res = await get("/v1/solana-validators/validator?vote=11111111111111111111111111111111");
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("not_found");
  });

  it("looks validators up by identity", async () => {
    stubSolanaRpc();
    const res = await get(`/v1/solana-validators/validator?identity=${FIXTURE_IDENTITY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.vote_pubkey).toBe(FIXTURE_VOTE);
    expect(body.attribution.publisher).toContain("Solana");
  });

  it("validates list parameters", async () => {
    stubSolanaRpc();
    for (const q of ["sort=best", "max_commission=101", "min_stake_sol=-1", "limit=0", "limit=51", "include_delinquent=yes"]) {
      expect((await get(`/v1/solana-validators/validators?${q}`)).status, q).toBe(400);
    }
    const res = await get("/v1/solana-validators/validators?sort=commission&limit=3&include_delinquent=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveLength(3);
    expect(body.meta).toMatchObject({ matched: 31, returned: 3, sort: "commission", credits_epoch: 1085, epoch: 1086 });
  });

  it("answers 503 with Retry-After when the RPC fails", async () => {
    stubSolanaRpc({ fail: true });
    for (const path of ["/v1/solana-validators/summary", `/v1/solana-validators/validator?vote=${FIXTURE_VOTE}`, "/v1/solana-validators/validators"]) {
      const res = await get(path);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(((await res.json()) as any).error).toBe("upstream_unavailable");
    }
  });

  it("answers 503 when the RPC returns a JSON-RPC error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } }));
    const res = await get("/v1/solana-validators/summary");
    expect(res.status).toBe(503);
  });
});

describe("RPC fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("moves on to the next free endpoint when one refuses, and never names a configured URL", async () => {
    const { rpcCall } = await import("../src/datasets/solana-validators/rpc");
    const snap = solanaSnapshot();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("publicnode")) return Response.json({ jsonrpc: "2.0", id: 1, result: snap.epochInfo });
      return new Response("forbidden", { status: 403 });
    });
    const env = { SOLANA_RPC_URL: "https://rpc.example.test/?api-key=secret" } as never;
    await expect(rpcCall(env, "getEpochInfo")).resolves.toEqual(snap.epochInfo);
    expect(seen).toEqual([
      "https://rpc.example.test/?api-key=secret",
      "https://api.mainnet-beta.solana.com",
      "https://solana-rpc.publicnode.com",
    ]);

    vi.stubGlobal("fetch", async () => new Response("forbidden", { status: 403 }));
    const err = await rpcCall(env, "getEpochInfo").catch((e: Error) => e);
    expect(String(err)).toContain("configured endpoint HTTP 403; api.mainnet-beta.solana.com HTTP 403");
    expect(String(err)).not.toContain("secret");
  });
});

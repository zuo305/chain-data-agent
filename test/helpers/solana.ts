import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { PUBLIC_RPC_URL } from "../../src/datasets/solana-validators/rpc";

// Real mainnet-beta snapshot trimmed to 31 validators (28 current, 3 delinquent) (see fixtures/solana)
export function solanaSnapshot() {
  return JSON.parse(readFileSync("fixtures/solana/snapshot.json", "utf8"));
}

// Largest validator in the fixture (stake rank 1)
export const FIXTURE_VOTE = "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk";
export const FIXTURE_IDENTITY = "HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU";
// A delinquent validator in the fixture
export const FIXTURE_DELINQUENT_VOTE = "P1TCHYwYPsNaNUK6fGkZzwXPjnYAMYRnUUv4c1TREee";
// The vote account used in the dataset's example input (not in the fixture)
export const EXAMPLE_VOTE = "JDMq8hxZnad2smKLGkFbfg8zVMZHKQcMugD4tMR9u2da";

// Answers Solana JSON-RPC calls from the fixture; other requests go to the
// real fetch. Returns the mock so tests can count calls or make it fail.
export function stubSolanaRpc(options: { fail?: boolean } = {}) {
  const snapshot = solanaSnapshot();
  const results: Record<string, unknown> = {
    getEpochInfo: snapshot.epochInfo,
    getVoteAccounts: snapshot.voteAccounts,
    getBlockProduction: snapshot.blockProduction,
  };
  const realFetch = globalThis.fetch;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== PUBLIC_RPC_URL) return realFetch(input, init);
    if (options.fail) return new Response("rate limited", { status: 429 });
    const { method } = JSON.parse(String(init?.body));
    return Response.json({ jsonrpc: "2.0", id: 1, result: results[method] });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { type Attribution, type Dataset, badRequest, dataResponse } from "../../platform/dataset";
import { appendLogDetail } from "../../platform/telemetry";
import { RPC_CACHE_SECONDS, RpcUnavailableError, fetchSnapshot, type ChainSnapshot } from "./rpc";
import {
  SORT_KEYS,
  type SortKey,
  type ValidatorKey,
  findValidator,
  listValidators,
  networkSummary,
  validatorStats,
} from "./stats";
import { LIST_EXAMPLE, SUMMARY_EXAMPLE, VALIDATOR_EXAMPLE } from "./examples";

// Solana validator stats, computed live from public chain state (vote
// accounts, epoch info and leader-slot block production) on every call.
// Nothing is stored, so there is no history yet: vote credits cover the
// epochs the vote account itself keeps (the last 5 are compared).

export const ATTRIBUTION: Attribution = {
  publisher: "Solana mainnet-beta (public chain state via JSON-RPC)",
  licence: "Public on-chain data",
  licenceUrl: "https://solana.com/docs/rpc",
  text:
    "Computed from Solana mainnet-beta chain state (getVoteAccounts, getEpochInfo, getBlockProduction). " +
    `Values are normally at most ${RPC_CACHE_SECONDS} seconds old; meta.data_age_seconds gives the age.`,
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const q = (c: Context<AppEnv>, name: string) => c.req.query(name)?.trim() || undefined;

function readKey(c: Context<AppEnv>): ValidatorKey | string {
  const vote = q(c, "vote");
  const identity = q(c, "identity");
  if (!vote && !identity) return "Pass vote (vote account pubkey) or identity (validator identity pubkey).";
  if (vote && identity) return "Pass either vote or identity, not both.";
  const key = (vote ?? identity)!;
  if (!BASE58.test(key)) return `${vote ? "vote" : "identity"} must be a base58 Solana public key.`;
  return vote ? { vote } : { identity };
}

type ListInput = {
  sort: SortKey;
  maxCommission?: number;
  minStakeSol?: number;
  includeDelinquent: boolean;
  limit: number;
};

function readListInput(c: Context<AppEnv>): ListInput | string {
  const sort = (q(c, "sort") ?? "stake") as SortKey;
  if (!SORT_KEYS.includes(sort)) return `sort must be one of ${SORT_KEYS.join(", ")}.`;
  const num = (name: string, min: number, max: number): number | undefined | string => {
    const raw = q(c, name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : `${name} must be a number between ${min} and ${max}.`;
  };
  const maxCommission = num("max_commission", 0, 100);
  if (typeof maxCommission === "string") return maxCommission;
  const minStakeSol = num("min_stake_sol", 0, 1e12);
  if (typeof minStakeSol === "string") return minStakeSol;
  const limit = num("limit", 1, MAX_LIMIT);
  if (typeof limit === "string") return limit;
  const delinquent = q(c, "include_delinquent");
  if (delinquent !== undefined && !["true", "false"].includes(delinquent)) return "include_delinquent must be true or false.";
  return {
    sort,
    maxCommission,
    minStakeSol,
    includeDelinquent: delinquent === "true",
    limit: limit === undefined ? DEFAULT_LIMIT : Math.floor(limit),
  };
}

// Runs a handler on a fresh snapshot; an unreachable RPC answers 503
// Seconds since the snapshot was fetched, for meta.data_age_seconds
export function dataAge(s: ChainSnapshot): number {
  return s.fetchedAt === undefined ? 0 : Math.max(0, Math.round((Date.now() - s.fetchedAt) / 1000));
}

async function withSnapshot(c: Context<AppEnv>, fn: (s: ChainSnapshot) => Response): Promise<Response> {
  let snapshot: ChainSnapshot;
  try {
    snapshot = await fetchSnapshot(c.env);
  } catch (err) {
    if (!(err instanceof RpcUnavailableError)) throw err;
    c.set("logDetail", appendLogDetail(c.get("logDetail"), `[upstream] ${err.message}`.slice(0, 200)));
    return c.json(
      {
        error: "upstream_unavailable",
        message: "No Solana RPC endpoint answered; retry shortly.",
        detail: err.message.slice(0, 300),
      },
      503,
      { "Retry-After": "5" }
    );
  }
  return fn(snapshot);
}

export const solanaValidators: Dataset = {
  id: "solana-validators",
  title: "Solana validator stats",
  description:
    "Live Solana network health and per-validator stats: stake and rank, commission, vote credits per SOL " +
    "over the last 5 epochs relative to the cluster median, current-epoch block production and skip rate, delinquency. " +
    "Computed from public chain state on each call (at most a minute old); no history is stored yet.",
  attribution: ATTRIBUTION,
  tags: ["solana", "validators", "staking", "crypto", "onchain"],
  endpoints: [
    {
      method: "GET",
      path: "/summary",
      toolName: "get_network_summary",
      summary: "Get live Solana network health: epoch progress, validator counts, stake concentration and skip rate.",
      details:
        "Returns the current epoch and its progress, active and delinquent validator counts, total active stake " +
        "in SOL, the delinquent stake share, the Nakamoto coefficient (fewest validators holding over a third of " +
        "stake), median commission, cluster block production and skip rate so far this epoch, and median and best " +
        "vote credits per SOL staked in the last complete epoch. Use it as the baseline when judging a single validator.",
      outputExample: SUMMARY_EXAMPLE,
      handler: (c) => withSnapshot(c, (s) => dataResponse(c, solanaValidators, networkSummary(s), { data_age_seconds: dataAge(s) })),
    },
    {
      method: "GET",
      path: "/validator",
      toolName: "get_validator",
      summary: "Get live stats for one Solana validator by vote account or identity pubkey.",
      details:
        "Pass vote (vote account pubkey) or identity (node identity pubkey). Returns stake in SOL with share and " +
        "rank, commission, delinquency, how many slots its last vote is behind the cluster, vote credits for each " +
        "of the last 5 epochs per SOL staked, as a percentage of the cluster median (100 = median; approximate, " +
        "as it uses today's stake), and current-epoch leader slots, blocks produced and skip rate next to the cluster's. " +
        "Unknown keys return 404.",
      price: "$0.001",
      params: [
        { name: "vote", description: "Vote account pubkey (base58)", example: "JDMq8hxZnad2smKLGkFbfg8zVMZHKQcMugD4tMR9u2da" },
        { name: "identity", description: "Validator identity (node) pubkey (base58); use instead of vote" },
      ],
      exampleInput: { vote: "JDMq8hxZnad2smKLGkFbfg8zVMZHKQcMugD4tMR9u2da" },
      outputExample: VALIDATOR_EXAMPLE,
      handler: async (c) => {
        const key = readKey(c);
        if (typeof key === "string") return badRequest(c, key);
        return withSnapshot(c, (s) => {
          const v = findValidator(s, key);
          if (!v) {
            return c.json(
              { error: "not_found", message: "No vote account matches this key on Solana mainnet-beta." },
              404
            );
          }
          return dataResponse(c, solanaValidators, validatorStats(s, v), { data_age_seconds: dataAge(s) });
        });
      },
      preview: async (c) => {
        const key = readKey(c);
        if (typeof key === "string") return { valid: false, error: "bad_request", message: key };
        try {
          const found = Boolean(findValidator(await fetchSnapshot(c.env), key));
          return { valid: true, found, note: "Free preview of this call; pay to get the stats." };
        } catch (err) {
          if (err instanceof RpcUnavailableError) return null;
          throw err;
        }
      },
    },
    {
      method: "GET",
      path: "/validators",
      toolName: "list_validators",
      summary: "List Solana validators ranked by stake, vote credits, skip rate or commission, with filters.",
      details:
        "For choosing where to stake or comparing validators. sort is stake (default), credits (vote credits per " +
        "SOL in the last complete epoch, as % of the cluster median), skip_rate (current epoch, lowest first; validators with no leader slots yet " +
        "come last) or commission (lowest first). Filters: max_commission (percent), min_stake_sol, " +
        `include_delinquent (default false). Returns up to limit rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) ` +
        "and the number matched.",
      price: "$0.002",
      params: [
        { name: "sort", description: `One of ${SORT_KEYS.join(", ")} (default stake)`, example: "credits" },
        { name: "max_commission", description: "Only validators with commission at most this percent", example: "5" },
        { name: "min_stake_sol", description: "Only validators with at least this much active stake in SOL", example: "100000" },
        { name: "include_delinquent", description: "true to include delinquent validators (default false)" },
        { name: "limit", description: `Rows to return, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`, example: "10" },
      ],
      exampleInput: { sort: "credits", max_commission: "5", min_stake_sol: "100000", limit: "10" },
      outputExample: LIST_EXAMPLE,
      handler: async (c) => {
        const input = readListInput(c);
        if (typeof input === "string") return badRequest(c, input);
        return withSnapshot(c, (s) => {
          const { matched, validators, credits_epoch } = listValidators(s, input);
          return dataResponse(c, solanaValidators, validators, {
            matched,
            returned: validators.length,
            sort: input.sort,
            credits_epoch,
            epoch: s.epochInfo.epoch,
            data_age_seconds: dataAge(s),
          });
        });
      },
      preview: async (c) => {
        const input = readListInput(c);
        if (typeof input === "string") return { valid: false, error: "bad_request", message: input };
        try {
          const { matched } = listValidators(await fetchSnapshot(c.env), input);
          return { valid: true, matched, note: "Free preview of this call; pay to get the ranked list." };
        } catch (err) {
          if (err instanceof RpcUnavailableError) return null;
          throw err;
        }
      },
    },
  ],
  prompts: [
    {
      name: "solana_check_validator",
      title: "Check a Solana validator before staking",
      description: "Judge one validator's performance and fees against the rest of the network.",
      args: [{ name: "vote", description: "Vote account pubkey of the validator", required: true }],
      text: ({ vote }) =>
        "Check whether this Solana validator is a good place to stake. Call " +
        "solana_validators_get_network_summary (free) for the network baseline, then " +
        `solana_validators_get_validator with vote="${vote}". Explain in plain language its commission, whether it ` +
        "is delinquent or lagging, its vote credits per SOL over the last epochs compared with the cluster median, its skip " +
        "rate compared with the cluster, and its stake share (very large validators concentrate the network). " +
        "Include the attribution from the result.",
    },
  ],
};

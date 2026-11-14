import type { ChainSnapshot, RawVoteAccount } from "./rpc";

// Pure computations over one chain snapshot. Everything is derived from
// public chain state at query time; nothing is stored.

export const LAMPORTS_PER_SOL = 1_000_000_000;
// Vote credits are compared over this many most recent epochs
export const CREDIT_EPOCHS = 5;

export type Validator = RawVoteAccount & { delinquent: boolean };

// Vote credits scale with stake on current Solana versions, so validators
// are compared by credits per SOL of active stake, relative to the cluster
// median for the same epoch. Approximate: the stake is today's, not the
// stake the validator had during that epoch.
export type EpochCredits = {
  epoch: number;
  // null when the vote account has no entry for the epoch
  credits: number | null;
  credits_per_sol: number | null;
  // 100 = the cluster median; higher earns more per SOL staked
  pct_of_median: number | null;
  complete: boolean;
};

// Validators below this stake are left out of the median (their ratios are noisy)
export const MEDIAN_MIN_STAKE_SOL = 1_000;

const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export const toSol = (lamports: number) => round(lamports / LAMPORTS_PER_SOL, 3);

export function allValidators(snapshot: ChainSnapshot): Validator[] {
  return [
    ...snapshot.voteAccounts.current.map((v) => ({ ...v, delinquent: false })),
    ...snapshot.voteAccounts.delinquent.map((v) => ({ ...v, delinquent: true })),
  ];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Smallest number of validators whose combined stake exceeds one third of
// the total: the count that could halt the network (superminority)
export function nakamotoCoefficient(stakes: number[]): number {
  const total = stakes.reduce((a, b) => a + b, 0);
  let sum = 0;
  let count = 0;
  for (const s of [...stakes].sort((a, b) => b - a)) {
    sum += s;
    count++;
    if (sum > total / 3) return count;
  }
  return count;
}

export function creditsEarned(v: RawVoteAccount, epoch: number): number | null {
  const entry = v.epochCredits.find(([e]) => e === epoch);
  return entry ? entry[1] - entry[2] : null;
}

export function creditsPerSol(v: RawVoteAccount, epoch: number): number | null {
  const credits = creditsEarned(v, epoch);
  const sol = v.activatedStake / LAMPORTS_PER_SOL;
  return credits === null || sol <= 0 ? null : credits / sol;
}

// Cluster median of credits per SOL, per epoch
export function medianCreditsPerSol(validators: RawVoteAccount[], epochs: number[]): Map<number, number> {
  const out = new Map<number, number>();
  const eligible = validators.filter((v) => v.activatedStake >= MEDIAN_MIN_STAKE_SOL * LAMPORTS_PER_SOL);
  for (const epoch of epochs) {
    const m = median(eligible.map((v) => creditsPerSol(v, epoch)).filter((r): r is number => r !== null && r > 0));
    if (m) out.set(epoch, m);
  }
  return out;
}

export function recentEpochs(currentEpoch: number, count = CREDIT_EPOCHS): number[] {
  return Array.from({ length: count }, (_, i) => currentEpoch - i).filter((e) => e >= 0);
}

export function epochCredits(
  v: RawVoteAccount,
  epochs: number[],
  medianByEpoch: Map<number, number>,
  currentEpoch: number
): EpochCredits[] {
  return epochs.map((epoch) => {
    const perSol = creditsPerSol(v, epoch);
    const med = medianByEpoch.get(epoch);
    return {
      epoch,
      credits: creditsEarned(v, epoch),
      credits_per_sol: perSol === null ? null : round(perSol, 1),
      pct_of_median: perSol !== null && med ? round((perSol / med) * 100) : null,
      complete: epoch < currentEpoch,
    };
  });
}

export type BlockProduction = { leader_slots: number; blocks_produced: number; skip_rate_pct: number | null };

export function blockProduction(snapshot: ChainSnapshot, identity?: string): BlockProduction {
  const entries = identity
    ? [snapshot.blockProduction.value.byIdentity[identity] ?? [0, 0]]
    : Object.values(snapshot.blockProduction.value.byIdentity);
  let leader = 0;
  let produced = 0;
  for (const [slots, blocks] of entries) {
    leader += slots;
    produced += blocks;
  }
  return {
    leader_slots: leader,
    blocks_produced: produced,
    skip_rate_pct: leader ? round(((leader - produced) / leader) * 100) : null,
  };
}

function epochProgress(snapshot: ChainSnapshot) {
  const { epoch, slotIndex, slotsInEpoch, absoluteSlot } = snapshot.epochInfo;
  return {
    epoch,
    slot: absoluteSlot,
    slot_index: slotIndex,
    slots_in_epoch: slotsInEpoch,
    progress_pct: round((slotIndex / slotsInEpoch) * 100),
  };
}

export function networkSummary(snapshot: ChainSnapshot) {
  const validators = allValidators(snapshot);
  const active = validators.filter((v) => !v.delinquent);
  const totalStake = validators.reduce((a, v) => a + v.activatedStake, 0);
  const delinquentStake = validators.filter((v) => v.delinquent).reduce((a, v) => a + v.activatedStake, 0);
  const staked = validators.filter((v) => v.activatedStake > 0);
  const epoch = snapshot.epochInfo.epoch;
  const lastComplete = epoch - 1;

  return {
    epoch: epochProgress(snapshot),
    validators: {
      total: validators.length,
      active: active.length,
      delinquent: validators.length - active.length,
    },
    stake: {
      total_active_sol: toSol(totalStake),
      delinquent_pct: totalStake ? round((delinquentStake / totalStake) * 100) : 0,
      nakamoto_coefficient: nakamotoCoefficient(staked.map((v) => v.activatedStake)),
    },
    commission: {
      median_pct: median(staked.map((v) => v.commission)),
      zero_commission_validators: staked.filter((v) => v.commission === 0).length,
    },
    block_production_current_epoch: blockProduction(snapshot),
    vote_credits_last_epoch: {
      epoch: lastComplete,
      median_credits_per_sol: round(medianCreditsPerSol(validators, [lastComplete]).get(lastComplete) ?? 0, 1) || null,
    },
  };
}

export type ValidatorKey = { vote?: string; identity?: string };

export function findValidator(snapshot: ChainSnapshot, key: ValidatorKey): Validator | undefined {
  return allValidators(snapshot).find((v) =>
    key.vote ? v.votePubkey === key.vote : v.nodePubkey === key.identity
  );
}

// Validators ordered by stake, largest first (rank 1)
function stakeRanks(validators: Validator[]): Map<string, number> {
  return new Map(
    [...validators].sort((a, b) => b.activatedStake - a.activatedStake).map((v, i) => [v.votePubkey, i + 1])
  );
}

function lastVoteLag(validators: Validator[], v: Validator): number {
  let tip = 0;
  for (const x of validators) if (x.lastVote > tip) tip = x.lastVote;
  return Math.max(0, tip - v.lastVote);
}

export function validatorStats(snapshot: ChainSnapshot, v: Validator) {
  const validators = allValidators(snapshot);
  const totalStake = validators.reduce((a, x) => a + x.activatedStake, 0);
  const epoch = snapshot.epochInfo.epoch;
  const epochs = recentEpochs(epoch);
  const credits = epochCredits(v, epochs, medianCreditsPerSol(validators, epochs), epoch);
  return {
    vote_pubkey: v.votePubkey,
    identity_pubkey: v.nodePubkey,
    delinquent: v.delinquent,
    epoch: epochProgress(snapshot),
    stake: {
      active_sol: toSol(v.activatedStake),
      share_pct: totalStake ? round((v.activatedStake / totalStake) * 100, 4) : 0,
      rank: stakeRanks(validators).get(v.votePubkey) ?? null,
      of_validators: validators.length,
    },
    commission_pct: v.commission,
    ...(v.inflationRewardsCommissionBps !== undefined
      ? { inflation_rewards_commission_bps: v.inflationRewardsCommissionBps }
      : {}),
    voting: {
      last_vote_slot: v.lastVote,
      root_slot: v.rootSlot,
      slots_behind_tip: lastVoteLag(validators, v),
      epoch_credits: credits,
    },
    block_production_current_epoch: {
      ...blockProduction(snapshot, v.nodePubkey),
      cluster_skip_rate_pct: blockProduction(snapshot).skip_rate_pct,
    },
  };
}

export const SORT_KEYS = ["stake", "credits", "skip_rate", "commission"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type ListOptions = {
  sort: SortKey;
  maxCommission?: number;
  includeDelinquent: boolean;
  minStakeSol?: number;
  limit: number;
};

export function listValidators(snapshot: ChainSnapshot, opts: ListOptions) {
  const validators = allValidators(snapshot);
  const totalStake = validators.reduce((a, v) => a + v.activatedStake, 0);
  const epoch = snapshot.epochInfo.epoch;
  const lastComplete = epoch - 1;
  const medianPerSol = medianCreditsPerSol(validators, [lastComplete]).get(lastComplete);
  const ranks = stakeRanks(validators);
  const rows = validators
    .filter((v) => opts.includeDelinquent || !v.delinquent)
    .filter((v) => opts.maxCommission === undefined || v.commission <= opts.maxCommission)
    .filter((v) => opts.minStakeSol === undefined || v.activatedStake / LAMPORTS_PER_SOL >= opts.minStakeSol)
    .map((v) => {
      const perSol = creditsPerSol(v, lastComplete);
      const production = blockProduction(snapshot, v.nodePubkey);
      return {
        vote_pubkey: v.votePubkey,
        identity_pubkey: v.nodePubkey,
        stake_rank: ranks.get(v.votePubkey) ?? null,
        active_stake_sol: toSol(v.activatedStake),
        stake_share_pct: totalStake ? round((v.activatedStake / totalStake) * 100, 4) : 0,
        commission_pct: v.commission,
        last_epoch_credits_pct_of_median: perSol !== null && medianPerSol ? round((perSol / medianPerSol) * 100) : null,
        skip_rate_pct: production.skip_rate_pct,
        leader_slots: production.leader_slots,
        delinquent: v.delinquent,
      };
    });
  const matched = rows.length;
  rows.sort(comparator(opts.sort));
  return { matched, validators: rows.slice(0, opts.limit), credits_epoch: lastComplete };
}

type Row = ReturnType<typeof listValidators>["validators"][number];

// Best first; validators without a value (no leader slots yet) sort last
function comparator(sort: SortKey): (a: Row, b: Row) => number {
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) =>
    a === null ? (b === null ? 0 : 1) : b === null ? -1 : (a - b) * dir;
  switch (sort) {
    case "stake":
      return (a, b) => b.active_stake_sol - a.active_stake_sol;
    case "credits":
      return (a, b) => nullsLast(a.last_epoch_credits_pct_of_median, b.last_epoch_credits_pct_of_median, -1) || b.active_stake_sol - a.active_stake_sol;
    case "skip_rate":
      return (a, b) => nullsLast(a.skip_rate_pct, b.skip_rate_pct, 1) || b.active_stake_sol - a.active_stake_sol;
    case "commission":
      return (a, b) => a.commission_pct - b.commission_pct || b.active_stake_sol - a.active_stake_sol;
  }
}

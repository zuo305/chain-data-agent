// Output examples published to x402 Bazaar discovery and the docs. Taken
// from a real mainnet-beta snapshot (epoch 1086, 2026-11-14), shortened.

const EXAMPLE_ATTRIBUTION = {
  publisher: "Solana mainnet-beta (public chain state via JSON-RPC)",
  licence: "Public on-chain data",
};

export const SUMMARY_EXAMPLE = {
  "data": {
    "epoch": {
      "epoch": 1086,
      "slot": 469241436,
      "slot_index": 89436,
      "slots_in_epoch": 432000,
      "progress_pct": 20.7
    },
    "validators": {
      "total": 699,
      "active": 660,
      "delinquent": 39
    },
    "stake": {
      "total_active_sol": 429651630.953,
      "delinquent_pct": 0.14,
      "nakamoto_coefficient": 18
    },
    "commission": {
      "median_pct": 5,
      "zero_commission_validators": 229
    },
    "block_production_current_epoch": {
      "leader_slots": 89435,
      "blocks_produced": 89392,
      "skip_rate_pct": 0.05
    },
    "vote_credits_last_epoch": {
      "epoch": 1085,
      "median_credits_per_sol": 142934.2
    }
  },
  "meta": {},
  attribution: EXAMPLE_ATTRIBUTION,
};

export const VALIDATOR_EXAMPLE = {
  "data": {
    "vote_pubkey": "JDMq8hxZnad2smKLGkFbfg8zVMZHKQcMugD4tMR9u2da",
    "identity_pubkey": "DUND26mEDfFeaPsVof3YvbXDRvpuQX7HMUJrLgEWzYw4",
    "delinquent": false,
    "epoch": {
      "epoch": 1086,
      "slot": 469241436,
      "slot_index": 89436,
      "slots_in_epoch": 432000,
      "progress_pct": 20.7
    },
    "stake": {
      "active_sol": 2500000.992,
      "share_pct": 0.5819,
      "rank": 43,
      "of_validators": 699
    },
    "commission_pct": 100,
    "inflation_rewards_commission_bps": 10000,
    "voting": {
      "last_vote_slot": 469241425,
      "root_slot": 469241407,
      "slots_behind_tip": 7,
      "epoch_credits": [
        {
          "epoch": 1086,
          "credits": 75116475950,
          "credits_per_sol": 30046.6,
          "pct_of_median": 101.56,
          "complete": false
        },
        {
          "epoch": 1085,
          "credits": 350729897051,
          "credits_per_sol": 140291.9,
          "pct_of_median": 98.15,
          "complete": true
        }
      ]
    },
    "block_production_current_epoch": {
      "leader_slots": 528,
      "blocks_produced": 528,
      "skip_rate_pct": 0,
      "cluster_skip_rate_pct": 0.05
    }
  },
  "meta": {},
  attribution: EXAMPLE_ATTRIBUTION,
};

export const LIST_EXAMPLE = {
  "data": [
    {
      "vote_pubkey": "4jEHuQZTNTRYAhxRYEjV3HJ1b4wqdQjnBRdPzFWzkCft",
      "identity_pubkey": "HW4zorvt6xDwhU36RqjcWNwU8YMj9tiqnAafBKW4cqV",
      "stake_rank": 276,
      "active_stake_sol": 206930.65,
      "stake_share_pct": 0.0482,
      "commission_pct": 0,
      "last_epoch_credits_pct_of_median": 268.41,
      "skip_rate_pct": 0,
      "leader_slots": 168,
      "delinquent": false
    },
    {
      "vote_pubkey": "4tuMshQNpAFpy1YtEHnSsE5EPN1mAT8FevWvn2UPJHNM",
      "identity_pubkey": "ALp2GdA1eJV8vZHMHazCtTxNXe3BLUSco9LDASgjDs8R",
      "stake_rank": 252,
      "active_stake_sol": 227486.507,
      "stake_share_pct": 0.0529,
      "commission_pct": 0,
      "last_epoch_credits_pct_of_median": 241.98,
      "skip_rate_pct": 0,
      "leader_slots": 88,
      "delinquent": false
    }
  ],
  "meta": {
    "matched": 408,
    "returned": 10,
    "sort": "credits",
    "credits_epoch": 1085,
    "epoch": 1086
  },
  attribution: EXAMPLE_ATTRIBUTION,
};

// Output examples published to x402 Bazaar discovery and the docs, from a
// real mainnet-beta snapshot taken on 2026-11-15 (lists shortened).

const EXAMPLE_ATTRIBUTION = {
  publisher: "Solana mainnet-beta (stake account lockups via JSON-RPC)",
  licence: "Public on-chain data",
};

export const SUMMARY_EXAMPLE = {
  data: {
    "locked": {
      "sol": 16478396.318,
      "accounts": 719,
      "delegated_sol": 15829489.871
    },
    "next_unlock_day": {
      "date": "2026-11-19",
      "sol": 1724.598,
      "accounts": 1
    },
    "next_7_days": {
      "sol": 1724.598,
      "accounts": 1
    },
    "next_30_days": {
      "sol": 1031119.694,
      "accounts": 44
    },
    "next_90_days": {
      "sol": 2911339.835,
      "accounts": 214
    },
    "next_365_days": {
      "sol": 12494945.986,
      "accounts": 646
    },
    "last_unlock_date": "2028-11-11"
  },
  meta: {
    "refreshed_at": "2026-11-15T23:05:12Z",
    "data_age_seconds": 1210
  },
  attribution: EXAMPLE_ATTRIBUTION,
};

export const CALENDAR_EXAMPLE = {
  data: [
    {
      "period": "2026-12",
      "sol": 992262.239,
      "accounts": 46,
      "delegated_sol": 983441.239,
      "largest_account_sol": 204160.289
    },
    {
      "period": "2027-01",
      "sol": 910555.082,
      "accounts": 123,
      "delegated_sol": 897316.637,
      "largest_account_sol": 204149.638
    },
    {
      "period": "2027-02",
      "sol": 911274.01,
      "accounts": 45,
      "delegated_sol": 866182.01,
      "largest_account_sol": 204165.461
    },
    {
      "period": "2027-03",
      "sol": 864665.06,
      "accounts": 39,
      "delegated_sol": 864665.06,
      "largest_account_sol": 204152.223
    },
    {
      "period": "2027-04",
      "sol": 888123.662,
      "accounts": 48,
      "delegated_sol": 853998.662,
      "largest_account_sol": 204146.313
    },
    {
      "period": "2027-05",
      "sol": 1366350.612,
      "accounts": 59,
      "delegated_sol": 1356020.612,
      "largest_account_sol": 500000
    }
  ],
  meta: {
    "group": "month",
    "from": "2026-12-01",
    "to": "2027-05-31",
    "periods": 6,
    "refreshed_at": "2026-11-15T23:05:12Z",
    "data_age_seconds": 1210
  },
  attribution: EXAMPLE_ATTRIBUTION,
};

export const UNLOCKS_EXAMPLE = {
  data: [
    {
      "stake_account": "D1iUaddNCTu2HsinYefkNb8CurCSHM48wzvfGmntUuew",
      "sol": 195511.613,
      "unlocks_at": "2026-12-07T00:00:00Z",
      "withdraw_authority": "2Wk4x9xaxmqvXr7amKA36UaQzPcqri3HCGmg6wWxo7c5",
      "custodian": "3XdBZcURF5nKg3oTZAcfQZg8XEc5eKsx6vK8r3BdGGxg",
      "delegated_to": "CvSb7wdQAFpHuSpTYTJnX5SYH4hCfQ9VuGnqrKaKwycB"
    },
    {
      "stake_account": "6vqG1wtqk5egjijTMzBdWWimVzebubvE9aUZAw6uW5Xx",
      "sol": 112192.489,
      "unlocks_at": "2026-12-07T00:00:00Z",
      "withdraw_authority": "G62LeCBehaarj5iVh58s7QTC61upEJiJhuK3BCQ2GqW6",
      "custodian": "3XdBZcURF5nKg3oTZAcfQZg8XEc5eKsx6vK8r3BdGGxg",
      "delegated_to": "HimWQUK61d9wxhw7EYu9jUje7xQiDs4jKexaTSvuCmXE"
    }
  ],
  meta: {
    "matched": 14,
    "matched_sol": 905417.41,
    "returned": 20,
    "refreshed_at": "2026-11-15T23:05:12Z",
    "data_age_seconds": 1210
  },
  attribution: EXAMPLE_ATTRIBUTION,
};

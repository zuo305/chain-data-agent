# Token unlocks from on-chain data: feasibility check (2026-11-15)

Question: can we build our own token unlock data from on-chain vesting
contracts (aggregators such as DefiLlama, Tokenomist, CryptoRank and
Messari do not allow resale)? Threshold set beforehand: worth building only
if roughly half or more of the large upcoming unlocks can be read on-chain.

Method: list of the ~25 largest scheduled unlocks between 2026-11-16 and
2027-01-15 (mrnasdog month pages, CoinGabbar, Tokenomics.com; DefiLlama,
CryptoRank and Tokenomist answered 403), then for each token how the unlock
is enforced, from docs, governance posts, news and, for Solana, our own
`getProgramAccounts` queries. DefiLlama's emissions-adapters repo (which
cites contract addresses) could not be reached from the session.

## Classification

A = on-chain schedule readable; B = on-chain lock, schedule only partly
readable or mutable; C = custodian, foundation multisig or manual release
(schedule only in docs); ? = not determined.

| Token | Class | Mechanism | Confidence |
|---|---|---|---|
| SOL (stake lockups) | A | Stake program accounts, `lockup.unix_timestamp` @76; 366 locked accounts, ~6.24M SOL expiring Nov 2026 to Jun 2027; Dec 11 204,160, Dec 20 100,000, Jan 11 204,150; ~640k SOL on the 7th of each month | high (queried) |
| PUMP | B | Streamflow holds 44.7B unvested in 135 monthly streams (2 senders), far below the ~330B team+investor allocation | high for escrow, med for coverage |
| ARB | A (partial) | 151 per-investor vesting wallets (OZ VestingWallet variant, inferred); some team tokens at Coinbase Custody | med |
| LDO | A | Aragon TokenManager vestings (`getVesting`), Vote #197 | med-high |
| MORPHO | A (inferred) | DssVest `awards(id)` | med-low |
| WLD | A (secondary source) | 4 "Vesting Wallet" contracts; schedule extended in 2024 | med-low |
| CRO | A (not EVM) | Cosmos SDK vesting account on Cronos POS | med |
| APT | A | `0x1::vesting` resources; 4-year schedule probably ended Sep-Oct 2026 | med |
| GRAM (Toncoin) | A | TON Believers Fund locker, 1/36 a month | med |
| CC (Canton) | A (issuance) | `AmuletRules` minting via Scan API, not a lock | med |
| STRK | B | Partly a lock contract on Ethereum (date changed by tx), partly custodians | med |
| ENA | C | Coinbase Prime Custody; investor schedule changed off-chain | med |
| MON | C | Anchorage, BitGo, Coinbase Custody; locked tokens cannot be staked | med |
| SUI | C | Third-party custodians (stake subsidy part is protocol state) | med |
| HYPE | C | Manual unstake and distribution; 7-day unstaking queue gives ~1 week notice | med |
| TRUMP | C (inferred) | Not in Jupiter Lock or Streamflow; insider wallets | med |
| JTO | C (inferred) | No vesting program holds the tranches | med |
| ZRO, FF, LIT, PIEVERSE, SEI, XPL | ? | No contract or custodian found | low |

Summary: of 23 tokens, 9 are A (only SOL verified by query), 2 are B, 6 are
C, 6 undetermined. The largest unlock of the period (MON, $240-340M) and
most large L1 unlocks (SUI, HYPE, ENA, likely TRUMP and JTO) are custodial.
The A tokens use about nine different mechanisms (OZ VestingWallet, Aragon
TokenManager, DssVest, Cosmos vesting accounts, Solana stake lockups,
Streamflow, Aptos vesting, a TON locker, Canton issuance), so each needs its
own reader and per-token curation (contract discovery, team vs investor
labels). Several readable schedules were later changed (STRK, WLD, ENA).

## Vesting infrastructure

- Sablier: maintenance mode since 2026-07-13, wind-down by June 2028.
- Hedgey: acquired by Anchorage (Dec 2025). Magna: acquired by Kraken
  (Feb 2026); supports off-chain tracking and partial funding. Liquifi:
  acquired by Coinbase (Token Manager). Vesting is moving into custodians.
- Streamflow (Solana, claims $1.4B+ TVL) and Jupiter Lock (Solana) are open,
  readable by mint with `getProgramAccounts` memcmp filters.
- Team vs investor is almost never encoded on-chain; it needs labelling.
- No published estimate of the custodial share; Tokenomist grades its own
  schedules by source ("Vesting Contract" vs "Public Project Data").

## Conclusion

A complete unlock calendar from on-chain data is not feasible: below the
threshold, the biggest unlocks are custodial, and the readable ones are
fragmented across many mechanisms. Two narrower options fit our Solana
dataset and the free tier:

1. SOL stake lockup calendar: exact, verified, one RPC query (via the cron
   into D1); answers "how much SOL unlocks when", which no free API offers.
2. Solana vesting escrows by mint (Streamflow + Jupiter Lock): "verified
   on-chain vesting for token X" (unvested, next release), partial coverage
   stated explicitly.

Possible later add-on: release detection for custodial tokens (watch known
addresses and HYPE's unstaking queue), which reports after the fact.

# Chain Data Agent

On-chain data sold to AI agents. Agents discover the service through
`llms.txt`, an MCP server and a JSON catalog, and pay per call with
[x402](https://x402.org) (USDC on Base, no signup, no API key).

This is an experiment to find which on-chain data agents actually pay for.
It reuses the dataset-agnostic platform of
[agent-data-platform](https://github.com/zuo305/agent-data-platform), whose
first month showed that discovery works but demand needs a better fit: its
callers are crypto-native agents, and NSW planning data was not what they
needed.

**Datasets:** Solana validator stats (live).

## Principles

- **Find demand cheaply.** Each experiment is a few endpoints computed live
  from public chain state; nothing is stored until an endpoint has paying users.
- **$0 to run.** Cloudflare Workers Free, D1 free tier, public RPC endpoints,
  GitHub Actions on a public repository.
- **Own the data path.** Use public chain state or sources whose terms permit
  commercial redistribution; never resell aggregators that forbid it.
- **Agents are first-class customers.** Machine-readable docs, predictable
  JSON envelopes, clear prices, a free summary endpoint per dataset and a free
  preview in every 402.
- **Measure everything.** Caller type, tool, tier and failures are logged.

## How it works

```
Agent ──GET /v1/solana-validators/validator?vote=…──▶ Worker
      ◀──402 + PAYMENT-REQUIRED (+ free preview)───── (price, network, payTo)
      ──GET + PAYMENT-SIGNATURE────────────────────▶ x402 middleware ──verify──▶ facilitator
                                                     handler ──JSON-RPC──▶ Solana (cached 60 s)
      ◀──200 { data, meta, attribution } + PAYMENT-RESPONSE (settled)
```

The platform (`src/platform/`) derives routing, x402 pricing, MCP tools,
OpenAPI, `llms.txt`, well-known discovery files, the website and telemetry
from each dataset's declaration. See agent-data-platform's README for the
platform's design notes; the files are the same apart from `src/service.ts`.

### Project structure

```
src/
├── index.ts                  # App entry: middleware order, mounts datasets
├── service.ts                # Service identity: name, description, base URL
├── types.ts                  # Worker bindings and context variables
├── platform/                 # Dataset-agnostic layer (from agent-data-platform)
└── datasets/
    ├── registry.ts           # The list of live datasets
    └── solana-validators/    # Live Solana network and validator stats
        ├── rpc.ts            # JSON-RPC client with a 60 s Workers cache
        ├── stats.ts          # Pure computations over one chain snapshot
        ├── examples.ts       # Output examples for Bazaar and docs
        └── index.ts          # Endpoints, prices, prompts
migrations/                   # D1 schema (platform tables only)
fixtures/solana/              # Trimmed real mainnet-beta snapshot for tests
scripts/                      # x402 payment and Bazaar listing tools
test/                         # Vitest unit tests
```

## Solana validator stats (v1)

| Endpoint | MCP tool | Price | Description |
|---|---|---|---|
| `GET /v1/solana-validators/summary` | `solana_validators_get_network_summary` | free | Epoch progress, validator counts, total and delinquent stake, Nakamoto coefficient, median commission, cluster skip rate, median vote credits per SOL |
| `GET /v1/solana-validators/validator` | `solana_validators_get_validator` | $0.001 | One validator by `vote` or `identity`: stake, share and rank, commission, delinquency, slots behind tip, vote credits per SOL for the last 5 epochs vs the cluster median, current-epoch block production and skip rate |
| `GET /v1/solana-validators/validators` | `solana_validators_list_validators` | $0.002 | Validators ranked by `stake`, `credits`, `skip_rate` or `commission`, filtered by `max_commission`, `min_stake_sol`, `include_delinquent`; up to 50 rows |

Notes:
- Data is computed on each call from `getVoteAccounts`, `getEpochInfo` and
  `getBlockProduction` (mainnet-beta). RPC results are fresh for 60 s in the
  Workers cache; when every endpoint refuses, an answer up to 1 hour old is
  served instead: from the edge cache of that location or, failing that,
  from the `rpc_snapshot` table in D1, which the cron trigger refreshes every
  10 minutes with the raw (unparsed) RPC answers (3 rows written per run,
  ~430 a day). Every response has `meta.data_age_seconds`. Added on
  2026-11-15 after a paid call got 503 when both free endpoints refused and
  the serving location had no cached answer (the payment was not taken).
- Measured 2026-11-14: `getVoteAccounts` is ~315 KB for ~700 validators.
  Parsing plus computing takes ~3 ms warm, 4–7 ms cold (free plan limit:
  10 ms CPU per request).
- Vote credits scale with stake on current Solana versions (~143k credits
  per SOL per epoch in epoch 1085), so validators are compared by credits
  per SOL relative to the cluster median (validators under 1,000 SOL are
  left out of the median). This uses today's stake, so validators whose
  stake changed recently look better or worse than they were.
- RPC endpoints are tried in order: `SOLANA_RPC_URL` (if set), the public
  `api.mainnet-beta.solana.com`, then PublicNode's free
  `solana-rpc.publicnode.com`; a 503 `upstream_unavailable` names each host
  and why it failed. On the first deploy (2026-11-14) the Worker could not
  get an answer from the public endpoint although it works from elsewhere
  (likely blocking or rate limiting Cloudflare egress), hence the fallback.
  The next request then got 403 (official) and 429 (PublicNode) for
  `getBlockProduction` only, and succeeded a minute later: the free
  endpoints rate limit Cloudflare's shared egress intermittently, hence the
  stale fallback. A free-tier provider key goes in a Secret, not in
  `wrangler.toml`.

## Data sources

| Source | Terms | Commercial use | Status |
|---|---|---|---|
| Solana mainnet-beta chain state (JSON-RPC) | Public blockchain data | Yes | Live as `solana-validators` |
| DefiLlama unlocks / emissions | Site terms: personal, non-commercial use | **No** (without a licence) | Excluded |
| beaconcha.in API | API terms forbid redistribution and commercial exploitation | **No** | Excluded |
| Tokenomist, Messari, CryptoRank, Rated | Paid APIs, no resale | **No** | Excluded |

## Deployment

Deploys happen **only** through Cloudflare Workers Builds on push to `main`.
Never run `wrangler deploy` from a dev session.

One-time setup in the new Cloudflare account (free plan):

1. D1 → create database `chain-data-agent`; put its id in `wrangler.toml` (done).
2. Workers → connect the Git repository `zuo305/chain-data-agent`,
   production branch `main`, build command empty, deploy command
   `npm run deploy`. The build API token needs **D1 Edit**.
3. Put the `workers.dev` URL in `src/service.ts` (`BASE_URL`).
4. Before taking payments: set `X402_PAY_TO` (a new payee wallet) and the
   CDP secrets `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET`; switch
   `X402_NETWORK` to `eip155:8453` for mainnet.

Configuration (`wrangler.toml` `[vars]`, all public): `X402_PAY_TO`,
`X402_NETWORK`, `X402_FACILITATOR_URL`, `SOLANA_RPC_URL`, and the optional
listing vars documented in `src/types.ts`. Secrets: `CDP_API_KEY_ID`,
`CDP_API_KEY_SECRET`, `ADMIN_TOKEN`, `CLIENT_ID_SECRET`.

## Development (in a cloud session)

```bash
npm install
npm run db:migrate:local      # apply migrations to local D1
npm test                      # unit tests
npm run typecheck
npm run build:check           # bundle the Worker without deploying
npm run dev                   # local Worker on :8787
```

```bash
curl localhost:8787/llms.txt
curl localhost:8787/v1/solana-validators/summary
curl -i "localhost:8787/v1/solana-validators/validator?vote=JDMq8hxZnad2smKLGkFbfg8zVMZHKQcMugD4tMR9u2da"  # 503 until X402_PAY_TO is set, then 402
```

## Milestones

### M0 — Foundations
- [x] Repository created (public, for free GitHub Actions)
- [x] Platform copied from agent-data-platform; service identity in `src/service.ts`
- [x] Consolidated platform migration (`0001_platform.sql`)
- [x] First dataset: Solana validator stats, computed live (1 free, 2 paid endpoints)
- [x] New Cloudflare account (free) and D1 database `chain-data-agent` (Eastern North America, 2026-11-14)
- [x] Workers Builds connected to `main`; first deploy 2026-11-14
- [x] Real `BASE_URL` in `src/service.ts`: https://chain-data-agent.wangzuo305.workers.dev
- [x] RPC access from production (2026-11-14): free summary live with PublicNode fallback and stale cache; paid routes 503 until a payee is set; `llms.txt`, MCP card, OpenAPI live
- [x] CPU time in production (2026-11-14): median 1.27 ms over 53 invocations, 0 errors (free plan limit 10 ms)
- [x] Payee wallet (shared with agent-data-platform), own CDP Secret API key (no account permissions), Base mainnet (2026-11-14)
- [x] `server.json` added (2026-11-14); `.github/workflows/publish-mcp.yml` published it to the MCP Registry as `io.github.zuo305/chain-data-agent` 0.1.0 (live 2026-11-14), and does so again whenever it changes on `main` (bump `version` with every change, keep it in sync with `SERVICE.version`)

### Resolved (2026-11-14): paid routes answered 503 / 1101
- Error 1101: the x402 middleware started the facilitator's `getSupported`
  call when it was created, inside whichever request came first (often a
  free one); later requests awaited that promise after Workers had
  cancelled its I/O. Fixed in 879789d (the resource server is initialized
  inside the paid request). **Port this to agent-data-platform.**
- 503 `Facilitator does not support exact on eip155:8453`: the CDP secrets
  had been added as *build* variables, so at runtime the Worker fell back
  to the public x402.org facilitator (testnet only). They must be runtime
  Secrets (Settings → Variables and Secrets).
- Harmless log noise: `@x402/extensions` validates Bazaar schemas with Ajv,
  which needs `new Function` (not allowed in Workers), so it logs "Error
  compiling schema" and skips local validation; the metadata is still sent.

### M1 — Find demand
- [x] `ADMIN_TOKEN` and `CLIENT_ID_SECRET` set as Worker secrets (2026-11-15): `/admin/usage` enabled, anonymous client ids from then on
- [x] Both paid HTTP routes listed in the CDP x402 Bazaar (seen 2026-11-15) without paying ourselves: the settlements from PayAPI's review and from x402 crawlers were enough. The 2 MCP tools are not listed yet; the manual workflow **List in x402 Bazaar** (`.github/workflows/bazaar-list.yml`, repository secret `PAYER_PRIVATE_KEY`) can pay them once with `only` = `tool` ($0.003)
- [x] 402 Index (2026-11-14): both paid routes registered through its API (category `crypto`) and approved after domain verification via `/.well-known/402index-verify.txt` (`INDEX402_VERIFY_HASH`); the claim token for editing listings is kept outside the repo
- [x] agent-tools.cloud (2026-11-14): both paid routes auto-verified and listed, MCP server indexed (submitted through its API, contact johnzuo305@gmail.com)
- [ ] PayAPI Market: both paid routes submitted through its API on 2026-11-14 (pending review). Its review pays one call per route from its own wallet, which also gets the HTTP routes listed in the CDP Bazaar
- [ ] mcpservers.org: web form (owner to submit)
- [ ] Glama, PulseMCP: pick servers up from the MCP Registry automatically; Smithery and AllMCPs need the owner's account
- [ ] First paid call from an agent that is not a directory, verifier or probe
- [ ] Decide after ~2 weeks of listings: keep, change or drop Solana validator stats

### M2 — Next experiments (each one only after a demand check)
- [ ] Token unlocks from on-chain vesting contracts (Sablier, Hedgey, Streamflow): measure coverage of the 10–20 largest upcoming unlocks first; below ~50% the on-chain route does not work
- [ ] Validator history (needs storage, e.g. a daily GitHub Actions snapshot) once the live endpoints have users
- [ ] Ethereum validators: on hold (≈1M validators do not fit the free D1 tier; operator labels have licence issues)

# CLAUDE.md

Working rules for Claude Code sessions on this repository. See README.md for
the project plan, architecture and milestones.

## Language

- All code, comments, identifiers, log messages, commit messages and docs in
  the repo are written in **English**.
- Explanations to the user (chat replies, summaries) are written in **Chinese**.

## Goal and budget

- This is an experiment to find real demand for paid on-chain data among AI
  agents. Ship small, measure, drop what nobody uses.
- **$0 budget**: everything must run on free tiers (Cloudflare Workers Free,
  D1 free, public RPC endpoints, GitHub Actions on a public repo). Do not add
  anything that needs a paid plan without asking first.
- Prefer live queries of public chain state that store nothing. Add storage
  (history) only for endpoints that have proven demand.

## Workflow

- All work happens in cloud sessions; nothing is kept on a local machine.
  Commit and push frequently so no work lives only in a session container.
- Push directly to `main` (no feature branches or PRs unless asked).
- Before every push, run and pass:
  `npm run typecheck && npm test && npm run build:check`
  (`build:check` writes to `dist/`, which is git-ignored).

## Deployment

- Deploy **only** via Cloudflare Workers Builds, triggered by a push to `main`.
  The deploy command is `npm run deploy` (D1 migrations, then `wrangler deploy`).
- **Never** run `wrangler deploy`, `npm run deploy`, `npm run db:migrate:remote`
  or any `wrangler ... --remote` write command from a session.
- Schema changes go in a new numbered file under `migrations/`; never edit an
  applied migration.

## Code conventions

- Platform code (`src/platform/`) stays dataset-agnostic. Service identity
  (name, description, base URL) lives in `src/service.ts`. Dataset code lives
  in `src/datasets/<id>/` and is registered in `src/datasets/registry.ts`.
- The platform was copied from `zuo305/agent-data-platform` (November 2026);
  fixes to shared platform code may be worth porting in either direction.
- Paid endpoints are declared by setting `price` on an endpoint; never
  hand-write x402 route config.
- Every data response uses the `{ data, meta, attribution }` envelope via
  `dataResponse()`.
- Data sources: only public chain state or sources whose terms permit
  commercial redistribution. Do not resell data from aggregators (DefiLlama,
  beaconcha.in, Tokenomist, Rated, ...) whose terms forbid it. Record the
  source in the dataset's `attribution` and README.
- Free plan CPU limit is 10 ms per request: measure the CPU cost of any
  handler that parses large RPC responses (see the Solana notes in README).
- Secrets never go in the repo (including RPC URLs that embed an API key).
  Public config (e.g. the payee wallet address) lives in `wrangler.toml` `[vars]`.

## Checking usage

Production usage stats: `curl -s
https://chain-data-agent.wangzuo305.workers.dev/admin/usage?days=7`
with no Authorization header: the cloud environment has a network secret for
this host that adds `Authorization: Bearer <ADMIN_TOKEN>` to every request,
so the token never appears in the session. (Public routes ignore Bearer
values that are not `adp_` API keys, so the header is harmless elsewhere.
`ADMIN_TOKEN` in the environment variables belongs to agent-data-platform.)
A 401 means the network secret is missing or outdated. Anonymous
client ids (`CLIENT_ID_SECRET`) are recorded since 2026-11-15; earlier rows
have none. Our own test traffic shows up there too.

Routine requests from self-identified bots are logged as a 1-in-10 sample
(`usage_log.weight` = 10); ad hoc queries must sum `weight`, not count rows.

To tell real customers from verifiers, look at the payer wallets of paid
calls on Base (USDC `Transfer` logs to the payee). Base produces a block
every 0.2 s, so convert times to block numbers with that rate. Wallets that
pay dozens of x402 services within an hour are crawlers or verifiers.
A wallet that comes back is not demand by itself: check what else it pays in
the same burst (the CDP discovery API, `/platform/v2/x402/discovery/merchant
?payTo=<recipient>`, names the services). Known sampler: `0xaa34…1db3` pays
20-28 unrelated x402 services (weather, fortune demos, JSON validators, chat
models, ...) every 6 hours at 01/07/13/19 UTC, including our cheapest route.
Other known verifiers: `0x171d…0fca` (PayAPI Market review, one call per
newly submitted route), `0xa1d1…1978` (SettledScout, settled.tools: pays each
x402 service once, ~200 recipients a day) and `0x82ce…6f86` (pays ~2,700
calls to ~860 recipients a day; shares a client id with SettledScout).

## Calling production

When calling production by hand (curl, scripts), send
`User-Agent: chain-data-agent-selftest/0.1 (+https://github.com/zuo305/chain-data-agent)`.
The contact URL makes it classify as a bot, so our own tests stay out of
the client funnel and the free-call allowance.

`/admin/usage` reads the whole stats window several times against D1's 5M
rows/day free limit: never poll it (e.g. to wait for a deploy); check a public
endpoint instead.

## Ending a session

Before ending a session, update the **Milestones** checklist (and any status
tables) in README.md to reflect progress, then commit and push.

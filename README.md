# CL Vault Monitor — live dashboard

Self-contained live monitor for the Harvest Aerodrome CL vaults on Base. A small Node server re-reads
on-chain state on a timer and serves the dashboard; the page reloads its data when a newer snapshot
lands and remembers each viewer's pool, timeframe and chart choices.

## Add a vault

1. Add one line to `vaults.json`:

   ```json
   {"id": "aeroCL_USDC_cbBTC_16edge", "vault": "0x…", "label": "always in, edge re-entry"}
   ```

   - `vault` (required): the vault's address.
   - `id` (recommended): any unique name. Keep it once chosen: the API and anything reading it use it.
     Without one the vault gets `vault_<first 8 hex digits>`.
   - `label` (optional): what the page calls the vault. Defaults to its range width, e.g. `2.02%`.
   - `startTs` (optional): unix seconds; history before it is ignored (samples, events, figures). Use
     it to skip a seeding period, e.g. the time of the first real deposit.
   - `pool` (optional): only if the collector cannot find the pool on chain (it says so in the log).

2. Commit and push (Railway redeploys), or restart the server locally.

3. On the next refresh the collector reads everything else on chain: the design, pool, tokens,
   decimals, symbols, range width, strategy, gauge and (for the parked design) the lending pool. It
   finds the vault's birth block, reads every rebalance and harvest since then, and fills an hourly
   sample grid from birth to now: one sample per day first, so the whole history shows at once, then
   finer with each refresh (a new vault of a few weeks is complete in one or two refreshes).

Designs it knows: `CLVault` (V1), `CLVaultV2`, `CLVaultV3` (including the gauge strategy that sells
AERO for USDC and sends it to the vault) and `ParkedVault`. Vaults on the same pool are shown together.

## Aerodrome addresses: `chain.json`

Nothing about Aerodrome's deployment is written into the code. `chain.json` (or the file `CHAIN_CONFIG`
names) lists, each with a note:

- `usdc`: the token prices are read against;
- `factories` and `tickSpacings`: where the X/USDC pools that price tokens are searched for. It lists the
  original factory, the stock vaults' second factory, and the factory of Aerodrome's deployment live from
  2026-10-22;
- `rewardTokens`: AERO and the new AERO it converts to 1:1. Any of them arriving at a strategy in a
  harvest's transaction counts as reward claimed, whether the gauge sends it or a voter mints it;
- `rewardPricePools`: optional fixed AERO/USDC pools; empty means every reward-token/USDC pool on the
  factories;
- `claimEvents`: gauge events that mark a harvest (`ClaimRewards` on the gauges before 2026-10-22);
- `harvestEvent`: the controller's `SharePriceChangeLog`, which marks every harvest whatever the gauge
  or the reward.

A price at a block (AERO for the income of V1/V2 vaults, the vault tokens for TVL and for valuing AERO
in token0) comes from the candidate pool with the most liquidity in range at that block, whichever of
its two tokens is USDC. So the price follows liquidity from the old AERO/USDC pools to the new ones
(where AERO is token0), and a pool not yet funded is never used. The pools found are kept for 6 hours.

Vaults on Aerodrome's new gauges: a V3 vault's harvests and AERO income come from its strategy's own
`RewardSold` events (the new gauges emit `EmissionsClaimed`, not `ClaimRewards`), the parked vault's from
its `Harvested` events, and any vault with a controller from the controller's log. A vault that has
been unstaked (for example with the strategy's `emergencyExit()`) and earns no AERO keeps charting: its
samples, swap fees and harvests are read the same way, with AERO at zero.

The two cbBTC/USDC experiment vaults, once deployed (addresses from their deploy scripts; `startTs` is
the first deposit's time, as both design notes suggest). Their pool is found on chain, whichever new
cbBTC/USDC pool is chosen; the old ids are kept, though at spacing 50 the width is 32 spacings:

```json
{"id": "aeroCL_USDC_cbBTC_16edge", "vault": "<vault A>", "label": "always in, edge re-entry", "startTs": <first deposit>},
{"id": "aeroCL_USDC_cbBTC_16parked", "vault": "<vault B>", "label": "parked by default", "startTs": <first deposit>}
```

## Run locally

```bash
npm install
RPC_URL="https://base-mainnet.g.alchemy.com/v2/<key>" npm start
# open http://localhost:8080
```

`RPC_URL` may list several endpoints separated by commas; requests go to them in turn, and an endpoint
that refuses a method (some public ones do not serve `eth_getLogs`, or only for a few blocks) is
skipped for it. An archive endpoint is needed (reads at past blocks). Public Base endpoints work for a
look (slowly). Without any RPC the server serves `CACHE_FILE` read-only, which is handy for previews.

```bash
npm test     # the collector against a simulated chain: both experiment designs, no network
```

## Configuration (env)

| var | default | meaning |
|---|---|---|
| `RPC_URL` | — | Base RPC with archive state; several may be comma-separated. Or set `ALCHEMEY_KEY` and the URL is built for you. |
| `PORT` | `8080` | HTTP port |
| `REFRESH_MINUTES` | `5` | how often to re-read the chain |
| `GRID_MINUTES` | `60` | spacing of the sample grid. Changing it rebuilds every vault's samples |
| `BACKFILL_CALLS` | `3000` | past grid samples read per refresh, shared among the vaults still missing some (one `eth_call` each) |
| `ENRICH_CALLS` | `800` | events carried over from the earlier build that get the prices and ranges around them, per refresh |
| `CONCURRENCY` | `4` | vaults collected in parallel |
| `RPC_IN_FLIGHT` | `8` | RPC requests in flight at once. Lower it if the log shows rate-limit errors |
| `CACHE_FILE` | `./data-cache.json` | where the snapshot is kept between refreshes and restarts |
| `CHAIN_CONFIG` | `./chain.json` | Aerodrome addresses and events (see above) |

## How the data is collected

- **Samples on a grid.** Each vault is sampled at every UTC hour from its start, each sample one
  Multicall3 `eth_call` at that hour's block (Base makes a block every 2 seconds, checked against the
  head block on every run), plus one sample at the head block. Missing hours are filled coarse to fine
  (daily, 4-hourly, 2-hourly, hourly) under `BACKFILL_CALLS` per refresh; the page draws stretches
  without samples dashed and says how much is still to read. A full rebuild of the 20 vaults is about
  31,000 samples: about ten refreshes, under an hour.
- **Events at their block.** Rebalances and harvests (the vault's events, the configured gauge claim
  events, the strategy's `RewardSold`, the controller's harvest log) are read from logs and each is measured just
  before (block − 1) and after (block): its effect on the share price, split into AERO income, swap-fee
  income and cost, the price around it and the new range. The range shown on the price chart steps at
  the exact rebalance, not at the next sample.
- **Incremental.** Each refresh reads only the new hours, the head sample, and logs since the last
  scanned block (stored per vault). Steady state is a few calls per vault.
- **The first deploy of this build** keeps the earlier build's cache (schema 2): its events and their
  income/cost split are not read again; they get their surrounding prices and ranges over the next
  refreshes (`ENRICH_CALLS`). Its sparse samples are shown until the first refresh finishes, then
  replaced by the hourly grid. Without a cache (no Railway volume), the first refresh reads every
  event again: a few minutes.

## What the figures mean

Everything on the page follows the timeframe chosen (whole life by default).

- **vs holding 50/50**: the value of one share (position, idle and lent tokens, at the pool price)
  against holding half its starting value in each token. This replaces the comparison with the vault's
  own starting mix, which was often far from 50/50 and moved the answer by up to 1.7 points.
- **Marked**: the same against a 50/50 mix kept at 50/50. For a centred vault this equals its booked
  share price plus the loss its current range has not booked yet (the vault's share price is in
  liquidity units, which book the range loss only when the vault re-centres). A wide vault that has
  not re-centred looks better booked than it is; marked shows it as if it re-centred now.
- **Booked**: the vault's own share price. For the parked vault it is in token0 (USDC), not liquidity.
- **Income** is split into AERO (net of the protocol fee; for a V3 vault, what the sale paid it), swap
  fees and, for the parked vault, lending interest (from Aave's income index over the lent balances).
  **Cost at rebalances** is the rest of each rebalance's change. For centred vaults it is the range loss
  booked at re-centring plus the swap. For the edge-placed V3 vault and the parked vault it is the
  move's own cost at the price just before (swap fee and price impact; the parked vault's from its own
  `Rebalanced` event); their range loss shows in the marked line instead.
- **Time in range** (hourly samples) and, for the parked vault, **time in the pool** (from its enter
  and exit events). **Daily volatility** is from 4-hour moves of the pool price on the grid.

## Endpoints

- `/` the dashboard (`public/index.html`, `public/metrics.js`)
- `/api/view` compact per-vault arrays the page loads
- `/api/data` the full snapshot. Same shape as before: `vaults[].series` (now hourly, each sample with
  its grid index `k`; the last is the head sample, `tip: true`), `events`, `rebalances` and the earlier
  fields. New: `label`, `sym0`, `sym1`, `spacing`, `widthTicks`, `widthPct`, `ppsUnit` (`L` or
  `token0`), `birthTs`, `gridFilled`/`gridTotal`, parked samples' `deployed`, `lent0`, `lent1`, `ix0`,
  `ix1`; events' `aeroPct`, `feePct`, `priceRef`, `tickBefore`, `tickAfter`, `tickLo`/`tickHi` (range
  after a rebalance) and, for the parked vault, `action` (`enter`, `exit`, `replace`) and
  `deployedAfter`; a `summary` per vault with the whole-life figures above; `progress` at the top.
- `/api/meta` `{block, ts, vaults, tvl, progress, schema}` (the page polls it)
- `/healthz` liveness and the last refresh's outcome

## Docker

```bash
docker build -t cl-dashboard .
docker run -p 8080:8080 -e RPC_URL="https://base-mainnet.g.alchemy.com/v2/<key>" cl-dashboard
```

## Deploy (Railway)

1. Put this folder in a GitHub repo (node_modules is ignored; Railway installs dependencies itself).
2. Railway → New Project → Deploy from GitHub repo → pick the repo. It runs `npm start`.
3. Service → Variables: add `RPC_URL` (a separate Alchemy app/key for the dashboard keeps its usage
   apart from deploys). Railway sets `PORT` itself.
4. Settings → Networking → Generate Domain. Redeploys are `git push`; logs are in the Deployments tab,
   one line per refresh (`grid filled/total`, `events priced`, calls, seconds).

The URL is public by default; it only shows public chain data.

### Keep the cache across redeploys (Railway volume)

Without a volume each redeploy starts empty and the first refresh reads all events again and the grid
fills over the next hour. With one, a redeploy warm-starts.

1. Open the service. ⌘K / Ctrl-K → "Volume" → attach a volume to it, mount path `/data`.
2. Variables: `CACHE_FILE = /data/data-cache.json`.
3. Redeploy. Boot logs then show `warm-started from /data/data-cache.json …`.

The snapshot is now about 10–15 MB (hourly samples for every vault); the default volume size is
plenty. Do not mount at `/` or `/app`.

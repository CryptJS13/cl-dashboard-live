# CL Vault Monitor — live dashboard

Self-contained live monitor for the Harvest Aerodrome CL vaults on Base. A small Node server
re-reads on-chain state on a timer and serves the dashboard with the latest snapshot; the page
auto-refreshes when newer data lands and remembers each viewer's pair/zoom selection.

## Run locally

```bash
npm install
RPC_URL="https://base-mainnet.g.alchemy.com/v2/<key>" npm start
# open http://localhost:8080
```

## Configuration (env)

| var | default | meaning |
|---|---|---|
| `RPC_URL` | — | Base mainnet RPC (archive access required for history). Or set `ALCHEMEY_KEY` and the URL is built for you. |
| `PORT` | `8080` | HTTP port |
| `REFRESH_MINUTES` | `5` | how often to re-collect on-chain data |
| `SAMPLES` | `90` | samples in the **first** (cold) collection, spread birth→head per vault |
| `CONCURRENCY` | `2` | vaults collected in parallel. Raise to 4–8 on a paid RPC plan; drop to 1 if you still see rate-limit errors in the log |
| `CADENCE_BLOCKS` | `450` | ≈15 min on Base. Spacing of samples appended on each incremental refresh (smaller = fresher chart tip, slightly more RPC) |
| `CACHE_FILE` | `./data-cache.json` | where the snapshot is persisted between refreshes/restarts |

**Collection is incremental.** Only the *first* refresh reads full history (birth→head, `SAMPLES` points/vault
plus every past event); the snapshot is then cached, and every later refresh fetches **only what is new since the
previous head** — a couple of samples and any new rebalances/harvests. Steady-state RPC use drops ~100× (from tens
of thousands of calls per refresh to a few hundred), so refreshes are quick and cheap while full history is retained.
Each refresh logs `… N rpc · incremental|full …` so you can see it working.

The cold collection across 20 vaults takes ~2 minutes; until then the page shows a "collecting…" splash and retries.
The snapshot is written to `CACHE_FILE`, so a **restart resumes incrementally** instead of re-reading history. On
Railway this survives restarts within a deploy; mount a volume at `CACHE_FILE`'s path to also skip the cold rebuild
across redeploys (otherwise each redeploy pays the one-time ~2 min cold collection).

An archive RPC is required (historical `eth_call` at old blocks). Alchemy Base, QuickNode Base, or any archive Base
endpoint works.

## Docker

```bash
docker build -t cl-dashboard .
docker run -p 8080:8080 -e RPC_URL="https://base-mainnet.g.alchemy.com/v2/<key>" cl-dashboard
```

## Deploy — start here if you've never hosted anything

Recommended: **Railway** (simplest path from a folder to a URL, no server admin, free trial then
~$5/mo Hobby). The whole thing is a stateless single-container web service — no database, no volumes.

1. Put this folder in a GitHub repo (private is fine). Easiest: its own repo —
   `cd cl-dashboard-live && git init && git add -A && git commit -m init` then push to a new
   GitHub repo. (node_modules is gitignored; Railway installs deps itself.)
2. Sign up at railway.app with that GitHub account.
3. New Project → Deploy from GitHub repo → pick the repo. Railway detects Node and uses `npm start`.
4. In the service → Variables, add `RPC_URL` = your Base RPC
   (e.g. `https://base-mainnet.g.alchemy.com/v2/<key>`). Nothing else is required — Railway sets
   `PORT` itself and the server reads it.
5. Settings → Networking → Generate Domain. That URL is your dashboard, from any device.
   First load after a deploy shows "collecting…" for ~2 minutes, then it's live and self-refreshing.

Notes for this setup:
- Use a SEPARATE Alchemy app/key for the dashboard (rate limits and usage isolated from your deploys;
  revocable independently). Free tier is enough at the default settings.
- The URL is public by default. It only exposes read-only public chain data, but if you want it
  private the simplest gate is an access token: set an env var and require it in `server.js`, or use
  Railway's built-in private networking + a tunnel. Ask and I'll wire a token check in.
- Redeploys are just `git push`. Logs live in the service's Deployments tab — refresh lines and
  rate-limit errors show up there.

Alternatives, same idea: Render (very similar; free tier sleeps between requests, which resets the
collection cache — mind the ~2 min warmup on wake) and Fly.io (nice CLI, slightly more setup). A VPS
also works (`node server.js` under systemd or pm2) if you already have one.

### Persist the cache across redeploys (Railway volume)

Optional but recommended. Without a volume, each redeploy starts on a fresh filesystem and pays the one-time
`full` cold collection (~5–10 min) before going incremental. A volume keeps the snapshot so redeploys and
restarts warm-start instead.

1. Open the `cl-dashboard-live` service.
2. Attach a volume: **⌘K / Ctrl-K → "Volume" → Create/Attach Volume** for this service (or right-click the
   service in the canvas → **Attach Volume**).
3. Set the **mount path** to `/data` (default size is fine — the snapshot is well under 1 MB).
4. In **Variables**, add `CACHE_FILE = /data/data-cache.json`.
5. Redeploy (automatic on adding the volume/variable; otherwise trigger one).

After this, boot logs show `warm-started from /data/data-cache.json …` and the first refresh is `incremental`.
The very first deploy after attaching still does one `full` pass (the volume starts empty). Gotchas: one volume
per service, and don't mount at `/` or `/app` (use `/data`); a data-schema bump is detected and safely rebuilt
once (`ignoring …/data-cache.json (schema …)`), no manual clearing needed.

## Endpoints

- `/` — the dashboard
- `/api/data` — full snapshot JSON
- `/api/meta` — `{block, ts, vaults, tvl}` (the client polls this to know when to refresh)
- `/healthz` — liveness + last refresh status

## Adding / changing vaults

Edit `vaults.json` (`{id, vault, pool, pair, platform}` per entry). Everything else — token
addresses, decimals, strategy, gauge, V1/V2 design — is discovered on-chain.

Optional per-entry `startTs` (unix seconds) ignores all history before that time for that vault —
useful when a vault's first days are a seeding artifact rather than real performance. It applies to
samples, events and rebalance markers, and takes effect on the next refresh (no rebuild needed,
since it also trims what's already cached). `aeroCL_cbETH_ETH_new` uses it to start at 2026-06-01,
skipping an inception pps spike (1.00 -> 1.22 -> 1.00) that otherwise distorted its whole series.

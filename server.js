// Live CL vault dashboard server. Refreshes on-chain data on a timer and serves:
//   /            the page (public/index.html), which loads /api/view
//   /api/view    compact arrays per vault for the page
//   /api/data    the full snapshot (same fields as before, plus new ones and a `summary` per vault)
//   /api/meta    {block, ts, vaults, tvl, progress}; the page polls it to know when to reload its data
//   /healthz     liveness and the last refresh's outcome
// Without an RPC URL it serves the cache file read-only (for local previews).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const express = require("express");
const { collectAll, SCHEMA } = require("./collect.js");
const { buildView, summaries } = require("./view.js");

const PORT = parseInt(process.env.PORT || "8080", 10);
const REFRESH_MINUTES = parseFloat(process.env.REFRESH_MINUTES || "5");
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "4", 10);          // vaults collected in parallel
const RPC_IN_FLIGHT = parseInt(process.env.RPC_IN_FLIGHT || "8", 10);      // RPC requests in flight at once
const GRID_MINUTES = parseFloat(process.env.GRID_MINUTES || "60");         // spacing of the sample grid
const BACKFILL_CALLS = parseInt(process.env.BACKFILL_CALLS || "3000", 10); // past grid samples read per refresh
const ENRICH_CALLS = parseInt(process.env.ENRICH_CALLS || "800", 10);      // older events given their prices per refresh
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, "data-cache.json");
const RPC_URL = process.env.RPC_URL
  || (process.env.ALCHEMEY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`
  : (process.env.ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}` : null));
const READ_ONLY = !RPC_URL;

let cache = null;          // last data object (fed back to the collector as `prev`)
let served = null;         // the JSON the API serves, plain and gzipped
let lastError = null, lastRefreshMs = 0, refreshing = false;

function pack(obj) { const raw = Buffer.from(JSON.stringify(obj)); return { raw, gz: zlib.gzipSync(raw, { level: 6 }) }; }
function publish(data) {
  const view = buildView(data);
  const sums = summaries(view);
  const withSummary = { ...data, vaults: data.vaults.map(v => ({ ...v, summary: sums[v.id] || null })) };
  served = { data: pack(withSummary), view: pack(view), tvl: data.vaults.reduce((s, v) => s + (v.tvlUsd || 0), 0) };
}

try {
  if (fs.existsSync(CACHE_FILE)) {
    const disk = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (disk && (disk._schema === SCHEMA || disk._schema === 2) && Array.isArray(disk.vaults) && disk.vaults.length) {
      cache = disk; publish(disk);
      console.log(`warm-started from ${CACHE_FILE}: block ${disk.generatedAtBlock} · ${disk.vaults.length} vaults · schema ${disk._schema}${disk._schema !== SCHEMA ? " (its events are kept; its samples are replaced by the hourly grid on the first refresh)" : ""}`);
    } else console.log(`ignoring ${CACHE_FILE} (schema ${disk && disk._schema}, ${SCHEMA} expected, or empty): will rebuild`);
  }
} catch (e) { console.error(`could not read ${CACHE_FILE}: ${e.message}`); }

if (READ_ONLY) {
  if (!cache) { console.error("No RPC configured (set RPC_URL=<base rpc url>, several may be comma-separated, or ALCHEMEY_KEY) and no cache file to serve."); process.exit(1); }
  console.log("no RPC configured: serving the cache file read-only");
}

async function refresh() {
  if (refreshing || READ_ONLY) return;
  refreshing = true;
  const t0 = Date.now();
  try {
    const data = await collectAll(RPC_URL, {
      concurrency: CONCURRENCY, inFlight: RPC_IN_FLIGHT, gridSeconds: Math.round(GRID_MINUTES * 60),
      backfillCalls: BACKFILL_CALLS, enrichCalls: ENRICH_CALLS, prev: cache, log: m => console.log(m),
    });
    cache = data;
    publish(data);
    lastError = null; lastRefreshMs = Date.now();
    try { fs.writeFileSync(CACHE_FILE + ".tmp", JSON.stringify(data)); fs.renameSync(CACHE_FILE + ".tmp", CACHE_FILE); }
    catch (e) { console.error(`cache write failed: ${e.message}`); }
    const p = data.progress || {};
    console.log(`[${new Date().toISOString()}] refreshed block ${data.generatedAtBlock} · ${data.vaults.length} vaults · $${served.tvl.toFixed(0)} TVL · ${data._rpcCalls} rpc · ${data._incremental ? "incremental" : "full"} · grid ${p.gridFilled}/${p.gridTotal} · events priced ${p.eventsWithPrices}/${p.events} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) {
    lastError = e.message || String(e);
    console.error(`[${new Date().toISOString()}] refresh FAILED: ${lastError}`);
  } finally { refreshing = false; }
}

const app = express();
function send(req, res, buf) {
  res.set("cache-control", "no-store");
  res.type("application/json");
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) { res.set("content-encoding", "gzip"); res.set("vary", "accept-encoding"); return res.send(buf.gz); }
  res.send(buf.raw);
}

app.get("/healthz", (_req, res) => res.json({ ok: !!cache, block: cache && cache.generatedAtBlock, lastRefresh: lastRefreshMs, lastError, refreshing, readOnly: READ_ONLY }));
app.get("/api/meta", (_req, res) => {
  res.set("cache-control", "no-store");
  if (!cache) return res.json({ block: 0, refreshing });
  res.json({ block: cache.generatedAtBlock, ts: cache.generatedAtTs, vaults: cache.vaults.length, tvl: served.tvl, progress: cache.progress || null, schema: cache._schema, refreshing });
});
app.get("/api/data", (req, res) => { if (!served) return res.status(503).json({ error: "collecting", refreshing, lastError }); send(req, res, served.data); });
app.get("/api/view", (req, res) => { if (!served) return res.status(503).json({ error: "collecting", refreshing, lastError }); send(req, res, served.view); });
app.use(express.static(path.join(__dirname, "public"), { setHeaders: r => r.set("cache-control", "no-cache") }));

const BUILD = "v4-grid";                  // bump on deploy-visible changes; printed at startup to confirm which code is live
app.listen(PORT, () => {
  const shown = RPC_URL ? RPC_URL.split(",").map(u => u.replace(/\/v2\/.*/, "/v2/***").replace(/([?&](key|apikey|token)=)[^&]+/i, "$1***")).join(", ") : "none";
  console.log(`CL vault dashboard [${BUILD}] on http://localhost:${PORT} · RPC ${shown} · ${CONCURRENCY} vaults at once · grid ${GRID_MINUTES} min · refresh every ${REFRESH_MINUTES} min · addresses from ${process.env.CHAIN_CONFIG || "chain.json"}`);
  if (!READ_ONLY) { refresh(); setInterval(refresh, REFRESH_MINUTES * 60 * 1000); }
});

// Live CL vault dashboard server. Refreshes on-chain data on a timer, serves the dashboard with the
// latest snapshot injected, and exposes /api/data (full JSON) + /api/meta (tiny, for the client poll).
const fs = require("fs");
const path = require("path");
const express = require("express");
const { collectAll, SCHEMA } = require("./collect.js");

const PORT = parseInt(process.env.PORT || "8080", 10);
const REFRESH_MINUTES = parseFloat(process.env.REFRESH_MINUTES || "5");
const SAMPLES = parseInt(process.env.SAMPLES || "90", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "2", 10);
const CADENCE_BLOCKS = parseInt(process.env.CADENCE_BLOCKS || "450", 10);   // ~15 min on Base: spacing of appended samples
// Persist the last snapshot so a restart/redeploy resumes incrementally instead of re-collecting all history.
// On Railway this survives restarts within a deploy; mount a volume at this path to survive redeploys too.
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, "data-cache.json");
const RPC_URL = process.env.RPC_URL
  || (process.env.ALCHEMEY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`
  : (process.env.ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}` : null));

if (!RPC_URL) {
  console.error("No RPC configured. Set RPC_URL=<base rpc url> (or ALCHEMEY_KEY).");
  process.exit(1);
}

const TEMPLATE = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const PLACEHOLDER = '/*__DATA__*/ {"vaults":[],"generatedAtTs":0,"generatedAtBlock":0}';

let cache = null;         // last successful data object (fed back as `prev` for incremental collection)
let cacheJson = null;     // pre-stringified
let lastError = null;
let lastRefreshMs = 0;
let refreshing = false;

// Warm-start from disk so the page serves immediately and the first refresh is incremental.
try {
  if (fs.existsSync(CACHE_FILE)) {
    const disk = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (disk && disk._schema === SCHEMA && Array.isArray(disk.vaults) && disk.vaults.length) {
      cache = disk; cacheJson = JSON.stringify(disk);
      console.log(`warm-started from ${CACHE_FILE}: block ${disk.generatedAtBlock} · ${disk.vaults.length} vaults`);
    } else {
      console.log(`ignoring ${CACHE_FILE} (schema ${disk && disk._schema} != ${SCHEMA} or empty) — will rebuild`);
    }
  }
} catch (e) { console.error(`could not read ${CACHE_FILE}: ${e.message}`); }

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const t0 = Date.now();
  try {
    const data = await collectAll(RPC_URL, { samples: SAMPLES, concurrency: CONCURRENCY, cadenceBlocks: CADENCE_BLOCKS, prev: cache });
    cache = data;
    cacheJson = JSON.stringify(data);
    lastError = null;
    lastRefreshMs = Date.now();
    try { fs.writeFileSync(CACHE_FILE, cacheJson); } catch (e) { console.error(`cache write failed: ${e.message}`); }
    const tvl = data.vaults.reduce((s, v) => s + (v.tvlUsd || 0), 0);
    const mode = data._incremental ? "incremental" : "full";
    console.log(`[${new Date().toISOString()}] refreshed block ${data.generatedAtBlock} · ${data.vaults.length} vaults · $${tvl.toFixed(0)} TVL · ${data._rpcCalls} rpc · ${mode} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } catch (e) {
    lastError = e.message || String(e);
    console.error(`[${new Date().toISOString()}] refresh FAILED: ${lastError}`);
  } finally {
    refreshing = false;
  }
}

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: !!cache, block: cache && cache.generatedAtBlock, lastRefresh: lastRefreshMs, lastError });
});

app.get("/api/meta", (_req, res) => {
  res.set("cache-control", "no-store");
  if (!cache) return res.json({ block: 0, refreshing });
  res.json({
    block: cache.generatedAtBlock, ts: cache.generatedAtTs,
    vaults: cache.vaults.length,
    tvl: cache.vaults.reduce((s, v) => s + (v.tvlUsd || 0), 0),
  });
});

app.get("/api/data", (_req, res) => {
  res.set("cache-control", "no-store");
  if (!cacheJson) return res.status(503).json({ error: "collecting", refreshing });
  res.type("application/json").send(cacheJson);
});

app.get("/", (_req, res) => {
  res.set("cache-control", "no-store");
  if (!cacheJson) {
    return res.status(200).send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="6">
      <title>CL Vault Monitor</title>
      <body style="font-family:system-ui;background:#0b0e12;color:#e9edf1;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center"><h2 style="font-weight:600">Collecting on-chain data…</h2>
      <p style="color:#8592a0">First snapshot across 20 vaults takes ~1–2 minutes. This page will refresh automatically.${lastError ? `<br><br>last error: ${lastError.slice(0, 200)}` : ""}</p></div>`);
  }
  res.type("html").send(TEMPLATE.replace(PLACEHOLDER, "/*__DATA__*/ " + cacheJson));
});

const BUILD = "v3-incremental";                  // bump on deploy-visible changes; printed at startup to confirm which code is live
app.listen(PORT, () => {
  console.log(`CL vault dashboard [${BUILD}] on http://localhost:${PORT}  ·  RPC ${RPC_URL.replace(/\/v2\/.*/, "/v2/***")}  ·  concurrency ${CONCURRENCY}  ·  refresh every ${REFRESH_MINUTES}m`);
  refresh();                                    // initial collection
  setInterval(refresh, REFRESH_MINUTES * 60 * 1000);
});

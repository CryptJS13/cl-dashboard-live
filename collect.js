// Standalone port of scripts/analysis/dash-collect.js + dash-events.js (no hardhat).
// Uses ethers only for keccak256 (function selectors / event topics); everything else is raw JSON-RPC.
// Exports collectAll(rpcUrl, {samples, cap}) -> the same data object the hardhat collectors produced.
const { utils } = require("ethers");
const VAULTS = require("./vaults.json");

// Output schema version. Bumped whenever the shape of a series/event record changes so a stale
// on-disk cache from an older build is discarded (full rebuild) instead of being appended to.
const SCHEMA = 2;

const id = s => utils.id(s);                       // keccak256 of the UTF8 string (== web3.utils.keccak256)
const sel = s => id(s).slice(0, 10);               // 4-byte selector
const pad = a => "000000000000000000000000" + a.slice(2).toLowerCase();
const Q96 = 2n ** 96n;
const i24 = w => { const v = BigInt("0x" + w); return v >= (1n << 255n) ? Number(v - (1n << 256n)) : Number(v); };
const NB = h => h && h !== "0x" ? BigInt(h) : null;
const sqrtX96 = tick => BigInt(Math.floor(Math.pow(1.0001, tick / 2) * 2 ** 96));
const tsHex = t => (t >= 0 ? t : (2 ** 24 + t)).toString(16).padStart(64, "0");

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const AERO_USDC_POOL = "0xccd9cc53b63662088c738b8bc06e9078fb8d9ad4"; // ts200, token0=USDC token1=AERO
const USD_FACTORIES = ["0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"];
const T = {
  transfer: id("Transfer(address,address,uint256)"),
  collect:  id("Collect(uint256,address,uint256,uint256)"),
  decrease: id("DecreaseLiquidity(uint256,uint128,uint256,uint256)"),
  claim:    id("ClaimRewards(address,uint256)"),
  rebV2:    id("RangeRebalanced(uint256,uint256,uint256,uint256,uint256,uint256)"),
  rebV1:    id("Rebalanced(uint256,uint256,uint256,uint256,uint256)"),
};

const sleep = ms => new Promise(res => setTimeout(res, ms));
// Retry transient RPC failures (HTTP 429/5xx, network errors, and JSON-RPC
// rate-limit codes) with exponential backoff + jitter. Without this, one
// throttled call turns into a null that a downstream .slice() throws on,
// dropping the whole vault — which is why a free-tier key showed only the
// first few vaults. Retries let bursts back off and succeed.
function isRateLimit(err) {
  const s = String(err && err.message || err || "");
  return /429|rate.?limit|limit exceeded|too many|capacity|-3200[456]|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed/i.test(s);
}
function makeRpc(url, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 7;
  const counter = opts.counter;
  return async (method, params) => {
    let attempt = 0;
    for (;;) {
      if (counter) counter.n++;
      try {
        const r = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status}`);
        const j = await r.json();
        if (j.error) throw new Error(JSON.stringify(j.error));
        return j.result;
      } catch (e) {
        attempt++;
        if (attempt > maxRetries || !isRateLimit(e)) throw e;
        const backoff = Math.min(8000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 200);
        await sleep(backoff);
      }
    }
  };
}

function liqForAmounts(sp, sa, sb, a0, a1) {
  if (sa > sb) [sa, sb] = [sb, sa];
  if (a0 < 0n) a0 = 0n; if (a1 < 0n) a1 = 0n;
  const L0 = (sA, sB, amt) => (amt * ((sA * sB) / Q96)) / (sB - sA);
  const L1 = (sA, sB, amt) => (amt * Q96) / (sB - sA);
  if (sp <= sa) return L0(sa, sb, a0);
  if (sp < sb) { const l0 = L0(sp, sb, a0), l1 = L1(sa, sp, a1); return l0 < l1 ? l0 : l1; }
  return L1(sa, sb, a1);
}

async function collectAll(rpcUrl, opts = {}) {
  const SAMPLES = opts.samples || 90;
  const CAP = opts.cap || 100000;
  const CADENCE = Math.max(1, opts.cadenceBlocks || 450);   // ~15 min on Base: minimum spacing of appended samples
  const MAXPTS = Math.max(50, opts.maxPoints || 400);       // cap stored series length; decimate beyond this
  const TARGETPTS = Math.max(30, opts.targetPoints || 250); // decimate target
  // Incremental cache: the previous run's output. Immutable history (metadata, old samples, old events)
  // is reused; only data past the previous head is fetched. A schema mismatch forces a full rebuild.
  const prev = (opts.prev && opts.prev._schema === SCHEMA) ? opts.prev : null;
  const prevById = {}; for (const pv of (prev && prev.vaults) || []) prevById[pv.id] = pv;
  const prevHead = (prev && prev.generatedAtBlock) || 0;
  const counter = { n: 0 };
  const rpc = makeRpc(rpcUrl, { counter });
  const callAt = async (to, d, b) => { try { return await rpc("eth_call", [{ to, data: d }, "0x" + b.toString(16)]); } catch { return null; } };
  const birth = async (addr, head) => { let lo = 40000000, hi = head;
    while (lo < hi) { const m = (lo + hi) >> 1; const c = await rpc("eth_getCode", [addr, "0x" + m.toString(16)]); if (c === "0x") lo = m + 1; else hi = m; } return lo; };

  const usdCache = {};
  async function usdPrice(token, head) {
    const key = token.toLowerCase();
    if (key === USDC) return 1;
    if (usdCache[key] !== undefined) return usdCache[key];
    const dX = Number(NB(await callAt(token, sel("decimals()"), head)) || 18n);
    for (const F of USD_FACTORIES) for (const ts of [100, 200, 2000, 50, 500, 1, 10]) {
      const r = await callAt(F, sel("getPool(address,address,int24)") + pad(token) + pad(USDC) + tsHex(ts), head);
      if (!r || BigInt(r) === 0n) continue;
      const pool = "0x" + r.slice(26);
      const s0 = await callAt(pool, sel("slot0()"), head); if (!s0) continue;
      const tick = i24(s0.slice(66, 130));
      const t0 = ("0x" + (await callAt(pool, sel("token0()"), head)).slice(26)).toLowerCase();
      const price = t0 === key ? Math.pow(10, dX - 6) * Math.pow(1.0001, tick)
                               : Math.pow(10, dX - 6) * Math.pow(1.0001, -tick);
      return (usdCache[key] = price);
    }
    return (usdCache[key] = null);
  }
  async function aeroUsdc(b) {
    const s0 = await callAt(AERO_USDC_POOL, sel("slot0()"), b);
    if (!s0) return null;
    return Math.pow(10, 18 - 6) / Math.pow(1.0001, i24(s0.slice(66, 130)));
  }

  const head = parseInt(await rpc("eth_blockNumber"), 16);
  const headTs = Number(NB((await rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false])).timestamp));
  const out = { generatedAtBlock: head, generatedAtTs: headTs, _schema: SCHEMA, vaults: [] };

  const list = opts.only && opts.only.length ? VAULTS.filter(v=>opts.only.includes(v.id)) : VAULTS;
  const CONC = Math.max(1, opts.concurrency || 4);

  // Uniform decimation that always keeps the first and last point — bounds the stored series length.
  const decimate = (arr, target) => {
    if (arr.length <= target) return arr;
    const o = [arr[0]], stride = (arr.length - 1) / (target - 1);
    for (let i = 1; i < target - 1; i++) o.push(arr[Math.round(i * stride)]);
    o.push(arr[arr.length - 1]); return o;
  };

  // One time-series sample at block b. ctx carries the vault's immutable metadata (token/decimals/design/strategy).
  async function buildSample(v, ctx, b) {
    const { t0, t1, d0, d1, isV2, strat } = ctx;
    const [s0, amts, ubwi, tl, pps, sup, lo, hi, i0v, i1v, i0s, i1s, blk] = await Promise.all([
      callAt(v.pool, sel("slot0()"), b),
      callAt(v.vault, sel("getCurrentTokenAmounts()"), b),
      callAt(v.vault, sel("underlyingBalanceWithInvestment()"), b),
      isV2 ? callAt(v.vault, sel("totalLiquidity()"), b) : Promise.resolve(null),
      callAt(v.vault, sel("getPricePerFullShare()"), b),
      callAt(v.vault, sel("totalSupply()"), b),
      callAt(v.vault, sel("tickLower()"), b),
      callAt(v.vault, sel("tickUpper()"), b),
      callAt(t0, sel("balanceOf(address)") + pad(v.vault), b),
      callAt(t1, sel("balanceOf(address)") + pad(v.vault), b),
      strat ? callAt(t0, sel("balanceOf(address)") + pad(strat), b) : Promise.resolve(null),
      strat ? callAt(t1, sel("balanceOf(address)") + pad(strat), b) : Promise.resolve(null),
      rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false]),
    ]);
    if (!s0 || !amts || amts === "0x" || sup === null || ubwi === null || pps === null || !lo || !hi) return null;
    const tick = i24(s0.slice(66, 130));
    const tLo = i24(lo.slice(2)), tHi = i24(hi.slice(2));
    const a0p = BigInt("0x" + amts.slice(2, 66)), a1p = BigInt("0x" + amts.slice(66, 130));
    const idle0 = (NB(i0v) || 0n) + (NB(i0s) || 0n), idle1 = (NB(i1v) || 0n) + (NB(i1s) || 0n);
    const valueL = NB(ubwi);
    const Lpos = tl !== null ? NB(tl) : valueL;
    const supply = NB(sup);
    return { block: b, ts: Number(NB(blk.timestamp)), tick, tickLo: tLo, tickHi: tHi,
      a0: Number(a0p) / 10 ** d0, a1: Number(a1p) / 10 ** d1,
      idle0: Number(idle0) / 10 ** d0, idle1: Number(idle1) / 10 ** d1,
      Lpos: Number(Lpos), Lidle: Number(valueL - Lpos), valueL: Number(valueL),
      supply: Number(supply), pps: Number(NB(pps)),
      vps: supply > 0n ? Number(valueL) / Number(supply) : 0,
      priceT1inT0: Math.pow(10, d1 - d0) / Math.pow(1.0001, tick) };
  }

  async function collectVault(v) {
    if (!v.pool) return null;
    const pv = prevById[v.id];

    // ---- immutable metadata: reuse from the cached record when available (skips the birth bisection) ----
    let isV2, t0, t1, d0, d1, b0;
    if (pv && pv.token0) {
      isV2 = pv.design === "V2"; t0 = pv.token0; t1 = pv.token1; d0 = pv.d0; d1 = pv.d1; b0 = pv.birth;
    } else {
      isV2 = (await callAt(v.vault, sel("bufferPosId()"), head)) !== null;
      t0 = "0x" + (await callAt(v.vault, sel("token0()"), head)).slice(26);
      t1 = "0x" + (await callAt(v.vault, sel("token1()"), head)).slice(26);
      d0 = Number(NB(await callAt(t0, sel("decimals()"), head)));
      d1 = Number(NB(await callAt(t1, sel("decimals()"), head)));
      b0 = await birth(v.vault, head);
    }
    // strategy/gauge can change on a migration, so re-read them cheaply each refresh
    const stratRaw = await callAt(v.vault, sel("strategy()"), head);
    const strat = stratRaw && stratRaw !== "0x" ? "0x" + stratRaw.slice(26) : null;
    const gaugeRaw = strat ? await callAt(strat, sel("rewardPool()"), head) : null;
    const gauge = gaugeRaw && gaugeRaw !== "0x" ? "0x" + gaugeRaw.slice(26) : null;
    const ctx = { t0, t1, d0, d1, isV2, strat };
    // Optional per-vault start override (vaults.json "startTs"): ignore history before this time,
    // e.g. to skip a seeding artifact at inception. bStart is an estimate (~2s blocks on Base) used
    // only to place cold-start samples; the exact cut is the ts filter applied to the records below.
    const startTs = v.startTs || 0;
    const bStart = startTs && headTs > startTs ? Math.max(b0, head - Math.floor((headTs - startTs) / 2)) : b0;

    // ---- series: reuse cached history, append only samples past the previous head at a fixed cadence ----
    let series = (pv && Array.isArray(pv.series)) ? pv.series.slice() : [];
    const newBlocks = [];
    if (!series.length) {                                   // cold start: SAMPLES points start -> head
      const step = Math.max(1, Math.floor((head - bStart) / SAMPLES));
      for (let b = bStart + 1; b <= head; b += step) newBlocks.push(b);
      if (newBlocks.length && newBlocks[newBlocks.length - 1] !== head) newBlocks.push(head);
      else if (!newBlocks.length) newBlocks.push(head);
    } else {                                                // incremental: one point per CADENCE blocks of new time
      const lastB = series[series.length - 1].block;
      for (let b = lastB + CADENCE; b <= head; b += CADENCE) newBlocks.push(b);
    }
    for (const b of newBlocks) { const s = await buildSample(v, ctx, b); if (s) series.push(s); }
    if (startTs) series = series.filter(s => s.ts >= startTs);
    if (series.length > MAXPTS) series = decimate(series, TARGETPTS);

    // ---- rebalance markers: reuse cached, scan only the new block range ----
    const scanFrom = pv ? prevHead + 1 : bStart;
    const prevReb = (pv && Array.isArray(pv.rebalances)) ? pv.rebalances : [];
    const rebSeen = new Set(prevReb.map(r => r.block));
    const rebalances = prevReb.slice();
    if (scanFrom <= head) {
      const newReb = [];
      for (const topic of [T.rebV2, T.rebV1]) {
        const logs = await rpc("eth_getLogs", [{ address: v.vault, topics: [topic], fromBlock: "0x" + scanFrom.toString(16), toBlock: "0x" + head.toString(16) }]).catch(() => []);
        for (const l of logs) newReb.push(parseInt(l.blockNumber, 16));
      }
      for (const bl of [...new Set(newReb)].sort((a, b) => a - b)) if (!rebSeen.has(bl)) rebalances.push({ block: bl, ts: headTs - (head - bl) * 2 });
    }

    // ---- TVL in USD (from the latest sample) ----
    let tvlUsd = null;
    if (series.length) {
      const last = series[series.length - 1];
      const valInT0 = (last.a0 + last.idle0) + (last.a1 + last.idle1) * last.priceT1inT0;
      const p0 = await usdPrice(t0, head);
      if (p0 != null) tvlUsd = valInT0 * p0;
      else { const p1 = await usdPrice(t1, head); if (p1 != null) tvlUsd = (valInT0 / last.priceT1inT0) * p1; }
    }

    const rec = { id: v.id, vault: v.vault, pool: v.pool, pair: v.pair, platform: v.platform, tvlUsd,
      design: isV2 ? "V2" : "V1", token0: t0, token1: t1, d0, d1, birth: b0, strat, gauge,
      series, rebalances: startTs ? rebalances.filter(r => r.ts >= startTs) : rebalances,
      events: (pv && Array.isArray(pv.events)) ? pv.events.filter(e => !startTs || e.ts >= startTs) : [], usdcQuote: true };

    // ---- per-event income/cost/net: reuse cached events, decompose only events past the previous head ----
    if (series.length) {
      const evFrom = pv ? prevHead + 1 : bStart;
      const getLogs = (addr, topics, from) => rpc("eth_getLogs", [{ address: addr, topics, fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16) }]).catch(() => []);
      let evs = [];
      if (evFrom <= head) {
        const reb = [...await getLogs(v.vault, [T.rebV2], evFrom), ...await getLogs(v.vault, [T.rebV1], evFrom)];
        const harv = (gauge && strat) ? await getLogs(gauge, [T.claim, "0x" + pad(strat)], evFrom) : [];
        evs = [
          ...reb.map(l => ({ kind: "rebalance", tx: l.transactionHash, block: parseInt(l.blockNumber, 16) })),
          ...harv.map(l => ({ kind: "harvest", tx: l.transactionHash, block: parseInt(l.blockNumber, 16) })),
        ];
        const byTx = {}; for (const e of evs) { if (!byTx[e.tx] || e.kind === "rebalance") byTx[e.tx] = e; }
        evs = Object.values(byTx).sort((a, b) => a.block - b.block);
      }
      const seen = new Set(rec.events.map(e => e.tx + ":" + e.kind));   // dedupe against cached events across the boundary
      evs = evs.filter(e => !seen.has(e.tx + ":" + e.kind));

      if (evs.length) {
        let feeRate = 0;
        if (strat) { const num = async g => Number(NB(await callAt(strat, sel(g), head)) || 0n);
          const den = await num("feeDenominator()") || 10000;
          feeRate = (await num("profitSharingNumerator()") + await num("platformFeeNumerator()") + await num("strategistFeeNumerator()")) / den; }
        const navAt = async (b, priceRef) => {
          const amts = await callAt(v.vault, sel("getCurrentTokenAmounts()"), b);
          if (!amts || amts === "0x") return null;
          const a0 = Number(BigInt("0x" + amts.slice(2, 66))) / 10 ** d0;
          const a1 = Number(BigInt("0x" + amts.slice(66, 130))) / 10 ** d1;
          const [i0, i1, i0s, i1s] = await Promise.all([
            callAt(t0, sel("balanceOf(address)") + pad(v.vault), b),
            callAt(t1, sel("balanceOf(address)") + pad(v.vault), b),
            strat ? callAt(t0, sel("balanceOf(address)") + pad(strat), b) : Promise.resolve(null),
            strat ? callAt(t1, sel("balanceOf(address)") + pad(strat), b) : Promise.resolve(null),
          ]);
          const idle0 = (Number(NB(i0) || 0n) + Number(NB(i0s) || 0n)) / 10 ** d0;
          const idle1 = (Number(NB(i1) || 0n) + Number(NB(i1s) || 0n)) / 10 ** d1;
          return (a0 + idle0) + (a1 + idle1) * priceRef;
        };
        for (const e of evs) {
          const b = e.block;
          const [ppsB, ppsA] = await Promise.all([callAt(v.vault, sel("getPricePerFullShare()"), b - 1), callAt(v.vault, sel("getPricePerFullShare()"), b)]);
          if (!ppsB || !ppsA) continue;
          const netPctL = (Number(NB(ppsA)) / Number(NB(ppsB)) - 1) * 100;
          const ts = headTs - (head - b) * 2;
          let income = null, cost = null, incomePct = null, costPct = null, aeroAmt = 0, fee0 = 0, fee1 = 0;
          const s0b = await callAt(v.pool, sel("slot0()"), b - 1);
          const priceRef = s0b ? Math.pow(10, d1 - d0) / Math.pow(1.0001, i24(s0b.slice(66, 130))) : null;
          const navBefore = priceRef != null ? await navAt(b - 1, priceRef) : null;
          if (priceRef != null && navBefore != null) {
            const rc = await rpc("eth_getTransactionReceipt", [e.tx]).catch(() => null);
            let coll0 = 0, coll1 = 0, dec0 = 0, dec1 = 0;
            if (rc) for (const l of rc.logs) {
              const a = l.address.toLowerCase();
              if (a === AERO && l.topics[0] === T.transfer && gauge && ("0x" + l.topics[1].slice(26)).toLowerCase() === gauge && ("0x" + l.topics[2].slice(26)).toLowerCase() === (strat || "").toLowerCase())
                aeroAmt += Number(BigInt(l.data)) / 1e18;
              if (l.topics[0] === T.collect) { const d = l.data.slice(2); coll0 += Number(BigInt("0x" + d.slice(64, 128))); coll1 += Number(BigInt("0x" + d.slice(128, 192))); }
              if (l.topics[0] === T.decrease) { const d = l.data.slice(2); dec0 += Number(BigInt("0x" + d.slice(64, 128))); dec1 += Number(BigInt("0x" + d.slice(128, 192))); }
            }
            fee0 = Math.max(0, coll0 - dec0) / 10 ** d0;
            fee1 = Math.max(0, coll1 - dec1) / 10 ** d1;
            // Value the AERO reward in token0 using USD only as an intermediary:
            // token0-per-AERO = (USDC-per-AERO) / (USDC-per-token0). USDC need not be
            // in the pair, so the income/cost split resolves for every vault.
            let aeroInT0 = 0;
            if (aeroAmt > 0) {
              const aeroUsdPx = (await aeroUsdc(b - 1)) || 0;          // USDC per AERO (historical)
              let t0Usd = await usdPrice(t0, head);                    // USDC per token0 (cached from the TVL step)
              if (t0Usd == null) { const t1Usd = await usdPrice(t1, head); if (t1Usd != null && priceRef) t0Usd = t1Usd / priceRef; }
              aeroInT0 = t0Usd ? aeroUsdPx / t0Usd : 0;                // token0 per AERO
            }
            const inc = aeroAmt * (1 - feeRate) * aeroInT0 + fee0 + fee1 * priceRef;
            incomePct = navBefore ? inc / navBefore * 100 : 0;
            costPct = netPctL - incomePct;
            if (costPct > 0) { incomePct = netPctL; costPct = 0; }
            income = incomePct / 100 * navBefore;
            cost = costPct / 100 * navBefore;
          }
          rec.events.push({ kind: e.kind, tx: e.tx, block: b, ts, netPct: netPctL, income, cost, incomePct, costPct, aeroClaimed: aeroAmt, fee0, fee1 });
        }
        rec.events.sort((a, b) => a.block - b.block);
        if (rec.events.length > CAP) { rec._eventsCapped = rec.events.length; rec.events = rec.events.slice(-CAP); }
      }
    }

    return rec;
  }

  // Concurrency pool: vaults are independent; N in flight keeps total wall-clock ~N x faster while
  // staying under RPC rate limits. Order of the output is preserved regardless of finish order.
  const results = new Array(list.length).fill(null);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      try { results[i] = await collectVault(list[i]); }
      catch (e) { console.error(`collect ${list[i].id} failed: ${e.message}`); results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));
  out.vaults = results.filter(Boolean);
  out._rpcCalls = counter.n;
  out._incremental = !!prev;
  return out;
}

module.exports = { collectAll, SCHEMA };

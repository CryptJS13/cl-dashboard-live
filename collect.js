// Standalone port of scripts/analysis/dash-collect.js + dash-events.js (no hardhat).
// Uses ethers only for keccak256 (function selectors / event topics); everything else is raw JSON-RPC.
// Exports collectAll(rpcUrl, {samples, cap}) -> the same data object the hardhat collectors produced.
const { utils } = require("ethers");
const VAULTS = require("./vaults.json");

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

function makeRpc(url) {
  return async (method, params) => {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
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
  const rpc = makeRpc(rpcUrl);
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
  const out = { generatedAtBlock: head, generatedAtTs: headTs, vaults: [] };

  const list = opts.only && opts.only.length ? VAULTS.filter(v=>opts.only.includes(v.id)) : VAULTS;
  const CONC = Math.max(1, opts.concurrency || 4);

  async function collectVault(v) {
    if (!v.pool) return null;
    // ---- base series ----
    const isV2 = (await callAt(v.vault, sel("bufferPosId()"), head)) !== null;
    const t0 = "0x" + (await callAt(v.vault, sel("token0()"), head)).slice(26);
    const t1 = "0x" + (await callAt(v.vault, sel("token1()"), head)).slice(26);
    const d0 = Number(NB(await callAt(t0, sel("decimals()"), head)));
    const d1 = Number(NB(await callAt(t1, sel("decimals()"), head)));
    const stratRaw = await callAt(v.vault, sel("strategy()"), head);
    const strat = stratRaw && stratRaw !== "0x" ? "0x" + stratRaw.slice(26) : null;
    const gaugeRaw = strat ? await callAt(strat, sel("rewardPool()"), head) : null;
    const gauge = gaugeRaw && gaugeRaw !== "0x" ? "0x" + gaugeRaw.slice(26) : null;
    const b0 = await birth(v.vault, head);
    const step = Math.max(1, Math.floor((head - b0) / SAMPLES));
    const blocks = []; for (let b = b0 + 1; b <= head; b += step) blocks.push(b); if (blocks[blocks.length - 1] !== head) blocks.push(head);
    const series = [];
    for (const b of blocks) {
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
      if (!s0 || !amts || amts === "0x" || sup === null || ubwi === null || pps === null || !lo || !hi) continue;
      const tick = i24(s0.slice(66, 130));
      const tLo = i24(lo.slice(2)), tHi = i24(hi.slice(2));
      const a0p = BigInt("0x" + amts.slice(2, 66)), a1p = BigInt("0x" + amts.slice(66, 130));
      const idle0 = (NB(i0v) || 0n) + (NB(i0s) || 0n), idle1 = (NB(i1v) || 0n) + (NB(i1s) || 0n);
      const valueL = NB(ubwi);
      const Lpos = tl !== null ? NB(tl) : valueL;
      const supply = NB(sup);
      series.push({ block: b, ts: Number(NB(blk.timestamp)), tick, tickLo: tLo, tickHi: tHi,
        a0: Number(a0p) / 10 ** d0, a1: Number(a1p) / 10 ** d1,
        idle0: Number(idle0) / 10 ** d0, idle1: Number(idle1) / 10 ** d1,
        Lpos: Number(Lpos), Lidle: Number(valueL - Lpos), valueL: Number(valueL),
        supply: Number(supply), pps: Number(NB(pps)),
        vps: supply > 0n ? Number(valueL) / Number(supply) : 0,
        priceT1inT0: Math.pow(10, d1 - d0) / Math.pow(1.0001, tick) });
    }

    // ---- rebalance blocks (for markers list; events[] below has the enriched detail) ----
    let rbBlocks = [];
    for (const topic of [T.rebV2, T.rebV1]) {
      const logs = await rpc("eth_getLogs", [{ address: v.vault, topics: [topic], fromBlock: "0x" + b0.toString(16), toBlock: "0x" + head.toString(16) }]).catch(() => []);
      for (const l of logs) rbBlocks.push(parseInt(l.blockNumber, 16));
    }
    rbBlocks = [...new Set(rbBlocks)].sort((a, b) => a - b);
    const rebalances = rbBlocks.map(bl => { let best = null; for (const s of series) if (best === null || Math.abs(s.block - bl) < Math.abs(best.block - bl)) best = s; return { block: bl, ts: best ? best.ts + (bl - best.block) * 2 : null }; });

    // ---- TVL in USD ----
    let tvlUsd = null;
    if (series.length) {
      const last = series[series.length - 1];
      const valInT0 = (last.a0 + last.idle0) + (last.a1 + last.idle1) * last.priceT1inT0;
      const p0 = await usdPrice(t0, head);
      if (p0 != null) tvlUsd = valInT0 * p0;
      else { const p1 = await usdPrice(t1, head); if (p1 != null) tvlUsd = (valInT0 / last.priceT1inT0) * p1; }
    }

    const rec = { id: v.id, vault: v.vault, pool: v.pool, pair: v.pair, platform: v.platform, tvlUsd,
      design: isV2 ? "V2" : "V1", token0: t0, token1: t1, d0, d1, birth: b0, series, rebalances,
      events: [], usdcQuote: false };

    // ---- per-event income/cost/net enrichment ----
    if (series.length) {
      const t0usdc = t0.toLowerCase() === USDC, t1usdc = t1.toLowerCase() === USDC;
      const hasUsdcLeg = t0usdc || t1usdc;
      let feeRate = 0;
      if (strat) { const num = async g => Number(NB(await callAt(strat, sel(g), head)) || 0n);
        const den = await num("feeDenominator()") || 10000;
        feeRate = (await num("profitSharingNumerator()") + await num("platformFeeNumerator()") + await num("strategistFeeNumerator()")) / den; }
      const getLogs = topic => rpc("eth_getLogs", [{ address: v.vault, topics: [topic], fromBlock: "0x" + b0.toString(16), toBlock: "0x" + head.toString(16) }]).catch(() => []);
      const reb = [...await getLogs(T.rebV2), ...await getLogs(T.rebV1)];
      const harv = (gauge && strat) ? await rpc("eth_getLogs", [{ address: gauge, topics: [T.claim, "0x" + pad(strat)], fromBlock: "0x" + b0.toString(16), toBlock: "0x" + head.toString(16) }]).catch(() => []) : [];
      let evs = [
        ...reb.map(l => ({ kind: "rebalance", tx: l.transactionHash, block: parseInt(l.blockNumber, 16) })),
        ...harv.map(l => ({ kind: "harvest", tx: l.transactionHash, block: parseInt(l.blockNumber, 16) })),
      ];
      const byTx = {}; for (const e of evs) { if (!byTx[e.tx] || e.kind === "rebalance") byTx[e.tx] = e; }
      evs = Object.values(byTx).sort((a, b) => a.block - b.block);
      if (evs.length > CAP) { rec._eventsCapped = evs.length; evs = evs.slice(-CAP); }

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

      const events = [];
      for (const e of evs) {
        const b = e.block;
        const [ppsB, ppsA] = await Promise.all([callAt(v.vault, sel("getPricePerFullShare()"), b - 1), callAt(v.vault, sel("getPricePerFullShare()"), b)]);
        if (!ppsB || !ppsA) continue;
        const netPctL = (Number(NB(ppsA)) / Number(NB(ppsB)) - 1) * 100;
        const ts = series.reduce((best, s) => Math.abs(s.block - b) < Math.abs(best.block - b) ? s : best, series[0]).ts;
        let income = null, cost = null, incomePct = null, costPct = null, aeroAmt = 0, fee0 = 0, fee1 = 0;
        if (hasUsdcLeg) {
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
            const aeroUsdcPx = aeroAmt > 0 ? (await aeroUsdc(b - 1)) || 0 : 0;
            const aeroInT0 = t0usdc ? aeroUsdcPx : (priceRef ? aeroUsdcPx / priceRef : 0);
            const inc = aeroAmt * (1 - feeRate) * aeroInT0 + fee0 + fee1 * priceRef;
            incomePct = navBefore ? inc / navBefore * 100 : 0;
            costPct = netPctL - incomePct;
            if (costPct > 0) { incomePct = netPctL; costPct = 0; }
            income = incomePct / 100 * navBefore;
            cost = costPct / 100 * navBefore;
          }
        }
        events.push({ kind: e.kind, tx: e.tx, block: b, ts, netPct: netPctL, income, cost, incomePct, costPct, aeroClaimed: aeroAmt, fee0, fee1 });
      }
      rec.events = events;
      rec.usdcQuote = hasUsdcLeg;
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
  return out;
}

module.exports = { collectAll };

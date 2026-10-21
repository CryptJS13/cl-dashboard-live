// Collector for the CL vault dashboard. Raw JSON-RPC (ethers v5 only for ABI coding and keccak).
//
// What it produces for each vault in vaults.json:
//   - metadata read on chain: design, pool, tokens, decimals, symbols, width, birth block, strategy, gauge;
//   - `series`: one sample per hour on a fixed UTC grid from the vault's start to now, each read with one
//     Multicall3 eth_call at that hour's block, plus one sample at the head block. The grid is filled
//     coarse to fine (daily, 4-hourly, 2-hourly, hourly) under a per-refresh budget, so a new vault or a
//     cold start shows its whole history at once and sharpens over the next refreshes;
//   - `events`: every rebalance and harvest, each split into AERO income, swap-fee income and cost.
//
// collectAll(rpcUrls, opts) takes the previous output as opts.prev and only reads what is new or missing.
const { utils } = require("ethers");
const { makeRpc, multicall, getLogs } = require("./rpc");

const SCHEMA = 3;

const id = s => utils.id(s);
const sel = s => id(s).slice(0, 10);
const pad = a => "000000000000000000000000" + a.slice(2).toLowerCase();
const lc = a => (a || "").toLowerCase();
const word = (data, i) => BigInt("0x" + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
const addrAt = (data, i) => "0x" + data.slice(2 + 64 * i + 24, 2 + 64 * (i + 1));
const intAt = (data, i) => { const v = word(data, i); return v >= (1n << 255n) ? Number(v - (1n << 256n)) : Number(v); };
const int24hex = t => (t >= 0 ? BigInt(t) : (1n << 256n) + BigInt(t)).toString(16).padStart(64, "0");
const Q96 = 2 ** 96;
const ADDR0 = "0x0000000000000000000000000000000000000000";
const isAddr = a => !!a && lc(a) !== ADDR0;

// Base makes a block every 2 s from genesis: timestamp = GENESIS_TS + 2 * block. Checked against the
// head block on every run; every sample also stores the timestamp Multicall3 reports for its block.
const GENESIS_TS = 1686789347;
const BLOCK_SECONDS = 2;

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const AERO_USDC_POOL = "0xccd9cc53b63662088c738b8bc06e9078fb8d9ad4"; // tick spacing 200, token0 USDC, token1 AERO
// Slipstream factories the vaults' position managers use (read on chain from posManager().factory())
const USD_FACTORIES = ["0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef"];

const T = {
  transfer: id("Transfer(address,address,uint256)"),
  collect: id("Collect(uint256,address,uint256,uint256)"),
  decrease: id("DecreaseLiquidity(uint256,uint128,uint256,uint256)"),
  claim: id("ClaimRewards(address,uint256)"),
  rebV2: id("RangeRebalanced(uint256,uint256,uint256,uint256,uint256,uint256)"),   // CLVaultV2 and CLVaultV3
  rebV1: id("Rebalanced(uint256,uint256,uint256,uint256,uint256)"),               // CLVault (V1) and ParkedVault
  harvested: id("Harvested(uint256,uint256,uint256)"),                            // ParkedVault
  emergencyParked: id("EmergencyParked(uint256)"),                                // ParkedVault
  rewardSold: id("RewardSold(uint256,uint256,uint256,uint256)"),                  // AerodromeCLStrategyV3Gauge
  feesCollected: id("FeesCollected(uint256,uint256,uint256,uint256)"),            // AerodromeCLStrategyV3Gauge
  interestFee: id("InterestFeeCharged(address,uint256,uint256)"),                 // ParkedStrategy
};
const PARKED_ACTION = { 1: "enter", 2: "exit", 3: "replace" };

// amounts (raw) held by liquidity L on [lo, hi) at sqrt price s (raw, token1 per token0)
function amountsFor(L, lo, hi, s) {
  if (!L || lo === hi) return [0, 0];
  const sa = Math.pow(1.0001, lo / 2), sb = Math.pow(1.0001, hi / 2);
  if (s <= sa) return [L * (1 / sa - 1 / sb), 0];
  if (s >= sb) return [0, L * (sb - sa)];
  return [L * (1 / s - 1 / sb), L * (s - sa)];
}
// everything a state holds, valued in raw token0 at sqrt price s
function valueRaw0(st, s) {
  const [x0, x1] = amountsFor(st.L, st.lo, st.hi, s);
  return x0 + st.idle0 + (x1 + st.idle1) / (s * s);
}

// Grid indices still to read: daily points first, then 4-hourly, 2-hourly, every step; newest first in each pass.
function backfillOrder(K, present, failed, gridSeconds, maxFails) {
  const levels = [...new Set([86400, 14400, 7200, gridSeconds].map(x => Math.max(1, Math.round(x / gridSeconds))))].sort((a, b) => b - a);
  const out = [], seen = new Set();
  for (const step of levels) for (let k = K - (K % step); k >= 0; k -= step) {
    if (seen.has(k)) continue; seen.add(k);
    if (!present.has(k) && (failed[k] || 0) < maxFails) out.push(k);
  }
  return out;
}

// Pair and labels for the page and for the API's older fields. A vaults.json entry may set any of them.
const QUOTES = ["USDC", "WETH", "ETH"];
function deriveNames(entry, m, widthPct) {
  const s0 = m.sym0, s1 = m.sym1;
  const pair = entry.pair || (QUOTES.includes(s1) && !QUOTES.includes(s0) ? s0 : s1);
  const w = widthPct == null ? "" : widthPct.toFixed(2) + "%";
  const label = entry.label || w || m.design;
  const platform = entry.platform || `${s0}/${s1} ${w} - ${entry.label || "Aero Automated CL"}`.replace("  ", " ");
  return { pair, label, platform };
}

async function collectAll(rpcUrls, opts = {}) {
  const VAULTS = opts.vaults || require("./vaults.json");
  const GRID = Math.max(300, opts.gridSeconds || 3600);
  const CAP = opts.cap || 100000;
  const BACKFILL = Math.max(0, opts.backfillCalls != null ? opts.backfillCalls : 3000); // grid reads per refresh, all vaults together
  const ENRICH = Math.max(0, opts.enrichCalls != null ? opts.enrichCalls : 800);        // old events given prices per refresh
  const MAXFAILS = 5;
  const log = opts.log || (() => {});
  const counter = { n: 0 };
  const rpc = opts.rpc || makeRpc(rpcUrls, { counter, inFlight: opts.inFlight || 8 });
  const calls = () => (rpc.counter ? rpc.counter.n : counter.n);

  // previous output: schema 3 is reused as is; schema 2 (the earlier build) gives back its metadata and
  // its decomposed events, so they are not read again; its sparse series is replaced by the grid.
  const prevSchema = opts.prev && opts.prev._schema;
  const prev = (prevSchema === SCHEMA || prevSchema === 2) ? opts.prev : null;
  const prevById = {}; for (const pv of (prev && prev.vaults) || []) prevById[pv.id] = pv;
  const legacyHead = prevSchema === 2 ? prev.generatedAtBlock : null;

  // the head is read as the latest block itself (number and time in one answer) and taken 3 blocks (6 s)
  // back, so that every endpoint in rotation already has it
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (!latest || !latest.number) throw new Error("eth_getBlockByNumber(latest) returned nothing");
  const LAG = 3;
  const head = parseInt(latest.number, 16) - LAG;
  const headTs = Number(BigInt(latest.timestamp)) - BLOCK_SECONDS * LAG;
  const genesisTs = headTs - BLOCK_SECONDS * head;
  if (genesisTs !== GENESIS_TS) log(`note: head block ${head} is ${genesisTs - GENESIS_TS}s off the 2-second schedule; using the head for the block/time map`);
  const blockAt = ts => Math.max(1, Math.ceil((ts - genesisTs) / BLOCK_SECONDS));
  const tsOf = b => genesisTs + BLOCK_SECONDS * b;

  const callAt = async (to, data, b) => { try { const r = await rpc("eth_call", [{ to, data }, "0x" + b.toString(16)]); return r && r !== "0x" ? r : null; } catch { return null; } };

  // ---------------------------------------------------------------- USD prices
  const usdPoolCache = {};
  async function usdPoolFor(token) {
    const key = lc(token);
    if (key === USDC) return { usdc: true };
    if (usdPoolCache[key] !== undefined) return usdPoolCache[key];
    let found = null;
    outer: for (const F of USD_FACTORIES) for (const ts of [100, 200, 2000, 50, 500, 10, 1]) {
      const r = await callAt(F, sel("getPool(address,address,int24)") + pad(token) + pad(USDC) + int24hex(ts), head);
      if (!r || BigInt(r) === 0n) continue;
      const pool = lc(addrAt(r, 0));
      const t0 = await callAt(pool, sel("token0()"), head);
      if (!t0) continue;
      found = { pool, tokenIsToken0: lc(addrAt(t0, 0)) === key };
      break outer;
    }
    return (usdPoolCache[key] = found);
  }
  // USDC per whole token, from the slot0 data of the token's USDC pool (dX = the token's decimals)
  const usdFromSlot0 = (up, s0, dX) => {
    if (!up) return null; if (up.usdc) return 1;
    if (!s0) return null;
    const p = Math.pow(1.0001, intAt(s0, 1)); // raw token1 per raw token0
    return up.tokenIsToken0 ? p * Math.pow(10, dX - 6) : Math.pow(10, dX - 6) / p;
  };
  const aeroUsdFromSlot0 = s0 => s0 ? Math.pow(10, 18 - 6) / Math.pow(1.0001, intAt(s0, 1)) : null;

  // ---------------------------------------------------------------- discovery
  async function discoverStrategy(meta, strat) {
    const key = lc(strat);
    if (meta.strategies[key]) return meta.strategies[key];
    const mc = await multicall(rpc, ["rewardPool()", "idleBalances()", "rewardProceeds()", "lendingPool()", "aToken0()", "aToken1()"].map(n => ({ to: strat, data: sel(n) })), head);
    const r = mc.results;
    const a = i => (r[i].ok && isAddr(addrAt(r[i].data, 0)) ? lc(addrAt(r[i].data, 0)) : null);
    const s = { gauge: a(0), idleBalances: r[1].ok, rewardSale: r[2].ok, lendingPool: a(3), aToken0: a(4), aToken1: a(5) };
    meta.strategies[key] = s;
    return s;
  }

  async function birthBlock(addr) {
    let lo = 1, hi = head;
    // every vault on this dashboard is younger than block 40,000,000; start there when it has no code yet
    const c40 = await rpc("eth_getCode", [addr, "0x" + (40000000).toString(16)]).catch(() => "0x");
    if (c40 === "0x") lo = 40000000;
    while (lo < hi) { const mid = (lo + hi) >> 1; const c = await rpc("eth_getCode", [addr, "0x" + mid.toString(16)]); if (c === "0x") lo = mid + 1; else hi = mid; }
    return lo;
  }

  async function discover(entry) {
    const v = entry.vault;
    const names = ["isDeployed()", "width()", "pool()", "bufferPosId()", "depositCap()", "token0()", "token1()", "posManager()",
      "tickSpacing()", "posWidth()", "tickLower()", "tickUpper()", "strategy()", "getCurrentTokenAmounts()"];
    const mc = await multicall(rpc, names.map(n => ({ to: v, data: sel(n) })), head);
    const R = {}; names.forEach((n, i) => { R[n] = mc.results[i]; });
    if (!R["token0()"].ok || !R["token1()"].ok) throw new Error(`${entry.id || v}: not a CL vault this dashboard knows (no token0/token1)`);
    const design = (R["isDeployed()"].ok && R["width()"].ok) ? "parked"
      : R["bufferPosId()"].ok ? (R["depositCap()"].ok ? "V3" : "V2") : "V1";
    const token0 = lc(addrAt(R["token0()"].data, 0)), token1 = lc(addrAt(R["token1()"].data, 0));
    let pool = entry.pool ? lc(entry.pool) : (R["pool()"].ok ? lc(addrAt(R["pool()"].data, 0)) : null);
    const spacingV = R["tickSpacing()"].ok ? intAt(R["tickSpacing()"].data, 0) : null;
    if (!pool && R["posManager()"].ok && spacingV) {
      const f = await callAt(addrAt(R["posManager()"].data, 0), sel("factory()"), head);
      if (f) { const p = await callAt(addrAt(f, 0), sel("getPool(address,address,int24)") + pad(token0) + pad(token1) + int24hex(spacingV), head); if (p && BigInt(p) !== 0n) pool = lc(addrAt(p, 0)); }
    }
    const meta = { strategies: {} };
    const strat = R["strategy()"].ok && isAddr(addrAt(R["strategy()"].data, 0)) ? lc(addrAt(R["strategy()"].data, 0)) : null;
    if (!pool && strat) { const s = await discoverStrategy(meta, strat); if (s.gauge) { const p = await callAt(s.gauge, sel("pool()"), head); if (p) pool = lc(addrAt(p, 0)); } }
    if (!pool) throw new Error(`${entry.id || v}: could not find the pool on chain; add "pool" to its vaults.json entry`);
    const tmc = await multicall(rpc, [
      { to: token0, data: sel("decimals()") }, { to: token1, data: sel("decimals()") },
      { to: token0, data: sel("symbol()") }, { to: token1, data: sel("symbol()") },
      { to: pool, data: sel("tickSpacing()") }, { to: pool, data: sel("token0()") },
    ], head);
    const tr = tmc.results;
    const sym = r => { try { return utils.defaultAbiCoder.decode(["string"], r.data)[0]; } catch { try { return utils.parseBytes32String(r.data); } catch { return "?"; } } };
    if (tr[5].ok && lc(addrAt(tr[5].data, 0)) !== token0) throw new Error(`${entry.id || v}: pool ${pool} does not hold the vault's token0`);
    const spacing = tr[4].ok ? intAt(tr[4].data, 0) : spacingV;
    let widthTicks = null;
    if (design === "parked") widthTicks = intAt(R["width()"].data, 0);
    else if (R["posWidth()"].ok && spacing) widthTicks = Number(word(R["posWidth()"].data, 0)) * spacing;
    else if (R["tickLower()"].ok && R["tickUpper()"].ok) widthTicks = intAt(R["tickUpper()"].data, 0) - intAt(R["tickLower()"].data, 0);
    Object.assign(meta, {
      design, pool, token0, token1, d0: tr[0].ok ? Number(word(tr[0].data, 0)) : 18, d1: tr[1].ok ? Number(word(tr[1].data, 0)) : 18,
      sym0: tr[2].ok ? sym(tr[2]) : "token0", sym1: tr[3].ok ? sym(tr[3]) : "token1", spacing, widthTicks,
    });
    return meta;
  }

  // ---------------------------------------------------------------- one state read (one eth_call)
  function stateCalls(m, strat, s) {
    const v = m.vault, c = [];
    const add = (name, to, data) => c.push({ name, to, data });
    add("slot0", m.pool, sel("slot0()"));
    add("amts", v, sel("getCurrentTokenAmounts()"));
    add("ubwi", v, sel("underlyingBalanceWithInvestment()"));
    add("pps", v, sel("getPricePerFullShare()"));
    add("sup", v, sel("totalSupply()"));
    add("lo", v, sel("tickLower()"));
    add("hi", v, sel("tickUpper()"));
    add("strat", v, sel("strategy()"));
    add("v0", m.token0, sel("balanceOf(address)") + pad(v));
    add("v1", m.token1, sel("balanceOf(address)") + pad(v));
    if (m.design === "V2" || m.design === "V3") add("tl", v, sel("totalLiquidity()"));
    if (strat) {
      if (s && s.idleBalances) add("idle", strat, sel("idleBalances()"));         // excludes the protocol fee set aside
      else if (m.design === "parked") add("hold", strat, sel("holdings()"));      // position, lent and idle balances
      else { add("s0", m.token0, sel("balanceOf(address)") + pad(strat)); add("s1", m.token1, sel("balanceOf(address)") + pad(strat)); }
      if (s && s.rewardSale) add("rp", strat, sel("rewardProceeds()"));
      if (m.design === "parked" && s && s.lendingPool) {
        add("ix0", s.lendingPool, sel("getReserveNormalizedIncome(address)") + pad(m.token0));
        add("ix1", s.lendingPool, sel("getReserveNormalizedIncome(address)") + pad(m.token1));
      }
    }
    return c;
  }
  async function readState(m, b, extra = []) {
    let strat = m.strat;
    for (let pass = 0; ; pass++) {
      const s = strat ? await discoverStrategy(m, strat) : null;
      const cs = stateCalls(m, strat, s).concat(extra);
      const mc = await multicall(rpc, cs, b);
      const R = {}; cs.forEach((c, i) => { R[c.name] = mc.results[i]; });
      const stratAt = R.strat.ok && isAddr(addrAt(R.strat.data, 0)) ? lc(addrAt(R.strat.data, 0)) : null;
      if (stratAt !== strat && pass === 0) { strat = stratAt; continue; } // the vault had another strategy then
      return { R, ts: mc.ts, strat, s };
    }
  }
  const num = r => (r && r.ok ? Number(word(r.data, 0)) : null);
  function stateFrom(st) {
    const { R } = st;
    if (!R.slot0.ok || !R.sup.ok) return null;
    const sp = Number(word(R.slot0.data, 0)) / Q96, tick = intAt(R.slot0.data, 1);
    let idle0 = num(R.v0) || 0, idle1 = num(R.v1) || 0, lent0 = 0, lent1 = 0, L = null;
    let lo = R.lo.ok ? intAt(R.lo.data, 0) : 0, hi = R.hi.ok ? intAt(R.hi.data, 0) : 0;
    if (R.idle && R.idle.ok) { idle0 += Number(word(R.idle.data, 0)); idle1 += Number(word(R.idle.data, 1)); }
    else if (R.hold && R.hold.ok) {
      const h = R.hold.data;
      L = Number(word(h, 0)); lo = intAt(h, 1); hi = intAt(h, 2);
      lent0 = Number(word(h, 3)); lent1 = Number(word(h, 4));
      idle0 += Number(word(h, 5)); idle1 += Number(word(h, 6));
    } else { idle0 += num(R.s0) || 0; idle1 += num(R.s1) || 0; }
    if (L === null && R.tl && R.tl.ok) L = Number(word(R.tl.data, 0));
    return { sp, tick, lo, hi, L, idle0, idle1, lent0, lent1, supply: Number(word(R.sup.data, 0)),
      pps: num(R.pps), ubwi: num(R.ubwi), a0: R.amts.ok ? Number(word(R.amts.data, 0)) : null, a1: R.amts.ok ? Number(word(R.amts.data, 1)) : null,
      ix0: R.ix0 && R.ix0.ok ? Number(word(R.ix0.data, 0)) / 1e27 : null, ix1: R.ix1 && R.ix1.ok ? Number(word(R.ix1.data, 0)) / 1e27 : null,
      rp: R.rp && R.rp.ok ? Number(word(R.rp.data, 0)) : null };
  }
  async function buildSample(m, b, k) {
    const st = await readState(m, b);
    const x = stateFrom(st);
    if (!x || x.pps === null || x.ubwi === null || x.a0 === null) return null;
    const { d0, d1 } = m;
    const Lpos = m.design === "parked" ? (x.L || 0) : (x.L !== null ? x.L : x.ubwi);
    const out = { block: b, ts: st.ts || tsOf(b), tick: x.tick, tickLo: x.lo, tickHi: x.hi,
      a0: x.a0 / 10 ** d0, a1: x.a1 / 10 ** d1, idle0: x.idle0 / 10 ** d0, idle1: x.idle1 / 10 ** d1,
      Lpos, Lidle: m.design === "parked" ? null : x.ubwi - Lpos,
      valueL: x.ubwi, supply: x.supply, pps: x.pps, vps: x.supply > 0 ? x.ubwi / x.supply : 0,
      priceT1inT0: Math.pow(10, d1 - d0) / Math.pow(1.0001, x.tick) };
    if (k != null) out.k = k;
    if (m.design === "parked") {
      out.deployed = x.L > 0 && x.lo !== x.hi;
      out.lent0 = x.lent0 / 10 ** d0; out.lent1 = x.lent1 / 10 ** d1;
      if (x.ix0) out.ix0 = x.ix0;
      if (x.ix1) out.ix1 = x.ix1;
    }
    if (x.rp !== null) out.rewardProceeds = x.rp;
    if (st.strat !== m.strat) out.strat = st.strat;
    return out;
  }

  // ---------------------------------------------------------------- events
  async function scanEvents(m, from, to) {
    if (from > to) return [];
    const evs = [];
    const add = (l, kind) => evs.push({ kind, tx: l.transactionHash, block: parseInt(l.blockNumber, 16), data: l.data });
    if (m.design === "parked") {
      for (const l of await getLogs(rpc, { address: m.vault, topics: [[T.rebV1, T.harvested, T.emergencyParked]] }, from, to)) {
        const t0 = l.topics[0];
        add(l, t0 === T.rebV1 ? "rebalance" : t0 === T.harvested ? "harvest" : "emergency");
      }
    } else {
      for (const l of await getLogs(rpc, { address: m.vault, topics: [[T.rebV2, T.rebV1]] }, from, to)) add(l, "rebalance");
      // harvests: the gauge's ClaimRewards to the strategy (the gauges before Aerodrome's 2026-10-22 deployment);
      // for a strategy that sells AERO, also its own RewardSold, which does not depend on the gauge's events
      // (the new gauges emit EmissionsClaimed instead)
      const pairs = new Map();
      for (const [sa, s] of Object.entries(m.strategies)) if (s.gauge) pairs.set(s.gauge + ":" + sa, [s.gauge, sa]);
      for (const [g, sa] of pairs.values()) for (const l of await getLogs(rpc, { address: g, topics: [T.claim, "0x" + pad(sa)] }, from, to)) add(l, "harvest");
      for (const [sa, s] of Object.entries(m.strategies)) if (s.rewardSale) for (const l of await getLogs(rpc, { address: sa, topics: [T.rewardSold] }, from, to)) add(l, "harvest");
    }
    const byTx = {};
    for (const e of evs) { const cur = byTx[e.tx]; if (!cur || (e.kind !== "harvest" && cur.kind === "harvest")) byTx[e.tx] = e; }
    return Object.values(byTx).sort((a, b) => a.block - b.block);
  }

  async function feeRateOf(m) {
    if (m._feeRate != null) return m._feeRate;
    if (!m.strat) return (m._feeRate = 0);
    const mc = await multicall(rpc, ["feeDenominator()", "profitSharingNumerator()", "platformFeeNumerator()", "strategistFeeNumerator()"].map(n => ({ to: m.strat, data: sel(n) })), head);
    const n = mc.results.map(r => (r.ok ? Number(word(r.data, 0)) : 0));
    return (m._feeRate = (n[1] + n[2] + n[3]) / (n[0] || 10000));
  }

  // One event: the state just before it (block b-1), just after it (block b), and its receipt.
  async function decompose(m, e) {
    const b = e.block;
    const extra = [{ name: "aero", to: AERO_USDC_POOL, data: sel("slot0()") }];
    if (m.usd0 && m.usd0.pool) extra.push({ name: "usd0", to: m.usd0.pool, data: sel("slot0()") });
    if (m.usd1 && m.usd1.pool) extra.push({ name: "usd1", to: m.usd1.pool, data: sel("slot0()") });
    const [stB, stA, rc] = await Promise.all([readState(m, b - 1, extra), readState(m, b), rpc("eth_getTransactionReceipt", [e.tx])]);
    const B = stateFrom(stB), A = stateFrom(stA);
    const rec = { kind: e.kind === "emergency" ? "rebalance" : e.kind, tx: e.tx, block: b, ts: stA.ts || tsOf(b), netPct: 0,
      income: null, cost: null, incomePct: null, costPct: null, aeroClaimed: 0, fee0: 0, fee1: 0 };
    if (!B || !A || B.a0 === null) return rec;
    const { d0, d1 } = m;
    const sRef = B.sp, pRef = Math.pow(10, d1 - d0) / (sRef * sRef); // token1 in token0, whole units, just before
    rec.priceRef = pRef; rec.tickBefore = B.tick; rec.tickAfter = A.tick;
    if (rec.kind === "rebalance") { rec.tickLo = A.lo; rec.tickHi = A.hi; }
    const okData = (st, n) => (st.R[n] && st.R[n].ok ? st.R[n].data : null);
    const aeroUsd = aeroUsdFromSlot0(okData(stB, "aero")) || 0;
    let t0Usd = usdFromSlot0(m.usd0, okData(stB, "usd0"), d0);
    if (t0Usd == null) { const t1Usd = usdFromSlot0(m.usd1, okData(stB, "usd1"), d1); if (t1Usd != null) t0Usd = t1Usd / pRef; }
    const usdcToT0 = raw => lc(m.token0) === USDC ? raw / 1e6 : lc(m.token1) === USDC ? raw / 1e6 * pRef : (t0Usd ? raw / 1e6 / t0Usd : 0);
    const strat = stB.strat || m.strat, gauge = (m.strategies[lc(strat)] || {}).gauge;
    let aeroT0 = null, coll0 = 0, coll1 = 0, dec0 = 0, dec1 = 0, fc0 = null, fc1 = null, interestFeeT0 = 0;
    for (const l of (rc && rc.logs) || []) {
      const t0 = l.topics[0], a = lc(l.address), fromStrat = a === lc(strat);
      if (a === AERO && t0 === T.transfer && gauge && lc("0x" + l.topics[1].slice(26)) === gauge && lc("0x" + l.topics[2].slice(26)) === lc(strat)) rec.aeroClaimed += Number(BigInt(l.data)) / 1e18;
      if (t0 === T.collect) { coll0 += Number(word(l.data, 1)); coll1 += Number(word(l.data, 2)); }
      if (t0 === T.decrease) { dec0 += Number(word(l.data, 1)); dec1 += Number(word(l.data, 2)); }
      if (t0 === T.rewardSold && fromStrat) aeroT0 = (aeroT0 || 0) + usdcToT0(Number(word(l.data, 3)));
      if (t0 === T.feesCollected && fromStrat) { fc0 = (fc0 || 0) + Number(word(l.data, 0)) - Number(word(l.data, 2)); fc1 = (fc1 || 0) + Number(word(l.data, 1)) - Number(word(l.data, 3)); }
      if (t0 === T.interestFee && fromStrat) { const tok = lc("0x" + l.topics[1].slice(26)), fee = Number(word(l.data, 1)); interestFeeT0 += tok === lc(m.token0) ? fee / 10 ** d0 : fee / 10 ** d1 * pRef; }
    }
    if (fc0 !== null) { rec.fee0 = Math.max(0, fc0) / 10 ** d0; rec.fee1 = Math.max(0, fc1) / 10 ** d1; }
    else { rec.fee0 = Math.max(0, coll0 - dec0) / 10 ** d0; rec.fee1 = Math.max(0, coll1 - dec1) / 10 ** d1; }
    const feesT0 = rec.fee0 + rec.fee1 * pRef;

    if (m.design === "parked") {
      // everything the strategy holds, valued at the price just before the event
      const stOf = X => ({ L: X.L || 0, lo: X.lo, hi: X.hi, idle0: X.idle0 + X.lent0, idle1: X.idle1 + X.lent1 });
      const navB = valueRaw0(stOf(B), sRef) / 10 ** d0;
      if (rec.kind === "rebalance") {
        let before = null, after = null, action = e.kind === "emergency" ? "exit" : "rebalance";
        if (e.kind === "rebalance" && e.data && e.data.length >= 2 + 64 * 5) {
          before = Number(word(e.data, 2)); after = Number(word(e.data, 3)); action = PARKED_ACTION[Number(word(e.data, 4))] || "rebalance";
        }
        if (!(before > 0)) { before = valueRaw0(stOf(B), sRef); after = valueRaw0(stOf(A), sRef); } // supply does not change inside a keeper call
        rec.action = action;
        rec.netPct = before > 0 ? (after / before - 1) * 100 : 0;
        rec.incomePct = 0; rec.aeroPct = 0; rec.feePct = 0; rec.costPct = rec.netPct;
        rec.income = 0; rec.cost = rec.costPct / 100 * navB;
        rec.deployedAfter = !!(A.L > 0 && A.lo !== A.hi);
      } else {
        let proceeds = 0, fee = 0;
        if (e.data && e.data.length >= 2 + 64 * 3) { proceeds = Number(word(e.data, 1)); fee = Number(word(e.data, 2)); }
        const aero = (proceeds - fee) / 10 ** d0;
        rec.aeroPct = navB > 0 ? aero / navB * 100 : 0;
        rec.feePct = navB > 0 ? feesT0 / navB * 100 : 0;
        rec.incomePct = rec.aeroPct + rec.feePct;
        rec.costPct = navB > 0 ? -interestFeeT0 / navB * 100 : 0;
        rec.netPct = rec.incomePct + rec.costPct;
        rec.income = rec.incomePct / 100 * navB; rec.cost = rec.costPct / 100 * navB;
      }
      return rec;
    }

    // V1/V2: the vault's own share price in liquidity units, which books the range loss at each rebalance.
    // V3 (edge placement): value per share at the price just before, since the liquidity units of an
    // off-centre range are not comparable with those of the range before it.
    let netPct;
    const stOf = X => ({ L: X.L || 0, lo: X.lo, hi: X.hi, idle0: X.idle0, idle1: X.idle1 });
    if (m.design === "V3" && B.L !== null && A.L !== null && B.supply > 0 && A.supply > 0) {
      netPct = (valueRaw0(stOf(A), sRef) / A.supply / (valueRaw0(stOf(B), sRef) / B.supply) - 1) * 100;
    } else {
      if (!(B.pps > 0) || !(A.pps > 0)) return rec;
      netPct = (A.pps / B.pps - 1) * 100;
    }
    const navB = (B.a0 + B.idle0) / 10 ** d0 + (B.a1 + B.idle1) / 10 ** d1 * pRef;
    let aero;
    if (aeroT0 !== null) aero = aeroT0;                     // V3: what the sale paid the vault, after the protocol fee
    else {
      const feeRate = await feeRateOf(m);
      aero = rec.aeroClaimed > 0 && t0Usd ? rec.aeroClaimed * (1 - feeRate) * aeroUsd / t0Usd : 0;
    }
    let incomePct = navB > 0 ? (aero + feesT0) / navB * 100 : 0;
    let costPct = netPct - incomePct;
    if (costPct > 0) { incomePct = netPct; costPct = 0; }
    rec.netPct = netPct; rec.incomePct = incomePct; rec.costPct = costPct;
    rec.feePct = navB > 0 ? Math.max(0, Math.min(incomePct, feesT0 / navB * 100)) : 0;
    rec.aeroPct = incomePct - rec.feePct;
    rec.income = incomePct / 100 * navB; rec.cost = costPct / 100 * navB;
    return rec;
  }

  // AERO / swap-fee split of an event's income. Events from the earlier build stored only the total
  // income and the fee amounts; the split needs the price at the event.
  function splitIncome(e) {
    if (e.incomePct == null) { e.aeroPct = e.feePct = null; return; }
    const navB = e.incomePct !== 0 && e.income ? e.income / (e.incomePct / 100) : null;
    if (navB && e.priceRef != null) e.feePct = Math.max(0, Math.min(e.incomePct, ((e.fee0 || 0) + (e.fee1 || 0) * e.priceRef) / navB * 100));
    else e.feePct = 0;
    e.aeroPct = e.incomePct - e.feePct;
  }
  async function enrich(m, e) {
    const [mb, ma] = await Promise.all([
      multicall(rpc, [{ to: m.pool, data: sel("slot0()") }], e.block - 1),
      multicall(rpc, [{ to: m.pool, data: sel("slot0()") }, { to: m.vault, data: sel("tickLower()") }, { to: m.vault, data: sel("tickUpper()") }], e.block),
    ]);
    if (!mb.results[0].ok || !ma.results[0].ok) return false;
    const sRef = Number(word(mb.results[0].data, 0)) / Q96;
    e.priceRef = Math.pow(10, m.d1 - m.d0) / (sRef * sRef);
    e.tickBefore = intAt(mb.results[0].data, 1); e.tickAfter = intAt(ma.results[0].data, 1);
    if (e.kind !== "harvest" && ma.results[1].ok && ma.results[2].ok) { e.tickLo = intAt(ma.results[1].data, 0); e.tickHi = intAt(ma.results[2].data, 0); }
    if (ma.ts) e.ts = ma.ts;
    delete e._priceApprox;
    splitIncome(e);
    return true;
  }
  function approxPrice(e, grid) {
    if (!grid.length) return;
    let best = grid[0]; for (const s of grid) if (Math.abs(s.ts - e.ts) < Math.abs(best.ts - e.ts)) best = s;
    if (Math.abs(best.ts - e.ts) <= 6 * 3600) { e.priceRef = best.priceT1inT0; e._priceApprox = true; }
  }

  // ---------------------------------------------------------------- one vault
  const list = opts.only && opts.only.length ? VAULTS.filter(v => opts.only.includes(v.id)) : VAULTS;
  const entries = list.map(e => ({ ...e, id: e.id || autoId(e), vault: lc(e.vault) }));

  async function collectVault(entry, budget, enrichBudget) {
    const pv = prevById[entry.id] || null;
    const same = pv && lc(pv.vault) === entry.vault;
    const pv3 = same && pv._schema3 ? pv : null;
    let m;
    if (pv3) m = { ...pv3._meta, strategies: { ...(pv3._meta.strategies || {}) } };
    else {
      m = await discover(entry);
      m.birth = (same && pv.birth) || await birthBlock(entry.vault); // the earlier build already found the birth block
    }
    m.vault = entry.vault;
    if (entry.pool) m.pool = lc(entry.pool);
    // strategy and gauge can change on a migration: read them on every refresh
    const sraw = await callAt(m.vault, sel("strategy()"), head);
    m.strat = sraw && isAddr(addrAt(sraw, 0)) ? lc(addrAt(sraw, 0)) : null;
    if (m.strat) await discoverStrategy(m, m.strat);
    if (same && pv.strat && isAddr(pv.strat)) await discoverStrategy(m, lc(pv.strat)).catch(() => {});
    const sInfo = (m.strat && m.strategies[m.strat]) || {};
    m.gauge = sInfo.gauge || null;
    if (m.usd0 === undefined) m.usd0 = await usdPoolFor(m.token0);
    if (m.usd1 === undefined) m.usd1 = await usdPoolFor(m.token1);
    delete m._feeRate;

    const birthTs = tsOf(m.birth);
    const startTs = entry.startTs || 0;
    const startBlock = startTs ? Math.max(m.birth, blockAt(startTs)) : m.birth;

    // ---- the hourly grid
    const gridStart = Math.ceil(Math.max(birthTs, startTs) / GRID) * GRID;
    const K = gridStart > headTs ? -1 : Math.floor((headTs - gridStart) / GRID);
    let grid = [];
    let failed = {};
    if (pv3 && pv3._gridSeconds === GRID && pv3._gridStart === gridStart && Array.isArray(pv3.series)) {
      grid = pv3.series.filter(s => !s.tip && s.k != null);
      failed = { ...(pv3._failed || {}) };
    }
    const present = new Set(grid.map(s => s.k));
    const lastK = grid.length ? grid[grid.length - 1].k : -1;
    // the hours since the last refresh (at most two days of them) are read whatever the budget
    const newest = []; for (let k = K; k > lastK && newest.length < 48; k--) if (!present.has(k)) newest.push(k);
    const newestSet = new Set(newest);
    const todo = newest.concat(backfillOrder(K, present, failed, GRID, MAXFAILS).filter(k => !newestSet.has(k)).slice(0, budget));
    for (let i = 0; i < todo.length; i += 12) {
      const chunk = todo.slice(i, i + 12);
      const got = await Promise.all(chunk.map(k => buildSample(m, blockAt(gridStart + k * GRID), k).catch(() => null)));
      chunk.forEach((k, j) => { if (got[j]) { grid.push(got[j]); delete failed[k]; } else failed[k] = (failed[k] || 0) + 1; });
    }
    grid.sort((a, b) => a.k - b.k);
    const tip = await buildSample(m, head, null).catch(() => null);

    // ---- events
    let events = (same && Array.isArray(pv.events)) ? pv.events.map(e => ({ ...e })) : [];
    const scanFrom = same ? ((pv3 ? pv3.scannedTo : legacyHead) || startBlock - 1) + 1 : startBlock;
    const seen = new Set(events.map(e => e.tx));
    const found = (await scanEvents(m, Math.max(scanFrom, startBlock), head)).filter(e => !seen.has(e.tx));
    let scannedTo = head;
    for (const e of found) {
      try { events.push(await decompose(m, e)); }
      catch (err) { log(`${entry.id}: event ${e.tx} not read (${err.message}); retried next refresh`); scannedTo = Math.min(scannedTo, e.block - 1); }
    }
    events.sort((a, b) => a.block - b.block);
    // events from the earlier build: read the prices and ranges around them, a few hundred per refresh
    let enriched = 0;
    for (const e of events) {
      if (e.tickBefore != null) { if (e.aeroPct == null) splitIncome(e); continue; }
      if (enriched < enrichBudget) {
        enriched++;
        const ok = await enrich(m, e).catch(() => false);
        if (ok) continue;
      }
      if (e.aeroPct == null || e._priceApprox) { approxPrice(e, grid); splitIncome(e); }
    }
    if (startTs) events = events.filter(e => e.ts >= startTs);
    if (events.length > CAP) events = events.slice(-CAP);

    // ---- TVL in USD from the head sample
    let tvlUsd = null;
    const last = tip || grid[grid.length - 1];
    if (last) {
      const valInT0 = (last.a0 + last.idle0) + (last.a1 + last.idle1) * last.priceT1inT0;
      let p0 = usdFromSlot0(m.usd0, m.usd0 && m.usd0.pool ? await callAt(m.usd0.pool, sel("slot0()"), head) : null, m.d0);
      if (p0 == null) { const p1 = usdFromSlot0(m.usd1, m.usd1 && m.usd1.pool ? await callAt(m.usd1.pool, sel("slot0()"), head) : null, m.d1); if (p1 != null) p0 = p1 / last.priceT1inT0; }
      if (p0 != null) tvlUsd = valInT0 * p0;
    }

    const widthPct = m.widthTicks ? (Math.pow(1.0001, m.widthTicks) - 1) * 100 : null;
    const names = deriveNames(entry, m, widthPct);
    const keep = s => !startTs || s.ts >= startTs;
    const series = grid.filter(keep).concat(tip && keep(tip) ? [{ ...tip, tip: true }] : []);
    // hours still to read; an hour that failed MAXFAILS times (e.g. before the vault was set up) is left as a gap
    const gridMissing = backfillOrder(K, new Set(grid.map(s => s.k)), failed, GRID, MAXFAILS).length;
    const gridUnreadable = Object.values(failed).filter(n => n >= MAXFAILS).length;
    const { _feeRate, ...meta } = m;
    return {
      id: entry.id, vault: entry.vault, pool: m.pool, pair: names.pair, platform: names.platform, label: names.label,
      tvlUsd, design: m.design, ppsUnit: m.design === "parked" ? "token0" : "L",
      token0: m.token0, token1: m.token1, d0: m.d0, d1: m.d1, sym0: m.sym0, sym1: m.sym1, spacing: m.spacing,
      widthTicks: m.widthTicks, widthPct, birth: m.birth, birthTs, startTs: startTs || null, strat: m.strat, gauge: m.gauge,
      lending: m.design === "parked" ? { pool: sInfo.lendingPool || null, aToken0: sInfo.aToken0 || null, aToken1: sInfo.aToken1 || null } : undefined,
      series, rebalances: events.filter(e => e.kind !== "harvest").map(e => ({ block: e.block, ts: e.ts })),
      events, usdcQuote: true, scannedTo, gridSeconds: GRID, gridFilled: grid.length, gridTotal: K + 1 - gridUnreadable, gridMissing, gridUnreadable,
      _schema3: true, _gridSeconds: GRID, _gridStart: gridStart, _failed: failed, _meta: meta,
    };
  }

  // the per-refresh budgets are shared out in proportion to what each vault still lacks
  const gridNeed = e => {
    const pv = prevById[e.id];
    if (pv && pv._schema3 && lc(pv.vault) === e.vault && pv._gridSeconds === GRID) return pv.gridMissing || 0;
    return pv && pv.birth ? Math.max(1, (headTs - tsOf(pv.birth)) / GRID) : 24 * 30;
  };
  const enrichNeed = e => { const pv = prevById[e.id]; return pv && Array.isArray(pv.events) ? pv.events.filter(x => x.tickBefore == null).length : 0; };
  const share = (need, budget) => { const total = entries.reduce((s, e) => s + need(e), 0); return e => (total > 0 ? Math.ceil(budget * need(e) / total) : 0); };
  const gridShare = share(gridNeed, BACKFILL), enrichShare = share(enrichNeed, ENRICH);

  const CONC = Math.max(1, opts.concurrency || 4);
  const results = new Array(entries.length).fill(null);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      const e = entries[i];
      try { results[i] = await collectVault(e, gridShare(e), enrichShare(e)); }
      catch (err) {
        log(`collect ${e.id} failed: ${err.message}`);
        const pv = prevById[e.id];
        if (pv && pv._schema3) results[i] = { ...pv, _stale: true };           // keep the last good record
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, entries.length) }, worker));

  const out = { generatedAtBlock: head, generatedAtTs: headTs, _schema: SCHEMA, gridSeconds: GRID, vaults: results.filter(Boolean) };
  const sum = f => out.vaults.reduce((s, v) => s + (f(v) || 0), 0);
  out.progress = {
    gridFilled: sum(v => v.gridFilled), gridTotal: sum(v => v.gridTotal),
    eventsWithPrices: sum(v => v.events.filter(e => e.tickBefore != null).length), events: sum(v => v.events.length),
  };
  out._rpcCalls = calls();
  out._incremental = !!prev;
  return out;
}

function autoId(e) {
  return "vault_" + lc(e.vault).slice(2, 10);
}

module.exports = { collectAll, SCHEMA, amountsFor, valueRaw0, backfillOrder, deriveNames, T, GENESIS_TS };

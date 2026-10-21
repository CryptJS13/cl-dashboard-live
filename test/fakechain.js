// A fake Base chain for the collector's tests: no network. It simulates, block by block, the two
// experiment vault designs on a cbBTC/USDC pool with a seeded random price path, answers the JSON-RPC
// calls the collector makes (Multicall3 included), and keeps the true figures to check against:
//   vault A (design "V3"): always in, 16-spacing range, re-entered at the edge it left by, AERO sold for
//                          USDC that stays in the vault, swap fees on the buffer;
//   vault B (design "parked"): both tokens lent on Aave by default, in the pool from 08:00 to 14:00 UTC
//                          each day on a range fitted around the price, moved to an edge if the price
//                          leaves it, AERO sold each evening and the USDC lent.
// The vault and strategy addresses below are test placeholders, not deployed contracts.
const { utils } = require("ethers");
const { amountsFor } = require("../collect.js");

const coder = utils.defaultAbiCoder;
const sel = s => utils.id(s).slice(0, 10);
const lc = a => a.toLowerCase();
const GENESIS_TS = 1686789347, BPD = 43200, SPACING = 100, WIDTH = 1600;

const ADDR = {
  MC: lc("0xcA11bde05977b3631167028862bE2a173976CA11"),
  USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", CBBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  AERO: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", AERO_POOL: "0xccd9cc53b63662088c738b8bc06e9078fb8d9ad4",
  POOL: lc("0x4e962BB3889Bf030368F56810A9c96B83CB3E778"), GAUGE: lc("0x6399ed6725cC163D019aA64FF55b22149D7179A8"),
  NPM: lc("0x827922686190790b37229fd06084350E74485b72"), FACTORY: lc("0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"),
  AAVE: lc("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),
  AUSDC: lc("0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB"), ACBBTC: lc("0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6"),
  // placeholders for the tests only
  VA: "0x00000000000000000000000000000000000a0001", SA: "0x00000000000000000000000000000000000a0002",
  VB: "0x00000000000000000000000000000000000b0001", SB: "0x00000000000000000000000000000000000b0002",
};
const T = {
  transfer: utils.id("Transfer(address,address,uint256)"), claim: utils.id("ClaimRewards(address,uint256)"),
  rebV2: utils.id("RangeRebalanced(uint256,uint256,uint256,uint256,uint256,uint256)"), rebV1: utils.id("Rebalanced(uint256,uint256,uint256,uint256,uint256)"),
  harvested: utils.id("Harvested(uint256,uint256,uint256)"), rewardSold: utils.id("RewardSold(uint256,uint256,uint256,uint256)"),
  feesCollected: utils.id("FeesCollected(uint256,uint256,uint256,uint256)"),
};
const topicAddr = a => "0x" + "0".repeat(24) + lc(a).slice(2);
const U = x => coder.encode(["uint256"], [BigInt(Math.max(0, Math.round(x)))]);
const I = x => coder.encode(["int256"], [BigInt(Math.round(x))]);
const A = a => coder.encode(["address"], [a]);
const BIG = x => BigInt(Math.max(0, Math.round(x)));

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function buildChain(opts = {}) {
  const head = opts.head || 52900000, days = opts.days || 10;
  const birthA = head - days * BPD, birthB = birthA + 50, depA = birthA + 100, depB = birthB + 100;
  const STEP = 300;                                       // simulation step: 10 minutes
  const tsOf = b => GENESIS_TS + 2 * b;

  // ---- price: a seeded walk of the pool tick, one step per 15 minutes, linear in between
  const rnd = mulberry32(opts.seed || 7);
  const normal = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const W = [-67213]; const from = birthA - 2000;
  // a seeded walk, plus a rally on day 5 from 09:00 UTC (+1,600 ticks in 5 hours) so both vaults have to move their range
  const tsAt = blk => GENESIS_TS + 2 * blk;
  const rallyFrom = Math.floor(tsAt(birthA) / 86400 + 5) * 86400 + 9 * 3600;
  for (let k = 1; k <= Math.ceil((head - from) / 450) + 2; k++) {
    const t = tsAt(from + k * 450);
    W.push(W[k - 1] + normal() * (opts.tickVol || 60) + (opts.rally !== false && t >= rallyFrom && t < rallyFrom + 5 * 3600 ? 80 : 0));
  }
  const tickAt = b => { const x = (b - from) / 450, k = Math.max(0, Math.min(W.length - 2, Math.floor(x))); return Math.round(W[k] + (W[k + 1] - W[k]) * (x - k)); };
  const sOf = b => Math.pow(1.0001, tickAt(b) / 2);
  const ixAt = (b, apr) => Math.exp(apr * (b - birthA) * 2 / 31536000);   // Aave normalized income, as a fraction
  const APR0 = 0.0377, APR1 = 0.0001;
  const valueIn0 = (x0, x1, s) => x0 + x1 / (s * s);
  const rangeValuePerL = (lo, hi, s) => { const [x0, x1] = amountsFor(1, lo, hi, s); return valueIn0(x0, x1, s); };
  function liqFor(lo, hi, s, a0, a1) { const [u0, u1] = amountsFor(1, lo, hi, s); let L = Infinity; if (u0 > 0) L = Math.min(L, a0 / u0); if (u1 > 0) L = Math.min(L, a1 / u1); return isFinite(L) ? L : 0; }
  const centred = tick => { const lo = Math.floor(tick / SPACING) * SPACING - WIDTH / 2; return [lo, lo + WIDTH]; };
  const edge = (tick, below) => { if (below) { const lo = (Math.floor(tick / SPACING) - 1) * SPACING; return [lo, lo + WIDTH]; } const hi = (Math.floor(tick / SPACING) + 2) * SPACING; return [hi - WIDTH, hi]; };
  const aeroUsd = 0.89, aeroTick = Math.round(Math.log(1e12 / aeroUsd) / Math.log(1.0001));
  const usdc = x => x * 1e6;                              // whole USDC to raw

  const logs = [], receipts = {};
  let nonce = 0;
  const txh = () => utils.id("tx" + (nonce++));
  function emit(block, tx, address, topics, data) { const l = { address, topics, data, blockNumber: "0x" + block.toString(16), transactionHash: tx, logIndex: "0x0" }; logs.push(l); (receipts[tx] = receipts[tx] || { transactionHash: tx, blockNumber: l.blockNumber, logs: [] }).logs.push(l); return l; }

  // ---- vault A
  const a = { L: 0, lo: 0, hi: 0, vIdle0: 0, sIdle0: 0, sIdle1: 0, supply: 0, aero: 0, fees: 0, rp: 0 };
  const b = { L: 0, lo: 0, hi: 0, s0: 0, s1: 0, supply: 0, aero: 0, id: 0 };
  const snapsA = [], snapsB = [];
  const snap = (arr, blk, obj) => arr.push({ block: blk, st: { ...obj } });
  const truth = { A: { events: [], aeroT0: 0, feesT0: 0, reentries: 0, harvests: 0 }, B: { events: [], enters: 0, exits: 0, replaces: 0, harvests: 0, deployedSec: 0, lendT0: 0, aeroT0: 0 } };

  const navA = (st, s) => valueIn0(...amountsFor(st.L, st.lo, st.hi, s), s) + st.vIdle0 + st.sIdle0 + st.sIdle1 / (s * s);
  const navB = (st, blk, s) => valueIn0(...amountsFor(st.L, st.lo, st.hi, s), s) + st.s0 * ixAt(blk, APR0) + st.s1 * ixAt(blk, APR1) / (s * s);

  for (let blk = birthA; blk <= head; blk += STEP) {
    const s = sOf(blk), tick = tickAt(blk), P = s * s;          // P = raw cbBTC per raw USDC
    const hour = Math.floor((tsOf(blk) % 86400) / 3600);
    // ===== A
    if (blk >= depA && a.supply === 0) {                       // first deposit: $1,000, centred range
      [a.lo, a.hi] = centred(tick); a.L = usdc(1000) / rangeValuePerL(a.lo, a.hi, s); a.supply = a.L; snap(snapsA, blk, a);
    } else if (a.supply > 0) {
      const posV = valueIn0(...amountsFor(a.L, a.lo, a.hi, s), s);
      a.aero += posV * 0.10 / 365 / 144;                       // 10% a year, in raw-USDC worth of AERO, while in
      a.fees += posV * 0.02 / 365 / 144;                       // swap fees on the buffer
      const out = tick < a.lo || tick >= a.hi;
      const harvest = (blk - depA) % BPD < STEP && blk > depA;
      if (out || harvest) {
        const before = navA(a, s) / a.supply;
        const tx = txh();
        const aeroAmt = a.aero / aeroUsd * 1e12;               // AERO raw (18 dec) from raw USDC worth
        const paid = a.aero * 0.9, fee0 = a.fees * 0.45, fee1 = a.fees * 0.45 * P;
        if (harvest) emit(blk, tx, ADDR.GAUGE, [T.claim, topicAddr(ADDR.SA)], U(aeroAmt));
        emit(blk, tx, ADDR.AERO, [T.transfer, topicAddr(ADDR.GAUGE), topicAddr(ADDR.SA)], U(aeroAmt));
        emit(blk, tx, ADDR.SA, [T.rewardSold], coder.encode(["uint256", "uint256", "uint256", "uint256"], [BIG(aeroAmt), BIG(a.aero), BIG(a.aero * 0.1), BIG(paid)]));
        emit(blk, tx, ADDR.SA, [T.feesCollected], coder.encode(["uint256", "uint256", "uint256", "uint256"], [BIG(a.fees * 0.5), BIG(a.fees * 0.5 * P), BIG(a.fees * 0.05), BIG(a.fees * 0.05 * P)]));
        a.vIdle0 += paid; a.sIdle0 += fee0; a.sIdle1 += fee1; a.rp += paid;
        truth.A.aeroT0 += paid / 1e6; truth.A.feesT0 += a.fees * 0.9 / 1e6;
        const navMid = navA(a, s);
        let cost = 0;
        if (out) {
          const posV2 = valueIn0(...amountsFor(a.L, a.lo, a.hi, s), s);
          cost = posV2 * 0.00025;                              // the re-entry swap
          [a.lo, a.hi] = edge(tick, tick < a.lo);
          const Lb = a.L; a.L = (posV2 - cost) / rangeValuePerL(a.lo, a.hi, s);
          emit(blk, tx, ADDR.VA, [T.rebV2], coder.encode(Array(6).fill("uint256"), [1n, 2n, 3n, 4n, BIG(Lb), BIG(a.L)]));
          truth.A.reentries++;
        } else truth.A.harvests++;
        const after = navA(a, s) / a.supply;
        truth.A.events.push({ block: blk, kind: out ? "rebalance" : "harvest", netPct: (after / before - 1) * 100, aeroPct: paid / (navMid - paid - fee0 - fee1 / P) * 100, costPct: -cost / navMid * 100 });
        receipts[tx].status = "0x1";
        a.aero = 0; a.fees = 0;
        snap(snapsA, blk, a);
      }
    }
    // ===== B
    if (blk >= depB && b.supply === 0) {
      b.s0 = usdc(500) / ixAt(blk, APR0); b.s1 = usdc(500) * P / ixAt(blk, APR1); b.supply = 1e21; snap(snapsB, blk, b);
    } else if (b.supply > 0) {
      const dep = b.L > 0;
      if (dep) { truth.B.deployedSec += STEP * 2; b.aero += valueIn0(...amountsFor(b.L, b.lo, b.hi, s), s) * 0.20 / 365 / 144; }
      // lending interest over this step, for the truth
      truth.B.lendT0 += (b.s0 * (ixAt(blk + STEP, APR0) - ixAt(blk, APR0)) + b.s1 * (ixAt(blk + STEP, APR1) - ixAt(blk, APR1)) / P) / 1e6 / (navB(b, blk, s) / 1e6) * 100;
      let action = 0, cost = 0;
      const tx = txh();
      const before = navB(b, blk, s);
      const lent0 = b.s0 * ixAt(blk, APR0), lent1 = b.s1 * ixAt(blk, APR1);
      if (!dep && hour >= 8 && hour < 14) {
        [b.lo, b.hi] = centred(tick);
        b.L = liqFor(b.lo, b.hi, s, lent0, lent1) * 0.995;
        const [x0, x1] = amountsFor(b.L, b.lo, b.hi, s);
        cost = before * 0.0002;
        b.s0 = (lent0 - x0 - cost) / ixAt(blk, APR0); b.s1 = (lent1 - x1) / ixAt(blk, APR1);
        b.id = 100 + nonce; action = 1; truth.B.enters++;
      } else if (dep && !(hour >= 8 && hour < 14)) {
        const [x0, x1] = amountsFor(b.L, b.lo, b.hi, s);
        cost = before * 0.0001;
        b.s0 = (lent0 + x0 - cost) / ixAt(blk, APR0); b.s1 = (lent1 + x1) / ixAt(blk, APR1); b.L = 0; b.lo = b.hi = 0;
        action = 2; truth.B.exits++;
      } else if (dep && (tick < b.lo || tick >= b.hi)) {
        const [x0, x1] = amountsFor(b.L, b.lo, b.hi, s);
        const below = tick < b.lo;
        [b.lo, b.hi] = edge(tick, below);
        cost = before * 0.0003;
        const t0 = lent0 + x0 - cost, t1 = lent1 + x1;
        b.L = liqFor(b.lo, b.hi, s, t0, t1) * 0.99;
        const [y0, y1] = amountsFor(b.L, b.lo, b.hi, s);
        b.s0 = (t0 - y0) / ixAt(blk, APR0); b.s1 = (t1 - y1) / ixAt(blk, APR1);
        action = 3; truth.B.replaces++;
      }
      if (action) {
        const after = navB(b, blk, s);
        emit(blk, tx, ADDR.VB, [T.rebV1], coder.encode(Array(5).fill("uint256"), [1n, 2n, BIG(before), BIG(after), BigInt(action)]));
        truth.B.events.push({ block: blk, kind: "rebalance", action: { 1: "enter", 2: "exit", 3: "replace" }[action], costPct: (after / before - 1) * 100 });
        receipts[tx].status = "0x1";
        snap(snapsB, blk, b);
      } else if (hour === 20 && Math.floor((tsOf(blk) % 3600) / 600) === 0 && b.aero > 0) {
        const nav = before;
        const proceeds = b.aero;
        b.s0 += proceeds / ixAt(blk, APR0);
        emit(blk, tx, ADDR.VB, [T.harvested], coder.encode(["uint256", "uint256", "uint256"], [BIG(b.aero / aeroUsd * 1e12), BIG(proceeds), 0n]));
        truth.B.events.push({ block: blk, kind: "harvest", aeroPct: proceeds / nav * 100 });
        truth.B.aeroT0 += proceeds / 1e6; truth.B.harvests++;
        b.aero = 0;
        receipts[tx].status = "0x1";
        snap(snapsB, blk, b);
      }
    }
  }

  const stAt = (arr, blk) => { let lo = 0, hi = arr.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].block <= blk) { r = arr[m]; lo = m + 1; } else hi = m - 1; } return r ? r.st : null; };

  // ---- views
  const revert = () => { throw new Error("revert"); };
  function view(to, data, blk) {
    to = lc(to); const s4 = data.slice(0, 10), arg = data.slice(10);
    const argAddr = () => "0x" + arg.slice(24, 64);
    const s = sOf(blk), tick = tickAt(blk);
    if (to === ADDR.MC && s4 === sel("getCurrentBlockTimestamp()")) return U(tsOf(blk));
    if (to === ADDR.POOL) {
      if (s4 === sel("slot0()")) return coder.encode(["uint160", "int24", "uint16", "uint16", "uint16", "bool"], [BigInt(Math.round(s * 2 ** 96)), tick, 0, 1, 1, true]);
      if (s4 === sel("tickSpacing()")) return I(SPACING);
      if (s4 === sel("token0()")) return A(ADDR.USDC);
      if (s4 === sel("token1()")) return A(ADDR.CBBTC);
    }
    if (to === ADDR.AERO_POOL && s4 === sel("slot0()")) return coder.encode(["uint160", "int24", "uint16", "uint16", "uint16", "bool"], [1n, aeroTick, 0, 1, 1, true]);
    if (to === ADDR.NPM && s4 === sel("factory()")) return A(ADDR.FACTORY);
    if (to === ADDR.FACTORY && s4 === sel("getPool(address,address,int24)")) {
      const t0 = "0x" + arg.slice(24, 64), t1 = "0x" + arg.slice(88, 128), ts = parseInt(arg.slice(128 + 56, 192), 16);
      const pair = [t0, t1].sort().join();
      return A(pair === [ADDR.USDC, ADDR.CBBTC].sort().join() && ts === SPACING ? ADDR.POOL : "0x0000000000000000000000000000000000000000");
    }
    if (to === ADDR.USDC || to === ADDR.CBBTC) {
      const usd = to === ADDR.USDC;
      if (s4 === sel("decimals()")) return U(usd ? 6 : 8);
      if (s4 === sel("symbol()")) return coder.encode(["string"], [usd ? "USDC" : "cbBTC"]);
      if (s4 === sel("balanceOf(address)")) {
        const who = lc(argAddr()); const st = who === ADDR.VA || who === ADDR.SA ? stAt(snapsA, blk) : null;
        if (!st) return U(0);
        if (who === ADDR.VA) return U(usd ? st.vIdle0 : 0);
        return U(usd ? st.sIdle0 : st.sIdle1);                 // strategy A's raw balances (idleBalances is what counts)
      }
    }
    if (to === ADDR.AAVE && s4 === sel("getReserveNormalizedIncome(address)")) return coder.encode(["uint256"], [BigInt(Math.round(ixAt(blk, lc(argAddr()) === ADDR.USDC ? APR0 : APR1) * 1e9)) * 10n ** 18n]);
    if (to === ADDR.VA || to === ADDR.SA) {
      if (blk < birthA) return "0x";
      const st = stAt(snapsA, blk) || { L: 0, lo: 0, hi: 0, vIdle0: 0, sIdle0: 0, sIdle1: 0, supply: 0, rp: 0 };
      const amts = amountsFor(st.L, st.lo, st.hi, s);
      const idleV = st.vIdle0 + st.sIdle0 + st.sIdle1 / (s * s);
      const ubwi = st.L + (st.L > 0 ? idleV / rangeValuePerL(st.lo, st.hi, s) : 0);
      const v = {
        [sel("token0()")]: () => A(ADDR.USDC), [sel("token1()")]: () => A(ADDR.CBBTC), [sel("posManager()")]: () => A(ADDR.NPM),
        [sel("tickSpacing()")]: () => I(SPACING), [sel("posWidth()")]: () => U(16), [sel("bufferPosId()")]: () => U(2), [sel("depositCap()")]: () => U(1e30),
        [sel("tickLower()")]: () => I(st.lo), [sel("tickUpper()")]: () => I(st.hi), [sel("strategy()")]: () => A(ADDR.SA),
        [sel("getCurrentTokenAmounts()")]: () => coder.encode(["uint256", "uint256"], [BIG(amts[0]), BIG(amts[1])]),
        [sel("underlyingBalanceWithInvestment()")]: () => U(ubwi), [sel("totalLiquidity()")]: () => U(st.L),
        [sel("getPricePerFullShare()")]: () => U(st.supply > 0 ? ubwi / st.supply * 1e18 : 1e18), [sel("totalSupply()")]: () => U(st.supply),
      };
      const vs = {
        [sel("rewardPool()")]: () => A(ADDR.GAUGE), [sel("idleBalances()")]: () => coder.encode(["uint256", "uint256"], [BIG(st.sIdle0), BIG(st.sIdle1)]),
        [sel("rewardProceeds()")]: () => U(st.rp), [sel("feeDenominator()")]: () => U(10000), [sel("profitSharingNumerator()")]: () => U(700),
        [sel("platformFeeNumerator()")]: () => U(300), [sel("strategistFeeNumerator()")]: () => U(0),
      };
      const f = (to === ADDR.VA ? v : vs)[s4]; return f ? f() : revert();
    }
    if (to === ADDR.VB || to === ADDR.SB) {
      if (blk < birthB) return "0x";
      const st = stAt(snapsB, blk) || { L: 0, lo: 0, hi: 0, s0: 0, s1: 0, supply: 0, id: 0 };
      const l0 = st.s0 * ixAt(blk, APR0), l1 = st.s1 * ixAt(blk, APR1);
      const amts = amountsFor(st.L, st.lo, st.hi, s);
      const nav = valueIn0(amts[0] + l0, amts[1] + l1, s);
      const v = {
        [sel("token0()")]: () => A(ADDR.USDC), [sel("token1()")]: () => A(ADDR.CBBTC), [sel("pool()")]: () => A(ADDR.POOL),
        [sel("tickSpacing()")]: () => I(SPACING), [sel("width()")]: () => I(WIDTH), [sel("isDeployed()")]: () => U(st.L > 0 ? 1 : 0),
        [sel("tickLower()")]: () => I(st.lo), [sel("tickUpper()")]: () => I(st.hi), [sel("strategy()")]: () => A(ADDR.SB),
        [sel("getCurrentTokenAmounts()")]: () => coder.encode(["uint256", "uint256"], [BIG(amts[0] + l0), BIG(amts[1] + l1)]),
        [sel("underlyingBalanceWithInvestment()")]: () => U(nav), [sel("getPricePerFullShare()")]: () => U(st.supply > 0 ? nav * 1e18 / st.supply : 1e6),
        [sel("totalSupply()")]: () => U(st.supply),
      };
      const vs = {
        [sel("rewardPool()")]: () => A(ADDR.GAUGE), [sel("lendingPool()")]: () => A(ADDR.AAVE), [sel("aToken0()")]: () => A(ADDR.AUSDC), [sel("aToken1()")]: () => A(ADDR.ACBBTC),
        [sel("holdings()")]: () => coder.encode(["uint128", "int24", "int24", "uint256", "uint256", "uint256", "uint256"], [BIG(st.L), st.lo, st.hi, BIG(l0), BIG(l1), 0n, 0n]),
        [sel("feeDenominator()")]: () => U(10000), [sel("profitSharingNumerator()")]: () => U(0), [sel("platformFeeNumerator()")]: () => U(0), [sel("strategistFeeNumerator()")]: () => U(0),
      };
      const f = (to === ADDR.VB ? v : vs)[s4]; return f ? f() : revert();
    }
    return revert();
  }

  const MC = new utils.Interface(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
  const counter = { n: 0 };
  async function rpc(method, params = []) {
    counter.n++;
    const blkOf = tag => tag === "latest" ? head : parseInt(tag, 16);
    switch (method) {
      case "eth_blockNumber": return "0x" + head.toString(16);
      case "eth_getBlockByNumber": { const bk = blkOf(params[0]); return { number: "0x" + bk.toString(16), timestamp: "0x" + tsOf(bk).toString(16) }; }
      case "eth_getCode": { const bk = blkOf(params[1]), a2 = lc(params[0]); if ((a2 === ADDR.VA && bk >= birthA) || (a2 === ADDR.VB && bk >= birthB)) return "0x6080"; return "0x"; }
      case "eth_call": {
        const { to, data } = params[0], bk = blkOf(params[1]);
        if (lc(to) === ADDR.MC && data.startsWith(MC.getSighash("aggregate3"))) {
          const [calls] = MC.decodeFunctionData("aggregate3", data);
          const res = calls.map(c => { try { const r = view(c.target, c.callData, bk); return [r !== "0x", r]; } catch { return [false, "0x"]; } });
          return MC.encodeFunctionResult("aggregate3", [res]);
        }
        try { return view(to, data, bk); } catch { throw new Error(JSON.stringify({ code: 3, message: "execution reverted" })); }
      }
      case "eth_getLogs": {
        const f = params[0], fb = parseInt(f.fromBlock, 16), tb = parseInt(f.toBlock, 16);
        const t0s = f.topics && f.topics[0] ? [].concat(f.topics[0]) : null, t1 = f.topics && f.topics[1];
        return logs.filter(l => lc(l.address) === lc(f.address) && parseInt(l.blockNumber, 16) >= fb && parseInt(l.blockNumber, 16) <= tb
          && (!t0s || t0s.includes(l.topics[0])) && (!t1 || l.topics[1] === t1));
      }
      case "eth_getTransactionReceipt": return receipts[params[0]] || null;
    }
    throw new Error("fake chain: no " + method);
  }
  rpc.counter = counter;
  return { rpc, truth, head, birthA, birthB, depA, depB, ADDR, tickAt, stAt: (k, blk) => stAt(k === "A" ? snapsA : snapsB, blk), ixAt };
}

module.exports = { buildChain, ADDR };

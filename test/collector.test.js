// Run with `npm test`. No network: the collector reads a simulated chain (test/fakechain.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChain, ADDR } = require("./fakechain");
const { collectAll, backfillOrder, amountsFor, deriveNames } = require("../collect");
const { buildView, summaries } = require("../view");
const M = require("../public/metrics");

const VAULTS = [
  { id: "aeroCL_USDC_cbBTC_16edge", vault: ADDR.VA, label: "always in (edge re-entry)" },
  { id: "aeroCL_USDC_cbBTC_16parked", vault: ADDR.VB, label: "parked by default" },
];
const near = (x, y, tol, msg) => assert.ok(Math.abs(x - y) <= tol, `${msg}: ${x} vs ${y} (tolerance ${tol})`);
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

async function collectUntilFull(chain, vaults, prev, opts = {}) {
  let d = prev;
  for (let pass = 0; pass < 12; pass++) {
    d = await collectAll(null, { rpc: chain.rpc, vaults, prev: d, backfillCalls: 500, enrichCalls: 500, ...opts });
    if (d.progress.gridFilled >= d.progress.gridTotal && d.progress.eventsWithPrices >= d.progress.events) break;
  }
  return d;
}

let chain, data;
test.before(async () => { chain = buildChain(); data = await collectUntilFull(chain, VAULTS, null); });

test("finds each vault's design, pool, tokens and width on chain from just its address", () => {
  const [a, b] = data.vaults;
  assert.equal(a.design, "V3"); assert.equal(b.design, "parked");
  for (const v of [a, b]) {
    assert.equal(v.pool, ADDR.POOL);
    assert.equal(v.sym0, "USDC"); assert.equal(v.sym1, "cbBTC"); assert.equal(v.d0, 6); assert.equal(v.d1, 8);
    assert.equal(v.widthTicks, 1600); near(v.widthPct, 17.35, 0.01, "width %");
    assert.equal(v.gauge, ADDR.GAUGE);
    assert.equal(v.pair, "cbBTC");
  }
  assert.equal(a.birth, chain.birthA); assert.equal(b.birth, chain.birthB);
  assert.equal(b.ppsUnit, "token0"); assert.equal(b.lending.pool, ADDR.AAVE);
  assert.equal(a.label, "always in (edge re-entry)");
});

test("fills an hourly grid from the vault's birth to the head block", () => {
  for (const v of data.vaults) {
    assert.equal(v.gridFilled, v.gridTotal, v.id + " grid complete");
    const s = v.series.filter(x => !x.tip);
    for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i].ts - s[i - 1].ts - 3600) <= 2, `${v.id} sample ${i} is an hour after the one before`);
    assert.ok(s[0].ts - (1686789347 + 2 * v.birth) < 3600 + 2, "grid starts within the hour after birth");
    assert.ok(v.series[v.series.length - 1].tip, "ends with a sample at the head block");
  }
});

test("vault A: every re-entry and harvest (found from its own RewardSold, not the gauge), AERO paid in USDC, re-entry cost", () => {
  const a = data.vaults[0], T = chain.truth.A;
  const reb = a.events.filter(e => e.kind === "rebalance"), harv = a.events.filter(e => e.kind === "harvest");
  assert.equal(reb.length, T.reentries); assert.equal(harv.length, T.harvests);
  assert.ok(T.reentries >= 3, "the price path makes the vault re-enter a few times");
  near(sum(a.events, e => e.aeroPct), sum(T.events, e => e.aeroPct), 0.002, "AERO income, % summed");
  T.events.forEach((t, i) => {
    const e = a.events[i];
    assert.equal(e.block, t.block);
    near(e.netPct, t.netPct, 0.002, `event ${i} net %`);
  });
  // a re-entry's cost is the swap only (value at the price just before), here 2.5 bp of the position
  reb.forEach(e => assert.ok(e.costPct < 0 && e.costPct > -0.05, `re-entry cost ${e.costPct}`));
  // ranges after each re-entry are read at the exact block, edge-placed (1,600 ticks, price near one edge)
  reb.forEach(e => { assert.equal(e.tickHi - e.tickLo, 1600); const pos = (e.tickAfter - e.tickLo) / 1600; assert.ok(pos < 0.2 || pos > 0.8, "edge placement"); });
});

test("vault B: enters, leaves and moves, with the keeper's cost from the vault's own event, AERO and lending", () => {
  const b = data.vaults[1], T = chain.truth.B;
  const by = k => b.events.filter(e => e.action === k);
  assert.equal(by("enter").length, T.enters); assert.equal(by("exit").length, T.exits); assert.equal(by("replace").length, T.replaces);
  assert.equal(b.events.filter(e => e.kind === "harvest").length, T.harvests);
  const moves = b.events.filter(e => e.kind === "rebalance");
  T.events.filter(e => e.kind === "rebalance").forEach((t, i) => near(moves[i].costPct, t.costPct, 1e-6, `move ${i} cost`));
  near(sum(b.events, e => e.aeroPct), sum(T.events, e => e.aeroPct), 0.002, "AERO income, % summed");
  const view = buildView(data), vb = M.decode(view.vaults[1]);
  const w = M.windowStats(vb, vb.t[0], vb.t[vb.t.length - 1], 3600);
  near(w.lending, T.lendT0, Math.max(0.002, T.lendT0 * 0.05), "lending income %");
  const life = vb.t[vb.t.length - 1] - vb.t[0];
  near(w.inPool, T.deployedSec / life * 100, 2.5, "share of time in the pool");
  assert.equal(w.nEnter, T.enters); assert.equal(w.booked, null, "no liquidity-unit share price for the parked vault");
});

test("figures: vs holding 50/50 and marked agree with the definitions on the samples", () => {
  const view = buildView(data);
  for (const vv of view.vaults) {
    const a = M.decode(vv);
    const n = a.t.length - 1, i0 = M.span(a, a.t[0], a.t[n])[0];
    const r = M.price(a, n) / M.price(a, i0), L = a.v0[n] / a.v0[i0];
    const w = M.windowStats(a, a.t[0], a.t[n], 3600);
    near(w.vsHold, (L / (0.5 + 0.5 * r) - 1) * 100, 1e-9, "vs hold");
    near(w.marked, (L / Math.sqrt(r) - 1) * 100, 1e-9, "marked");
    assert.ok(w.marked >= w.vsHold - 1e-9, "a 50/50 kept at 50/50 never beats holding 50/50, so marked >= vs hold");
    near(w.volDaily, 60 * Math.sqrt(96) * 1e-4 * 100, 1.2, "daily volatility from 4-hour moves vs the simulated path's (60 ticks per 15 min)");
  }
  const s = summaries(view);
  assert.ok(s.aeroCL_USDC_cbBTC_16edge && s.aeroCL_USDC_cbBTC_16parked);
});

test("a second refresh at the same head reads only the head sample, the logs and the strategy", async () => {
  const before = chain.rpc.counter.n;
  const d2 = await collectAll(null, { rpc: chain.rpc, vaults: VAULTS, prev: data });
  const used = chain.rpc.counter.n - before;
  assert.ok(used < 40, `incremental refresh used ${used} calls`);
  assert.equal(d2.vaults[0].events.length, data.vaults[0].events.length);
  assert.equal(d2.vaults[1].gridFilled, data.vaults[1].gridFilled);
});

test("migrates the earlier build's cache: keeps its events, rebuilds the samples on the grid", async () => {
  const legacy = { _schema: 2, generatedAtBlock: data.generatedAtBlock, generatedAtTs: data.generatedAtTs, vaults: data.vaults.map(v => ({
    id: v.id, vault: v.vault, pool: v.pool, design: v.design, token0: v.token0, token1: v.token1, d0: v.d0, d1: v.d1, birth: v.birth, strat: v.strat, gauge: v.gauge,
    series: v.series.filter((_, i) => i % 50 === 0).map(({ k, tip, ...x }) => x),
    events: v.events.map(e => ({ kind: e.kind, tx: e.tx, block: e.block, ts: e.ts, netPct: e.netPct, income: e.income, cost: e.cost, incomePct: e.incomePct, costPct: e.costPct, aeroClaimed: e.aeroClaimed, fee0: e.fee0, fee1: e.fee1, marker: "old" })),
  })) };
  const receiptsBefore = countMethod("eth_getTransactionReceipt");
  const view0 = buildView(legacy);                         // the page can show the old cache before the first refresh
  assert.equal(view0.legacy, true); assert.equal(view0.vaults.length, 2);
  const d = await collectUntilFull(chain, VAULTS, legacy);
  assert.equal(countMethod("eth_getTransactionReceipt"), receiptsBefore, "old events are not read again");
  for (const v of d.vaults) {
    assert.ok(v.events.every(e => e.marker === "old"), "events kept");
    assert.ok(v.events.every(e => e.tickBefore != null && e.aeroPct != null), "events given their prices and split");
    assert.equal(v.gridFilled, v.gridTotal);
  }
});
let methodCounts = null;
function countMethod(m) {
  if (!methodCounts) { methodCounts = {}; const inner = chain.rpc; const wrapped = async (method, params) => { methodCounts[method] = (methodCounts[method] || 0) + 1; return inner(method, params); }; wrapped.counter = inner.counter; chain.rpc = wrapped; }
  return methodCounts[m] || 0;
}

test("grid order: daily points first, then finer, newest first within each pass", () => {
  const o = backfillOrder(50, new Set([48]), {}, 3600, 3);
  assert.deepEqual(o.slice(0, 3), [24, 0, 44]);   // daily (every 24), then 4-hourly (every 4)
  assert.ok(o.indexOf(1) > o.indexOf(6));
  assert.ok(!o.includes(48));
  assert.equal(new Set(o).size, 50);
});

test("liquidity maths and the names derived for the existing vaults", () => {
  const [x0, x1] = amountsFor(1e12, -100, 100, 1);
  near(x0 / x1, 1, 1e-9, "centred range holds equal raw amounts at price 1");
  const m = (s0, s1) => ({ sym0: s0, sym1: s1, design: "V1" });
  assert.equal(deriveNames({}, m("tBTC", "cbBTC"), 0.01).pair, "cbBTC");
  assert.equal(deriveNames({}, m("cbETH", "WETH"), 0.01).pair, "cbETH");
  assert.equal(deriveNames({}, m("WETH", "cbBTC"), 4.08).pair, "cbBTC");
  assert.equal(deriveNames({}, m("USDC", "AAPLc"), 2.02).pair, "AAPLc");
  assert.equal(deriveNames({}, m("EURC", "USDC"), 0.5).pair, "EURC");
  assert.equal(deriveNames({}, m("USDC", "NVDAc"), 2.02).platform, "USDC/NVDAc 2.02% - Aero Automated CL");
});

// Builds what the page loads (/api/view) from the collector's snapshot: per vault, compact arrays over
// its samples and its events, with the derived per-sample figures (value per share in token0, the
// current range's not-yet-booked loss, cumulative lending income). Also used for the API's `summary`.
// Accepts the earlier build's snapshot (schema 2) too, so the page has something to show while the
// first refresh of a new deploy runs.
const M = require("./public/metrics.js");

const r8 = x => (x == null || !isFinite(x) ? null : Number(x.toPrecision(8)));
const r6 = x => (x == null || !isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const KIND = { harvest: "h", rebalance: "r" };

// names for a vault from the earlier build, which kept no symbols: read them from its id
function legacyNames(v) {
  const parts = v.id.replace(/^aeroCL_/, "").split("_");
  const last = parts[parts.length - 1];
  const hasW = !isNaN(parseInt(last, 10));
  const toks = hasW ? parts.slice(0, -1) : parts.filter(x => x !== "new");
  return { sym0: v.sym0 || toks[0] || "token0", sym1: v.sym1 || toks[1] || "token1" };
}

function centredValuePerL(widthTicks) { return 2 * (1 - Math.pow(1.0001, -widthTicks / 4)); }

function vaultView(v, gridSeconds) {
  const legacy = !v._schema3;
  const names = legacyNames(v);
  const s = (v.series || []).filter(x => x && x.ts != null).slice().sort((a, b) => a.ts - b.ts);
  const parked = v.design === "parked";
  const d0 = v.d0, d1 = v.d1;
  let widthTicks = v.widthTicks;
  if (widthTicks == null && s.length) { const l = s[s.length - 1]; widthTicks = l.tickHi - l.tickLo; }
  const ubOk = !parked && v.design !== "V3" && widthTicks > (v.spacing || 1) && v.spacing != null;
  const t = [], tick = [], lo = [], hi = [], pps = [], v0 = [], ub = [], lend = [], dep = [];
  let prevT = 0, cum = 0, prev = null;
  for (const x of s) {
    t.push(x.ts - prevT); prevT = x.ts;
    tick.push(x.tick);
    const deployed = parked ? !!x.deployed : x.tickLo !== x.tickHi;
    lo.push(deployed ? x.tickLo : 0); hi.push(deployed ? x.tickHi : 0);
    pps.push(r8(x.pps));
    const val0 = (x.a0 + x.idle0) + (x.a1 + x.idle1) * x.priceT1inT0;   // whole token0 units
    v0.push(x.supply > 0 ? r8(val0 / x.supply) : 0);
    if (ubOk) {
      // the liquidity a re-centred range of the same width would get from everything held, at this price
      const sp = Math.pow(1.0001, x.tick / 2);
      const rawV = val0 * 10 ** d0;
      const Lc = rawV * sp / centredValuePerL(widthTicks);
      ub.push(x.valueL > 0 ? r6((Lc / x.valueL - 1) * 100) : null);
    }
    if (parked) {
      dep.push(deployed ? 1 : 0);
      if (prev && prev.ix0 && x.ix0 && prev.ix1 && x.ix1) {
        const V = (prev.a0 + prev.idle0) + (prev.a1 + prev.idle1) * prev.priceT1inT0;
        const g = (prev.lent0 || 0) * (x.ix0 / prev.ix0 - 1) + (prev.lent1 || 0) * (x.ix1 / prev.ix1 - 1) * prev.priceT1inT0;
        if (V > 0) cum += g / V * 100;
      }
      lend.push(r6(cum));
    }
    prev = x;
  }
  const ev = (v.events || []).slice().sort((a, b) => a.ts - b.ts).map(e => [
    e.ts, e.action || KIND[e.kind] || "r", r6(e.netPct), r6(e.aeroPct != null ? e.aeroPct : null), r6(e.feePct != null ? e.feePct : null), r6(e.costPct),
    e.tickBefore != null ? e.tickBefore : null, e.tickAfter != null ? e.tickAfter : null,
    e.tickLo != null ? e.tickLo : null, e.tickHi != null ? e.tickHi : null,
    e.deployedAfter != null ? (e.deployedAfter ? 1 : 0) : (e.action === "exit" ? 0 : e.action === "enter" || e.action === "replace" ? 1 : null),
  ]);
  return {
    id: v.id, label: v.label || null, design: v.design, ppsUnit: v.ppsUnit || (parked ? "token0" : "L"),
    vault: v.vault, pool: v.pool, strat: v.strat, gauge: v.gauge, platform: v.platform, pair: v.pair,
    sym0: v.sym0 || names.sym0, sym1: v.sym1 || names.sym1, d0, d1, spacing: v.spacing || null, widthTicks: widthTicks || null,
    widthPct: v.widthPct != null ? v.widthPct : (widthTicks ? (Math.pow(1.0001, widthTicks) - 1) * 100 : null),
    tvlUsd: v.tvlUsd, birthTs: v.birthTs || null, startTs: v.startTs || null, legacy, stale: !!v._stale,
    gridFilled: v.gridFilled != null ? v.gridFilled : null, gridTotal: v.gridTotal != null ? v.gridTotal : null,
    tip: !!(s.length && s[s.length - 1].tip),
    t, tick, lo, hi, pps, v0, ub: ubOk ? ub : null, lend: parked ? lend : null, dep: parked ? dep : null, ev,
  };
}

function buildView(data) {
  const grid = data.gridSeconds || 3600;
  const vaults = (data.vaults || []).map(v => vaultView(v, grid));
  return {
    schema: data._schema, generatedAtBlock: data.generatedAtBlock, generatedAtTs: data.generatedAtTs, gridSeconds: grid,
    progress: data.progress || null, legacy: data._schema !== 3, vaults,
  };
}

// full-life figures per vault, for the API
function summaries(view) {
  const out = {};
  for (const vv of view.vaults) {
    const a = M.decode(vv);
    if (!a.t.length) continue;
    const w = M.windowStats(a, a.t[0], a.t[a.t.length - 1], view.gridSeconds);
    if (w) out[vv.id] = w;
  }
  return out;
}

module.exports = { buildView, summaries, vaultView };

// Figures for one vault over a time window, shared by the page and the server (the API's `summary`).
//
// A vault here is the compact form /api/view sends, decoded: arrays over its samples (t, tick, lo, hi,
// pps, v0, and for some designs ub, lend, dep) plus its events. v0 is the value of one share in token0
// (position + idle + lent, at the pool price), the basis of every comparison with holding:
//   vs holding 50/50   v0 against holding half the value in each token, bought at the window's start
//   marked             v0 against a 50/50 mix kept at 50/50 (the geometric mean of the two tokens). For a
//                      vault whose share price is in liquidity units this is that share price with the
//                      current range's not-yet-booked loss added, as if it re-centred now.
//   booked             the vault's own share price (liquidity units; for the parked vault, token0)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CLMetrics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DAY = 86400;

  function decode(v) {
    const t = new Array(v.t.length);
    let acc = 0;
    for (let i = 0; i < v.t.length; i++) { acc += v.t[i]; t[i] = acc; }
    const ev = (v.ev || []).map(r => ({ ts: r[0], kind: r[1], net: r[2], aero: r[3], fee: r[4], cost: r[5], tb: r[6], ta: r[7], lo: r[8], hi: r[9], dep: r[10] }));
    return Object.assign({}, v, { t, ev });
  }

  const price = (a, i) => Math.pow(10, a.d1 - a.d0) / Math.pow(1.0001, a.tick[i]);
  const priceAtTick = (a, tick) => Math.pow(10, a.d1 - a.d0) / Math.pow(1.0001, tick);
  function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }

  // first and last usable sample inside [t0, t1]
  function span(a, t0, t1) {
    const n = a.t.length;
    let i0 = lowerBound(a.t, t0); while (i0 < n && !(a.v0[i0] > 0)) i0++;
    let i1 = upperBound(a.t, t1) - 1; while (i1 >= 0 && !(a.v0[i1] > 0)) i1--;
    return i0 < n && i1 >= i0 ? [i0, i1] : null;
  }

  // Daily volatility of the pool price from non-overlapping 4-hour log moves between grid samples.
  function dailyVol(a, t0, t1, stepSec) {
    const H4 = 4 * 3600, tol = Math.max(90, (stepSec || 3600) / 10);
    const sp = span(a, t0, t1); if (!sp) return null;
    const r = [];
    let i = sp[0], j = sp[0];
    while (i <= sp[1]) {
      const target = a.t[i] + H4;
      while (j <= sp[1] && a.t[j] < target - tol) j++;
      if (j > sp[1]) break;
      if (Math.abs(a.t[j] - target) <= tol && !a.isTip(j)) { r.push(Math.log(price(a, j) / price(a, i))); i = j; }
      else { i = j; }                       // a gap: restart the 4-hour step from the next sample
    }
    if (r.length < 6) return null;
    const mean = r.reduce((s, x) => s + x, 0) / r.length;
    const v = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
    return { pct: Math.sqrt(v * 6) * 100, n: r.length };
  }

  // share of [tA, tB] the parked vault held a position, from its samples and its enter/exit events
  function inPoolShare(a, i0, i1) {
    if (!a.dep) return null;
    const tA = a.t[i0], tB = a.t[i1];
    if (!(tB > tA)) return a.dep[i1] ? 100 : 0;
    const pts = [];
    for (let i = i0; i <= i1; i++) pts.push([a.t[i], !!a.dep[i]]);
    for (const e of a.ev) if (e.dep != null && e.ts > tA && e.ts <= tB) pts.push([e.ts, !!e.dep]);
    pts.sort((x, y) => x[0] - y[0]);
    let inT = 0;
    for (let k = 0; k < pts.length - 1; k++) if (pts[k][1]) inT += pts[k + 1][0] - pts[k][0];
    return inT / (tB - tA) * 100;
  }

  function windowStats(a, t0, t1, stepSec) {
    const sp = span(a, t0, t1); if (!sp) return null;
    const [i0, i1] = sp;
    const tA = a.t[i0], tB = a.t[i1], days = Math.max((tB - tA) / DAY, 1 / 24);
    const pA = price(a, i0), pB = price(a, i1), L = a.v0[i1] / a.v0[i0], r = pB / pA;
    const o = { tA, tB, days };
    o.vsHold = (L / (0.5 + 0.5 * r) - 1) * 100;
    o.marked = (L / Math.sqrt(r) - 1) * 100;
    o.booked = a.ppsUnit === "L" && a.pps[i0] > 0 ? (a.pps[i1] / a.pps[i0] - 1) * 100 : null;
    o.sharePrice = a.pps[i0] > 0 ? (a.pps[i1] / a.pps[i0] - 1) * 100 : null;
    o.inToken0 = (L - 1) * 100; o.inToken1 = (L / r - 1) * 100;
    o.priceMove = (r - 1) * 100;
    o.notBooked = a.ub && a.ub[i1] != null ? a.ub[i1] : null;
    let aero = 0, fee = 0, costReb = 0, costHarv = 0, net = 0, nReb = 0, nHarv = 0, nEnter = 0, nExit = 0, nReplace = 0, split = true;
    // events after the first sample; when the view starts with the vault, also those of its first hour
    const evFrom = t0 <= a.t[0] ? -Infinity : tA;
    for (const e of a.ev) {
      if (e.ts <= evFrom || e.ts > tB) continue;
      net += e.net || 0;
      if (e.aero == null && e.net) split = false;
      aero += e.aero || 0; fee += e.fee || 0;
      if (e.kind === "h") { nHarv++; costHarv += e.cost || 0; }
      else { costReb += e.cost || 0; if (e.kind === "enter") nEnter++; else if (e.kind === "exit") nExit++; else if (e.kind === "replace") nReplace++; else nReb++; }
    }
    o.lending = a.lend ? a.lend[i1] - a.lend[i0] : null;
    Object.assign(o, { aero, fee, costReb, costHarv, net: net + (o.lending || 0), nReb, nHarv, nEnter, nExit, nReplace, split });
    let dep = 0, inR = 0;
    for (let i = i0; i <= i1; i++) {
      if (a.lo[i] === a.hi[i]) continue;
      dep++; if (a.tick[i] >= a.lo[i] && a.tick[i] < a.hi[i]) inR++;
    }
    o.inRange = dep ? inR / dep * 100 : null;
    o.inPool = inPoolShare(a, i0, i1);
    o.samples = i1 - i0 + 1;
    const vol = dailyVol(a, tA, tB, stepSec);
    o.volDaily = vol ? vol.pct : null;
    const yr = x => (x == null ? null : x * 365 / days);
    o.apr = { vsHold: yr(o.vsHold), marked: yr(o.marked), booked: yr(o.booked), aero: yr(aero), fee: yr(fee), lending: yr(o.lending), costReb: yr(costReb), net: yr(o.net) };
    return o;
  }

  function attachHelpers(a) {
    const n = a.t.length;
    a.isTip = i => !!a.tip && i === n - 1;
    return a;
  }

  return { decode: v => attachHelpers(decode(v)), attachHelpers, windowStats, dailyVol, price, priceAtTick, lowerBound, upperBound, span };
});

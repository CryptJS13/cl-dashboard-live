// JSON-RPC client for the collector: several endpoints in turn, a cap on requests in flight, retries
// with backoff on rate limits and flaky nodes, Multicall3 batching, and log scans that split their
// block range when an endpoint refuses a wide one. Uses ethers v5 only for ABI coding.
const { utils } = require("ethers");

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"; // same address on every chain; on Base since block 5,022
const MC = new utils.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
  "function getCurrentBlockTimestamp() view returns (uint256)",
]);

const sleep = ms => new Promise(res => setTimeout(res, ms));

// Transient failures worth another try: HTTP 429/5xx, network errors, JSON-RPC rate-limit codes, and the
// errors public nodes give when a request lands on a node that is behind or pruned for a moment.
function isTransient(err) {
  const s = String((err && err.message) || err || "");
  return /429|rate.?limit|limit exceeded|too many|capacity|-3200[456]|-32603|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket|header not found|unknown block|missing trie node|pruned|internal error|bad gateway|service unavailable|http 5\d\d|http 403|unexpected token|invalid json/i.test(s);
}
// A log query refused because of its size (block range or result count), as different nodes word it.
function isRangeError(err) {
  const s = String((err && err.message) || err || "");
  return /range|too many|exceed|limit|10000|10,000|max.*block|block.*max|response size|query returned more/i.test(s);
}

// urls: one URL or several (comma-separated string or array); calls go to them in turn.
function makeRpc(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : String(urls).split(",")).map(u => u.trim()).filter(Boolean);
  if (!list.length) throw new Error("no RPC URL");
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 10;   // about a minute and a half of backing off
  const maxInFlight = Math.max(1, opts.inFlight || 8);
  const counter = opts.counter || { n: 0 };
  const timeoutMs = opts.timeoutMs || 30000;
  let turn = 0, inFlight = 0;
  const waiting = [];
  const acquire = () => inFlight < maxInFlight ? (inFlight++, Promise.resolve()) : new Promise(res => waiting.push(res));
  const release = () => { const next = waiting.shift(); if (next) next(); else inFlight--; };

  async function once(url, method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429 || r.status >= 500 || r.status === 403) throw new Error(`http ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("timeout");
      throw e;
    } finally { clearTimeout(timer); }
  }

  // endpoints that do not offer a method are skipped for it; an endpoint that refused a log query as too
  // wide is skipped for log queries at least that wide (public nodes allow 10 to 10,000 blocks)
  const unsupported = {}, refusedSpan = {};
  const spanOf = (method, params) => method === "eth_getLogs" && params[0] ? parseInt(params[0].toBlock, 16) - parseInt(params[0].fromBlock, 16) : 0;
  const usable = (url, method, span) => !(unsupported[method] && unsupported[method].has(url)) && !(method === "eth_getLogs" && refusedSpan[url] != null && span >= refusedSpan[url]);
  const pick = (method, span) => {
    for (let i = 0; i < list.length; i++) { const u = list[turn++ % list.length]; if (usable(u, method, span)) return u; }
    return null;
  };
  // o.retries: fewer retries for a call the caller can recover from another way (a wide log scan splits)
  const rpc = async (method, params = [], o = {}) => {
    const retries = o.retries != null ? o.retries : maxRetries;
    await acquire();
    try {
      const span = spanOf(method, params);
      for (let attempt = 0; ; attempt++) {
        const url = pick(method, span);
        if (!url) throw new Error(method === "eth_getLogs" ? `eth_getLogs: block range ${span} too large for every endpoint` : `${method}: not offered by any endpoint`);
        counter.n++;
        try { return await once(url, method, params); }
        catch (e) {
          const msg = String(e.message || e);
          const tooWide = method === "eth_getLogs" && isRangeError(e) && !/429|rate|request limit/i.test(msg);
          const notOffered = !tooWide && /not supported|method not found|-32601|not available|disabled/i.test(msg);
          if (notOffered) { (unsupported[method] = unsupported[method] || new Set()).add(url); if (list.length > 1) continue; }
          if (tooWide) { refusedSpan[url] = Math.min(refusedSpan[url] != null ? refusedSpan[url] : Infinity, span); if (list.length > 1) continue; throw e; }
          if (attempt >= retries || !isTransient(e)) { e.message = `${method}: ${msg}`; throw e; }
          const backoff = Math.min(8000, 250 * 2 ** attempt) + Math.floor(Math.random() * 250);
          await sleep(list.length > 1 && attempt === 0 ? 50 : backoff);
        }
      }
    } finally { release(); }
  };
  rpc.counter = counter;
  rpc.urls = list;
  return rpc;
}

const hexBlock = b => (typeof b === "string" ? b : "0x" + b.toString(16));

// calls: [{ to, data }]; returns [{ ok, data }] in the same order, plus the block's timestamp.
// One eth_call for all of them. A call that reverts (or a target with no code) gives ok=false.
async function multicall(rpc, calls, block) {
  const wrapped = [{ target: MULTICALL3, allowFailure: true, callData: MC.encodeFunctionData("getCurrentBlockTimestamp") },
    ...calls.map(c => ({ target: c.to, allowFailure: true, callData: c.data }))];
  const raw = await rpc("eth_call", [{ to: MULTICALL3, data: MC.encodeFunctionData("aggregate3", [wrapped]) }, hexBlock(block)]);
  if (!raw || raw === "0x") throw new Error("multicall returned nothing at block " + block);
  const [res] = MC.decodeFunctionResult("aggregate3", raw);
  const ts = res[0].success ? Number(BigInt(res[0].returnData)) : null;
  return { ts, results: res.slice(1).map(r => ({ ok: r.success && r.returnData && r.returnData !== "0x", data: r.returnData })) };
}

// eth_getLogs over [from, to]. A range a node refuses as too large is halved; so is any range over WIDE
// blocks that still fails after a couple of tries (some nodes answer a heavy query with a rate limit, and
// a narrower range may suit other endpoints). Only narrow ranges get the full series of retries.
const WIDE = 1000;
async function getLogs(rpc, filter, from, to, minSpan = 500) {
  if (from > to) return [];
  const wide = to - from > WIDE;
  try {
    return await rpc("eth_getLogs", [{ ...filter, fromBlock: hexBlock(from), toBlock: hexBlock(to) }], wide ? { retries: 2 } : {});
  } catch (e) {
    if (to - from < minSpan || !(isRangeError(e) || wide)) throw e;
    const mid = from + Math.floor((to - from) / 2);
    const a = await getLogs(rpc, filter, from, mid, minSpan);
    const b = await getLogs(rpc, filter, mid + 1, to, minSpan);
    return a.concat(b);
  }
}

module.exports = { makeRpc, multicall, getLogs, isTransient, MULTICALL3 };

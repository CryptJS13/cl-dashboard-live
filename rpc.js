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
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 7;
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

  // endpoints that refused a method (not offered, or a log range too wide for them): later calls of that
  // method go to the others
  const refused = {};
  const pick = method => {
    const bad = refused[method];
    if (bad && bad.size && bad.size < list.length) {
      for (let i = 0; i < list.length; i++) { const u = list[turn++ % list.length]; if (!bad.has(u)) return u; }
    }
    return list[turn++ % list.length];
  };
  const rpc = async (method, params = []) => {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        counter.n++;
        const url = pick(method);
        try { return await once(url, method, params); }
        catch (e) {
          const msg = String(e.message || e);
          const unsupported = /not supported|method not found|-32601|not available|not allowed|disabled/i.test(msg);
          const tooWide = method === "eth_getLogs" && isRangeError(e) && !/429|rate/i.test(msg);
          if (list.length > 1 && (unsupported || tooWide)) {
            (refused[method] = refused[method] || new Set()).add(url);
            // when every endpoint has refused, the caller decides (a log scan then splits its range)
            if (refused[method].size >= list.length || attempt >= maxRetries) throw e;
            continue;
          }
          if (tooWide) throw e;
          if (attempt >= maxRetries || !isTransient(e)) throw e;
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

// eth_getLogs over [from, to], halving the range whenever a node refuses it as too large.
async function getLogs(rpc, filter, from, to, minSpan = 500) {
  if (from > to) return [];
  try {
    return await rpc("eth_getLogs", [{ ...filter, fromBlock: hexBlock(from), toBlock: hexBlock(to) }]);
  } catch (e) {
    if (to - from < minSpan || !isRangeError(e)) throw e;
    const mid = from + Math.floor((to - from) / 2);
    const a = await getLogs(rpc, filter, from, mid, minSpan);
    const b = await getLogs(rpc, filter, mid + 1, to, minSpan);
    return a.concat(b);
  }
}

module.exports = { makeRpc, multicall, getLogs, isTransient, MULTICALL3 };

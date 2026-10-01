"use strict";
// Drives /analyze-stream end to end with the stub scraper, a fake news search and a fake
// model. Proves the dashboard ships before the search resolves, that `news` precedes the
// AI stream, that the model's prompt carries the digest, and that the cache keeps it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const ROOT = path.resolve(__dirname, "../..");
const serverPath = path.join(ROOT, "server.js");
const realRequire = createRequire(serverPath);

const DIGEST = {
  ok: true, model: "news-model", today: "2026-09-23", searchedAt: "2026-09-23T00:00:00Z", ms: 40, citations: 1,
  digest: { overview: "Q3 beat dominates.", upcoming: [], dropped: { ungrounded: 0, stale: 0, invalid: 0, duplicate: 0 },
    items: [{ date: "2026-09-18", source: "Reuters", url: "https://reuters.com/a", headline: "Acme beats Q3",
      event: "earnings", impact: "high", direction: "positive", summary: "Revenue up." }] }
};

function boot({ apiKey, researchResult = DIGEST }) {
  let handler; const aiBodies = [];
  const newsMod = { ...realRequire("./news-research"),
    researchNews: () => new Promise(r => setTimeout(() => r(researchResult), 40)) };
  const sandbox = {
    require: name => name === "http" ? { createServer(fn) { handler = fn; return {}; } }
      : name === "./news-research" ? newsMod : realRequire(name),
    module: { exports: {} }, __dirname: ROOT,
    process: { ...process, env: { ...process.env, OPENROUTER_API_KEY: apiKey, SQUALL_NEWS_SEARCH: "",
      PYTHON_BIN: process.execPath, SQUALL_SCRAPER_PATH: path.join(ROOT, "tests/stubs/scraper_stub.js"),
      SQUALL_STATE_PATH: path.join(os.tmpdir(), "squall-news-stream-test.json") } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, TextDecoder, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (_url, init) => {
      aiBodies.push(String(init && init.body));
      return { ok: true, body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"Done."}}]}\n\n');
        yield Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      })() };
    }
  };
  vm.runInNewContext(fs.readFileSync(serverPath, "utf8"), sandbox, { filename: serverPath });
  return { handler, aiBodies };
}

async function drive(handler, route) {
  let output = "", finish;
  const ended = new Promise(r => { finish = r; });
  const req = Object.assign(new EventEmitter(), { method: "GET", url: route,
    headers: { host: "localhost" }, socket: { remoteAddress: "127.0.0.1" } });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
    writeHead() {}, setHeader() {}, write(t) { output += t; return true; },
    end(t = "") { output += t; this.writableEnded = true; finish(); } });
  await handler(req, res);
  let timer;
  try { await Promise.race([ended, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("stream did not finish")), 10000); })]); }
  finally { clearTimeout(timer); }
  return output.split("\n\n").filter(Boolean).map(block => {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return { name, data: data ? JSON.parse(data) : null };
  }).filter(e => e.name);
}

(async () => {
  {
    const { handler, aiBodies } = boot({ apiKey: "test-key" });
    const ev = await drive(handler, "/analyze-stream?ticker=AAA");
    const names = ev.map(e => e.name);
    const iResult = names.indexOf("result"), iNews = names.indexOf("news");
    const iAi = names.findIndex(n => n.startsWith("ai_"));
    assert.ok(iResult >= 0 && iNews > iResult && iAi > iNews, `order was ${names.join(",")}`);
    const result = ev[iResult].data, news = ev[iNews].data;
    assert.equal(result.news_pending, true);
    assert.equal(result.news_digest, undefined, "the digest must not ride on result");
    assert.equal(news.news_digest.overview, "Q3 beat dominates.");
    assert.equal(news.company_news[0].headline, "Acme beats Q3");
    assert.match(news.ai_prompt, /Acme beats Q3/);
    assert.equal(news.news_search.status, "ok");
    assert.ok(aiBodies.some(b => /Acme beats Q3/.test(b)), "the analysis prompt must carry the digest");
    console.log("ok - result ships before the news search; news precedes the AI stream");

    const again = await drive(handler, "/analyze-stream?ticker=AAA");
    const hit = again.find(e => e.name === "result").data;
    assert.equal(hit.cached, true);
    assert.equal(hit.news_pending, undefined);
    assert.equal(hit.news_digest.overview, "Q3 beat dominates.");
    assert.ok(!again.some(e => e.name === "news"), "a cache hit sends no news event");
    console.log("ok - the cache keeps the digest-applied payload");
  }
  {
    const { handler } = boot({ apiKey: "" });   // no key = news search off
    const ev = await drive(handler, "/analyze-stream?ticker=BBB");
    const result = ev.find(e => e.name === "result").data;
    assert.equal(result.news_pending, undefined);
    assert.equal(result.news_search.status, "off");
    assert.ok(!ev.some(e => e.name === "news"));
    console.log("ok - with news search off, result is unchanged and no news event is sent");
  }
  {
    const { handler } = boot({ apiKey: "test-key", researchResult: { ok: false, error: "boom", ms: 5 } });
    const ev = await drive(handler, "/analyze-stream?ticker=CCC");
    const names = ev.map(e => e.name);
    const iNews = names.indexOf("news");
    const iAi = names.findIndex(n => n.startsWith("ai_"));
    assert.ok(iNews >= 0 && iAi > iNews, `news must precede the AI stream, order was ${names.join(",")}`);
    const news = ev[iNews].data;
    assert.equal(news.news_digest, null);
    assert.equal(news.news_search.status, "fallback");
    assert.equal(news.company_news[0].source, "Stub Wire");
    console.log("ok - a failed search falls back to Finnhub's records and still precedes the AI stream");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

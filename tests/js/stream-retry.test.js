"use strict";
// Exercise the actual request handlers with offline engines and a failing provider.
// No listening socket, API key, or provider request is needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const ROOT = path.resolve(__dirname, "../..");
const serverPath = path.join(ROOT, "server.js");
const realRequire = createRequire(serverPath);

async function exercise(route, failAfterToken) {
  let handler, attempts = 0, output = "";
  const scopedRequire = name => name === "http" ? {
    createServer(fn) { handler = fn; return {}; }
  } : realRequire(name);
  const sandbox = {
    require: scopedRequire, module: { exports: {} }, __dirname: ROOT,
    process: { ...process, env: { ...process.env, OPENROUTER_API_KEY: "", PYTHON_BIN: process.execPath,
      SQUALL_SCRAPER_PATH: path.join(ROOT, "tests/stubs/scraper_stub.js"),
      SQUALL_BACKTESTER_PATH: path.join(ROOT, "tests/stubs/backtester_stub.js") } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, TextDecoder, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => {
      const attempt = ++attempts;
      return { ok: true, body: (async function* () {
        if (attempt === 1 && !failAfterToken) throw new Error("socket terminated");
        yield Buffer.from('data: {"choices":[{"delta":{"content":"A spaced sentence."}}]}\n\n');
        if (attempt === 1 && failAfterToken) throw new Error("socket terminated");
        yield Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      })() };
    }
  };
  vm.runInNewContext(fs.readFileSync(serverPath, "utf8"), sandbox, { filename: serverPath });
  const req = Object.assign(new EventEmitter(), {
    method: "GET", url: route, headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" }
  });
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, writeHead() {}, setHeader() {},
    write(text) { output += text; return true; },
    end(text = "") { output += text; this.writableEnded = true; finish(); }
  });
  await handler(req, res);
  let timer;
  try {
    await Promise.race([ended, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Stream did not finish")), 10000);
    })]);
  } finally { clearTimeout(timer); }
  const historical = route.startsWith("/backtest");
  const prefix = historical ? "backtest_" : "";
  const tokens = output.match(new RegExp(`event: ${prefix}ai_delta\\n`, "g")) || [];
  assert.equal(tokens.length, 1, "The browser must receive exactly one copy of the answer");
  assert.equal(attempts, failAfterToken ? 1 : 2,
    "Retry is permitted only when no response text has reached the browser");
  assert.match(output, new RegExp(`event: ${prefix}ai_${failAfterToken ? "error" : "done"}\\n`));
  assert.match(output, /A spaced sentence\./, "Streaming must preserve spaces");
}

(async () => {
  for (const route of ["/analyze-stream?ticker=AAA", "/backtest-stream?ticker=AAA&as_of=2023-03-15"]) {
    for (const after of [true, false]) {
      await exercise(route, after);
      console.log(`ok - ${route.split("?")[0]} retries only before the first token (${after ? "partial" : "empty"} failure)`);
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

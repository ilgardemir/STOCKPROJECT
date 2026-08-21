"use strict";
// Executes each page's scripts against that page's REAL id set. A bare
// getElementById(x).foo on an id the page lacks throws, and every listener below
// it silently never wires up — the exact failure CLAUDE.md warns about, which
// grepping cannot detect because it depends on the page's markup.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");

function assemble(page) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  return html.replace(/<!--#include\s+([\w-]+)\s*-->/g, (_, name) =>
    fs.readFileSync(path.join(ROOT, "partials", name + ".html"), "utf8"));
}

function idsOf(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
  return ids;
}

function makeEl(id) {
  return {
    id, value: "", textContent: "", innerHTML: "", checked: false, disabled: false,
    max: "", min: "", tagName: "DIV", offsetWidth: 800, offsetHeight: 600, scrollTop: 0,
    scrollHeight: 0, clientWidth: 800, clientHeight: 600, children: [], dataset: {},
    style: new Proxy({}, { get: () => "", set: () => true }),
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, removeEventListener(){}, appendChild(){}, removeChild(){},
    insertBefore(){}, replaceChild(){}, contains: () => false, dispatchEvent: () => true,
    setAttribute(){}, getAttribute: () => null, removeAttribute(){}, focus(){}, blur(){},
    click(){}, closest: () => null, scrollIntoView(){}, insertAdjacentHTML(){}, remove(){},
    getBoundingClientRect: () => ({ top:0, left:0, width:800, height:600, bottom:600, right:800 }),
    querySelector: () => makeEl("q"), querySelectorAll: () => [],
    getContext: () => new Proxy({}, { get: () => () => ({}) }),
    parentNode: null, parentElement: null, firstChild: null
  };
}

function run(page, scripts) {
  const html = assemble(page);
  const ids = idsOf(html);
  const bodyPage = (html.match(/<body[^>]*data-page\s*=\s*["']([^"']+)["']/) || [])[1] || "analyzer";
  const cache = new Map();
  const noopEl = { dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    style: { setProperty(){}, getPropertyValue: () => "" }, appendChild(){}, addEventListener(){} };
  const doc = {
    body: { ...noopEl, dataset: { page: bodyPage } },
    documentElement: { ...noopEl },
    getElementById(id) {
      if (!ids.has(id)) return null;
      if (!cache.has(id)) cache.set(id, makeEl(id));
      return cache.get(id);
    },
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => makeEl("created"), createTextNode: () => ({}),
    addEventListener(){}, removeEventListener(){}, dispatchEvent: () => true,
    startViewTransition: null, readyState: "complete", hidden: false,
    visibilityState: "visible", head: { appendChild(){} }
  };
  const storage = {
    _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
    clear() { this._d = {}; }, key: () => null, get length() { return Object.keys(this._d).length; }
  };
  const sandbox = {
    document: doc, localStorage: storage, sessionStorage: storage,
    location: { href: "http://localhost/" + page, search: "", pathname: "/", hash: "",
      assign(){}, replace(){} },
    history: { replaceState(){}, pushState(){} },
    navigator: { userAgent: "node", maxTouchPoints: 0, clipboard: { writeText: () => Promise.resolve() } },
    console: { log(){}, warn(){}, error(){}, info(){} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 1, cancelAnimationFrame(){},
    matchMedia: () => ({ matches: false, addEventListener(){}, addListener(){} }),
    getComputedStyle: () => ({ getPropertyValue: () => "#000", fontSize: "13px", display: "block" }),
    EventSource: function () { return { addEventListener(){}, close(){}, onerror: null }; },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    CustomEvent: function(){}, Event: function(){}, URL, URLSearchParams,
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900, scrollY: 0,
    ResizeObserver: function () { return { observe(){}, disconnect(){}, unobserve(){} }; },
    MutationObserver: function () { return { observe(){}, disconnect(){} }; },
    IntersectionObserver: function () { return { observe(){}, disconnect(){}, unobserve(){} }; },
    alert(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){},
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const s of scripts) {
    let code = fs.readFileSync(path.join(ROOT, s), "utf8");
    // Self-validation: prove the harness catches the shape it exists to find.
    if (process.env.PAGECHECK_POISON && s === "app.js")
      code += '\ndocument.getElementById("definitelyNotOnAnyPage").addEventListener("click", () => {});\n';
    try {
      vm.runInContext(code, sandbox, { filename: s });
    } catch (e) {
      return { page, script: s, error: e.message, stack: (e.stack || "").split("\n").slice(0, 3).join("\n") };
    }
  }
  return { page, ok: true, ids: ids.size };
}

const JOBS = [
  ["index.html", ["sp500.js", "market-universes.js", "app.js"]],
  ["screener.html", ["sp500.js", "market-universes.js", "app.js"]],
  ["ilgar.html", ["sp500.js", "market-universes.js", "app.js", "backtester.js"]]
];

let failed = 0;
for (const [page, scripts] of JOBS) {
  const r = run(page, scripts);
  if (r.ok) console.log(`ok - ${page} (${r.ids} ids) executed clean`);
  else {
    failed += 1;
    console.error(`not ok - ${r.page} threw in ${r.script}\n  ${r.error}\n${r.stack}`);
  }
}
console.log(`\n${JOBS.length - failed}/${JOBS.length} pages executed clean`);
if (failed) process.exitCode = 1;

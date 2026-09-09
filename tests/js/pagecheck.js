"use strict";
// Executes each page's scripts against that page's REAL id set. A bare
// getElementById(x).foo on an id the page lacks throws, and every listener below
// it silently never wires up — the exact failure CLAUDE.md warns about, which
// grepping cannot detect because it depends on the page's markup.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");

// Must stay byte-identical to INCLUDE_RE in server.js. A looser pattern here
// expands includes the server would ship to the browser as a literal comment,
// so the harness would check a page that is never served — a superset id set,
// which fails open.
const INCLUDE_RE = /^[ \t]*<!--#include\s+([a-z0-9-]+)\s*-->[ \t]*$/gm;

function assemble(page) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  return html.replace(INCLUDE_RE, (_, name) =>
    fs.readFileSync(path.join(ROOT, "partials", name + ".html"), "utf8"));
}

function idsOf(html) {
  // Comments and inline script bodies are stripped first: a commented-out block
  // leaves its ids in the source but not in the DOM, and `const id = "x"` inside
  // an inline script is not an element. Either would invent an id the browser
  // does not have, and an id set that is too large fails open.
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const ids = new Set();
  // Leading whitespace, not \b: \b matches after the hyphen in data-id="…",
  // which is an attribute on an element whose own id may be absent.
  for (const m of markup.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
  return ids;
}

/* The page's own executable scripts, in document order. Derived rather than listed: a
   hardcoded list silently stops covering a script the moment someone adds one to a page,
   which is exactly the regression this harness exists to prevent.

   Inline blocks count as scripts. They used to be skipped because every page's logic lived
   in app.js, but 404.html is deliberately standalone — its whole behavior (the theme
   restore that runs before first paint, the path readout, the search hand-off) is inline,
   and an uncovered inline block is the same silent failure as an uncovered file: the first
   throw kills every listener below it and the page still renders, looking fine. Only
   same-origin relative sources are loadable; a cross-origin <script src> is left out. */
function unitsOf(html) {
  const units = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = (m[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (src) {
      if (/^(?:https?:)?\/\//.test(src)) continue;
      const file = src.replace(/^\.?\//, "").split("?")[0];
      units.push({ name: file, code: () => fs.readFileSync(path.join(ROOT, file), "utf8") });
    } else if (m[2].trim()) {
      const body = m[2];
      units.push({ name: `inline#${units.length + 1}`, code: () => body });
    }
  }
  return units;
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
    setAttribute(){}, getAttribute: () => null, removeAttribute(){},
    toggleAttribute(){ return false; }, hasAttribute: () => false, focus(){}, blur(){},
    click(){}, closest: () => null, scrollIntoView(){}, insertAdjacentHTML(){}, remove(){},
    getBoundingClientRect: () => ({ top:0, left:0, width:800, height:600, bottom:600, right:800 }),
    querySelector: () => makeEl("q"), querySelectorAll: () => [],
    getContext: () => new Proxy({}, { get: () => () => ({}) }),
    parentNode: null, parentElement: null, firstChild: null
  };
}

/*
 * An EMPTY localStorage is not the interesting case, and running only that hid a real
 * load-time crash: app.js calls applyTheme() at load, applyTheme repaints the chart, and
 * drawChart returns immediately when there is no active session. With a clean store every
 * line past that guard is dead code here, so a `const` referenced inside drawChart but
 * declared further down the file — a temporal dead zone that throws in any browser holding
 * a saved tab — sailed through as a clean pass.
 *
 * So the store is seeded with a saved analysis. This is the returning-visitor path, which
 * is most visitors, and it is the one where the load-time render actually executes.
 * Deliberately shaped like a PRE-timeframe session: `range` is the old numeric bar count,
 * so the legacy migration is exercised on every run rather than only when someone thinks
 * to test an upgrade.
 */
const SEEDED_STORAGE = {
  "squall-saved-analyses-v1": JSON.stringify({
    AAA: {
      data: {
        ticker: "AAA", company_name: "Pagecheck Industries", aiSummary: "## Verdict\n**Hold** — flat.\n\n## A\nx\n\n## B\ny",
        raw_data: { technicals: { current_price: 10 }, key_levels: { resistance: [11], support: [9] } },
        live_quote: { last_price: 10 },
        price_history: Array.from({ length: 300 }, (_, i) => ({
          date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
          open: 10 + i * 0.01, high: 10.5 + i * 0.01, low: 9.5 + i * 0.01, close: 10.2 + i * 0.01, volume: 1000 + i
        })),
        intraday_history: {
          "5m": Array.from({ length: 78 }, (_, i) => ({
            date: `2024-05-01 ${String(9 + Math.floor(i / 12)).padStart(2, "0")}:${String((i * 5) % 60).padStart(2, "0")}`,
            open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 500
          }))
        }
      },
      history: [], range: 252, createdAt: 1, updatedAt: 2
    },
    /*
     * A SECOND tab, and a used one. One near-empty session is not the returning-visitor
     * path, it is the first-run path with a row in it — and the difference is load-bearing,
     * because a real store reaches code the minimal one never does: a non-empty chat
     * `history`, a compare ticker resolving to a real session (effectiveCompare returns a
     * pane instead of null, so the compare half of drawChart executes at all), and a
     * MySquall profile so the profile-shaped branches are not uniformly skipped.
     *
     * This exists because /ilgar broke in exactly one browser and the difference turned out
     * not to be the browser: it was that profile's localStorage, accumulated over real use,
     * against test stores that were nearly empty. A seed the shape of a first visit cannot
     * find a fault that needs a second one.
     */
    BBB: {
      data: {
        ticker: "BBB", company_name: "Second Tab Corp", aiSummary: "## Verdict\n**Buy** — momentum.",
        raw_data: { technicals: { current_price: 42 }, key_levels: { resistance: [], support: [] } },
        live_quote: { last_price: 42 },
        price_history: Array.from({ length: 420 }, (_, i) => ({
          date: `2023-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
          open: 40 + i * 0.02, high: 41 + i * 0.02, low: 39 + i * 0.02, close: 40.5 + i * 0.02, volume: 9000 + i
        }))
        // No intraday_history at all — the fund/thin-name payload, where the tiers must
        // disappear rather than resolve to an empty series.
      },
      history: [
        { role: "user", content: "Why is the RSI that low?" },
        { role: "assistant", content: "Because the 14-day window is dominated by the March drawdown.", reasoning: "checking rsi window" },
        { role: "user", content: "And the volume?" }
      ],
      range: "1W", profile: { risk: 4, horizon: 2, experience: 3, depth: 4, style: "swing", priorities: ["momentum"], custom: "" },
      profileKey: "seeded", fibAnchors: { a: 12, b: 200 }, createdAt: 3, updatedAt: 9
    }
  }),
  "squall-saved-screeners-v1": JSON.stringify({
    scr1: {
      id: "scr1", query: "cheap industrials with improving margins", title: "Saved screen",
      spec: { title: "Saved screen", concepts: [{ id: "momentum", weight: 1 }], filters: [], settings: {} },
      result: { results: [{ ticker: "CCC", name: "Third Co", score: 71, reasons: ["momentum"] }] },
      history: [{ role: "assistant", content: "This screen returned 1 match." }],
      createdAt: 4, updatedAt: 5
    }
  }),
  "squall-profile-v1": JSON.stringify({ risk: 4, horizon: 2, experience: 3, depth: 4,
    style: "swing", priorities: ["momentum", "valuation"], custom: "I trade breakouts" }),
  "squall-chart-compare-v1": "BBB",
  "squall-analysis-runs-v1": JSON.stringify([{ ticker: "AAA", at: Date.now() }]),
  "squall-data-section": "technicals",
  "squall-chat-h": "120",
  "squall-chat-think": "1",
  "squall-split": "0.55",
  "squall-theme": "dark"
};

function run(page, units, poisonId, dropIds) {
  const html = assemble(page);
  const ids = idsOf(html);
  // Simulates chrome that is absent at runtime even though the markup declares it: a
  // stale cached page against a fresh script, an include that did not expand, an element
  // removed by an extension. The distinction from poisonId is the point — poisonId proves
  // the harness can fail, dropIds proves the PAGE degrades instead of dying.
  for (const id of dropIds || []) ids.delete(id);
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
    _d: { ...SEEDED_STORAGE }, getItem(k) { return k in this._d ? this._d[k] : null; },
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

  const last = units[units.length - 1];
  for (const u of units) {
    let code = u.code();
    // Appended to the LAST script rather than to one matched by name, so that
    // renaming or splitting a script cannot turn the self-check into a no-op.
    if (poisonId && u === last)
      code += `\ndocument.getElementById(${JSON.stringify(poisonId)}).addEventListener("click", () => {});\n`;
    try {
      vm.runInContext(code, sandbox, { filename: `${page}:${u.name}` });
    } catch (e) {
      return { page, script: u.name, error: e.message, stack: (e.stack || "").split("\n").slice(0, 3).join("\n") };
    }
  }
  return { page, ok: true, ids: ids.size };
}

const PAGES = ["index.html", "screener.html", "ilgar.html", "404.html"];
const JOBS = PAGES.map(page => [page, unitsOf(assemble(page))]);
// Saved analyses can be removed from shared chrome on secondary pages too.
for (const page of ["index.html", "screener.html", "ilgar.html"]) {
  JOBS.push([page, [...unitsOf(assemble(page)), {
    name: "delete-saved-analysis",
    // Driven off whatever the seed actually contains rather than off hardcoded tickers:
    // the seed is meant to grow as new returning-visitor state turns out to matter, and a
    // unit that names its rows fails on the next row added rather than on a real defect.
    code: () => `
      sessions.OTHER = { ...sessions.AAA, data: { ...sessions.AAA.data, ticker: "OTHER" } };
      for (const t of Object.keys(sessions)) deleteSession(t);
      if (Object.keys(sessions).length) throw new Error("Saved analyses were not removed");
    `
  }]]);
}

/*
 * Proves the harness can still fail, on every run rather than on a human
 * remembering to set an env var. CLAUDE.md: "Validate the checker before
 * trusting it" — a checker validated once at authoring time and never again
 * drifts into passing on anything, and nothing announces when it does.
 *
 * Two assertions, because they fail for different reasons:
 *   1. An id on no page must throw. Catches a stub that stopped returning null.
 *   2. An id on exactly one page must throw on the others and NOT on its own.
 *      Catches a stub that returns null for everything — which would also
 *      satisfy (1) while proving nothing about page-specific markup.
 * The discriminating id is derived from the real pages, never hardcoded, so it
 * survives markup changes.
 */
function selfCheck() {
  const problems = [];
  const ABSENT = "__pagecheck_id_present_on_no_page__";
  const [homePage, homeScripts] = JOBS[0];
  const [otherPage, otherScripts] = JOBS[JOBS.length - 1];

  if (run(homePage, homeScripts, ABSENT).ok)
    problems.push(`poisoning ${homePage} with an absent id did not throw — the harness cannot fail`);

  const homeIds = idsOf(assemble(homePage));
  const otherIds = idsOf(assemble(otherPage));
  const only = [...homeIds].find(id => !otherIds.has(id));
  if (!only) problems.push(`no id distinguishes ${homePage} from ${otherPage}; cannot prove page-specificity`);
  else {
    if (!run(homePage, homeScripts, only).ok)
      problems.push(`id "${only}" is in ${homePage} but the harness threw on it — false failures are likely`);
    if (run(otherPage, otherScripts, only).ok)
      problems.push(`id "${only}" is absent from ${otherPage} but the harness passed — id sets are not page-specific`);
  }
  return problems;
}

const selfProblems = selfCheck();
for (const p of selfProblems) console.error(`not ok - self-check: ${p}`);
if (selfProblems.length) {
  console.error("\npagecheck self-validation FAILED — its clean results below mean nothing.");
  process.exitCode = 1;
} else {
  console.log("ok - self-check: harness fails on a missing id and is page-specific");
}

let failed = 0;
for (const [page, scripts] of JOBS) {
  const r = run(page, scripts);
  if (r.ok) console.log(`ok - ${page} (${r.ids} ids, ${scripts.length} scripts) executed clean`);
  else {
    failed += 1;
    console.error(`not ok - ${r.page} threw in ${r.script}\n  ${r.error}\n${r.stack}`);
  }
}

/*
 * Missing chrome must cost its own affordance, not the rest of the file.
 *
 * app.js is a classic script shared by three pages, so a throw at its top level does not
 * "break the theme picker" — it stops execution dead. Every function DECLARATION stays
 * hoisted and callable while every let/const below the throw is stranded in its temporal
 * dead zone, so the page still renders, `typeof fn === "function"` still answers true, and
 * the failure re-emerges somewhere unrelated as "Cannot access 'x' before initialization".
 * Two thirds of app.js sits below the theme block, including runAnalysis, the MySquall
 * profile and the hero wind field, which is exactly the set that went dead in the wild.
 *
 * The ids here are the shared header's, and the elements most plausibly absent at runtime
 * while the markup still declares them: a page cached from an older deploy against a fresh
 * app.js, an include that did not expand, an element an extension removed. The pages above
 * prove app.js runs when the DOM is perfect; this proves it survives when it is not.
 */
const FRAGILE_CHROME = ["themeBtn", "themeMenu", "profileBtn", "tickerBar", "ticker", "searchForm"];
for (const page of ["index.html", "screener.html", "ilgar.html"]) {
  const scripts = unitsOf(assemble(page));
  const r = run(page, scripts, undefined, FRAGILE_CHROME);
  if (r.ok) console.log(`ok - ${page} survives missing shared chrome (${FRAGILE_CHROME.length} ids removed)`);
  else {
    failed += 1;
    console.error(`not ok - ${r.page} died on missing chrome in ${r.script}\n  ${r.error}\n${r.stack}`);
  }
}

const total = JOBS.length + 3;
console.log(`\n${total - failed}/${total} pages executed clean`);
if (failed) process.exitCode = 1;

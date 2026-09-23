"use strict";

/* ════════════════ PAGE ════════════════
   The analyzer (/) and the screener (/screener) are separate pages that load this one
   script. Everything shared — theme, MySquall, saved tabs, storage — runs on both; the rest
   addresses elements that exist on only one. PAGE is the switch for behavior, `on` is the
   guard for wiring. Top-level `document.getElementById(x).addEventListener(...)` is what
   breaks the other page: one null and the whole script dies at that line, taking every
   listener below it with it. Use `on` instead — it no-ops when the element isn't there. */
const PAGE = document.body.dataset.page || "analyzer";
const IS_ANALYZER_PAGE = PAGE === "analyzer";
const IS_SCREENER_PAGE = PAGE === "screener";
const IS_BACKTESTER_PAGE = PAGE === "backtester";
function on(id, ev, fn, opts) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn, opts);
  return el;
}

/* ════════════════ STATE: per-ticker sessions (declared first — theme init reads `active`) ════════════════ */
const sessions = {};   // { TICKER: { data, context, history, range } }
let active = null;     // active ticker for the chat/AI/data panes
const chartOpts = { ma20: false, ma50: true, ma200: true, bb: false, fib: false, sr: true, pct: false, vol: true, instWindow: false };

/* Chart ranges are timeframe descriptors, not bar counts. They used to be
   [label, dailyBars], which is why "1W" drew five candles and "1M" drew twenty-one — a
   week of daily bars is a week of daily bars however you slice it. The short tiers now
   read intraday series, so the same wall clock buys ~78/65/150 candles instead of 5/21.
   `tf` names the series: "1d" is price_history, "5m"/"60m" come straight from the payload,
   and "30m" is rolled up from "5m" in the browser because the scraper deliberately does
   not ship data the client can derive exactly.
   These live up here, not down beside drawChart, because hydrateSavedSessions() runs at
   load and calls normalizeRange — a `const` declared below that call site is in the
   temporal dead zone, and the ReferenceError takes the whole script down on both pages. */
const RANGES = [
  { id: "1D", label: "1D", tf: "5m",  bars: 78,   note: "5-min bars"  },
  { id: "1W", label: "1W", tf: "30m", bars: 65,   note: "30-min bars" },
  { id: "1M", label: "1M", tf: "60m", bars: 150,  note: "1-hour bars" },
  { id: "3M", label: "3M", tf: "1d",  bars: 63,   note: "daily bars"  },
  { id: "6M", label: "6M", tf: "1d",  bars: 126,  note: "daily bars"  },
  { id: "1Y", label: "1Y", tf: "1d",  bars: 252,  note: "daily bars"  },
  { id: "2Y", label: "2Y", tf: "1d",  bars: 504,  note: "daily bars"  },
  { id: "5Y", label: "5Y", tf: "1d",  bars: 1260, note: "daily bars"  },
];
const DEFAULT_RANGE = "1Y";
/* Every saved tab in every existing browser stores the old bar count. Without this map
   `RANGES.find(r => r.id === 252)` is undefined and drawChart throws on the first render
   of restored work — a silent, total loss of the saved-tab feature on upgrade. */
const LEGACY_RANGE_BARS = { 5: "1W", 21: "1M", 63: "3M", 126: "6M", 252: "1Y", 504: "2Y", 1260: "5Y" };
function normalizeRange(raw) {
  if (typeof raw === "string" && RANGES.some(r => r.id === raw)) return raw;
  return LEGACY_RANGE_BARS[Number(raw)] || DEFAULT_RANGE;
}
const rangeSpec = id => RANGES.find(r => r.id === id) || RANGES.find(r => r.id === DEFAULT_RANGE);

/* ── Timeframe series resolution ──────────────────────────────────────────────
   n→1 bar rollup. Anchored to the END of the series so the newest bar is always a
   boundary: aggregating from the front would let a partial oldest group shift every
   bucket by a bar or two each time new data arrives, and the most recent candle — the
   one being read — is the one that must be right. */
function aggregateBars(bars, factor) {
  if (!Array.isArray(bars) || factor < 2) return Array.isArray(bars) ? bars : [];
  const out = [];
  const start = bars.length % factor;                    // leading remainder, dropped
  for (let i = start; i + factor <= bars.length; i += factor) {
    const win = bars.slice(i, i + factor);
    const highs = win.map(b => b.high).filter(isNum);
    const lows  = win.map(b => b.low).filter(isNum);
    if (!highs.length || !lows.length) continue;
    out.push({
      date:   win[0].date,
      open:   win[0].open,
      high:   Math.max(...highs),
      low:    Math.min(...lows),
      close:  win[win.length - 1].close,
      volume: win.reduce((s, b) => s + (Number(b.volume) || 0), 0),
    });
  }
  return out;
}
/* The one place that knows which array backs a timeframe. Returns [] — never null — so
   every caller can treat "no data for this tier" as an ordinary empty series. */
const _agg30mCache = new WeakMap();
function seriesFor(d, tf) {
  if (!d) return [];
  if (tf === "1d") return d.price_history || d.price_history_1y || [];
  const intra = d.intraday_history || {};
  if (tf === "30m") {
    // Derived per payload, not per draw: drawChart runs on every hover, drag and repaint.
    const src = intra["5m"];
    if (!Array.isArray(src) || !src.length) return [];
    if (!_agg30mCache.has(src)) _agg30mCache.set(src, aggregateBars(src, 6));
    return _agg30mCache.get(src);
  }
  return Array.isArray(intra[tf]) ? intra[tf] : [];
}
// A tier only earns a button if it has enough bars to be a chart rather than a hint.
const MIN_TIER_BARS = 12;
const rangeAvailable = (d, r) => seriesFor(d, r.tf).length >= MIN_TIER_BARS;
/* Intraday bars carry "YYYY-MM-DD HH:MM". Showing the date on every tick wastes the
   width and repeats itself; showing only the time makes a multi-day window ambiguous.
   Edges get the day, interior ticks get the clock. */
function axisLabel(bar, tf, edge) {
  const raw = String(bar?.date || "");
  if (tf === "1d") return raw.slice(2);
  const [day, time] = raw.split(" ");
  if (!time) return raw.slice(2);
  return edge ? `${day.slice(5)} ${time}` : time;
}
/* ── Viewport: zoom + pan over the tier's default window ──────────────────────
   A range tier picks the timeframe and a default number of bars; the viewport is a zoom
   over that default rather than a replacement for it, so "5-min bars" stays true however
   far in you have pinched. State is two numbers and both are counted in BARS FROM THE
   RIGHT EDGE — `count` on screen, `offset` trimmed off the newest end — which is what lets
   one viewport drive two tickers of different history lengths in the compare split without
   either pane drifting out of step with the other.
   Everything is clamped in here, so no caller has to reason about a series shorter than
   the window it is being asked for. Kept beside RANGES rather than beside drawChart for
   the same reason RANGES is: it is read during the load-time render. */
const MIN_ZOOM_BARS = 10;
const chartZoom = { key: null, count: null, offset: 0 };
const finiteNum = v => typeof v === "number" && isFinite(v);

function visibleWindow(len, defaultBars, zoom) {
  const n = Math.max(0, Math.floor(len) || 0);
  const base = Math.min(Math.max(1, Math.floor(defaultBars) || 1), n);
  const floor = Math.min(MIN_ZOOM_BARS, n);
  let count = finiteNum(zoom?.count) ? Math.round(zoom.count) : base;
  count = Math.max(floor, Math.min(count, n));
  let offset = finiteNum(zoom?.offset) ? Math.round(zoom.offset) : 0;
  offset = Math.max(0, Math.min(offset, n - count));
  return { start: n - offset - count, end: n - offset, count, offset };
}
/* Zoom holds the bar under the pointer still: `anchor` is where in the window the cursor
   (or the midpoint of a pinch) sits, 0 at the left edge and 1 at the right. Without it
   every zoom walks the view toward the newest bar and you cannot open up the level you
   were actually looking at. */
function zoomWindow(win, factor, anchor, len) {
  const n = Math.max(0, Math.floor(len) || 0);
  const floor = Math.min(MIN_ZOOM_BARS, n);
  const count = Math.max(floor, Math.min(n, Math.round(win.count * factor)));
  const a = Math.max(0, Math.min(1, finiteNum(anchor) ? anchor : 1));
  const held = win.start + a * win.count;                  // the bar that must not move
  const end = Math.round(held + (1 - a) * count);
  return { count, offset: Math.max(0, Math.min(n - count, n - end)) };
}
/* Positive delta drags the candles to the right, which walks the window back in time. */
function panWindow(win, deltaBars, len) {
  const n = Math.max(0, Math.floor(len) || 0);
  const step = finiteNum(deltaBars) ? Math.round(deltaBars) : 0;
  return { count: win.count, offset: Math.max(0, Math.min(n - win.count, win.offset + step)) };
}
const zoomActive = () => chartZoom.count !== null || chartZoom.offset !== 0;
/* Per-pane paint and gesture state. Hover, the reveal sweep and the in-flight gesture used
   to hang off drawChart itself, which was correct while there was exactly one canvas; with
   the compare split there are two, and a shared hover index draws a crosshair on the chart
   you are not touching. Declared up here with the rest of the chart state because the
   load-time applyTheme() repaints, and a const below that call site is a temporal dead
   zone that throws for every visitor holding a saved tab. */
const chartPaneState = { primary: {}, compare: {} };
/* Up here with the rest of the chart state for the same reason, and it earned its place the
   hard way: resolvePane reads it to decide whether an in-flight Fib drag has to fit inside
   the y-axis, and resolvePane is called from drawChart BEFORE the canvas check — so the
   load-time applyTheme() repaint reaches it on a page that has never rendered a chart.
   Declared beside paintChartPane, that is a temporal dead zone which throws at load and
   takes every listener below it with it, on all four pages. pagecheck catches this. */
const fibInteraction = { ticker: null, mode: false, pending: null, dragging: null };
function resetZoom(key) {
  if (key !== undefined) chartZoom.key = key;
  chartZoom.count = null; chartZoom.offset = 0;
}

/* ── Compare: a second saved tab beside the first ─────────────────────────────
   A view preference, not session state — the same class of thing as the active rail
   destination, so it lives under its own localStorage key and never enters a session. */
const CHART_COMPARE_KEY = "squall-chart-compare-v1";
let compareTicker = null;
try { compareTicker = localStorage.getItem(CHART_COMPARE_KEY) || null; } catch (_) { compareTicker = null; }
/* Resolved at read time rather than pruned on write: the stored ticker can stop being
   comparable between one render and the next (its tab was deleted, or it became the active
   one), and a stale id must degrade to "not comparing" rather than to a blank pane. */
function effectiveCompare() {
  return compareTicker && compareTicker !== active && sessions[compareTicker] ? compareTicker : null;
}
/* Turning compare on for the first time also turns the percent scale on. Two absolute
   price axes are never the right answer for a $890 stock beside a $95 one, and someone who
   has just asked to compare has not yet been given a reason to go looking for a scale
   setting. It is a one-shot default, not a lock: the flag records that the suggestion was
   made, so switching back to dollars sticks and is never overridden again. */
const CHART_PCT_SEEDED_KEY = "squall-chart-pct-seeded-v1";
function seedPercentScaleForCompare() {
  try {
    if (localStorage.getItem(CHART_PCT_SEEDED_KEY)) return false;
    localStorage.setItem(CHART_PCT_SEEDED_KEY, "1");
  } catch (_) { return false; }
  if (chartOpts.pct) return false;
  chartOpts.pct = true;
  return true;
}
function setCompareTicker(t, redraw = true) {
  const wasComparing = Boolean(effectiveCompare());
  compareTicker = t && sessions[t] && t !== active ? t : null;
  try {
    if (compareTicker) localStorage.setItem(CHART_COMPARE_KEY, compareTicker);
    else localStorage.removeItem(CHART_COMPARE_KEY);
  } catch (_) {}
  if (!wasComparing && effectiveCompare() && seedPercentScaleForCompare()) syncOverlayToggles();
  if (redraw) { syncChartChrome(); drawChart(); }
}

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;   // JS-driven animations honor this too
const SESSION_STORAGE_KEY = "squall-saved-analyses-v1";
const SCREENER_STORAGE_KEY = "squall-saved-screeners-v1";
const screeners = {};   // saved natural-language multi-index screens
let activeScreen = null;
let _screenES = null;
const ANALYSIS_RUNS_KEY = "squall-analysis-runs-v1";
const RUN_WINDOW_MS = 15 * 60 * 1000;
const RUN_LIMIT = 3;

function cleanHistory(history) {
  return Array.isArray(history) ? history.map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || ""),
    reasoning: String(m.reasoning || ""),
    error: Boolean(m.error)
  })) : [];
}
function hydrateSavedSessions() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "{}"); } catch (_) { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  Object.entries(saved).forEach(([ticker, raw]) => {
    if (!raw || typeof raw !== "object" || !raw.data || raw.data.ticker !== ticker) return;
    sessions[ticker] = {
      data: raw.data,
      context: String(raw.context || raw.data.ai_prompt || ""),
      history: cleanHistory(raw.history),
      range: normalizeRange(raw.range),   // migrates the pre-timeframe bar counts
      profile: raw.profile || null,
      profileKey: String(raw.profileKey || "none"),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
      fibAnchors: raw.fibAnchors || null
    };
  });
  active = Object.keys(sessions).sort((a, b) => sessions[b].updatedAt - sessions[a].updatedAt)[0] || null;
}
/* A saved session is dominated by data.price_history — 1260 daily OHLCV bars — and it used
   to carry two free copies alongside it. safe_float in the scraper does no rounding, so a
   close arrives as 234.55999755859375: 18 bytes where 6 will do, four times per bar.
   price_history_1y is a pure alias that both chart readers already fall back to, and
   `context` is assigned data.ai_prompt at creation and never reassigned, so storing it
   duplicates the largest text field in the payload. Trimming all three roughly halves a
   session against a ~5MB origin budget. This shapes the persisted projection only — the
   in-memory session keeps exactly what the scraper sent. */
function trimBars(bars) {
  if (!Array.isArray(bars)) return bars;
  return bars.map(bar => {
    if (!bar || typeof bar !== "object") return bar;
    const out = {};
    for (const k in bar) {
      const v = bar[k];
      // 6dp is far finer than any quote ever quoted; volume is a count and must not move.
      out[k] = (typeof v === "number" && k !== "volume") ? Math.round(v * 1e6) / 1e6 : v;
    }
    return out;
  });
}
function persistableSession(s) {
  const data = { ...s.data };
  if (Array.isArray(data.price_history) && data.price_history.length) {
    data.price_history = trimBars(data.price_history);
    delete data.price_history_1y;   // only ever dropped when the series it aliases survived
  }
  // Intraday tiers get the same 6dp treatment. The 30-minute series 1W draws is not here
  // and must never be added: seriesFor derives it from "5m" on demand, and storing it
  // would be the same duplication price_history_1y is dropped for.
  if (data.intraday_history && typeof data.intraday_history === "object") {
    const intra = {};
    for (const tf in data.intraday_history) intra[tf] = trimBars(data.intraday_history[tf]);
    data.intraday_history = intra;
  }
  const out = {
    data, history: cleanHistory(s.history), range: s.range,
    profile: s.profile || null, profileKey: s.profileKey || "none",
    createdAt: s.createdAt || Date.now(), updatedAt: s.updatedAt || Date.now(),
    fibAnchors: s.fibAnchors || null
  };
  // hydrateSavedSessions recovers context from data.ai_prompt, so it only needs storing in
  // the case that can't be recovered: one that has somehow diverged from its prompt.
  if (s.context && s.context !== (s.data?.ai_prompt || "")) out.context = s.context;
  return out;
}
function writeSessionMap(map) {
  try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(map)); return true; }
  catch (_) { return false; }
}
let _saveTimer = null;   // declared above persistSessions, which clears it on an immediate write
/* Quota is a real ceiling here, and it used to be reached in silence: this returned false
   and not one of its eleven callers looked at the result. The tab appeared, the write
   failed, and the analysis was gone on the next visit with nothing shown either way. A full
   store now evicts the least-recently-updated saved analyses — never the active one — until
   the write fits, and says which ones went. Announced loss beats silent loss; refusing the
   write instead would still lose the session at reload, just later and even more quietly. */
function persistSessions() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }   // an immediate write satisfies any pending one
  const map = {};
  Object.keys(sessions).forEach(t => { map[t] = persistableSession(sessions[t]); });
  if (writeSessionMap(map)) return true;

  const evictable = Object.keys(sessions)
    .filter(t => t !== active)
    .sort((a, b) => (sessions[a].updatedAt || 0) - (sessions[b].updatedAt || 0));
  const evicted = [];
  for (const victim of evictable) {
    delete map[victim];
    evicted.push(victim);
    if (writeSessionMap(map)) {
      evicted.forEach(t => { delete sessions[t]; });
      const n = evicted.length;
      showStorageNotice(`Browser storage is full — removed ${n} older saved ${n === 1 ? "analysis" : "analyses"} (${evicted.join(", ")}) to make room for this one.`);
      renderTickerPills();
      return true;
    }
  }
  showStorageNotice("Browser storage is full and this analysis could not be saved. Close a saved tab, then run it again.");
  return false;
}
/* Range clicks and fib handles wrote the whole blob synchronously per interaction. Coalesce
   that churn; the state transitions that must survive a crash still write straight through.
   A debounced write that never lands is worse than no debounce, so both ways a page can go
   away flush first — pagehide covers tab close and bfcache, visibilitychange covers the
   mobile app-switch that never fires pagehide at all. */
function scheduleSessionSave(delay = 400) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; persistSessions(); }, delay);
}
function flushSessionSave() { if (_saveTimer) persistSessions(); }
addEventListener("pagehide", flushSessionSave);
addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSessionSave(); });
/* The saved-tab features can fail for a reason the user can actually act on, so they need a
   visible channel. Deliberately not auto-dismissed: the message says data was dropped. */
function showStorageNotice(msg) {
  const el = document.getElementById("storageNotice");
  const txt = document.getElementById("storageNoticeText");
  if (!el || !txt) return;
  txt.textContent = msg;
  el.hidden = false;
  const close = el.querySelector("button");
  if (close) close.onclick = () => { el.hidden = true; };
}
function hydrateSavedScreeners() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SCREENER_STORAGE_KEY) || "{}"); } catch (_) { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  Object.entries(saved).forEach(([id, raw]) => {
    if (!raw || typeof raw !== "object" || !raw.query) return;
    screeners[id] = { ...raw, id, query: String(raw.query), title: String(raw.title || "Saved screen"),
      history: Array.isArray(raw.history) ? raw.history.slice(-20).map(m => ({ role:m?.role === "user" ? "user" : "assistant", content:String(m?.content || "").slice(0,1000) })) : [],
      createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now() };
  });
}
function persistScreeners() {
  const saved = {};
  Object.entries(screeners).forEach(([id, s]) => { saved[id] = { ...s, loading: false }; });
  try { localStorage.setItem(SCREENER_STORAGE_KEY, JSON.stringify(saved)); return true; }
  catch (_) {
    // Screens are small, but they share the origin budget with the analyses that aren't, so
    // this fails for the same reason and used to fail just as invisibly. No eviction here:
    // a screen is cheap to re-run, and silently deleting one to save another isn't a trade
    // worth making on the user's behalf.
    showStorageNotice("Browser storage is full — this screen could not be saved. Close a saved tab, then try again.");
    return false;
  }
}
function touchSession(sess) { if (sess) sess.updatedAt = Date.now(); }
function recentAnalysisRuns(ticker) {
  let runs = [];
  try { runs = JSON.parse(localStorage.getItem(ANALYSIS_RUNS_KEY) || "[]"); } catch (_) {}
  const cutoff = Date.now() - RUN_WINDOW_MS;
  return Array.isArray(runs) ? runs.filter(r => r && r.at >= cutoff && (!ticker || r.ticker === ticker)) : [];
}
function recordAnalysisRun(ticker) {
  const runs = recentAnalysisRuns();
  runs.push({ ticker, at: Date.now() });
  try { localStorage.setItem(ANALYSIS_RUNS_KEY, JSON.stringify(runs)); } catch (_) {}
}
function analysisRunWait(ticker) {
  const runs = recentAnalysisRuns(ticker);
  return runs.length >= RUN_LIMIT ? Math.max(1, Math.ceil((runs[0].at + RUN_WINDOW_MS - Date.now()) / 60000)) : 0;
}
hydrateSavedSessions();
hydrateSavedScreeners();

/* Retitle a control safely. The tooltip layer below migrates [title] → data-tip on
   first hover and drops the attribute, so writing .title afterwards would leave the
   visible tooltip showing stale text. Write whichever one the element is using. */
function setTip(el, text) {
  if (!el) return;
  if ("tip" in el.dataset) el.dataset.tip = text; else el.title = text;
}

/* ════════════════ THEME ════════════════
   Each entry mirrors a :root[data-theme="…"] block in index.html — adding a palette means
   editing both. `mode` is the light/dark family, published on <html data-mode> for the few
   places that need to know (canvas candle alpha) instead of testing for one theme id.
   `bg`/`accent` are literal hex for the menu swatches: a swatch has to show its own
   palette, so it can't read the vars of the theme currently applied. */
const THEMES = [
  { id: "dark",   label: "Midnight", note: "Slate + teal",      mode: "dark",  bg: "#0a0e14", accent: "#3fd0b6" },
  { id: "light",  label: "Daylight", note: "Fog + teal",        mode: "light", bg: "#eef2f5", accent: "#0b8a78" },
  { id: "noir",   label: "Noir",     note: "Black + white",     mode: "dark",  bg: "#000000", accent: "#ffffff" },
  { id: "paper",  label: "Paper",    note: "White + black",     mode: "light", bg: "#ffffff", accent: "#000000" },
  { id: "lagoon", label: "Lagoon",   note: "Turquoise + pink",  mode: "dark",  bg: "#052b2b", accent: "#ff4fa3" },
  { id: "matrix", label: "Terminal", note: "Black + lime",      mode: "dark",  bg: "#000000", accent: "#8dff3a" },
];
/* Noir is the default. The key is versioned because the old build wrote the resolved theme
   on EVERY load, so a stored "dark" cannot be told apart from "never chose" — keeping the
   old key would have left every returning visitor on Midnight. Only an explicit pick writes
   the new key; a pre-v2 value is carried over only when it is one no default could have
   produced (see the loader below). 404.html reads the same key. */
const THEME_STORAGE_KEY = "squall-theme-v2";
const LEGACY_THEME_KEY = "squall-theme";
const DEFAULT_THEME = "noir";
const themeBtn = document.getElementById("themeBtn");
const themeMenu = document.getElementById("themeMenu");

function themeDef(id) { return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === DEFAULT_THEME); }

/* The switch itself: flip the tokens, tell anything that samples resolved colors, repaint
   the canvas. Deliberately synchronous and cheap — it is the callback a view transition
   runs between its two snapshots, so anything deferred out of it (a rAF, a timeout) lands
   *after* the "new" snapshot is taken and pops into view mid-fade instead of crossfading.
   drawChart() is the reason that matters: canvases don't inherit CSS colors. */
function commitTheme(def, persist) {
  const root = document.documentElement;
  root.dataset.theme = def.id;
  root.dataset.mode = def.mode;
  /* The tokens above are the theme; the two lines below are only its BUTTON. Guarded
     because this runs at load, from the top level, in a file three pages share — and a
     throw here does not fail the theme, it strands every let/const declared below this
     call site in its temporal dead zone while leaving the hoisted functions callable.
     The page then renders, `typeof fn === "function"` still answers true, and the damage
     surfaces far away as "Cannot access 'x' before initialization". Chrome that is absent
     for any reason — a stale cached page against fresh script, an include that did not
     expand, a blocked element — must cost its own affordance and nothing else. */
  if (themeBtn) {
    themeBtn.setAttribute("aria-label", `Appearance — ${def.label} theme`);
    setTip(themeBtn, `Appearance · ${def.label}`);
  }
  if (themeMenu) themeMenu.querySelectorAll(".theme-opt").forEach(b =>
    b.setAttribute("aria-checked", String(b.dataset.theme === def.id)));
  // Persist only an explicit pick — writing the resolved default here is what made the
  // pre-v2 key unable to distinguish a choice from a default.
  if (persist) try { localStorage.setItem(THEME_STORAGE_KEY, def.id); } catch (e) {}
  // Anything that samples resolved colors (hero wind field, the cssVar cache, future
  // canvases) listens here rather than on the button — the button click only opens the menu.
  document.dispatchEvent(new CustomEvent("squall:theme", { detail: def }));
  if (active && sessions[active]) drawChart();
}

/* Crossfade between palettes on the compositor. The page is snapshotted before and after
   the swap and the two textures are cross-faded — one animating layer whatever is on
   screen — instead of the old `.theme-anim` rule, which put a six-property color
   transition on every element and both pseudo-elements (~3.5k animating boxes on a
   rendered analysis, and worse in a burst because each new switch re-targeted transitions
   still running from the last one).

   `.theme-swap` holds per-element transitions off for the duration: underneath a snapshot
   they are invisible work, and on browsers with no view transitions they are exactly the
   "some things fade, most snap" effect that read as broken. Overlapping switches need no
   handling here — startViewTransition skips an in-flight transition for us, and the DOM is
   already in its final state by then either way. */
function applyTheme(id, animate, persist) {
  const def = themeDef(id);
  const root = document.documentElement;
  if (root.dataset.theme === def.id && root.dataset.mode) { commitTheme(def, persist); return; }
  if (!animate || REDUCED || !document.startViewTransition) { commitTheme(def, persist); return; }

  root.classList.add("theme-swap");
  const done = () => root.classList.remove("theme-swap");
  try {
    const vt = document.startViewTransition(() => commitTheme(def, persist));
    // Every one of these promises rejects on a skipped transition — a hidden tab, or a
    // second switch arriving mid-fade — and an unhandled rejection is a console error the
    // user sees. Skipping is a normal outcome here, not a failure: the DOM is already in
    // its final state, so the only thing left to do is take the class back off.
    vt.ready.catch(() => {});
    vt.updateCallbackDone.catch(() => {});
    vt.finished.then(done, done);
  } catch (e) { commitTheme(def, persist); done(); }
}

if (themeMenu) themeMenu.innerHTML =
  `<div class="theme-menu-head">Theme</div>` +
  THEMES.map(t => `<button class="theme-opt" type="button" role="menuitemradio" aria-checked="false"
      data-theme="${t.id}" style="--sw-bg:${t.bg}; --sw-accent:${t.accent}">
      <i class="theme-swatch" aria-hidden="true"></i>
      <span class="tl"><b>${t.label}</b><span>${t.note}</span></span>
      <svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
    </button>`).join("");

(function () {
  let saved;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (!saved) {
      // "dark"/"light" were what the old build wrote as the OS-derived default, so they
      // prove nothing; any other palette could only have been picked by hand.
      const legacy = localStorage.getItem(LEGACY_THEME_KEY);
      if (legacy && legacy !== "dark" && legacy !== "light" && THEMES.some(t => t.id === legacy)) {
        saved = legacy;
        localStorage.setItem(THEME_STORAGE_KEY, legacy);
      }
      localStorage.removeItem(LEGACY_THEME_KEY);
    }
  } catch (e) {}
  // An unknown id (older build, hand-edited storage) falls back to the default.
  if (!saved || !THEMES.some(t => t.id === saved)) saved = DEFAULT_THEME;
  applyTheme(saved, false);
})();

/* Menu open/close + roving keyboard focus */
function themeMenuOpen() { return Boolean(themeMenu) && themeMenu.classList.contains("open"); }
function openThemeMenu() {
  themeMenu.classList.add("open");
  themeBtn.setAttribute("aria-expanded", "true");
  const checked = themeMenu.querySelector('.theme-opt[aria-checked="true"]') || themeMenu.querySelector(".theme-opt");
  if (checked) { checked.classList.add("cursor"); checked.focus(); }
}
function closeThemeMenu(refocus) {
  if (!themeMenuOpen()) return;
  themeMenu.classList.remove("open");
  themeBtn.setAttribute("aria-expanded", "false");
  themeMenu.querySelectorAll(".cursor").forEach(b => b.classList.remove("cursor"));
  if (refocus) themeBtn.focus();
}
function moveThemeCursor(step) {
  const opts = [...themeMenu.querySelectorAll(".theme-opt")];
  const from = opts.indexOf(document.activeElement);
  const next = opts[(from + step + opts.length) % opts.length] || opts[0];
  opts.forEach(b => b.classList.toggle("cursor", b === next));
  next.focus();
}

if (themeBtn) themeBtn.addEventListener("click", () => { themeMenuOpen() ? closeThemeMenu(false) : openThemeMenu(); });
if (themeMenu) themeMenu.addEventListener("click", e => {
  const opt = e.target.closest(".theme-opt");
  if (!opt) return;
  applyTheme(opt.dataset.theme, true, true);
  themeBtn.classList.remove("picked"); void themeBtn.offsetWidth; themeBtn.classList.add("picked");
  closeThemeMenu(true);
});
if (themeMenu) themeMenu.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveThemeCursor(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveThemeCursor(-1); }
  else if (e.key === "Home") { e.preventDefault(); moveThemeCursor(-[...themeMenu.querySelectorAll(".theme-opt")].indexOf(document.activeElement)); }
  else if (e.key === "Tab") closeThemeMenu(false);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && themeMenuOpen()) { e.stopPropagation(); closeThemeMenu(true); } }, true);
document.addEventListener("pointerdown", e => {
  if (themeMenuOpen() && !themeMenu.contains(e.target) && !themeBtn.contains(e.target)) closeThemeMenu(false);
});

/* ════════════════ MYSQUALL PROFILE ════════════════ */
const PROFILE_STORAGE_KEY = "squall-profile-v1";
const PROFILE_DEFAULTS = { risk: 3, horizon: 4, experience: 2, depth: 3, style: "balanced", priorities: [], custom: "" };
const PROFILE_STYLES = new Set(["balanced", "long-term", "swing", "value", "growth", "income", "options"]);
const PROFILE_PRIORITIES = new Set(["downside", "growth", "valuation", "income", "momentum", "options"]);
let mySquallProfile = loadMySquall();
let profileReturnFocus = null;

function clampProfileScore(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : fallback;
}
function normalizeMySquall(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    risk: clampProfileScore(raw.risk, PROFILE_DEFAULTS.risk),
    horizon: clampProfileScore(raw.horizon, PROFILE_DEFAULTS.horizon),
    experience: clampProfileScore(raw.experience, PROFILE_DEFAULTS.experience),
    depth: clampProfileScore(raw.depth, PROFILE_DEFAULTS.depth),
    style: PROFILE_STYLES.has(raw.style) ? raw.style : PROFILE_DEFAULTS.style,
    priorities: Array.isArray(raw.priorities) ? [...new Set(raw.priorities.filter(p => PROFILE_PRIORITIES.has(p)))].slice(0, 4) : [],
    custom: String(raw.custom || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 600)
  };
}
function loadMySquall() {
  try { return normalizeMySquall(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY))); }
  catch (_) { return null; }
}
function getMySquallProfile() {
  return mySquallProfile ? { ...mySquallProfile, priorities: [...mySquallProfile.priorities] } : null;
}
function mySquallKey(profile) { return profile ? JSON.stringify(profile) : "none"; }
function syncProfileButton() {
  const btn = document.getElementById("profileBtn");
  btn?.classList.toggle("configured", Boolean(mySquallProfile));
  setTip(btn, mySquallProfile ? "MySquall profile saved — click to edit" : "Personalize analysis with MySquall");
}
function updateProfileLabels() {
  ["Risk", "Horizon", "Experience", "Depth"].forEach(name => {
    const input = document.getElementById("profile" + name);
    const output = document.getElementById("profile" + name + "Value");
    const labels = input?.dataset.labels?.split("|") || [];
    if (input && output) output.textContent = labels[Number(input.value) - 1] || input.value;
  });
  const custom = document.getElementById("profileCustom");
  const count = document.getElementById("profileCustomCount");
  if (custom && count) count.textContent = String(custom.value.length);
}
function fillMySquallForm(profile = mySquallProfile || PROFILE_DEFAULTS) {
  document.getElementById("profileRisk").value = profile.risk;
  document.getElementById("profileHorizon").value = profile.horizon;
  document.getElementById("profileExperience").value = profile.experience;
  document.getElementById("profileDepth").value = profile.depth;
  document.getElementById("profileStyle").value = profile.style;
  document.getElementById("profileCustom").value = profile.custom || "";
  document.querySelectorAll("#profilePriorities input").forEach(input => { input.checked = profile.priorities.includes(input.value); });
  updateProfileLabels();
}
function readMySquallForm() {
  return normalizeMySquall({
    risk: document.getElementById("profileRisk").value,
    horizon: document.getElementById("profileHorizon").value,
    experience: document.getElementById("profileExperience").value,
    depth: document.getElementById("profileDepth").value,
    style: document.getElementById("profileStyle").value,
    priorities: [...document.querySelectorAll("#profilePriorities input:checked")].map(input => input.value),
    custom: document.getElementById("profileCustom").value
  });
}
function openMySquall() {
  profileReturnFocus = document.activeElement;
  fillMySquallForm();
  const modal = document.getElementById("profileModal");
  modal.classList.add("open"); modal.setAttribute("aria-hidden", "false");
  document.getElementById("profileSaveStatus").textContent = "";
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => document.getElementById("profileRisk").focus());
}
function closeMySquall() {
  const modal = document.getElementById("profileModal");
  modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (profileReturnFocus?.focus) profileReturnFocus.focus();
}
function saveMySquall() {
  mySquallProfile = readMySquallForm();
  try { localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(mySquallProfile)); }
  catch (_) { document.getElementById("profileSaveStatus").textContent = "Could not save in this browser"; return; }
  syncProfileButton();
  document.getElementById("profileSaveStatus").textContent = "Saved locally ✓";
  setTimeout(closeMySquall, 450);
}
function resetMySquall() {
  mySquallProfile = null;
  try { localStorage.removeItem(PROFILE_STORAGE_KEY); } catch (_) {}
  fillMySquallForm(PROFILE_DEFAULTS); syncProfileButton();
  document.getElementById("profileSaveStatus").textContent = "Profile cleared";
}

document.querySelectorAll('#profileForm input[type="range"]').forEach(input => input.addEventListener("input", updateProfileLabels));
document.getElementById("profileCustom").addEventListener("input", updateProfileLabels);
document.getElementById("profilePriorities").addEventListener("change", e => {
  const checked = document.querySelectorAll("#profilePriorities input:checked");
  if (checked.length > 4 && e.target.matches("input")) {
    e.target.checked = false;
    document.getElementById("profileSaveStatus").textContent = "Choose up to four focus areas";
  }
});
document.querySelectorAll("[data-profile-prompt]").forEach(button => button.addEventListener("click", () => {
  const field = document.getElementById("profileCustom");
  const next = (field.value.trim() ? field.value.trim() + " " : "") + button.dataset.profilePrompt;
  field.value = next.slice(0, 600); updateProfileLabels(); field.focus();
}));
document.getElementById("profileModal").addEventListener("click", e => { if (e.target.id === "profileModal") closeMySquall(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && document.getElementById("profileModal").classList.contains("open")) closeMySquall(); });
syncProfileButton();

/* ════════════════ FORMATTERS ════════════════ */
/* A DECLARATION, not a `const` arrow like its neighbours, and that is load-bearing rather
   than a style slip. isNum is the one formatter reached from the chart path, and the chart
   path runs at LOAD: applyTheme() -> commitTheme() -> drawChart() fires ~170 lines above
   this point for any visitor whose active saved tab resolves to a derived timeframe, so
   aggregateBars called it while a `const` was still in its temporal dead zone. That threw
   at app.js's top level, which strands every let/const below it and leaves the hoisted
   functions callable — the page renders, the header links still work, and everything
   wired below the throw is silently dead. Hoisting makes the ordering unbreakable instead
   of merely correct today; the rest of this block is only ever reached from render code
   and can stay as it is. */
function isNum(v) { return v !== null && v !== undefined && typeof v === "number" && isFinite(v); }
const fPct = (v, dp = 2) => isNum(v) ? (v * 100).toFixed(dp) + "%" : "N/A";
const fRatio = (v, dp = 2) => isNum(v) ? v.toFixed(dp) : "N/A";
function fUsd(v) { if (!isNum(v)) return "N/A"; const a = Math.abs(v);
  if (a >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T"; if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const fInt = v => isNum(v) ? Math.round(v).toLocaleString("en-US") : "N/A";
const signCls = (v, inv = false) => (!isNum(v) || v === 0) ? "" : ((inv ? v < 0 : v > 0) ? "green" : "red");
const esc = t => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = t => esc(t).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (url.protocol === "https:" || url.protocol === "http:") ? url.href : "";
  } catch { return ""; }
}
// Escape for a single-quoted JS string sitting inside a double-quoted HTML attribute
// (e.g. onclick="retryAnalysis('…')") — company names may contain ' or &.
const jsAttr = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/* Resolved token lookup, memoized. Every call is a getComputedStyle on <html>, and the
   chart calls it *per candle* (--up/--down inside the draw loop) — several hundred style
   resolutions per repaint, each one able to force a recalc if styles are dirty, which is
   exactly the state right after a theme switch. Tokens only change when the theme does, so
   the cache is cleared on squall:theme and nowhere else. */
let cssVarCache = new Map();
const cssVar = n => {
  let v = cssVarCache.get(n);
  if (v === undefined) { v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); cssVarCache.set(n, v); }
  return v;
};
document.addEventListener("squall:theme", () => { cssVarCache = new Map(); });

/* ════════════════ PROGRESS ════════════════ */
function showProgressPercent(percent, label, isErr = false) {
  document.getElementById("progressWrap").classList.add("show");
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const fill = document.getElementById("progressFill");
  fill.style.width = pct + "%"; fill.classList.toggle("error", isErr);
  document.getElementById("progressTrack").setAttribute("aria-valuenow", String(pct));
  document.getElementById("progressStage").textContent = label;
  document.getElementById("progressMeta").classList.toggle("error", isErr);
  document.getElementById("progressPct").textContent = isErr ? "—" : pct + "%";
}
function showProgress(stage, total, label, isErr = false) {
  // Market-data collection occupies the first 68%; the remaining progress is
  // driven by dashboard rendering and live AI events below.
  const pct = isErr ? 0 : Math.round((stage / Math.max(1, total)) * 68);
  showProgressPercent(pct, label, isErr);
}
function hideProgress(delay = 600) { setTimeout(() => {
  document.getElementById("progressWrap").classList.remove("show");
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("progressTrack").setAttribute("aria-valuenow", "0"); }, delay); }

/* ════════════════ ANALYSIS (SSE streaming — scraper stages, then live AI tokens) ════════════════ */
function quick(t) { document.getElementById("ticker").value = t; runAnalysis(); }

// The hero field is a second mouth for the same pipeline: mirror it into #ticker, which
// stays the single source of truth for runAnalysis and everything downstream of it.
function runHeroAnalysis() {
  const hero = document.getElementById("heroTicker");
  if (hero?.value.trim().toLowerCase() === "/ilgar") { location.href = "/ilgar"; return; }
  if (hero) document.getElementById("ticker").value = hero.value.trim();
  runAnalysis();
}
// Both Analyze buttons show one run state — the hero's is on screen for the first click,
// the header's for every one after it.
function setAnalyzeBusy(busy) {
  document.querySelectorAll("#analyzeBtn, #heroAnalyzeBtn").forEach(b => { b.disabled = busy; });
}
/* Focus the hero field at boot and on the way home, but not on touch or narrow screens:
   there, focusing raises the keyboard over the page before the visitor asked for it. */
function focusHeroSearch() {
  const el = document.getElementById("heroTicker");
  if (!el || matchMedia("(hover: none), (max-width: 720px)").matches) return;
  el.focus();
}
/* The header's field hides while the hero is up. #hero's visibility is flipped by inline
   display from five call sites, so watch the attribute once instead of remembering to
   toggle a class at each of them (the wind field below watches it the same way). */
(function () {
  const hero = document.getElementById("hero");
  if (!hero) return;
  const sync = () => document.body.classList.toggle("hero-up", hero.style.display !== "none");
  new MutationObserver(sync).observe(hero, { attributes: true, attributeFilter: ["style"] });
  sync();
})();

/* On phones the header field is too small for the full placeholder — and the font steps
   up to 16px there to stop iOS zooming on focus, which makes the text wider still. A
   truncated placeholder ("Ticker or compan…") reads as a bug, so shorten it instead.
   The hero field is full width, so it can hold a longer prompt at every size but the
   narrowest. The full intent stays in each field's aria-label, and both match names too. */
(function () {
  const narrow = matchMedia("(max-width: 520px)");
  const fields = [
    { el: document.getElementById("ticker"), wide: "Ticker or company", tight: "Ticker" },
    { el: document.getElementById("heroTicker"), wide: "Search a ticker or company name", tight: "Ticker or company" }
  ].filter(f => f.el);
  const sync = () => fields.forEach(f => { f.el.placeholder = narrow.matches ? f.tight : f.wide; });
  narrow.addEventListener("change", sync);
  sync();
})();
// Pick a random company from the combined large-cap screening universe.
function randomAnalysis() {
  const extra = window.MARKET_UNIVERSES || {};
  const list = [...new Set([...(window.SP500 || []), ...(extra.nasdaq100 || []), ...(extra.dow30 || [])])];
  if (!Array.isArray(list) || !list.length) { quick("AAPL"); return; }
  quick(list[Math.floor(Math.random() * list.length)]);
}
let _es = null;
let _stream = null;   // { ticker, model, thinking, answer, answerStarted, done, sticky }

function prettyModel(id) {
  if (!id) return "AI";
  const online = /:online\b/.test(id);
  let m = id.split("/").pop().replace(/:online|:free|:nitro/g, "");
  m = m.split("-").map(w => (w.length <= 2 || /^v?\d/.test(w)) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(" ");
  m = m.replace(/\bDeepseek\b/i, "DeepSeek").replace(/\bGpt\b/i, "GPT").replace(/\bGlm\b/i, "GLM").replace(/\bQwen(\d)/i, "Qwen $1");
  m = m.replace(/(\d) (\d)$/, "$1.$2");   // "Sonnet 4 6" → "Sonnet 4.6"
  return m + (online ? " · live search" : "");
}
function setModelTag(id) { const el = document.getElementById("aiModelTag"); if (el && id) el.textContent = prettyModel(id); }
fetch("/health").then(r => r.json()).then(j => setModelTag(j.model)).catch(() => {});

/* ── Search typeahead — custom in-site dropdown over supported index constituents ──
   Records are lowercased once at boot; each keystroke is a single linear scan over
   503 entries with ranked buckets (ticker prefix → name prefix → substring), capped
   at 8 rows and painted with one innerHTML write — no per-item DOM churn.
   Attached to both search fields (header and hero) off one record set — the two are the
   same instrument, so they must rank, highlight and key-navigate identically. */
const TICKER_RECORDS = (() => {
  const names = { ...(window.MARKET_UNIVERSES?.names || {}), ...(window.SP500_NAMES || {}) };
  return Object.keys(names).map(sym =>
    ({ sym, name: names[sym], s: sym.toLowerCase(), n: names[sym].toLowerCase() }));
})();

function attachTypeahead(input, box, submit) {
  if (!input || !box || !TICKER_RECORDS.length) return;

  const REC = TICKER_RECORDS;
  const MAX = 8;
  // Row ids are namespaced per field: both dropdowns live in the DOM at once, and a
  // duplicate id would point aria-activedescendant at the wrong field's row.
  const rowId = i => box.id + "-opt-" + i;
  let items = [], activeI = -1;

  function search(q) {
    const symPre = [], namePre = [], sub = [];
    for (const r of REC) {
      if (r.s.startsWith(q)) { if (symPre.length < MAX) symPre.push(r); }
      else if (r.n.startsWith(q) || r.n.includes(" " + q)) { if (namePre.length < MAX) namePre.push(r); }
      else if (r.s.includes(q) || r.n.includes(q)) { if (sub.length < MAX) sub.push(r); }
      if (symPre.length >= MAX) break;   // top bucket full — nothing below can outrank it
    }
    return symPre.concat(namePre, sub).slice(0, MAX);
  }

  // Bold the matched run (search is case-insensitive; render from the original casing).
  function hi(text, lower, q) {
    const i = lower.indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  function close() {
    box.classList.remove("open"); box.innerHTML = "";
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
    items = []; activeI = -1;
  }

  function render(q) {
    items = search(q); activeI = -1;
    if (!items.length) { close(); return; }
    box.innerHTML = items.map((r, i) =>
      `<div class="sug" id="${rowId(i)}" role="option" data-i="${i}">
        <span class="sym">${hi(r.sym, r.s, q)}</span><span class="nm">${hi(r.name, r.n, q)}</span>
      </div>`).join("");
    box.classList.add("open");
    input.setAttribute("aria-expanded", "true");
  }

  function setActive(i) {
    activeI = i;
    box.querySelectorAll(".sug").forEach((el, j) => el.classList.toggle("active", j === i));
    if (i >= 0) {
      input.setAttribute("aria-activedescendant", rowId(i));
      box.children[i].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function pick(i) {
    if (i < 0 || i >= items.length) return;
    input.value = items[i].sym;
    close();
    submit();
  }

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 1) { close(); return; }
    render(q);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) { const q = input.value.trim().toLowerCase(); if (q) render(q); if (!items.length) return; }
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeI + d + items.length) % items.length);
    } else if (e.key === "Enter") {
      // With a highlighted row, Enter adopts that ticker; the form submit then runs it.
      if (activeI >= 0) input.value = items[activeI].sym;
      close();
    } else if (e.key === "Escape") {
      if (items.length) { e.preventDefault(); close(); }
    } else if (e.key === "Tab") close();
  });

  // pointerdown + preventDefault keeps focus in the input (no blur) while still firing click.
  box.addEventListener("pointerdown", e => e.preventDefault());
  box.addEventListener("click", e => {
    const el = e.target.closest(".sug");
    if (el) pick(+el.dataset.i);
  });
  input.addEventListener("blur", close);
}
attachTypeahead(document.getElementById("ticker"), document.getElementById("tickerSuggest"), runAnalysis);
attachTypeahead(document.getElementById("heroTicker"), document.getElementById("heroSuggest"), runHeroAnalysis);

function finalizePartialStream(ticker = _stream?.ticker) {
  // A new run (or navigation) interrupts an in-flight stream — keep what arrived.
  const pending = _stream && !_stream.done;
  const s = sessions[ticker];
  if (s && (pending || (!s.data.aiSummary && !s.data.aiError))) {
    if (pending) {
      s.data.aiSummary = _stream.answer;
      s.data.aiReasoning = _stream.thinking;
      s.data.model = _stream.model;
    }
    s.data.aiError = "The written analysis was interrupted and is incomplete";
    touchSession(s); persistSessions();
  }
  if (pending || s) {
    setAnalysisStreaming(false);
    document.getElementById("aiModelTag")?.classList.remove("live");
  }
  _stream = null;
  if (s && active === ticker) finalizeAiRender(s.data);
}

/* ── Skeleton loaders — mirror the real card/metric/prose shapes while data loads ── */
function skMetric() {
  return `<div class="sk-metric"><div class="skeleton sk-line sk-k"></div><div class="skeleton sk-line sk-v"></div></div>`;
}
function skCard(n, { chart = false } = {}) {
  const body = chart
    ? `<div class="skeleton sk-chart"></div>`
    : `<div class="mgrid">${Array.from({ length: n }, skMetric).join("")}</div>`;
  // No icon placeholder: headers lost their icons, so reserving space for one made the
  // title jump sideways the moment real content replaced the skeleton.
  return `<div class="card sk-card">
    <div class="sk-summary"><div class="skeleton sk-line sk-title"></div></div>
    <div class="card-body">${body}</div></div>`;
}
function dataSkeleton() {
  /* Wrapped in the same panel the real cards land in, so the skeleton takes the same
     measure — unwrapped it spanned the full pane and every card jumped left on arrival.
     data-section is not decoration: showView() toggles `.show` off every panel whose
     data-section does not match, so an unnamed wrapper is hidden the moment the reader
     clicks the rail and the pane goes blank mid-load. */
  return `<div class="data-section show" data-section="overview">${
    skCard(8) + skCard(0, { chart: true }) + skCard(6) + skCard(6)}</div>`;
}
function aiSkeleton() {
  const line = w => `<div class="skeleton sk-line" style="width:${w}"></div>`;
  const para = ws => `<div class="sk-para">${ws.map(line).join("")}</div>`;
  return `<div class="sk-prose">
    <div class="skeleton sk-line sk-h"></div>
    ${para(["100%", "96%", "88%", "70%"])}
    <div class="skeleton sk-line sk-h"></div>
    ${para(["94%", "100%", "82%"])}
    ${para(["98%", "90%", "76%", "58%"])}
  </div>`;
}

function runAnalysis() {
  // The input now accepts a ticker OR a company name; the server resolves it and the
  // real symbol comes back on the `result` event, at which point we re-key the session.
  const query = document.getElementById("ticker").value.trim();
  if (query.toLowerCase() === "/ilgar") { location.href = "/ilgar"; return; }
  // The header search exists on both pages; running an analysis is the analyzer's job, so
  // from the screener this hands the query over rather than half-rendering a dashboard
  // into a page that has no dashboard to render into.
  if (!IS_ANALYZER_PAGE) { if (query) gotoAnalyzer(query); return; }
  const profileSnapshot = getMySquallProfile();
  const profileKey = mySquallKey(profileSnapshot);
  activeScreen = null;
  document.getElementById("screenerView")?.classList.remove("show");
  if (!query) { showProgress(0, 7, "Enter a ticker or company name first", true); hideProgress(2200); return; }
  if (_es) { _es.close(); _es = null; }
  finalizePartialStream();

  // Analyze explicitly requests a new analysis. Saved research opens through the Saved menu.
  const direct = query.toUpperCase();
  // Courtesy pre-check only — it saves a wasted scrape on an obvious re-run. The server
  // holds the authoritative limits; this one is per-ticker, per-browser and trivially
  // bypassed, and it doesn't fire at all for company-name queries.
  const wait = /^[A-Z.\-]{1,10}$/.test(direct) ? analysisRunWait(direct) : 0;
  if (wait) {
    showProgress(0, 7, `You've run ${RUN_LIMIT} ${direct} analyses recently — reopen its saved tab, or try again in about ${wait} min.`, true);
    hideProgress(4200); return;
  }

  let key = direct;   // session key; updated to the resolved ticker on `result`
  setAnalyzeBusy(true);
  showWorkspace();
  showProgress(0, 7, "Starting analysis for " + query);

  document.getElementById("dataBody").innerHTML = dataSkeleton();
  renderLoadingRail();
  const ai = document.getElementById("aiSummary");
  ai.className = "prose"; ai.innerHTML = aiSkeleton();

  let streamUrl = "/analyze-stream?ticker=" + encodeURIComponent(query);
  if (profileSnapshot) streamUrl += "&profile=" + encodeURIComponent(JSON.stringify(profileSnapshot));
  const es = new EventSource(streamUrl);
  _es = es;
  let gotResult = false;

  es.addEventListener("progress", e => { const d = JSON.parse(e.data); showProgress(d.stage, d.total || 7, d.label); });

  es.addEventListener("error", e => {
    if (!e.data && gotResult) {   // terminal events close the stream themselves; this is a drop
      finalizePartialStream(key);
      if (_es === es) {
        showProgressPercent(100, "Dashboard ready · written analysis interrupted");
        hideProgress(900);
      }
      es.close(); if (_es === es) _es = null; setAnalyzeBusy(false); return;
    }
    let d = {};
    try { if (e.data) d = JSON.parse(e.data); } catch (x) {}

    // A rate/capacity limit is not a broken connection. Say so plainly and offer no
    // Retry button — retrying is exactly what the limit is asking them not to do.
    if (d.limited) {
      showProgress(0, 7, d.error, true);
      // Neutral, not a hue: a limit is informational, not directional, and --warn falls
      // to 3.7:1 on Daylight's surface. --ink holds >=5.18:1 in all six themes.
      document.getElementById("dataBody").innerHTML = `<div class="placeholder"><span style="color:var(--ink);font-family:var(--mono);font-size:12px">${esc(d.error)}</span></div>`;
      ai.className = "prose"; ai.innerHTML = `<div class="placeholder"><span>Written analysis paused — saved tabs still open instantly.</span></div>`;
      setAnalyzeBusy(false); es.close(); if (_es === es) _es = null; hideProgress(6000);
      return;
    }

    const msg = d.error || "Connection lost. Is the server running? (node server.js)";
    showProgress(0, 7, "Error: " + msg, true);
    document.getElementById("dataBody").innerHTML = `<div class="placeholder"><span style="color:var(--down);font-family:var(--mono);font-size:12px">${esc(msg)}</span>
      <button class="retry-btn" onclick="retryAnalysis('${jsAttr(query)}')">${RETRY_SVG}<span>Retry</span></button></div>`;
    ai.className = "prose"; ai.innerHTML = `<div class="placeholder"><span>Analysis unavailable — fix the error above and run again.</span></div>`;
    setAnalyzeBusy(false); es.close(); if (_es === es) _es = null; hideProgress(3000);
  });

  // Scraper finished — dashboard renders now; AI streams on top of it.
  es.addEventListener("result", e => {
    const data = JSON.parse(e.data);
    gotResult = true;
    key = data.ticker;   // resolved symbol — re-key so the AI-stream handlers below find the session
    const now = Date.now();
    sessions[data.ticker] = { data, context: data.ai_prompt || "", history: [], range: DEFAULT_RANGE,
      profile: profileSnapshot, profileKey, createdAt: now, updatedAt: now, fibAnchors: null };
    recordAnalysisRun(data.ticker);
    persistSessions();
    active = data.ticker;
    renderTickerPills();
    renderAll(data);
    if (active === data.ticker) showAiThinking(data.model);   // fill the pane instantly; ai_start replaces it
    setAnalyzeBusy(false);
    showProgressPercent(72, "Dashboard ready · preparing the written analysis");
  });

  es.addEventListener("ai_start", e => {
    const d = JSON.parse(e.data);
    _stream = { ticker: key, model: d.model, thinking: "", answer: "", answerStarted: false, done: false, sticky: true, raf: null };
    setModelTag(d.model);
    document.getElementById("aiModelTag")?.classList.add("live");
    setAnalysisStreaming(true);
    if (active === key) buildStreamShell();
    showProgressPercent(76, "Reviewing the compiled evidence");
  });

  es.addEventListener("ai_thinking", e => pushStream("thinking", JSON.parse(e.data).t));
  es.addEventListener("ai_delta",    e => pushStream("answer",   JSON.parse(e.data).t));

  es.addEventListener("ai_done", e => {
    const d = JSON.parse(e.data);
    const sess = sessions[key];
    if (sess) { sess.data.aiSummary = d.aiSummary; sess.data.aiReasoning = d.aiReasoning; sess.data.model = d.model; touchSession(sess); persistSessions(); }
    if (_stream) _stream.done = true;
    document.getElementById("aiModelTag")?.classList.remove("live");
    setAnalysisStreaming(false);
    if (active === key && sess) finalizeAiRender(sess.data);
    _stream = null;
    showProgressPercent(100, "Analysis complete");
    hideProgress(900);
    es.close(); if (_es === es) _es = null;
  });

  es.addEventListener("ai_error", e => {
    const d = JSON.parse(e.data);
    const sess = sessions[key];
    if (sess) {
      sess.data.aiError = d.error; sess.data.aiSummary = _stream?.answer || ""; sess.data.aiReasoning = _stream?.thinking || "";
      // A capacity limit is a different banner from a failed stream: there is nothing to
      // retry until the budget resets, so aiWarnHtml drops the Retry button.
      sess.data.aiLimited = Boolean(d.limited); sess.data.aiResetsAt = d.resets_at || null;
      touchSession(sess); persistSessions();
    }
    if (_stream) _stream.done = true;
    document.getElementById("aiModelTag")?.classList.remove("live");
    setAnalysisStreaming(false);
    if (active === key && sess) finalizeAiRender(sess.data);
    _stream = null;
    showProgressPercent(100, "Dashboard ready · written analysis unavailable");
    hideProgress(1600);
    es.close(); if (_es === es) _es = null;
  });
}

/* Bridges the gap between "dashboard ready" and the first AI token — shows the
   wind indicator immediately so the AI pane never flashes blank. */
const WIND_SVG = `<svg class="wind" viewBox="0 0 30 26" aria-hidden="true"><path d="M2 7 H17 a4 4 0 1 0 -4 -5"/><path d="M2 13 H24 a4 4 0 1 1 -4 5"/><path d="M2 19 H13 a3.2 3.2 0 1 1 -3.2 4"/></svg>`;
const RETRY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

// Re-run the full pipeline for a ticker after a failure. Clears any partial AI text
// so runAnalysis doesn't short-circuit to the cached-result path.
function retryAnalysis(t) {
  if (!t) return;
  if (sessions[t]) { sessions[t].data.aiSummary = ""; sessions[t].data.aiLimited = false; touchSession(sessions[t]); persistSessions(); }
  document.getElementById("ticker").value = t;
  runAnalysis();
}
// Shared AI-error banner (with a retry affordance) used by both the live stream and final render.
function aiWarnHtml(d) {
  if (!d || !d.aiError) return "";
  // Out of daily AI capacity: no Retry button. Retrying would re-spend a scrape and
  // still can't produce a write-up until the budget resets, and the message already
  // says the dashboard is live, so the usual suffix would be redundant.
  if (d.aiLimited) return `<div class="ai-warn">${esc(d.aiError)}</div>`;
  return `<div class="ai-warn">${esc(d.aiError)} — the data dashboard is still fully available.
    <button class="retry-btn" onclick="retryAnalysis('${jsAttr(d.ticker)}')">${RETRY_SVG}<span>Retry analysis</span></button></div>`;
}
// Rendered under every completed analysis — trust/compliance footer.
function aiDisclaimerHtml(d) {
  if (!d || !d.aiSummary) return "";
  return `<div class="ai-disclaimer">AI-generated analysis for informational purposes only — not financial advice. Verify figures against the source filings before acting.</div>`;
}
function showAiThinking(modelId) {
  const ai = document.getElementById("aiSummary");
  if (!ai) return;
  ai.className = "prose streaming";
  ai.innerHTML = `<div id="genIndicator">${WIND_SVG}<span id="genLabel">${esc(prettyModel(modelId))} is reading the data…</span></div>`;
  const scroll = document.getElementById("aiScroll");
  if (scroll) scroll.scrollTop = 0;
}

/* ── Streaming render machinery ── */
function buildStreamShell() {
  const ai = document.getElementById("aiSummary");
  ai.className = "prose streaming";
  const brain = `<svg class="brain" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18z"/></svg>`;
  const chev  = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  ai.innerHTML = `
    <div id="genIndicator">
      <svg class="wind" viewBox="0 0 30 26" aria-hidden="true"><path d="M2 7 H17 a4 4 0 1 0 -4 -5"/><path d="M2 13 H24 a4 4 0 1 1 -4 5"/><path d="M2 19 H13 a3.2 3.2 0 1 1 -3.2 4"/></svg>
      <span id="genLabel">${esc(prettyModel(_stream.model))} is reading the data…</span>
    </div>
    <div id="thinkingWrap">
      <button id="thinkingToggle" class="open live" onclick="toggleThinking(this)"><span class="live-dot"></span>${brain}<span class="tlabel">Thinking</span>${chev}</button>
      <div id="thinkingPanel" class="show"><span class="tk-label">Model reasoning · live</span><span id="thinkStream"></span></div>
    </div>
    <div id="answerStream"></div>`;
  flushStream(true);
}
function pushStream(kind, t) {
  if (!_stream || !t) return;
  _stream[kind] += t;
  if (kind === "thinking") {
    showProgressPercent(78 + Math.min(6, Math.floor(_stream.thinking.length / 800)), "Reasoning through the evidence");
  } else {
    showProgressPercent(85 + Math.min(14, Math.floor(_stream.answer.length / 450)), "Rendering the written analysis");
  }
  if (kind === "answer" && !_stream.answerStarted) {
    _stream.answerStarted = true;
    if (active === _stream.ticker) {
      document.getElementById("genIndicator")?.remove();
      const tog = document.getElementById("thinkingToggle"), panel = document.getElementById("thinkingPanel");
      if (tog) { tog.classList.remove("open", "live"); const l = tog.querySelector(".tlabel"); if (l) l.textContent = "Show thinking"; }
      panel?.classList.remove("show");
    }
  }
  if (kind === "thinking" && active === _stream.ticker) {
    const lbl = document.getElementById("genLabel"); if (lbl) lbl.textContent = prettyModel(_stream.model) + " is reasoning…";
  }
  if (!_stream.raf) _stream.raf = requestAnimationFrame(flushStream);
}
function flushStream(force) {
  if (!_stream) return;
  _stream.raf = null;
  if (active !== _stream.ticker && force !== true) return;   // pane shows another ticker — buffers keep accumulating
  const think = document.getElementById("thinkStream");
  if (think) { think.textContent = _stream.thinking;
    const panel = document.getElementById("thinkingPanel");
    if (panel && panel.classList.contains("show")) panel.scrollTop = panel.scrollHeight; }
  const ans = document.getElementById("answerStream");
  if (ans && _stream.answerStarted) ans.innerHTML = renderMarkdown(_stream.answer);
  const scroll = document.getElementById("aiScroll");
  if (_stream.sticky && scroll) scroll.scrollTop = scroll.scrollHeight;
}
// If the reader scrolls up mid-stream, stop yanking them to the bottom; resume when they return.
on("aiScroll", "scroll", function () {
  if (!_stream || _stream.done) return;
  _stream.sticky = (this.scrollHeight - this.scrollTop - this.clientHeight) < 60;
});
function finalizeAiRender(d) {
  const ai = document.getElementById("aiSummary");
  const scroll = document.getElementById("aiScroll");
  const keep = scroll.scrollTop;
  ai.className = "prose";
  ai.innerHTML = aiWarnHtml(d) + thinkingBlock(d.aiReasoning) + renderAnalysisBody(d.aiSummary) + aiDisclaimerHtml(d);
  scroll.scrollTop = keep;
}

/* ════════════════ HOME / WORKSPACE NAVIGATION ════════════════ */
/* ── Cross-page navigation ────────────────────────────────────────────────────
   The analyzer and the screener are two URLs now, so "switch view" is sometimes a real
   navigation. Each entry point below asks which page it is on: on the right one it does the
   in-page work it always did, on the wrong one it hands off through the URL and the
   deep-link handler at the bottom of this file picks the state back up on arrival. Saved
   tabs and MySquall survive the trip because they were always localStorage, not memory. */
function gotoScreener(id) { location.href = id ? `/screener?id=${encodeURIComponent(id)}` : "/screener"; }
function gotoAnalyzer(ticker) { location.href = ticker ? `/?t=${encodeURIComponent(ticker)}` : "/"; }

function goHome() {
  if (!IS_ANALYZER_PAGE) return gotoAnalyzer();   // the wordmark is a link home from secondary pages
  const ws = document.getElementById("workspace"), hero = document.getElementById("hero");
  const screen = document.getElementById("screenerView");
  if (!ws.classList.contains("show") && !screen?.classList.contains("show")) return;
  ws.classList.add("leaving");
  setTimeout(() => {
    ws.classList.remove("show", "leaving");
    screen?.classList.remove("show"); activeScreen = null;
    clearTickerBar();
    hero.style.display = "";
    hero.style.animation = "none"; void hero.offsetWidth; hero.style.animation = "";   // replay entrance
    document.getElementById("resumeChip").classList.toggle("show", Object.keys(sessions).length + Object.keys(screeners).length > 0);
    focusHeroSearch();
  }, 290);
}
function showWorkspace(skipAnim) {
  const ws = document.getElementById("workspace"), hero = document.getElementById("hero");
  document.getElementById("screenerView")?.classList.remove("show"); activeScreen = null;
  syncPaneVisibility();   // the skeleton renders before any renderAll; unhidden panes overlap
  if (ws.classList.contains("show")) { if (hero.style.display !== "none") hero.style.display = "none"; return; }
  const reveal = () => { hero.style.display = "none"; hero.classList.remove("leaving"); ws.classList.add("show"); if (active) requestAnimationFrame(drawChart); };
  if (skipAnim || hero.style.display === "none") reveal();
  else { hero.classList.add("leaving"); setTimeout(reveal, 260); }
}
function resumeSavedWorkspace() {
  const latestAnalysis = Object.keys(sessions).sort((a, b) => sessions[b].updatedAt - sessions[a].updatedAt)[0];
  const latestScreen = Object.keys(screeners).sort((a, b) => screeners[b].updatedAt - screeners[a].updatedAt)[0];
  if (latestScreen && (!latestAnalysis || screeners[latestScreen].updatedAt > sessions[latestAnalysis].updatedAt)) { openSavedScreener(latestScreen); return; }
  if (!active || !sessions[active]) active = latestAnalysis || null;
  if (!active) return;
  showWorkspace(true); renderTickerPills(); renderAll(sessions[active].data);
}

/* ════════════════ NATURAL-LANGUAGE MULTI-INDEX SCREENER ════════════════ */
const SCREEN_CONCEPT_LABELS = {
  consolidation: "Consolidation", volatility_contraction: "Shrinking volatility", uptrend: "Uptrend",
  vcp:"Volatility contraction pattern (VCP)", cup_and_handle:"Cup with handle",
  flat_base:"Flat base", double_bottom:"Double bottom", bull_flag:"Bull flag",
  downtrend:"Downtrend", accumulation: "Accumulation", distribution:"Distribution", breakout: "Breakout", momentum: "Momentum",
  relative_strength:"Relative strength", risk_adjusted_momentum:"Efficient momentum", near_highs: "Near 52-week highs",
  low_volatility: "Lower volatility", high_volatility:"Higher volatility", trend_stability:"Stable trend",
  oversold: "Oversold pullback", recovery:"Early recovery", pullback_to_ma:"Pullback to support", golden_cross:"Golden cross",
  volume_surge:"Unusual volume", volume_dryup:"Quiet volume", value: "Value", growth: "Growth", profitability:"Profitability",
  quality: "Business quality", balance_sheet:"Balance sheet", cash_generation:"Cash generation", high_margin:"High margins",
  income: "Income", analyst_upside:"Analyst upside", insider_ownership:"Insider ownership",
  institutional_ownership:"Institutional ownership", mega_cap:"Mega-cap", smaller_cap:"Smaller companies",
  profitable_growth:"Profitable growth", garp:"Growth at a reasonable price", quality_value:"Quality value",
  steady_compounder:"Steady compounder", defensive_quality:"Defensive quality", speculative_growth:"Speculative growth",
  revenue_growth:"Revenue growth", earnings_growth:"Earnings growth", high_roe:"High return on equity",
  fcf_yield:"Free-cash-flow yield", cash_rich:"Cash-rich", low_debt:"Low debt",
  capital_efficiency:"Capital efficiency", dividend_quality:"Dividend quality", liquidity:"Trading liquidity",
  options_liquidity_proxy:"Options-liquidity proxy", low_beta:"Lower beta", high_beta:"Higher beta",
  high_short_interest:"High short interest", squeeze:"Technical squeeze", bullish_pullback:"Healthy pullback",
  mean_reversion:"Mean-reversion setup", turnaround:"Turnaround setup", technical_strength:"Technical strength",
  short_squeeze_setup:"Short-squeeze setup"
};
function openScreener() {
  // From the analyzer this is a link, not a view swap — there is nothing here to reveal.
  if (!IS_SCREENER_PAGE) return gotoScreener();
  document.getElementById("screenerView")?.classList.add("show");
  renderTickerPills();
  setTimeout(() => document.getElementById("screenQuery")?.focus(), 0);
}
function openSavedScreener(id) {
  if (!IS_SCREENER_PAGE) return gotoScreener(id);
  const s = screeners[id]; if (!s) return;
  activeScreen = id; active = null; openScreener();
  document.getElementById("screenQuery").value = s.query;
  document.getElementById("screenUniverse").value = s.universe || s.spec?.universe_id || "combined";
  renderSavedScreener(s); renderTickerPills();
}
function showScreenProgress(percent, label, isErr = false) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const wrap = document.getElementById("screenProgress");
  wrap.classList.add("show");
  wrap.classList.toggle("error", isErr);
  document.getElementById("screenProgressText").textContent = label || "Preparing the screen…";
  document.getElementById("screenProgressPct").textContent = isErr ? "—" : pct + "%";
  document.getElementById("screenProgressFill").style.width = pct + "%";
  wrap.querySelector('[role="progressbar"]')?.setAttribute("aria-valuenow", String(pct));
}
function hideScreenProgress(delay = 650) {
  setTimeout(() => {
    document.getElementById("screenProgress").classList.remove("show", "error");
    document.getElementById("screenProgressFill").style.width = "0%";
  }, delay);
}
function applyScreenProgressEvent(data, fallback) {
  const pct = isNum(data.percent)
    ? data.percent
    : Math.round((Number(data.stage) || 0) / Math.max(1, Number(data.total) || 1) * 100);
  showScreenProgress(pct, data.label || fallback);
}
function deleteScreener(id) {
  if (!screeners[id]) return;
  delete screeners[id];
  if (activeScreen === id) {
    activeScreen = null;
    const next = Object.keys(screeners).sort((a, b) => screeners[b].updatedAt - screeners[a].updatedAt)[0];
    if (next) { persistScreeners(); openSavedScreener(next); return; }
    document.getElementById("screenInterpretation").innerHTML = "";
    document.getElementById("screenResults").innerHTML = "";
    goHome();
  }
  persistScreeners(); renderTickerPills();
}
function screenPct(v) { return isNum(v) ? (v * 100).toFixed(1) + "%" : "N/A"; }
function screenSourceLabel(source) {
  return ({ rules:"Rule-based interpretation", ai:"AI-assisted interpretation",
    "rules + follow-up":"Rule-based revision", "ai + follow-up":"AI-assisted revision" })[source] || "Measured recipe";
}
function renderScreenRecipe(spec) {
  if (!spec) return "";
  const concepts = (spec.concepts || []).map(c => `<div class="recipe-chip"><b>${esc(SCREEN_CONCEPT_LABELS[c.id] || c.id)}</b><span>${c.source === "profile" ? "MySquall tilt · " : ""}${c.required ? "required · " : ""}${(Number(c.weight) || 1).toFixed(2)}× weight</span></div>`).join("");
  const filters = Object.entries(spec.filters || {}).filter(([, v]) => v !== null && v !== "" && v !== undefined)
    .map(([k, v]) => `<div class="recipe-chip"><b>${esc(k.replaceAll("_", " "))}</b><span>${esc(Array.isArray(v) ? v.join(", ") : v)}</span></div>`).join("");
  const adjustments = (spec.profile_adjustments || []).map(a => `<div class="recipe-adjust">Profile preference · ${esc(a)}</div>`).join("");
  const window = spec.settings?.consolidation_window;
  const definitions = (spec.definitions || []).map(d => `<details class="recipe-definition"><summary>${esc(d.label || SCREEN_CONCEPT_LABELS[d.id] || d.id)}<span>Measurement</span></summary><p>${esc(d.definition)}</p></details>`).join("");
  const definition = (spec.concepts || []).some(c => c.id === "consolidation")
    ? `<div class="recipe-adjust">Profile-adjusted structure window · ${esc(window || 30)} trading days</div>` : "";
  const momentumWindow = (spec.concepts || []).some(c => c.id === "momentum")
    ? `<div class="recipe-adjust">Profile-adjusted momentum window · ${esc(spec.settings?.momentum_window || 60)} trading days</div>` : "";
  const theme = spec.theme && Array.isArray(spec.theme.keywords) && spec.theme.keywords.length ? spec.theme : null;
  const themeChip = theme
    ? `<div class="recipe-chip theme-chip"><b>Theme · ${esc(theme.label || "Theme")}</b><span>${esc(theme.keywords.slice(0, 8).join(", "))} · minimum evidence ${esc(theme.min_score || 24)}/100${theme.exclude_keywords?.length ? ` · excludes ${esc(theme.exclude_keywords.join(", "))}` : ""}</span></div>` : "";
  const themeNote = theme
    ? `<div class="recipe-adjust theme-note">Theme matching reads each company's business description, which reflects its established operations — it may miss very recent developments such as new products, pivots, or last week's news.</div>` : "";
  return `<div class="recipe"><div class="recipe-top"><div><h2>${esc(spec.title || "Screening criteria")}</h2><p>${esc(spec.summary || "Your request translated into measurable rules.")}</p></div><span class="recipe-source">${esc(screenSourceLabel(spec.interpretation_source))}</span></div><div class="recipe-chips">${themeChip}${concepts}${filters}</div>${adjustments}${definition}${momentumWindow}${themeNote}<div class="recipe-definitions">${definitions}</div><div class="recipe-adjust recipe-scorenote">The <b>match score</b> shows how closely a company fits these criteria. It is not a recommendation or a price forecast.</div></div>`;
}
// Per-result breakdown of the components behind the match score: the theme
// relevance (if any) plus each concept's 0-100 sub-score. Makes the circle
// number legible instead of opaque. Weights (from the recipe) show on hover.
function scoreBar(label, value, kind, weight) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const wt = isNum(weight) ? ` · ${Number(weight).toFixed(2)}× weight` : "";
  return `<div class="sb-row ${kind}" title="${esc(label)}: ${Math.round(pct)}/100${wt}"><span class="sb-label">${esc(label)}</span><span class="sb-bar"><b style="width:${pct}%"></b></span><span class="sb-val">${Math.round(pct)}</span></div>`;
}
function scoreBreakdown(r, spec) {
  const rows = [];
  const themeLabel = spec && spec.theme && spec.theme.label;
  if (isNum(r.theme_score) && themeLabel) rows.push(scoreBar(themeLabel, r.theme_score, "theme"));
  const weights = {};
  (spec && Array.isArray(spec.concepts) ? spec.concepts : []).forEach(c => { weights[c.id] = c.weight; });
  Object.entries(r.concept_scores || {}).forEach(([id, v]) =>
    rows.push(scoreBar(SCREEN_CONCEPT_LABELS[id] || id, v, "concept", weights[id])));
  if (!rows.length) return "";
  const blend = isNum(r.theme_score) ? "0.55 × theme + 0.45 × concepts" : "weighted average of concepts";
  return `<div class="score-breakdown"><div class="sb-head" title="Match score = ${blend}">Score breakdown</div>${rows.join("")}</div>`;
}
function renderScreenResults(result) {
  if (!result) return "";
  const rows = result.results || [];
  const spec = result.spec || {};
  const coverage = result.coverage || {};
  const coverageHtml = `<p class="learn-note">${esc(result.universe_scored ?? "Unknown")} of ${esc(result.universe_requested ?? "unknown")} companies have market data. ${isNum(coverage.evaluated) ? `${coverage.evaluated} fully evaluated; ${coverage.missing_data || 0} excluded for missing data; ${coverage.not_applicable || 0} require a different financial model; ${coverage.failed_filters || 0} failed filters; ${coverage.failed_criteria || 0} failed theme or score criteria.` : "Criterion-level coverage unavailable for this saved screen; rerun to check."}${result.throttled ? " Provider throttling reduced coverage." : ""}${result.generated_at ? ` Screen generated ${esc(result.generated_at)}.` : ""}</p>`;
  if (!rows.length) return coverageHtml + `<div class="screen-empty"><b>No verified matches in the available data.</b><span>Check coverage above before changing your criteria. Missing or inapplicable data is not a failed investment criterion.</span></div>`;
  const cards = rows.map((r, i) => `<article class="screen-result" style="--i:${i}"><div class="screen-result-top"><button class="screen-symbol" type="button" onclick="analyzeFromScreener('${jsAttr(r.ticker)}')">${esc(r.ticker)}</button><div class="screen-name"><b>${esc(r.name || r.ticker)}</b><span>${esc([(r.indexes || []).join(" / "), r.sector, r.industry].filter(Boolean).join(" · "))}</span></div><div class="match-score" data-score="${Math.round(r.match_score)}" title="Match score: fit with this screen, not an investment rating">${Math.round(r.match_score)}</div></div><div class="screen-metrics"><div class="screen-metric"><small>Price</small><b>${fUsd(r.price)}</b></div><div class="screen-metric"><small>20-day return</small><b class="${signCls(r.return_20d)}">${screenPct(r.return_20d)}</b></div><div class="screen-metric"><small>Below 52-week high</small><b>${screenPct(r.distance_52w_high)}</b></div></div>${scoreBreakdown(r, spec)}<div class="screen-reasons">${(r.reasons || []).map(x => `<p class="screen-reason">${esc(x)}</p>`).join("")}</div></article>`).join("");
  return `<div class="screen-results-head"><h2>${rows.length} matches</h2><span>${esc(result.universe || spec.universe_label || "the selected universe")}${result.cache_hit ? " · cached market data" : ""}</span></div>${coverageHtml}<div class="screen-grid">${cards}</div>`;
}
/* Paint results and bring them to life: each match ring sweeps 0→score while
   the number counts up. Skipped (values set instantly) under reduced motion. */
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");
function animateScoreRing(ring, delayMs) {
  const target = Math.max(0, Math.min(100, Number(ring.dataset.score) || 0));
  if (REDUCED_MOTION.matches) { ring.style.setProperty("--ring", target + "%"); return; }
  if (ring._ringRun) return;                                    // a reveal never replays
  ring._ringRun = true;
  ring.textContent = "0"; ring.style.setProperty("--ring", "0%");
  const t0 = performance.now() + delayMs;
  (function step(now) {
    const p = Math.max(0, Math.min(1, (now - t0) / 750));
    const v = (1 - Math.pow(1 - p, 3)) * target;                // ease-out cubic
    ring.textContent = String(Math.round(v));
    ring.style.setProperty("--ring", v + "%");
    if (p < 1) requestAnimationFrame(step);
  })(performance.now());
}

/* ── Scroll reveal ───────────────────────────────────────────────────────────
   #screenerView is its own scroll container, so it is the observer root. Only
   elements below the first screenful are deferred; whatever is already on screen
   keeps the render-time cascade, so the results still land as one piece.
   Deferring is purely additive — if IntersectionObserver is missing or motion is
   reduced, nothing is tagged and every card renders exactly as it did before. */
let _screenRevealObs = null;
function screenRevealObserver() {
  if (_screenRevealObs) return _screenRevealObs;
  const root = document.getElementById("screenerView");
  if (!root || !("IntersectionObserver" in window)) return null;
  _screenRevealObs = new IntersectionObserver((entries, obs) => {
    // Stagger within the batch (a grid row reveals together), capped so a fast
    // flick doesn't queue up a visible backlog of delayed cards.
    entries.filter(e => e.isIntersecting).forEach((e, k) => {
      const el = e.target, wait = Math.min(k, 3) * 55;
      obs.unobserve(el);
      setTimeout(() => {
        el.classList.add("in");
        const ring = el.querySelector(".match-score[data-score]");
        if (ring) animateScoreRing(ring, 90);
      }, wait);
    });
  }, { root, threshold: .12 });
  return _screenRevealObs;
}
/* Returns the elements it deferred, so callers can skip their own entrance work. */
function deferBelowFold(els) {
  const view = document.getElementById("screenerView");
  const obs = screenRevealObserver();
  if (!obs || !view || REDUCED_MOTION.matches) return new Set();
  const fold = view.getBoundingClientRect().bottom - 40;       // one layout read for the batch
  const deferred = new Set();
  els.forEach(el => {
    if (el.getBoundingClientRect().top <= fold) return;         // already in view
    el.classList.add("screen-reveal");
    obs.observe(el);
    deferred.add(el);
  });
  return deferred;
}

function paintScreenResults(result) {
  const el = document.getElementById("screenResults");
  el.innerHTML = renderScreenResults(result);
  const deferred = deferBelowFold([...el.querySelectorAll(".screen-result")]);
  let shown = 0;
  el.querySelectorAll(".screen-result").forEach(card => {
    if (deferred.has(card)) return;                             // its ring runs on reveal
    const ring = card.querySelector(".match-score[data-score]");
    if (ring) animateScoreRing(ring, Math.min(shown++, 14) * 35 + 120);
  });
}
function renderSavedScreener(s) {
  document.getElementById("screenInterpretation").innerHTML = renderScreenRecipe(s.spec);
  paintScreenResults(s.result);
  renderScreenRefine(s);
}
function analyzeFromScreener(ticker) {
  document.getElementById("ticker").value = ticker;
  runAnalysis();
}
function runScreener() {
  const query = document.getElementById("screenQuery").value.trim();
  if (query.toLowerCase() === "/ilgar") { location.href = "/ilgar"; return; }
  const universe = document.getElementById("screenUniverse").value || "combined";
  if (query.length < 3) { showScreenProgress(0, "Describe the companies you want to find in a little more detail.", true); hideScreenProgress(2400); return; }
  if (_screenES) _screenES.close();
  openScreener();
  const id = "screen-" + Date.now().toString(36), now = Date.now();
  const s = screeners[id] = { id, query, universe, title: "New stock screen", spec: null, result: null, history:[], profile: getMySquallProfile(), createdAt: now, updatedAt: now, loading: true };
  activeScreen = id;
  document.getElementById("screenRun").disabled = true;
  showScreenProgress(2, "Interpreting your request");
  document.getElementById("screenInterpretation").innerHTML = ""; document.getElementById("screenResults").innerHTML = ""; document.getElementById("screenRefine").innerHTML = "";
  renderTickerPills();
  let url = "/screen-stream?q=" + encodeURIComponent(query) + "&universe=" + encodeURIComponent(universe);
  if (s.profile) url += "&profile=" + encodeURIComponent(JSON.stringify(s.profile));
  const es = _screenES = new EventSource(url);
  const finish = (delay = 650) => { s.loading = false; s.updatedAt = Date.now(); document.getElementById("screenRun").disabled = false; hideScreenProgress(delay); persistScreeners(); renderScreenRefine(s); renderTickerPills(); es.close(); if (_screenES === es) _screenES = null; };
  es.addEventListener("screen_progress", e => applyScreenProgressEvent(JSON.parse(e.data), "Screening the selected universe"));
  es.addEventListener("screen_interpretation", e => { const d = JSON.parse(e.data); s.spec = d.spec || d; s.title = s.spec.title || "Saved stock screen"; s.updatedAt = Date.now(); document.getElementById("screenInterpretation").innerHTML = renderScreenRecipe(s.spec); persistScreeners(); renderTickerPills(); });
  es.addEventListener("screen_result", e => { s.result = JSON.parse(e.data); const count=(s.result.results||[]).length; if (!s.history.length) s.history.push({role:"assistant",content:count ? `This screen returned ${count} matches. Describe anything that should be broader, stricter, added, or removed, and the criteria will be rescored.` : "No companies met every required condition. You can broaden the threshold, remove a requirement, or emphasize a different factor without accepting weaker matches automatically."}); showScreenProgress(97, `Rendering ${count} matches`); paintScreenResults(s.result); renderScreenRefine(s); requestAnimationFrame(() => showScreenProgress(100, `Screen complete · ${count} matches`)); finish(900); });
  es.addEventListener("screen_error", e => { let msg = "The screen could not be completed."; try { msg = JSON.parse(e.data).error || msg; } catch (_) {} document.getElementById("screenResults").innerHTML = `<div class="screen-empty"><b>Screen unavailable</b><span>${esc(msg)}</span></div>`; showScreenProgress(0, msg, true); finish(2200); });
  es.onerror = () => { if (_screenES === es) { document.getElementById("screenResults").innerHTML = `<div class="screen-empty"><b>Connection lost</b><span>Confirm that the Squall server is running, then try again.</span></div>`; showScreenProgress(0, "Connection lost before the screen completed.", true); finish(2200); } };
}
function renderScreenRefine(s) {
  const el = document.getElementById("screenRefine"); if (!el) return;
  if (!s?.spec) { el.innerHTML=""; return; }
  const messages=(s.history||[]).map(m => `<div class="screen-chat-msg ${m.role}"><span>${m.role === "user" ? "You" : "Squall"}</span><p>${esc(m.content)}</p></div>`).join("");
  el.innerHTML=`<section class="screen-refine"><div class="screen-refine-head"><div><h2>Adjust this screen</h2><p>Describe what should be broader, stricter, added, or removed. The same market universe will be rescored.</p></div><span>${(s.result?.results||[]).length} current matches</span></div><div class="screen-chat-messages">${messages}</div><div class="screen-refine-prompts"><button type="button" onclick="refineScreener('Broaden the criteria and remove unnecessary hard requirements')">Broaden criteria</button><button type="button" onclick="refineScreener('Limit the results to the strongest matches')">Show strongest matches</button><button type="button" onclick="refineScreener('Place more emphasis on relative strength')">Emphasize relative strength</button><button type="button" onclick="refineScreener('Require unusual trading volume')">Require unusual volume</button></div><form class="screen-refine-form" onsubmit="event.preventDefault(); refineScreener(this.elements.message.value)"><input name="message" maxlength="500" autocomplete="off" placeholder="For example: remove value, emphasize cash flow, or make the pattern requirement less strict" aria-label="Adjust this stock screen"><button type="submit" ${s.loading ? "disabled" : ""}>${s.loading ? "Updating…" : "Apply changes"}</button></form></section>`;
  const messagesEl=el.querySelector(".screen-chat-messages"); if(messagesEl) messagesEl.scrollTop=messagesEl.scrollHeight;
  // Sits below a full grid of matches, so on a fresh screen it is almost always off-screen.
  deferBelowFold([el.querySelector(".screen-refine")].filter(Boolean));
}
function refineScreener(rawMessage) {
  const message=String(rawMessage||"").trim(), s=screeners[activeScreen];
  if (!s || !s.spec || message.length < 2 || s.loading) return;
  if (_screenES) _screenES.close();
  s.history=(s.history||[]).concat({role:"user",content:message}).slice(-20); s.loading=true; s.updatedAt=Date.now();
  renderScreenRefine(s); persistScreeners();
  showScreenProgress(2, "Revising the measurable criteria");
  const universe=s.universe||s.spec?.universe_id||"combined";
  let url="/screen-stream?q="+encodeURIComponent(message)+"&universe="+encodeURIComponent(universe)+"&existing="+encodeURIComponent(JSON.stringify(s.spec))+"&result_count="+encodeURIComponent((s.result?.results||[]).length);
  if(s.profile) url+="&profile="+encodeURIComponent(JSON.stringify(s.profile));
  const es=_screenES=new EventSource(url); let reply="";
  const finish=(delay=650)=>{s.loading=false;s.updatedAt=Date.now();hideScreenProgress(delay);persistScreeners();renderScreenRefine(s);renderTickerPills();es.close();if(_screenES===es)_screenES=null;};
  es.addEventListener("screen_progress",e=>applyScreenProgressEvent(JSON.parse(e.data),"Rescoring the selected universe"));
  es.addEventListener("screen_reply",e=>{reply=JSON.parse(e.data).reply||"";});
  es.addEventListener("screen_interpretation",e=>{s.spec=JSON.parse(e.data);s.title=s.spec.title||s.title;document.getElementById("screenInterpretation").innerHTML=renderScreenRecipe(s.spec);renderTickerPills();});
  es.addEventListener("screen_result",e=>{s.result=JSON.parse(e.data);const count=(s.result.results||[]).length;s.history.push({role:"assistant",content:reply||`The revised screen returned ${count} matches.`});s.history=s.history.slice(-20);showScreenProgress(97,`Rendering ${count} matches`);paintScreenResults(s.result);requestAnimationFrame(()=>showScreenProgress(100,`Screen updated · ${count} matches`));finish(900);});
  es.addEventListener("screen_error",e=>{let msg="The revised screen could not be completed.";try{msg=JSON.parse(e.data).error||msg;}catch(_){}s.history.push({role:"assistant",content:msg});showScreenProgress(0,msg,true);finish(2200);});
  es.onerror=()=>{if(_screenES===es){s.history.push({role:"assistant",content:"The connection ended before the revised screen completed. Please apply the change again."});showScreenProgress(0,"Connection lost before the revised screen completed.",true);finish(2200);}};
}
document.querySelectorAll("[data-screen-example]").forEach(button => button.addEventListener("click", () => { document.getElementById("screenQuery").value = button.dataset.screenExample; document.getElementById("screenQuery").focus(); }));

/* ════════════════ RENDER HELPERS ════════════════ */
/* The `icon` parameter and the `I` map of section SVGs are gone: an icon on every one of
   19 headers is decoration when the header already names the section. The `--d` stagger
   went with them — it only ever fed the entrance cascade, and nothing reads it now. */
function card(id, title, bodyHtml, { open = true, count = null, source = null } = {}) {
  const src = source
    ? `<span class="src" data-src="${source.kind}" title="Extracted from ${esc(source.label)}">${esc(source.label)}</span>` : "";
  return `<details class="card" id="card-${id}" ${open ? "open" : ""}>
    <summary><span>${title}</span>${count !== null ? `<span class="count">${count}</span>` : ""}${src}
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </summary><div class="card-body">${bodyHtml}</div></details>`;
}
/* Provenance for the two extraction paths the payload declares outright: the SEC EDGAR
   filing read, and the price history yahooquery pulled. Read from d.data_sources rather
   than hardcoded, so a card says "Finnhub" on the runs where history came from the
   recovery path instead of Yahoo.
   Valuation, Profitability and Financial Health are deliberately left unbadged — those
   metrics fall back per-field across yahooquery → Finnhub → FMP, so no single source
   label would be true for the whole card. */
const YQ_SRC = { kind: "market", label: "Yahoo Finance" };          // pulled from yahooquery directly
function secSrc(d) {
  return d.sec_available === false ? null : { kind: "sec", label: d.data_sources?.sec || "SEC EDGAR" };
}
function histSrc(d) {
  const h = d.data_sources?.history;
  if (!h || h === "Unavailable") return null;
  return { kind: "market", label: h === "Yahoo" ? "Yahoo Finance" : h };
}
// Strip badge only when results are imminent; a routine report months out is not news.
function eventBadge(er) {
  if (!er || !er.imminent || !Array.isArray(er.earnings_window)) return "";
  const label = er.earnings_window_already_open ? "Results due now" : `Results in ~${er.days_until_earnings_window_opens}d`;
  return `<span class="regime-badge event-badge" title="Estimated results window ${esc(er.earnings_window[0])} to ${esc(er.earnings_window[1])}, from SEC filing cadence; not a confirmed date">${label}</span>`;
}
const metric = (label, value, cls = "") => `<div class="metric"><span class="k">${label}</span><span class="v ${cls}">${value}</span></div>`;
function rangeBar(title, lo, hi, val, fmt = fUsd, altVal = null, altName = "") {
  if (!isNum(lo) || !isNum(hi) || !isNum(val) || hi <= lo) return "";
  const pos = Math.min(100, Math.max(0, ((val - lo) / (hi - lo)) * 100));
  let alt = "";
  if (isNum(altVal)) { const ap = Math.min(100, Math.max(0, ((altVal - lo) / (hi - lo)) * 100));
    alt = `<div class="rb-marker alt" style="left:${ap}%" title="${altName}: ${fmt(altVal)}"></div>`; }
  return `<div class="rangebar"><div class="rb-title">${title}</div>
    <div class="rb-labels"><span>${fmt(lo)}</span><b>${fmt(val)}</b><span>${fmt(hi)}</span></div>
    <div class="rb-track"><div class="rb-fill" style="left:0;width:${pos}%"></div>${alt}<div class="rb-marker" style="left:${pos}%"></div></div></div>`;
}
function signalClass(text) { const t = String(text).toUpperCase();
  if (/(BULLISH|FUNDAMENTAL VALUE|BEAT|GOLDEN CROSS|INSIDER BUYING|DOUBLE BOTTOM|UPTREND|AT SUPPORT|BASE FORMATION|ACCUMULATION|OBV RISING|UP-VOLUME)/.test(t)) return "green";
  if (/(RED FLAG|BEARISH|EXTREME|MISSED|DEATH CROSS|NET LOSS|DECLINING|HEAVY INSIDER SELLING|DOUBLE TOP|DOWNTREND|DISTRIBUTION|OBV FALLING|DOWN-VOLUME)/.test(t)) return "red";
  if (/(WARNING|WEAK|FAKE|EXPENSIVE|RECOVERY|STRETCH|SHORT|CYCLE|OVERSOLD|OVERBOUGHT|SQUEEZE|LEVERAGE|ACTIVIST|AT RESISTANCE|VOLUME|NEGATIVE PEG|SIDEWAYS|RANGE|TRANSITION|CHANGE OF CHARACTER|BREAK OF STRUCTURE)/.test(t)) return "amber";
  return "neutral"; }
function signalHtml(s) { const m = String(s).match(/^([^:]+):\s*(.*)$/);
  const inner = m ? `<b>${esc(m[1])}:</b>&nbsp;<span>${esc(m[2])}</span>` : esc(s);
  return `<div class="signal ${signalClass(s)}">${inner}</div>`; }

/* ════════════════ SAVED ANALYSIS TABS ════════════════ */
function renderTickerPills() {
  const items = [
    ...Object.keys(sessions).map(key => ({ kind: "analysis", key, at: sessions[key].createdAt })),
    ...Object.keys(screeners).map(key => ({ kind: "screen", key, at: screeners[key].createdAt }))
  ].sort((a, b) => a.at - b.at);
  const el = document.getElementById("analysisTabs");
  if (!el) return;
  el.innerHTML = items.map(item => {
    const s = item.kind === "analysis" ? sessions[item.key] : screeners[item.key];
    const when = new Date(s.createdAt || Date.now()).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const label = item.kind === "analysis" ? item.key : (s.title || "Saved screen");
    const selected = item.kind === "analysis" ? (!activeScreen && item.key === active) : item.key === activeScreen;
    return `<div class="analysis-tab ${item.kind === "screen" ? "screener-tab" : ""} ${selected ? "active" : ""}" data-kind="${item.kind}" data-key="${esc(item.key)}">
      <button class="analysis-tab-main" type="button" title="Open saved ${item.kind}"><b>${item.kind === "screen" ? "Screen · " : ""}${esc(label)}</b><span>${esc(when)}</span></button>
      <button class="analysis-tab-close" type="button" aria-label="Delete saved ${esc(label)}" title="Delete this saved item">×</button>
    </div>`;
  }).join("");
  el.querySelectorAll(".analysis-tab").forEach(tab => {
    tab.querySelector(".analysis-tab-main").onclick = () => { closeSavedMenu(false);
      return tab.dataset.kind === "screen" ? openSavedScreener(tab.dataset.key) : switchTicker(tab.dataset.key); };
    tab.querySelector(".analysis-tab-close").onclick = () => tab.dataset.kind === "screen" ? deleteScreener(tab.dataset.key) : deleteSession(tab.dataset.key);
  });
  document.getElementById("resumeChip")?.classList.toggle("show", items.length > 0);
  // The rail button carries the count so the popover does not have to be opened to learn
  // there is nothing in it. Both button and its divider go when the store is empty.
  const savedBtn = document.getElementById("savedBtn"), savedCount = document.getElementById("savedCount");
  if (savedCount) savedCount.textContent = items.length ? String(items.length) : "";
  if (savedBtn) savedBtn.hidden = items.length === 0;
  const savedDiv = document.getElementById("savedDiv");
  if (savedDiv) savedDiv.hidden = items.length === 0;
  if (!items.length) closeSavedMenu(false);
  // The compare menu lists saved analyses, so it goes stale on exactly the events that
  // rebuild these pills. No-ops on /screener, which has no chart chrome to write.
  syncChartChrome();
}

/* Saved-work popover — the same open/close/roving-focus contract as #themeMenu, because a
   second popover that behaves differently from the first is a second thing to learn. Both
   elements ship in partials/chrome-top.html, so they exist on every page and a top-level
   listener here is safe; `on` is used anyway so that stays true if a page ever drops the
   partial. */
const savedMenuOpen = () => document.getElementById("savedMenu")?.classList.contains("open") || false;
function openSavedMenu() {
  const menu = document.getElementById("savedMenu"), btn = document.getElementById("savedBtn");
  if (!menu || !btn) return;
  menu.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  menu.querySelector(".analysis-tab.active .analysis-tab-main, .analysis-tab-main")?.focus();
}
function closeSavedMenu(refocus) {
  const menu = document.getElementById("savedMenu"), btn = document.getElementById("savedBtn");
  if (!menu || !menu.classList.contains("open")) return;
  menu.classList.remove("open");
  btn?.setAttribute("aria-expanded", "false");
  if (refocus && btn && !btn.hidden) btn.focus();
}
on("savedBtn", "click", () => savedMenuOpen() ? closeSavedMenu(false) : openSavedMenu());
on("savedMenu", "keydown", e => {
  const opts = [...document.querySelectorAll("#savedMenu .analysis-tab-main")];
  const from = opts.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); opts[(from + 1 + opts.length) % opts.length]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); opts[(from - 1 + opts.length) % opts.length]?.focus(); }
  else if (e.key === "Tab") closeSavedMenu(false);
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && savedMenuOpen()) { e.stopPropagation(); closeSavedMenu(true); } }, true);
document.addEventListener("pointerdown", e => {
  if (!savedMenuOpen()) return;
  const menu = document.getElementById("savedMenu"), btn = document.getElementById("savedBtn");
  if (!menu.contains(e.target) && !btn?.contains(e.target)) closeSavedMenu(false);
});

/* ════════════════ WATCHLIST ════════════════
   Tickers someone follows, with a live price beside what their saved snapshot said. The
   list is localStorage-only like everything else a visitor owns; prices are fetched from
   GET /quotes and deliberately never persisted, since a stored quote is a stale quote.

   The rate story matters more than the UI here. Prices refresh only while the popover is
   open and the tab is visible, at most once per WATCH_REFRESH_MS, and the server answers
   repeats from its own per-symbol cache — so an idle open tab costs nothing upstream. A
   row never triggers an analysis by itself: opening one runs (or reopens) it explicitly. */
const WATCH_STORAGE_KEY = "squall-watchlist-v1";
const WATCH_MAX = 25;                // matches SQUALL_QUOTE_MAX_SYMBOLS' default
const WATCH_REFRESH_MS = 60000;      // matches the server's quote TTL
const WATCH_TICKER_RE = /^\^?[A-Z][A-Z0-9]{0,5}([.\-][A-Z0-9]{1,4})?$/;   // validateTickerFormat's
let watchlist = [];                  // [{ t, at }]
const watchQuotes = {};              // ticker → last /quotes row, memory only
let watchFetchedAt = 0, watchTimer = null, watchInflight = false, watchNotice = "";

function loadWatchlist() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(WATCH_STORAGE_KEY) || "[]"); } catch (_) { raw = []; }
  if (!Array.isArray(raw)) raw = [];
  const seen = new Set();
  watchlist = raw.filter(r => r && typeof r.t === "string" && WATCH_TICKER_RE.test(r.t) && !seen.has(r.t) && seen.add(r.t))
    .slice(0, WATCH_MAX).map(r => ({ t: r.t, at: Number(r.at) || Date.now() }));
}
function persistWatchlist() {
  try { localStorage.setItem(WATCH_STORAGE_KEY, JSON.stringify(watchlist)); return true; }
  catch (_) { showStorageNotice("Browser storage is full — the watchlist change could not be saved."); return false; }
}
const isWatched = t => watchlist.some(r => r.t === t);
function normalizeWatchTicker(raw) { return String(raw || "").trim().toUpperCase().replace(/^\$/, ""); }

function addToWatchlist(raw) {
  const t = normalizeWatchTicker(raw);
  if (!WATCH_TICKER_RE.test(t)) return { ok: false, message: `"${String(raw).trim().slice(0, 12)}" isn't a ticker symbol.` };
  if (isWatched(t)) return { ok: false, message: `${t} is already on the watchlist.` };
  if (watchlist.length >= WATCH_MAX) return { ok: false, message: `The watchlist holds up to ${WATCH_MAX} tickers — remove one first.` };
  watchlist.push({ t, at: Date.now() });
  persistWatchlist();
  return { ok: true, t };
}
function removeFromWatchlist(t) {
  watchlist = watchlist.filter(r => r.t !== t);
  delete watchQuotes[t];
  persistWatchlist();
}
function toggleWatch(t) {
  if (isWatched(t)) removeFromWatchlist(t); else addToWatchlist(t);
  renderWatchlist(); syncWatchToggle();
  if (isWatched(t)) refreshWatchQuotes(true);
}

/* What the saved snapshot said, if there is one — the baseline for "since snapshot". */
function watchSnapshot(t) {
  const d = sessions[t]?.data;
  if (!d) return null;
  const q = d.live_quote || {}, tech = (d.raw_data || {}).technicals || {};
  const price = isNum(q.last_price) ? q.last_price : tech.current_price;
  return { price: isNum(price) ? price : null, when: q.quote_time || q.fetched_at || d.today || null,
    event: d.event_risk || null, name: d.company_name || "" };
}

/* The results window as seen from TODAY, not from the snapshot date: a snapshot taken a
   month ago stored "results in ~30d", which is now "~0d" or already past. Only the window
   dates are reused, never the stored day counts. A window that has closed says nothing. */
function watchEventFlag(er, now = new Date()) {
  if (!er || !Array.isArray(er.earnings_window) || er.earnings_window.length < 2) return null;
  const day = s => { const d = new Date(String(s) + "T00:00:00"); return isNaN(d) ? null : d; };
  const open = day(er.earnings_window[0]), close = day(er.earnings_window[1]);
  if (!open || !close) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (close < today) return null;
  const title = `Estimated results window ${er.earnings_window[0]} to ${er.earnings_window[1]}, from SEC filing cadence at the snapshot date; not a confirmed date`;
  if (open <= today) return { label: "Results due now", title };
  const days = Math.round((open - today) / 86400000);
  return days <= 21 ? { label: `Results ~${days}d`, title } : null;
}

function watchRowHtml(r) {
  const q = watchQuotes[r.t], snap = watchSnapshot(r.t);
  const hasPx = q && isNum(q.price);
  const dayPct = hasPx && isNum(q.change_pct) ? q.change_pct / 100 : null;
  const px = hasPx ? fUsd(q.price)
    : q && q.status === "unknown" ? "Unknown" : q && (q.status === "deferred" || q.status === "error") ? "—" : "…";
  const bits = [];
  if (hasPx && snap && isNum(snap.price) && snap.price > 0) {
    const since = q.price / snap.price - 1;
    const when = snap.when ? new Date(String(snap.when).replace(" ", "T")) : null;
    const whenLabel = when && !isNaN(when) ? when.toLocaleDateString([], { month: "short", day: "numeric" }) : "snapshot";
    bits.push(`<span class="${signCls(since)}" title="Change since the saved analysis (${esc(fUsd(snap.price))})">${since >= 0 ? "+" : ""}${fPct(since, 1)} since ${esc(whenLabel)}</span>`);
  } else if (!snap) {
    bits.push(`<span>Not analyzed yet</span>`);
  }
  if (q && q.status === "stale") bits.push(`<span title="The quote provider is busy; this is the last known price">delayed ${Math.round((q.age_s || 0) / 60)}m</span>`);
  if (q && q.status === "unknown") bits.push(`<span>No quote for this symbol</span>`);
  const ev = watchEventFlag(snap && snap.event);
  if (ev) bits.push(`<span class="watch-event" title="${escAttr(ev.title)}">${esc(ev.label)}</span>`);
  return `<div class="watch-row" data-t="${escAttr(r.t)}">
    <button class="watch-open" type="button" title="${sessions[r.t] ? "Open the saved analysis" : "Analyze"} ${escAttr(r.t)}">
      <span class="watch-line"><b>${esc(r.t)}</b><span class="watch-px">${px}</span>${isNum(dayPct)
        ? `<span class="pill ${dayPct >= 0 ? "up" : "down"}">${dayPct >= 0 ? "▲" : "▼"} ${fPct(Math.abs(dayPct))}</span>` : ""}</span>
      ${bits.length ? `<span class="watch-sub">${bits.join('<i aria-hidden="true">·</i>')}</span>` : ""}
    </button>
    <button class="watch-del" type="button" aria-label="Remove ${escAttr(r.t)} from the watchlist" title="Remove">×</button>
  </div>`;
}

function renderWatchlist() {
  const rows = document.getElementById("watchRows");
  const count = document.getElementById("watchCount");
  if (count) count.textContent = watchlist.length ? String(watchlist.length) : "";
  if (!rows) return;
  rows.innerHTML = watchlist.length ? watchlist.map(watchRowHtml).join("")
    : `<p class="watch-empty">Nothing watched yet. Add a ticker above, or use the ☆ beside a ticker you've analyzed.</p>`;
  const stamp = document.getElementById("watchStamp");
  if (stamp) stamp.textContent = watchFetchedAt ? `updated ${new Date(watchFetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  const note = document.getElementById("watchNote");
  if (note) note.textContent = watchNotice;
  document.getElementById("watchRefresh")?.classList.toggle("spin", watchInflight);
}

async function refreshWatchQuotes(force) {
  if (!watchlist.length || watchInflight) return;
  if (!force && Date.now() - watchFetchedAt < WATCH_REFRESH_MS - 1000) return;
  watchInflight = true; renderWatchlist();
  try {
    const res = await fetch(`/quotes?symbols=${encodeURIComponent(watchlist.map(r => r.t).join(","))}`, { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) watchNotice = body.error || "Refreshing too often — try again in a moment.";
    else if (!res.ok) watchNotice = body.error || "Prices could not be loaded right now.";
    else if (body.available === false) watchNotice = body.message || "Live quotes are unavailable.";
    else {
      Object.assign(watchQuotes, body.quotes || {});
      watchFetchedAt = Date.now();
      const missing = Object.values(body.quotes || {}).filter(q => q.status === "deferred" || q.status === "error").length;
      watchNotice = missing ? `${missing} price${missing === 1 ? "" : "s"} unavailable right now — the next refresh will try again.` : "";
    }
  } catch (_) {
    watchNotice = "Prices could not be loaded — check your connection.";
  } finally {
    watchInflight = false;
    renderWatchlist();
  }
}

const watchMenuOpen = () => document.getElementById("watchMenu")?.classList.contains("open") || false;
function openWatchMenu() {
  const menu = document.getElementById("watchMenu"), btn = document.getElementById("watchBtn");
  if (!menu || !btn) return;
  closeSavedMenu(false);
  menu.classList.add("open");
  btn.setAttribute("aria-expanded", "true");
  renderWatchlist();
  refreshWatchQuotes(false);
  clearInterval(watchTimer);
  watchTimer = setInterval(() => { if (!document.hidden) refreshWatchQuotes(false); }, WATCH_REFRESH_MS);
  (watchlist.length ? menu.querySelector(".watch-open") : document.getElementById("watchInput"))?.focus();
}
function closeWatchMenu(refocus) {
  const menu = document.getElementById("watchMenu"), btn = document.getElementById("watchBtn");
  if (!menu || !menu.classList.contains("open")) return;
  menu.classList.remove("open");
  btn?.setAttribute("aria-expanded", "false");
  clearInterval(watchTimer); watchTimer = null;
  if (refocus) btn?.focus();
}
function openWatchedTicker(t) {
  closeWatchMenu(false);
  if (sessions[t]) return switchTicker(t);
  if (!IS_ANALYZER_PAGE) return gotoAnalyzer(t);
  const input = document.getElementById("ticker");
  if (input) { input.value = t; runAnalysis(); }
}

/* The ☆ in the ticker bar. #tickerBar is re-rendered wholesale by renderStrip, so the
   toggle is wired by delegation and its pressed state is re-synced after every change. */
function syncWatchToggle() {
  const btn = document.getElementById("sWatch");
  if (!btn) return;
  const on_ = isWatched(btn.dataset.t);
  btn.setAttribute("aria-pressed", on_ ? "true" : "false");
  btn.textContent = on_ ? "★" : "☆";
  btn.title = on_ ? `Remove ${btn.dataset.t} from the watchlist` : `Add ${btn.dataset.t} to the watchlist`;
}

loadWatchlist();
renderWatchlist();
on("watchBtn", "click", () => watchMenuOpen() ? closeWatchMenu(false) : openWatchMenu());
on("watchRefresh", "click", () => refreshWatchQuotes(true));
on("watchAdd", "submit", e => {
  e.preventDefault();
  const input = document.getElementById("watchInput");
  const r = addToWatchlist(input?.value);
  watchNotice = r.ok ? "" : r.message;
  if (r.ok && input) input.value = "";
  renderWatchlist(); syncWatchToggle();
  if (r.ok) refreshWatchQuotes(true);
});
on("watchRows", "click", e => {
  const row = e.target.closest?.(".watch-row");
  if (!row) return;
  if (e.target.closest(".watch-del")) { removeFromWatchlist(row.dataset.t); watchNotice = ""; renderWatchlist(); syncWatchToggle();
    (document.querySelector("#watchRows .watch-open") || document.getElementById("watchInput"))?.focus(); return; }
  if (e.target.closest(".watch-open")) openWatchedTicker(row.dataset.t);
});
on("watchMenu", "keydown", e => {
  const opts = [...document.querySelectorAll("#watchMenu .watch-open")];
  const from = opts.indexOf(document.activeElement);
  if (from < 0) return;
  if (e.key === "ArrowDown") { e.preventDefault(); opts[(from + 1) % opts.length]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); opts[(from - 1 + opts.length) % opts.length]?.focus(); }
});
on("tickerBar", "click", e => { const b = e.target.closest?.("#sWatch"); if (b) toggleWatch(b.dataset.t); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && watchMenuOpen()) { e.stopPropagation(); closeWatchMenu(true); } }, true);
document.addEventListener("pointerdown", e => {
  if (!watchMenuOpen()) return;
  const menu = document.getElementById("watchMenu"), btn = document.getElementById("watchBtn");
  if (!menu.contains(e.target) && !btn?.contains(e.target)) closeWatchMenu(false);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden && watchMenuOpen()) refreshWatchQuotes(false); });
/* Another tab edited the list — follow it rather than overwrite it on our next write. */
window.addEventListener("storage", e => { if (e.key === WATCH_STORAGE_KEY) { loadWatchlist(); renderWatchlist(); syncWatchToggle(); } });

function switchTicker(t) {
  if (!sessions[t]) return;
  if (IS_SCREENER_PAGE) return gotoAnalyzer(t);   // saved analyses live on the other page
  const prev = active;
  active = t; activeScreen = null;
  // Opening the tab you are comparing against swaps the two panes rather than silently
  // dropping the comparison: the pair on screen is the thing being read, and losing half
  // of it because you clicked the half you wanted in front is the wrong outcome. The swap
  // is written after `active` moves — setCompareTicker refuses a ticker equal to it.
  if (t === compareTicker) setCompareTicker(prev, false);
  showWorkspace(true);
  renderTickerPills();
  renderAll(sessions[t].data);
  syncChatSendMode();   // reflect whether this ticker's thread is mid-stream
}
function deleteSession(t) {
  const sess = sessions[t]; if (!sess) return;
  if (sess._chatAbort) { try { sess._chatAbort.abort(); } catch (_) {} }
  const keys = Object.keys(sessions), idx = keys.indexOf(t);
  delete sessions[t];
  if (t === compareTicker) setCompareTicker(null, false);   // nothing left to compare against
  if (active === t) active = keys[idx + 1] && sessions[keys[idx + 1]] ? keys[idx + 1] : keys[idx - 1] && sessions[keys[idx - 1]] ? keys[idx - 1] : Object.keys(sessions)[0] || null;
  persistSessions(); renderTickerPills();
  // Shared Saved chrome is present on /screener and /ilgar, but their bodies
  // do not contain the analyzer dashboard or hero.
  if (!IS_ANALYZER_PAGE) return;
  if (active && sessions[active]) { renderAll(sessions[active].data); syncChatSendMode(); }
  else {
    clearTickerBar();
    const ws = document.getElementById("workspace"), hero = document.getElementById("hero");
    ws.classList.remove("show", "leaving"); hero.style.display = "";
  }
}
/* The header reverts to its marketing state — tagline back, identity gone — whenever there
   is no analysis on screen. Declared as a function so the two callers above it can hoist. */
function clearTickerBar() {
  const bar = document.getElementById("tickerBar");
  if (bar) { bar.classList.remove("show"); bar.innerHTML = ""; }
  document.body.classList.remove("has-analysis");
}

/* ════════════════ RENDER: HEADER IDENTITY ════════════════
   This used to be #summaryStrip, a 100px band under the header. On a 720p display that was
   a sixth of the viewport spent on one line of glance information and one line of metadata,
   while the analysis it described read through a 228px slot. The glance half — name,
   ticker, price, change, sector, regime — moves into the header bar, which was already
   there; the metadata half (structure, market state, fetch time) moves into the Live
   Snapshot card, which is where the rest of this analysis's provenance already lives.

   The order here is the shed order: everything after #sPrice is dropped by the media
   ladder as the bar narrows, right to left, before the wordmark or the search field give
   up any width. */
/* The snapshot date, compact. It shipped as the raw ISO string in an accent pill — 182px
   of "As of 2026-08-27 14:31:00Z" — which at 1280px ellipsed every chip after it down to
   "TR…" and "Tec…". It is metadata, not a category, so it reads as muted text; the full
   value stays on the title. Today shows the time (freshness is the question), anything
   older shows the date (staleness is). */
function asOfStamp(raw) {
  if (!raw) return `<span class="as-of" title="Snapshot time unknown">as of —</span>`;
  const dt = new Date(String(raw).replace(" ", "T"));
  let label = String(raw);
  if (!isNaN(dt)) {
    const now = new Date();
    const sameDay = dt.toDateString() === now.toDateString();
    label = sameDay
      ? dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : dt.toLocaleDateString([], { month: "short", day: "numeric",
          ...(dt.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  }
  return `<span class="as-of" title="Snapshot as of ${esc(raw)} — Analyze refreshes it">as of ${esc(label)}</span>`;
}

function renderStrip(d) {
  const q = d.live_quote || {}, t = (d.raw_data || {}).technicals || {};
  const company = d.company_profile || {}, regime = d.market_regime || {};
  const price = q.last_price ?? t.current_price, chg = t.daily_change;
  const strip = document.getElementById("tickerBar");
  if (!strip) return;
  strip.innerHTML = `
    <span id="sTicker">${esc(d.ticker)}</span>
    <button id="sWatch" type="button" data-t="${escAttr(d.ticker)}" aria-pressed="false"></button>
    <span id="sCompany" title="${esc(d.company_name)}${q.exchange ? " · " + esc(q.exchange) : ""}">${esc(d.company_name)}</span>
    <span id="sPrice" title="Saved snapshot; Analyze refreshes the research">${fUsd(price)}</span>
    ${asOfStamp(q.quote_time || q.fetched_at || d.today)}
    ${isNum(chg) ? `<span class="pill ${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "▲" : "▼"} ${fPct(chg)}</span>` : ""}
    ${company.sector ? `<span class="sector-badge" title="${esc(company.industry || company.sector)}">${esc(company.sector)}</span>` : ""}
    ${/* Label only. The confidence used to ride along here, and "DISTRIBUTION · 86%" is
          wide enough that the bar clipped it mid-character at 1280px — while the Market
          Regime card already shows the same number with a bar beside it. The title keeps
          both for anyone who wants them without opening the card. */""}
    ${regime.label && regime.label !== "INSUFFICIENT DATA" ? `<span class="regime-badge" title="Historical price/volume classification; not a forecast">${esc(regime.label)}</span>` : ""}
    ${eventBadge(d.event_risk)}`;
  syncWatchToggle();
  strip.classList.add("show");
  document.body.classList.add("has-analysis");   // the wordmark's tagline yields its width

  // price ticks up into place
  const pe = document.getElementById("sPrice");
  if (!REDUCED && isNum(price) && pe) {
    const t0 = performance.now(), dur = 700, from = price * 0.96;
    const tick = now => {
      if (!pe.isConnected) return;   // strip re-rendered mid-animation — stop
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      pe.textContent = fUsd(from + (price - from) * e);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/* ════════════════ WORKSPACE DESTINATIONS ════════════════
   One list, rendered as a vertical rail on larger screens and a bottom dock on phones,
   driving both layout modes. It replaces two
   separate mechanisms that were the same idea at different breakpoints: the four horizontal
   section tabs inside the data pane, and #mobileTabs' Data/AI pane switcher below 960px.

   Vertical is the right trade on short desktop screens: a horizontal row costs 34–40px of
   the axis that layout has none of. A phone is the opposite trade — 74px of permanent rail
   consumes a fifth of its usable width — so CSS moves the same buttons below the pane.

   `pane` says which pane a destination lives in. In split mode both panes are on screen, so
   the AI destinations are filtered out of the rail — selecting "AI Analysis" when the AI
   pane is already beside you is not a navigation. In focus mode every destination is
   listed and exactly one pane is mounted. */
const VIEWS = [
  { id: "chart",        label: "Chart",          pane: "data" },
  { id: "overview",     label: "Overview",       pane: "data" },
  { id: "technicals",   label: "Technicals",     pane: "data" },
  { id: "fundamentals", label: "Fundamentals",   pane: "data" },
  { id: "filings",      label: "Filings",        pane: "data" },
  // "Analysis", not "AI Analysis": the longer label is the only one that wraps to two
  // lines in the rail, and sitting directly above "Chat" under its own divider it is not
  // ambiguous — the pane it opens carries the model tag.
  { id: "analysis",     label: "Analysis",       pane: "ai", focusOnly: true },
  { id: "chat",         label: "Chat",           pane: "ai", focusOnly: true },
];
const DATA_VIEWS = VIEWS.filter(v => v.pane === "data");
const SECTION_KEY = "squall-data-section";

/* Focus mode: one destination at a time, taking the whole workspace. Triggered by EITHER
   axis. Width was the old sole trigger at 960px, which is why a 1280×720 laptop — wide
   enough to pass, short enough that the split gave the analysis a 228px reading slot —
   got the worst of both. 820px of viewport height is roughly where two stacked scroll
   regions stop being worth their scrollbars. */
const FOCUS_MQ = matchMedia("(max-width: 1100px), (max-height: 820px)");
const MOBILE_VIEW_MQ = matchMedia("(max-width: 600px)");
const isFocusMode = () => FOCUS_MQ.matches;
/* The class is what CSS keys off. Set here rather than in a media query so that JS and CSS
   cannot disagree about which mode is live — one condition, one source. */
const syncFocusModeClass = () => document.body.classList.toggle("focus-mode", FOCUS_MQ.matches);
syncFocusModeClass();
FOCUS_MQ.addEventListener("change", syncFocusModeClass);

/* A view preference, not session state — which destination you last read is about you, not
   about the ticker. Kept off `sessions` deliberately so switching never writes a session or
   evicts a saved analysis to make room for the fact that you clicked a tab. */
let activeView = VIEWS[0].id;
try {
  const saved = localStorage.getItem(SECTION_KEY);
  if (VIEWS.some(v => v.id === saved)) activeView = saved;
} catch (e) {}

/* Which destinations exist for this render. A data destination earns its place by having
   cards; the AI ones exist whenever the AI pane does, and only in focus mode. */
function availableViews(bucket) {
  return VIEWS.filter(v => {
    if (v.pane === "data") return Boolean((bucket[v.id] || "").trim());
    return isFocusMode() && Boolean(document.getElementById("aiPane"));
  });
}

function renderViewRail(bucket) {
  const filled = availableViews(bucket);
  if (!filled.length) return "";
  if (!filled.some(v => v.id === activeView)) activeView = filled[0].id;
  const rail = document.getElementById("viewRail");
  if (rail) {
    let lastPane = null;
    rail.innerHTML = filled.map(v => {
      // A hairline between the panes' destinations, so the rail reads as two groups rather
      // than one list of seven unrelated words.
      const rule = lastPane && v.pane !== lastPane ? ' data-group-start="1"' : "";
      lastPane = v.pane;
      return `<button type="button" role="tab" data-view="${v.id}"${rule} aria-selected="${v.id === activeView}"
        class="${v.id === activeView ? "active" : ""}">${esc(v.label)}<i class="tab-dot" aria-hidden="true"></i></button>`;
    }).join("");
    keepActiveViewVisible();
  }
  // Only the data destinations produce panels; the AI ones are a whole pane already.
  return filled.filter(v => v.pane === "data").map(v =>
    `<div class="data-section ${v.id === activeView ? "show" : ""} ${v.id === "chart" ? "chart-section" : ""}"
      data-section="${v.id}" role="tabpanel">${bucket[v.id]}</div>`).join("");
}

function showView(id) {
  const view = VIEWS.find(v => v.id === id);
  if (!view) return;
  activeView = id;
  try { localStorage.setItem(SECTION_KEY, id); } catch (e) {}
  document.querySelectorAll("#viewRail [data-view]").forEach(b => {
    const on = b.dataset.view === id;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  keepActiveViewVisible();
  document.querySelectorAll("#dataBody .data-section").forEach(p =>
    p.classList.toggle("show", p.dataset.section === id));
  const body = document.getElementById("dataBody");
  if (body) body.scrollTop = 0;
  syncPaneVisibility();
  // A hidden panel is display:none, so its canvas measures 0×0 and drawChart bails at its
  // own guard — the chart comes back as an empty box unless it is told to repaint on the
  // way in. This is why Chart is checked here and not just on first render.
  if (id === "chart" && active) requestAnimationFrame(drawChart);
  if (id === "chat") document.getElementById("chatInput")?.focus();
}

/* A saved destination can sit beyond the phone dock's initial scroll position. Keep the
   selected item in view without coupling navigation to desktop geometry; the optional
   method guard also keeps the page harness and older browsers on the no-op path. */
function keepActiveViewVisible() {
  if (!MOBILE_VIEW_MQ.matches) return;
  const button = document.querySelector(`#viewRail [data-view="${activeView}"]`);
  if (button && typeof button.scrollIntoView === "function") {
    button.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function syncViewRailOrientation() {
  const rail = document.getElementById("viewRail");
  if (!rail) return;
  rail.setAttribute("aria-orientation", MOBILE_VIEW_MQ.matches ? "horizontal" : "vertical");
  keepActiveViewVisible();
}
MOBILE_VIEW_MQ.addEventListener("change", syncViewRailOrientation);
syncViewRailOrientation();

/* Which panes are mounted. In split mode: both, always — leaving a stale [data-hidden]
   behind after a resize is how one pane silently disappears on a wide screen. */
function syncPaneVisibility() {
  const dataPane = document.getElementById("dataPane"), aiPane = document.getElementById("aiPane");
  if (!dataPane || !aiPane) return;
  if (!isFocusMode()) { dataPane.removeAttribute("data-hidden"); aiPane.removeAttribute("data-hidden"); return; }
  const view = VIEWS.find(v => v.id === activeView) || VIEWS[0];
  dataPane.toggleAttribute("data-hidden", view.pane !== "data");
  aiPane.toggleAttribute("data-hidden", view.pane !== "ai");
  document.body.classList.toggle("chat-view", view.id === "chat");
}
/* Run it at load, not only from renderAll. In focus mode both panes occupy the same grid
   cell, so until one of them is marked hidden they are stacked on top of each other — and
   the window where that is true is exactly the skeleton-loading phase of a first analysis,
   before any render has happened. */
syncPaneVisibility();

/* The only signal that the write-up is still generating while you are looking at numbers.
   It rode #mobileTabs' AI tab, which no longer exists; it now rides the rail's AI Analysis
   entry, and in split mode where that entry is filtered out, the model tag beside the prose
   is already pulsing. */
function setAnalysisStreaming(on) {
  document.querySelector('#viewRail [data-view="analysis"]')?.classList.toggle("streaming", on);
}

/* The rail during the skeleton phase. Without it the rail is empty for the whole of a
   first analysis — thirty to sixty seconds in which, in focus mode, there is no way to
   reach the pane where the write-up is streaming. #mobileTabs used to cover this by
   existing statically in the markup; a rail that renderAll builds does not.

   Two entries, not seven: the dashboard has no destinations yet, so offering five that all
   resolve to the same skeleton would be a lie. "Dashboard" holds the skeleton's place. */
function renderLoadingRail() {
  const rail = document.getElementById("viewRail");
  if (!rail) return;
  const entries = [{ id: "overview", label: "Dashboard", pane: "data" }]
    .concat(isFocusMode() ? [{ id: "analysis", label: "Analysis", pane: "ai" }] : []);
  // Chat is the one preference that cannot survive the wait — there is nothing to ask
  // about yet. Everything else is left alone: activeView is NOT rewritten to whichever
  // placeholder is highlighted here, so renderAll restores the reader's real destination
  // (Chart, Technicals…) when the payload lands.
  if (activeView === "chat") activeView = "analysis";
  const current = VIEWS.find(v => v.id === activeView) || VIEWS[0];
  const marked = current.pane === "ai" && isFocusMode() ? "analysis" : "overview";
  rail.innerHTML = entries.map(e =>
    `<button type="button" role="tab" data-view="${e.id}" aria-selected="${e.id === marked}"
      class="${e.id === marked ? "active" : ""}">${esc(e.label)}<i class="tab-dot" aria-hidden="true"></i></button>`).join("");
  keepActiveViewVisible();
  wireViewRail();
  syncPaneVisibility();
}

/* Delegated, and wired from inside renderAll rather than at the top level: #viewRail is
   filled by renderAll, so a bare getElementById("viewRail").addEventListener at the top
   level would throw on /screener and /ilgar — which have no workspace — and silently kill
   every listener declared below it. */
function wireViewRail() {
  const rail = document.getElementById("viewRail");
  if (!rail) return;
  rail.onclick = e => {
    const btn = e.target.closest("[data-view]");
    if (btn) showView(btn.dataset.view);
  };
}

/* Crossing the focus-mode boundary re-filters the rail (the AI destinations appear and
   disappear) and has to re-mount whichever pane the other mode hid. Re-rendering the whole
   dashboard would be wasteful and would lose scroll position, so only the rail is rebuilt. */
FOCUS_MQ.addEventListener("change", () => {
  if (!active || !sessions[active]) { syncPaneVisibility(); return; }
  const rail = document.getElementById("viewRail");
  if (!rail || !rail.children.length) return;
  renderAll(sessions[active].data);
});

/* ════════════════ RENDER: EVERYTHING ════════════════ */
function renderAll(d) {
  renderStrip(d);
  const r = d.raw_data || {};
  const v = r.valuation || {}, p = r.profitability || {}, fh = r.financial_health || {}, sec = r.sec_fundamentals || {},
        t = r.technicals || {}, rr = r.risk_return || {}, s = r.sentiment || {}, kl = r.key_levels || {};
  const q = d.live_quote || {}, pa = d.price_action || {}, inst = d.institutional || {}, company = d.company_profile || {}, regime = d.market_regime || {};

  /* Cards accumulate per destination rather than into one string. Eighteen of them, fifteen
     open by default, was ~90 metrics in a single scroll — every card defensible, the sum
     unreadable. Nothing is removed or collapsed here; it is regrouped, and the destination a
     card belongs to is stated at the card rather than inferred from its position. */
  const bucket = Object.fromEntries(DATA_VIEWS.map(v => [v.id, ""]));
  const add = (section, markup) => { bucket[section] += markup; };

  /* Snapshot */
  let snap = `<div class="mgrid">
    ${metric("Last Price", fUsd(q.last_price ?? t.current_price))}
    ${metric("Day Change", fPct(t.daily_change), signCls(t.daily_change))}
    ${metric("Open", fUsd(q.open))}
    ${metric("Prev Close", fUsd(q.previous_close))}
    ${metric("Bid / Ask", (isNum(q.bid) && q.bid > 0 && isNum(q.ask) && q.ask >= q.bid) ? `${fUsd(q.bid)} <small>/</small> ${fUsd(q.ask)} <small>(snapshot)</small>` : "Unavailable")}
    ${metric("Volume", fInt(q.last_volume))}
    ${metric("Market Cap", fUsd(q.market_cap))}
    ${metric("Currency", esc(q.currency || "N/A"))}
    ${metric("Sector", esc(company.sector || "N/A"))}
    ${metric("Industry", esc(company.industry || "N/A"))}
    ${metric("Quote Source", esc(q.source || d.data_sources?.quote || "N/A"))}
    ${metric("Chart Source", esc(d.data_sources?.history || "N/A"))}
    ${/* Followed the identity block out of the deleted summary strip. These are provenance
          rather than glance information — you check them once to know how fresh and how
          well-founded the numbers are — so the card that already states where every figure
          came from is where they belong. */""}
    ${pa.trend ? metric("Market Structure", esc(pa.trend)) : ""}
    ${q.market_state ? metric("Market State", esc(q.market_state)) : ""}
    ${q.fetched_at ? metric("Data Fetched", esc(q.fetched_at)) : ""}
  </div>`;
  snap += rangeBar("Day range", q.day_low, q.day_high, q.last_price ?? t.current_price);
  snap += rangeBar("52-week range", t.low_52w ?? q.year_low, t.high_52w ?? q.year_high, q.last_price ?? t.current_price);
  snap += `<p class="learn-note">Saved market snapshot, not a streaming quote. Select Analyze to refresh; the server may reuse data fetched within five minutes.</p><button type="button" class="chip" onclick="retryAnalysis('${jsAttr(d.ticker)}')">Refresh analysis</button>`;
  add("overview", card("snapshot", "Market Snapshot", snap));

  /* Candlestick chart — its own destination, not a card in a scroll list.
     As a card it was a fixed 565px inside a 312px window, so the controls and the candles
     could never be on screen together. Alone in its panel it takes the region's full
     height, and a <details> wrapper would only add a 44px summary row whose collapse
     affordance controls the one thing already there. */
  if (Array.isArray(d.price_history || d.price_history_1y) && (d.price_history || d.price_history_1y).length > 10) {
    add("chart", chartCardBody());
  }

  /* Deterministic market regime — explains the current price/volume environment. */
  if (regime.label && regime.label !== "INSUFFICIENT DATA") {
    let body = `<div class="regime-summary ${signalClass(regime.label)}">
      <div><span>Current regime</span><strong>${esc(regime.label)}</strong></div>
      <div class="regime-confidence"><span>Score separation: ${esc(regime.separation || "unavailable")}</span></div>
      <p>${esc(regime.summary || "Price and volume currently give a mixed signal.")}</p>
    </div>`;
    if (Array.isArray(regime.evidence) && regime.evidence.length) body += `<div class="regime-evidence">${regime.evidence.map(x => `<span>${esc(x)}</span>`).join("")}</div>`;
    if (regime.conflicts?.length) body += `<p class="learn-note">Conflicting evidence: ${regime.conflicts.map(esc).join("; ")}</p>`;
    body += `<p class="learn-note"><b>How to use this:</b> regime describes the current environment; it does not predict the next move. Trend regimes favor continuation setups, while range or transition regimes reward patience and tighter risk controls.</p>`;
    add("overview", card("regime", "Market Regime", body, { count: regime.label, source: histSrc(d) }));
  }

  /* Price action / market structure */
  if (pa.trend && pa.trend !== "INSUFFICIENT DATA") {
    let body = `${signalHtml((pa.trend === "UPTREND" ? "UPTREND: " : pa.trend === "DOWNTREND" ? "DOWNTREND: " : "RANGE: ") + (pa.trend_basis || ""))}`;
    (pa.events || []).forEach(e => body += signalHtml(e));
    body += `<div class="mgrid" style="margin-top:8px">
      ${metric("Recent Swing High", fUsd(pa.recent_swing_high))}
      ${metric("Recent Swing Low", fUsd(pa.recent_swing_low))}</div>`;
    if (pa.fib && Object.keys(pa.fib).length) {
      body += `<div class="lvl-label">Fibonacci retracement (last swing leg)</div><div class="levels">`;
      Object.entries(pa.fib).forEach(([k, val]) => body += `<span class="lvl" style="color:var(--ink-dim);background:var(--chrome-2)">${k} · ${fUsd(val)}</span>`);
      body += `</div>`;
    }
    add("technicals", card("priceaction", "Price Action & Market Structure", body, { count: pa.trend, source: histSrc(d) }));
  }

  /* Institutional footprint */
  if (inst.signals || inst.net_bias) {
    const bias = inst.net_bias || "NEUTRAL";
    const biasCls = bias === "ACCUMULATION" ? "green" : bias === "DISTRIBUTION" ? "red" : "";
    let body = `<label class="toggle ${chartOpts.instWindow ? "on" : ""}" style="--swatch:var(--ink);margin-bottom:10px">
      <input type="checkbox" id="instToggle" ${chartOpts.instWindow ? "checked" : ""} onchange="toggleInstFocus(this.checked)">
      Focus the next question on institutional positioning</label>
      <div class="mgrid">
      ${metric("Net Bias", esc(bias), biasCls)}
      ${metric("OBV Trend", esc(inst.obv_trend || "N/A"), inst.obv_trend === "RISING" ? "green" : inst.obv_trend === "FALLING" ? "red" : "")}
      ${metric("Up-Day Volume (20D)", fPct(inst.up_vol_ratio, 0))}
      ${metric("Accum. Days (25)", String(inst.accumulation_days ?? 0), (inst.accumulation_days || 0) >= 3 ? "green" : "")}
      ${metric("Distrib. Days (25)", String(inst.distribution_days ?? 0), (inst.distribution_days || 0) >= 3 ? "red" : "")}
    </div>`;
    (inst.signals || []).forEach(sg => body += signalHtml(sg));
    add("technicals", card("institutional", "Price & Volume Proxies", body, { source: histSrc(d) }));
  }

  /* Algorithmic signals */
  const flags = d.algorithmic_signals || [];
  add("overview", card("signals", "Algorithmic Signals", flags.length ? flags.map(signalHtml).join("") : signalHtml("NEUTRAL: No strong signals triggered."), { count: flags.length }));

  /* Chart patterns */
  const pats = d.chart_patterns || [];
  if (pats.length) add("overview", card("patterns", "Chart Patterns", pats.map(signalHtml).join(""), { count: pats.length, source: histSrc(d) }));

  /* Valuation */
  add("fundamentals", card("valuation", "Valuation", `<div class="mgrid">
    ${metric("P/E Trailing", fRatio(v.pe_trailing))}${metric("P/E Forward", fRatio(v.pe_forward))}
    ${metric("PEG (provider growth basis)", fRatio(v.peg_ratio))}
    ${metric("Price / Book", fRatio(v.price_to_book))}${metric("Price / Sales", fRatio(v.price_to_sales))}
    ${metric("EV / EBITDA", fRatio(v.ev_ebitda))}${metric("FCF Yield", fPct(v.fcf_yield), signCls(v.fcf_yield))}</div>`));

  /* Profitability */
  add("fundamentals", card("profit", "Profitability & Margins", `<div class="mgrid">
    ${metric("Gross Margin", fPct(p.gross_margin))}${metric("Operating Margin", fPct(p.operating_margin), signCls(p.operating_margin))}
    ${metric("Net Margin", fPct(p.net_margin), signCls(p.net_margin))}${metric("FCF Margin", fPct(p.fcf_margin), signCls(p.fcf_margin))}
    ${metric("ROE", fPct(p.roe), signCls(p.roe))}${metric("ROA", fPct(p.roa), signCls(p.roa))}</div>`));

  /* Health */
  add("fundamentals", card("health", "Financial Health", `<div class="mgrid">
    ${metric("Current Ratio", fRatio(fh.current_ratio), isNum(fh.current_ratio) ? (fh.current_ratio >= 1.5 ? "green" : fh.current_ratio < 1 ? "red" : "amber") : "")}
    ${metric(fh.debt_to_equity_unit === "multiple" ? "Debt / Equity (×)" : "Debt / Equity (legacy units)", fRatio(fh.debt_to_equity))}
    ${metric("Earnings Quality <small>(OCF/NI)</small>", fRatio(fh.earnings_quality), isNum(fh.earnings_quality) ? (fh.earnings_quality >= 1 ? "green" : fh.earnings_quality < 0.5 ? "red" : "amber") : "")}</div>`));

  /* SEC fundamentals */
  let secBody = `<div class="mgrid">
    ${metric("Revenue", fUsd(sec.revenue))}${metric("Net Income", fUsd(sec.net_income), signCls(sec.net_income))}
    ${metric("Total Assets", fUsd(sec.assets))}${metric("Liabilities", fUsd(sec.liabilities))}
    ${metric("Equity", fUsd(sec.equity))}${metric("Operating CF", fUsd(sec.ocf), signCls(sec.ocf))}
    ${metric("Rev CAGR (3Y)", fPct(sec.rev_cagr_3y), signCls(sec.rev_cagr_3y))}</div>`;
  if (d.sec_filing && d.sec_filing.source_url)
    secBody += `<p style="margin-top:10px;font-size:12px;color:var(--ink-dim)">Source filing: <a href="${esc(d.sec_filing.source_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(d.sec_filing.form)} · filed ${esc(d.sec_filing.filing_date)}</a></p>`;
  if (d.sec_available === false)
    secBody = `<div class="signal amber"><b>NOTE:</b>&nbsp;SEC EDGAR data unavailable for this ticker — figures rely on the market-data provider only.</div>` + secBody;
  add("fundamentals", card("sec", "SEC-Verified Fundamentals (Latest 10-K)", secBody, { source: secSrc(d) }));

  /* Technicals */
  let tech = `<div class="mgrid">
    ${metric("50-Day MA", fUsd(t.ma_50))}${metric("200-Day MA", fUsd(t.ma_200))}
    ${metric("RSI (14)", fRatio(t.rsi_14), isNum(t.rsi_14) ? (t.rsi_14 >= 70 ? "red" : t.rsi_14 <= 30 ? "green" : "") : "")}
    ${metric("MACD", fRatio(t.macd), signCls(t.macd))}${metric("MACD Signal", fRatio(t.macd_signal))}
    ${metric("MACD Hist", fRatio(kl.macd_hist), signCls(kl.macd_hist))}
    ${metric("Bollinger Upper", fUsd(t.bb_upper))}${metric("Bollinger Lower", fUsd(t.bb_lower))}
    ${metric("BB Width", fPct(kl.bb_width_pct))}
    ${metric("Volume Ratio", isNum(t.volume_ratio) ? t.volume_ratio.toFixed(2) + "× <small>20d avg</small>" : "N/A")}
    ${metric("vs 52W High", fPct(t.pct_from_52_high), signCls(t.pct_from_52_high))}
    ${isNum(kl.trend_slope_daily_pct) ? metric("60D Trend Slope", kl.trend_slope_daily_pct.toFixed(2) + "%<small>/day</small>", signCls(kl.trend_slope_daily_pct)) : ""}</div>`;
  if (isNum(t.rsi_14)) tech += rangeBar("RSI scale", 0, 100, t.rsi_14, x => x.toFixed(0));
  const resL = (kl.resistance || []).filter(isNum), supL = (kl.support || []).filter(isNum);
  if (resL.length || supL.length) tech += `<div class="lvl-label">Key price levels</div><div class="levels">
    ${resL.map(x => `<span class="lvl res">R ${fUsd(x)}</span>`).join("")}${supL.map(x => `<span class="lvl sup">S ${fUsd(x)}</span>`).join("")}</div>`;
  add("technicals", card("tech", "Technicals & Key Levels", tech, { source: histSrc(d) }));

  /* Risk */
  add("technicals", card("risk", rr.period_start ? `Risk & Return · ${esc(rr.period_start)} to ${esc(rr.period_end)}` : "Risk & Return (saved estimate)", `<div class="mgrid">
    ${metric("CAGR", fPct(rr.cagr), signCls(rr.cagr))}${metric("Annual Volatility", fPct(rr.annual_volatility))}
    ${metric("Sharpe Ratio", fRatio(rr.sharpe), signCls(rr.sharpe))}${metric("Max Drawdown", fPct(rr.max_drawdown), signCls(rr.max_drawdown, true))}
    ${metric("Beta (vs SPY)", fRatio(rr.beta), isNum(rr.beta) && rr.beta > 1.6 ? "amber" : "")}</div>${rr.price_basis ? `<p style="margin-top:10px;font-size:12px;color:var(--ink-dim)">${esc(rr.price_basis)} · ${esc(rr.observations)} observations. Sharpe: ${esc(rr.sharpe_basis)}.</p>` : ""}`, { source: histSrc(d) }));

  /* Sentiment */
  let sent = `<div class="mgrid">
    ${metric("Consensus", esc(String(s.rec_key || "N/A").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())))}
    ${metric("Target Mean", fUsd(s.target_mean))}${metric("Target High", fUsd(s.target_high))}${metric("Target Low", fUsd(s.target_low))}
    ${metric("Institutional Own.", fPct(s.inst_ownership))}
    ${metric("Short Interest", fPct(s.short_percent), isNum(s.short_percent) && s.short_percent > 0.10 ? "red" : "")}</div>`;
  sent += rangeBar("Analyst targets vs price (amber = mean target)", s.target_low, s.target_high, t.current_price, fUsd, s.target_mean, "Mean target");
  add("fundamentals", card("sentiment", "Sentiment & Ownership", sent));

  /* Next results — estimated from the issuer's SEC filing cadence (event_calendar.py) */
  const er = d.event_risk;
  if (er && Array.isArray(er.earnings_window)) {
    const overdue = er.earnings_window_already_open && er.days_until_earnings_window_closes === 0;
    const opens = overdue ? "Past usual date" : er.earnings_window_already_open ? "Open now" : `${er.days_until_earnings_window_opens} days`;
    const lag = er.observed_filing_lag_days || {};
    let body = `<div class="mgrid">
      ${metric("Estimated results window", `${esc(er.earnings_window[0])} <small>to</small> ${esc(er.earnings_window[1])}`, er.imminent ? "amber" : "")}
      ${metric("Window opens in", opens, er.imminent ? "amber" : "")}
      ${metric("For the period ending", esc(er.pending_period_end))}
      ${er.results_announced ? metric("Last results released", `${esc(er.results_announced.announced)} <small>(period ended ${esc(er.results_announced.period_end)})</small>`) : ""}
      ${isNum(lag.median) ? metric("Usual filing lag", `${lag.median} days <small>(${lag.low}–${lag.high})</small>`) : ""}</div>`;
    body += `<p class="learn-note">${overdue ? "No results release (8-K Item 2.02) found yet, although this company has usually filed by now. " : ""}${er.imminent ? "Results are likely within three weeks. A price gap on results can jump straight past a stop. " : ""}${esc(er.basis || "")}</p>`;
    add("fundamentals", card("nextresults", "Next Results", body, { source: secSrc(d) }));
  }

  /* Earnings */
  const earn = r.earnings_surprises || [];
  if (earn.length) {
    const rows = earn.map(e => { const pos = e.reported >= e.estimate;
      return `<tr><td class="hi">${esc(e.date)}</td><td>$${e.estimate.toFixed(2)}</td><td class="hi">$${e.reported.toFixed(2)}</td>
        <td class="${pos ? "pos" : "neg"}">${isNum(e.surprise_pct) ? `${e.surprise_pct >= 0 ? "+" : ""}${(e.surprise_pct * 100).toFixed(1)}%` : "N/A"}</td><td class="${pos ? "pos" : "neg"}">${e.reported === e.estimate ? "Met" : pos ? "Beat" : "Miss"}</td></tr>`; }).join("");
    add("fundamentals", card("earnings", "Recent Earnings Surprises",
      `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Estimate</th><th>Reported</th><th>Surprise</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`, { count: earn.length, source: YQ_SRC }));
  }

  /* Filing activity */
  const fa = d.filing_activity;
  if (fa && d.sec_available !== false) {
    const ev = fa["8k_events"] || [];
    // The window comes from the scraper so the labels can't drift from what it scanned.
    const win = Number(fa.window_days) > 0 ? Number(fa.window_days) : 90;
    let body = `<div class="mgrid">
      ${metric(`Insider Buys <small>(${win}D)</small>`, String(fa.insider_buys ?? 0), fa.insider_buys > 0 ? "green" : "")}
      ${metric(`Insider Sells <small>(${win}D)</small>`, String(fa.insider_sells ?? 0), fa.insider_sells >= 5 ? "red" : "")}
      ${metric("Recent 13D / 13D-A filing", fa.activist_13d ? "Present — inspect purpose and ownership changes" : "None found")}</div>`;
    body += `<div class="lvl-label">8-K events (last ${win} days)</div><div class="levels">` +
      (ev.length ? ev.map(e => `<span class="lvl" style="color:var(--ink);background:var(--chrome-2)">${esc(e)}</span>`).join("") : `<span style="font-size:12px;color:var(--ink-dim)">None filed.</span>`) + `</div>`;
    // The scraper caps how many filing documents it will fetch per run. When that binds,
    // the counts above are a floor rather than a total, and saying so is cheaper than
    // having someone reconcile them against EDGAR and conclude the numbers are wrong.
    if (fa.truncated) {
      body += `<div style="font-size:var(--t-micro);color:var(--ink-dim);margin-top:8px">` +
              `Counts are a floor — this issuer files more frequently than one analysis reads.</div>`;
    }
    add("filings", card("filings", `SEC Filing Activity (${win} Days)`, body, { source: secSrc(d) }));
  }

  /* Options */
  const od = d.options_data || {};
  if (od.chains && od.chains.length) {
    let body = `<p style="font-size:12px;color:var(--ink-dim);margin-bottom:4px">Available expirations: <span style="font-family:var(--mono)">${(od.available_expirations || []).map(esc).join(" · ")}</span></p>`;
    od.chains.forEach(ch => {
      body += `<div class="opt-exp"><b>${esc(ch.expiration)}</b><span>${ch.days_to_exp} days out</span><span>ATM ${fUsd(ch.atm_strike)}</span>${isNum(od.iv_summary?.[ch.expiration]) ? `<span>IV ${fPct(od.iv_summary[ch.expiration], 1)}</span>` : ""}</div><div class="opt-pair">`;
      [["calls", ch.calls], ["puts", ch.puts]].forEach(([side, arr]) => {
        const rows = (arr || []).map(o => `<tr class="${o.in_the_money ? "itm" : ""}"><td class="hi">${fUsd(o.strike)}${o.in_the_money ? '<span class="itm-badge">ITM</span>' : ""}</td>
          <td>${fUsd(o.bid)}</td><td>${fUsd(o.ask)}</td><td>${fUsd(o.last)}</td><td>${fPct(o.iv, 1)}</td><td>${fInt(o.open_interest)}</td><td>${fInt(o.volume)}</td></tr>`).join("");
        body += `<div><div class="opt-side-label ${side}">${side}</div><div class="tbl-wrap"><table><thead><tr><th>Strike</th><th>Bid</th><th>Ask</th><th>Last</th><th>IV</th><th>OI</th><th>Vol</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No data</td></tr>'}</tbody></table></div></div>`;
      });
      body += `</div>`;
    });
    add("filings", card("options", "Live Options Chains", body, { open: false, count: od.chains.length + " exp", source: YQ_SRC }));
  }

  /* MD&A */
  if (d.mda_excerpt && !/unavailable|Failed|not found/i.test(d.mda_excerpt))
    add("filings", card("mda", "MD&A Excerpt (Latest 10-K)", `<div class="prose" style="font-size:13px"><blockquote>${esc(d.mda_excerpt)}</blockquote></div>`, { open: false, source: secSrc(d) }));

  /* Raw prompt */
  if (d.ai_prompt)
    add("filings", card("prompt", "Exact Data Sent to the AI",
      `<p style="font-size:12px;color:var(--ink-dim);margin-bottom:8px">The verbatim prompt the model received — every figure above is here, so what you see is what the AI reads.</p>
       <button class="copy-btn" onclick="copyPrompt(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy prompt</button>
       <pre class="raw">${esc(d.ai_prompt)}</pre>`, { open: false }));

  /* Sourced company news — last card, below the measurements. The model explains
     these records but does not search for them. */
  const news = Array.isArray(d.company_news) ? d.company_news : [];
  if (news.length) {
    const newsBody = `<div class="news-list">${news.slice(0, 10).map(item => {
      const href = safeHttpUrl(item.url);
      let date = "Date unavailable";
      if (item.published_at) {
        const parsed = new Date(item.published_at);
        if (!Number.isNaN(parsed.getTime())) date = parsed.toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" });
      }
      const headline = esc(item.headline || "Untitled story");
      const title = href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${headline}</a>` : `<span>${headline}</span>`;
      return `<article class="news-item">
        <div class="news-meta"><span>${esc(item.source || "Unknown source")}</span><time>${esc(date)}</time></div>
        <h4>${title}</h4>
        ${item.summary ? `<p>${esc(item.summary)}</p>` : ""}
      </article>`;
    }).join("")}</div><p class="learn-note">Stories are dated source records returned by Finnhub. Squall can explain them, but the linked publisher remains the source of truth.</p>`;
    add("filings", card("news", "Recent Company News", newsBody, { count: news.length }));
  }

  const body = document.getElementById("dataBody");
  body.innerHTML = renderViewRail(bucket);
  body.scrollTop = 0;
  wireViewRail();
  syncPaneVisibility();
  wireChartControls();

  /* AI summary — live stream shell if this ticker is mid-generation, else the final render */
  if (d.model) setModelTag(d.model);
  if (_stream && !_stream.done && _stream.ticker === d.ticker) {
    buildStreamShell();
    if (_stream.answerStarted) {
      document.getElementById("genIndicator")?.remove();
      const tog = document.getElementById("thinkingToggle");
      if (tog) { tog.classList.remove("open", "live"); const l = tog.querySelector(".tlabel"); if (l) l.textContent = "Show thinking"; }
      document.getElementById("thinkingPanel")?.classList.remove("show");
      flushStream(true);
    }
  } else {
    const ai = document.getElementById("aiSummary");
    ai.className = "prose";
    ai.innerHTML = aiWarnHtml(d) + thinkingBlock(d.aiReasoning) + renderAnalysisBody(d.aiSummary) + aiDisclaimerHtml(d);
    document.getElementById("aiScroll").scrollTop = 0;
  }

  renderChat();
  requestAnimationFrame(drawChart);
}

/* ════════════════ SHOW THINKING (model reasoning trace) ════════════════ */
function thinkingBlock(reasoning) {
  if (!reasoning || !reasoning.trim()) return "";
  const brain = `<svg class="brain" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18z"/></svg>`;
  const chev  = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  return `<div id="thinkingWrap">
    <button id="thinkingToggle" onclick="toggleThinking(this)">${brain}<span class="tlabel">Show thinking</span>${chev}</button>
    <div id="thinkingPanel"><span class="tk-label">Model reasoning · summarized</span>${esc(reasoning)}</div>
  </div>`;
}
function toggleThinking(btn) {
  const panel = document.getElementById("thinkingPanel");
  const open = panel.classList.toggle("show");
  btn.classList.toggle("open", open);
  const lbl = btn.querySelector(".tlabel");
  if (lbl && !btn.classList.contains("live")) lbl.textContent = open ? "Hide thinking" : "Show thinking";
}

function copyPrompt(btn) { navigator.clipboard.writeText(sessions[active]?.data?.ai_prompt || "").then(() => {
  btn.lastChild.textContent = " Copied"; setTimeout(() => (btn.lastChild.textContent = " Copy prompt"), 1600); }); }

function toggleInstFocus(on) { chartOpts.instWindow = on; }

/* ════════════════ CHART: controls + candlestick engine ════════════════ */
function chartCardBody() {
  const tog = (id, label, swatch, dash, dotted = false) =>
    `<label class="toggle ${chartOpts[id] ? "on" : ""}" style="--swatch:${swatch}">
      <input type="checkbox" data-opt="${id}" ${chartOpts[id] ? "checked" : ""}>
      ${dash ? `<span class="dash ${dotted ? "dotted" : ""}"></span>` : ""}${label}</label>`;
  /* Eight toggles laid out inline wrapped to two rows and, with the range selector, spent
     93px above a chart that had 312px of window to live in — more than a quarter of the
     view was the controls for the view. They are settings, not readings: they change
     rarely, they belong behind a disclosure. What stays on the row is what you act on
     while looking at the chart, plus the two labels that say what you are looking at. */
  const overlayMenu = `<div id="overlayMenu" role="menu" aria-label="Chart overlays">
      <div class="menu-head">Overlays</div>
      ${tog("ma20", "MA 20", "var(--accent)", true)}
      ${tog("ma50", "MA 50", "var(--warn)", true)}
      ${tog("ma200", "MA 200", "var(--ink-dim)", true)}
      ${tog("bb", "Bollinger", "var(--ink)", true, true)}
      ${tog("fib", "Auto Fib", "var(--ink-dim)", true, true)}
      ${tog("sr", "Support / Resistance", "var(--down)", true, true)}
      <div class="menu-head">Scale</div>
      ${tog("pct", "% scale", "var(--accent)", false)}
      ${tog("vol", "Volume", "var(--ink-dim)", false)}
      <details class="chart-guide"><summary>How to use Fibonacci</summary><p>Choose <b>Draw Fib</b>, then click the start and end of a price swing. Drag either endpoint to refine it. The 38.2%, 50%, and 61.8% lines are possible reaction <em>zones</em>—not predictions or automatic buy signals.</p></details>
    </div>`;
  const chev = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
  /* Compare carries no id on purpose. expandChart clones this row into the modal's control
     bar, and a cloned id is a duplicate id whose copy is dead — which is exactly why the
     overlay popover has to be skipped by that clone. Everything here is addressed by data
     attribute and driven by delegation, so both copies are live. */
  const compareWrap = `<div class="compare-wrap">
      <button class="chart-tool-btn quiet" type="button" data-compare-btn aria-haspopup="menu" aria-expanded="false" aria-label="Compare with another saved ticker">
        <span class="cmp-label">Compare</span><span class="cmp-label-short" aria-hidden="true">vs</span><b class="compare-cur" data-compare-cur></b>${chev}
      </button>
      <div class="compare-menu" role="menu" aria-label="Compare with another saved ticker" data-compare-menu></div>
    </div>`;
  return `<div id="chartControls">
    <div class="overlay-wrap">
      <button class="chart-tool-btn quiet" type="button" id="overlayBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="overlayMenu">
        Overlays<b class="overlay-count" data-overlay-count></b>${chev}
      </button>
      ${overlayMenu}
    </div>
    ${compareWrap}
    <button class="chart-tool-btn" type="button" data-chart-action="draw-fib">Draw Fib</button>
    <button class="chart-tool-btn quiet" type="button" data-chart-action="clear-fib">Clear Fib</button>
    <button class="chart-tool-btn quiet" type="button" data-chart-action="reset-zoom" hidden title="Back to the range's default window">Reset zoom</button>
    <span class="fib-status" data-fib-status></span>
    <span class="interval-chip" data-interval-chip title="Bar interval for the selected range"></span>
    <div id="rangeSel"></div></div>
    <div id="chartBox">
      <div class="chart-pane" id="chartPane">
        <canvas id="priceChart" role="img" aria-label="Candlestick price chart with volume"></canvas>
        <div id="chartTip" class="chart-tip"></div>
        <span class="pane-tag" data-pane-tag></span>
      </div>
      <div class="chart-pane" id="chartPaneB" hidden>
        <canvas id="compareChart" role="img" aria-label="Comparison candlestick price chart"></canvas>
        <div id="compareTip" class="chart-tip"></div>
        <span class="pane-tag" data-pane-tag></span>
      </div>
      <button class="chart-expand-btn" title="Expand chart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>
    </div>`;
}
function manualFibLevels(anchors) {
  if (!anchors?.start || !anchors?.end || !isNum(anchors.start.price) || !isNum(anchors.end.price)) return null;
  const levels = {};
  [["0%", 0], ["23.6%", .236], ["38.2%", .382], ["50%", .5], ["61.8%", .618], ["78.6%", .786], ["100%", 1]].forEach(([label, ratio]) => {
    levels[label] = anchors.end.price + (anchors.start.price - anchors.end.price) * ratio;
  });
  return levels;
}
function syncFibControls() {
  const sess = sessions[active], drawing = fibInteraction.mode && fibInteraction.ticker === active;
  document.querySelectorAll('[data-chart-action="draw-fib"]').forEach(btn => {
    btn.classList.toggle("active", drawing); btn.textContent = drawing ? "Cancel drawing" : (sess?.fibAnchors ? "Redraw Fib" : "Draw Fib");
  });
  document.querySelectorAll('[data-chart-action="clear-fib"]').forEach(btn => { btn.disabled = !sess?.fibAnchors && !drawing; });
  const status = drawing ? (fibInteraction.pending ? "Now choose the swing end" : "Choose the swing start") : (sess?.fibAnchors ? "Custom Fib saved" : "");
  document.querySelectorAll("[data-fib-status]").forEach(el => { el.textContent = status; });
}
function toggleFibDraw() {
  if (!active || !sessions[active]) return;
  const same = fibInteraction.mode && fibInteraction.ticker === active;
  fibInteraction.ticker = active; fibInteraction.mode = !same; fibInteraction.pending = null; fibInteraction.dragging = null;
  if (!same) chartOpts.fib = true;
  syncOverlayToggles();
  syncFibControls(); drawChart();
}
function clearManualFib() {
  const sess = sessions[active]; if (!sess) return;
  sess.fibAnchors = null; fibInteraction.mode = false; fibInteraction.pending = null; fibInteraction.dragging = null;
  touchSession(sess); scheduleSessionSave(); syncFibControls(); drawChart();
}
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-chart-action]"); if (!btn) return;
  if (btn.dataset.chartAction === "draw-fib") toggleFibDraw();
  if (btn.dataset.chartAction === "clear-fib") clearManualFib();
  if (btn.dataset.chartAction === "reset-zoom") { resetZoom(); syncChartChrome(); drawChart(); }
});

/* ── Compare control ──────────────────────────────────────────────────────────
   Delegated for the same reason #viewRail is: this markup is rebuilt by every render and
   cloned into the expand modal, so nothing may hold a reference to one instance of it. */
function closeCompareMenus() {
  document.querySelectorAll("[data-compare-menu]").forEach(m => m.classList.remove("open"));
  document.querySelectorAll("[data-compare-btn]").forEach(b => b.setAttribute("aria-expanded", "false"));
}
document.addEventListener("click", e => {
  const item = e.target.closest("[data-compare]");
  if (item) { closeCompareMenus(); setCompareTicker(item.dataset.compare || null); return; }
  const btn = e.target.closest("[data-compare-btn]");
  if (!btn) return;
  const menu = btn.parentElement?.querySelector("[data-compare-menu]");
  if (!menu) return;
  const open = !menu.classList.contains("open");
  closeCompareMenus();
  menu.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("pointerdown", e => {
  if (!e.target.closest("[data-compare-menu]") && !e.target.closest("[data-compare-btn]")) closeCompareMenus();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeCompareMenus(); }, true);

/* One writer for every copy of the chart's stateful chrome — inline row and the modal's
   clone of it. Called after a render, after a session list changes, and after any zoom or
   compare change, so the two bars can never disagree about what the chart is showing. */
function syncChartChrome() {
  const cmp = effectiveCompare();
  const others = Object.keys(sessions).filter(t => t !== active).sort();
  document.querySelectorAll("[data-compare-btn]").forEach(btn => {
    btn.disabled = !others.length;
    btn.title = others.length ? "Show a second saved ticker beside this chart"
                              : "Analyze a second ticker to compare charts";
    btn.classList.toggle("active", Boolean(cmp));
    const cur = btn.querySelector("[data-compare-cur]");
    if (cur) cur.textContent = cmp || "";
  });
  document.querySelectorAll("[data-compare-menu]").forEach(menu => {
    menu.innerHTML = `<div class="menu-head">Compare with</div>` +
      (others.length
        ? others.map(t => `<button type="button" role="menuitemradio" aria-checked="${t === cmp}" class="${t === cmp ? "on" : ""}" data-compare="${esc(t)}">${esc(t)}</button>`).join("")
        : `<div class="menu-empty">No other saved analyses yet.</div>`) +
      (cmp ? `<button type="button" class="menu-clear" data-compare="">Stop comparing</button>` : "");
  });
  // The reset is only offered once there is something to reset — an always-on button that
  // does nothing most of the time is one more thing in a row with no width to spare.
  document.querySelectorAll('[data-chart-action="reset-zoom"]').forEach(b => { b.hidden = !zoomActive(); });
}

/* The interval a range actually draws is not inferable from the candles — a 78-bar 1D view
   and a zoomed daily one look identical. Name it. */
function syncIntervalChip(id) {
  const spec = rangeSpec(id);
  document.querySelectorAll("[data-interval-chip]").forEach(el => { el.textContent = spec.note; });
}
function buildRangeSel(container) {
  if (!container) return;
  const sess = sessions[active];
  const d = sess?.data;
  // Only offer a tier the payload can actually draw. A fund, a thin name or a Yahoo miss
  // leaves intraday_history empty, and a button that renders nothing is worse than absent.
  const tiers = RANGES.filter(r => !d || rangeAvailable(d, r));
  let cur = normalizeRange(sess?.range);
  if (!tiers.some(r => r.id === cur)) cur = DEFAULT_RANGE;
  container.innerHTML = tiers.map(r =>
    `<button data-range="${r.id}" class="${cur === r.id ? "active" : ""}" title="${esc(r.note)}">${r.label}</button>`).join("");
  syncIntervalChip(cur);
  container.querySelectorAll("button").forEach(b => {
    b.onclick = () => {
      const id = b.dataset.range;
      if (sessions[active]) { sessions[active].range = id; touchSession(sessions[active]); scheduleSessionSave(); }
      // Choosing a tier is choosing a window, not zooming the one you had.
      resetZoom(id); syncChartChrome();
      // keep both selectors in sync
      ["#rangeSel", "#chartModalRangeSel"].forEach(sel =>
        document.querySelectorAll(sel + " button").forEach(x => x.classList.toggle("active", x.dataset.range === id)));
      syncIntervalChip(id);
      drawChart();
    };
  });
}

/* The button names how many overlays are on, so the row still reports the chart's state
   now that the toggles themselves are behind a disclosure. Without it, turning the whole
   set off and closing the menu leaves nothing on screen saying so. */
const OVERLAY_OPTS = ["ma20", "ma50", "ma200", "bb", "fib", "sr", "pct", "vol"];
function syncOverlayCount() {
  const n = OVERLAY_OPTS.filter(k => chartOpts[k]).length;
  document.querySelectorAll("[data-overlay-count]").forEach(el => { el.textContent = n ? String(n) : ""; });
}
/* Writes chartOpts back into every copy of the toggles — the inline menu and the clone
   expandChart puts in the modal bar — plus the count badge. Anything that changes an
   overlay from code rather than from a click has to call this, or the checkbox and the
   chart disagree about what is switched on and only one of them is visible. */
function syncOverlayToggles() {
  document.querySelectorAll("input[data-opt]").forEach(cb => {
    const on = Boolean(chartOpts[cb.dataset.opt]);
    cb.checked = on;
    cb.closest(".toggle")?.classList.toggle("on", on);
  });
  syncOverlayCount();
}
const overlayMenuOpen = () => document.getElementById("overlayMenu")?.classList.contains("open") || false;
function closeOverlayMenu() {
  document.getElementById("overlayMenu")?.classList.remove("open");
  document.getElementById("overlayBtn")?.setAttribute("aria-expanded", "false");
}
function wireChartControls() {
  document.querySelectorAll('#chartControls input[data-opt]').forEach(cb => {
    cb.onchange = () => { chartOpts[cb.dataset.opt] = cb.checked; cb.closest(".toggle").classList.toggle("on", cb.checked);
      syncOverlayCount(); drawChart(); };
  });
  const oBtn = document.getElementById("overlayBtn"), oMenu = document.getElementById("overlayMenu");
  if (oBtn && oMenu) {
    oBtn.onclick = () => {
      const open = !oMenu.classList.contains("open");
      oMenu.classList.toggle("open", open);
      oBtn.setAttribute("aria-expanded", String(open));
    };
  }
  syncOverlayCount();
  buildRangeSel(document.getElementById("rangeSel"));
  buildRangeSel(document.getElementById("chartModalRangeSel"));
  syncFibControls();
  syncChartChrome();
  const expandBtn = document.querySelector('.chart-expand-btn');
  if (expandBtn) expandBtn.onclick = () => window.expandChart(active);
  observeChartBox();
}
document.addEventListener("pointerdown", e => {
  if (!overlayMenuOpen()) return;
  if (!e.target.closest("#overlayMenu") && !e.target.closest("#overlayBtn")) closeOverlayMenu();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && overlayMenuOpen()) { e.stopPropagation(); closeOverlayMenu(); } }, true);

/* The canvas is sized by its container now instead of by a constant, so anything that
   changes the container's height — the split drag, entering the Chart destination, the
   focus-mode switch — has to repaint. The window resize handler below covers the window;
   this covers everything else. One observer, re-pointed at each render's fresh #chartBox. */
let _chartBoxRO = null;
function observeChartBox() {
  const box = document.getElementById("chartBox");
  if (!box) return;
  if (!_chartBoxRO) {
    let raf = null;
    _chartBoxRO = new ResizeObserver(() => {
      if (raf) return;                       // coalesce a drag's worth of callbacks into one paint
      raf = requestAnimationFrame(() => { raf = null; if (active) drawChart(); });
    });
  }
  _chartBoxRO.disconnect();
  _chartBoxRO.observe(box);
}
/* ── Axis ticks ───────────────────────────────────────────────────────────────
   Gridlines snapped to 1 / 2 / 2.5 / 5 x 10^n. The axis used to cut [lo,hi] into four
   equal parts and print each with `toFixed(val < 10 ? 2 : 0)` — decimals chosen from the
   PRICE rather than from the span. Zoom a $187 stock into one session and the window is
   seventy cents wide, so all five labels printed "$187" and the axis stopped carrying any
   information at exactly the magnification where it matters most. The step is the only
   number that knows how fine the scale is, so the decimals come from it.
   Hoisted, like isNum, because the load-time applyTheme() repaints the chart: a `const`
   here would be a temporal dead zone for every visitor holding a saved tab. */
function niceTicks(lo, hi, target = 5) {
  if (!isNum(lo) || !isNum(hi) || !(hi > lo)) return { ticks: [], dp: 2, step: 0 };
  /* Divided by `target`, not `target - 1`. Ticks here are INTERIOR to [lo,hi] — the range
     comes from the data and does not land on round numbers — so a step sized for `target-1`
     intervals loses roughly one tick at each end and consistently under-draws. A $916-941
     pane came back with $920 and $940 alone; a $0.42-0.98 one with two lines. */
  const raw = (hi - lo) / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  // Rungs placed so the count stays near the target from either side of a decade boundary.
  const step = (norm <= 1.2 ? 1 : norm <= 2 ? 2 : norm <= 3 ? 2.5 : norm <= 6 ? 5 : 10) * mag;
  const ticks = [];
  // The epsilon is on the loop bound, not on the values: floating accumulation otherwise
  // drops the top tick roughly half the time and the axis looks short by one line.
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6 && ticks.length < 24; v += step) ticks.push(v);
  /* Decimals that represent the step exactly — 2 for 0.25, 1 for 2.5, 0 for 50 — rather
     than a log approximation, which gets the 2.5 x 10^n family wrong in both directions. */
  let dp = 4;
  for (let d = 0; d <= 4; d++) {
    const scaled = step * Math.pow(10, d);
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) { dp = d; break; }
  }
  return { ticks, dp, step };
}
// Volume runs to ten digits and the label sits in a 46px band. fUsd's T/B/M shape without
// the currency, since a share count is not money.
function fVolShort(v) {
  if (!isNum(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(Math.round(v));
}

function movingAvg(arr, n) { const out = new Array(arr.length).fill(null); let sum = 0;
  for (let i = 0; i < arr.length; i++) { sum += arr[i]; if (i >= n) sum -= arr[i - n]; if (i >= n - 1) out[i] = sum / n; } return out; }

function bollinger(arr, n = 20, k = 2) {
  const mid = movingAvg(arr, n), up = new Array(arr.length).fill(null), lo = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) { const win = arr.slice(i - n + 1, i + 1); const m = mid[i];
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / n); up[i] = m + k * sd; lo[i] = m - k * sd; }
  return { mid, up, lo };
}

/* Which canvas / tooltip / pane each role paints into. The modal and the inline card are
   the same two panes at two sizes, so the only thing that varies is the id. */
function chartSlots() {
  const x = window.chartExpanded;
  const el = id => document.getElementById(id);
  const primary = sessions[active];
  if (!primary) return [];
  const cmp = effectiveCompare();
  return [
    { role: "primary", ticker: active, sess: primary,
      canvas: el(x ? "chartModalCanvas" : "priceChart"),
      tip:    el(x ? "chartModalTip" : "chartTip"),
      paneEl: el(x ? "chartModalPane" : "chartPane") },
    { role: "compare", ticker: cmp, sess: cmp ? sessions[cmp] : null,
      canvas: el(x ? "chartModalCompareCanvas" : "compareChart"),
      tip:    el(x ? "chartModalCompareTip" : "compareTip"),
      paneEl: el(x ? "chartModalPaneB" : "chartPaneB") }
  ];
}

/* ── Pane resolution ──────────────────────────────────────────────────────────
   Everything a pane will draw, worked out without touching a canvas: which timeframe it
   fell back to, which bars are on screen, the indicators over them, and the price bounds
   those bars plus their surviving overlays need.
   This used to live inside the painter, which was right while a pane's scale was its own
   business. It no longer is: percent mode has to put two panes on ONE domain, and that
   cannot be decided by either pane alone. drawChart needs the answer one step before
   anything is painted, so the resolution moved out here — one function, so the pre-pass
   and the painter can never disagree about what is on screen or how tall it is. */
function resolvePane(sess, ticker, primarySpec) {
  const d = sess.data;
  // A compare ticker need not have the tier the primary is on — a fund ships no intraday
  // series at all — so availability is resolved per pane.
  const spec = rangeAvailable(d, primarySpec) ? primarySpec : rangeSpec(DEFAULT_RANGE);
  const all = seriesFor(d, spec.tf);
  const full = Array.isArray(all) ? all.filter(p => isNum(p.close) && isNum(p.open) && isNum(p.high) && isNum(p.low)) : [];
  if (full.length < 5) return { spec, full, win: null, data: [], ok: false };

  // The tier's bar count is the DEFAULT window, not the window: zoom and pan move inside it.
  const win = visibleWindow(full.length, spec.bars, chartZoom);
  const data = full.slice(win.start, win.end);
  if (data.length < 2) return { spec, full, win, data, ok: false };

  /* Indicators are computed on the resolved series and then cut to the window, so on a
     5-minute chart "MA 20" is twenty five-minute periods — the conventional reading — and
     the first visible bar carries a real average rather than a null. */
  const closes = full.map(p => p.close);
  const cut = a => a.slice(win.start, win.end);
  const bbF = bollinger(closes, 20, 2);
  const ma = { ma20: cut(movingAvg(closes, 20)), ma50: cut(movingAvg(closes, 50)), ma200: cut(movingAvg(closes, 200)) };
  const bb = { up: cut(bbF.up), lo: cut(bbF.lo), mid: cut(bbF.mid) };
  const volAvg = chartOpts.vol ? cut(movingAvg(full.map(p => Number(p.volume) || 0), 20)) : null;

  /* Overlay levels come from the DAILY series and are the same prices on every timeframe,
     but the window they have to fit into is not. One session of 5-minute bars spans a
     couple of dollars; a support level 8% away then sets the y-axis on its own and the
     candles collapse into a sliver. The bars set the scale and a level only participates
     if it lands near them — and a level outside that band is not drawn either, because a
     line pinned to the top pixel is not information. */
  const barLo = Math.min(...data.map(p => p.low)), barHi = Math.max(...data.map(p => p.high));
  const slack = Math.max((barHi - barLo) * 0.6, barHi * 0.005);
  const inBand = x => isNum(x) && x >= barLo - slack && x <= barHi + slack;

  const kl = d.raw_data?.key_levels || {};
  const resistance = chartOpts.sr ? (kl.resistance || []).filter(inBand) : [];
  const support = chartOpts.sr ? (kl.support || []).filter(inBand) : [];
  const fibAll = chartOpts.fib ? (manualFibLevels(sess.fibAnchors) || d.price_action?.fib || null) : null;
  const fibIn = fibAll ? Object.fromEntries(Object.entries(fibAll).filter(([, x]) => inBand(x))) : null;
  const fib = fibIn && Object.keys(fibIn).length ? fibIn : null;

  const vals = [barLo, barHi];
  if (chartOpts.bb) bb.up.forEach((x, i) => { if (isNum(x) && inBand(x)) vals.push(x, bb.lo[i]); });
  resistance.forEach(x => vals.push(x));
  support.forEach(x => vals.push(x));
  if (fib) Object.values(fib).forEach(x => vals.push(x));
  if (fibInteraction.ticker === ticker && fibInteraction.pending) vals.push(fibInteraction.pending.price);
  const finite = vals.filter(isNum);
  const lo = Math.min(...finite) * 0.99, hi = Math.max(...finite) * 1.01;

  /* The pane's own extent expressed as percent from its first visible bar — the one unit
     two panes with different price levels can be reconciled in. Null when the base is
     unusable, which drops this pane out of the shared domain rather than poisoning it. */
  const base = data[0].close;
  const pct = (isNum(base) && base !== 0 && isNum(lo) && isNum(hi))
    ? { lo: (lo - base) / base * 100, hi: (hi - base) / base * 100 } : null;

  return { spec, full, win, data, ok: true, ma, bb, volAvg, resistance, support, fib, lo, hi, base, pct };
}

/* One percent domain across every pane on screen. This is the whole reason resolution
   happens out here: a pane cannot know the other pane's range, and without that knowledge
   "compare" draws two shapes on unrelated scales — NVDA at $890 beside AMD at $95 — which
   is not a comparison, it is two charts sharing a border. Rebasing is per pane (each has
   its own first visible bar) but the DOMAIN is shared, and that is what makes the two
   shapes overlayable. */
function sharedPercentDomain(panes) {
  const spans = panes.map(p => p && p.ok ? p.pct : null).filter(Boolean);
  if (!spans.length) return null;
  const lo = Math.min(...spans.map(s => s.lo)), hi = Math.max(...spans.map(s => s.hi));
  return (isNum(lo) && isNum(hi) && hi > lo) ? { lo, hi } : null;
}

function drawChart() {
  const sess = sessions[active]; if (!sess) return;
  // Resolve the timeframe before the series. A saved session can name a tier this payload
  // has no data for (an intraday range restored against a fund, or a provider miss on
  // re-run), so fall back rather than render an empty canvas.
  let spec = rangeSpec(normalizeRange(sess.range));
  if (!rangeAvailable(sess.data, spec)) spec = rangeSpec(DEFAULT_RANGE);
  // The viewport belongs to the tier. A range the user never chose (the fallback above, or
  // a restored tab) must not inherit the zoom left over from the tier they were last on.
  if (chartZoom.key !== spec.id) resetZoom(spec.id);

  const comparing = Boolean(effectiveCompare());
  const box = document.getElementById(window.chartExpanded ? "chartModalBody" : "chartBox");
  if (box) box.classList.toggle("comparing", comparing);

  const slots = chartSlots();
  slots.forEach(slot => {
    slot.show = slot.role === "primary" || comparing;
    slot.pane = (slot.show && slot.sess) ? resolvePane(slot.sess, slot.ticker, spec) : null;
  });
  // Only computed when the scale is actually in percent; in dollars each pane keeps its own
  // bounds exactly as before, and passing null is what says so.
  const shared = chartOpts.pct ? sharedPercentDomain(slots.map(s => s.pane)) : null;

  slots.forEach(slot => {
    if (slot.paneEl) slot.paneEl.hidden = !slot.show;
    // The canvas check matters at load: applyTheme() repaints before renderAll has ever
    // built the chart card, so every element here is still null on the first call.
    if (slot.show && slot.sess && slot.canvas) paintChartPane(slot, spec, comparing, shared);
  });
}

function paintChartPane(slot, primarySpec, comparing, shared) {
  const sess = slot.sess, d = sess.data;
  const st = chartPaneState[slot.role];
  const canvas = slot.canvas, tipEl = slot.tip;
  const R = slot.pane;
  if (!R) return;
  const spec = R.spec;
  // The pane tag names the interval it ACTUALLY drew rather than the one that was asked
  // for, and is written even when there is nothing to paint below.
  const tagEl = slot.paneEl ? slot.paneEl.querySelector("[data-pane-tag]") : null;
  if (tagEl) tagEl.textContent = comparing ? (slot.ticker + (spec.id === primarySpec.id ? "" : " · " + spec.note)) : "";
  if (!canvas || !tipEl || !R.ok) return;

  const full = R.full, win = R.win, data = R.data, len = full.length;
  const ma20 = R.ma.ma20, ma50 = R.ma.ma50, ma200 = R.ma.ma200;
  const bb = R.bb, volAvg = R.volAvg;

  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

  // Wind-front reveal — sweep the plot in on ticker / range / expand changes.
  // Key excludes canvas size so split-drags and window resizes don't retrigger it, and
  // excludes the viewport so a pinch or a pan — which repaint continuously — don't either.
  const revealKey = slot.ticker + "|" + spec.id + "|" + (window.chartExpanded ? "x" : "i");
  if (st.revealKey !== revealKey) {
    st.revealKey = revealKey;
    st.revealT0 = REDUCED ? 0 : performance.now();
  }
  let reveal = 1;
  if (st.revealT0) {
    const rt = (performance.now() - st.revealT0) / 650;
    if (rt >= 1) st.revealT0 = 0; else reveal = 1 - Math.pow(1 - rt, 3);
  }

  const manualAnchors = sess.fibAnchors;
  const srLevels = [...R.resistance.map(x => [x, cssVar("--down")]),
                    ...R.support.map(x => [x, cssVar("--up")])];
  const fibVisible = R.fib;

  /* Scale. In dollars a pane keeps its own bounds, exactly as before. In percent mode the
     bounds are DERIVED from the shared domain instead: converting the domain back into
     this pane's own prices means Y, Yinv, the levels, the candles and the bands all keep
     working in price space and need no percent-awareness at all. Only the axis labels and
     the two chips have to know, which is why the mode reaches no further than they do. */
  const pctMode = Boolean(chartOpts.pct && shared && isNum(R.base) && R.base !== 0);
  const toPct = v => (v - R.base) / R.base * 100;
  const fromPct = p => R.base * (1 + p / 100);
  const lo = pctMode ? fromPct(shared.lo) : R.lo;
  const hi = pctMode ? fromPct(shared.hi) : R.hi;

  // The pane tag is an HTML label sitting over the canvas's top-left. The top gridline and
  // any S/R label near the high are drawn right there, so while comparing the plot gives up
  // a strip for it rather than letting two pieces of text share the same pixels. Nothing is
  // spent in the single-chart case, where the tag renders empty.
  const padL = 54, padR = 14, padT = comparing ? 26 : 12, padB = 30;
  const volH = chartOpts.vol ? 46 : 0;
  const plotB = H - padB - volH;
  /* The volume band used to run from H-volH down to H-6 while the date labels drew at H-8,
     so the axis was printed across the bottom of the bars. Giving the band its own top and
     baseline separates them without spending any more height than volH already cost. */
  const volTop = plotB + 10, volB = H - padB + 8;
  const X = i => padL + (i + 0.5) / data.length * (W - padL - padR);
  const Y = val => padT + (1 - (val - lo) / (hi - lo)) * (plotB - padT);
  /* Inverse of Y. The crosshair reads a price off the pointer's own pixel rather than off
     the hovered bar, which is what makes it a measuring line rather than a second tooltip. */
  const Yinv = py => lo + (1 - (py - padT) / (plotB - padT)) * (hi - lo);
  const cw = Math.max(1, (W - padL - padR) / data.length);
  const bodyW = Math.max(1, Math.min(cw * 0.66, 13));

  /* Ticks are snapped in whatever unit the axis is labelled in — snapping prices and then
     converting would give nicely-spaced dollars carrying ragged percentages. */
  const axis = pctMode ? niceTicks(shared.lo, shared.hi, 5) : niceTicks(lo, hi, 5);
  const fmtAxis = pctMode
    ? v => (v >= 0 ? "+" : "") + v.toFixed(axis.dp) + "%"
    : v => (axis.dp === 0 && Math.abs(v) >= 10000)
      ? "$" + (v / 1000).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + "k"
      : "$" + v.toLocaleString("en-US", { minimumFractionDigits: axis.dp, maximumFractionDigits: axis.dp });
  // The chips report a single reading, so they carry their own precision rather than the
  // axis's: the gridline step says how coarse the AXIS is, not how coarse the number is.
  const fmtChip = v => pctMode ? ((toPct(v) >= 0 ? "+" : "") + toPct(v).toFixed(2) + "%") : fUsd(v);

  /* An opaque label in the left gutter, where the axis prices already live. The right
     gutter is 14px and widening it costs plot width on the axis a compare split has least
     of. Drawn over the tick labels deliberately — a chip and a gridline label sharing a
     baseline is the collision this exists to resolve. */
  const gutterChip = (yPx, text, bg, fg) => {
    ctx.font = "10px 'IBM Plex Mono', monospace";
    /* Sized to its text, not clamped to the gutter. A four-digit share price needs more
       than the 50px between the canvas edge and padL, and a chip clamped narrower than its
       label does not truncate it — fillText simply spills past the background onto the
       plot. Overrunning the gutter is what every trading chart's price tag does anyway. */
    const w = ctx.measureText(text).width + 8;
    const x = Math.max(1, padL - 4 - w);
    const y = Math.max(padT + 7, Math.min(plotB - 1, yPx));
    ctx.fillStyle = bg; ctx.fillRect(x, y - 7, w, 14);
    ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.fillText(text, x + 4, y + 3);
  };

  // grid + y axis
  ctx.font = "10px 'IBM Plex Mono', monospace"; ctx.strokeStyle = cssVar("--rule"); ctx.lineWidth = 1;
  axis.ticks.forEach(val => {
    const y = Y(pctMode ? fromPct(val) : val);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillStyle = cssVar("--ink-dim"); ctx.fillText(fmtAxis(val), 6, y + 3);
  });
  /* The crosshair's time chip is opaque and lands on the date axis. Its span is computed
     here, before the axis is drawn, so the tick underneath can be SKIPPED rather than
     overprinted — a chip that only partly covers a label leaves a fragment of the old date
     showing beside the new one, which reads as a rendering fault. */
  let stampBox = null;
  if (isNum(st.hover) && st.hover < data.length) {
    const text = axisLabel(data[st.hover], spec.tf, true);
    ctx.font = "10px 'IBM Plex Mono', monospace";
    const w = ctx.measureText(text).width + 8;
    stampBox = { text, w, x: Math.max(padL, Math.min(W - padR - w, X(st.hover) - w / 2)) };
  }

  // x axis (dates)
  ctx.textAlign = "center"; ctx.fillStyle = cssVar("--ink-dim");
  for (let g = 0; g <= 4; g++) {
    const i = Math.round(g / 4 * (data.length - 1));
    const label = axisLabel(data[i], spec.tf, g === 0 || g === 4);
    if (stampBox) {
      const lw = ctx.measureText(label).width;
      const lx = Math.max(lw / 2 + 2, Math.min(W - lw / 2 - 2, X(i)));
      if (lx + lw / 2 >= stampBox.x - 2 && lx - lw / 2 <= stampBox.x + stampBox.w + 2) continue;
    }
    // Edge ticks carry the day as well as the clock, so they are the widest labels on the
    // axis and the outermost — centred on their own tick they run off the canvas and get
    // clipped mid-character. Nudge them inside instead of letting the edge eat them.
    const half = ctx.measureText(label).width / 2;
    ctx.fillText(label, Math.max(half + 2, Math.min(W - half - 2, X(i))), H - 8);
  }

  // everything painted after the axes is clipped to the reveal front
  const frontX = reveal >= 1 ? W : padL + reveal * (W - padL - padR);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, frontX, H); ctx.clip();

  // volume
  if (chartOpts.vol) {
    const maxVol = Math.max(...data.map(p => p.volume || 0)) || 1;
    const volY = v => volB - Math.max(0, Math.min(1, (Number(v) || 0) / maxVol)) * (volB - volTop);
    data.forEach((p, i) => {
      const y = volY(p.volume);
      ctx.fillStyle = (p.close >= p.open ? cssVar("--up") : cssVar("--down")); ctx.globalAlpha = .35;
      ctx.fillRect(X(i) - bodyW / 2, y, bodyW, volB - y); ctx.globalAlpha = 1;
    });
    /* The 20-period average is the reference the whole rest of the app already reasons in —
       §6b feeds the model "volume against the 20-day average" and the dashboard quotes it —
       so the chart was the one surface silent about it, showing bars whose only meaning was
       "tallest in this window". On a 5-minute series it is twenty five-minute periods, the
       same convention the price MAs follow. */
    if (volAvg) {
      ctx.beginPath(); let vst = false;
      volAvg.forEach((v, i) => { if (!isNum(v)) return; vst ? ctx.lineTo(X(i), volY(v)) : ctx.moveTo(X(i), volY(v)); vst = true; });
      ctx.strokeStyle = cssVar("--ink-dim"); ctx.lineWidth = 1; ctx.globalAlpha = .85; ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.font = "10px 'IBM Plex Mono', monospace"; ctx.fillStyle = cssVar("--ink-dim"); ctx.textAlign = "left";
    ctx.fillText(fVolShort(maxVol), 6, volTop + 8);
  }

  // Bollinger band fill + lines
  if (chartOpts.bb) {
    ctx.beginPath(); let started = false;
    bb.up.forEach((x, i) => { if (!isNum(x)) return; started ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x)); started = true; });
    for (let i = bb.lo.length - 1; i >= 0; i--) if (isNum(bb.lo[i])) ctx.lineTo(X(i), Y(bb.lo[i]));
    // Tint from the token rather than a literal, so the band tracks the theme. cssVar returns
    // an opaque color, so the transparency comes from globalAlpha instead of an rgba().
    ctx.closePath(); ctx.fillStyle = cssVar("--ink"); ctx.globalAlpha = .07; ctx.fill(); ctx.globalAlpha = 1;
    [["up", bb.up], ["lo", bb.lo]].forEach(([, arr]) => { ctx.beginPath(); let st = false;
      arr.forEach((x, i) => { if (!isNum(x)) return; st ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x)); st = true; });
      ctx.strokeStyle = cssVar("--ink"); ctx.globalAlpha = .5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1; });
  }

  // S/R lines
  srLevels.forEach(([val, color]) => { ctx.strokeStyle = color; ctx.globalAlpha = .55; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, Y(val)); ctx.lineTo(W - padR, Y(val)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.textAlign = "left"; ctx.fillText(fUsd(val), padL + 3, Y(val) - 3); });

  // Fibonacci
  if (fibVisible) { Object.entries(fibVisible).forEach(([k, val]) => { if (!isNum(val)) return;
    ctx.strokeStyle = cssVar("--ink-dim"); ctx.globalAlpha = .4; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(padL, Y(val)); ctx.lineTo(W - padR, Y(val)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar("--ink-dim"); ctx.textAlign = "right"; ctx.fillText(k, W - padR - 3, Y(val) - 3); }); }

  // A custom Fib has a visible swing leg and draggable endpoints.
  const anchorPoint = anchor => {
    if (!anchor) return null;
    const i = data.findIndex(p => p.date === anchor.date);
    return i < 0 ? null : { x: X(i), y: Y(anchor.price), i };
  };
  const startPoint = anchorPoint(manualAnchors?.start), endPoint = anchorPoint(manualAnchors?.end);
  if (startPoint && endPoint) {
    ctx.strokeStyle = cssVar("--accent"); ctx.lineWidth = 1.4; ctx.globalAlpha = .8;
    ctx.beginPath(); ctx.moveTo(startPoint.x, startPoint.y); ctx.lineTo(endPoint.x, endPoint.y); ctx.stroke(); ctx.globalAlpha = 1;
    [startPoint, endPoint].forEach(point => { ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, Math.PI * 2); ctx.fillStyle = cssVar("--chrome-1"); ctx.fill(); ctx.strokeStyle = cssVar("--accent"); ctx.lineWidth = 2; ctx.stroke(); });
  }
  const pendingPoint = fibInteraction.ticker === slot.ticker ? anchorPoint(fibInteraction.pending) : null;
  if (pendingPoint) { ctx.beginPath(); ctx.arc(pendingPoint.x, pendingPoint.y, 6, 0, Math.PI * 2); ctx.fillStyle = cssVar("--accent"); ctx.fill(); }

  // MA lines
  const maSpec = [[chartOpts.ma200, ma200, cssVar("--ink-dim"), 1.2], [chartOpts.ma50, ma50, cssVar("--warn"), 1.4], [chartOpts.ma20, ma20, cssVar("--accent"), 1.4]];
  maSpec.forEach(([on, arr, color, wgt]) => { if (!on) return; ctx.beginPath(); let st = false;
    arr.forEach((val, i) => { if (val === null) return; st ? ctx.lineTo(X(i), Y(val)) : ctx.moveTo(X(i), Y(val)); st = true; });
    ctx.strokeStyle = color; ctx.lineWidth = wgt; ctx.stroke(); });

  // CANDLES
  ctx.lineWidth = 1;
  data.forEach((p, i) => {
    const up = p.close >= p.open, color = up ? cssVar("--up") : cssVar("--down");
    const x = X(i);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    // wick
    ctx.beginPath(); ctx.moveTo(x, Y(p.high)); ctx.lineTo(x, Y(p.low)); ctx.stroke();
    // body
    const yO = Y(p.open), yC = Y(p.close); const top = Math.min(yO, yC); const hgt = Math.max(1, Math.abs(yC - yO));
    if (up) { ctx.globalAlpha = document.documentElement.dataset.mode === "dark" ? .85 : 1; ctx.fillRect(x - bodyW / 2, top, bodyW, hgt); ctx.globalAlpha = 1; }
    else { ctx.fillRect(x - bodyW / 2, top, bodyW, hgt); }
  });

  /* Where it is now. Nothing marked the latest close, so "what does this trade at" meant
     hovering the final candle — the one question a price chart should answer before it is
     touched. Tinted by that bar's own direction so the marker agrees with the candle it
     belongs to, and drawn after the candles so the line is never buried under one. */
  const lastBar = data[data.length - 1];
  if (lastBar && isNum(lastBar.close)) {
    const lastCol = cssVar(lastBar.close >= lastBar.open ? "--up" : "--down");
    const ly = Y(lastBar.close);
    ctx.strokeStyle = lastCol; ctx.globalAlpha = .7; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(W - padR, ly); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    gutterChip(ly, fmtChip(lastBar.close), lastCol, cssVar("--chrome-0"));
  }

  ctx.restore();   // lift the reveal clip
  if (reveal < 1) {
    // glowing accent edge riding the reveal front — the "wind" doing the drawing
    const ac = cssVar("--accent");
    const grad = ctx.createLinearGradient(frontX - 34, 0, frontX, 0);
    grad.addColorStop(0, ac + "00"); grad.addColorStop(1, ac + "55");
    ctx.fillStyle = grad; ctx.fillRect(frontX - 34, padT, 34, plotB - padT);
  }

  const pointFromEvent = e => {
    const rect = canvas.getBoundingClientRect();
    const i = Math.max(0, Math.min(data.length - 1, Math.floor(((e.clientX - rect.left) - padL) / (W - padL - padR) * data.length)));
    const p = data[i]; if (!p) return null;
    const py = e.clientY - rect.top;
    const price = Math.abs(py - Y(p.high)) <= Math.abs(py - Y(p.low)) ? p.high : p.low;
    // `py` is the raw pointer pixel; `price`/`y` are snapped to the nearer extreme for Fib
    // placement. The crosshair wants the former, Fib the latter — hence both.
    return { date: p.date, price, i, x: X(i), y: Y(price), py };
  };
  const showHover = e => {
    const hit = pointFromEvent(e); if (!hit) return;
    const i = hit.i;
    const p = data[i]; if (!p) return;
    st.hover = i; st.hoverY = hit.py; drawChart();
    tipEl.style.display = "block";
    const chg = ((p.close - p.open) / p.open) * 100;
    tipEl.innerHTML = `<b>${p.date}</b><br>O ${fUsd(p.open)} · H ${fUsd(p.high)}<br>L ${fUsd(p.low)} · C ${fUsd(p.close)}<br>
      <span class="${chg >= 0 ? "tg" : "tr"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span> · Vol ${fInt(p.volume)}`;
    const tx = Math.min(X(i) + 12, W - 160); tipEl.style.left = Math.max(padL, tx) + "px"; tipEl.style.top = "10px";
  };

  /* ── Viewport gestures ──────────────────────────────────────────────────────
     Zoom and pan write to the shared chartZoom and repaint everything, so the compare
     pane follows the pane being touched. `plotW` is the drawable width; a fraction of it
     is what a zoom anchors on and what a pan converts into bars. */
  const plotW = W - padL - padR;
  const fracFromClientX = cx => {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, ((cx - rect.left) - padL) / plotW));
  };
  const setViewport = next => {
    if (next.count === win.count && next.offset === win.offset) return;
    chartZoom.count = next.count; chartZoom.offset = next.offset;
    tipEl.style.display = "none"; st.hover = null; st.hoverY = null;
    syncChartChrome(); drawChart();
  };
  // The window a gesture started from, so a pinch or a drag stays absolute against its own
  // starting point rather than compounding its own rounding frame after frame.
  const windowFrom = base => visibleWindow(len, spec.bars, base);
  /* Ctrl/⌘ + wheel, and the trackpad pinch the platform delivers as a ctrlKey wheel. A
     bare wheel is deliberately left alone: the chart lives inside a scrolling pane, and
     swallowing the page scroll whenever the pointer crosses a canvas is the thing that
     makes an embedded chart hostile to the page around it. */
  canvas.onwheel = e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // deltaMode normalizes lines and pages to pixels; the exponent — not the delta — is
    // what gets clamped, so one violent flick of a wheel cannot jump the whole series.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * H : e.deltaY;
    setViewport(zoomWindow(win, Math.exp(Math.max(-0.7, Math.min(0.7, dy * 0.0022))), fracFromClientX(e.clientX), len));
  };

  const pointers = st.pointers || (st.pointers = new Map());
  const setPanning = on => { if (slot.paneEl) slot.paneEl.classList.toggle("panning", on); };
  const endGesture = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) st.pinch = null;
    if (!pointers.size) { st.drag = null; setPanning(false); }
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.onpointerdown = e => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    /* Two fingers is a pinch, whatever the first one had started. Capture both so a finger
       that wanders off the canvas mid-gesture keeps reporting to it. */
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      st.drag = null; setPanning(false);
      st.pinch = { dist: Math.max(1, Math.abs(a.x - b.x)), anchor: fracFromClientX((a.x + b.x) / 2),
                   base: { count: win.count, offset: win.offset } };
      tipEl.style.display = "none"; st.hover = null; st.hoverY = null;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (pointers.size > 2) return;
    const hit = pointFromEvent(e); if (!hit) return;
    const drawing = fibInteraction.mode && fibInteraction.ticker === active && slot.role === "primary";
    if (drawing) {
      if (!fibInteraction.pending) fibInteraction.pending = { date: hit.date, price: hit.price };
      else {
        sess.fibAnchors = { start: fibInteraction.pending, end: { date: hit.date, price: hit.price } };
        fibInteraction.pending = null; fibInteraction.mode = false; touchSession(sess); scheduleSessionSave();
      }
      syncFibControls(); drawChart(); return;
    }
    const rect = canvas.getBoundingClientRect();
    const near = (point, name) => point && Math.hypot((e.clientX - rect.left) - point.x, (e.clientY - rect.top) - point.y) <= 14 ? name : null;
    const handle = slot.role === "primary" ? (near(startPoint, "start") || near(endPoint, "end")) : null;
    if (handle) { fibInteraction.dragging = handle; fibInteraction.ticker = active; canvas.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    // Otherwise arm a pan. It does not become one until the pointer has actually travelled,
    // so a plain click still reads as a click and hover keeps working under a resting mouse.
    st.drag = { x: e.clientX, base: { count: win.count, offset: win.offset }, moved: false };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.onpointermove = e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (st.pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(1, Math.abs(a.x - b.x));
      // Spreading the fingers grows the distance, which must SHRINK the bar count.
      setViewport(zoomWindow(windowFrom(st.pinch.base), st.pinch.dist / dist, st.pinch.anchor, len));
      return;
    }
    if (fibInteraction.dragging && fibInteraction.ticker === active && slot.role === "primary" && sess.fibAnchors) {
      const hit = pointFromEvent(e); if (!hit) return;
      sess.fibAnchors[fibInteraction.dragging] = { date: hit.date, price: hit.price };
      tipEl.style.display = "none"; drawChart(); return;
    }
    if (st.drag) {
      const dx = e.clientX - st.drag.x;
      if (st.drag.moved || Math.abs(dx) > 3) {
        st.drag.moved = true; setPanning(true);
        const barW = plotW / Math.max(1, win.count);
        setViewport(panWindow(windowFrom(st.drag.base), dx / barW, len));
        return;
      }
    }
    showHover(e);
  };
  canvas.onpointerup = e => {
    const wasDrag = st.drag && st.drag.moved;
    endGesture(e);
    if (fibInteraction.dragging && slot.role === "primary") {
      fibInteraction.dragging = null; touchSession(sess); scheduleSessionSave(); syncFibControls(); drawChart();
    } else if (wasDrag) drawChart();
  };
  canvas.onpointercancel = canvas.onpointerup;
  canvas.onmouseleave = () => {
    if (fibInteraction.dragging || st.drag || st.pinch) return;
    tipEl.style.display = "none"; st.hover = null; st.hoverY = null; drawChart();
  };

  /* Crosshair: two lines and two chips. It used to be a single vertical rule, which said
     WHICH bar the pointer was on but not what price it sat at — the measurement people
     actually take off a chart, and the reason a bare vertical reads as a decoration.
     The horizontal follows the pointer's own pixel rather than the bar: the snap-to-high-
     or-low in pointFromEvent exists for placing Fib anchors and would make a measuring
     line jump between extremes as the cursor crossed the midpoint of a candle. */
  if (isNum(st.hover) && st.hover < data.length) {
    const x = X(st.hover);
    const hy = isNum(st.hoverY) ? Math.max(padT, Math.min(plotB, st.hoverY)) : null;
    ctx.strokeStyle = cssVar("--ink-dim"); ctx.globalAlpha = .45; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, plotB); ctx.stroke();
    if (hy !== null) { ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(W - padR, hy); ctx.stroke(); }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    // Chips last and opaque: they sit over the gridline labels and the date ticks they
    // would otherwise have to be read through.
    if (hy !== null) gutterChip(hy, fmtChip(Yinv(hy)), cssVar("--ink"), cssVar("--chrome-0"));
    if (stampBox) {
      ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = cssVar("--ink"); ctx.fillRect(stampBox.x, H - 18, stampBox.w, 14);
      ctx.fillStyle = cssVar("--chrome-0"); ctx.textAlign = "left"; ctx.fillText(stampBox.text, stampBox.x + 4, H - 8);
    }
  }

  // keep sweeping until the reveal completes
  if (st.revealT0 && !st.revealRaf) {
    st.revealRaf = requestAnimationFrame(() => { st.revealRaf = null; drawChart(); });
  }
}
/* The modal fires this on open and on close, and open is when expandChart has just cloned
   the control row — so this is where the clone gets its live state written into it. */
window.chartRedrawCallback = function () { syncChartChrome(); drawChart(); };
window.addEventListener("resize", () => { syncMetricDensity(); clearTimeout(window._rz); window._rz = setTimeout(() => { if (active) drawChart(); }, 120); });

/* ════════════════ MARKDOWN ════════════════ */
function renderMarkdown(text) {
  let t = esc(text);
  t = t.replace(/((?:^\|.*\|[ \t]*$\n?)+)/gm, block => {
    const lines = block.trim().split("\n").filter(l => l.trim()); if (lines.length < 2) return block;
    const cells = l => l.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    let out = "<div class='tbl-wrap'><table>";
    lines.forEach((line, idx) => { if (/^\|?\s*:?-{2,}/.test(line)) return; const tag = idx === 0 ? "th" : "td";
      out += "<tr>" + cells(line).map(c => `<${tag}>${c}</${tag}>`).join("") + "</tr>"; });
    return out + "</table></div>\n";
  });
  return t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^#{3,4} (.+)$/gm, "<h3>$1</h3>").replace(/^#{1,2} (.+)$/gm, "<h2>$1</h2>")
    .replace(/^>\s?(.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^[-•*]\s+(.+)$/gm, "<li>$1</li>").replace(/^(\d+)\.\s+(.+)$/gm, "<li>$2</li>")
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
    .replace(/^-{3,}$/gm, "<hr>").replace(/\n{2,}/g, "</p><p>")
    .replace(/^(?!\s*<[hpuoldbt])(.+)$/gm, "<p>$1</p>").replace(/<p>\s*<\/p>/g, "");
}

/* ════════════════ ANALYSIS BODY (verdict + collapsible sections) ════════════════
   The write-up is 900–1300 words under seven ## headers, and it rendered as one unbroken
   column of prose — the verdict, which is the thing being looked for, indistinguishable
   from the paragraph after it. This promotes the verdict and makes the rest navigable.
   Not one word is dropped: the prompt is untouched and every section still renders. */
const VERDICT_RATINGS = ["Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"];
// Green and red are direction. Hold is neither, so it is neutral ink — NOT --warn, which
// is a distinct role and would read as a caution the model did not express.
const RATING_TONE = { "strong buy": "up", "buy": "up", "hold": "flat", "sell": "down", "strong sell": "down" };
// Opened by default: the two sections that carry the reasoning behind the call. The rest
// are one click away rather than one scroll.
const AI_OPEN_SECTIONS = /valuation|price action/i;

function splitAnalysisSections(text) {
  const lines = String(text).split("\n");
  const out = []; let preamble = []; let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !/^###/.test(line)) {
      if (cur) out.push(cur);
      cur = { heading: m[1], body: [] };
    } else if (cur) cur.body.push(line);
    else preamble.push(line);
  }
  if (cur) out.push(cur);
  return { preamble: preamble.join("\n").trim(), sections: out.map(s => ({ heading: s.heading, body: s.body.join("\n").trim() })) };
}

function renderAnalysisBody(markdown) {
  const text = String(markdown || "");
  if (!text.trim()) return "";
  const { preamble, sections } = splitAnalysisSections(text);
  /* The single most important line here. The model can and does go off-format — a missing
     header, a numbered list instead of headings, a truncated stream — and an analysis that
     vanishes behind a parser is far worse than one that renders flat. Below two headers
     there is nothing to section, so hand back exactly what the old renderer produced. */
  if (sections.length < 2) return renderMarkdown(text);

  let html = preamble ? renderMarkdown(preamble) : "";
  let rest = sections;

  if (/verdict/i.test(sections[0].heading)) {
    const v = sections[0];
    rest = sections.slice(1);
    // Pull the rating out of its **bold** so it can be typeset as a rating rather than as
    // an emphasised phrase in a sentence.
    const found = VERDICT_RATINGS.find(r => new RegExp(`\\*\\*\\s*${r}\\s*\\*\\*`, "i").test(v.body));
    let prose = v.body;
    let head = "";
    if (found) {
      prose = prose.replace(new RegExp(`\\*\\*\\s*${found}\\s*\\*\\*[\\s.:—-]*`, "i"), "");
      head = `<span class="verdict-rating" data-tone="${RATING_TONE[found.toLowerCase()]}">${esc(found)}</span>`;
    }
    // No rating matched? Still render the section — dropping the verdict because it was
    // phrased unexpectedly is the one outcome worth avoiding.
    html += `<div class="verdict-block"><div class="verdict-head">${head}
      <span class="verdict-label">${esc(v.heading)}</span></div>
      <div class="verdict-body">${renderMarkdown(prose.trim())}</div></div>`;
  }

  html += rest.map(s =>
    `<details class="ai-section"${AI_OPEN_SECTIONS.test(s.heading) ? " open" : ""}>
      <summary><span>${esc(s.heading)}</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </summary><div class="ai-section-body">${renderMarkdown(s.body)}</div></details>`).join("");
  return html;
}

/* ════════════════ CHAT (per-ticker, streaming) ════════════════ */
let chatThink = false;   // model reasoning — OFF by default
try { chatThink = localStorage.getItem("squall-chat-think") === "1"; } catch (e) {}
let chatSticky = true;   // auto-scroll unless the reader scrolls up mid-stream

function syncChatThinkBtn() { document.getElementById("chatThinkBtn")?.classList.toggle("on", chatThink); }
function toggleChatThink() {
  chatThink = !chatThink;
  try { localStorage.setItem("squall-chat-think", chatThink ? "1" : "0"); } catch (e) {}
  syncChatThinkBtn();
}

const _brainSvg = `<svg class="brain" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18z"/></svg>`;
const _chevSvg  = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

// Send button doubles as a stop control while a reply streams.
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>`;
const STOP_SVG = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`;
function setChatSendMode(streaming) {
  const btn = document.getElementById("chatSend");
  if (!btn) return;
  btn.classList.toggle("stopping", streaming);
  btn.innerHTML = streaming ? STOP_SVG : SEND_SVG;
  btn.setAttribute("aria-label", streaming ? "Stop response" : "Send");
  btn.disabled = false;
}
function syncChatSendMode() { setChatSendMode(!!sessions[active]?._chatBusy); }
// One click handler: stop if a reply is streaming, otherwise send.
function onChatSend() {
  const sess = sessions[active];
  if (sess && sess._chatBusy) stopChat(); else sendChat();
}
function stopChat() {
  const sess = sessions[active];
  if (sess && sess._chatAbort) { try { sess._chatAbort.abort(); } catch (e) {} }
}
// Retry a follow-up: drop the failed reply and re-stream from the last question.
function retryChat() {
  const sess = sessions[active];
  if (!sess || sess._chatBusy) return;
  while (sess.history.length && sess.history[sess.history.length - 1].role === "assistant") sess.history.pop();
  if (!sess.history.length) return;
  streamChatReply(sess);
}

function chatThinkingBlock(reasoning, live) {
  if (!reasoning || !reasoning.trim()) return "";
  return `<div class="chat-think ${live ? "open live" : ""}">
    <button class="chat-think-toggle" onclick="this.closest('.chat-think').classList.toggle('open')"><span class="live-dot"></span>${_brainSvg}<span>${live ? "Thinking" : "Show thinking"}</span>${_chevSvg}</button>
    <div class="chat-think-panel">${esc(reasoning)}</div>
  </div>`;
}
function chatMsgInner(msg) {
  const thinkingLive = !!msg.streaming && !msg.content;   // still reasoning, not yet answering
  const think = chatThinkingBlock(msg.reasoning, thinkingLive);
  const retry = msg.error ? `<button class="retry-btn" onclick="retryChat()">${RETRY_SVG}<span>Retry</span></button>` : "";
  if (msg.content) return think + `<div class="prose${msg.error ? " chat-err" : ""}">${renderMarkdown(msg.content)}</div>` + retry;
  if (msg.streaming) return think + (msg.reasoning ? "" : `<div class="chat-typing"><span class="gust-dots"><i></i><i></i><i></i></span> Thinking…</div>`);
  return think + `<div class="prose${msg.error ? " chat-err" : ""}">${esc(msg.content || "")}</div>` + retry;
}

function renderChat() {
  const m = document.getElementById("chatMessages"); const sess = sessions[active];
  syncChatDock();   // an empty thread is an input row, not a 280px band
  if (!sess) { m.innerHTML = ""; return; }
  if (!sess.history.length) {
    m.innerHTML = `<div class="chat-empty">Ask anything about <b>${esc(active)}</b> — risks, peers, options ideas, or how institutions are positioned. Each ticker keeps its own thread.</div>`;
    return;
  }
  m.innerHTML = sess.history.map((msg, i) => msg.role === "user"
    ? `<div class="msg user">${esc(msg.content)}</div>`
    : `<div class="msg ai" data-i="${i}">${chatMsgInner(msg)}</div>`).join("");
  scrollChat();
}
// Repaint just the streaming message node — avoids rebuilding the whole thread on every token.
function paintChatStream(sess, idx) {
  const node = document.querySelector(`#chatMessages .msg.ai[data-i="${idx}"]`);
  if (!node) return;
  const wasOpen = node.querySelector(".chat-think")?.classList.contains("open");
  node.innerHTML = chatMsgInner(sess.history[idx]);
  const think = node.querySelector(".chat-think");
  if (think && wasOpen) think.classList.add("open");                       // keep the reader's manual toggle
  const livePanel = think?.classList.contains("live") ? think.querySelector(".chat-think-panel") : null;
  if (livePanel) livePanel.scrollTop = livePanel.scrollHeight;             // follow the reasoning as it streams
  const wrap = document.getElementById("chatMessages");
  if (chatSticky) wrap.scrollTop = wrap.scrollHeight;
}

function sendChat() {
  const input = document.getElementById("chatInput");
  const sess = sessions[active]; const msg = input.value.trim();
  if (!msg || !sess || sess._chatBusy) return;

  let content = msg;
  if (chartOpts.instWindow) content = "[Focus on institutional positioning and price-action evidence] " + msg;

  input.value = "";
  sess.history.push({ role: "user", content });
  streamChatReply(sess);
}

// Streams one assistant reply into `sess` using the current history. Reusable by
// sendChat (new question) and retryChat (re-run the last question after a failure).
async function streamChatReply(sess) {
  const aiMsg = { role: "assistant", content: "", reasoning: "", streaming: true };
  sess.history.push(aiMsg);
  const aiIdx = sess.history.length - 1;
  sess._chatBusy = true; chatSticky = true;
  const ctrl = new AbortController();
  sess._chatAbort = ctrl;
  if (sessions[active] === sess) { renderChat(); setChatSendMode(true); }

  // Only role + content go to the server (drop the in-flight msg and any prior errored replies).
  const outbound = sess.history
    .filter(x => !x.streaming && !(x.role === "assistant" && x.error))
    .map(({ role, content }) => ({ role, content }));

  let raf = null;
  const schedulePaint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; if (sessions[active] === sess) paintChatStream(sess, aiIdx); }); };

  try {
    const res = await fetch("/chat", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: outbound, context: sess.context, analysis: sess.data.aiSummary || "",
        think: chatThink, profile: sess.profile || null }) });
    // A limited/refused request answers with a JSON body carrying a real explanation.
    // Throwing the bare status would surface it as "⚠️ Connection error: server responded
    // 429" and hide what the server actually said. Thrown rather than handled inline
    // because the cleanup below this try is not a finally — returning early would leave
    // _chatBusy set and wedge the thread.
    if (!res.ok || !res.body) {
      const info = await res.json().catch(() => null);
      const err = new Error((info && info.error) || ("server responded " + res.status));
      err.fromServer = Boolean(info && info.error);
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", evt = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (l.startsWith("event:")) { evt = l.slice(6).trim(); continue; }
        if (!l.startsWith("data:")) continue;
        let j; try { j = JSON.parse(l.slice(5).trim()); } catch { continue; }
        if      (evt === "think") { aiMsg.reasoning += j.t; schedulePaint(); }
        else if (evt === "delta") { aiMsg.content   += j.t; schedulePaint(); }
        // `truncated` means the model stopped at its token ceiling, not that it finished.
        // Marking it inline is the whole point: an answer that just stops mid-sentence
        // reads as the model being vague rather than as the reply being cut in half.
        else if (evt === "done")  { if (j.reply) aiMsg.content = j.reply; if (j.reasoning) aiMsg.reasoning = j.reasoning;
                                    if (j.truncated) aiMsg.content += "\n\n_…cut off at the length limit._"; }
        else if (evt === "error") { aiMsg.error = true; aiMsg.content = (aiMsg.content ? aiMsg.content + "\n\n" : "") + "⚠️ " + j.error; }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      // User stopped it — keep whatever streamed; note it if nothing arrived.
      if (!aiMsg.content.trim()) aiMsg.content = "_Stopped._";
    } else if (e.fromServer) {
      // The server explained itself (rate limit, capacity, budget) — quote it verbatim
      // rather than dressing it up as a connection failure.
      aiMsg.error = true;
      aiMsg.content = "⚠️ " + e.message;
    } else {
      aiMsg.error = true;
      if (!aiMsg.content) aiMsg.content = "⚠️ Connection error: " + e.message + " — please try again.";
    }
  }

  aiMsg.streaming = false;
  sess._chatBusy = false; sess._chatAbort = null;
  touchSession(sess); persistSessions(); renderTickerPills();
  if (sessions[active] === sess) { renderChat(); setChatSendMode(false); }
  document.getElementById("chatInput").focus();
}
function scrollChat() { const m = document.getElementById("chatMessages"); m.scrollTop = m.scrollHeight; }
on("chatMessages", "scroll", function () {
  chatSticky = (this.scrollHeight - this.scrollTop - this.clientHeight) < 60;
});
on("chatInput", "keydown", e => { if (e.key === "Enter") sendChat(); });
syncChatThinkBtn();
on("ticker", "keydown", e => { if (e.key === "Enter") { e.preventDefault(); runAnalysis(); } });
renderTickerPills();
if (IS_SCREENER_PAGE) document.getElementById("screenerNav")?.setAttribute("aria-current", "page");

/* ════════════════ DEEP LINKS ════════════════
   /?t=TICKER opens an analysis, /screener?id=<screen> opens a saved screen. This is the
   point of having two URLs at all: until now there was one address and nothing in the app
   was linkable, shareable or indexable. Runs last, after the initial render, so the saved
   state these read has already been hydrated. Falls through to the hero's caret when there
   is nothing to restore — the landing page's one job. */
(function applyDeepLink() {
  const params = new URLSearchParams(location.search);
  if (IS_SCREENER_PAGE) {
    const id = params.get("id");
    if (id && screeners[id]) openSavedScreener(id);
    else document.getElementById("screenQuery")?.focus();
    return;
  }
  if (IS_BACKTESTER_PAGE) return;
  const t = (params.get("t") || "").trim().toUpperCase();
  if (!t) { focusHeroSearch(); return; }
  const field = document.getElementById("ticker");
  if (field) field.value = t;
  // Already analyzed and still held locally: reopen it rather than spending a run on it.
  if (sessions[t]) switchTicker(t); else runAnalysis();
})();

/* ════════════════ RESIZERS (rAF-driven, snap points, touch-ready) ════════════════ */
// Rows need a shared axis; below ~380px of pane there isn't room for one.
const syncMetricDensity = () => { const p = document.getElementById("dataPane");
  if (!p) return;
  const w = p.getBoundingClientRect().width;
  // Zero width means the pane isn't laid out yet — the hero is still up, or it's the
  // hidden pane on mobile. That is not "narrow": treating it as narrow stacks every
  // metric and nothing widens it back until you happen to drag or resize.
  if (!w) return;
  p.classList.toggle("stack-metrics", w < 380);
  /* The chart's control row is nowrap and #rangeSel is the elastic member, so on a narrow
     pane the range buttons are what quietly scroll out of reach — nothing overflows, the
     tiers just stop being visible. Measured on this row: all six survive down to ~670px,
     and dropping the interval chip and the Compare label buys back ~115px of that. Keyed
     to the PANE, not the viewport: the split drag narrows this pane to any width it likes
     without the viewport moving at all, which is what a media query cannot see. */
  p.classList.toggle("tight-controls", w < 760); };

// The pane's width changes from the drag, from the viewport, and from the hero giving way
// to the dashboard. One observer catches all three; the explicit calls below are belt-and-braces.
if (window.ResizeObserver) { const p = document.getElementById("dataPane");
  if (p) new ResizeObserver(syncMetricDensity).observe(p); }

(function () {
  const rz = document.getElementById("resizer"), split = document.getElementById("split"), badge = document.getElementById("rzBadge");
  if (!rz || !split) return;   // analyzer-only chrome; the screener page has no split pane
  try { const saved = localStorage.getItem("squall-split"); if (saved) split.style.setProperty("--left-w", saved); } catch (e) {}
  syncMetricDensity();
  let dragging = false, pendingX = null, raf = null;
  const SNAPS = [40, 50, 60];

  function apply() {
    raf = null;
    if (pendingX == null) return;
    const rect = split.getBoundingClientRect();
    let pct = (pendingX - rect.left) / rect.width * 100;
    for (const s of SNAPS) if (Math.abs(pct - s) < 1.2) { pct = s; break; }
    pct = Math.max(30, Math.min(70, pct));
    split.style.setProperty("--left-w", pct.toFixed(2) + "%");
    // --left-w is a share of the whole grid, which now includes the rail column, so the raw
    // percentage is not the ratio between the two PANES — which is the only thing the
    // reader is actually sizing. Report the panes.
    const railPct = ((document.getElementById("viewRail")?.getBoundingClientRect().width || 0) / rect.width) * 100;
    const left = Math.round((pct - railPct) / Math.max(1, 100 - railPct) * 100);
    badge.textContent = left + " / " + (100 - left);
    syncMetricDensity();
    if (active) drawChart();          // chart follows the drag live
  }
  rz.addEventListener("pointerdown", e => {
    dragging = true; rz.classList.add("dragging"); rz.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  });
  rz.addEventListener("pointermove", e => {
    if (!dragging) return;
    pendingX = e.clientX;
    if (!raf) raf = requestAnimationFrame(apply);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false; pendingX = null; rz.classList.remove("dragging");
    document.body.classList.remove("resizing");
    try { localStorage.setItem("squall-split", split.style.getPropertyValue("--left-w")); } catch (e) {}
    if (active) drawChart();
  };
  rz.addEventListener("pointerup", stop); rz.addEventListener("pointercancel", stop);
  rz.addEventListener("dblclick", () => {
    split.style.setProperty("--left-w", "50%");
    try { localStorage.removeItem("squall-split"); } catch (e) {}
    syncMetricDensity();
    if (active) requestAnimationFrame(drawChart);
  });
  // Keyboard: arrows nudge the split, Enter resets — mirrors drag/double-click.
  rz.addEventListener("keydown", e => {
    if (e.key === "Enter") { rz.dispatchEvent(new Event("dblclick")); e.preventDefault(); return; }
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const cur = parseFloat(split.style.getPropertyValue("--left-w")) || 50;
    const pct = Math.max(30, Math.min(70, cur + dir * 2));
    split.style.setProperty("--left-w", pct + "%");
    badge.textContent = Math.round(pct) + " / " + Math.round(100 - pct);
    try { localStorage.setItem("squall-split", pct + "%"); } catch (err) {}
    syncMetricDensity();
    if (active) requestAnimationFrame(drawChart);
  });
})();

/* The dock is collapsed to its input row until there is something in the thread or the
   reader is typing. Called from renderChat, from the input's focus, and from showView —
   anywhere the answer could change. Never collapses mid-thread: losing the transcript
   under you while a reply streams would be worse than the height it costs. */
function syncChatDock(focused) {
  const dock = document.getElementById("chatDock");
  if (!dock) return;
  const sess = sessions[active];
  /* `focused` is passed explicitly by the focus handler rather than inferred from
     document.activeElement: in a background tab activeElement reports <body> even
     immediately inside a focus event, so inferring it makes the dock refuse to open in
     exactly the case that is hardest to notice. */
  const wanted = focused === true || Boolean(sess?.history?.length);
  if (dock.classList.contains("expanded") === wanted) return;
  dock.classList.add("animate");
  dock.classList.toggle("expanded", wanted);
  setTimeout(() => dock.classList.remove("animate"), 340);
}
on("chatInput", "focus", () => syncChatDock(true));
// Leaving an empty field takes the height back; a dock with a thread in it stays open,
// because `wanted` is already true from the history.
on("chatInput", "blur", () => syncChatDock(false));

(function () {
  const grip = document.getElementById("chatGrip"), dock = document.getElementById("chatDock");
  if (!grip || !dock) return;   // analyzer-only chrome; the screener page has no chat dock
  /* A stored height is clamped against the pane it has to live in rather than trusted.
     The value in this browser was 124px — the old min-height, dragged there by hand to
     claw reading space back off a 280px default — and restoring it verbatim would just
     reproduce the cramped dock the collapse is meant to fix. */
  try {
    const saved = parseFloat(localStorage.getItem("squall-chat-h"));
    if (Number.isFinite(saved)) {
      const paneH = document.getElementById("aiPane")?.getBoundingClientRect().height || 0;
      const cap = paneH ? paneH * 0.7 : saved;
      dock.style.setProperty("--chat-h", Math.round(Math.max(150, Math.min(cap, saved))) + "px");
    }
  } catch (e) {}
  let dragging = false, pendingY = null, raf = null;

  function apply() {
    raf = null;
    if (pendingY == null) return;
    const aiPane = document.getElementById("aiPane").getBoundingClientRect();
    const h = Math.max(150, Math.min(aiPane.height * 0.7, aiPane.bottom - pendingY));
    dock.style.setProperty("--chat-h", Math.round(h) + "px");
  }
  grip.addEventListener("pointerdown", e => {
    dragging = true; grip.classList.add("dragging"); grip.setPointerCapture(e.pointerId);
    dock.classList.remove("animate");
    document.body.classList.add("resizing-y");
  });
  grip.addEventListener("pointermove", e => {
    if (!dragging) return;
    pendingY = e.clientY;
    if (!raf) raf = requestAnimationFrame(apply);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false; pendingY = null; grip.classList.remove("dragging");
    document.body.classList.remove("resizing-y");
    try { localStorage.setItem("squall-chat-h", dock.style.getPropertyValue("--chat-h")); } catch (e) {}
  };
  grip.addEventListener("pointerup", stop); grip.addEventListener("pointercancel", stop);
  grip.addEventListener("dblclick", () => {
    dock.classList.add("animate");
    // Back to the stylesheet's default (46% of the pane), not to a pixel constant — a
    // constant is what stopped scaling with the window in the first place.
    dock.style.removeProperty("--chat-h");
    try { localStorage.removeItem("squall-chat-h"); } catch (e) {}
    setTimeout(() => dock.classList.remove("animate"), 350);
  });
  // Keyboard: up/down arrows resize the chat dock, Enter resets.
  grip.addEventListener("keydown", e => {
    if (e.key === "Enter") { grip.dispatchEvent(new Event("dblclick")); e.preventDefault(); return; }
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const aiPane = document.getElementById("aiPane").getBoundingClientRect();
    const cur = parseFloat(dock.style.getPropertyValue("--chat-h")) || dock.getBoundingClientRect().height;
    const h = Math.max(150, Math.min(aiPane.height * 0.7, cur + dir * 24));
    dock.style.setProperty("--chat-h", Math.round(h) + "px");
    try { localStorage.setItem("squall-chat-h", Math.round(h) + "px"); } catch (err) {}
  });
})();

/* #mobileTabs is gone. It was a Data/AI pane switcher below 960px — the same idea as the
   rail, at one breakpoint, with its own markup, CSS and wiring. VIEWS/showView/
   syncPaneVisibility subsume it, and FOCUS_MQ (which watches height as well as width) is
   what decides when one pane at a time applies. */

/* ════════════════ MODAL OVERLAY TOGGLES (delegation — fires on cloned checkboxes) ════════════════ */
on("chartModalControls", "change", function (e) {
  const opt = e.target.dataset.opt;
  if (!opt) return;
  chartOpts[opt] = e.target.checked;
  e.target.closest(".toggle")?.classList.toggle("on", e.target.checked);
  // Mirror state back to the source checkbox in #chartControls
  const src = document.querySelector(`#chartControls input[data-opt="${opt}"]`);
  if (src) { src.checked = e.target.checked; src.closest(".toggle")?.classList.toggle("on", e.target.checked); }
  syncOverlayCount();   // the inline row's badge is the only state readout once the modal closes
  drawChart();
});

/* ════════════════ HERO WIND FIELD ════════════════
   Passive, cursor-reactive wind behind the landing hero, and the hero's only streak layer
   since the CSS .hero-streaks were removed. Short accent-colored streaks drift left→right;
   moving the cursor drags nearby streaks along its path and parts them around it, then the
   field relaxes back to ambient drift. */
(function () {
  if (REDUCED) return;                                  // honor prefers-reduced-motion — no ambient motion
  const hero = document.getElementById("hero");
  if (!hero || !window.requestAnimationFrame) return;

  const canvas = document.createElement("canvas");
  canvas.className = "wind-field";
  canvas.setAttribute("aria-hidden", "true");
  hero.insertBefore(canvas, hero.firstChild);           // first child → paints above the dot grid, below the copy
  const ctx = canvas.getContext("2d");

  const BASE_WIND = 0.9;     // ambient rightward drift (px/frame @60fps)
  const R = 70, R2 = R * R; // cursor influence radius
  const MAX_V = 10;          // per-particle speed cap → keeps gusts tasteful, never flings

  let W = 0, H = 0, particles = [];
  // Cursor: position + the movement velocity that becomes the "gust".
  const cur = { x: -9999, y: -9999, vx: 0, vy: 0, active: false };

  const readAccent = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3fd0b6";
  let strokeColor = readAccent();

  function spawn(fromLeft) {
    return {
      x: fromLeft ? -20 : Math.random() * W,
      y: Math.random() * H,
      vx: BASE_WIND * (0.6 + Math.random() * 0.9),
      vy: 0,
      sway: 0.15 + Math.random() * 0.35,                // gentle idle breathing so it's alive at rest
      phase: Math.random() * Math.PI * 2,
      len: 12 + Math.random() * 30,
      a: 0.12 + Math.random() * 0.22,                    // base alpha
      heat: 0                                            // rises near the cursor, decays → a lingering wind wake
    };
  }

  function resize() {
    const r = hero.getBoundingClientRect();
    W = r.width; H = r.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.min(220, Math.round((W * H) / 9000));
    particles = Array.from({ length: target }, () => spawn(false));
  }

  function step() {
    cur.vx *= 0.86; cur.vy *= 0.86;                      // gusts fade once the cursor stops moving

    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = strokeColor;

    for (const p of particles) {
      p.phase += 0.01;
      let ax = 0, ay = Math.sin(p.phase) * p.sway * 0.15;

      if (cur.active) {
        const dx = p.x - cur.x, dy = p.y - cur.y, d2 = dx * dx + dy * dy;
        if (d2 < R2) {
          const dist = Math.sqrt(d2) + 0.001;
          const f = 1 - dist / R;                         // 1 at cursor → 0 at edge
          const push = f * 1.5;                           // radial: part the air around the pointer
          ax += (dx / dist) * push + cur.vx * 0.18 * f;   // + drag air along the cursor's motion
          ay += (dy / dist) * push + cur.vy * 0.18 * f;
          if (f > p.heat) p.heat = f;                     // light up; lingers via the decay below
        }
      }
      p.heat *= 0.93;                                     // wake fades a beat after the cursor passes

      p.vx += ax; p.vy += ay;
      // relax back toward ambient wind so the field settles when idle
      p.vx += (BASE_WIND * (0.6 + p.sway) - p.vx) * 0.04;
      p.vy += -p.vy * 0.06;

      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAX_V) { p.vx *= MAX_V / sp; p.vy *= MAX_V / sp; }

      const nx = p.x + p.vx, ny = p.y + p.vy;
      const tail = Math.min(p.len + p.heat * 22, 6 + sp * 7 + p.heat * 22);  // faster/gusted → longer streak
      const ang = Math.atan2(p.vy, p.vx);
      ctx.globalAlpha = Math.min(0.8, p.a + sp * 0.05 + p.heat * 0.4);
      ctx.beginPath();
      ctx.moveTo(nx - Math.cos(ang) * tail, ny - Math.sin(ang) * tail);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      p.x = nx; p.y = ny;
      if (p.x > W + 30 || p.y < -40 || p.y > H + 40) Object.assign(p, spawn(true));
    }
    ctx.globalAlpha = 1;
  }

  let running = false;
  function loop() {
    if (hero.style.display === "none") { running = false; return; }   // paused while workspace is up
    step();
    requestAnimationFrame(loop);
  }
  function start() { if (!running) { running = true; strokeColor = readAccent(); requestAnimationFrame(loop); } }

  hero.addEventListener("pointermove", e => {
    const r = hero.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (cur.active) {                                     // derive gust from movement, clamped so fast flicks don't explode
      cur.vx = Math.max(-40, Math.min(40, x - cur.x));
      cur.vy = Math.max(-40, Math.min(40, y - cur.y));
    }
    cur.x = x; cur.y = y; cur.active = true;
  });
  hero.addEventListener("pointerleave", () => { cur.active = false; });

  window.addEventListener("resize", resize);
  document.addEventListener("squall:theme", () => { strokeColor = readAccent(); });
  // Resume when the hero is shown again (goHome flips display back on).
  new MutationObserver(() => { if (hero.style.display !== "none") start(); })
    .observe(hero, { attributes: true, attributeFilter: ["style"] });

  resize();
  start();
})();

/* ════════════════ TOOLTIPS — site-styled, replace native title balloons ════════════════
   One #tip element serves the whole app. Delegated listeners adopt any element
   with a title attribute (including future innerHTML renders) by migrating the
   text to data-tip on first contact, so the browser balloon never appears.
   Mouse/pen hover (short delay) and keyboard focus (:focus-visible) both show it. */
(function () {
  const tip = document.createElement("div");
  tip.id = "tip"; tip.setAttribute("role", "tooltip"); tip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tip);
  let anchor = null, showT = null;

  const adopt = el => {
    const t = el.getAttribute("title");
    if (t) { el.dataset.tip = t; el.removeAttribute("title"); }
    return el.dataset.tip;
  };
  const findTarget = e => e.target && e.target.closest ? e.target.closest("[data-tip], [title]") : null;

  function place(el) {
    const text = adopt(el);
    if (!text) return;
    anchor = el;
    tip.textContent = text;
    tip.classList.remove("show", "below");
    tip.style.left = "0px"; tip.style.top = "0px";          // reset before measuring
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, innerWidth - tw - 8));
    let y = r.top - th - 10, below = false;
    if (y < 8) { y = r.bottom + 10; below = true; }
    tip.style.left = Math.round(x) + "px"; tip.style.top = Math.round(y) + "px";
    tip.style.setProperty("--ax", Math.round(Math.max(12, Math.min(r.left + r.width / 2 - x, tw - 12))) + "px");
    tip.classList.toggle("below", below);
    tip.classList.add("show");
    tip.setAttribute("aria-hidden", "false");
  }
  function hide() {
    clearTimeout(showT); showT = null; anchor = null;
    tip.classList.remove("show"); tip.setAttribute("aria-hidden", "true");
  }

  document.addEventListener("pointerover", e => {
    if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;   // touch keeps native-free silence
    const el = findTarget(e);
    if (!el) { if (anchor) hide(); return; }
    if (el === anchor) return;
    clearTimeout(showT);
    showT = setTimeout(() => place(el), 120);
  });
  document.addEventListener("pointerout", e => {
    const el = findTarget(e);
    if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hide();
  });
  document.addEventListener("pointerdown", () => hide(), true);   // don't linger through clicks/drags
  document.addEventListener("focusin", e => {
    const el = findTarget(e);
    if (el && el.matches(":focus-visible")) place(el);            // keyboard focus only, not click focus
  });
  document.addEventListener("focusout", () => hide());
  document.addEventListener("scroll", () => hide(), true);
  window.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
})();

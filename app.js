"use strict";

/* ════════════════ STATE: per-ticker sessions (declared first — theme init reads `active`) ════════════════ */
const sessions = {};   // { TICKER: { data, context, history, range } }
let active = null;     // active ticker for the chat/AI/data panes
const chartOpts = { ma20: false, ma50: true, ma200: true, bb: false, fib: false, sr: true, pct: false, vol: true, instWindow: false };
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
      range: Number(raw.range) || 252,
      profile: raw.profile || null,
      profileKey: String(raw.profileKey || "none"),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
      fibAnchors: raw.fibAnchors || null
    };
  });
  active = Object.keys(sessions).sort((a, b) => sessions[b].updatedAt - sessions[a].updatedAt)[0] || null;
}
function persistSessions() {
  const saved = {};
  Object.entries(sessions).forEach(([ticker, s]) => {
    saved[ticker] = {
      data: s.data, context: s.context, history: cleanHistory(s.history), range: s.range,
      profile: s.profile || null, profileKey: s.profileKey || "none",
      createdAt: s.createdAt || Date.now(), updatedAt: s.updatedAt || Date.now(),
      fibAnchors: s.fibAnchors || null
    };
  });
  try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(saved)); return true; }
  catch (_) { return false; }
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
  try { localStorage.setItem(SCREENER_STORAGE_KEY, JSON.stringify(saved)); return true; } catch (_) { return false; }
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
const THEME_STORAGE_KEY = "squall-theme";
const themeBtn = document.getElementById("themeBtn");
const themeMenu = document.getElementById("themeMenu");

function themeDef(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }

/* One-shot uniform color crossfade. Only a few elements transition color by default, so
   without this most of the UI snaps while those few fade — it reads as choppy. Skipped on
   first paint (nothing to fade from) and under reduced-motion. */
function flashThemeTransition() {
  if (REDUCED) return;
  const root = document.documentElement;
  root.classList.add("theme-anim");
  clearTimeout(root._themeAnimT);
  root._themeAnimT = setTimeout(() => root.classList.remove("theme-anim"), 420);
}

function applyTheme(id, animate) {
  const def = themeDef(id);
  const root = document.documentElement;
  if (animate && root.dataset.theme !== def.id) flashThemeTransition();
  root.dataset.theme = def.id;
  root.dataset.mode = def.mode;
  themeBtn.setAttribute("aria-label", `Appearance — ${def.label} theme`);
  setTip(themeBtn, `Appearance · ${def.label}`);
  themeMenu.querySelectorAll(".theme-opt").forEach(b =>
    b.setAttribute("aria-checked", String(b.dataset.theme === def.id)));
  try { localStorage.setItem(THEME_STORAGE_KEY, def.id); } catch (e) {}
  // Anything that samples resolved colors (hero wind field, future canvases) listens here
  // rather than on the button — the button click now only opens the menu.
  document.dispatchEvent(new CustomEvent("squall:theme", { detail: def }));
  // Defer the canvas repaint to the next frame so the CSS color transition starts
  // immediately — redrawing synchronously here blocks paint and makes the switch stutter.
  if (active && sessions[active]) requestAnimationFrame(() => { if (active && sessions[active]) drawChart(); });
}

themeMenu.innerHTML =
  `<div class="theme-menu-head">Theme</div>` +
  THEMES.map(t => `<button class="theme-opt" type="button" role="menuitemradio" aria-checked="false"
      data-theme="${t.id}" style="--sw-bg:${t.bg}; --sw-accent:${t.accent}">
      <i class="theme-swatch" aria-hidden="true"></i>
      <span class="tl"><b>${t.label}</b><span>${t.note}</span></span>
      <svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
    </button>`).join("");

(function () {
  let saved; try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch (e) {}
  // An unknown id (older build, hand-edited storage) falls back to the OS preference.
  if (!saved || !THEMES.some(t => t.id === saved))
    saved = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(saved, false);
})();

/* Menu open/close + roving keyboard focus */
function themeMenuOpen() { return themeMenu.classList.contains("open"); }
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

themeBtn.addEventListener("click", () => { themeMenuOpen() ? closeThemeMenu(false) : openThemeMenu(); });
themeMenu.addEventListener("click", e => {
  const opt = e.target.closest(".theme-opt");
  if (!opt) return;
  applyTheme(opt.dataset.theme, true);
  themeBtn.classList.remove("picked"); void themeBtn.offsetWidth; themeBtn.classList.add("picked");
  closeThemeMenu(true);
});
themeMenu.addEventListener("keydown", e => {
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
const isNum = v => v !== null && v !== undefined && typeof v === "number" && isFinite(v);
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
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

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

/* On phones the search field is too small for the full placeholder — and the font steps
   up to 16px there to stop iOS zooming on focus, which makes the text wider still. A
   truncated placeholder ("Ticker or compan…") reads as a bug, so shorten it instead.
   The full intent stays in the field's aria-label, and the typeahead matches names too. */
(function () {
  const input = document.getElementById("ticker");
  if (!input) return;
  const narrow = matchMedia("(max-width: 520px)");
  const sync = () => { input.placeholder = narrow.matches ? "Ticker" : "Ticker or company"; };
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
   at 8 rows and painted with one innerHTML write — no per-item DOM churn. */
(function () {
  const input = document.getElementById("ticker"), box = document.getElementById("tickerSuggest");
  const names = { ...(window.MARKET_UNIVERSES?.names || {}), ...(window.SP500_NAMES || {}) };
  if (!input || !box || !names) return;

  const REC = Object.keys(names).map(sym =>
    ({ sym, name: names[sym], s: sym.toLowerCase(), n: names[sym].toLowerCase() }));
  const MAX = 8;
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
      `<div class="sug" id="sug-${i}" role="option" data-i="${i}">
        <span class="sym">${hi(r.sym, r.s, q)}</span><span class="nm">${hi(r.name, r.n, q)}</span>
      </div>`).join("");
    box.classList.add("open");
    input.setAttribute("aria-expanded", "true");
  }

  function setActive(i) {
    activeI = i;
    box.querySelectorAll(".sug").forEach((el, j) => el.classList.toggle("active", j === i));
    if (i >= 0) {
      input.setAttribute("aria-activedescendant", "sug-" + i);
      box.children[i].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function pick(i) {
    if (i < 0 || i >= items.length) return;
    input.value = items[i].sym;
    close();
    runAnalysis();
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
})();

function finalizePartialStream() {
  // A new run (or navigation) interrupts an in-flight stream — keep what arrived.
  if (_stream && !_stream.done) {
    const s = sessions[_stream.ticker];
    if (s) { s.data.aiSummary = _stream.answer; s.data.aiReasoning = _stream.thinking; s.data.model = _stream.model; touchSession(s); persistSessions(); }
    document.getElementById("mobileTabs").querySelector('[data-pane="aiPane"]')?.classList.remove("streaming");
    document.getElementById("aiModelTag")?.classList.remove("live");
  }
  _stream = null;
}

/* ── Skeleton loaders — mirror the real card/metric/prose shapes while data loads ── */
function skMetric() {
  return `<div class="sk-metric"><div class="skeleton sk-line sk-k"></div><div class="skeleton sk-line sk-v"></div></div>`;
}
function skCard(n, { chart = false, delay = 0 } = {}) {
  const body = chart
    ? `<div class="skeleton sk-chart"></div>`
    : `<div class="mgrid">${Array.from({ length: n }, skMetric).join("")}</div>`;
  return `<div class="card sk-card" style="--d:${delay}s">
    <div class="sk-summary"><div class="skeleton sk-icon"></div><div class="skeleton sk-line sk-title"></div></div>
    <div class="card-body">${body}</div></div>`;
}
function dataSkeleton() {
  return skCard(8, { delay: 0 }) + skCard(0, { chart: true, delay: .05 }) + skCard(6, { delay: .1 }) + skCard(6, { delay: .15 });
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
  const btn = document.getElementById("analyzeBtn");
  const profileSnapshot = getMySquallProfile();
  const profileKey = mySquallKey(profileSnapshot);
  activeScreen = null;
  document.getElementById("screenerView")?.classList.remove("show");
  if (!query) { showProgress(0, 7, "Enter a ticker or company name first", true); hideProgress(2200); return; }
  if (_es) { _es.close(); _es = null; }
  finalizePartialStream();

  // Re-run of something we already hold (matched by ticker)? Reopen instantly, no tokens spent.
  const direct = query.toUpperCase();
  if (sessions[direct] && sessions[direct].data.aiSummary && sessions[direct].profileKey === profileKey) {
    active = direct; showWorkspace(); renderTickerPills(); renderAll(sessions[direct].data); return;
  }
  const wait = /^[A-Z.\-]{1,10}$/.test(direct) ? analysisRunWait(direct) : 0;
  if (wait) {
    showProgress(0, 7, `You've already run ${RUN_LIMIT} ${direct} analyses recently. Reopen its saved tab or try again in about ${wait} min.`, true);
    hideProgress(4200); return;
  }

  let key = direct;   // session key; updated to the resolved ticker on `result`
  btn.disabled = true;
  showWorkspace();
  showProgress(0, 7, "Starting analysis for " + query);

  document.getElementById("dataBody").innerHTML = dataSkeleton();
  const ai = document.getElementById("aiSummary");
  ai.className = "prose"; ai.innerHTML = aiSkeleton();

  let streamUrl = "/analyze-stream?ticker=" + encodeURIComponent(query);
  if (profileSnapshot) streamUrl += "&profile=" + encodeURIComponent(JSON.stringify(profileSnapshot));
  const es = new EventSource(streamUrl);
  _es = es;
  let gotResult = false;

  es.addEventListener("progress", e => { const d = JSON.parse(e.data); showProgress(d.stage, d.total || 7, d.label); });

  es.addEventListener("error", e => {
    if (!e.data && gotResult) {   // natural close (or drop) after data arrived — finalize quietly
      finalizePartialStream();
      if (_es === es) {
        showProgressPercent(100, "Dashboard ready");
        hideProgress(900);
      }
      es.close(); if (_es === es) _es = null; btn.disabled = false; return;
    }
    let msg = "Connection lost. Is the server running? (node server.js)";
    try { if (e.data) msg = JSON.parse(e.data).error || msg; } catch (x) {}
    showProgress(0, 7, "Error: " + msg, true);
    document.getElementById("dataBody").innerHTML = `<div class="placeholder"><span style="color:var(--red);font-family:var(--mono);font-size:12px">${esc(msg)}</span>
      <button class="retry-btn" onclick="retryAnalysis('${jsAttr(query)}')">${RETRY_SVG}<span>Retry</span></button></div>`;
    ai.className = "prose"; ai.innerHTML = `<div class="placeholder"><span>Analysis unavailable — fix the error above and run again.</span></div>`;
    btn.disabled = false; es.close(); if (_es === es) _es = null; hideProgress(3000);
  });

  // Scraper finished — dashboard renders now; AI streams on top of it.
  es.addEventListener("result", e => {
    const data = JSON.parse(e.data);
    gotResult = true;
    key = data.ticker;   // resolved symbol — re-key so the AI-stream handlers below find the session
    const now = Date.now();
    sessions[data.ticker] = { data, context: data.ai_prompt || "", history: [], range: 252,
      profile: profileSnapshot, profileKey, createdAt: now, updatedAt: now, fibAnchors: null };
    recordAnalysisRun(data.ticker);
    persistSessions();
    active = data.ticker;
    renderTickerPills();
    renderAll(data);
    if (active === data.ticker) showAiThinking(data.model);   // fill the pane instantly; ai_start replaces it
    btn.disabled = false;
    showProgressPercent(72, "Dashboard ready · preparing the written analysis");
  });

  es.addEventListener("ai_start", e => {
    const d = JSON.parse(e.data);
    _stream = { ticker: key, model: d.model, thinking: "", answer: "", answerStarted: false, done: false, sticky: true, raf: null };
    setModelTag(d.model);
    document.getElementById("aiModelTag")?.classList.add("live");
    document.getElementById("mobileTabs").querySelector('[data-pane="aiPane"]')?.classList.add("streaming");
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
    document.getElementById("mobileTabs").querySelector('[data-pane="aiPane"]')?.classList.remove("streaming");
    if (active === key && sess) finalizeAiRender(sess.data);
    _stream = null;
    showProgressPercent(100, "Analysis complete");
    hideProgress(900);
    es.close(); if (_es === es) _es = null;
  });

  es.addEventListener("ai_error", e => {
    const d = JSON.parse(e.data);
    const sess = sessions[key];
    if (sess) { sess.data.aiError = d.error; sess.data.aiSummary = _stream?.answer || ""; sess.data.aiReasoning = _stream?.thinking || ""; touchSession(sess); persistSessions(); }
    if (_stream) _stream.done = true;
    document.getElementById("aiModelTag")?.classList.remove("live");
    document.getElementById("mobileTabs").querySelector('[data-pane="aiPane"]')?.classList.remove("streaming");
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
  if (sessions[t]) { sessions[t].data.aiSummary = ""; touchSession(sessions[t]); persistSessions(); }
  document.getElementById("ticker").value = t;
  runAnalysis();
}
// Shared AI-error banner (with a retry affordance) used by both the live stream and final render.
function aiWarnHtml(d) {
  if (!d || !d.aiError) return "";
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
document.getElementById("aiScroll").addEventListener("scroll", function () {
  if (!_stream || _stream.done) return;
  _stream.sticky = (this.scrollHeight - this.scrollTop - this.clientHeight) < 60;
});
function finalizeAiRender(d) {
  const ai = document.getElementById("aiSummary");
  const scroll = document.getElementById("aiScroll");
  const keep = scroll.scrollTop;
  ai.className = "prose";
  ai.innerHTML = aiWarnHtml(d) + thinkingBlock(d.aiReasoning) + renderMarkdown(d.aiSummary || "") + aiDisclaimerHtml(d);
  scroll.scrollTop = keep;
}

/* ════════════════ HOME / WORKSPACE NAVIGATION ════════════════ */
function goHome() {
  const ws = document.getElementById("workspace"), hero = document.getElementById("hero"), strip = document.getElementById("summaryStrip");
  const screen = document.getElementById("screenerView");
  if (!ws.classList.contains("show") && !screen?.classList.contains("show")) return;
  ws.classList.add("leaving");
  setTimeout(() => {
    ws.classList.remove("show", "leaving");
    screen?.classList.remove("show"); activeScreen = null;
    strip.classList.remove("show");
    hero.style.display = "";
    hero.style.animation = "none"; void hero.offsetWidth; hero.style.animation = "";   // replay entrance
    document.getElementById("resumeChip").classList.toggle("show", Object.keys(sessions).length + Object.keys(screeners).length > 0);
    document.getElementById("ticker").focus();
  }, 290);
}
function showWorkspace(skipAnim) {
  const ws = document.getElementById("workspace"), hero = document.getElementById("hero");
  document.getElementById("screenerView")?.classList.remove("show"); activeScreen = null;
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
  document.getElementById("hero").style.display = "none";
  document.getElementById("workspace").classList.remove("show", "leaving");
  document.getElementById("summaryStrip").classList.remove("show");
  document.getElementById("screenerView").classList.add("show");
  renderTickerPills();
  setTimeout(() => document.getElementById("screenQuery")?.focus(), 0);
}
function openSavedScreener(id) {
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
  if (!rows.length) return `<div class="screen-empty"><b>No companies met every condition.</b><span>Broaden the match threshold or remove a required criterion, then run the screen again.</span></div>`;
  const cards = rows.map((r, i) => `<article class="screen-result" style="--i:${i}"><div class="screen-result-top"><button class="screen-symbol" type="button" onclick="analyzeFromScreener('${jsAttr(r.ticker)}')">${esc(r.ticker)}</button><div class="screen-name"><b>${esc(r.name || r.ticker)}</b><span>${esc([(r.indexes || []).join(" / "), r.sector, r.industry].filter(Boolean).join(" · "))}</span></div><div class="match-score" data-score="${Math.round(r.match_score)}" title="Match score: fit with this screen, not an investment rating">${Math.round(r.match_score)}</div></div><div class="screen-metrics"><div class="screen-metric"><small>Price</small><b>${fUsd(r.price)}</b></div><div class="screen-metric"><small>20-day return</small><b class="${signCls(r.return_20d)}">${screenPct(r.return_20d)}</b></div><div class="screen-metric"><small>Below 52-week high</small><b>${screenPct(r.distance_52w_high)}</b></div></div>${scoreBreakdown(r, spec)}<div class="screen-reasons">${(r.reasons || []).map(x => `<p class="screen-reason">${esc(x)}</p>`).join("")}</div></article>`).join("");
  return `<div class="screen-results-head"><h2>${rows.length} matches</h2><span>${esc(result.universe_scored)} of ${esc(result.universe_requested)} companies scored in ${esc(result.universe || spec.universe_label || "the selected universe")}${result.cache_hit ? " · current cache used" : ""}</span></div><div class="screen-grid">${cards}</div>`;
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
let _cardN = 0;
function card(id, icon, title, bodyHtml, { open = true, count = null } = {}) {
  _cardN++;
  return `<details class="card" id="card-${id}" ${open ? "open" : ""} style="--d:${Math.min(_cardN * 0.03, 0.3)}s">
    <summary>${icon}<span>${title}</span>${count !== null ? `<span class="count">${count}</span>` : ""}
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </summary><div class="card-body">${bodyHtml}</div></details>`;
}
const I = {
  bolt:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 11-12h-7l1-8z"/></svg>',
  chart:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>',
  scale:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 7l7-4 7 4M3 13l2-6 2 6a3 3 0 0 1-4 0zM17 13l2-6 2 6a3 3 0 0 1-4 0z"/></svg>',
  margin:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 9 9h-9z"/></svg>',
  shield:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/></svg>',
  bank:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M4 18h16M6 18V10M10 18V10M14 18V10M18 18V10M2 10l10-7 10 7z"/></svg>',
  gauge:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 14 8 8"/><path d="M3.3 17a10 10 0 1 1 17.4 0"/></svg>',
  pulse:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  eye:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  cal:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  doc:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>',
  layers:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5"/></svg>',
  struct:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l4-6 4 3 4-8 6 9"/></svg>',
  whale:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c2 0 3-2 3-2s2 4 6 4 7-3 9-3M3 12c0 4 4 7 9 7 6 0 9-5 9-9 0-1-.3-2-1-3"/></svg>',
  brain:'<svg class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18z"/></svg>'
};
const metric = (label, value, cls = "") => `<div class="metric"><div class="k">${label}</div><div class="v ${cls}">${value}</div></div>`;
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
    tab.querySelector(".analysis-tab-main").onclick = () => tab.dataset.kind === "screen" ? openSavedScreener(tab.dataset.key) : switchTicker(tab.dataset.key);
    tab.querySelector(".analysis-tab-close").onclick = () => tab.dataset.kind === "screen" ? deleteScreener(tab.dataset.key) : deleteSession(tab.dataset.key);
  });
  document.getElementById("resumeChip")?.classList.toggle("show", items.length > 0);
}
function switchTicker(t) {
  if (!sessions[t]) return;
  active = t; activeScreen = null;
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
  if (active === t) active = keys[idx + 1] && sessions[keys[idx + 1]] ? keys[idx + 1] : keys[idx - 1] && sessions[keys[idx - 1]] ? keys[idx - 1] : Object.keys(sessions)[0] || null;
  persistSessions(); renderTickerPills();
  if (active && sessions[active]) { renderAll(sessions[active].data); syncChatSendMode(); }
  else {
    document.getElementById("summaryStrip").classList.remove("show");
    const ws = document.getElementById("workspace"), hero = document.getElementById("hero");
    ws.classList.remove("show", "leaving"); hero.style.display = "";
  }
}

/* ════════════════ RENDER: SUMMARY STRIP ════════════════ */
function renderStrip(d) {
  const q = d.live_quote || {}, t = (d.raw_data || {}).technicals || {};
  const company = d.company_profile || {}, regime = d.market_regime || {};
  const price = q.last_price ?? t.current_price, chg = t.daily_change;
  const strip = document.getElementById("summaryStrip");
  strip.innerHTML = `
    <span id="sCompany">${esc(d.company_name)}</span>
    <span id="sTicker">${esc(d.ticker)}${q.exchange ? " · " + esc(q.exchange) : ""}</span>
    <span id="sPrice">${fUsd(price)}</span>
    ${isNum(chg) ? `<span class="pill ${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "▲" : "▼"} ${fPct(chg)}</span>` : ""}
    ${company.sector ? `<span class="sector-badge" title="${esc(company.industry || company.sector)}">${esc(company.sector)}</span>` : ""}
    ${regime.label && regime.label !== "INSUFFICIENT DATA" ? `<span class="regime-badge" title="Market regime · ${esc(regime.summary || "")}">${esc(regime.label)}${isNum(regime.confidence) ? ` · ${Math.round(regime.confidence)}%` : ""}</span>` : ""}
    ${(d.price_action && d.price_action.trend) ? `<span class="meta-dot">Structure <b>${esc(d.price_action.trend)}</b></span>` : ""}
    ${q.market_state ? `<span class="meta-dot">Market <b>${esc(q.market_state)}</b></span>` : ""}
    ${q.fetched_at ? `<span class="meta-dot">Fetched <b>${esc(q.fetched_at)}</b></span>` : ""}`;
  strip.classList.add("show");

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

/* ════════════════ RENDER: EVERYTHING ════════════════ */
function renderAll(d) {
  renderStrip(d);
  _cardN = 0;
  const r = d.raw_data || {};
  const v = r.valuation || {}, p = r.profitability || {}, fh = r.financial_health || {}, sec = r.sec_fundamentals || {},
        t = r.technicals || {}, rr = r.risk_return || {}, s = r.sentiment || {}, kl = r.key_levels || {};
  const q = d.live_quote || {}, pa = d.price_action || {}, inst = d.institutional || {}, company = d.company_profile || {}, regime = d.market_regime || {};
  let html = "";

  /* Snapshot */
  let snap = `<div class="mgrid">
    ${metric("Last Price", fUsd(q.last_price ?? t.current_price))}
    ${metric("Day Change", fPct(t.daily_change), signCls(t.daily_change))}
    ${metric("Open", fUsd(q.open))}
    ${metric("Prev Close", fUsd(q.previous_close))}
    ${metric("Bid / Ask", (isNum(q.bid) || isNum(q.ask)) ? `${fUsd(q.bid)} <small>/</small> ${fUsd(q.ask)}` : "N/A")}
    ${metric("Volume", fInt(q.last_volume))}
    ${metric("Market Cap", fUsd(q.market_cap))}
    ${metric("Currency", esc(q.currency || "N/A"))}
    ${metric("Sector", esc(company.sector || "N/A"))}
    ${metric("Industry", esc(company.industry || "N/A"))}
    ${metric("Quote Source", esc(q.source || d.data_sources?.quote || "N/A"))}
    ${metric("Chart Source", esc(d.data_sources?.history || "N/A"))}
  </div>`;
  snap += rangeBar("Day range", q.day_low, q.day_high, q.last_price ?? t.current_price);
  snap += rangeBar("52-week range", t.low_52w ?? q.year_low, t.high_52w ?? q.year_high, q.last_price ?? t.current_price);
  html += card("snapshot", I.bolt, "Live Snapshot", snap);

  /* Sourced company news — the model explains these records but does not search for them. */
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
    html += card("news", I.doc, "Recent Company News", newsBody, { count: news.length });
  }

  /* Candlestick chart + controls */
  if (Array.isArray(d.price_history || d.price_history_1y) && (d.price_history || d.price_history_1y).length > 10) {
    html += card("chart", I.chart, "Candlestick — Price Action", chartCardBody());
  }

  /* Deterministic market regime — explains the current price/volume environment. */
  if (regime.label && regime.label !== "INSUFFICIENT DATA") {
    const confidence = isNum(regime.confidence) ? Math.max(0, Math.min(100, regime.confidence)) : 0;
    let body = `<div class="regime-summary ${signalClass(regime.label)}">
      <div><span>Current regime</span><strong>${esc(regime.label)}</strong></div>
      <div class="regime-confidence"><span>${Math.round(confidence)}% confidence</span><i><b style="width:${confidence}%"></b></i></div>
      <p>${esc(regime.summary || "Price and volume currently give a mixed signal.")}</p>
    </div>`;
    if (Array.isArray(regime.evidence) && regime.evidence.length) body += `<div class="regime-evidence">${regime.evidence.map(x => `<span>${esc(x)}</span>`).join("")}</div>`;
    body += `<p class="learn-note"><b>How to use this:</b> regime describes the current environment; it does not predict the next move. Trend regimes favor continuation setups, while range or transition regimes reward patience and tighter risk controls.</p>`;
    html += card("regime", I.gauge, "Market Regime", body, { count: regime.label });
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
      Object.entries(pa.fib).forEach(([k, val]) => body += `<span class="lvl" style="color:var(--violet);background:rgba(157,140,240,.12)">${k} · ${fUsd(val)}</span>`);
      body += `</div>`;
    }
    html += card("priceaction", I.struct, "Price Action & Market Structure", body, { count: pa.trend });
  }

  /* Institutional footprint */
  if (inst.signals || inst.net_bias) {
    const bias = inst.net_bias || "NEUTRAL";
    const biasCls = bias === "ACCUMULATION" ? "green" : bias === "DISTRIBUTION" ? "red" : "";
    let body = `<label class="toggle ${chartOpts.instWindow ? "on" : ""}" style="--swatch:var(--violet);margin-bottom:10px">
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
    html += card("institutional", I.whale, "Institutional Footprint", body);
  }

  /* Algorithmic signals */
  const flags = d.algorithmic_signals || [];
  html += card("signals", I.pulse, "Algorithmic Signals", flags.length ? flags.map(signalHtml).join("") : signalHtml("NEUTRAL: No strong signals triggered."), { count: flags.length });

  /* Chart patterns */
  const pats = d.chart_patterns || [];
  if (pats.length) html += card("patterns", I.layers, "Chart Patterns", pats.map(signalHtml).join(""), { count: pats.length });

  /* Valuation */
  html += card("valuation", I.scale, "Valuation", `<div class="mgrid">
    ${metric("P/E Trailing", fRatio(v.pe_trailing))}${metric("P/E Forward", fRatio(v.pe_forward))}
    ${metric("PEG", fRatio(v.peg_ratio), isNum(v.peg_ratio) ? (v.peg_ratio > 0 && v.peg_ratio < 1 ? "green" : v.peg_ratio > 3 ? "red" : "") : "")}
    ${metric("Price / Book", fRatio(v.price_to_book))}${metric("Price / Sales", fRatio(v.price_to_sales))}
    ${metric("EV / EBITDA", fRatio(v.ev_ebitda))}${metric("FCF Yield", fPct(v.fcf_yield), signCls(v.fcf_yield))}</div>`);

  /* Profitability */
  html += card("profit", I.margin, "Profitability & Margins", `<div class="mgrid">
    ${metric("Gross Margin", fPct(p.gross_margin))}${metric("Operating Margin", fPct(p.operating_margin), signCls(p.operating_margin))}
    ${metric("Net Margin", fPct(p.net_margin), signCls(p.net_margin))}${metric("FCF Margin", fPct(p.fcf_margin), signCls(p.fcf_margin))}
    ${metric("ROE", fPct(p.roe), signCls(p.roe))}${metric("ROA", fPct(p.roa), signCls(p.roa))}</div>`);

  /* Health */
  html += card("health", I.shield, "Financial Health", `<div class="mgrid">
    ${metric("Current Ratio", fRatio(fh.current_ratio), isNum(fh.current_ratio) ? (fh.current_ratio >= 1.5 ? "green" : fh.current_ratio < 1 ? "red" : "amber") : "")}
    ${metric("Debt / Equity", fRatio(fh.debt_to_equity), isNum(fh.debt_to_equity) && fh.debt_to_equity > 200 ? "red" : "")}
    ${metric("Earnings Quality <small>(OCF/NI)</small>", fRatio(fh.earnings_quality), isNum(fh.earnings_quality) ? (fh.earnings_quality >= 1 ? "green" : fh.earnings_quality < 0.5 ? "red" : "amber") : "")}</div>`);

  /* SEC fundamentals */
  let secBody = `<div class="mgrid">
    ${metric("Revenue", fUsd(sec.revenue))}${metric("Net Income", fUsd(sec.net_income), signCls(sec.net_income))}
    ${metric("Total Assets", fUsd(sec.assets))}${metric("Liabilities", fUsd(sec.liabilities))}
    ${metric("Equity", fUsd(sec.equity))}${metric("Operating CF", fUsd(sec.ocf), signCls(sec.ocf))}
    ${metric("Rev CAGR (3Y)", fPct(sec.rev_cagr_3y), signCls(sec.rev_cagr_3y))}</div>`;
  if (d.sec_filing && d.sec_filing.source_url)
    secBody += `<p style="margin-top:10px;font-size:12px;color:var(--text-dim)">Source filing: <a href="${esc(d.sec_filing.source_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(d.sec_filing.form)} · filed ${esc(d.sec_filing.filing_date)}</a></p>`;
  if (d.sec_available === false)
    secBody = `<div class="signal amber"><b>NOTE:</b>&nbsp;SEC EDGAR data unavailable for this ticker — figures rely on the market-data provider only.</div>` + secBody;
  html += card("sec", I.bank, "SEC-Verified Fundamentals (Latest 10-K)", secBody);

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
  html += card("tech", I.gauge, "Technicals & Key Levels", tech);

  /* Risk */
  html += card("risk", I.pulse, "Risk & Return (5Y)", `<div class="mgrid">
    ${metric("CAGR", fPct(rr.cagr), signCls(rr.cagr))}${metric("Annual Volatility", fPct(rr.annual_volatility))}
    ${metric("Sharpe Ratio", fRatio(rr.sharpe), signCls(rr.sharpe))}${metric("Max Drawdown", fPct(rr.max_drawdown), signCls(rr.max_drawdown, true))}
    ${metric("Beta (vs SPY)", fRatio(rr.beta), isNum(rr.beta) && rr.beta > 1.6 ? "amber" : "")}</div>`);

  /* Sentiment */
  let sent = `<div class="mgrid">
    ${metric("Consensus", esc(String(s.rec_key || "N/A").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())))}
    ${metric("Target Mean", fUsd(s.target_mean))}${metric("Target High", fUsd(s.target_high))}${metric("Target Low", fUsd(s.target_low))}
    ${metric("Institutional Own.", fPct(s.inst_ownership))}
    ${metric("Short Interest", fPct(s.short_percent), isNum(s.short_percent) && s.short_percent > 0.10 ? "red" : "")}</div>`;
  sent += rangeBar("Analyst targets vs price (amber = mean target)", s.target_low, s.target_high, t.current_price, fUsd, s.target_mean, "Mean target");
  html += card("sentiment", I.eye, "Sentiment & Ownership", sent);

  /* Earnings */
  const earn = r.earnings_surprises || [];
  if (earn.length) {
    const rows = earn.map(e => { const pos = e.surprise_pct >= 0;
      return `<tr><td class="hi">${esc(e.date)}</td><td>$${e.estimate.toFixed(2)}</td><td class="hi">$${e.reported.toFixed(2)}</td>
        <td class="${pos ? "pos" : "neg"}">${pos ? "+" : ""}${(e.surprise_pct * 100).toFixed(1)}%</td><td class="${pos ? "pos" : "neg"}">${pos ? "Beat" : "Miss"}</td></tr>`; }).join("");
    html += card("earnings", I.cal, "Recent Earnings Surprises",
      `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Estimate</th><th>Reported</th><th>Surprise</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`, { count: earn.length });
  }

  /* Filing activity */
  const fa = d.filing_activity;
  if (fa && d.sec_available !== false) {
    const ev = fa["8k_events"] || [];
    let body = `<div class="mgrid">
      ${metric("Insider Buys <small>(90D)</small>", String(fa.insider_buys ?? 0), fa.insider_buys > 0 ? "green" : "")}
      ${metric("Insider Sells <small>(90D)</small>", String(fa.insider_sells ?? 0), fa.insider_sells >= 5 ? "red" : "")}
      ${metric("Activist 13D", fa.activist_13d ? "Yes" : "No", fa.activist_13d ? "amber" : "")}</div>`;
    body += `<div class="lvl-label">8-K events (last 90 days)</div><div class="levels">` +
      (ev.length ? ev.map(e => `<span class="lvl" style="color:var(--text);background:var(--surface-2)">${esc(e)}</span>`).join("") : `<span style="font-size:12px;color:var(--text-dim)">None filed.</span>`) + `</div>`;
    html += card("filings", I.doc, "SEC Filing Activity (90 Days)", body);
  }

  /* Options */
  const od = d.options_data || {};
  if (od.chains && od.chains.length) {
    let body = `<p style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Available expirations: <span style="font-family:var(--mono)">${(od.available_expirations || []).map(esc).join(" · ")}</span></p>`;
    od.chains.forEach(ch => {
      body += `<div class="opt-exp"><b>${esc(ch.expiration)}</b><span>${ch.days_to_exp} days out</span><span>ATM ${fUsd(ch.atm_strike)}</span>${isNum(od.iv_summary?.[ch.expiration]) ? `<span>IV ${fPct(od.iv_summary[ch.expiration], 1)}</span>` : ""}</div><div class="opt-pair">`;
      [["calls", ch.calls], ["puts", ch.puts]].forEach(([side, arr]) => {
        const rows = (arr || []).map(o => `<tr class="${o.in_the_money ? "itm" : ""}"><td class="hi">${fUsd(o.strike)}${o.in_the_money ? '<span class="itm-badge">ITM</span>' : ""}</td>
          <td>${fUsd(o.bid)}</td><td>${fUsd(o.ask)}</td><td>${fUsd(o.last)}</td><td>${fPct(o.iv, 1)}</td><td>${fInt(o.open_interest)}</td><td>${fInt(o.volume)}</td></tr>`).join("");
        body += `<div><div class="opt-side-label ${side}">${side}</div><div class="tbl-wrap"><table><thead><tr><th>Strike</th><th>Bid</th><th>Ask</th><th>Last</th><th>IV</th><th>OI</th><th>Vol</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No data</td></tr>'}</tbody></table></div></div>`;
      });
      body += `</div>`;
    });
    html += card("options", I.layers, "Live Options Chains", body, { open: false, count: od.chains.length + " exp" });
  }

  /* MD&A */
  if (d.mda_excerpt && !/unavailable|Failed|not found/i.test(d.mda_excerpt))
    html += card("mda", I.doc, "MD&A Excerpt (Latest 10-K)", `<div class="prose" style="font-size:13px"><blockquote>${esc(d.mda_excerpt)}</blockquote></div>`, { open: false });

  /* Raw prompt */
  if (d.ai_prompt)
    html += card("prompt", I.brain, "Exact Data Sent to the AI",
      `<p style="font-size:12px;color:var(--text-dim);margin-bottom:8px">The verbatim prompt the model received — every figure above is here, so what you see is what the AI reads.</p>
       <button class="copy-btn" onclick="copyPrompt(this)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy prompt</button>
       <pre class="raw">${esc(d.ai_prompt)}</pre>`, { open: false });

  document.getElementById("dataBody").innerHTML = html;
  document.getElementById("dataBody").scrollTop = 0;
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
    ai.innerHTML = aiWarnHtml(d) + thinkingBlock(d.aiReasoning) + renderMarkdown(d.aiSummary || "") + aiDisclaimerHtml(d);
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
  return `<div id="chartControls">
    ${tog("ma20", "MA 20", "var(--accent)", true)}
    ${tog("ma50", "MA 50", "var(--amber)", true)}
    ${tog("ma200", "MA 200", "var(--text-dim)", true)}
    ${tog("bb", "Bollinger", "var(--violet)", true, true)}
    ${tog("fib", "Auto Fib", "var(--violet)", true, true)}
    ${tog("sr", "Support / Resistance", "var(--red)", true, true)}
    ${tog("pct", "% scale", "var(--accent)", false)}
    ${tog("vol", "Volume", "var(--text-dim)", false)}
    <button class="chart-tool-btn" type="button" data-chart-action="draw-fib">Draw Fib</button>
    <button class="chart-tool-btn quiet" type="button" data-chart-action="clear-fib">Clear Fib</button>
    <span class="fib-status" data-fib-status></span>
    <div id="rangeSel"></div></div>
    <div id="chartBox">
      <canvas id="priceChart" role="img" aria-label="Candlestick price chart with volume"></canvas><div id="chartTip"></div>
      <button class="chart-expand-btn" title="Expand chart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      </button>
    </div>
    <details class="chart-guide"><summary>How to use Fibonacci</summary><p>Choose <b>Draw Fib</b>, then click the start and end of a price swing. Drag either endpoint to refine it. The 38.2%, 50%, and 61.8% lines are possible reaction <em>zones</em>—not predictions or automatic buy signals.</p></details>`;
}
const RANGES = [["1W", 5], ["1M", 21], ["3M", 63], ["6M", 126], ["1Y", 252], ["2Y", 504], ["5Y", 1260]];
const fibInteraction = { ticker: null, mode: false, pending: null, dragging: null };

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
  document.querySelectorAll('input[data-opt="fib"]').forEach(cb => { cb.checked = chartOpts.fib; cb.closest(".toggle")?.classList.toggle("on", chartOpts.fib); });
  syncFibControls(); drawChart();
}
function clearManualFib() {
  const sess = sessions[active]; if (!sess) return;
  sess.fibAnchors = null; fibInteraction.mode = false; fibInteraction.pending = null; fibInteraction.dragging = null;
  touchSession(sess); persistSessions(); syncFibControls(); drawChart();
}
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-chart-action]"); if (!btn) return;
  if (btn.dataset.chartAction === "draw-fib") toggleFibDraw();
  if (btn.dataset.chartAction === "clear-fib") clearManualFib();
});

function buildRangeSel(container) {
  if (!container) return;
  const cur = sessions[active]?.range || 252;
  container.innerHTML = RANGES.map(([l, n]) =>
    `<button data-range="${n}" class="${cur === n ? "active" : ""}">${l}</button>`).join("");
  container.querySelectorAll("button").forEach(b => {
    b.onclick = () => {
      const n = Number(b.dataset.range);
      if (sessions[active]) { sessions[active].range = n; touchSession(sessions[active]); persistSessions(); }
      // keep both selectors in sync
      ["#rangeSel", "#chartModalRangeSel"].forEach(sel =>
        document.querySelectorAll(sel + " button").forEach(x => x.classList.toggle("active", Number(x.dataset.range) === n)));
      drawChart();
    };
  });
}

function wireChartControls() {
  document.querySelectorAll('#chartControls input[data-opt]').forEach(cb => {
    cb.onchange = () => { chartOpts[cb.dataset.opt] = cb.checked; cb.closest(".toggle").classList.toggle("on", cb.checked); drawChart(); };
  });
  buildRangeSel(document.getElementById("rangeSel"));
  buildRangeSel(document.getElementById("chartModalRangeSel"));
  syncFibControls();
  const expandBtn = document.querySelector('.chart-expand-btn');
  if (expandBtn) expandBtn.onclick = () => window.expandChart(active);
}
function movingAvg(arr, n) { const out = new Array(arr.length).fill(null); let sum = 0;
  for (let i = 0; i < arr.length; i++) { sum += arr[i]; if (i >= n) sum -= arr[i - n]; if (i >= n - 1) out[i] = sum / n; } return out; }
function bollinger(arr, n = 20, k = 2) {
  const mid = movingAvg(arr, n), up = new Array(arr.length).fill(null), lo = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) { const win = arr.slice(i - n + 1, i + 1); const m = mid[i];
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - m) ** 2, 0) / n); up[i] = m + k * sd; lo[i] = m - k * sd; }
  return { mid, up, lo };
}

function drawChart() {
  const sess = sessions[active]; if (!sess) return;
  const d = sess.data;
  const canvas = window._chartCanvasEl ? window._chartCanvasEl() : document.getElementById("priceChart");
  const tipEl  = window._chartTipEl   ? window._chartTipEl()   : document.getElementById("chartTip");
  const all = d.price_history || d.price_history_1y;
  if (!canvas || !Array.isArray(all) || all.length < 5) return;

  const full = all.filter(p => isNum(p.close) && isNum(p.open) && isNum(p.high) && isNum(p.low));
  const closesFull = full.map(p => p.close);
  const ma20f = movingAvg(closesFull, 20), ma50f = movingAvg(closesFull, 50), ma200f = movingAvg(closesFull, 200);
  const bbF = bollinger(closesFull, 20, 2);

  const N = Math.min(sess.range || 252, full.length);
  const s0 = full.length - N;
  const data = full.slice(s0);
  const ma20 = ma20f.slice(s0), ma50 = ma50f.slice(s0), ma200 = ma200f.slice(s0);
  const bb = { up: bbF.up.slice(s0), lo: bbF.lo.slice(s0), mid: bbF.mid.slice(s0) };

  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

  // Wind-front reveal — sweep the plot in on ticker / range / expand changes.
  // Key excludes canvas size so split-drags and window resizes don't retrigger it.
  const revealKey = active + "|" + N + "|" + (window.chartExpanded ? "x" : "i");
  if (drawChart._revealKey !== revealKey) {
    drawChart._revealKey = revealKey;
    drawChart._revealT0 = REDUCED ? 0 : performance.now();
  }
  let reveal = 1;
  if (drawChart._revealT0) {
    const rt = (performance.now() - drawChart._revealT0) / 650;
    if (rt >= 1) drawChart._revealT0 = 0; else reveal = 1 - Math.pow(1 - rt, 3);
  }

  const kl = d.raw_data?.key_levels || {};
  const srLevels = chartOpts.sr ? [...(kl.resistance || []).filter(isNum).map(x => [x, cssVar("--red")]),
                                   ...(kl.support || []).filter(isNum).map(x => [x, cssVar("--green")])] : [];
  const manualAnchors = sess.fibAnchors;
  const fib = chartOpts.fib ? (manualFibLevels(manualAnchors) || d.price_action?.fib || null) : null;

  // price bounds (include overlays so nothing clips)
  let vals = [];
  data.forEach(p => { vals.push(p.high, p.low); });
  if (chartOpts.bb) bb.up.forEach((x, i) => { if (isNum(x)) vals.push(x, bb.lo[i]); });
  srLevels.forEach(l => vals.push(l[0]));
  if (fib) Object.values(fib).forEach(x => { if (isNum(x)) vals.push(x); });
  if (fibInteraction.ticker === active && fibInteraction.pending) vals.push(fibInteraction.pending.price);
  const lo = Math.min(...vals) * 0.99, hi = Math.max(...vals) * 1.01;

  const padL = 54, padR = chartOpts.pct ? 50 : 14, padT = 12, padB = 30;
  const volH = chartOpts.vol ? 46 : 0;
  const plotB = H - padB - volH;
  const X = i => padL + (i + 0.5) / data.length * (W - padL - padR);
  const Y = val => padT + (1 - (val - lo) / (hi - lo)) * (plotB - padT);
  const cw = Math.max(1, (W - padL - padR) / data.length);
  const bodyW = Math.max(1, Math.min(cw * 0.66, 13));

  // grid + y axis ($)
  ctx.font = "10px 'IBM Plex Mono', monospace"; ctx.fillStyle = cssVar("--text-dim"); ctx.strokeStyle = cssVar("--border-soft"); ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) { const val = lo + g / 4 * (hi - lo), y = Y(val);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillText(val >= 1000 ? "$" + (val / 1000).toFixed(1) + "k" : "$" + val.toFixed(val < 10 ? 2 : 0), 6, y + 3);
    if (chartOpts.pct) { const base = data[0].close; const pc = ((val - base) / base) * 100;
      ctx.textAlign = "left"; ctx.fillStyle = cssVar("--text-dim"); ctx.fillText((pc >= 0 ? "+" : "") + pc.toFixed(0) + "%", W - padR + 6, y + 3); }
  }
  // x axis (dates)
  ctx.textAlign = "center"; ctx.fillStyle = cssVar("--text-dim");
  for (let g = 0; g <= 4; g++) { const i = Math.round(g / 4 * (data.length - 1)); ctx.fillText(data[i].date.slice(2), X(i), H - 8); }

  // everything painted after the axes is clipped to the reveal front
  const frontX = reveal >= 1 ? W : padL + reveal * (W - padL - padR);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, frontX, H); ctx.clip();

  // volume
  if (chartOpts.vol) {
    const maxVol = Math.max(...data.map(p => p.volume || 0)) || 1;
    data.forEach((p, i) => { const h = (p.volume || 0) / maxVol * (volH - 6);
      ctx.fillStyle = (p.close >= p.open ? cssVar("--green") : cssVar("--red")); ctx.globalAlpha = .35;
      ctx.fillRect(X(i) - bodyW / 2, H - 6 - h, bodyW, h); ctx.globalAlpha = 1; });
  }

  // Bollinger band fill + lines
  if (chartOpts.bb) {
    ctx.beginPath(); let started = false;
    bb.up.forEach((x, i) => { if (!isNum(x)) return; started ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x)); started = true; });
    for (let i = bb.lo.length - 1; i >= 0; i--) if (isNum(bb.lo[i])) ctx.lineTo(X(i), Y(bb.lo[i]));
    ctx.closePath(); ctx.fillStyle = "rgba(157,140,240,.07)"; ctx.fill();
    [["up", bb.up], ["lo", bb.lo]].forEach(([, arr]) => { ctx.beginPath(); let st = false;
      arr.forEach((x, i) => { if (!isNum(x)) return; st ? ctx.lineTo(X(i), Y(x)) : ctx.moveTo(X(i), Y(x)); st = true; });
      ctx.strokeStyle = cssVar("--violet"); ctx.globalAlpha = .5; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1; });
  }

  // S/R lines
  srLevels.forEach(([val, color]) => { ctx.strokeStyle = color; ctx.globalAlpha = .55; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(padL, Y(val)); ctx.lineTo(W - padR, Y(val)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.textAlign = "left"; ctx.fillText(fUsd(val), padL + 3, Y(val) - 3); });

  // Fibonacci
  if (fib) { Object.entries(fib).forEach(([k, val]) => { if (!isNum(val)) return;
    ctx.strokeStyle = cssVar("--violet"); ctx.globalAlpha = .4; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(padL, Y(val)); ctx.lineTo(W - padR, Y(val)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar("--violet"); ctx.textAlign = "right"; ctx.fillText(k, W - padR - 3, Y(val) - 3); }); }

  // A custom Fib has a visible swing leg and draggable endpoints.
  const anchorPoint = anchor => {
    if (!anchor) return null;
    const i = data.findIndex(p => p.date === anchor.date);
    return i < 0 ? null : { x: X(i), y: Y(anchor.price), i };
  };
  const startPoint = anchorPoint(manualAnchors?.start), endPoint = anchorPoint(manualAnchors?.end);
  if (startPoint && endPoint) {
    ctx.strokeStyle = cssVar("--violet"); ctx.lineWidth = 1.4; ctx.globalAlpha = .8;
    ctx.beginPath(); ctx.moveTo(startPoint.x, startPoint.y); ctx.lineTo(endPoint.x, endPoint.y); ctx.stroke(); ctx.globalAlpha = 1;
    [startPoint, endPoint].forEach(point => { ctx.beginPath(); ctx.arc(point.x, point.y, 5, 0, Math.PI * 2); ctx.fillStyle = cssVar("--surface"); ctx.fill(); ctx.strokeStyle = cssVar("--violet"); ctx.lineWidth = 2; ctx.stroke(); });
  }
  const pendingPoint = fibInteraction.ticker === active ? anchorPoint(fibInteraction.pending) : null;
  if (pendingPoint) { ctx.beginPath(); ctx.arc(pendingPoint.x, pendingPoint.y, 6, 0, Math.PI * 2); ctx.fillStyle = cssVar("--violet"); ctx.fill(); }

  // MA lines
  const maSpec = [[chartOpts.ma200, ma200, cssVar("--text-dim"), 1.2], [chartOpts.ma50, ma50, cssVar("--amber"), 1.4], [chartOpts.ma20, ma20, cssVar("--accent"), 1.4]];
  maSpec.forEach(([on, arr, color, wgt]) => { if (!on) return; ctx.beginPath(); let st = false;
    arr.forEach((val, i) => { if (val === null) return; st ? ctx.lineTo(X(i), Y(val)) : ctx.moveTo(X(i), Y(val)); st = true; });
    ctx.strokeStyle = color; ctx.lineWidth = wgt; ctx.stroke(); });

  // CANDLES
  ctx.lineWidth = 1;
  data.forEach((p, i) => {
    const up = p.close >= p.open, color = up ? cssVar("--green") : cssVar("--red");
    const x = X(i);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    // wick
    ctx.beginPath(); ctx.moveTo(x, Y(p.high)); ctx.lineTo(x, Y(p.low)); ctx.stroke();
    // body
    const yO = Y(p.open), yC = Y(p.close); const top = Math.min(yO, yC); const hgt = Math.max(1, Math.abs(yC - yO));
    if (up) { ctx.globalAlpha = document.documentElement.dataset.mode === "dark" ? .85 : 1; ctx.fillRect(x - bodyW / 2, top, bodyW, hgt); ctx.globalAlpha = 1; }
    else { ctx.fillRect(x - bodyW / 2, top, bodyW, hgt); }
  });

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
    return { date: p.date, price, i, x: X(i), y: Y(price) };
  };
  const showHover = e => {
    const hit = pointFromEvent(e); if (!hit) return;
    const i = hit.i;
    const p = data[i]; if (!p) return;
    drawChart._hover = i; drawChart();
    tipEl.style.display = "block";
    const chg = ((p.close - p.open) / p.open) * 100;
    tipEl.innerHTML = `<b>${p.date}</b><br>O ${fUsd(p.open)} · H ${fUsd(p.high)}<br>L ${fUsd(p.low)} · C ${fUsd(p.close)}<br>
      <span class="${chg >= 0 ? "tg" : "tr"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span> · Vol ${fInt(p.volume)}`;
    const tx = Math.min(X(i) + 12, W - 160); tipEl.style.left = Math.max(padL, tx) + "px"; tipEl.style.top = "10px";
  };
  canvas.onpointerdown = e => {
    const hit = pointFromEvent(e); if (!hit) return;
    const drawing = fibInteraction.mode && fibInteraction.ticker === active;
    if (drawing) {
      if (!fibInteraction.pending) fibInteraction.pending = { date: hit.date, price: hit.price };
      else {
        sess.fibAnchors = { start: fibInteraction.pending, end: { date: hit.date, price: hit.price } };
        fibInteraction.pending = null; fibInteraction.mode = false; touchSession(sess); persistSessions();
      }
      syncFibControls(); drawChart(); return;
    }
    const near = (point, name) => point && Math.hypot((e.clientX - canvas.getBoundingClientRect().left) - point.x, (e.clientY - canvas.getBoundingClientRect().top) - point.y) <= 14 ? name : null;
    const handle = near(startPoint, "start") || near(endPoint, "end");
    if (handle) { fibInteraction.dragging = handle; fibInteraction.ticker = active; canvas.setPointerCapture(e.pointerId); e.preventDefault(); }
  };
  canvas.onpointermove = e => {
    if (fibInteraction.dragging && fibInteraction.ticker === active && sess.fibAnchors) {
      const hit = pointFromEvent(e); if (!hit) return;
      sess.fibAnchors[fibInteraction.dragging] = { date: hit.date, price: hit.price };
      tipEl.style.display = "none"; drawChart(); return;
    }
    showHover(e);
  };
  canvas.onpointerup = () => {
    if (!fibInteraction.dragging) return;
    fibInteraction.dragging = null; touchSession(sess); persistSessions(); syncFibControls(); drawChart();
  };
  canvas.onpointercancel = canvas.onpointerup;
  canvas.onmouseleave = () => { if (fibInteraction.dragging) return; tipEl.style.display = "none"; drawChart._hover = null; drawChart(); };

  // draw crosshair if hovering
  if (isNum(drawChart._hover) && drawChart._hover < data.length) {
    const x = X(drawChart._hover);
    ctx.strokeStyle = cssVar("--text-dim"); ctx.globalAlpha = .4; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, plotB); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // keep sweeping until the reveal completes
  if (drawChart._revealT0 && !drawChart._revealRaf) {
    drawChart._revealRaf = requestAnimationFrame(() => { drawChart._revealRaf = null; drawChart(); });
  }
}
drawChart._hover = null;
window.chartRedrawCallback = function () { drawChart(); };
window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(() => { if (active) drawChart(); }, 120); });

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
    if (!res.ok || !res.body) throw new Error("server responded " + res.status);

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
        else if (evt === "done")  { if (j.reply) aiMsg.content = j.reply; if (j.reasoning) aiMsg.reasoning = j.reasoning; }
        else if (evt === "error") { aiMsg.error = true; aiMsg.content = (aiMsg.content ? aiMsg.content + "\n\n" : "") + "⚠️ " + j.error; }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      // User stopped it — keep whatever streamed; note it if nothing arrived.
      if (!aiMsg.content.trim()) aiMsg.content = "_Stopped._";
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
document.getElementById("chatMessages").addEventListener("scroll", function () {
  chatSticky = (this.scrollHeight - this.scrollTop - this.clientHeight) < 60;
});
document.getElementById("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
syncChatThinkBtn();
document.getElementById("ticker").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); runAnalysis(); } });
renderTickerPills();

/* ════════════════ RESIZERS (rAF-driven, snap points, touch-ready) ════════════════ */
(function () {
  const rz = document.getElementById("resizer"), split = document.getElementById("split"), badge = document.getElementById("rzBadge");
  try { const saved = localStorage.getItem("squall-split"); if (saved) split.style.setProperty("--left-w", saved); } catch (e) {}
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
    badge.textContent = Math.round(pct) + " / " + Math.round(100 - pct);
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
    if (active) requestAnimationFrame(drawChart);
  });
})();

(function () {
  const grip = document.getElementById("chatGrip"), dock = document.getElementById("chatDock");
  try { const saved = localStorage.getItem("squall-chat-h"); if (saved) dock.style.setProperty("--chat-h", saved); } catch (e) {}
  let dragging = false, pendingY = null, raf = null;

  function apply() {
    raf = null;
    if (pendingY == null) return;
    const aiPane = document.getElementById("aiPane").getBoundingClientRect();
    const h = Math.max(120, Math.min(aiPane.height * 0.8, aiPane.bottom - pendingY));
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
    dock.style.setProperty("--chat-h", "280px");
    try { localStorage.removeItem("squall-chat-h"); } catch (e) {}
    setTimeout(() => dock.classList.remove("animate"), 350);
  });
  // Keyboard: up/down arrows resize the chat dock, Enter resets.
  grip.addEventListener("keydown", e => {
    if (e.key === "Enter") { grip.dispatchEvent(new Event("dblclick")); e.preventDefault(); return; }
    const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const cur = parseFloat(dock.style.getPropertyValue("--chat-h")) || 280;
    const aiPane = document.getElementById("aiPane").getBoundingClientRect();
    const h = Math.max(120, Math.min(aiPane.height * 0.8, cur + dir * 24));
    dock.style.setProperty("--chat-h", Math.round(h) + "px");
    try { localStorage.setItem("squall-chat-h", Math.round(h) + "px"); } catch (err) {}
  });
})();

/* ════════════════ MOBILE TABS ════════════════ */
document.querySelectorAll("#mobileTabs button").forEach(btn => {
  btn.onclick = () => { document.querySelectorAll("#mobileTabs button").forEach(b => b.classList.toggle("active", b === btn));
    if (matchMedia("(max-width: 960px)").matches) {
      document.getElementById("dataPane").toggleAttribute("data-hidden", btn.dataset.pane !== "dataPane");
      document.getElementById("aiPane").toggleAttribute("data-hidden", btn.dataset.pane !== "aiPane");
      if (btn.dataset.pane === "dataPane" && active) drawChart(); } };
});
matchMedia("(max-width: 960px)").addEventListener("change", ev => {
  if (!ev.matches) { document.getElementById("dataPane").removeAttribute("data-hidden"); document.getElementById("aiPane").removeAttribute("data-hidden"); }
  else document.querySelector("#mobileTabs button.active")?.click();
  if (active) drawChart();
});
if (matchMedia("(max-width: 960px)").matches) document.getElementById("aiPane").setAttribute("data-hidden", "");

/* ════════════════ MODAL OVERLAY TOGGLES (delegation — fires on cloned checkboxes) ════════════════ */
document.getElementById("chartModalControls").addEventListener("change", function (e) {
  const opt = e.target.dataset.opt;
  if (!opt) return;
  chartOpts[opt] = e.target.checked;
  e.target.closest(".toggle")?.classList.toggle("on", e.target.checked);
  // Mirror state back to the source checkbox in #chartControls
  const src = document.querySelector(`#chartControls input[data-opt="${opt}"]`);
  if (src) { src.checked = e.target.checked; src.closest(".toggle")?.classList.toggle("on", e.target.checked); }
  drawChart();
});

/* ════════════════ HERO WIND FIELD ════════════════
   Passive, cursor-reactive wind behind the landing hero. Short accent-colored streaks
   drift left→right (matching .hero-streaks); moving the cursor drags nearby streaks along
   its path and parts them around it, then the field relaxes back to ambient drift. */
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

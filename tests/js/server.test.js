"use strict";

const assert = require("node:assert/strict");
const {
  sanitizeProfile, fallbackScreenerSpec, sanitizeScreenerSpec,
  validateBacktestDate,
  LIM, COST, clientIp, clientKey, admit, buckets, globals
} = require("../../server");

const BASE_LIMITS = { ...LIM };

function request(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

function resetLimits(overrides = {}) {
  Object.assign(LIM, BASE_LIMITS, overrides);
  buckets.clear();
  Object.assign(globals, { dayId: "", ai: 0, scrape: 0, screen: 0, ceilingLogged: {} });
}

test("sanitizeProfile clamps scores and removes unsafe preference data", () => {
  const profile = sanitizeProfile({
    risk: 99, horizon: 0, experience: "unknown", depth: 3.6,
    style: "invented",
    priorities: ["growth", "growth", "downside", "bogus", "income", "momentum", "options"],
    custom: "  patient\u0000 investor\nwith context  "
  });
  assert.deepEqual(profile, {
    risk: 5, horizon: 1, experience: 3, depth: 4, style: "balanced",
    priorities: ["growth", "downside", "income", "momentum"],
    custom: "patient investor with context"
  });
  assert.equal(sanitizeProfile("not json"), null);
  assert.equal(sanitizeProfile([]), null);
});

test("sanitizeScreenerSpec rejects unknown concepts and unsafe model defaults", () => {
  const fallback = fallbackScreenerSpec("quality companies", null);
  const safe = sanitizeScreenerSpec({
    title: "  Quality\u0000 screen  ",
    summary: "measurable candidates",
    concepts: [
      { id: "quality", weight: 99, required: true },
      { id: "not_a_real_concept", weight: 2 }
    ],
    filters: {
      sectors: ["Technology", "Technology", "Not a sector"],
      price_min: 20, price_max: 10, pe_max: 0, beta_max: "none"
    },
    settings: { match_threshold: 999, consolidation_window: 45, momentum_window: 126 },
    max_results: 500,
    theme: {
      label: "AI\u0000 infrastructure",
      keywords: ["GPU!!!", "gpu", "data center", "x", "valid-term"],
      exclude_keywords: ["consulting<script>", ""],
      min_score: 999
    }
  }, fallback);

  assert.deepEqual(safe.concepts.map(c => c.id), ["quality"]);
  assert.equal(safe.concepts[0].weight, 3);
  assert.equal(safe.concepts[0].required, true);
  assert.deepEqual(safe.filters.sectors, ["Technology"]);
  assert.equal(safe.filters.price_min, 20);
  assert.equal("price_max" in safe.filters, false);
  assert.equal("pe_max" in safe.filters, false);
  assert.equal(safe.settings.match_threshold, 85);
  assert.equal(safe.settings.momentum_window, 126);
  assert.equal(safe.max_results, 50);
  assert.deepEqual(safe.theme.keywords, ["gpu", "data center", "valid-term"]);
  assert.equal(safe.theme.min_score, 80);
  assert.equal(safe.definitions[0].id, "quality");
});

test("historical analyzer dates are real, past, and within the supported era", () => {
  const now = new Date("2026-08-20T12:00:00Z");
  assert.deepEqual(validateBacktestDate("2024-02-29", now), { ok:true, value:"2024-02-29" });
  assert.equal(validateBacktestDate("2024-02-30", now).ok, false);
  assert.equal(validateBacktestDate("1999-12-31", now).ok, false);
  assert.equal(validateBacktestDate("2026-08-20", now).ok, false);
});

test("client identity ignores spoofed forwarding headers on a public peer", () => {
  resetLimits({ TRUST_PROXY: 1 });
  const req = request("203.0.113.80", { "x-forwarded-for": "1.2.3.4" });
  assert.equal(clientIp(req), "203.0.113.80");
  assert.equal(clientKey(req), "4:203.0.113.80");
});

test("client identity trusts the rightmost public hop behind a private proxy", () => {
  resetLimits({ TRUST_PROXY: 1 });
  const req = request("10.0.0.8", { "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
  assert.equal(clientIp(req), "203.0.113.9");
});

test("IPv6 client keys bucket addresses by /64", () => {
  resetLimits();
  const a = clientKey(request("2001:db8:1234:5678:0000:0000:0000:0001"));
  const b = clientKey(request("2001:db8:1234:5678:ffff:ffff:ffff:ffff"));
  const c = clientKey(request("2001:db8:1234:9999::1"));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(clientKey(request("::ffff:192.0.2.4")), "4:192.0.2.4");
});

test("admit enforces burst limits without charging a denied request", () => {
  resetLimits({
    BURST_CAP: 1, BURST_REFILL_MS: 600000,
    IP_HOURLY: 100, IP_DAILY: 100, IP_ANALYZE_DAILY: 100,
    GLOBAL_SCRAPE_DAILY: 100, GLOBAL_SCREEN_DAILY: 100
  });
  const req = request("192.0.2.20");
  assert.equal(admit(req, "chat").ok, true);
  const denied = admit(req, "chat");
  assert.equal(denied.ok, false);
  assert.equal(denied.rule, "burst");
  const entry = buckets.get("4:192.0.2.20");
  assert.equal(entry.dayN, 1);
  assert.equal(entry.hourN, 1);
});

test("admit applies engine costs only after every gate passes", () => {
  resetLimits({
    BURST_CAP: 10, IP_HOURLY: 100, IP_DAILY: 100, IP_ANALYZE_DAILY: 100,
    GLOBAL_SCRAPE_DAILY: 100, GLOBAL_SCREEN_DAILY: 0
  });
  const screenReq = request("192.0.2.21");
  const denied = admit(screenReq, "screen");
  assert.equal(denied.rule, "global_screen");
  const untouched = buckets.get("4:192.0.2.21");
  assert.equal(untouched.tokens, 10);
  assert.equal(untouched.dayN, 0);
  assert.equal(globals.screen, 0);

  LIM.GLOBAL_SCREEN_DAILY = 100;
  const analyzeReq = request("192.0.2.22");
  assert.equal(admit(analyzeReq, "analyze").ok, true);
  assert.equal(buckets.get("4:192.0.2.22").analyzeN, COST.analyze.scrape);
  assert.equal(globals.scrape, COST.analyze.scrape);
});

"use strict";

/*
 * Covers the pure helpers behind the /ilgar charts.
 *
 * backtester.js is a browser script, not a module, so it is executed in a vm with
 * the small stub its top level actually touches and its function declarations are
 * read off the sandbox global. Only pure functions are exercised here — anything
 * that strokes a canvas is verified in the browser, per CLAUDE.md.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBacktester() {
  const sandbox = {
    document: {
      getElementById: () => null,
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => []
    },
    ResizeObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    requestAnimationFrame: () => 1,
    console: { log() {}, warn() {}, error() {} },
    devicePixelRatio: 1,
    EventSource: function () { return { addEventListener() {}, close() {} }; }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const file = path.resolve(__dirname, "..", "..", "backtester.js");
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: "backtester.js" });
  return sandbox;
}

const BT = loadBacktester();

/*
 * Arrays built inside the sandbox carry that realm's Array.prototype, and strict
 * deepEqual compares prototypes — so a correct result fails as "same structure but
 * not reference-equal". Round-trip anything the sandbox allocated before comparing
 * it structurally. Whether a returned array is host- or sandbox-allocated depends
 * on where its backing .map() ran, which is not worth reasoning about per call.
 */
const plain = value => JSON.parse(JSON.stringify(value));

test("chart gridlines land on round numbers inside the measured range", () => {
  // The range is NOT snapped outward — a tick outside [lo, hi] would mean the
  // renderer gave up plot height to make a label look tidy.
  const ticks = BT.btNiceTicks(118.6, 179.5);
  assert.ok(ticks.length >= 3, `expected at least 3 gridlines, got ${ticks.length}`);
  assert.ok(ticks.length <= 8, `expected at most 8 gridlines, got ${ticks.length}`);
  for (const t of ticks) {
    assert.ok(t >= 118.6 && t <= 179.5, `${t} falls outside the data range`);
    assert.ok(Number.isInteger(t / 10), `${t} is not a round value a person would say`);
  }
});

test("an equity curve puts break-even on a gridline", () => {
  // Every series in the /ilgar curve is indexed to $10,000 at the entry fill, so
  // "above or below 10,000" is the entire question the chart answers. A scale that
  // omits it — as an even 4-way split of the padded range did — cannot answer it.
  // Note the curve's FIRST point is not 10,000: entry fills at the opening print
  // and the curve is stamped from closes, so day one already carries a move.
  const ticks = BT.btNiceTicks(9510, 13182);
  assert.ok(ticks.includes(10000), `break-even missing from ${JSON.stringify(ticks)}`);
});

test("gridlines survive a flat and an inverted range without hanging", () => {
  assert.deepEqual(plain(BT.btNiceTicks(100, 100)), []);
  assert.deepEqual(plain(BT.btNiceTicks(50, 10)), []);
  assert.deepEqual(plain(BT.btNiceTicks(Number.NaN, 10)), []);
});

test("sub-dollar and very large ranges still produce round gridlines", () => {
  for (const [lo, hi] of [[0.42, 0.91], [11_500_000, 48_200_000]]) {
    const ticks = BT.btNiceTicks(lo, hi);
    assert.ok(ticks.length >= 3, `range ${lo}–${hi} produced ${ticks.length} gridlines`);
    for (const t of ticks) assert.ok(t >= lo && t <= hi, `${t} outside ${lo}–${hi}`);
  }
});

test("date ticks are spread across the window, not just its two ends", () => {
  const dates = Array.from({ length: 126 }, (_, i) => `2023-${String(1 + (i % 12)).padStart(2, "0")}-01`);
  const ticks = BT.btDateTicks(dates);
  assert.ok(ticks.length >= 4, `expected several date ticks, got ${ticks.length}`);
  assert.equal(ticks[0].index, 0);
  assert.equal(ticks[ticks.length - 1].index, dates.length - 1);
  // Strictly increasing, so no two labels collide on the same x.
  for (let i = 1; i < ticks.length; i++)
    assert.ok(ticks[i].index > ticks[i - 1].index, "date tick indices must increase");
});

test("date labels are never repeated, whatever the window spans", () => {
  // A short window puts two ticks in one month; a long one puts two in one
  // month-of-year. Both used to render the same label twice, which locates nothing.
  const sameMonth = Array.from({ length: 20 }, (_, i) => `2023-03-${String(i + 1).padStart(2, "0")}`);
  const acrossYears = Array.from({ length: 40 },
    (_, i) => `${2019 + Math.floor(i / 12)}-${String(1 + (i % 12)).padStart(2, "0")}-15`);
  for (const dates of [sameMonth, acrossYears]) {
    const labels = plain(BT.btDateTicks(dates)).map(t => t.label);
    assert.equal(new Set(labels).size, labels.length, `repeated label in ${JSON.stringify(labels)}`);
  }
});

test("a narrow canvas asks for fewer date ticks and still spans the window", () => {
  const dates = Array.from({ length: 126 },
    (_, i) => new Date(Date.UTC(2023, 2, 16 + i)).toISOString().slice(0, 10));
  const ticks = plain(BT.btDateTicks(dates, 3));
  assert.equal(ticks.length, 3);
  assert.equal(ticks[0].index, 0);
  assert.equal(ticks[2].index, dates.length - 1);
});

test("a two-point window degrades to its endpoints rather than repeating one", () => {
  const ticks = BT.btDateTicks(["2023-03-16", "2023-03-17"]);
  assert.deepEqual(plain(ticks).map(t => t.index), [0, 1]);
});

test("the trade line splits at the exit so the cash tail is a separate stroke", () => {
  // simulateTrade holds the trade flat in cash to the end of the window by design.
  // Drawn as one stroke, most of the boldest line on the chart is a position that
  // no longer exists. The two segments must SHARE the exit point or the line breaks.
  const points = [10000, 10100, 9800, 9760, 9760, 9760];
  const split = BT.btSplitAtExit(points, 3);
  assert.ok(split, "expected a split when sessions remain after the exit");
  assert.deepEqual(plain(split.live), [10000, 10100, 9800, 9760, null, null]);
  assert.deepEqual(plain(split.cash), [null, null, null, 9760, 9760, 9760]);
});

test("no cash tail is drawn when the trade ran to the end of the window", () => {
  const points = [10000, 10100, 9800];
  assert.equal(BT.btSplitAtExit(points, 2), null);
  assert.equal(BT.btSplitAtExit(points, null), null);
  assert.equal(BT.btSplitAtExit(points, -1), null);
});

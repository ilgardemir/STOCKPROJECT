# Squall UI/UX direction — precision instrument

**Date:** 2026-08-04
**Status:** Approved, ready for implementation planning

## Problem

Squall's interface is carefully built — the CSS carries real reasoning, the motion is
deliberate, the six-theme system is coherent. But its *visual vocabulary* is the default
one: Chakra Petch as a display face, teal-on-slate, uppercase letterspaced micro-labels, an
icon on every card header, motion on nearly every element. Each choice is individually
defensible; together they are the exact set a generator reaches for. The craft is real, the
identity is borrowed.

The goal is to replace borrowed vocabulary with chosen vocabulary, without discarding the
working system underneath.

## Direction

**Squall is a precision instrument.** Terminal lineage: dense, monospace-forward,
information-first, minimal chrome. The data is the design; decoration is suspect.

This direction is load-bearing rather than cosmetic. Squall's pitch is "here is the
evidence, verifiably sourced" — the per-card provenance badges added earlier the same day
already commit to that claim. An instrument aesthetic is the honest expression of it, and it
is the direction furthest from generated-dashboard defaults.

## 1. Token layer

Two families. No display face.

```css
--mono: 'IBM Plex Mono'   /* instrument: data, labels, chrome, wordmark */
--doc:  'Newsreader'      /* document: analysis prose, excerpts, explanations */
```

Chakra Petch and Schibsted Grotesk are removed. This is a net reduction from three webfont
families to two, so it improves load rather than costing anything.

Newsreader is chosen deliberately: drawn for screen reading, variable, editorial without
being fussy, and uncommon enough not to read as a default pick. Generated dashboards
essentially never use a serif, which makes the document register the single most
distinguishing move available.

The wordmark is set in the mono, uppercase and tightly tracked. Section headers are also mono
but **lowercase and untracked** — the current uppercase-plus-letterspacing treatment on every
card header is one of the borrowed-vocabulary tells this direction is meant to remove.
Instruments do not have a brand font; they have a readout face. Using it for identity is the
point.

### Type scale

| Token | Size | Use |
|---|---|---|
| `--t-micro` | 10px | labels, provenance badges, counts |
| `--t-data` | 12px | tabular values |
| `--t-body` | 13px | chrome text |
| `--t-lead` | 15px | emphasised readouts |
| `--t-doc` | 16px | document body |
| `--t-doc-h` | 20px | document headings |
| `--t-title` | 22px | company / page title |

Line height: instrument `1.35`, document `1.6`. Document measure caps at `66ch`.

`font-variant-numeric: tabular-nums` applies to every numeric context. The serif requires it
and it is currently set nowhere in the stylesheet.

10px is a hard floor. Nothing renders smaller.

### Color roles

Roles are named for their job, not their appearance, and the neutral ramp drops from five
steps to three.

```
--chrome-0 / --chrome-1 / --chrome-2   surfaces
--rule                                 hairlines
--ink / --ink-dim / --ink-bright       text
--accent                               exactly one, load-bearing
--up / --down                          direction only
--warn                                 amber, rare
```

The five current neutrals collapse as follows, so the reduction is unambiguous:
`--bg` and `--bg-deep` → `--chrome-0`; `--surface` → `--chrome-1`; `--surface-2` and
`--surface-3` → `--chrome-2`. `--border` and `--border-soft` collapse to `--rule`. Elements
that relied on a distinct third surface for hover states use `--rule` or a background
lightness shift instead.

`--violet` is deleted. It currently serves as an unofficial second accent (MySquall, recipe
chips, Fibonacci levels, chat role labels). "Exactly one accent" is the rule that makes the
palettes read as disciplined rather than decorated.

The existing radius scale (`--radius` 12 / `--radius-md` 10 / `--radius-sm` 8 / `--radius-xs`
6) is retained unchanged.

## 2. The two registers

The dividing line is **measurement vs. explanation**, not pane position.

| Instrument (mono) | Document (serif) |
|---|---|
| Header, utility rail, saved tabs | AI analysis pane |
| All card data and labels | MD&A excerpt |
| Screener form, results, recipe chips | Learn-notes |
| Chart axes and chrome | Recipe plain-English definitions |
| Wordmark | Screener refinement chat |

The seam between the two panes becomes deliberate rather than accidental. An instrument has
a readout and a manual; that distinction is correct, not inconsistent.

## 3. Density

The largest visual change. Metric tiles become **tabular rows**.

Today every metric is a rounded box with a stacked label and value. Nineteen cards at roughly
eight tiles each produces a field of boxes.

```
valuation                        yq·fh·fmp
  pe trailing                        38.2
  pe forward                         31.4
  ev/ebitda                          24.9
```

Values are right-aligned on a shared axis. This is what makes the surface read as an
instrument, and it is genuinely more scannable — comparison down a column is possible, which
tiles prevent.

- Row height `22px`, gutter `12px`, block padding `14px`.
- Cards lose `box-shadow` and become sections separated by hairlines.
- The nineteen per-card icons are removed. An icon on every header is decoration when the
  header already names the section.

## 4. Palette discipline

All six themes are retained. Each is audited against the same rule: chrome near-neutral,
exactly one accent, green and red reserved for direction.

| Theme | Action |
|---|---|
| Midnight | accent retained; neutral ramp reduced to three steps |
| Daylight | as above |
| Noir | already near-conformant |
| Paper | already near-conformant |
| Lagoon | chrome pulled from deep teal toward near-neutral with a teal cast |
| Terminal | already correct; serves as the reference implementation |

Violet is removed from every theme. With chrome neutralised, green and red become the only
other colors on screen, which makes direction read hard — a real gain for a stock app.

## 5. Motion budget

The governing rule: **motion encodes state, it never announces arrival.**

**Retained** — progress fill (completion), streaming caret (live output), match-ring count-up
(magnitude), score-bar growth (magnitude), screener scroll reveal (just arrived), theme
crossfade (state change).

**Removed** — card entrance cascade, summary strip cascade, screener recipe chip pops,
provenance badge pop, wordmark idle gust, hero dot-grid drift.

The hero wind-field canvas survives. It is the one piece of ambience with real craft, and the
hero is not an instrument surface.

## 6. Migration approach

**Token-first.** Rebuild the token layer, let components inherit, then fix the stragglers.

This is the right lever for this codebase specifically: the radius change made earlier the
same day collapsed roughly forty scattered literals into four tokens, demonstrating that the
stylesheet already responds to token-level edits. It is also the cheapest of the three
options considered (the alternatives were surface-by-surface, which reworks shared components
repeatedly, and a parallel opt-in stylesheet, which doubles the CSS surface in an app with no
build step).

Accepted cost: a transitional period where some surfaces look half-migrated.

## 7. Verification

The project has no test suite, linter, or build step. Verification is empirical, following
the method already in use: deploy to `squall.up.railway.app` (the only environment with
Python, API keys and dependencies), then measure and screenshot.

Per-change gates:

1. **Computed-style check** — read resolved values from the live DOM, confirm they match the
   token table rather than trusting the source.
2. **Contrast audit across all six themes** — the measurement script already exists and must
   continue to pass WCAG AA for every text-on-surface pair.
3. **Token-orphan grep** — after migration, no hardcoded `font-family`, `font-size`, or color
   literal outside the token block.
4. **Screenshot every theme** on hero, screener and a populated dashboard.

## 8. Risks

- **Mono at 10–12px for all chrome** is the real gamble. It is the most instrument-like
  choice and the most likely to hurt legibility. Mitigation: the 10px floor, and explicit
  checks in Paper and Daylight where contrast is lowest.
- **Tabular rows on narrow panes.** The left pane can be dragged to 360px, and label-value
  rows degrade worse than tiles. A collapse behaviour must be defined during implementation:
  below a threshold width, rows stack label-over-value.
- **Removing violet** touches MySquall's entire visual identity, which is currently
  violet-coded. MySquall needs a replacement treatment that does not reintroduce a second
  accent — likely weight and rule treatment rather than hue.

## 9. Open question

Whether dashboard cards remain open by default. Sixteen of nineteen currently render
expanded. Tabular rows make every card substantially shorter, so the current default may
become acceptable. This is deliberately deferred: it should be measured after the density
change rather than guessed at now.

## 10. Out of scope

- Any change to the Python engines, server, or SSE contracts.
- Chart rendering internals beyond axis and chrome typography.
- Adding dependencies. The project ships zero npm packages and no build step; that stands.
- Information architecture. Which cards exist, and what the screener does, are unchanged.

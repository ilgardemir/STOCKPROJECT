# Precision-Instrument UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Squall's borrowed visual vocabulary with a chosen one — a mono/serif two-register precision instrument — without discarding the working system underneath.

**Architecture:** Token-first. The token block at the top of `index.html` is rebuilt first, components inherit, then stragglers are fixed. Every migration is done additively (add new token → migrate usages → delete old token) so the app never enters a broken state between commits.

**Tech Stack:** Vanilla HTML/CSS/JS. Zero npm dependencies, no build step, no bundler. All CSS lives in `index.html` inside one `<style>` block; all behavior lives in `app.js`. Fonts come from Google Fonts via a single `<link>`.

## Global Constraints

- **No dependencies.** The project ships zero npm packages and no build step. Do not add either.
- **No changes to Python engines, `server.js`, or the SSE event contracts.** This is a presentation-layer change only.
- **10px is a hard type floor.** Nothing renders smaller.
- **Exactly one accent per theme.** Green and red are reserved for direction; amber is rare; there is no second accent.
- **All six themes must keep working** — `dark`, `light`, `noir`, `paper`, `lagoon`, `matrix`. Every token added to one theme block must be added to all six.
- **WCAG AA (4.5:1)** for every text-on-surface pair, in every theme.
- **Commit after every task.** Push to `main`; Railway auto-deploys.

## Verification Method (read before Task 1)

There is no test suite, linter, or build step. "Testing" means running the app and measuring it. Two harnesses are used throughout; both are defined here once and referenced by later tasks.

**Harness A — computed-style probe.** Run against a loaded page via the browser tool's `javascript_tool`. Reads resolved values from the live DOM rather than trusting the source:

```js
const cs = getComputedStyle(document.documentElement);
const v = n => cs.getPropertyValue(n).trim();
const probe = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
```

**Harness B — six-theme contrast audit.** Cycles every theme and reports the worst text-on-surface ratio. Paste whole:

```js
const root = document.documentElement, prev = root.dataset.theme;
const toRGB = s => { const d = document.createElement('div'); d.style.color = s; document.body.appendChild(d);
  const m = getComputedStyle(d).color.match(/[\d.]+/g).slice(0,3).map(Number); d.remove(); return m; };
const L = c => { const [r,g,b] = c.map(x => { x/=255; return x<=.03928 ? x/12.92 : Math.pow((x+.055)/1.055, 2.4); });
  return .2126*r + .7152*g + .0722*b; };
const ratio = (a,b) => { const l1 = L(toRGB(a)), l2 = L(toRGB(b));
  return +((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)).toFixed(2); };
const V = n => getComputedStyle(root).getPropertyValue(n).trim();
const out = THEMES.map(t => { root.dataset.theme = t.id; const s = V('--surface') || V('--chrome-1');
  const ink = V('--bright') || V('--ink-bright'), dim = V('--text-dim') || V('--ink-dim');
  return `${t.id}: ink ${ratio(ink,s)} dim ${ratio(dim,s)}`; });
root.dataset.theme = prev;
out.join('\n');
```

**Local vs deployed.** `node server.js` on `PORT=3111` serves the UI fine without Python, which is enough for every task except Task 7 and Task 10 (they need a populated dashboard). Those must be verified on `https://squall.up.railway.app` after push. Python is **not** installed on the dev machine — do not attempt to run `scraperFinal.py` locally.

---

### Task 1: Load the serif and add the type tokens

Additive only. Old tokens stay; nothing should visibly change except that Newsreader becomes available.

**Files:**
- Modify: `index.html:13` (fonts link), `index.html:15-25` (`:root` token block)

**Interfaces:**
- Consumes: nothing
- Produces: `--doc`, `--t-micro`, `--t-data`, `--t-body`, `--t-lead`, `--t-doc`, `--t-doc-h`, `--t-title`, `--lh-tight`, `--lh-doc`, `--measure`

- [ ] **Step 1: Add Newsreader to the fonts link**

Replace line 13 entirely. Chakra Petch and Schibsted Grotesk stay for now — they are removed in Task 3, after their usages are gone.

```html
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&family=Chakra+Petch:wght@600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap" rel="stylesheet">
```

- [ ] **Step 2: Add the document family and type scale to `:root`**

Insert immediately after the existing `--display:` line (line 18):

```css
  --doc: 'Newsreader', Georgia, 'Times New Roman', serif;
  /* Instrument register is dense; document register is for reading. */
  --t-micro: 10px; --t-data: 12px; --t-body: 13px; --t-lead: 15px;
  --t-doc: 16px; --t-doc-h: 20px; --t-title: 22px;
  --lh-tight: 1.35; --lh-doc: 1.6; --measure: 66ch;
```

- [ ] **Step 3: Verify the font actually loaded**

Start the server, then run via Harness A:

```bash
PORT=3111 node server.js
```

```js
await document.fonts.ready;
JSON.stringify({
  newsreader: document.fonts.check('16px Newsreader'),
  doc: getComputedStyle(document.documentElement).getPropertyValue('--doc').trim(),
  scale: ['--t-micro','--t-data','--t-doc','--measure']
    .map(n => n + '=' + getComputedStyle(document.documentElement).getPropertyValue(n).trim())
});
```

Expected: `newsreader: true`, `--doc` resolves to the Newsreader stack, all four scale values non-empty.
If `newsreader: false`, the `<link>` is malformed — recheck Step 1 before continuing.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add Newsreader and the two-register type scale"
git push
```

---

### Task 2: Move chrome to mono and prose to serif

**Files:**
- Modify: `index.html` — all 7 `var(--sans)` and 12 `var(--display)` usages
- Modify: `app.js` — no changes needed (fonts are never set inline)

**Interfaces:**
- Consumes: `--doc` and the type scale from Task 1
- Produces: a stylesheet where `--sans` and `--display` are unreferenced

- [ ] **Step 1: Find every usage**

```bash
grep -n "var(--sans)\|var(--display)" index.html
```

Expect 19 lines. Every one gets reassigned in Step 2 by the rule below — no exceptions, no judgement calls.

- [ ] **Step 2: Reassign by register**

The rule: **anything that is measurement or chrome becomes `var(--mono)`; anything that is explanation in sentences becomes `var(--doc)`.**

To `var(--doc)` — these are the only prose surfaces:
- `.prose` and its descendants (the AI analysis body)
- `.learn-note`
- `.recipe-definition` text
- `.screen-chat-msg p`
- `#hero p` (the pitch and fine print)
- `blockquote` (MD&A excerpt)

Everything else — header, wordmark, rail, tabs, card headers, metrics, screener form, buttons, tooltips, empty states — becomes `var(--mono)`.

- [ ] **Step 3: Restyle card headers to lowercase**

The current uppercase-plus-letterspacing treatment is one of the borrowed-vocabulary tells the direction exists to remove. Replace the font declarations on `index.html:588-589`:

```css
.card > summary { list-style: none; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 9px; padding: 12px 16px;
  font-family: var(--mono); font-size: var(--t-body); font-weight: 500; letter-spacing: 0; text-transform: lowercase; color: var(--bright); transition: background .15s; }
```

The wordmark keeps uppercase and tracking — it is identity, not a header. Leave `.wordmark .wm-title` alone except for swapping `var(--display)` to `var(--mono)`.

- [ ] **Step 4: Apply the document measure and leading**

Add near the `.prose` rules:

```css
.prose, .learn-note, .screen-chat-msg p, #hero p, .prose blockquote {
  font-family: var(--doc); font-size: var(--t-doc); line-height: var(--lh-doc); }
.prose { max-width: var(--measure); }
.prose h1, .prose h2, .prose h3 { font-family: var(--doc); font-size: var(--t-doc-h); line-height: 1.3; }
```

- [ ] **Step 5: Verify both registers resolve**

```js
const f = s => { const e = document.querySelector(s); return e ? getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g,'') : '(absent)'; };
JSON.stringify({ wordmark: f('.wordmark .wm-title'), cardHeader: f('.card > summary'),
  metric: f('.metric .v'), screenerH1: f('.screen-head h1'), heroPitch: f('#hero p') });
```

Expected: every value is either `IBM Plex Mono` or `Newsreader`. Any `Chakra Petch` or `Schibsted Grotesk` means a usage was missed — fix before committing.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Split typography into instrument and document registers"
git push
```

---

### Task 3: Delete the legacy families

**Files:**
- Modify: `index.html:13` (fonts link), `index.html:16,18` (token declarations)

**Interfaces:**
- Consumes: Task 2's migration being complete
- Produces: a two-family stylesheet

- [ ] **Step 1: Confirm zero references remain**

```bash
grep -c "var(--sans)\|var(--display)" index.html
```

Expected: `0`. If not, return to Task 2 — do not proceed.

- [ ] **Step 2: Drop both families from the fonts link**

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap" rel="stylesheet">
```

- [ ] **Step 3: Delete the two token declarations**

Remove the `--sans:` line (16) and the `--display:` line (18) from `:root`. Leave `--mono` and `--doc`.

- [ ] **Step 4: Verify nothing fell back to a system font**

Reload, then repeat Task 2 Step 5's probe. Expected: identical output — only `IBM Plex Mono` and `Newsreader`. A `Georgia`, `Times`, or `system-ui` result means a rule referenced a now-deleted token.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Remove Chakra Petch and Schibsted Grotesk"
git push
```

---

### Task 4: Add color-role tokens to all six themes

Additive. Each role is declared alongside the existing token it aliases, so nothing changes visually.

**Files:**
- Modify: `index.html:29-99` — all six `:root[data-theme=...]` blocks

**Interfaces:**
- Consumes: nothing
- Produces: `--chrome-0`, `--chrome-1`, `--chrome-2`, `--rule`, `--ink`, `--ink-dim`, `--ink-bright`, `--up`, `--down`, `--warn`, `--up-soft`, `--down-soft`, `--warn-soft` in every theme — 13 roles, matching Step 1's code block exactly

- [ ] **Step 1: Append the role block to each of the six themes**

The collapse mapping, from the spec, is fixed: `--bg`/`--bg-deep` → `--chrome-0`; `--surface` → `--chrome-1`; `--surface-2`/`--surface-3` → `--chrome-2`; `--border`/`--border-soft` → `--rule`.

Add these six lines inside **every** `:root[data-theme=...]` block, before the closing brace:

```css
  --chrome-0: var(--bg); --chrome-1: var(--surface); --chrome-2: var(--surface-2);
  --rule: var(--border-soft);
  --ink: var(--text); --ink-dim: var(--text-dim); --ink-bright: var(--bright);
  --up: var(--green); --down: var(--red); --warn: var(--amber);
  --up-soft: var(--green-soft); --down-soft: var(--red-soft); --warn-soft: var(--amber-soft);
```

The three `-soft` tint roles exist because `--green-soft`, `--red-soft` and `--amber-soft`
have 12 live usages between them (signal backgrounds, level pills, tinted metrics). Without
these roles, Task 6's deletion would strip those backgrounds in every theme. They are tints
of the direction colors, not additional accents, so they do not violate the one-accent rule.

`--accent` already exists in every theme and keeps its name — it is already the single load-bearing accent.

- [ ] **Step 2: Verify all six themes define all ten roles**

```js
const root = document.documentElement, prev = root.dataset.theme;
const NAMES = ['--chrome-0','--chrome-1','--chrome-2','--rule','--ink','--ink-dim','--ink-bright','--accent','--up','--down','--warn','--up-soft','--down-soft','--warn-soft'];
const out = THEMES.map(t => { root.dataset.theme = t.id;
  const cs = getComputedStyle(root); const miss = NAMES.filter(n => !cs.getPropertyValue(n).trim());
  return `${t.id}: ${miss.length ? 'MISSING ' + miss.join(',') : 'complete'}`; });
root.dataset.theme = prev; out.join('\n');
```

Expected: six lines, all `complete`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add color-role tokens across all six themes"
git push
```

---

### Task 5: Migrate to role tokens and remove violet

**Files:**
- Modify: `index.html` — 19 `var(--surface-3)` usages, all border/text usages, 33 violet usages

**Interfaces:**
- Consumes: role tokens from Task 4
- Produces: a stylesheet with no `--violet` and no legacy neutral references

**Ordering matters.** Literals are written into the theme blocks *before* the sed runs, so no
commit ever contains a self-referential custom property. Do not reverse these two steps.

- [ ] **Step 1: Replace the Task 4 aliases with literal values, per theme**

In each of the six theme blocks, the role lines currently alias the legacy tokens
(`--chrome-0: var(--bg)`). Replace them with that theme's own literal values, read from the
legacy declarations a few lines above in the same block. For `dark`:

```css
  --chrome-0: #0a0e14; --chrome-1: #101723; --chrome-2: #18212f;
  --rule: #1a2535;
  --ink: #8c9db1; --ink-dim: #7a8ca1; --ink-bright: #eaf0f7;
  --up: #46c95d; --down: #f0716b; --warn: #e9b44c;
  --up-soft: rgba(70,201,93,.10); --down-soft: rgba(240,113,107,.10); --warn-soft: rgba(233,180,76,.10);
```

Repeat for `light`, `noir`, `paper`, `lagoon` and `matrix`, copying each theme's own hex and
rgba values. Do not invent values — every one already exists in the block being edited.

After this step the roles hold literals, so the sed in Step 2 cannot corrupt them: sed matches
`var(--legacy)` *usages*, and these are now declarations of literals.

- [ ] **Step 2: Migrate every usage to the role names**

Longest names first so prefixes cannot collide, and the `-soft` tints before their base colors:

```bash
sed -i 's/var(--surface-3)/var(--chrome-2)/g; s/var(--surface-2)/var(--chrome-2)/g; s/var(--surface)/var(--chrome-1)/g; s/var(--bg-deep)/var(--chrome-0)/g; s/var(--bg)/var(--chrome-0)/g; s/var(--border-soft)/var(--rule)/g; s/var(--border)/var(--rule)/g; s/var(--text-dim)/var(--ink-dim)/g; s/var(--text)/var(--ink)/g; s/var(--bright)/var(--ink-bright)/g; s/var(--green-soft)/var(--up-soft)/g; s/var(--red-soft)/var(--down-soft)/g; s/var(--amber-soft)/var(--warn-soft)/g; s/var(--green)/var(--up)/g; s/var(--red)/var(--down)/g; s/var(--amber)/var(--warn)/g' index.html
```

`--accent`, `--accent-ink` and `--accent-soft` keep their names and are deliberately absent
from this mapping.

- [ ] **Step 3: Replace violet**

Violet currently serves as an unofficial second accent across 33 usages: MySquall's icon and dot, recipe theme chips, Fibonacci level pills, screener chat role labels, and the mobile tab streaming dot.

Substitute by **role, not by hue** — do not introduce a replacement color:
- MySquall icon, dot, and configured state → `var(--accent)`
- Recipe theme chips → `var(--rule)` border with `var(--ink-bright)` text
- Fibonacci level pills → `var(--ink-dim)` text on `var(--chrome-2)`
- Chat role labels → `var(--ink-dim)`
- Streaming tab dot → `var(--accent)`

Then delete the `--violet` declaration from all six theme blocks.

- [ ] **Step 4: Verify no legacy or violet references survive**

```bash
grep -c "var(--violet)\|157,140,240\|var(--surface\|var(--border\|var(--bright)\|var(--text)" index.html
```

Expected: `0`.

- [ ] **Step 5: Run the contrast audit**

Run Harness B. Expected: six lines, every ratio ≥ 4.5. Any value below that must be fixed by adjusting that theme's `--ink*` literals before committing.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Migrate to color roles and remove the second accent"
git push
```

---

### Task 6: Delete legacy color tokens and retune Lagoon

**Files:**
- Modify: `index.html:29-99`

**Interfaces:**
- Consumes: Task 5's migration
- Produces: theme blocks declaring only role tokens

- [ ] **Step 1: Delete the legacy declarations**

From each of the six blocks, remove `--bg`, `--bg-deep`, `--surface`, `--surface-2`, `--surface-3`, `--border`, `--border-soft`, `--text`, `--text-dim`, `--bright`, `--green`, `--green-soft`, `--red`, `--red-soft`, `--amber`, `--amber-soft`.

Before deleting, confirm each is genuinely unreferenced — Task 5 migrated all of them,
including the three `-soft` tints, so `grep -c "var(--green-soft)\|var(--red-soft)\|var(--amber-soft)" index.html`
must print `0`. If it does not, Task 5 was incomplete; fix that first.

Keep `--accent`, `--accent-ink`, `--accent-soft`, `--chart-fill-top`, `--chart-fill-bot`, `--skeleton-shine`, `--shadow`, `color-scheme`, and the ten role tokens.

- [ ] **Step 2: Pull Lagoon's chrome toward neutral**

Lagoon is the only theme whose chrome carries strong hue, which fights the one-accent rule. Replace its chrome and rule values:

```css
:root[data-theme="lagoon"] {          /* turquoise + pink */
  --chrome-0: #0b1a1a; --chrome-1: #122525; --chrome-2: #1a3130;
  --rule: #1f3b3a;
  --ink: #a8c4c1; --ink-dim: #8fadaa; --ink-bright: #f0fffb;
```

The teal cast survives; the saturation does not. Terminal is the reference for how much hue chrome may carry.

- [ ] **Step 3: Confirm no orphan tokens**

```js
const root = document.documentElement, prev = root.dataset.theme;
const DEAD = ['--bg','--surface','--surface-2','--surface-3','--border','--border-soft','--text','--text-dim','--bright','--green','--green-soft','--red','--red-soft','--amber','--amber-soft','--violet'];
const out = THEMES.map(t => { root.dataset.theme = t.id; const cs = getComputedStyle(root);
  const alive = DEAD.filter(n => cs.getPropertyValue(n).trim());
  return `${t.id}: ${alive.length ? 'STILL SET ' + alive.join(',') : 'clean'}`; });
root.dataset.theme = prev; out.join('\n');
```

Expected: six lines, all `clean`.

- [ ] **Step 4: Re-run the contrast audit**

Harness B. Expected: six lines, all ratios ≥ 4.5, with Lagoon specifically re-checked since its chrome moved.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Delete legacy color tokens and neutralize Lagoon chrome"
git push
```

---

### Task 7: Convert metric tiles to tabular rows

The largest visual change. Nineteen cards at roughly eight tiles each currently produce a field of boxes; this replaces them with label/value rows aligned on a shared axis.

**Files:**
- Modify: `app.js:1098` (the `metric` helper)
- Modify: `index.html:615-621` (`.mgrid` / `.metric` rules)

**Interfaces:**
- Consumes: type scale from Task 1, role tokens from Task 4
- Produces: `metric(label, value, cls)` keeps its exact signature and all 12 call sites are unchanged — only its markup and CSS change

- [ ] **Step 1: Rewrite the helper**

`app.js:1098`. Signature and argument order are unchanged so no call site needs editing:

```js
const metric = (label, value, cls = "") => `<div class="metric"><span class="k">${label}</span><span class="v ${cls}">${value}</span></div>`;
```

- [ ] **Step 2: Replace the tile CSS with row CSS**

`index.html:615-621`:

```css
/* Rows, not tiles: values share a right-hand axis so a reader can compare down a
   column. Tiles made that impossible, which is the whole reason for the change. */
.mgrid { display: block; }
.metric { display: flex; align-items: baseline; gap: 10px; min-height: 22px; padding: 2px 0; }
.metric + .metric { border-top: 1px solid var(--rule); }
.metric .k { flex: 1; min-width: 0; font-size: var(--t-data); font-weight: 400; color: var(--ink-dim);
  text-transform: lowercase; letter-spacing: 0; }
.metric .v { flex-shrink: 0; font-family: var(--mono); font-size: var(--t-data); font-weight: 500;
  color: var(--ink-bright); font-variant-numeric: tabular-nums; text-align: right; }
.metric .v.green { color: var(--up); } .metric .v.red { color: var(--down); } .metric .v.amber { color: var(--warn); }
.metric .v small { font-size: var(--t-micro); color: var(--ink-dim); font-weight: 400; }
/* Narrow panes: the left pane drags to 360px, where a shared axis stops working. */
@media (max-width: 460px) { .metric { flex-direction: column; gap: 0; align-items: stretch; }
  .metric .v { text-align: left; } }
```

The `.metric:hover` lift is deleted — it was tile affordance and rows do not need it.

- [ ] **Step 3: Handle the pane-width case the media query cannot**

The left pane is resizable independently of viewport width, so a viewport media query does not catch a dragged-narrow pane. Add to `app.js` inside the existing resizer handler, which already writes `--left-w`:

```js
// Rows need a shared axis; below ~380px of pane there isn't room for one.
document.getElementById("dataPane")?.classList.toggle("stack-metrics", leftPx < 380);
```

And the matching rule in `index.html`:

```css
#dataPane.stack-metrics .metric { flex-direction: column; gap: 0; align-items: stretch; }
#dataPane.stack-metrics .metric .v { text-align: left; }
```

- [ ] **Step 4: Verify on a populated dashboard**

This needs real data, so push first and verify on `https://squall.up.railway.app`. Load any ticker, then:

```js
const rows = [...document.querySelectorAll('.metric')];
const vals = rows.slice(0,6).map(r => Math.round(r.querySelector('.v').getBoundingClientRect().right));
JSON.stringify({ count: rows.length, rightEdges: vals, aligned: new Set(vals).size === 1,
  tabular: getComputedStyle(rows[0].querySelector('.v')).fontVariantNumeric });
```

Expected: `aligned: true` (all values share one right edge) and `tabular` containing `tabular-nums`. If `aligned` is false the flex layout is wrong — values are not on a shared axis, which defeats the change.

- [ ] **Step 5: Drag the pane narrow and confirm the fallback**

Drag the resizer until the left pane is under 380px. Expected: metrics stack label-over-value, no horizontal overflow, no clipped values.

- [ ] **Step 6: Commit**

```bash
git add app.js index.html
git commit -m "Convert metric tiles to tabular rows on a shared axis"
git push
```

---

### Task 8: Reduce card chrome

**Files:**
- Modify: `index.html:585-610` (`.card`, `.card > summary`, `.sec-icon`)
- Modify: `app.js:1056` (`card()` helper), `app.js:1081` (the `I` icon map)

**Interfaces:**
- Consumes: role tokens
- Produces: `card(id, icon, title, bodyHtml, opts)` keeps its five-argument signature; the `icon` argument becomes ignored rather than removed, so the 19 call sites need no edits

- [ ] **Step 1: Stop rendering the icon**

`app.js:1056`. Keep the parameter so call sites are untouched, and say why in a comment:

```js
/* `icon` is accepted and ignored: an icon on every one of 19 section headers is
   decoration when the header already names the section. Kept in the signature so the
   call sites stay untouched; delete both together if the icons never come back. */
function card(id, _icon, title, bodyHtml, { open = true, count = null, source = null } = {}) {
```

Leave the `I` map in place for now — `sec-icon` is still used by the screener. Removing it is a separate cleanup, not this task.

- [ ] **Step 2: Flatten the card to a hairline section**

`index.html:585`:

```css
.card { background: none; border: 0; border-top: 1px solid var(--rule); border-radius: 0; box-shadow: none;
  margin-bottom: 0; overflow: hidden; transition: none; }
.card:first-of-type { border-top: 0; }
```

The `cardIn` entrance animation is removed here rather than in Task 9 because it lives on this rule.

- [ ] **Step 3: Verify the chrome is gone**

On a populated dashboard:

```js
const c = getComputedStyle(document.querySelector('.card'));
const s = document.querySelector('.card > summary');
JSON.stringify({ shadow: c.boxShadow, radius: c.borderRadius, animation: c.animationName,
  icons: document.querySelectorAll('.card > summary .sec-icon').length,
  headerCase: getComputedStyle(s).textTransform });
```

Expected: `shadow: "none"`, `radius: "0px"`, `animation: "none"`, `icons: 0`, `headerCase: "lowercase"`.

- [ ] **Step 4: Commit**

```bash
git add app.js index.html
git commit -m "Flatten cards to hairline sections and drop header icons"
git push
```

---

### Task 9: Cut motion that does not encode state

The rule: **motion encodes state, it never announces arrival.**

**Files:**
- Modify: `index.html:442-490` (screener motion block), `index.html:956-984` (hero and summary strip), `index.html:600` (`.src` badge)

**Interfaces:**
- Consumes: nothing
- Produces: a motion layer where every remaining animation maps to a state change

- [ ] **Step 1: Remove the announcement animations**

Delete these rules and their now-unused `@keyframes`:

| Rule | Keyframe to remove if unused |
|---|---|
| `#summaryStrip.show > *` and its six `nth-child` delays | — (`riseIn` still used) |
| `.recipe-chips > *` and its ten `nth-child` delays | `popIn` if no other user |
| `.card > summary .src` animation property | `themePop` stays (button feedback) |
| `.wordmark .wind path` idle gust | `gustIdle` |
| `#hero::before` drift | `dotDrift` |
| `#screenerView.show .screen-kicker` / `h1` / `p` / `#screenForm` | — |
| `.screen-results-head`, `.screen-refine`, `.screen-empty` | — |

Keep `.screen-result`'s scroll-reveal transition and `.sb-bar b` growth — both encode state.

- [ ] **Step 2: Confirm the survivors still work**

Load the screener, run a screen, and check:

```js
JSON.stringify({
  progressFill: !!document.querySelector('#screenProgressFill'),
  revealDeferred: document.querySelectorAll('.screen-result.screen-reveal').length,
  revealedIn: document.querySelectorAll('.screen-result.in').length,
  badgeAnim: getComputedStyle(document.querySelector('.card > summary .src') || document.body).animationName
});
```

Expected: `progressFill: true`; `revealDeferred` greater than zero on a full result set; `badgeAnim: "none"`.

- [ ] **Step 3: Confirm nothing is stuck invisible**

The scroll-reveal sets `opacity: 0` until an element intersects. If a deleted rule broke it, cards stay blank. Scroll the results and run:

```js
const view = document.getElementById('screenerView'), vr = view.getBoundingClientRect();
const inView = [...document.querySelectorAll('.screen-result')]
  .filter(c => { const r = c.getBoundingClientRect(); return r.bottom > vr.top && r.top < vr.bottom; });
JSON.stringify({ inView: inView.length,
  hidden: inView.filter(c => getComputedStyle(c).opacity < 0.9).length });
```

Expected: `hidden: 0`. Any other value is a regression — fix before committing.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Cut motion that announces arrival rather than encoding state"
git push
```

---

### Task 10: Full verification sweep

**Files:** none modified unless a defect is found.

**Interfaces:**
- Consumes: everything
- Produces: a recorded pass/fail across all six themes and three surfaces

- [ ] **Step 1: Token-orphan grep**

```bash
grep -n "font-family: *['\"]" index.html | grep -v "var(--" ; grep -cn "font-size: *[0-9]" index.html
```

Expected: no literal `font-family` outside the token block. A small number of literal `font-size` values is acceptable only inside `@media` overrides; anything else should move onto the scale.

- [ ] **Step 2: Contrast audit**

Run Harness B on the deployed site. Expected: six lines, every ratio ≥ 4.5.

- [ ] **Step 3: Screenshot every theme on three surfaces**

For each of the six themes, capture the hero, the screener with results, and a populated dashboard. Eighteen screenshots. Look specifically for:
- mono at `--t-micro` (10px) still legible in `paper` and `daylight`, where contrast is lowest — this is the flagged risk from the spec
- values aligned on their shared axis in every theme
- no element left invisible by the scroll-reveal

- [ ] **Step 4: Record the open question**

The spec deliberately deferred whether cards stay open by default. Now that rows have replaced tiles, measure it:

```js
JSON.stringify({ cards: document.querySelectorAll('.card').length,
  open: document.querySelectorAll('.card[open]').length,
  paneScrollHeight: document.getElementById('dataPane').scrollHeight,
  viewport: window.innerHeight });
```

Record the ratio of `paneScrollHeight` to `viewport` in the commit message. If the dashboard is still more than roughly six screens tall with everything open, collapsing the lower-value cards by default becomes a follow-up task — not part of this plan.

- [ ] **Step 5: Commit the verification record**

```bash
git commit --allow-empty -m "Verify precision-instrument UI across six themes

Contrast: all pairs >= 4.5 in every theme.
Metric axis alignment confirmed on populated dashboard.
Dashboard height with all cards open: <ratio> screens."
git push
```

---

## Self-Review

**Spec coverage.** §1 type tokens → Tasks 1–3. §1 color roles → Tasks 4–6. §2 register mapping → Task 2 Step 2. §3 density → Task 7. §3 card chrome and icons → Task 8. §4 palette discipline → Tasks 5–6. §5 motion budget → Task 9. §6 token-first migration → the additive ordering throughout. §7 verification → Harnesses A/B plus Task 10. §8 risk "mono at 10–12px" → Task 10 Step 3. §8 risk "tabular rows on narrow panes" → Task 7 Steps 3 and 5. §8 risk "removing violet" → Task 5 Step 3. §9 open question → Task 10 Step 4. No gaps.

**Placeholder scan.** No TBD/TODO. Every code step shows real code; every verification step shows a runnable probe and its expected output. The one deliberately deferred item (default-open cards) is measured rather than guessed, with an explicit threshold.

**Type consistency.** `metric(label, value, cls)` keeps its signature in Task 7 so its 12 call sites are untouched. `card(id, _icon, title, bodyHtml, opts)` keeps its arity in Task 8 so its 19 call sites are untouched. Role token names are identical in Tasks 4, 5, 6 and the harnesses. Harness B reads both legacy and role names via `||` so it works before and after Task 6.

**Known sharp edge.** Task 5 Step 1's `sed` deliberately corrupts the aliases added in Task 4, and Step 2 repairs them. This is called out in the step itself because a reviewer seeing Step 1 alone would reasonably reject it.

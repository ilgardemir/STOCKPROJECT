# Historical research replay v2

This supersedes the original forced-choice evaluator and its tuned exit policies.
The implementation is `replay-engine.js`; `/backtest-stream` uses only this policy.
Legacy functions in `server.js` remain for reproducing old offline experiments and
their tests, not as a fallback or selectable live mode. `SQUALL_BT_*` legacy exit
and review knobs do not affect v2.

## What is measured

A single retrospective research decision, under a fixed hypothetical execution
policy. It does not estimate forecast accuracy or prove an investment edge.
The model receives cutoff-filtered evidence, but its learned knowledge is not
time-limited. Cases are user-selected and may suffer survivorship and selection
bias. Current-vintage prices may have revised adjustments. Filing-date filters do
not make the provider a historical data archive.

## Commitment before outcomes

The user selects 21, 63 or 126 held sessions before submitting. The server creates
the immutable v2 policy and a run ID before fetching data or generating analysis.
All other settings are fixed assumptions: 25% initial exposure, 8% adverse-close
exit, 16% favorable-close exit, 10 bps per transaction, 3% annual short borrow.
These constants are not claimed to be optimal. MySquall does not change the policy.

The AI returns one explicit long, short or flat JSON decision in its response.
No separate extraction model changes the decision. Missing, malformed, duplicated,
interrupted or truncated decisions are unavailable, not flat and not a rules trade.
There are no forced directions, conviction multipliers, event-based size changes,
stop widening, trailing targets, tolerated breaches, or AI exit reviews.

## Accounting

- Entry: first available post-cutoff session open.
- Signal: each daily close relative to the entry price. This is explicitly a
  close-based strategy, not an intraday broker stop order.
- Exit: following session open after the first stop/target signal, or the open
  after the selected number of held sessions. Gaps are fully reflected in that
  price. A missing next open never becomes a last-close fill.
- Price basis: Yahoo split-adjusted, non-dividend-adjusted OHLC for both assets.
  Dividends are excluded from both long and short P&L; the resulting return is
  explicitly a price-return scenario, not total investor return.
- Costs: 10 bps of entry notional, plus 10 bps of exit notional. Short borrow:
  initial short notional × 3% × elapsed calendar days / 365. Borrow availability,
  recalls and actual rates are unknown; short results are hypothetical.
- Residual and post-exit cash earns zero. No taxes, margin calls or cash interest.
- Stock and SPY benchmarks have identical initial exposure and transaction-cost
  assumptions and remain invested for the chosen observation horizon. Excess vs
  SPY is an arithmetic comparison, not risk-adjusted alpha.
- Daily drawdown includes entry costs, marked prices, accrued borrow and the exit
  fill. It is not intraday drawdown.
- An incomplete horizon has no completed benchmark return. A completed early
  trade can report its realized return, with the observation still incomplete.
  Open positions report marked P&L separately from completed trade P&L.

The additional 1/3/6-month market-context cards use the pre-existing adjusted-return
series and are labeled separately; they must not be confused with v2 accounting.

## Audit and validation

Download audit JSON after the outcome reveal. It contains the locked policy,
model identifier/configuration, exact messages, snapshot, snapshot/input hashes,
answer, parsed decision, future bars, and deterministic simulation.
Recompute without network or an AI call:

    node scripts/replay-audit.js path/to/downloaded-run.json

The hashes detect accidental changes, not malicious rewriting of the whole file;
there is no server-signed attestation or permanent server record. Save the export.
Repeated cases or changes to policy are exploratory development data. Evaluating
predictive skill requires a separate preregistered prospective study: freeze model,
policy and universe before observing returns, retain every attempted decision and
failure, and evaluate a sufficiently large untouched sample with uncertainty and
appropriate benchmarks. This replay does not claim to implement that study.

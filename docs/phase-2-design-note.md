# Phase 2 Design Note

## Status

Draft, first written 5 June 2026 as the formalisation of the Phase 2 design conversation begun 1 June 2026. Not an ADR — this is the design exploration that precedes the Phase 2 strategy ADR. When that ADR is written it will compress this note into a decision record and supersede it.

## Purpose

Phase 2 sits between Phase 1 (passive observation — see [phase-1-findings.md](phase-1-findings.md)) and Phase 3 (real trading with real capital). Its job is to answer one question with enough confidence to risk capital: **would the bot's strategy have made money?**

Answering that requires three things Phase 1 does not have:

1. A defined candidate strategy — entry filter, position sizing, exit policy.
2. A way to compute would-be profit and loss — either retrospectively on the ~32,400 tokens already collected, or prospectively in real-time on new launches.
3. Honest cost accounting — entry slippage on the bonding curve, exit slippage on the post-graduation pool, network fees.

Phase 2 ends when a P&L number exists across enough trades to trust, with documented assumptions and known failure modes. Until that number exists with that confidence, real trading is premature.

## What we know going in

The Phase 1 findings doc records the evidence in detail. The facts that shape Phase 2's design:

- Top-holder concentration is the strongest single signal observed — a 16.5-percentage-point gap between graduates and timeouts; the 30–50% band has roughly 1-in-32 odds against a baseline of 1-in-200.
- The RugCheck normalised score has weak discriminative power on its own (3.3 points).
- Winners are over-represented among coins for which RugCheck had no data at decision time — the blind-data hypothesis. Phase 2 should require positive evidence, not the absence of red flags.
- Catchable graduations cluster in the 2–30 minute window. There are 102 catchable winners over the first 12 days of observation. The 0–30 second cluster is unreachable and probably orchestrated.
- Graduation is not profit. Coins can graduate and immediately crash. This is the gap Phase 2 has to close.

## The problem, restated

Phase 2's job is to construct *the smallest credible thing that produces a P&L number*, then improve it. Both halves of that statement matter equally. "Smallest" means we resist building feature libraries, infrastructure layers, or harnesses until we have an EV number to motivate them. "Credible" means the P&L number has to account for survivorship bias, lookahead leak, slippage, and selection effects — failures the design block below addresses.

## Three alternative shapes

To stay honest about the design space, three distinct shapes are worth considering. They differ along the axis of *what work is done first*.

### Shape A — Validate existing signal first

Define a candidate strategy from Phase 1's findings: top-holder ≤50%, blind-data guard requiring populated `topHolders`, possibly a score floor. Build the smallest possible backtest that replays the collected tokens through the strategy and computes whether the filter would have selected the catchable winners, at what false-positive cost. Acknowledge the post-graduation P&L gap explicitly; address it as a second step only if the filter analysis says the strategy is worth pursuing.

*Pros.* Smallest scope. Leverages what we already have. Produces a "would this filter even work?" answer in days, not weeks. Defers expensive work — paper-trading harness, post-graduation price data — until there is signal that justifies the cost.

*Cons.* Does not immediately tell us whether the strategy makes *money*, only whether the filter *selects winners*. The gap between "winners selected" and "money made" still has to be closed before Phase 3.

### Shape B — Build feature library first

Compute every plausible feature against the historical dataset before committing to a strategy. Top-holder share, score, wallet diversity, time-clustering, creator-trade flag, holder-growth rate, raw trade velocity. Identify which features carry signal, then synthesise a strategy from the strongest combination.

*Pros.* Lets the data pick the strategy rather than us picking it from Phase 1's two-feature view. More information at the design table.

*Cons.* Substantially more upfront work without a P&L signal to motivate which features are worth the effort. Risks building a feature library that gets used once and discarded. Conflicts with Principle Three (resist overengineering) — adding complexity before there is a present problem that requires it.

### Shape C — Build paper-trading harness first

Treat the harness as the foundational infrastructure. Build it now, in shadow mode against live launches. The strategy starts simple — Phase 1's findings, lightly calibrated. Features are added incrementally as paper-trade volume reveals where the strategy fails.

*Pros.* Produces a real-time P&L stream from day one. Forces honest engagement with operational concerns — latency, slippage, exit timing — that pure backtest work hides.

*Cons.* Heaviest infrastructure cost. Paper-trade volume accumulates slowly (a few entries per day at most), so the EV number stays noisy for weeks. Defers the underlying question of whether the signal is strong enough to be worth the harness at all.

### Recommended shape

**Shape A**, with the explicit understanding that Phase 2 has a successor step — Shape C in spirit — once the filter analysis says the strategy is worth deploying.

The justification is the project's resist-overengineering principle. Shapes B and C add infrastructure cost before there is a present problem that requires them. Shape A spends one to two analytical sessions computing whether the filter we already think might work would have produced a useful selection over the collected coins. If the answer is yes, Shape C is the obvious next move and the work is justified. If the answer is no, the failure tells us what features need to be added — which is Shape B's work, but now motivated rather than speculative.

## Minimum-coupling check

For Shape A, the narrowest contract Phase 2 actually needs:

- *Inputs.* The existing `tracked_tokens` and `lifecycle_events` tables. The latter contains the RugCheck snapshot JSON. Nothing new on the data side.
- *Outputs.* A written analysis — extending or paralleling the findings doc — showing what fraction of catchable winners the candidate filter selects, and at what cost in false positives.
- *Code.* A single analysis script or SQL, not a module. No new module boundaries. No new event types. No infrastructure changes.

What is explicitly *not* needed at this stage: paper-trading harness, post-graduation price tracking, real-time event hooks, persistence schema changes, new strategy module. The most expensive thing Phase 2-Shape-A produces is *knowledge*, not code. That is the right ratio for this stage.

## Failure modes

Five failure modes the design has to account for:

**Survivorship bias.** Phase 1's findings compared "graduated" against "timed out." The most relevant comparison for trading is "graduated and held value" against "graduated and crashed immediately." This comparison cannot be made from collected data alone. Shape A produces filter accuracy *on the graduation outcome*; it does not produce trading P&L. The note recording this gap honestly is part of the deliverable.

**Lookahead leak.** Any feature computed using data from *after* the moment the bot would have decided is contaminated. The RugCheck snapshot is taken at a defined moment. Any other feature added must be similarly stamped. The analysis must use only data available at decision time, not the eventual outcome.

**Slippage underestimation.** Pump.fun's bonding curve is published and deterministic. The slippage on a hypothetical buy can be computed exactly given the curve state at decision time. The analysis must include this cost; it cannot use "displayed price at entry minus displayed price at exit" as a proxy for P&L.

**Selection effect on data collection.** The data-collection strategy (ADR-007) recorded a decision for every coin but traded against none of them. Its filter did not bias which coins were tracked. Phase 2 backtest should run against the full population of tracked coins, not just those the data-collection strategy would have entered. The strategy's job was labelling, not selecting the analyzable population.

**Regime change.** Pump.fun behaviour shifts week to week. A backtest on May data may not predict June behaviour. The standard mitigation is a train/test split by time — fit thresholds on the first eight days, validate against the last four. This requires sample sizes large enough to support the split, which on 102 catchable winners is marginal. The analysis should run the split and report whether the result survives.

## Cost profile

Phase 2 work is offline analysis. The relevant cost is *researcher time*, not compute. Build for clarity over performance. The 2.3M-row `trade_events` table is large enough that careless SQL is slow but well-indexed enough that careful SQL is fast. Cost discipline at this stage means: write each query thoughtfully, read the result before writing the next one, and resist the urge to systematise — a `queries/` directory, a parameterised analysis framework — until at least three queries share enough structure to justify it.

## Adversarial review

Three things a paranoid reviewer would flag, recorded so they are not forgotten:

1. **Threshold overfitting.** If the analysis lands on top-holder ≤50% by reading the bucket table from the findings doc, the threshold is fit on the same data it is being evaluated against. The mitigation is the train/test split mentioned above, plus reporting confidence intervals on any selected threshold rather than a point estimate.

2. **Filter chains and sample size.** If the candidate strategy combines top-holder filter, blind-data guard, and score floor, the intersection of three filters can produce very few entries. A strategy that selects three coins out of 32,000 has high precision but no statistical power; the resulting numbers are dominated by noise. The analysis must report sample size at every cut, and refuse to draw conclusions from samples below a documented threshold (somewhere around 30 selected coins minimum, subject to confidence interval analysis).

3. **The missing post-graduation price.** Even after Shape A is done, the question of "what happened to the price after graduation" is unanswered. Phase 2 cannot end without that data being acquired from somewhere — Birdeye, Dexscreener, direct on-chain Raydium pool reads, or an extended bot tracking window. The decision of where post-graduation price data comes from is itself a Phase 2 decision that needs its own evaluation.

## Ground-truth verification

Assumptions made in this note that need verification before they harden into code:

- **Pump.fun's bonding curve formula** — publicly documented; should be re-read and the exact slippage function transcribed before any P&L number is computed.
- **The 32k tokens with RugCheck payload data remain queryable** — handoff confirms; sanity-check by counting non-null payloads before serious analysis.
- **Post-graduation price data is obtainable** for May/early-June graduated coins — *not yet verified*. May require API calls to Birdeye/Dexscreener for the 175 graduated mints; capacity, rate limits, and historical depth all unknown until checked.
- **ADR-007's labelling-vs-trading distinction** is correctly understood here — the data-collection strategy recorded decisions but did not act on them — *worth re-reading against this note's claims before backtest design is finalised.*

## Open questions

Decisions the operator owns, listed before Phase 2 work starts in earnest:

1. **Is Shape A the right starting shape**, or is there a reason — operational, learning-curve, time-budget — to prefer B or C?
2. **Where does post-graduation price data come from** when Shape A's next step needs it? The decision affects whether Phase 2 spans weeks or months.
3. **What is the trade-sizing assumption** Phase 2 uses for paper P&L — a fixed SOL amount per trade, a fixed fraction of a notional bankroll, something else? The practical-books synthesis pointed at "fixed per-trade risk" as discipline; the exact number is a Phase 3 decision but Phase 2 must make a placeholder choice to compute P&L.
4. **What is the exit policy** assumed for paper P&L — sell at graduation, sell at 2× entry, sell after N minutes, trailing stop? Different choices produce very different EV numbers and are not interchangeable.

## Related documents

- [phase-1-findings.md](phase-1-findings.md) — the evidence this note builds on.
- ADR-005 — Data Store and Persistence (defines the schema Phase 2 reads).
- ADR-006 — Enrichment Readiness Signal (defines when RugCheck data is fetched, relevant to the blind-data guard).
- ADR-007 — Strategy Decision Shape (defines the labelling-vs-trading distinction that affects the Phase 2 backtest population).
- Future ADR — Phase 2 strategy (to be written; this design note becomes its evidence).
- Future ADR — Phase 3 sizing rules (informed by the practical-books synthesis recorded in the External Precedent section of [phase-1-findings.md](phase-1-findings.md)).

# Phase 2 Design Note

## Status

Draft, first written 5 June 2026 as the formalisation of the Phase 2 design conversation begun 1 June 2026. Updated the same day with the resolved decisions, captured in the new Decisions, Operator psychology, and Deferred to future phases sections below. The seven-item design block in the body remains the analysis that produced the decisions; the new sections record the conclusions. Not an ADR — this is the design exploration that precedes the Phase 2 strategy ADR. When that ADR is written it will compress this note into a decision record and supersede it.

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

Shape A was confirmed on 5 June 2026 in the conversation that produced this update; see the Decisions section below for the specific strategy this shape now commits to.

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

## Decisions

The four open questions raised by the design block above were resolved on 5 June 2026 in a conversation grounded in two rounds of research: the trading-book synthesis recorded in the External Precedent section of [phase-1-findings.md](phase-1-findings.md), and a fresh search for current best practice on exit rules, position sizing, and discretionary intervention. The decisions below are the conclusions; the design block above remains the reasoning.

**Starting shape — Shape A confirmed.** The asymmetric-returns framework — many small losses, occasional medium wins, rare large wins, positive expectation in aggregate — is the strategy direction. The relevant tradeoff (roughly 60% losing trades is expected and irreducible in memecoin markets) is acknowledged and addressed in the Operator psychology section below.

**Post-graduation price data — extend the bot to track PumpSwap pools directly via the existing Helius RPC.** No new external data provider, no new API key, zero additional service cost. This contradicts older project documentation that assumes Raydium as the graduation destination; the platform changed in early 2025 when Pump.fun launched their own AMM (PumpSwap), and a separate documentation pass is required to correct Raydium → PumpSwap references across the architecture and ADRs. The 175 already-graduated coins from the first 12 days are written off as historical loss; post-graduation coverage begins prospectively with the next graduates.

**Trade-sizing assumption — 0.1 SOL per paper trade.** Placeholder only, sufficient for Phase 2 P&L math. The real sizing decision belongs to a future Phase 3 ADR informed by measured edge. The professional standard (fractional Kelly, typically 25–50% of full Kelly) requires at least 50–100 completed trades to estimate the parameters with any confidence, which is exactly what Phase 2 produces.

**Exit policy — three-rule exit.** Scale out 50% of the position at 2× entry; this recovers capital and a small profit and removes the trade's downside. Apply a 35% trailing stop to the remaining 50% (price drops 35% from its highest level since entry → exit). Enforce a 4-hour hard backstop, almost never the active exit, protecting only against holding coins whose price has gone flat. A binary kill switch via the Telegram bot (`/pause`, `/resume`) is the only form of manual override. Per-trade discretionary intervention is explicitly out of scope; the research consensus is that it reduces returns, and including it would make the strategy's performance impossible to evaluate independently of operator skill.

The late-bloomer concern — coins that fail in the 30-minute window but recover days or weeks later because of social signal — was raised during the conversation and set out of scope. Capturing late bloomers requires a fundamentally different architecture (long-term watchlist, social-signal trigger, re-evaluation logic) and would distort the strategy chosen here if wedged in. Recorded under Deferred to future phases below.

## Operator psychology

Phase 2 paper trading has two purposes that the design must hold simultaneously. The first is to measure the strategy's performance — does the exit rule produce positive expected value across enough trades to trust. The second, and equal in importance, is to measure the operator's ability to follow the strategy without intervention.

The research consensus across academic and industry sources converges on a single uncomfortable finding: most retail traders lose money over a twelve-month window even when their strategies are mathematically sound, because they cannot follow their own rules. Discretionary intervention on individual trades typically reduces returns, sometimes catastrophically. The failure modes are consistent: traders override the system on losers (compounding the losses), reduce position size after losing streaks (missing the next winner), take profits early on winners because they do not want to give them back, and stop trading after drawdowns. Each behaviour individually feels rational; each is documented to reduce long-run returns.

The strategy committed to above expects roughly 60% losing trades. This is not a tunable parameter; it is a property of memecoin markets and of the asymmetric-returns framework. The operator's psychological reaction to that loss rate is therefore the single highest-leverage variable in whether Phase 3 succeeds — ahead of any code, any threshold, and any feature.

Three pre-commitment rules, recorded here before any paper trade has been taken, to be measured against during Phase 2:

1. **Override budget: zero per-trade overrides.** The kill switch is reserved for systemic events (network outage, suspected exploit, widespread regime shift), never for individual trade decisions. If during Phase 2 paper trading the operator finds themselves wanting to intervene on individual trades, that desire is the data point — not a signal that the rule is wrong.
2. **Rule-change budget: one strategy change per month maximum.** Constantly tuning the exit rule in response to recent trades is the same failure mode as discretionary intervention, in slower form. A change to the strategy requires a written rationale tied to a sample of completed trades large enough to support the conclusion (rough threshold: 30 completed trades since the previous change, subject to confidence-interval analysis).
3. **Sleep test: paper drawdowns should not cause sleep loss.** If they do, the planned Phase 3 position size is too large for the operator's psychology, regardless of what the expected-value math says. Reduce size, not strategy.

Operator journal: a private text file outside the repository, recording emotional state and the temptation to intervene across the Phase 2 paper-trading period. The repository contains the strategy; the journal contains the operator's relationship to it. Both are needed for an honest Phase 3 readiness assessment.

Phase 3 entry criteria: the strategy and the operator both pass. If either fails — strategy P&L is not credibly positive, override count exceeds zero, rule changes exceed budget, or the sleep test fails — Phase 3 does not begin at the planned size, and may not begin at all. The bot retains value as an observation system regardless of whether real trades follow.

## Deferred to future phases

Three items raised during Phase 2 design that are real and worth recording, but are not Phase 2's job:

- **Late-bloomer capture.** A separate strategy module that maintains a long-term watchlist of coins that failed the initial 30-minute window, re-evaluating them when social signal (Twitter, Telegram, on-chain activity) suggests a recovery is forming. Different architecture, different strategy, future bot.
- **Operations dashboard.** Centralised view of paper trades, real trades, P&L, position sizing, win/loss distribution, and operator-journal pointers. Currently the analytical reads against the database are ad-hoc SQL via SSH; a dashboard becomes valuable once trade volume grows or when external accountability matters. Future ADR.
- **Real position-sizing rules.** The 0.1 SOL Phase 2 placeholder is not a final sizing decision. Real sizing — fractional Kelly with measured edge, fixed risk-per-trade rules, daily drawdown caps — becomes a Phase 3 ADR once at least 50–100 paper trades exist to estimate the parameters from.

## Related documents

- [phase-1-findings.md](phase-1-findings.md) — the evidence this note builds on.
- ADR-005 — Data Store and Persistence (defines the schema Phase 2 reads).
- ADR-006 — Enrichment Readiness Signal (defines when RugCheck data is fetched, relevant to the blind-data guard).
- ADR-007 — Strategy Decision Shape (defines the labelling-vs-trading distinction that affects the Phase 2 backtest population).
- Future doc pass — Raydium → PumpSwap correction across the architecture and ADRs that predate the early-2025 platform change.
- Future ADR — Phase 2 strategy (to be written; this design note becomes its evidence).
- Future ADR — Phase 3 position-sizing rules (informed by the practical-books synthesis recorded in the External Precedent section of [phase-1-findings.md](phase-1-findings.md) and the fractional-Kelly research cited in the Decisions section above).
- Future ADR — Operations dashboard (deferred; see Deferred to future phases).
- Future bot — Late-bloomer capture strategy (deferred; see Deferred to future phases).

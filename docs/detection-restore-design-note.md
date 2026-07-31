# Detection Restore — Design Note

## Status

Draft, 31 July 2026. Written after detection was found dead for two months (expired Helius plan + the 1 May 2026 WebSocket-metering change) and while restoring it on branch `feat/pumpportal-detection`. This note records a finding that changes the restore approach, and surfaces a fork whose resolution belongs to the operator. Not an ADR; if the free re-architecture (Shape 2 below) is chosen, it will need a superseding ADR against ADR-006.

## The finding: the firehose is load-bearing for four roles, not one

The Helius `logsSubscribe mentions=[pumpfun]` firehose (`rawProgramLogReceived`) is not just "the detection feed." Reading `main.ts` and `wireActivityTracker.ts`, it feeds four things:

1. **Detection** — `wireDetection` extracts create events.
2. **Trades** — `wireActivityTracker.onRawLog` extracts every buy/sell.
3. **Graduation** — the same handler catches the bonding-curve "complete" event and calls `closeTracking(state, 'graduated')` (`wireActivityTracker.ts:206`). Graduations are detected here and nowhere else.
4. **Enrichment trigger** — RugCheck enrichment fires on the first `TokenTradeObserved` (ADR-006), which is produced by role 2.

PumpPortal's free `subscribeNewToken` replaces **only role 1.** Dropping the firehose — the entire point of going free — therefore breaks enrichment (no first-trade → no RugCheck call → no top-holder data) and graduation detection (no "complete" → every token times out). Both are fatal to the goal, which is out-of-sample validation of the 30–45% top-holder filter: without top-holder data there is nothing to filter on, and without graduation there are no positive outcomes to measure.

## Why the enrichment trigger is the hard part

ADR-006 is emphatic and evidence-backed. RugCheck returns HTTP 400 for freshly-launched mints at t=0; about 60% become queryable within 0.5–2s of the first observable trade, and **about 40% take 1–5 minutes.** ADR-006 chose the first-trade trigger precisely because "a trade existing on-chain is the same precondition for RugCheck's indexer having data," and it explicitly rejected — with reasons — detection-fires-immediately, timer-based retry, a detection+retry loop, and background polling. Its load-bearing principle: *use the bus's own readiness signal rather than a wall-clock timer.*

That readiness signal is the trade. The trade comes from the firehose. Remove the firehose and the readiness signal is gone, leaving only the options ADR-006 already rejected.

## The tension: there is no free lunch

Every way to restore a readiness signal (and graduation) costs something:

| Approach | Ongoing cost | Architectural cost |
|---|---|---|
| Keep the Helius firehose (current design) | Helius **$49+/mo** (metered WSS) | none — ADR-006 intact |
| PumpPortal `subscribeTokenTrade` for trades | metered ~$100+/mo at Pump.fun volumes (over the ~$10 budget) | small |
| Detection-triggered RugCheck retry | RugCheck quota — heavy, esp. the ~40% of mints that take 1–5 min to index | **reverses ADR-006's core decision and its no-timer principle** |

So "free" (PumpPortal `subscribeNewToken`) cheaply fixes detection alone. Making the *pipeline* work without the firehose requires either paying for trades (over budget) or a detection-triggered retry that is both quota-heavy and a reversal of a deliberate, well-argued ADR. "Free end-to-end" is not cheap; it is a significant re-architecture with hidden costs.

## Three shapes

They differ along the axis of *what we spend to unblock validation.*

### Shape 1 — Time-boxed paid firehose (recommended)

Pay for the Helius Developer plan (~$49) for **one month**. Zero re-architecture: the existing pipeline (detection + trades + graduation + enrichment) works unchanged the moment credits are restored. Out-of-sample data flows immediately. After the month, run the OOS validation. If the 30–45% filter holds, the strategy has *earned* the free re-architecture (or, more likely, earned the right to keep paying out of trading proceeds). If it does not hold, we have spent one month's fee instead of building infrastructure for a strategy that does not work.

*Pros.* Fastest to the actual goal. Zero new architecture, zero ADR reversal, zero new failure modes. Directly applies the project's own "defer expensive work until a signal justifies it" principle (the same logic that chose Shape A for Phase 2). The PumpPortal parser + driver already built are not wasted — they are Shape 2, ready if it is ever justified.

*Cons.* Costs $49 for one month. The operator has expressed budget sensitivity (ceiling ~$10/mo, free-first) — though that was a preference against *ongoing* $49 for an unvalidated bot, expressed before this finding revealed that "free" means reversing an ADR and building two new sources plus an enrichment redesign.

### Shape 2 — Free re-architecture now

Replace the firehose's roles with free sources: `subscribeNewToken` for detection (done), `subscribeMigration` for graduation, detection-triggered RugCheck enrichment with a readiness strategy (superseding ADR-006), the existing 30-min timer for timeout, and drop per-trade stats. $0/mo ongoing.

*Pros.* No recurring cost if the strategy is kept running long-term.

*Cons.* Significant engineering for an *unvalidated* strategy. Reverses ADR-006 and its no-timer principle (needs a superseding ADR). Not actually free: the detection-triggered retry burns RugCheck quota, heaviest on exactly the 40% of mints that are slowest to index. Introduces new failure modes (readiness strategy, second WebSocket source) right before the validation that is supposed to be measuring the *strategy*, not the plumbing.

### Shape 3 — Free detection + paid trades

`subscribeNewToken` (free) + `subscribeTokenTrade` (metered) to keep ADR-006's trigger intact. Rejected: it pays anyway (~$100+/mo, over budget) *and* adds a source — worse than Shape 1 on cost and worse than Shape 2 on architecture.

## Recommendation

**Shape 1.** Phase 2 exists to answer whether the strategy makes money before we invest in it. Building a free re-architecture — reversing a deliberate ADR, adding a readiness strategy and a second feed — is exactly the expensive infrastructure the Phase 2 design note says to defer until a signal justifies it. A one-month paid firehose buys the validation data immediately, keeps the architecture honest, and lets the *result* decide whether the free re-architecture is ever worth building. The already-built parser and driver sit ready for that day.

If the operator prefers Shape 2 regardless (a firm free-only constraint), the plan is: build the `subscribeMigration` source, write the superseding ADR for detection-triggered enrichment, and — first — measure the readiness cost (below).

## Ground-truth verification (required before Shape 2)

ADR-006's own scripts are the instrument: `scripts/investigate-rugcheck-trade-correlation.ts` measures how long after a fresh mint RugCheck becomes queryable. Before committing to a detection-triggered retry, re-run it against PumpPortal-detected mints to size the retry cost, and check RugCheck's current rate limits against Pump.fun's ~26k-launches/day rate. If the retry volume exceeds RugCheck's free limits, Shape 2 is not free either.

## Relationship to ADR-006

Shape 1 leaves ADR-006 fully intact. Shape 2 supersedes its Decision (the trade-trigger) and must be recorded as a new ADR that references ADR-006 and this note, re-justifying the reversal on the changed cost structure — not by editing ADR-006.

## Related documents

- ADR-006 — Enrichment Readiness Signal (the decision Shape 2 would supersede).
- `docs/phase-2-design-note.md` — the "defer expensive work until justified" logic this recommendation applies.
- `next_session_handoff.md` — the detection-restore state and the four-role firehose finding.

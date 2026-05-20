# ADR 007: Strategy Decision Shape

## Status

Accepted, 20 May 2026. Recorded the same day PR #21 merged the data-collection strategy module, while the design reasoning was still fresh. After any code begins depending on this ADR, future changes will be handled by superseding ADRs rather than by editing this document, in keeping with the convention that accepted ADRs preserve their historical record.

## Context

Phase 1 of the bot ships with one strategy: a data-collection strategy whose purpose is to label every observed token with a `Pass` / `Watch` / `Enter` verdict and record that verdict for later analysis. The verdicts do not drive any execution layer in Phase 1 — they are the data product Phase 1 exists to produce.

The architecture document Part Six prescribed the three-variant discriminated union (`Pass | Watch | Enter`) as the structural shape, but left the per-variant details open. When PR #21 implemented the first strategy, two specific design choices had to be made that the architecture did not constrain: where the threshold *parameters* live in the decision record, and how the *reasons* attached to Pass and Watch are modelled.

The first instinct on both questions was to put rich data on each reason variant. A `top_holder_excessive` reason would carry both the value that triggered it (`topHolderPercent`) and the threshold it was compared against (`threshold`). A `score_too_risky` reason would carry the score and its threshold. This is the obvious-default extension of the discriminated-union pattern: each variant carrying exactly the data it needs.

External research into how mature production systems record decisions surfaced a consistent pattern that ran counter to the obvious-default. Quantitative trading systems, ML feature stores, and policy engines (Open Policy Agent) all converge on the same structure: a decision record carries the full input feature snapshot, the parameter set that was applied to it, and the verdict — with reasons being a denormalisation for query convenience rather than the primary structure. AWS, Microsoft, Spotify, and the broader ADR literature also emphasise capturing decisions *while reasoning is fresh*, which is why this ADR is written today rather than retrospectively.

The reframe under that pattern: thresholds belong on the wrapper as a single snapshot per decision, not duplicated into each reason variant. The values that triggered reasons are already in the candidate's enrichment snapshot — they don't need to be carried again on reasons. Reasons become bare codes that say which rule fired; analytical queries derive the rest from inputs + parameters.

This ADR captures the shape that resulted, the invariants the rest of the system now depends on, and the alternatives that were rejected, so Phase 2 strategies either follow the shape or supersede it explicitly.

## Decision

A strategy evaluation produces a `StrategyEvaluationResult` value with five fields: a `strategyId` string-literal identifying which strategy produced the verdict, a `candidate` that is the full `TokenWithFullContext` the strategy evaluated, a `thresholds` snapshot capturing the parameters that produced the verdict, a `decision` carrying the verdict and its reasons, and an `evaluatedAt` timestamp.

The `decision` field is a discriminated union with three variants, discriminated on a `kind` field consistent with the project's existing convention. A `pass` variant carries a non-empty array of `PassReasonCode` values. A `watch` variant carries a non-empty array of `WatchReasonCode` values. An `enter` variant carries no additional fields in Phase 1; Phase 2 strategies will extend it with position size and exit rules.

The `thresholds` snapshot is a flat record of named numeric thresholds — for the data-collection strategy: an `enterMaxScoreNormalised`, an `enterMaxTopHolderPercent`, a `watchMaxScoreNormalised`, and a `watchMaxTopHolderPercent`. Other strategies that need a different parameter set declare their own `ThresholdsSnapshot` shape; the wrapper accepts any object satisfying the per-strategy threshold contract. Thresholds are recorded once per decision on the wrapper. They never appear inside individual reason variants.

Reason codes are bare string literals belonging to a per-variant union (`PassReasonCode` and `WatchReasonCode`). A reason code says only *which rule fired*. The value that triggered the rule and the threshold it was compared against are not on the reason; they are derivable from `candidate.rugcheck.value` and the wrapper's `thresholds`. Reason names are direction-explicit (for example `score_too_risky` rather than `score_above_threshold`) so analytical queries do not require the reader to know the score's direction.

Multi-reason collection is required for Pass and Watch. When a token fails multiple hard checks, every failed reason appears in the `pass` variant's reasons array, in a deterministic order matching the order rules were evaluated. The same applies to Watch when both soft thresholds are in the borderline range. The non-empty invariant is encoded at the type level as a tuple `readonly [ReasonCode, ...ReasonCode[]]`.

Every detected token produces exactly one `StrategyDecisionRecorded` event over the candidate's lifetime. Multiple strategies running in parallel each publish their own event; this invariant applies per-strategy-per-token, not globally. The invariant is what lets the strategy layer be assumed to always produce a decision the data store and downstream analytics can join against.

The evaluator function is pure: `(candidate, thresholds) => StrategyDecision`. It does not assemble the wrapper, take a clock, or know about the bus. The wire layer assembles the wrapper with `strategyId`, `evaluatedAt`, and the same `thresholds` it passed to the evaluator. Pure-function evaluation makes the strategy trivially testable against constructed candidates.

The Phase 1 data-collection strategy applies a two-stage filter inside the evaluator. Hard exclusions are checked first; any token that fails one or more hard exclusions becomes a Pass with every failed reason recorded. Tokens that survive the hard exclusions are evaluated against tighter Enter cutoffs and either become Enter (if both fit) or Watch (if either is borderline). The two-stage pattern matches the industry-standard token-screening shape — exclusions before signal — but is a property of this particular strategy, not a binding rule on future strategies.

## Consequences

Each fact in the decision record appears in exactly one place. The input value of `scoreNormalised` lives on the candidate. The threshold it was compared against lives in the wrapper's `thresholds`. Whether the rule fired lives in the decision's reasons. Analytical SQL queries that join across these axes do not have to reconcile competing copies of the same number.

Backtesting different threshold values against historical decisions becomes a SQL exercise rather than a code change. Because the candidate's full feature snapshot is preserved on every decision row, a query of the form *"if `enterMaxScoreNormalised` had been 25 instead of 30, how many tokens we marked Watch would have been Enter?"* runs entirely against the stored data with no need to replay events or rerun the evaluator.

Adding a new reason code is a one-line change to the relevant union (`PassReasonCode` or `WatchReasonCode`). It does not require a new type, a schema migration, or any change to consumers that don't filter by the new code. Removing a reason code is non-trivial because old persisted decisions still reference it — removals should be handled via a superseding ADR, not direct deletion.

The non-empty-tuple invariant on Pass and Watch reasons is enforced at the type level, but TypeScript cannot statically prove that a runtime array satisfies the tuple type. The evaluator uses an `as` cast immediately after a length check that establishes the property by other means. This is the idiomatic TypeScript pattern for narrowing an unknown-length array to a non-empty tuple, and it is provably safe at every site in the codebase. A future contributor who casts without a preceding length check breaks the invariant; tests must defend it.

The one-event-per-detected-token invariant is load-bearing. The strategy layer is designed against it, the EventStore's `recordStrategyDecision` assumes it, and the data store's `tracked_tokens` projection updates `last_event_seq` on every decision write. A future change that breaks this invariant — for example, a strategy that publishes multiple decisions per candidate, or one that silently drops decisions in some condition — silently corrupts downstream analysis without raising any obvious error. Reviewers should treat any change to the strategy publication path as a change to a documented architectural promise.

The discriminated-union pattern with the `kind` discriminant produces clean exhaustiveness checking. A `switch (decision.kind)` over all three variants is type-checked for completeness, and a future fourth variant (a hypothetical `Defer` or similar) would be caught by the compiler at every consumer site.

The `Enter` variant having no fields in Phase 1 is deliberate. Phase 2's execution layer will extend `Enter` with `positionSizeSol: bigint` and an exit-rules structure. Old Phase 1 records lacking those fields will remain valid because the new fields will be added as optional or migrated via a forward-only schema rule; the JSON shape in `lifecycle_events.payload` is flexible enough to accommodate the evolution.

## Alternatives Considered

We considered putting threshold values inside each reason variant — `{ kind: 'top_holder_excessive'; topHolderPercent: number; threshold: number }` and so on. The obvious-default extension of per-variant data. We rejected it because the same threshold value would be duplicated across every reason variant that referenced it, with the same threshold appearing under different field names on different reasons. Analytical SQL queries asking "what was the score threshold at the time of decision X" would have to inspect nested structured reasons. A future threshold change would need either a JSON migration or a reader that knew to take the value from the threshold field with the highest sequence number. The single-snapshot-on-the-wrapper shape avoids all of this by recording each parameter once per decision in a canonical location.

We considered a single typed reason per variant — `{ kind: 'pass'; reason: PassReasonCode; message: string }` with one reason and a human-readable message. Simpler than the multi-reason array. We rejected it because most rejected tokens fail multiple checks at once — a rugged token with active mint authority and a single holder owning ninety-five percent of the supply would record only one of those, throwing away two-thirds of the information. The "negative space is the data product" framing the architecture explicitly establishes is undermined when reasons are forced to be singular.

We considered a flat rule-trace shape, recording every rule's evaluation (passed or failed) and treating the outcome as a derived field. This is the pattern policy engines like Open Policy Agent use for their decision logs. We rejected it for our context because it would have abandoned the discriminated-union pattern Part Six of the architecture prescribes. The architecture's promise that an `Enter` variant has different shape than `Pass` or `Watch` — and Phase 2's extension of `Enter` with position-size fields — is only enforceable when each verdict has its own variant type. Flattening into a uniform shape loses this property and was not adopted.

We considered storing reasons as a simple string array with no per-variant union — `reasons: string[]` — and validating reason codes only by convention. We rejected it because string-literal unions are the project's standard tool for direction-explicit, typo-safe codes (consistent with the existing convention in `Result`, `RugCheckFetchError`, and the various `*Status` discriminants). Bare strings would have made typos in reason codes silent across the codebase.

We considered taking the candidate's `internalId` only on the wrapper rather than the full candidate. Smaller JSON payloads, no duplication between the analysis row and the strategy decision row. We rejected it because the architecture explicitly chose the embed-the-candidate shape ("the strategy identifier, the candidate it evaluated, and the decision made" in Part Five). The denormalised storage cost is justified by the analytical property that a single decision row is self-contained — no JOINs required to answer questions about what the strategy saw.

We considered making `StrategyEvaluationResult` itself the discriminated union, with `strategyId`, `candidate`, `thresholds`, and `evaluatedAt` repeated on each variant. We rejected it because the shared fields are genuinely shared — they describe the same wrapping context regardless of verdict. The wrapper-and-inner-union shape is the more honest model.

We considered writing this ADR retrospectively after the operational-security ADR and the Hetzner deploy were done. The mainstream ADR guidance from AWS, Microsoft, and Spotify all converge on "write while reasoning is fresh, not retrospectively." We took that seriously, and this ADR exists because of it.

## Implementation Notes

The types live at `src/shared/strategyEvaluationResult.ts`. `StrategyEvaluationResult` is the wrapper. `StrategyDecision` is the inner union. `ThresholdsSnapshot` is the parameter snapshot type currently shaped for the data-collection strategy; Phase 2 strategies that need a different parameter set declare their own snapshot type.

The Phase 1 data-collection strategy lives at `src/strategy/dataCollectionStrategy.ts`. Its threshold constants (`DATA_COLLECTION_THRESHOLDS`) and its identifier (`DATA_COLLECTION_STRATEGY_ID`) are exported alongside the pure evaluator `evaluateDataCollectionStrategy`. The two-stage filter is implemented inline; future strategies are free to use a different evaluation structure as long as they produce a `StrategyDecision`.

The wire layer `src/strategy/wireStrategy.ts` subscribes to `tokenAnalysisCompleted`, calls the evaluator, assembles the wrapper, and publishes `strategyDecisionRecorded`. Evaluator throws (the invariant-violation path) are caught and logged at error level; Phase 1 prioritises uptime over crashing on a single bad evaluation.

Persistence is handled by `EventStore.recordStrategyDecision` in `src/infrastructure/store/eventStore.ts`. The full result serialises into the `lifecycle_events.payload` JSON column with `event_type='strategyDecisionRecorded'`. The `tracked_tokens.last_event_seq` projection is updated transactionally with each write. No schema migration is needed; the `event_type` column is TEXT.

Tests covering the rule matrix live at `src/strategy/dataCollectionStrategy.test.ts` (15 cases including the multi-reason collection invariant, the inclusive-threshold boundaries, the empty-topHolders edge case, and the rugcheck-err short-circuit). Wire-layer integration tests live at `src/strategy/wireStrategy.test.ts`. EventStore persistence is covered in the existing test suite by an added case at `src/infrastructure/store/eventStore.test.ts`.

When working with Claude Code on future strategies, the invariants worth defending are the one-event-per-detected-token guarantee, the thresholds-as-snapshot rule, and the reasons-as-bare-codes rule. Future strategies that need a different decision shape — for example, a confidence-scored strategy whose verdict is derived from a continuous score — should write a superseding ADR rather than silently diverging. The architecture documents this as the convention; this ADR makes it concrete.

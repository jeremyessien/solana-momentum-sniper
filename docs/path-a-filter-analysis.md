# Path A — Candidate Filter Selection Analysis

## Status

Analysis document, written 29 July 2026. This is the Path A deliverable described in the Phase 2 design note ([phase-2-design-note.md](phase-2-design-note.md), "Shape A"): the smallest credible thing that tells us whether the candidate filter would have *selected* the catchable winners in the data we already have, and at what cost in false positives. It is evidence, not a decision — the eventual Phase 2 strategy ADR will cite it. It parallels [phase-1-findings.md](phase-1-findings.md) and, in one place, corrects it.

**One-line result:** a top-holder concentration filter of **30–45%** (with a blind-data guard) selects catchable winners at **~14.5% precision** (roughly 1 in 7) against a **0.38% baseline** — about a 38× lift — while catching ~24% of all catchable winners. The findings doc's recommended threshold (≤50%) would *not* have cleared this bar, for a reason this analysis uncovers.

## What this analysis is, and is not

Path A answers **selection**, not **profit**. It measures how well the filter separates catchable graduations from timeouts in the collected data. It does *not* measure whether buying the selected coins would have made money — graduation is not profit, and the post-graduation price gap is untouched here (see Caveats). Path A's job is to decide whether the strategy is worth the expensive next steps, not to produce a P&L number.

## The dataset, and a correction to the findings doc

All queries were run read-only against the production store (`/var/lib/moonscout/moonscout.db`) on 29 July 2026. The store holds **32,368 tracked tokens**.

The findings doc described this data as "the first ~12 days of observation." That is wrong, and the correction matters. The actual detection window is **2026-05-26 09:37:30 → 2026-05-27 14:20:39 — about 29 hours.** The 32,368-token *count* was always right; the *timespan* was not. Pump.fun is a firehose (~18 launches per minute), so a day of it produces tens of thousands of tokens. Detection has been down since 27 May (an expired Helius plan; the free tier cannot sustain the launch firehose), which is why the store stops there.

The consequence for this analysis is structural: **29 hours cannot be split into a train/test partition over time.** The standard guard against threshold overfitting — fit on early data, validate on later data — is unavailable to us. Every number below is therefore **in-sample**, and is labelled as such. Genuine out-of-sample validation requires fresh data, which is the concrete, evidence-based reason to restore detection.

## Methodology

Three choices, each grounded in the literature rather than convenience:

1. **Precision and recall, never accuracy.** The positive class is ~0.5% of the data; a classifier that says "no" to everything scores 99.5% accuracy and is useless. Saito & Rehmsmeier (PLOS ONE, 2015) show that even ROC/AUC mislead under heavy imbalance because their component rates are invariant to it, whereas precision is sensitive to it. We report **precision** (selected winners ÷ selected) and **recall** (selected winners ÷ all catchable winners).

2. **Wilson score confidence intervals on every proportion.** Our win-rates are tiny and some samples small, exactly where the textbook (Wald/normal) interval fails — it under-covers near 0 and can produce impossible bounds below 0. The Wilson score interval is the modern default for this regime (Brown, Cai & DasGupta 2001; rare-event CI literature). SQL returns raw counts; the intervals are computed off-database, where the math is clean.

3. **Treat threshold selection as multiple testing.** Sub-dividing concentration bands and keeping the best is precisely how flukes are manufactured (Bailey, Borwein, López de Prado & Zhu, "The Probability of Backtest Overfitting"; Harvey et al. 2016). We mitigate by (a) refining a threshold the findings doc *pre-registered* (30–50%) rather than fishing from scratch, (b) reporting a large effect size with confidence intervals rather than a marginal point estimate, and (c) stating plainly that the exact cut points are in-sample and need out-of-sample confirmation.

## Q0 — Population and ground truth

| tracking_status | count |
|---|---:|
| graduated | 175 |
| timeout | 32,193 |
| active | 0 |

Graduation rate 0.54% — one in ~185, matching the findings doc. Enrichment: **27,631** tokens have a RugCheck "ok" snapshot, **4,737** an "err", **0** pending. Every token has exactly one `tokenAnalysisCompleted` event (the ADR-007 invariant holds), so later queries join each token directly to its single snapshot. The RugCheck kind read from JSON matches the `enrichment_status` column exactly, confirming the JSON paths are sound.

Graduation-time distribution (detect → graduate), reproduced exactly from the findings doc:

| Window | Count |
|---|---:|
| 0–30 sec | 53 |
| 30 sec – 2 min | 20 |
| 2–5 min | 43 |
| 5–15 min | 34 |
| 15–30 min | 25 |

The **102 catchable winners** are the 2–30 minute cluster (43 + 34 + 25). These are the positive class for the rest of the analysis. The 0–30 second cluster (53) is unreachable by design and excluded.

## Q1 — The blind-data guard, and a reversal

The findings doc proposed guarding against "blind" entries. Two findings reshape how.

**`totalHolders` is a dead field at decision time.** It is near-zero for almost every fresh coin (indexing lag), even when a real top-holder percentage is present. Requiring `totalHolders ≥ 20` would have cut the 98 catchable winners that have top-holder data down to **1**. It is not a guard, it is a shredder. The blind-data guard is therefore defined on **"is `topHolders` populated?"**, never on the holder count.

**The blind-data hypothesis is backwards for the coins we can catch.** Blindness rate (`rugcheck err` or `ok but no top-holder`) by outcome:

| Outcome | n | blind | % blind |
|---|---:|---:|---:|
| catchable_winner | 102 | 4 | **3.9%** |
| fast_winner | 73 | 42 | 57.5% |
| timeout | 32,193 | 6,424 | 20.0% |

The catchable winners are the **least** blind group — 96% carry the data we need, and not one had a RugCheck error. The findings doc's claim that "winners are disproportionately blind" was picking up the **fast winners** (the 0–2 minute orchestrated cluster), which graduate before RugCheck can index them, and conflating them with the catchable population. The *principle* — enter on positive evidence, not the absence of red flags — still holds and is cheap to satisfy: the guard costs only 4 of 102 catchable winners on recall while removing 6,424 blind timeouts from the candidate pool.

## Q2 — The top-holder filter

Among guard-passing coins (RugCheck ok + top-holder present; 25,898 coins, 98 catchable winners), bucketed by top-holder concentration:

| Band | n | catchable wins | precision |
|---|---:|---:|---:|
| 0–30% | 1,614 | 12 | 0.74% |
| **30–40%** | **75** | **10** | **13.3%** |
| **40–45%** | **90** | **14** | **15.6%** |
| 45–50% | 7,430 | 5 | 0.07% |
| 50–70% | 1,144 | 22 | 1.9% |
| 70–90% | 6,437 | 26 | 0.40% |
| 90–100% | 9,108 | 9 | 0.10% |

The signal is concentrated, sharply, in **30–45%**. The 45–50% band is an anomaly — 7,430 coins, almost all timeouts — explained below.

Precision/recall for three candidate cutoffs, with Wilson 95% intervals:

| Filter | selected | catchable wins | precision (95% CI) | recall (95% CI) |
|---|---:|---:|---|---|
| **top-holder 30–45%** | 165 | 24 | **14.5%** [10.0, 20.7] | 23.5% [16.4, 32.6] |
| top-holder ≤45% | 1,779 | 36 | 2.0% [1.5, 2.8] | 35.3% |
| top-holder ≤50% *(findings doc)* | 9,209 | 41 | 0.44% [0.42, 0.51] | 40.2% |
| *baseline (all guard-passing)* | 25,898 | 98 | 0.38% | — |

The ≤50% filter is statistically indistinguishable from doing nothing (0.44% vs 0.38% baseline). The 30–45% filter is ~38× the baseline, and its interval floor (10%) is still ~26× — a large effect that survives the sample-size uncertainty. The cost is recall: 30–45% catches 24% of catchable winners where ≤50% would catch 40%. For a selectivity strategy where every entry costs slippage and fees, precision is the right thing to buy.

## Q2b — The `50.0` placeholder artifact

The 45–50% graveyard is not a concentration effect; it is a data-quality artifact. The twenty most common exact top-holder values are dominated by a single one:

- **`top_pct = 50.0` appears 6,507 times, with 1 catchable winner.** That is 5× the next value and accounts for **6,507 of the 7,430** coins in the 45–50% band.

Every genuine value in the distribution carries organic decimals (`49.911`, `84.834`, `90.245`). A flat `50.0` repeated 6,507 times is a **default** — RugCheck signalling "concentration not computed", masquerading as "top holder owns 50%". This fully explains why the findings doc's ≤50% recommendation failed: it swept 6,507 placeholder coins into the selected set. The genuine 45–50% coins (the 923 that are not the placeholder) are also weak (4 winners / 923 = 0.4%), so the sweet spot remains 30–45% either way.

**New data-quality rule:** `top_pct = 50.0` exactly is to be treated as blind data, folded into the guard. It is already excluded by the ≤45% cut here, but it matters for the live strategy and any future feature work.

## The candidate filter, locked for Path A

A coin is selected when all hold:

1. RugCheck returned data (`kind = 'ok'`);
2. top-holder data is present (`topHolders[0].pct` is not null);
3. it is not the placeholder (`top_pct ≠ 50.0`);
4. concentration is in **[30%, 45%]**.

On the collected data: **165 selected, 24 catchable winners, precision 14.5% [10.0, 20.7], recall 23.5% [16.4, 32.6].**

## Path A's verdict

**The filter selects winners far better than chance.** A ~1-in-7 hit rate against a 1-in-264 baseline is a strong, unambiguous yes to the question Shape A was built to answer, and it justifies the expensive next steps that the design note deferred until such a signal existed. It is worth recording that the findings doc's own recommended threshold would have failed this test — the value of sub-dividing a pre-registered band, and of chasing the 45–50% anomaly to its root, was decisive.

## Caveats

- **In-sample only.** Everything rests on a single 29-hour window with no time-based hold-out. The exact 30–45% boundaries are partly fit to this data. The signal is strong and mechanistically plausible, but confirmation requires out-of-sample data.
- **Graduation is not profit.** 14.5% precision means 1-in-7 *graduates in the catchable window*, not 1-in-7 *makes money*. Post-graduation price and round-trip slippage are unaddressed and are the back half of Phase 2.
- **Small samples in the sweet spot.** The 30–40% and 40–45% bands hold 75 and 90 coins. The Wilson intervals reflect this; the combined 30–45% floor of 10% is what makes the result robust despite the thinness.
- **Second-feature work is underpowered here.** After the 30–45% cut, 165 coins / 24 winners is too thin to layer a second filter (e.g. a RugCheck score floor) without dropping below the design note's ~30-selected threshold. That thinness is itself a finding: multi-feature strategy work needs more data.

## Implications for Phase 2

1. **Restore detection to get out-of-sample data.** This is the highest-value next step for the strategy — the only way to confirm the 30–45% filter is not an artefact of late May. Detection restoration should favour a cheap ingestion path (scoped subscription or Helius webhooks) over paying for the full firehose, since Phase 2 needs enough live launches to validate against, not the complete feed.
2. **Close the graduation→profit gap.** Extend the bot to track PumpSwap pool state for graduated coins (per the Phase 2 decisions) and compute honest round-trip P&L with slippage on the bonding curve entry and pool exit.
3. **Keep the filter simple.** The data does not yet support a multi-feature strategy. Top-holder 30–45% plus the blind-data guard is the whole filter until fresh data earns a second feature.

## Appendix — Queries (for reproducibility)

Run read-only against the production store. Full queries are recorded here so the analysis can be re-run against fresh data once detection is restored.

- **Q0** — population by tracking/enrichment status; one-analysis-per-token invariant; graduation-time buckets; RugCheck kind and JSON-path sanity.
- **Q1** — blindness rate by outcome group (catchable_winner / fast_winner / timeout), plus the `totalHolders ≥ 20` survival check.
- **Q2** — outcome counts by top-holder band among guard-passing coins.
- **Q2b** — twenty most common exact `top_pct` values with catchable-winner counts (the `50.0` artifact).

Outcome labelling used throughout: `catchable_winner` = graduated with detect→close in [2 min, 30 min); `fast_winner` = graduated in < 2 min; `timeout` = did not graduate. Guard = `rugcheck.kind = 'ok'` AND `topHolders[0].pct IS NOT NULL`.

## Related documents

- [phase-1-findings.md](phase-1-findings.md) — the evidence this analysis builds on and, in the blind-data section, corrects.
- [phase-2-design-note.md](phase-2-design-note.md) — defines Shape A, of which this is the execution.
- ADR-005 — Data Store and Persistence (the schema queried here).
- ADR-007 — Strategy Decision Shape (the one-decision-per-token invariant relied on in Q0).
- Future ADR — Phase 2 strategy (will cite this document for the candidate filter and its measured selection performance).

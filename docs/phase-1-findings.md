# Phase 1 Analytical Findings

## Status

Living document. First written 1 June 2026, capturing findings from the first ~12 days of production observation on Hetzner. This document grows as more data accumulates and more analysis runs. It is *evidence* for future decisions — it is not itself a decision, so it is not an ADR. The eventual Phase 2 strategy ADR will cite specific findings recorded here.

## Context

The bot has been recording every detected Pump.fun launch into the SQLite store specified by ADR-005 since the first deployment around 20 May 2026. The analyses summarised here were run against a snapshot of that store via read-only `sqlite3` queries on the production server (`/var/lib/moonscout/moonscout.db`). Concurrent reads against the WAL-mode database are safe whether the bot is running or stopped.

The dataset at the time of this writing contains roughly 32,400 tracked tokens, 129,000 lifecycle events, and 2.3 million per-trade observations. Every coin has been carried through the pipeline ADR-005, ADR-006, and ADR-007 specify, including the per-token strategy decision the data-collection strategy records with explicit pass reasons.

## The Shape of the Outcome

Of the ~32,400 tokens the bot tracked, **175 graduated** (escaped the Pump.fun bonding curve onto a wider market) and the remainder timed out without graduating. The graduation rate of **~0.54%** — roughly one in two hundred — is consistent with public characterisations of Pump.fun and confirms the system is observing accurately. The platform really is a firehose where the vast majority of launches die within the 30-minute tracking window.

The distribution of graduation times across the 175 winners is **bimodal**, not single-peaked, and this is the first non-obvious finding of Phase 1:

| Time from detection to graduation | Count | Share |
|---|---:|---:|
| 0–30 sec | 53 | 30% |
| 30 sec – 2 min | 20 | 11% |
| 2–5 min | 43 | 25% |
| 5–15 min | 34 | 19% |
| 15–30 min | 25 | 14% |

A dense cluster of 0–30 second graduations sits separated from a broader 2–30 minute spread by a clear dip. The 0–30 second cluster is most plausibly creator-orchestrated pump bundles — coordinated buyers pushing past the graduation threshold within seconds. These are unreachable for a selectivity bot by design (the detect-enrich-decide loop alone takes longer) and likely not coins worth targeting even hypothetically. The 2–30 minute spread looks more like organic momentum: people seeing the coin, buying in, accumulating to graduation. This is the population the architecture is actually built to act on.

## The Addressable Market

Combining the 2-5, 5-15, and 15-30 minute buckets yields **102 winners** that occurred at a pace the bot can react to. Extrapolated very roughly, that is several thousand catchable graduations per year — a meaningful sample for a system designed to say "no" 99% of the time. The architectural bet that "there are slow-enough winners for a selectivity bot to find some of them" is confirmed by data, not by hope.

## How the Current Strategy Behaves

Restricted to those 102 catchable winners, the data-collection strategy's decisions broke down as:

| Verdict | Count | Share |
|---|---:|---:|
| Enter (buy) | 3 | 3% |
| Watch (borderline) | 6 | 6% |
| Pass (skip) | 93 | 91% |

The strategy passes on roughly 91% of catchable winners. This is not framed as a criticism of the strategy — the data-collection strategy was intentionally built to be permissive for *labelling*, not to make money (per ADR-007, its purpose is to produce a useful distribution of decisions, not profitable trades). The result is exactly what Phase 1 is meant to surface: the labels themselves reveal that the criteria currently in use do not align with catchable winners.

## Why It Passes — and What That Tells Us

Of the 93 pass decisions on catchable winners, two reason codes do nearly all the work:

- `top_holder_excessive` — cited 86 times, about 92% of the passes.
- `score_too_risky` — cited 41 times, about 44% of the passes.

The dominant rejection reason is the bot saying "one wallet holds too big a share of the supply." On a fresh Pump.fun coin, this is usually the baseline shape of how a bonding curve works — early buyers hold concentrated positions. The threshold for "too much" is therefore set tight enough that the bot is rejecting coins for being normal, not just for being suspicious. The next two analyses test that hypothesis directly.

## Risk Score Has Weak Signal

Comparing the RugCheck `scoreNormalised` between winners and losers across the full dataset (excluding coins where RugCheck never returned scored data):

| Tracking status | Count with score | Avg score | Min | Max |
|---|---:|---:|---:|---:|
| Graduated | 135 | 50.2 | 1 | 83 |
| Timed out | 27,496 | 53.5 | 1 | 83 |

The averages differ by only 3.3 points on a 0–100 scale, and the full ranges overlap completely. A score-based filter cannot strongly discriminate winners from losers in this data; on this feature alone, the filter is essentially a slightly-biased coin flip. The bot's secondary rejection reason is not pulling meaningful weight as a predictor.

## Top-Holder Concentration Has Real Signal

The same comparison for the top holder's percentage of supply (`topHolders[0].pct` in the RugCheck snapshot):

| Tracking status | Count with data | Avg top-holder % | Min | Max |
|---|---:|---:|---:|---:|
| Graduated | 129 | 55.5% | 1.1 | 96.3 |
| Timed out | 25,769 | 72.0% | 0.0 | 100.0 |

A 16.5-percentage-point gap — about five times the score's separation. Top-holder concentration genuinely distinguishes winners from losers. Bucketing the same data by concentration band exposes where in the distribution the signal lives:

| Top-holder band | Winners | Losers | Total | Win odds |
|---|---:|---:|---:|---:|
| 0–30% | 19 | 1,595 | 1,614 | 1 in 85 |
| **30–50%** | **34** | **1,056** | **1,090** | **1 in 32** |
| 50–70% | 32 | 7,617 | 7,649 | 1 in 239 |
| 70–90% | 35 | 6,400 | 6,435 | 1 in 184 |
| 90–100% | 9 | 9,101 | 9,110 | 1 in 1,012 |

The 30–50% band is the sweet spot: graduates appear in it at roughly six times the overall baseline rate of ~1 in 200. The current data-collection strategy enters at top-holder ≤ 20% and watches at ≤ 30%, which means the current threshold lands almost exactly on the edge of the sweet spot but on the wrong side of it. The bot accepts a band with worse odds (1 in 85) and rejects the band with the best odds (1 in 32). The threshold is set where it does the least good.

## Calibration Target for Phase 2

Based on this feature alone, a top-holder threshold of **≤50%** is the best cutoff visible in our buckets. It would accept 53 winners out of 2,704 coins in the accepted band, for roughly 1-in-51 odds — twice as good as the current line. The next band up (50–70%) drops to 1-in-239, *worse* than the random baseline, so going above 50% is a bad trade.

Finer buckets within 30–50% will tighten this further; ≤45% is plausibly cleaner still. The recorded number for the Phase 2 design conversation is **≤50% as a defensible data-driven upper bound**, with the expectation that combining top-holder share with other features and finer bucketing will refine it.

## The Blind-Data Hypothesis

A subtler pattern recurs in both feature analyses: winners are disproportionately likely to be coins for which RugCheck returned no data at the moment of evaluation. Among the 175 winners, only 135 had a `scoreNormalised` value (77%) and only 129 had `topHolders[0].pct` populated (74%). The corresponding rates for timeouts were notably higher — about 85% and 80% respectively.

The hypothesis that follows: when the strategy enters, it may be doing so because RugCheck had no data to flag the coin with — not because the coin was genuinely clean. The three ENTER decisions among catchable winners all had RugCheck snapshots that look very sparse (holder counts of 0, 4, and 10 — almost certainly indexing lag, not real counts), supporting the same read. Three data points is not a finding, but it is a hypothesis worth holding when designing Phase 2: a strategy's "yes" should require *positive evidence*, not the *absence of negative evidence*.

## Honest Caveats

- **One feature in isolation.** The threshold work above looks only at top-holder share. A Phase 2 strategy combining multiple features — concentration, contract risk flags, early trade velocity, holder growth — may shift the calibrated thresholds in either direction.
- **Graduation is not profit.** Every finding here tracks whether a coin reached the bonding-curve graduation threshold. It does not yet test whether buying that coin would have been profitable. Some graduated coins crash immediately on the next venue; some keep climbing. Phase 2's paper trading is the next instrument that actually answers profitability.
- **Sample sizes are real but not huge.** 175 graduations, ~32k tokens. Enough to see real patterns; not enough to ground a high-confidence statistical model. The picture sharpens as the bot continues observing.
- **Pump.fun is a moving target.** Behaviour patterns shift week to week. Findings that hold today may need revisiting in months.

## Implications for Phase 2

Three concrete inputs for the Phase 2 strategy design conversation:

1. **The catchable window is real.** Phase 2 strategies should target the 2–30 minute graduation cluster, with the explicit understanding that the 0–30 second cluster is unreachable and probably not worth chasing anyway.
2. **Top-holder concentration is a usable feature; risk score on its own is not.** A Phase 2 strategy that filters on top-holder share has real signal to work with. A strategy that filters mainly on the RugCheck normalised score does not.
3. **Beware of entering when the safety check is blind.** Phase 2 design should require positive evidence (a populated `topHolders` array, a non-trivial holder count from a reliable source) before entering, not merely the absence of red flags.

## Methodology Notes

Two patterns from this round of analysis are worth carrying forward:

- **Recording the negative space worked.** ADR-007's invariant that every detected token produces exactly one `StrategyDecisionRecorded` event — including passes, with reasons — is the artefact that made today's findings possible. Future strategy designs should preserve the same property: every decision recorded, with reasons, so the next round of analysis can ask the same kinds of questions.
- **JSON-in-SQLite worked.** Storing the full RugCheck snapshot as JSON in the lifecycle event payload (per ADR-005) made it trivial to extract any field post-hoc with `json_extract`, including fields the strategy never inspected. If only a typed projection of "fields the strategy uses" had been stored, this analysis could not have looked at `topHolders[0].pct` to test whether the dominant filter actually carries signal.

## Related Documents

- ADR-005 — Data Store and Persistence (defines the schema this analysis queries)
- ADR-006 — Enrichment Readiness Signal (defines when RugCheck is fetched, which informs the blind-data hypothesis)
- ADR-007 — Strategy Decision Shape (defines the decision/reasons recording that made this analysis possible)
- Future ADR — Phase 2 strategy (to be written; will cite this document for calibration evidence)

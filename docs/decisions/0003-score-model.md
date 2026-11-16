# 0003. A 0..1 score per line from weighted signals, with two thresholds

- Status: Accepted
- Date: 2026-11-10, thresholds refined 2026-11-11 (`223ce7e`); reconstructed from code and history
- Code: `src/tracking/scoring.ts`, `src/config.ts`, `src/ui/settingsView.ts`

## Context
"Seen" is not binary. A glance while scrolling is weaker evidence than a minute with the cursor on a line. Users also differ in how they read, so the model has to be tunable without becoming a research project.

## Decision
- Every new line has a score in [0, 1]. Signals add `weight × seconds` (or `weight` per event), clamped to 1.
- `reviewedThreshold` (0.8) marks a line as **fully seen**. It gets the full colour, *Next Unreviewed* skips it, and it counts in "N of M lines". The colour gradient is scaled to reach full pink at this threshold.
- `partiallySeenThreshold` (0.1) applies to a file's *mean* score and moves it from Unseen to Partially seen. A file is Fully seen only when all of its lines are.
- The Settings panel shows each weight inverted, as "time / number of events until fully seen", which is easier to reason about than a rate.

## Alternatives considered
- **Binary seen / not seen.** This can't express "skimmed", and a single scroll would mark everything.
- **Time-decay of scores** (forgetting). More realistic but surprising: progress would disappear overnight.
- **One threshold for both purposes.** The file categories need a low bar (has the user started on this file?), and line completion needs a high one.

## Consequences
- Scores are plain numbers, cheap to store (rounded to 3 decimals) and merge.
- Changing `reviewedThreshold` recomputes all stats. The stored scores stay the same.
- Weights ≥ 1 for cursor, selection and hover act as "instant" (see [ADR 0004](0004-review-signals.md)).

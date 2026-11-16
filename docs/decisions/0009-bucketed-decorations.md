# 0009. 11 pre-built decoration types for the colour gradient

- Status: Accepted
- Date: 2026-11-10 (initial commit `3552912`); reconstructed from code and history
- Code: `src/ui/decorations.ts`, `src/ui/color.ts`

## Context
Each line's colour depends on its score. VS Code decorations are created as *types* with a fixed style, and an editor gets a list of ranges per type.

## Decision
- Create 11 types (0%, 10%, …, 100% between the two colours). Each new line goes into bucket `round(min(1, score / reviewedThreshold) × 10)`.
- Each type paints a whole-line background, a 3 px left border, and a mark in the left lane of the overview ruler, at a stronger alpha.
- `hideWhenFullyReviewed` makes the last type empty.

## Alternatives considered
- **One type per line with its exact colour.** Thousands of decoration types, created and disposed constantly: slow, and leak-prone.
- **Fewer buckets.** Too coarse to notice progress.
- **More buckets.** No visible difference. Each extra type is one more `setDecorations` call when it changes.

## Consequences
- Colour changes (settings) recreate all 11 types.
- Repaints only send the types whose lines changed ([ADR 0011](0011-targeted-invalidation.md)).

# 0012. Budgeted Myers with patience anchors and a chunked fallback

- Status: Accepted
- Date: 2026-11-13 (branch `perf-and-docs`)
- Code: `src/tracking/newLines.ts`

## Context
`computeNewLines` ran jsdiff's `diffArrays` (Myers, O((N+M)·D)) over the whole file. It runs on every document version, so on every keystroke while painting. For files with many changes it was catastrophic. Benchmarks with the old code:

| File | Small edit | 30% of lines rewritten | Fully rewritten |
| --- | --- | --- | --- |
| 1k lines | 0.1 ms | 27 ms | 127 ms |
| 10k lines | 0.9 ms | **2.4 s** | **12.3 s** |
| 50k lines | 6.2 ms | **108 s** | (not measured) |

AI tools routinely rewrite large parts of a file, so this was not hypothetical. It froze the extension host.

## Decision
1. Match the common prefix and suffix on the raw strings. The typical case, a few edits in a big file, ends here without further allocation.
2. Intern the remaining lines to integers. CR is stripped, so CRLF and LF compare equal.
3. For each range (explicit stack, no recursion limit):
   1. Trim the common prefix and suffix. A range where the two sides share no line is all new.
   2. **Try Myers** (jsdiff) with `maxEditLength = 400,000 / range size`, a 100 ms timeout, and a total budget of 8,000,000 cells per call. When it fits, the result is optimal.
   3. Otherwise split the range on **anchors**: lines that occur exactly once on both sides. Keep the longest increasing subsequence of anchors (patience sorting, O(k log k)), and push the gaps between them as new ranges.
   4. If there are no anchors either, use **chunked Myers**: cut both sides into consecutive, proportionally sized chunks of 128 current lines, and diff each chunk.

Every step matches lines in order, so the result is always a valid in-order common subsequence. The tests check this on every case, compare against an optimal Myers diff on random edits, and include a moved-block case and a tiny-alphabet stress case.

## Alternatives considered
- **Keep Myers, add a timeout.** Bounded time, but on timeout every line would be marked new, which is very wrong for large partly-rewritten files.
- **Trim prefix/suffix only.** Fixes small edits, not scattered rewrites. Those are the slow case.
- **Anchors first, Myers only in gaps without anchors** (classic patience diff). Tried first, and the review found a failure. Base `[import a; 100 × "}"; export b;]` against a version with the first and last lines swapped: one moved unique line becomes the only anchor and cuts the `}` block out of every gap, so 101 of 102 lines were marked new. Trying a cheap Myers first gives the optimal 2.
- **Order-insensitive multiset fallback** (a line is old while the base has an unused copy). Also tried first. Fast, but it breaks the in-order requirement, so reordered code could stay uncoloured.
- **Greedy in-order fallback.** Valid, but on low-variety input it consumes the base too fast and marks most lines new.
- **Provisional state while typing** (splice the previous `isNew` with the edit, diff later). Planned initially, then dropped: with the new diff a 10k-line file costs ~5 ms per version, about the same as hashing its lines, so the saving didn't justify up to 250 ms of wrong colours after each keystroke.
- **A WebAssembly or native diff.** Unnecessary after the algorithmic fix, and a build complication.

## Consequences
- 10k lines / 30% rewritten: 2.4 s → 5.5 ms. 10k fully rewritten: 12.3 s → 3.5 ms. 50k / 30%: 108 s → 29 ms. 1k / 30%: 27 ms → 3.6 ms. Small edits are unchanged (~0.7 ms for 10k lines). The marked-new counts are identical to the old optimal diff in all these cases.
- When a range is too expensive for Myers, the anchor split can miss a few matches an optimal diff would find, so a few extra lines are marked new. The random-edit test bounds this.
- Chunked Myers only runs for large ranges without a single unique line, which is rare in real code. Lines that moved across a chunk border are marked new.

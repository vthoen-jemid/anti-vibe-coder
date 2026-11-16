# 0001. Review progress is keyed by line content, not line number

- Status: Accepted
- Date: 2026-11-10 (initial commit `3552912`); reconstructed from code and history
- Code: `src/tracking/lineKeys.ts`, `src/tracking/scoring.ts`

## Context
Code on a branch changes all the time while it is being reviewed: commits, rebases, edits above a reviewed block, an AI tool rewriting one function. Progress must survive code moving around. It must *not* survive the code itself changing: a rewritten line has not been reviewed.

## Decision
A line's identity is `cyrb53(trimmed text)` in base 36, plus `#n` for the n-th earlier occurrence of the same trimmed text in the file (so the many `}` lines get distinct keys). Scores are stored per file as `Map<lineKey, score>`.

## Alternatives considered
- **Line numbers.** Every insertion above a line would shift its progress onto other code.
- **Tracking positions through edits** (like decorations do). This works inside one editor session but not across commits, files changed on disk, or restarts.
- **Hash of the line with its neighbours.** Editing one line would reset the lines around it too.
- **A cryptographic hash.** Slower for no benefit. Collisions only merge two lines' progress, and with 53 bits they are negligible per file.

## Consequences
- Moving code within a file keeps its progress. Moving it to another file does not, because scores are per file.
- Re-indenting doesn't reset progress (the text is trimmed). Any other change does.
- Duplicates are told apart by order. Deleting the first of two identical lines hands its score to the second.
- Keys of lines that disappear are pruned on save / disk read, so the store doesn't grow forever.
- The keys of the whole file are recomputed per document version (~5 ms for 10k lines). They are computed once per version and shared between the typing path and the state computation.

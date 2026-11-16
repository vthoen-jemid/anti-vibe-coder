# 0002. Compare the working tree against the merge-base

- Status: Accepted
- Date: 2026-11-10 (initial commit `3552912`); reconstructed from code and history
- Code: `src/git/repo.ts` (`refresh`), `src/tracking/newLines.ts`

## Context
The question the extension answers is "which code on my branch have I reviewed?". That includes code that isn't committed yet, which is often exactly what an AI tool just wrote. Commits on the base branch made after branching are not "my code".

## Decision
- The changed set is `git diff --name-only --no-renames --diff-filter=d <merge-base>` (working tree vs merge-base) plus `git ls-files --others --exclude-standard` (untracked, not ignored).
- Per file, the lines that are new compared to `<merge-base>:<path>` are tracked.
- Deleted files are left out, and renames are treated as delete + add.

## Alternatives considered
- **Compare with the tip of the base branch** (`git diff main`). Work merged into main after branching would show up as reverted lines on the branch, and the result would change every time someone pushes to main.
- **Only committed changes** (`main...HEAD`). This would miss what the user is reviewing right now.
- **Rename detection.** A renamed file would keep the base content of its old path. That is nice, but costs an extra git call and complexity, and line keys already carry progress for files whose content stayed the same.

## Consequences
- A file reverted to its base content leaves the diff on the next refresh.
- Unsaved edits are not visible to git. A file outside the diff joins it once saved.
- Merging main into the branch moves the merge-base, and all derived state is recomputed. Scores survive, because they are keyed by content.

# Architecture Decision Records

Short records of decisions that shaped the extension: the context, what was decided, the alternatives, and the consequences. Read the relevant ones before changing an area. If you decide differently, add a new ADR that supersedes the old one; don't rewrite history.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-content-keyed-line-identity.md) | Review progress is keyed by line content, not line number | Accepted |
| [0002](0002-compare-against-merge-base.md) | Compare the working tree against the merge-base, including uncommitted and untracked files | Accepted |
| [0003](0003-score-model.md) | A 0..1 score per line, accumulated from weighted signals, with two thresholds | Accepted |
| [0004](0004-review-signals.md) | Signals: a reading band instead of the whole viewport, a silent hover provider, selection kinds | Accepted |
| [0005](0005-typing-heuristic.md) | Small edits in the focused editor count as the user's own typing | Accepted |
| [0006](0006-local-storage.md) | Store progress locally in `workspaceState`, per repo and branch | Accepted |
| [0007](0007-git-cli.md) | Talk to git through the CLI, not the built-in Git extension API | Accepted |
| [0008](0008-per-branch-base.md) | Base branch: per-branch choice, then setting, then auto-detect | Accepted |
| [0009](0009-bucketed-decorations.md) | 11 pre-built decoration types for the colour gradient | Accepted |
| [0010](0010-persistent-cat-file.md) | Read base versions through one persistent `git cat-file --batch` process | Accepted |
| [0011](0011-targeted-invalidation.md) | Targeted invalidation, file-event triage and incremental repaint | Accepted |
| [0012](0012-fast-line-diff.md) | Budgeted Myers with patience anchors and a chunked fallback for the line diff | Accepted |

## Template

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD
- Code: files / commit

## Context
What problem or force made a decision necessary.

## Decision
What we do.

## Alternatives considered
What else was possible and why it lost.

## Consequences
What becomes easier, harder, or must be kept in mind.
```

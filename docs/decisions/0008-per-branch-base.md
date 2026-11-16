# 0008. Base branch: per-branch choice, then setting, then auto-detect

- Status: Accepted
- Date: 2026-11-12 (`a9db0dc`), refined 2026-11-13 (`1a395ec`); reconstructed from code and history
- Code: `src/tracker.ts` (`baseFor`, `setBranchBase`), `src/git/repo.ts` (`resolveBase`, `orderBaseCandidates`)

## Context
`main` is not always the right base. Teams with target branches (release branches, `develop`, stacked feature branches) compare different branches against different bases. A single setting means editing it on every branch switch.

## Decision
The base is resolved per repository in this order:

1. The ref chosen for this repo + branch. It is stored in `workspaceState` and set through the Settings panel or *Select Base Branch*.
2. The `antiVibe.baseBranch` setting.
3. Auto-detect: `origin/HEAD`'s target, `main`, `master`, `origin/main`, `origin/master`, `develop`. The first that shares history with `HEAD` wins.

Candidate existence is checked with a single `git for-each-ref` call.

## Alternatives considered
- **Read the upstream / PR target from the hosting service.** This needs network access and credentials, and the privacy promise rules it out.
- **Use the branch's configured upstream** (`@{upstream}`). That is usually the branch's own remote copy, not its target.

## Consequences
- Switching branches restores each branch's own base.
- A configured base that doesn't share history yields a clear error in the Overview instead of a silent fallback.
- Scores are keyed by branch, not by base, so changing the base never loses progress.

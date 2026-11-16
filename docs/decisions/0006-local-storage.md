# 0006. Store progress locally in workspaceState, per repo and branch

- Status: Accepted
- Date: 2026-11-10 (initial commit `3552912`); reconstructed from code and history
- Code: `src/tracking/store.ts`, `src/tracker.ts` (branch bases)

## Context
Review progress is personal and tied to a branch. It must survive restarts, must not end up in the repository or in commits, and must not leave the machine.

## Decision
- Scores are kept in memory and written to `context.workspaceState` under `antiVibe.v1:<normRoot>::<branch>` as `{ path: { lineKey: score } }`. Writes are debounced (3 s) and flushed on deactivate.
- Per-branch base choices go to `workspaceState` under `antiVibe.branchBases`.
- The colours on/off choice goes to `globalState`.

## Alternatives considered
- **A file in `.git/`** (e.g. `.git/anti-vibe.json`). It survives VS Code profile changes, but writes into the user's repo, breaks with worktrees, and is invisible to VS Code's storage lifecycle.
- **A file in the workspace.** It would risk getting committed.
- **Sync across machines** (settings sync, a server). Not wanted. It is a privacy promise in the README.

## Consequences
- Progress is per workspace: opening the same repo through a different folder or workspace starts fresh.
- Data of deleted branches is never cleaned up (small, but unbounded). A future cleanup could drop keys whose branch no longer exists.
- The `v1` prefix leaves room for a format migration.

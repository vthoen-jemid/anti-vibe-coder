# 0007. Talk to git through the CLI, not the built-in Git extension API

- Status: Accepted
- Date: 2026-11-10 (initial commit `3552912`); reconstructed from code and history
- Code: `src/git/git.ts`, `src/git/repo.ts`, `src/git/catFile.ts`

## Context
The extension needs: the current branch, merge-base resolution with fallbacks, the files changed against an arbitrary commit, untracked files, file content at a commit, ignore checks, and a branch list.

## Decision
Spawn `git` directly (`execFile`, plus one long-lived `cat-file --batch`, [ADR 0010](0010-persistent-cat-file.md)). `git/repo.ts` has no `vscode` dependency.

## Alternatives considered
- **`vscode.git` extension API.** It exposes repository state and `show`, but it is tied to that extension being enabled and activated. It has no merge-base fallback logic, no batch content reads, and its API surface has changed between versions.
- **A JS git implementation** (isomorphic-git, nodegit). A big dependency, slower than native git on large repos, and it would have to reimplement `.gitignore` and worktree handling.

## Consequences
- `git` must be on `PATH` (documented in the README).
- The git layer is tested against real temporary repositories (`test/git.test.ts`).
- Process spawns are the main cost on Windows (tens of ms each). Keeping their number low is a performance concern ([ADR 0010](0010-persistent-cat-file.md), [ADR 0011](0011-targeted-invalidation.md)).

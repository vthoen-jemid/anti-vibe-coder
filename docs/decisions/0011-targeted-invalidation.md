# 0011. Targeted invalidation, file-event triage and incremental repaint

- Status: Accepted
- Date: 2026-11-13 (branch `perf-and-docs`)
- Code: `src/tracker.ts` (`doRefresh`, `onFileEvent`, `sync`, `fireSoon`), `src/git/repo.ts` (`refresh`), `src/ui/decorations.ts`, `src/ui/changesTree.ts`

## Context
Three patterns made the extension do far more work than needed:

1. **Any refresh that changed the *set* of changed files dropped every cached file state.** Creating one new file, or the first save of a file from main, meant re-reading, re-loading the base of, and re-diffing every changed file.
2. **Every file-system event triggered a full refresh.** That includes build output (`npm run watch` writing `dist/`), `.git/index` updates, and saves of files already in the diff. A full refresh was ~11 sequential git spawns (~1 s on Windows).
3. **Every change event repainted every visible editor with all 11 decoration types** (11 IPC calls per editor), about once per second while reading. Edits in files outside the diff also scheduled git refreshes that could never find anything, because git only sees saved content.

## Decision
- `Repo.refresh()` returns `{ baseChanged, added, removed }`. Per-repo state is invalidated only when the branch, base ref, merge-base or readiness changed. Added files get state, and removed files are dropped.
- Refresh itself takes 3–4 sequential git rounds:
  - one `for-each-ref` instead of up to six `rev-parse --verify` calls
  - `diff` and `ls-files` in parallel
  - repo roots cached per workspace folder
- `Tracker.onFileEvent` triages watcher and save events (the table is in [ARCHITECTURE.md](../ARCHITECTURE.md#a-file-changes-on-disk)):
  - git-state files (`HEAD`, refs, `index`, `info/exclude`) trigger a refresh
  - changed files are re-read alone
  - other paths are batched into one `git check-ignore --stdin` call, and a refresh happens only for non-ignored paths
  - deletes trigger a refresh only when they remove a changed file, or a folder that contains one (VS Code reports a deleted folder as a single event)
  - while a repo is in an error state, any event schedules a slow refresh, so it can recover
- A stat computation that was in flight while a refresh moved the merge-base is discarded. Disk-state tags include the merge-base, so a state computed against an old base is never reused.
- File reads during a refresh are limited to 16 at a time.
- Change events carry `{ docs: Set<uri> | 'all' }`. The painter repaints only the named editors, and only the decoration types whose line set changed. It caches per-line buckets per `TextEditor`, trusted only for the same document version, because VS Code moves decorations on edits.
- Totals are computed once per event (`getTotals`). The tree fires only when a signature of what it renders changed.

## Alternatives considered
- **Narrow the watcher glob or rely on `files.watcherExclude`.** Ignored files differ per repo and the user's settings vary. Asking git is exact.
- **Debounce harder.** It reduces frequency but not cost, and makes the UI feel laggy.
- **Diff the decoration ranges per bucket instead of per line.** Same result, more allocation.

## Consequences
- Several paths now update state without a full refresh, so their correctness matters more. A forced *Refresh* and window focus still do a full refresh as a safety net. An independent review of this change found five such gaps, all fixed before merging: folder deletes, `.git/index` / `info/exclude` changes, the merge-base race above, unlimited concurrency in the batched re-read, and recovery from an error state.
- `.git/index` is written by other tools too (VS Code's own `git status`, for example), so saves still cause some refreshes. Each one is ~0.4 s of background git work and never blocks the UI.
- A file reverted to its base content while closed stays in the diff until the next full refresh. It has no new lines, so it doesn't show in the Overview.
- The change event shape is part of the internal API. New listeners must handle `'all'`, a set, and an empty set (stats only).

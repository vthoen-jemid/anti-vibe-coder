# 0010. Read base versions through one persistent `git cat-file --batch`

- Status: Accepted
- Date: 2026-11-13 (branch `perf-and-docs`)
- Code: `src/git/catFile.ts`, `src/git/repo.ts` (`showAt`, `loadBase`)

## Context
To know which lines are new, every changed file needs its merge-base version. The extension ran one `git show <mb>:<path>` per file, all at once. On Windows a git spawn costs tens of milliseconds, and a branch with 300 changed files started 300 processes. The benchmark measured 9.2–10.5 s to load 300 base versions, on every activation and every merge-base change.

## Decision
- Each `Repo` owns a `CatFile`: one `git cat-file --batch` process, started lazily. Requests (`<mb>:<path>\n`) are written to its stdin, and responses are parsed from stdout in order.
- Response formats:
  - `<oid> <type> <size>\n<bytes>\n`, with the size counted in bytes and parsed from a Buffer
  - `<name> missing\n` for a file that didn't exist at that commit
- Non-blobs and blobs over 8 MB are skipped without keeping the bytes in memory.
- The process stops after 60 s idle by closing stdin; kill is only a fallback after 2 s. Closing stdin also works when `git` is a launcher that started the real git as a child process (Git for Windows).
- A crash or spawn failure rejects the requests in flight. `showAt` then falls back to `git show` for that file, and the next read starts a new process.
- Paths containing CR/LF can't be sent on one line, so they always use `git show`.
- `loadBase` caches base content as lines, per merge-base.

## Alternatives considered
- **Limit concurrency of `git show`.** Fewer processes at once, but the same number of spawns: still seconds for large branches.
- **`git archive` / `git ls-tree` + reading objects.** More complex, no benefit over cat-file.
- **`--batch-command` / `--buffer`.** Needs newer git versions; plain `--batch` is supported everywhere.

## Consequences
- Loading 300 base versions: 9–10.5 s → ~0.45 s. 50 files: 1.4 s → ~0.14 s (see [PERFORMANCE.md](../PERFORMANCE.md)).
- One extra long-lived process per repo while the user is active. It has to be disposed with the repo; `Tracker.dispose` and repo removal do this.
- Tests and benchmarks that delete the repo directory must do so asynchronously. The process only sees EOF once the event loop runs (`fs.promises.rm`, not `fs.rmSync`).

# Performance

The extension runs in the shared extension host. A slow handler there delays every other extension, and a busy one drains laptop batteries. This document lists the hot paths, what each one may cost, and how to measure them.

## Hot paths and budgets

| Path | How often | Budget | What it does |
| --- | --- | --- | --- |
| Signal tick | 1×/s while focused and active | < 1 ms | Visible lines → deltas → `bumpMany` on a cached `FileState` |
| Repaint after a tick | 1×/s per affected editor | < 1 ms + 1–2 `setDecorations` | Bucket per line, then only the changed decoration types |
| Keystroke | per document version | < 10 ms for 10k lines | Line keys (once) + `computeNewLines` + repaint of that editor |
| File event | per watcher event | ~0 (batched) | Triage; at most one `check-ignore` per 0.5 s burst |
| Full refresh | activation, focus, branch/commit changes | < 0.5 s, off the UI path | 3–4 git rounds + stats for changed files (mtime-cached) |
| Base change (new merge-base) | branch switch, merge, base change | ≈ 0.5 s for 300 files | Re-read all base versions through cat-file, re-diff |

Rules of thumb:

- Nothing on a per-second or per-keystroke path may spawn a process or touch the disk.
- Anything proportional to the number of changed files must be cached, or batched through one process.
- An event only repaints the editors it names (see [ARCHITECTURE.md → The change event](ARCHITECTURE.md#the-change-event)).

## Benchmarks

`npm run bench` (or `npm run bench -- --quick`) runs `test/perf/bench.ts`:

- **Pure logic** on synthetic files: line keys, and `computeNewLines` for a small edit, 30% of lines rewritten at random positions, and a full rewrite.
- **Git** against a throw-away repository in the OS temp folder, with 50 / 300 changed files of 200 lines: `Repo.refresh`, and loading every base version with one `git show` per file (the old way) vs `Repo.loadBase` (cat-file).

### Results

Windows 11, Node 24, git 2.56 (Git for Windows). Before = `main` at `479f867`; after = branch `perf-and-docs`.

| Benchmark | Before | After |
| --- | --- | --- |
| line keys, 10k lines | 4.8 ms | 4.4 ms |
| line keys, 50k lines | 29 ms | 22 ms |
| new lines, 1k lines, 30% rewritten | 27 ms | 3.6 ms |
| new lines, 10k lines, small edit | 0.9 ms | 0.7 ms |
| new lines, 10k lines, 30% rewritten | **2,384 ms** | **5.5 ms** |
| new lines, 10k lines, fully rewritten | **12,297 ms** | **3.5 ms** |
| new lines, 50k lines, small edit | 6.2 ms | 4.6 ms |
| new lines, 50k lines, 30% rewritten | **107,707 ms** | **29 ms** |
| `Repo.refresh` (auto-detect base) | 1,061 ms | 443 ms |
| load 50 base versions | 1,398 ms | 138 ms |
| load 300 base versions | **10,541 ms** | **425 ms** |

The marked-new line counts in every case are identical before and after. Git timings vary by ±10% between runs.

Effects that the benchmark doesn't capture (they come from triage and incremental repaint, [ADR 0011](decisions/0011-targeted-invalidation.md)):

- **Build output, `.git/index` updates and saves of files already in the diff** no longer trigger a git refresh. Build output costs at most one `git check-ignore` per burst; saves cost none.
- **A new file joining the diff** no longer re-reads and re-diffs every other changed file.
- **The 1 Hz reading tick** repaints only the editor(s) whose scores changed, and only the 1–2 colour steps that changed, instead of 11 `setDecorations` calls per visible editor.
- **The Overview tree** re-renders only when a percentage, category or line count changes.

## Profiling the extension in VS Code

1. Start the Extension Development Host (F5, see [DEVELOPMENT.md](DEVELOPMENT.md)).
2. In that window: **Developer: Show Running Extensions**. It lists activation time and flags extensions that block the host.
3. Click **Start Extension Host Profile**, use the scenario (scroll a big file, type, switch branches), then **Stop**. Save the `.cpuprofile` and open it in VS Code or Chrome DevTools. Look for `computeNewLines`, `computeLineKeys`, `paint` and `doRefresh`.
4. To count git processes during a scenario on Windows, run this in a terminal:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Select ProcessId, CommandLine
   ```
   On macOS/Linux, use `ps -ef | grep git`.

## Known remaining costs

- Line keys are a full-file hash per document version (~4 ms per 10k lines). This could be made incremental using the edit ranges, but it isn't worth it below ~50k lines.
- A full refresh still runs on every window focus, to catch commits and edits made outside VS Code. It costs ~0.4 s of background git work, with no UI blocking.
- Disk files are read in full when their mtime changes. Files over 1.5 MB are skipped.

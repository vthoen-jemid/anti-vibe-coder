# Development

## Requirements

- Node.js 18+ (the bundle targets `node18`; development has been done on Node 24)
- `git` on `PATH`
- VS Code 1.90+

## Commands

```sh
npm install
npm run compile      # bundle src/extension.ts → dist/extension.js (esbuild, with source maps)
npm run watch        # same, rebuild on change
npm run typecheck    # tsc --noEmit over src/ and test/
npm test             # compile tests to out/ and run mocha on out/test/**/*.test.js
npm run bench        # performance benchmarks (add `-- --quick` to skip the slowest cases)
npm run package      # production bundle + anti-vibe-coder.vsix
```

The VSIX contains only `dist/extension.js`, `media/`, `package.json`, `README.md` and `LICENSE` (see `.vscodeignore`). `docs/`, `src/` and `test/` are never shipped. Check with `npx vsce ls`.

## Running and debugging

Press **F5** in VS Code. `.vscode/launch.json` builds first, then starts an Extension Development Host with the extension loaded. Breakpoints work in the TypeScript sources through the source maps. Open a git repository on a branch with changes in the host window to see colours.

The *npm: package (vsix)* build task in `.vscode/tasks.json` produces the VSIX from the editor.

## Tests

| File | Covers |
| --- | --- |
| `test/tracking.test.ts` | line keys, scoring, categories, colours, the reading band (`focusLines`) |
| `test/newLines.test.ts` | the line diff: in-order validity, near-optimality against Myers on random edits, moved blocks, the large-file fallback, CRLF |
| `test/git.test.ts` | the cat-file stream parser, base-candidate ordering, the concurrency limiter, and `Repo` / `CatFile` against a real temporary repository |

The tests run in plain Node: only modules without a `vscode` import are tested (`tracking/*`, `git/*`, `ui/color.ts`, `util/*`). The tracker, signals and UI are verified manually in the Extension Development Host. Use this checklist after changes there:

- Colours appear on a branch with changes. Reading, cursor, selection, hover and typing turn lines pink.
- Pasting a large block stays blue. Typing a few characters keeps a line's colour.
- Committing keeps progress. Switching branch, or changing the base, recomputes everything.
- Creating a new file adds it to the Overview without resetting other files' progress.
- `npm run watch` (writing to the ignored `dist/`) does not trigger refreshes.
- *Open All Branch Changes*, *Go to Next Unreviewed Line*, *Mark Selection as Reviewed* and reset work.
- Hiding the colours hides them in every editor. Showing them restores them.

## Project layout

```
src/
  extension.ts          activation, commands, event wiring
  tracker.ts            central model: repos, per-file state, stats, change events
  config.ts             typed view of the antiVibe.* settings
  settingsIO.ts         export / import / reset of settings
  git/                  git CLI wrapper, Repo (branch, base, changed files), cat-file reader
  tracking/             line identity, new-line diff, scoring, reading band, signals, storage
  ui/                   decorations, Overview tree, Settings webview, status bar, base documents
  util/                 small helpers (concurrency limit)
test/                   mocha unit tests for the vscode-free modules
test/perf/bench.ts      benchmarks (npm run bench)
docs/                   this documentation
```

## Conventions

- Keep `git/` and `tracking/` free of `vscode` imports so they stay testable in plain Node.
- Comments explain *why*, not *what*. Public classes and functions have a doc comment.
- Every user-visible behaviour change updates [FEATURES.md](FEATURES.md). Hot-path changes come with benchmark numbers in [PERFORMANCE.md](PERFORMANCE.md). Decisions with real alternatives get an [ADR](decisions/README.md).
- Run `npm run typecheck` and `npm test` before opening a PR.

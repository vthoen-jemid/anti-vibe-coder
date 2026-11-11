# Anti-Vibe Coder

> A VS Code extension that shows which code on your branch you've actually reviewed. New lines start **blue** and turn **pink** the longer you look at them.

AI assistants write a lot of code quickly. Reviewing it is the hard part: after a few commits you no longer know which lines you've read and which you only scrolled past. Anti-Vibe Coder compares your whole branch with `main` and keeps track, line by line, of what you have looked at.

## How it works

- Every line that is **new or changed on your branch** gets a background colour. The comparison is against the merge-base with `main` and includes uncommitted and untracked files.
- **Blue** means you have barely seen the line. Reading it, putting your cursor on it, selecting it or hovering over it turns it gradually **pink**.
- **Progress survives commits.** A line keeps its colour when code is inserted above it, because progress is tied to the line's *content* and not its line number.
- **Changed code turns blue again.** When a line you already reviewed is rewritten (for example by an AI tool), it needs a fresh look.
- **Code you type yourself turns pink on its own.** Small edits in the active editor keep the line's progress and add to it. Large pastes and changes written to disk by other tools don't.

## Features

- **Line colours** on a blue → pink gradient. The scrollbar (overview ruler) shows where blue lines remain.
- **Overview sidebar** that splits the changed files into **Unseen**, **Partially seen** and **Fully seen**, with the number of lines left to review.
- **Settings panel**: a collapsible block at the bottom of the sidebar with a slider for each signal, so you can tune how much each one counts.
- **Open All Branch Changes**: one multi-file diff of the whole branch against its base.
- **Go to Next Unreviewed Line** (`Ctrl+Alt+N` / `Cmd+Alt+N`): jumps to the next blue line, across files.
- **Show/Hide Review Colors**: eye button in the editor title bar (top right, also in Source Control diffs) or `Ctrl+Alt+H` / `Cmd+Alt+H`. Tracking keeps running while the colours are hidden, and the choice is remembered.
- **Mark Selection as Reviewed** (`Ctrl+Alt+R` / `Cmd+Alt+R`) for code you've checked by other means.
- **Status bar** showing progress for the whole branch, e.g. `👁 42% reviewed`.

## What counts as "seen"

| Signal | Meaning | Setting |
| --- | --- | --- |
| Reading (code on screen) | Time a line spends in the **reading area**: a band in the middle of the editor (30% by default), never the whole screen. Near the top or bottom of a file the band moves to that edge; in a file that fits on screen it follows the cursor. Doesn't count while you scroll fast | `antiVibe.signals.viewport.*` |
| Cursor on a line | Time the cursor sits on a line (neighbouring lines get half). Can be set to instant | `antiVibe.signals.cursor.*` |
| Selecting lines | Time code is selected (mouse, Shift+arrows, Ctrl+A/L/D). Can be set to instant | `antiVibe.signals.selection.*` |
| Mouse hover | The mouse resting over code | `antiVibe.signals.hover.*` |
| Typed by you | Small edits you make in the active editor | `antiVibe.signals.typing.*` |

Nothing counts while the VS Code window is unfocused or you've been idle longer than `antiVibe.idleTimeoutSeconds`. Every signal can be switched off or tuned in the sidebar's **Settings** block or in your VS Code settings. The sliders show how long (or how many hovers or edits) it takes for a line to become fully seen. You can also type an exact value.

### Sharing settings

Use **Export…** in the Settings block (or **Anti-Vibe Coder: Export Settings…**) to save your settings as a JSON file, and **Import…** to load one. The file uses the normal setting ids, so you can also paste its contents into a `settings.json`. `antiVibe.baseBranch` is not included, because it belongs to one repository.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `antiVibe.baseBranch` | *(auto)* | Branch to compare against. Empty means auto-detect: `origin/HEAD`, then `main`, then `master` |
| `antiVibe.signals.<signal>.enabled` | `true` | Turn a signal on or off |
| `antiVibe.signals.<signal>.weight` | varies | How much the signal counts per second or per event (1.0 = fully seen; for cursor, selection and hover, 1.0 means instant) |
| `antiVibe.signals.viewport.focusArea` | `0.3` | Reading area: part of the editor height that counts as being read (1 = whole screen) |
| `antiVibe.signals.typing.maxChars` | `80` | Edits larger than this don't count as your own typing |
| `antiVibe.idleTimeoutSeconds` | `60` | Stop counting after this long without activity |
| `antiVibe.reviewedThreshold` | `0.8` | Line progress at which a line counts as fully seen (full seen colour, skipped by Next Unreviewed) |
| `antiVibe.partiallySeenThreshold` | `0.1` | Average file progress at which a file moves from Unseen to Partially seen |
| `antiVibe.colors.unseen` / `antiVibe.colors.seen` | blue / pink | Gradient colours (`rgba()` or `#hex`) |
| `antiVibe.hideWhenFullyReviewed` | `false` | Remove the colour once a line is fully seen |
| `antiVibe.ignoreWhitespaceOnlyLines` | `true` | Don't track empty lines |

## Installation

The extension is not on the Marketplace yet. Build it from source:

```sh
git clone https://github.com/<your-account>/anti-vibe-coder.git
cd anti-vibe-coder
npm install
npm run package
```

In VS Code, run **Extensions: Install from VSIX…** and pick the generated `anti-vibe-coder-<version>.vsix`.

Requirements: VS Code 1.90 or newer, and `git` on your `PATH`.

## Privacy

Review progress is stored **locally** in VS Code's workspace state, per repository and per branch. Nothing is written to your repository, and nothing leaves your machine.

## Limitations

- VS Code doesn't give extensions the raw mouse position, so hovering only registers when the mouse rests over code (the same moment a hover tooltip would appear).
- Telling your own typing apart from tool edits is a heuristic. A small edit in the focused active editor counts as yours.
- Cutting a block and pasting it elsewhere counts as new code.

## Development

```sh
npm install
npm run compile     # bundle to dist/
npm run watch       # rebuild on change
npm test            # unit tests (mocha)
npm run typecheck
```

Press **F5** in VS Code to start an Extension Development Host with the extension loaded.

```
src/
  extension.ts          activation, commands, event wiring
  tracker.ts            central model: repos, per-file state, scores
  git/                  git CLI wrapper, merge-base and changed files
  tracking/             line identity, diffing, scoring, signals, storage
  ui/                   decorations, overview tree, settings webview, status bar
test/                   unit tests for the pure logic
```

## Contributing

Issues and pull requests are welcome. Please run `npm test` and `npm run typecheck` before opening a PR.

## License

MIT — see the `LICENSE` file.

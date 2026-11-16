# Features reference

The complete behaviour of Anti-Vibe Coder: what a user sees and the exact rules behind it. For the *why*, follow the ADR links.

## What gets tracked

- **Which files.** Everything that differs between the working tree and the **merge-base** of `HEAD` with the base branch:
  - committed, staged and unstaged changes (`git diff --name-only <merge-base>`)
  - untracked files that are not ignored (`git ls-files --others --exclude-standard`)

  Deleted files are not shown. Renames count as a new file. See [ADR 0002](decisions/0002-compare-against-merge-base.md).
- **Which lines.** Lines of those files that are added or modified compared to the merge-base version. The comparison ignores CRLF/LF differences. Empty and whitespace-only lines are skipped by default (`antiVibe.ignoreWhitespaceOnlyLines`). A file that does not exist at the merge-base is new in full.
- **Limits.**
  - Files over 1.5 MB on disk are skipped.
  - Binary files (a NUL byte in the first 8000 bytes) are skipped.
  - A base version over 8 MB is treated as absent.
  - Only `file:` documents are tracked. Diff editors show colours on their working-tree side, because that side is a regular file.

## Base branch

The base is resolved per repository, in this order ([ADR 0008](decisions/0008-per-branch-base.md)):

1. **Chosen for this branch**, with *Select Base Branch* or the *Compare against* field in the Settings panel. It is remembered per repository + branch, so switching back to a branch restores its base.
2. **The `antiVibe.baseBranch` setting.**
3. **Auto-detect**: the target of `origin/HEAD`, then `main`, `master`, `origin/main`, `origin/master`, `develop`. The first candidate that shares history with `HEAD` wins.

When no candidate shares history with `HEAD`, the Overview shows why. A shallow clone gets a hint to run `git fetch --unshallow`. Choosing a different base recomputes everything. Scores are not lost, because they are keyed by branch, not by base.

## Line progress and colours

Every new line has a score from 0 (unseen) to 1 ([ADR 0003](decisions/0003-score-model.md)). Signals add to it (next section). The colour is a gradient from `antiVibe.colors.unseen` (blue) to `antiVibe.colors.seen` (pink) in 11 steps ([ADR 0009](decisions/0009-bucketed-decorations.md)). The gradient is scaled so a line reaches full pink at `antiVibe.reviewedThreshold` (default 0.8, "fully seen").

- The colour covers the whole line, with a stronger 3 px stripe on its left edge and a mark in the left lane of the scrollbar (overview ruler).
- `antiVibe.hideWhenFullyReviewed` removes the colour from fully seen lines.
- **Progress follows content** ([ADR 0001](decisions/0001-content-keyed-line-identity.md)):
  - Inserting code above a line keeps its colour, and so does committing it.
  - Rewriting a line, by you or by a tool, makes it a different line, which starts blue. The typing exception is described below.
  - Two identical lines in one file are told apart by order. When the first copy is deleted, the second one takes over the first one's score.
- **Pruning.** When a file is saved (or re-read from disk), scores of lines that no longer exist are deleted.

## Signals: what counts as seeing a line

Nothing counts while the VS Code window is unfocused, or after `antiVibe.idleTimeoutSeconds` (default 60) without any activity. Activity is a selection or cursor move, scrolling, switching editors, an edit, focusing the window, or a hover. See [ADR 0004](decisions/0004-review-signals.md).

| Signal | When | Increment |
| --- | --- | --- |
| **Reading** (`viewport`) | Every second, for every visible editor whose visible ranges haven't changed for 0.7 s (so fast scrolling doesn't count) | `weight` × 1 s to every line in the reading band. Editors other than the active one get half. With more than 40 lines in the band, the increment is scaled by `40 / lines`. |
| **Cursor** | Every second, active editor only, empty selections | `weight` to the cursor line, half to the 2 lines above and below |
| **Selection** | Every second, active editor only, selections of at most 200 lines | `weight` to every selected line |
| **Hover** | When VS Code asks for a hover (after `editor.hover.delay`, only if `editor.hover.enabled`) | `weight` to that line. No popup is ever shown. |
| **Typing** | On each edit that looks like your own typing (see below) | `weight` to the edited lines, on top of the score they had |

**Instant mode.** A cursor or selection weight of 1.0 or more means "instant". The line scores fully the moment you click it or select it, instead of on the next tick. Only mouse and keyboard moves count for the cursor, so *Go to Line* or *Go to Next Unreviewed Line* don't mark the target as seen. Commands such as Ctrl+A, Ctrl+L and Ctrl+D do count for selections.

**The reading band** (`antiVibe.signals.viewport.focusArea`, default 0.3) is the middle 30% of the visible lines ([tracking/focus.ts](../src/tracking/focus.ts)):

- Near the top or bottom of a file, where a line can't be scrolled into the middle, the band slides to that edge. Scrolling one line then moves the band two lines, so no line is skipped.
- In a file that barely scrolls, the band follows the cursor while the cursor is visible. Otherwise it sweeps from top to bottom as you scroll.
- `1` means the whole screen.

**Typing heuristic** ([ADR 0005](decisions/0005-typing-heuristic.md)). An edit counts as yours when all of these are true:

- the typing signal is enabled
- the document is the active editor's and the window is focused
- the edit made the document dirty
- the edit follows directly on the version the extension last saw
- every change inserts at most `antiVibe.signals.typing.maxChars` characters (default 80) and replaces at most `max(maxChars, 2000)` characters

The edited line's previous score is then carried over to its new content, plus the typing weight. Anything else keeps the new content at 0: pastes, AI insertions, formatters, files written to disk.

## Overview (sidebar)

The *Anti-Vibe Coder* activity bar container has two views.

**Overview** groups changed files (with one repo node per repository in a multi-root workspace):

| Group | Rule |
| --- | --- |
| **Unseen** | mean line score < `antiVibe.partiallySeenThreshold` (default 0.1) |
| **Partially seen** | everything in between |
| **Fully seen** | every new line ≥ `antiVibe.reviewedThreshold` (collapsed by default) |

- Within a group, files are ordered least reviewed first, then by path.
- Each file shows its percentage and folder. The tooltip has the counts and flags untracked files.
- Group descriptions show "N of M lines to go".
- The view title shows the branch-wide percentage.
- Clicking a file opens it (preview) at its first unreviewed line, or its first new line.
- Inline action: *Open Diff with Base*. Context menu: *Reset Review Progress for File*.

Title-bar actions:

- *Open All Branch Changes*
- *Go to Next Unreviewed Line*
- *Show/Hide Review Colors*
- *Refresh*

Overflow menu:

- *Select Base Branch*
- *Reset Review Progress for Branch*
- *Open Settings*
- *Export Settings…* and *Import Settings…*

**Settings** is a collapsible webview with these sections:

- **Compare against**: the base per repository, with a branch list.
- **How code becomes seen**: one slider per signal. Sliders show "time / number of hovers / edits until a line is fully seen", which is the inverse of the stored weight. The top step is *instant* where supported.
- **Seen levels**: the two thresholds.
- **General**: idle timeout, colours and opacity, *hide when fully seen*, Export/Import, *Reset to defaults*, and *Open in Settings* (the Settings editor filtered to this extension).

Changes are written to user settings 300 ms after the last change.

## Commands and keybindings

| Command | Keybinding | Notes |
| --- | --- | --- |
| Anti-Vibe Coder: Refresh | | Re-reads git state and all files. |
| Open All Branch Changes | | One multi-file diff editor (`vscode.changes`) of every changed file against the merge-base, least reviewed first. |
| Open Diff with Base | | Tree inline action. Diff of one file against the merge-base (`antivibe-base:` document). |
| Go to Next Unreviewed Line | `Ctrl+Alt+N` / `Cmd+Alt+N` | The next new line below the cursor that is under the fully-seen threshold. Then the next file in Overview order that has unreviewed lines. Then wraps to the top of the current file. Says 🎉 when everything is reviewed. |
| Mark Selection as Reviewed | `Ctrl+Alt+R` / `Cmd+Alt+R` | Sets selected new lines to 1. Also in the editor context menu. |
| Mark Selection as Unreviewed | | Sets selected new lines to 0. |
| Reset Review Progress for File | | From the tree, or for the active file. |
| Reset Review Progress for Branch | | Asks for confirmation. |
| Select Base Branch | | Quick pick: *Default*, any branch, or type a ref (branch, tag, commit). |
| Toggle Review Colors | `Ctrl+Alt+H` / `Cmd+Alt+H` | Tracking keeps running while colours are hidden. The choice is remembered globally. |
| Hide / Show Review Colors | | The eye button in the editor title bar (whenever a repo is tracked) and in the Overview title. |
| Open Settings | | Focuses the Settings view. |
| Export Settings… / Import Settings… | | See below. |

## Status bar

`$(eye) 42% reviewed` is the sum of line scores divided by the number of new lines across all repos. The tooltip shows lines, files and `branch ↔ base`. Clicking it focuses the Overview. It is hidden when no repo is tracked.

## Export, import and reset

- **Export** writes every shareable setting to a JSON file with full ids (`"antiVibe.signals.cursor.weight": 0.2`), so it can be pasted into `settings.json`.
- **Import** accepts that format, keys without the `antiVibe.` prefix, or a nested `{ "antiVibe": { … } }`. Unknown keys and values whose type doesn't match the default are skipped and listed. Values are written to user settings.
- **Reset to defaults** clears the shareable settings at user and workspace level.
- `antiVibe.baseBranch` is never exported, imported or reset: it belongs to one repository.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `antiVibe.baseBranch` | `""` | Default base. Empty = auto-detect. A per-branch choice wins. |
| `antiVibe.signals.viewport.enabled` / `.weight` | `true` / `0.03` | Reading: score per second in the band (0.03 ≈ 33 s to fully seen at full weight). |
| `antiVibe.signals.viewport.focusArea` | `0.3` | Height of the reading band as a fraction of the visible lines (0.05–1). |
| `antiVibe.signals.cursor.enabled` / `.weight` | `true` / `0.2` | Per second on the cursor line; ≥ 1 = instant. |
| `antiVibe.signals.selection.enabled` / `.weight` | `true` / `0.1` | Per second per selected line; ≥ 1 = instant. |
| `antiVibe.signals.hover.enabled` / `.weight` | `true` / `0.15` | Per hover; ≥ 1 = instant. |
| `antiVibe.signals.typing.enabled` / `.weight` | `true` / `0.25` | Per keystroke-sized edit. |
| `antiVibe.signals.typing.maxChars` | `80` | Larger insertions are not your own typing. |
| `antiVibe.idleTimeoutSeconds` | `60` | Pause signals after this much inactivity (min 5). |
| `antiVibe.reviewedThreshold` | `0.8` | Score at which a line is fully seen (full colour, skipped by *Next Unreviewed*). |
| `antiVibe.partiallySeenThreshold` | `0.1` | Mean file score at which a file moves from Unseen to Partially seen. |
| `antiVibe.colors.unseen` / `.seen` | blue / pink `rgba(…)` | Gradient ends (`rgb()`, `rgba()`, `#rgb`, `#rrggbb`, `#rrggbbaa`). |
| `antiVibe.hideWhenFullyReviewed` | `false` | No colour on fully seen lines. |
| `antiVibe.ignoreWhitespaceOnlyLines` | `true` | Don't track empty / whitespace-only lines. |

## Known limitations

- VS Code doesn't expose the mouse position, so a hover registers only when the mouse rests long enough for a hover tooltip.
- The typing heuristic can be fooled: a small edit by an extension in the focused editor counts as yours.
- Cut + paste of a block counts as new code (it is a large insertion).
- An unsaved edit in a file that is not part of the diff yet is not tracked until the file is saved, because git only sees what is on disk.
- Scores are kept per branch forever. Data of deleted branches is not cleaned up yet (it is small: one number per reviewed line).
- In files that were largely rewritten, the diff trades optimality for speed. It may mark a few lines as new that an optimal diff would match ([ADR 0012](decisions/0012-fast-line-diff.md)).

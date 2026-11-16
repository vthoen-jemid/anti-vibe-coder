# 0005. Small edits in the focused editor count as the user's typing

- Status: Accepted
- Date: 2026-11-10 (initial commit `3552912`); reconstructed from code and history
- Code: `src/tracker.ts` (`onDocumentChanged`)

## Context
Content-keyed identity ([ADR 0001](0001-content-keyed-line-identity.md)) makes every edited line a new, blue line. For code the user types themselves that is wrong: they know it. For code an AI tool inserts it is exactly right. VS Code doesn't say who made an edit.

## Decision
An edit counts as typing when all of these are true:

- the typing signal is enabled
- the window is focused and the document is the active editor's
- the edit made the document dirty
- the edit directly follows the version the extension last saw
- each change inserts ≤ `typing.maxChars` (80) characters and replaces ≤ `max(maxChars, 2000)`

For each change, the highest score among the replaced lines is carried over to the new keys, plus `typing.weight`.

## Alternatives considered
- **Never credit edits.** Users would have to re-review their own keystrokes.
- **Credit every edit in the active editor.** AI inline completions and pastes would turn pink.
- **Use undo-stop or command metadata.** Not exposed by the API.

## Consequences
- Pastes, AI insertions, formatters (large edits) and files changed on disk stay blue.
- Small automated edits in the focused editor (a quick fix, a short completion) are credited as typing. This is listed under known limitations.
- The keys of the previous version are kept per document (`keysCache`) for this transfer, and are reused by `getDocState`.

# 0004. Review signals: reading band, silent hover, selection kinds

- Status: Accepted
- Date: 2026-11-10, reading band 2026-11-11 (`223ce7e`, `9a61d81`); reconstructed from code and history
- Code: `src/tracking/signals.ts`, `src/tracking/focus.ts`

## Context
VS Code doesn't tell an extension where the user is looking. The available evidence is the visible ranges, the cursor and selections, hovers, and edits. Each one can be gamed or misread. The design aims for "hard to get wrong by accident", not "impossible to cheat".

## Decision
- **Reading band.** Only a band in the middle of the visible lines counts (30% by default), not the whole screen.
  - Near the file edges the band slides to the edge so every line is reachable.
  - In a file that barely scrolls, the band follows the cursor.
  - The viewport must be stable for 0.7 s before it counts, so fast scrolling doesn't.
  - Bands of more than 40 lines are damped.
  - Visible editors other than the active one get half weight.
- **One tick per second** collects viewport, cursor (±2 neighbours at half weight) and selection (≤ 200 lines) increments, and applies them per document in one `bumpMany`.
- **Hover** uses a `HoverProvider` that records the line and always returns `undefined`, so no popup ever appears. It is the only mouse-position signal VS Code offers.
- **Selection kinds.** Programmatic moves (no `kind`) never count, so *Go to Next Unreviewed* doesn't mark its target. Commands (Ctrl+A/L/D) count for selections but not for the cursor.
- **Instant mode.** A weight ≥ 1 for cursor or selection applies on the selection event itself rather than the next tick.
- **Idle and focus.** Nothing counts while the window is unfocused or after `idleTimeoutSeconds` without activity.

## Alternatives considered
- **The whole viewport counts.** Opening a file would make every visible line pink after half a minute of doing nothing. The band is the main defence against "it's on screen, so I read it".
- **Eye tracking / webcam.** Out of scope, invasive.
- **A visible hover with progress info.** Noisy, and it competes with language hovers.

## Consequences
- The tick runs every second while VS Code is focused and not idle. Per tick, the work is proportional to the visible lines. Score changes repaint only the affected editor ([ADR 0011](0011-targeted-invalidation.md)).
- Hovers depend on `editor.hover.enabled` and `editor.hover.delay`.
- `focusLines` is pure and unit-tested. Its behaviour is documented in [FEATURES.md](../FEATURES.md#signals-what-counts-as-seeing-a-line).

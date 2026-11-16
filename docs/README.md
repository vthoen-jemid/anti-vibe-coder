# Anti-Vibe Coder documentation

The [top-level README](../README.md) is the user-facing introduction. The documents here explain how the extension works and why it is built the way it is.

| Document | Read it when you want to… |
| --- | --- |
| [FEATURES.md](FEATURES.md) | know exactly what every command, view, signal and setting does, including the edge cases |
| [ARCHITECTURE.md](ARCHITECTURE.md) | find your way around the code: components, data flow, caching, persistence |
| [PERFORMANCE.md](PERFORMANCE.md) | understand the hot paths, their budgets and benchmark numbers, or profile a slowdown |
| [DEVELOPMENT.md](DEVELOPMENT.md) | build, test, benchmark, debug or package the extension |
| [decisions/](decisions/README.md) | understand *why* something is done a certain way before changing it (Architecture Decision Records) |

Suggested reading order for a new contributor: README → FEATURES → ARCHITECTURE → the ADRs that touch the area you are changing.

## Keeping the docs current

- A change in behaviour that a user can notice → update [FEATURES.md](FEATURES.md) (and the README if it is a headline feature).
- A new component, event or cache → update [ARCHITECTURE.md](ARCHITECTURE.md).
- A decision with real alternatives (a new dependency, a different algorithm, a storage format change) → add an ADR in [decisions/](decisions/README.md). Don't rewrite an accepted ADR: supersede it with a new one.
- A change on a hot path → run `npm run bench` before and after and update [PERFORMANCE.md](PERFORMANCE.md).

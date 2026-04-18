# Improvements — index

Three companion documents proposing concrete, prioritized improvements to fleet-safety-demo, each grounded in the actual codebase (not generic best practice) and cited against official sources.

| Doc | Focus | Length |
|-----|-------|--------|
| [frontend.md](./frontend.md) | React 19 + Vite SPA: SSE, types, perf, a11y, tests | ~20 recommendations |
| [backend.md](./backend.md) | FastAPI + YOLOv8 + LLM service: caching, observability, MLOps, compliance | ~20 recommendations |
| [integration.md](./integration.md) | FE↔BE↔cloud seam: SSE protocol, contracts, auth, HMAC, tracing | ~20 recommendations |

## How to read

Each doc opens with a **TL;DR** of the highest-leverage items, then a **P0 bugs** section (real defects found during analysis — fix-first), then prioritized strategic recommendations (P0/P1/P2), then a **90-day phased rollout**, then a **what I would NOT recommend** section (signals deliberate restraint).

Every recommendation follows the same template:

> **Pattern.** What to adopt.
> **Why for this project.** Anchored to specific files / behaviors observed in the codebase.
> **Adoption path.** Concrete file, snippet, or command.
> **Trade-off.** Cost, risk, or constraint.
> **Citation.** Official-doc URL.

## Confirmed P0 defects (fix this week)

| ID | Doc | File | Issue |
|----|-----|------|-------|
| **B1** | [integration.md](./integration.md#p0-bugs-found-during-review) | [server.py:1609,1618](../../road_safety/server.py#L1609) | Watchdog DELETE / POST-delete are unauthenticated — anyone reachable on the listening port can wipe operator state |
| **B2** | [backend.md](./backend.md#p0-bugs-found-during-review) | [services/llm.py](../../road_safety/services/llm.py) | `_HAIKU_BUCKET._lock = asyncio.Lock()` is bound to whichever loop happens to instantiate first; awaiting the bucket from the perception thread risks `RuntimeError: ... bound to a different event loop` on contended frames |
| **B3** | [backend.md](./backend.md#p0-bugs-found-during-review) | [server.py:883-885](../../road_safety/server.py#L883) | `state.recent_events.append/pop(0)` runs in the perception thread; SSE handlers concurrently iterate via `list(state.recent_events)`. Single ops are GIL-safe; the read+slice composite is not |

These are independent of the strategic improvements and should be fixed before any of the larger refactors land.

## Reading order for reviewers

1. This README (you are here).
2. [integration.md](./integration.md) — start here; it surfaces the confirmed bugs and the contract (OpenAPI / SSE protocol) that constrains both ends.
3. [backend.md](./backend.md) — heaviest doc; covers the AI/ML and observability surface where most senior-engineer judgment shows.
4. [frontend.md](./frontend.md) — focused on the React 19 patterns and the live-dashboard-specific concerns (SSE bursts, MJPEG, accessibility).

## Out of scope for these docs

- Restating what already works well — see [docs/architecture.md](../architecture.md) and [docs/challenges.md](../challenges.md) for the existing-decision rationale.
- Generic "add observability" / "add tests" platitudes — every recommendation here names the specific tool, file, and trade-off.
- Speculative features (DMS, FNOL clip export, ELD integration). Those are tracked in [challenges.md §8 Out of scope](../challenges.md) and intentionally left there.

## Conventions

- **Pri tags:** `[H]` ship this quarter · `[M]` next 2 quarters · `[L]` opportunistic / when calmer.
- **Effort:** rough engineer-days assuming familiarity with the codebase.
- **Citations:** prefer official docs (react.dev, fastapi.tiangolo.com, docs.anthropic.com, datatracker.ietf.org, owasp.org). Engineering-blog citations are flagged with the source.

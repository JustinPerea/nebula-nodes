# Plan 2.3.c — Implementation Notes

Running log of decisions, deviations, and tradeoffs for
`docs/superpowers/plans/2026-05-23-remotion-player-overlay-rotation-keyframes.md`.

## Plan authoring

### Decisions outside the spec

- Added a test-harness stabilization task before rotation/keyframe work. The
  feature baseline has 222/222 passing assertions, but `graphStore` opens the
  real backend WebSocket at module import. When the backend is running, jsdom /
  undici can raise unhandled WebSocket `Event` errors and make `npm test` exit
  1. Fixing that first keeps the full-suite gate deterministic.
- Kept rotation math in a pure helper before React wiring, matching the
  `coordinates.ts` and `resizeMath.ts` pattern from 2.3.a/b.
- Planned a pause after Rotation fields and before keyframe routing. The first
  four tasks complete the visible rotation surface; the remaining tasks alter
  store semantics and drag dispatch routing.

### Verification notes

- Baseline `npm run build`: exit 0 with pre-existing Vite chunk-size and Lottie
  direct-eval warnings.
- Baseline `npm test`: 28 files / 222 assertions pass, but Vitest exits 1 due
  the WebSocket unhandled errors described above.

## Task 1 — Test harness WebSocket isolation

### Decisions outside the spec

- Stubbed `globalThis.WebSocket` in the shared Vitest setup instead of mocking
  `wsClient` in each Remotion test. The import side effect is in `graphStore`,
  and most video tests import that store directly; a single setup stub keeps the
  suite hermetic without broad per-file mocks.
- The stub intentionally does not auto-fire `open` / `message` events. Current
  unit tests do not assert socket behavior, and silent no-op transport is enough
  to prevent real backend connections.

### Changes

- Added a minimal browser-compatible `MockWebSocket` with static ready-state
  constants and no-op `send` / `close` methods.

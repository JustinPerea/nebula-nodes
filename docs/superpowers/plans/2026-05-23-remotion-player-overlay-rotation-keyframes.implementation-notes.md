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

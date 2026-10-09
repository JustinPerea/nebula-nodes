# Canvas next steps — acceptance, 2026-10-09

Implemented on `codex/canvas-next-step-actions`, following the first two recommendations in the Flora interface comparison. This slice is local; it has not been merged or pushed.

## Behavior

- A selected current Image or Video result exposes **Add next step**. Older batch previews, unfinished results and unsynchronized local sources cannot silently connect a different artifact.
- The existing compatible-node picker adds **All compatible**, **Edit image** and **Use in video** intents, source context, shared catalog search and provider setup status. It remains bounded and scrolls large catalogs.
- Choosing a model confirms an atomic node-and-edge creation, selects the destination and opens its Inspector. Pending requests, rejected creation, changed sources and uncertain acknowledgements retain visible recovery state and cannot produce an unconfirmed success or duplicate retry.
- The pinned Inspector reserves actual navigation and drawer geometry, retains pin/drag/resize preferences and yields when a compact drawer covers the available canvas. Its fields remain scrollable in short windows.
- Preparation, provider discovery and navigation never submit generation. Existing results, connections and saved run history remain intact.

## Automated checks

- Full frontend suite: **1,761 tests in 167 files passed**.
- Focused atomic-create and node-contract backend suite: **34 tests passed**.
- Catalog contracts: **255 definitions passed**.
- Frontend lint/style guards, TypeScript, production build and bundle budget passed after the final picker sizing change.
- Regression coverage includes both wiring directions, early/late synchronization, uncertain response quarantine, source/replacement ownership, stale provider status, keyboard focus, drawer overlap and short-window layout.

## Browser and visual proof

The real frontend and backend code ran against a private synthetic logo workspace. The walkthrough selected the existing cyan logo, filtered video destinations, searched for Veo 3.1 and created its First Frame connection. The graph changed from three nodes/two edges to four nodes/three edges; both original logo outputs and both original prompt connections survived. The new video node remained idle with empty outputs after setting four seconds and 1080p. Generation, provider-check and handoff request counters all remained zero.

Keyboard activation focused the destination's first parameter. At 800×600 the Assets drawer and pinned Inspector occupied separate rectangles, leaving navigation reachable; at 800×300 the Inspector stayed within the canvas with a scrollable body. A 28-second silent video and close-up screenshots show this UI flow. Fixtures, footage and browser evidence are private artifacts outside Git; the logo artwork is a fixture, not a claim of provider generation.

## Remaining limits

Existing global Undo/Redo restores frontend structure only; a later backend synchronization can restore CLI changes. Durable backend Undo/Redo is outside this slice. Native browser 200% zoom, live provider generation and packaged Electron were not acceptance gates for this change.

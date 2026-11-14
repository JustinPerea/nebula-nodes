# Startup set: what first paint does not need (2026-11-14)

Branch perf/startup-set-defer, from main 964f2e4f. The build budget limits the startup set (the entry, what index.html modulepreloads and every chunk those import statically, walked by scripts/lib/startupChunks.mjs). Main sat about 4 KB under the limit, so two open feature PRs could not both land. This change takes 82 KB raw / 21 KB gzip out of the set and lowers the limits to match.

## Measurement

Measured with a throwaway vite config (deleted afterwards) that merged the real config and wrote Rollup's `chunk.modules` and each module's `importers` from `generateBundle`, then a script that walks the static import graph from src/main.tsx and reports how many bytes become unreachable when one module is cut. Sizes below are the built files' raw and gzip bytes.

The chunk labelled pendingNodes (535 KB) is src/constants/nodeDefinitions.ts (827 KB of source) plus 2.5 KB of lib/pendingNodes.ts. Rollup named it after the small module. graphStore.js is graphStore.ts (466 KB of source) plus its stores and libs. The placeholderRunConfirm chunk is a shared chunk holding directRoute, runScope, pricing and placeholderRunConfirm. The `src` chunk is d3 (zoom, transition, selection), pulled in by @xyflow.

| Startup set before | raw | gzip |
|---|---|---|
| pendingNodes.js (nodeDefinitions) | 535,413 | 55,050 |
| index.js (entry) | 477,203 | 148,357 |
| graphStore.js | 345,190 | 105,069 |
| react-vendor.js | 174,594 | 54,385 |
| canvas-vendor.js | 120,607 | 38,140 |
| placeholderRunConfirm.js | 61,171 | 21,017 |
| src.js (d3) | 51,156 | 17,063 |
| canvasUndo.js | 21,259 | 7,251 |
| projectStore.js | 17,264 | 6,599 |
| errorCopy.js | 17,169 | 5,726 |
| backend.js | 11,277 | 4,610 |
| personSession.js | 8,820 | 3,544 |
| 28 smaller chunks | 82,266 | 35,484 |
| Total, 40 chunks | 1,923,389 | 502,295 |

| Startup set after | raw | gzip |
|---|---|---|
| nodeDefinitions.js | 534,015 | 54,414 |
| index.js (entry) | 394,268 | 125,652 |
| graphStore.js | 343,462 | 104,356 |
| react-vendor.js | 174,594 | 54,385 |
| canvas-vendor.js | 120,607 | 38,140 |
| src.js (d3) | 51,156 | 17,063 |
| pricing.js | 36,457 | 12,893 |
| placeholderRunConfirm.js | 25,226 | 9,250 |
| canvasUndo.js | 21,264 | 7,248 |
| projectStore.js | 17,264 | 6,595 |
| errorCopy.js | 17,169 | 5,726 |
| backend.js | 11,277 | 4,610 |
| 32 smaller chunks | 94,705 | 40,906 |
| Total, 44 chunks | 1,841,464 | 481,238 |

The entry went from 477,203 to 394,268 raw (83 KB), so the entry limits dropped too. The chunk count rose from 40 to 44 because Rollup re-split the shared chunks once the deferred code no longer held them together (pricing now has its own chunk, and the retry helper lazyWithPreload became a startup chunk of 3 KB). I did not trace the other two.

## What was deferred

All of it loads through the existing helpers: `lazyWithPreload` in lib/deferredChunks.ts, mounted with `deferredAtOnce` (components/deferredAtOnce.tsx: a DeferredBoundary and a null Suspense fallback, so a chunk that fails to load draws nothing and retries on online, focus or the next load attempt), preloaded by the idle preload list `DEFERRED_PRELOADS` that App.tsx already starts after the first paint. No second idle helper was written.

- Node cards for ten kinds a canvas holds only sometimes: Edit, Remotion, Cinema scene, Character, Camera rig, Reference set, Moodboard, Paper source, Batch and Dynamic (components/canvasTypes.ts). Model, Reroute and Video QC stay in the entry.
- The three result views a finished Model or Dynamic card draws: Jev result (JevResult.tsx), the world and spatial viewer (RepresentationViewer.tsx) and structured outputs (StructuredValuePreview.tsx). The cards still decide synchronously, from lib/representationViewerRegistry.ts and lib/structuredValue.ts, which result view applies and which classes the card takes; only the view body is deferred (components/nodes/DeferredOutputViews.tsx). `ModelNode` imported `type JevResultInputs` with an inline `type`, which verbatimModuleSyntax keeps as a side-effect import; it is now `import type`.
- ArrangeController (components/canvas/ArrangeController.tsx), the headless layout of an agent edit's new nodes. It reads store/arrangeStore.ts (still in the entry) when it mounts, so a request that arrives before its chunk is taken up when the chunk lands.

tests/entrySplit.test.ts walks the static graph from src/main.tsx; each new module is listed in DEFERRED_MODULES so a later static import fails that test.

## First-use behaviour

A card of a deferred kind, or a finished card's result view, never draws empty: the canvas keeps a node back until its chunks have settled (see Round 2). Nothing on screen at the first frame of Projects home or of a new canvas changes.

## Measured and left alone

- nodeDefinitions.ts (534 KB raw, 54 KB gzip). graphStore reads `NODE_DEFINITIONS[id]` synchronously in dozens of places (keyStatus, ports, titles, add and edit steps), keptWires reads it for the kept-canvas refusals, and every card reads it. Deferring it means turning those reads async, and the kept edit steps cannot wait for a chunk. Splitting the generated Krea catalog out has the same problem for any canvas holding a Krea node.
- graphStore.js (343 KB) and what it imports (uiStore, api, runHistory, providerReadiness, keptWires): the kept path and persisted-state hydration.
- The placeholderRunConfirm, runScope, directRoute and pricing chunks (about 62 KB together): graphStore's run path reads them synchronously, and directRoute also feeds keyStatus.
- noticeStackPlace.ts (38 KB source): NoticeRegion's layout effect runs placement at mount and writes the Agent log's hold state, so it is part of the first paint.
- SelectionToolbar: draws an empty panel at the first paint that holds the Inspector's slot, and its tests cover the kept and lock paths.
- ProviderSwitcher and providerSwitch: the provider chip is in the card header at first render; a fallback would have to hold its exact box.
- NodeLibrary, Toolbar, Settings, WorkspaceHeader: drawn at the first paint of the canvas or Projects home.
- d3 (src.js) and the vendor chunks: React Flow needs d3 at once; vendor grouping was not changed.

The target was 150 KB raw off the set. The measured chains show about 82 KB that can come out without an async rewrite of the node definitions or the kept path; I stopped there.

## Tests

Tests that render the canvas's own card map or a Model card with a result now `await Promise.all(DEFERRED_CARD_PRELOADS.map((p) => p()))` in a `beforeAll`, which resolves the lazy chunks so the cards render at once (tests/errorCopy.round3e.cards.test.tsx, tests/placeholderEveryNode.test.tsx, tests/pr198Fix3Ui.test.tsx, tests/canvasRenderScope.test.tsx, and tests/components/ BatchNodes, JevCardField, JevResult, PreviewMoodboardClashes, PreviewStructuredGuards, PreviewStructuredOutputs). The render-count test also names the ten real card components directly, since its counter wraps a card's own body.

## Out of scope changes

None outside frontend/ and this note. The entry limits in scripts/check-build-budget.mjs were lowered as the brief allows once the entry shrank by more than 30 KB.

Every test file that imports a changed module was run one file at a time (about 75 files). Several App, Canvas and presence files failed or collected no tests while other work loaded the machine; each passed when re-run alone. Under load the first build's `tsc -b` took 25 minutes, so the final build ran with a longer lg time cap (3600 s) than the brief's 1500 s.

## Round 2: a deferred card never draws empty

Round 1 mounted the deferred cards and result views through `deferredAtOnce`, which draws nothing until the chunk lands. For a node card that is a defect: a project opened in the first seconds after a load put nodes with no size, handles or wires beside drawn neighbours, and they popped in later. Measured with the network throttled (latency 400 ms, 1.5 MB/s), reloading and opening the project at once: with round 1's behaviour the 4 nodes appeared in one frame, 2 of them zero-size and empty, and stayed so for the 2 s sampled (127 frames). With the hold: 0 frames with a zero-size or empty node, the count goes 0 to 4 in one frame.

What was added:
- lib/resultViews.ts: the predicates the cards use to decide which result view to mount (Jev answer, world, spatial value, structured output). ModelNode and DynamicNode call them. `drawsMediaOrText` is a sufficient test for "the card drew this output", so `structured` is an over-estimate (a mask, an inline text node, partials), which is allowed: an unused chunk only delays a card, a missed one draws empty.
- lib/cardChunks.ts: the deferred card chunk by node type and `cardChunksOf(node)` (card chunk plus result view chunks). `deferredAtOnce` now carries its chunk so a test checks every deferred entry of CANVAS_CARDS is listed.
- lib/lazyWithPreload.ts: `isSettled()` (loaded, or the last attempt failed and none is running) and `onSettle()`.
- lib/cardHold.ts, used by Canvas.tsx: a graph replaced on the canvas (the store's `canvasGeneration()`, bumped by project open, restore, import, sample graph, agent switch) is handed to React Flow only when every node can draw; until then React Flow gets nothing and the canvas shows the app's own "Loading workspace…" line (not the empty-canvas splash; the store's nodes are not empty). A node added later is left out with its wires until its chunks settle; nodes already handed over stay (a chunk whose retry is running does not remove them). A failed chunk counts as settled. With every chunk settled the hook returns its inputs by identity and reads no node.
- A fit asked for by `nebula:graph-nodes-added` while the hold keeps something back waits and is asked again when the hold ends.
- Opening a project and a restore that reaches a canvas call the card preloads at once (store/projectFlows.ts through `preloadCardChunks`); the gate also asks for any chunk it waits on.

React Flow in controlled mode: a node missing from `nodes` for some renders and then present produces no `remove` change; position, selection and measured size come out as stored (tests/cardHold.canvas.test.tsx records every change the store receives). ArrangeController reads node sizes from React Flow's lookup and from the store, so a held node reads as unmeasured and the arrange waits for it (tests/cardHold.arrange.test.tsx).

Not done: the Dynamic card has no Jev view, but lib/cardChunks.ts only asks for the Jev chunk for model cards. A result view that first mounts after a card is already shown (a run finishing in the first seconds) still appears when its chunk lands.

## Round 2: the hold at the canvas

Round 1 mounted the deferred cards so that a card whose chunk had not landed drew nothing, and React Flow kept that unmeasured node hidden until it did; a finished card's result area filled in later and could grow the card. Nothing visible in a canvas's first frame may pop in later, so the canvas now decides what React Flow is given.

What it does:

- lib/cardChunks.ts lists what a node needs: its card's chunk by node type, and the chunk of each result view the card would mount for its data. The result-view part calls the predicates in lib/resultViews.ts, which ModelNode and DynamicNode call as well (`jevResultFor`, `worldOutputOf`, `spatialOutputOf`, `drawsMediaOrText`), so the card and the list share one test. The list may ask for a view a card ends up not using (it covers every batch result the card can browse); it never misses one.
- lib/cardHold.ts (`useCardHold`, called in Canvas.tsx) filters the nodes and edges handed to React Flow. A graph put on the canvas (the store's `canvasGeneration` moved) is handed over only when every node of it can draw; until then React Flow gets nothing and the canvas shows the app's "Loading workspace…" line (the one App.tsx shows while the workspace loads), not the empty-canvas splash. A node added to a graph already shown waits out, with its wires, until its chunks settle; the others are untouched. A chunk that failed counts as settled: the rest is drawn, that card draws nothing and retries on focus and when the browser is back online (DeferredBoundary). With every card chunk settled the hook returns its inputs by identity and reads no node.
- It changes only what is drawn. The graph store is not written; no `remove` change reaches it, and a node's stored position, selection and measured size come out right once it is drawn.
- The arrange controller (now a deferred chunk, mounted at once in Canvas) reads sizes of the store's nodes through React Flow's lookup, so a held node has no size and its layout waits until the node is drawn and measured. An auto-fit (`nebula:graph-nodes-added`) asked for during a hold runs once when the hold lets go.
- The chunks are asked for sooner: opening a project, and a restore that reaches an active project, call the card preloads at once (store/projectFlows.ts through `preloadCardChunks` in store/projectFlowsLoader.ts, which lib/deferredChunks.ts registers; importing deferredChunks into projectFlows made tests/personLockSweep.ratchet.test.ts trace an unlocked caller). The idle preload covers the rest.

What a person sees: after pressing a project, Projects home stays until the project's own fetch returns; then, if a card chunk is still in flight, the canvas shows the toolbar and "Loading workspace…" (no nodes, no splash) and then every node at once. With the chunks already in, there is no hold line.

Measured in the running app (production build, isolated backend, headless Chrome, project with a Text node, a Character, a Moodboard and a finished node with structured output; DOM sampled every animation frame; Chrome's network at 400 ms latency and 1.5 MB/s through CDP; the person presses the project card as soon as it is on screen). Hold switched off by a local toggle that is not in the tree:

| | frames with nodes | frames with a zero-size or empty node | node count steps |
|---|---|---|---|
| no hold, throttled | 49 | 49 (2 nodes) | 0 to 4 at 11.9 s |
| hold, throttled | 101 | 0 | 0 to 4 at 20.5 s |
| no hold, throttled, card chunks held back a further 2.5 s | 52 | 52 (2 nodes) | 0 to 4 at 12.5 s |
| hold, same | 60 | 0 | 0 to 4 at 14.5 s |
| no hold, no throttling | 53 | 0 | 0 to 4 at 1.9 s |

With the hold the "Loading workspace…" line shows from 16.3 s to 19.8 s after navigation start (throttled; the press was at 14.4 s), and 8.0 s to 14.4 s in the slowed-chunks run (press at 7.5 s). Unthrottled it showed for 11 ms (0.68 s to 0.69 s after navigation; press at 0.43 s, nodes at 0.74 s). The app's own line did not show in any run: the project's graph loads before Projects home appears. The stage between the press and the line is the project's own fetch, which is the same with and without the hold.

Build after round 2: startup set 1,844,908 raw / 482,465 gzip in 44 chunks (limits 1,850,000 / 485,000); entry 397,521 / 126,795 (limits 403,000 / 129,500).

Tests added: tests/cardChunks.test.tsx (every deferred card is in the list; the cards' own result views are chunks the list asks for), tests/cardHold.identity.test.tsx, tests/cardHold.canvas.test.tsx (whole graph held, then drawn in one commit with its wires; a node added later; a failed chunk and its retry; the store untouched; a shown graph replaced by a held one; the fit after the hold), tests/cardHold.arrange.test.tsx (the layout waits for the held node), and a test in tests/projectStore.test.ts that a restore and an open ask for the chunks before their fetch.

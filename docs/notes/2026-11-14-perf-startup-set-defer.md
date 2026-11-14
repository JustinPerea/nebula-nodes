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

## Design round 1

GM - Design's rulings of 2026-11-14 (A: the hold of a whole graph; B: a failed chunk; C: a node added to a canvas on screen). No change to the backend, MCP or CLI: the store and the agent's view of the graph are unchanged; everything below changes only what React Flow is given and draws.

### A. The hold of a whole graph

- The line is "Loading canvas…" in `.canvas-hold-line` (styles/canvas.css), inside `.canvas-wrapper`, with no background of its own, so it sits on the canvas's background and dot grid. The old `.workspace-loading--hold` rule (position fixed, #111) is gone.
- The line mounts once the cover has lasted 400 ms (`HOLD_LINE_DELAY_MS` in Canvas.tsx) and fades in on SOFT (`springCssVars()` set on the wrapper). A hold that ends sooner never mounts it.
- "Covered" runs from the start of the hold to the end of the fit, not only while chunks load. The node layer (`.react-flow__viewport`) has opacity 0 through it (`canvas-wrapper--reveal-wait`). When the graph is handed over, measured (`nodesInitialized`) and fitted, `onRevealed` swaps in `canvas-wrapper--reveal-in`: an opacity-only fade on SOFT, while the line takes `--out` on the same spring. Both end after the spring's duration. I used SOFT for the node layer too (critically damped, so an opacity animation has no overshoot to clip).
- The fit has two sources. React Flow's own first fit resolves when its nodes are measured; the cover waits for `fitViewQueued` to clear. A fit asked by `nebula:graph-nodes-added` during the hold now runs when the hold ends with `duration: 0` and no 80 ms delay (the animated 400 ms fit is kept for the other cases), and the cover waits for its promise. A fallback timer (1.5 s) reveals the layer if neither reports, so a graph can never stay hidden.
- The zoom readout: `store/canvasRevealStore.ts` carries `covered`; Toolbar shows four figure-width spaces instead of the number (the button keeps its box: it has a min-width) and drops the number from its aria-label.
- Reduced motion: `@media (prefers-reduced-motion: reduce)` rules in canvas.css use `notice-fade-in 180ms ease-out both` (the proposal bar's), and the JS timers use 180 ms through `matchMedia`, the same detection `NodeWaitSwap` uses. I found no app-level reduced-motion class in this tree (grep for classList and CSS selectors), so there is only the media query.

### B and C. The fallback card

- lib/cardFallback.ts: `fallbackNode(node)` is a copy of the node with type `cardFallback` and its data plus `__heldCard` (the real type and the node's own size if it has one). The copy is cached per node object, so React Flow sees the same object until the node changes. The store node is never changed.
- components/nodes/CardFallback.tsx draws it: the boundary card's frame (reusing node-card-boundary.css), the node's name, ports spread down the sides, and for a failed own chunk one line in the card's text colour, offline or online worded. Ports come from `handleIds` (lib/cardHandleIds.ts, moved out of NodeCardBoundary.tsx): the definition's ports, the data's dynamic ports and a cinema scene's shots. tests/cardFallback.test.tsx renders each of the ten deferred cards and its fallback and compares handle ids and sides: all ten match, so no card needs the edge-midpoint fallback.
- The fallback card takes over DeferredBoundary's retry triggers (mount, focus, online) for its chunk, since the real card is not mounted while it shows.
- lib/cardHold.ts: a node added to a shown graph, or whose own chunk failed, is handed over as a fallback card; the whole-graph hold is unchanged. `failed` means the own chunk is settled and not loaded. A failed result-view chunk (Jev, viewer, structured) still draws the card without the view, as before. The identity fast path now tests "every chunk loaded" instead of "every chunk settled", because a failed chunk needs a fallback card.
- components/nodes/withCardSwap.tsx wraps the ten deferred cards and the Model card: a card that replaces a frame (`CARD_SWAPS`, set by the hold) renders a ghost of the frame (no handles) as its sibling inside the node element. The card, the node element's first child, fades in on SOFT (`.react-flow__node:has(> .card-fallback--ghost) > :first-child`, styles/card-fallback.css) while the ghost lies over it and fades out; under reduced motion both take 180 ms. No box is added around a card (an earlier version added `display: contents` wrappers; tests/placeholderEveryNode.test.tsx reads the node element's first child as the card root, and tests/canvasRenderScope.test.tsx counts the Model card's own body, so the test now names ModelNode directly as it does the other cards).
- The fallback type is in CANVAS_NODE_TYPES (inside its own boundary) and not in CANVAS_CARDS; tests/errorCopy.round3e.cards.test.tsx lists every canvas type that shows a run error and now skips it.
- The frame sizes (`FALLBACK_SIZE_BY_TYPE`): widths are the cards' CSS widths and a test reads them from the stylesheets. Heights are estimates: they were not measured, because measuring needs a running app and this round does not start one.
- The placeholder's own measured size is written to the store by React Flow like any node's (a measured size, not a position or removal); the real card measures again when it arrives. A node that already has a size keeps it in the frame.
- Idle preload (C1): `DEFERRED_PRELOADS` already holds `DEFERRED_CARD_PRELOADS` and App.tsx starts it through `whenIdle` after the first paint. tests/cardChunks.test.tsx now pins both.

### A backend test that reads frontend source

- backend/tests/test_reference_set.py::test_frontend_registrations reads canvasTypes.ts as text and expected `referenceSetNode: ReferenceSetNode`. The card is registered through its deferred handle now, so the test looks for a `referenceSetNode:` line that names ReferenceSetNode and for the card's import in lib/deferredChunks.ts. CI's backend part 2 failed on this after round 2; no backend code changed.

### Two fixes from the coordinator's read of this round

- The crossfade ghost carried the frame's usual minimum height (120 px when the node has no size of its own), so over a shorter card such as Edit it hung below the card for the length of the fade. `.card-fallback--ghost` now drops the frame's width and minimum height and takes the arriving card's box.
- A held graph replaced by an empty canvas before its chunks arrived stayed covered until the 1.5 s fallback timer, with the zoom number blank and the line due at 400 ms. An empty graph has nothing to measure or fit, so `HoldRevealController` uncovers it at once (`empty`).

### Build budget

After this round: entry 405,278 raw / 129,329 gzip (was 399,592 / 127,624), startup set 1,852,953 / 485,068 in 44 chunks (was 1,847,267 / 483,364). The added bytes are the fallback card and its frame, the hold's placeholder and swap logic, the reveal controller and line in Canvas.tsx, the zoom-readout store, and CSS. Limits set to the measured size plus about 8,000 raw / 3,500 gzip: entry 413,300 / 132,900, startup 1,861,000 / 488,600 (main's are 512,000 / 160,000 and 1,928,000 / 505,000).

## Review round 1

Two reviewers read PR #244 at c47dd591. What changed, one current description per item (frontend only; no backend, MCP or CLI change):

- **A whole-graph hold has a ceiling.** `HOLD_CEILING_MS = 8000` (lib/cardHold.ts). A card chunk whose request neither loads nor fails no longer keeps the graph behind "Loading canvas…": after 8 s the graph is handed over like a node added later. Nodes whose chunks are in draw as their cards, the rest as fallback frames (no line: they are waiting, not failed), and each card replaces its frame when its chunk lands. `holdCards` takes whether the ceiling has passed for this generation; `useCardHold` runs the timer while a whole graph is held, clears it when the hold ends or the generation moves, and a new graph starts a new ceiling. The reveal (cover until measured and fitted, then fade) applies as for any handed-over graph.
- **The arrange never lays out by a frame's size.** ArrangeController's `placed` treats a node of the request that React Flow currently draws as `cardFallback` (read from React Flow's node lookup; the store never holds that type) as not measured, so the arrange waits for the real card. At its deadline (`MAX_WAIT_MS`, 15 s) it lays out with the frame's size, so a chunk that never comes cannot block an arrange for good. tests/cardHold.arrange.test.tsx now covers a node added to a graph already shown (frame, arrange waits, card lands, layout runs on the card's size) and the deadline, and runs on fake timers.
- **The fit handler decides after React has rendered, and the reveal waits for a fit that is owed.** The store dispatches `nebula:graph-nodes-added` inside its update, before a render; the handler now decides on a 0 ms timer (tracked in `pendingFits`), using what the event looked like when it went out for the file-drop, focus and viewport checks. One ref, `fitOwed`, replaces `fitRunning`: set when an event is stashed during a hold or an instant fit is scheduled, cleared by `done()`; HoldRevealController does not reveal while it is set (the 1.5 s fallback still does). The stash condition is the whole-graph hold (`hold.holding`), so a fit asked for a node added to a shown graph runs at once, as on main, not after its chunk.
- **Swap marks expire.** `markSwap` and `takeSwap` (lib/cardFallback.ts) keep a map of id to `performance.now()`; a mark older than `SWAP_WINDOW_MS` (1,000 ms) is not honoured, and stale marks are dropped when a new one is added. withCardSwap takes the mark in its first render.
- **Covered nodes are not live.** `.canvas-wrapper--reveal-wait .react-flow__viewport` has `visibility: hidden` besides `opacity: 0`. React Flow measures through ResizeObserver and `offsetWidth`/`getBoundingClientRect`, which a `visibility: hidden` element still answers (xyflow only skips nodes with its own `hidden` flag, and its own nodes are `visibility: hidden` until measured), so measurement is unaffected.
- **The hold line is announced.** `.canvas-hold-status` (role="status", aria-live="polite", the positioning, no background) is in the DOM, empty, from the start of the cover until the line has faded out. `.canvas-hold-line` (the text and its fades) mounts inside it at 400 ms as before.
- **Budget comment, loader test.** scripts/check-build-budget.mjs has a comment whose numbers reconcile and limits from the final build. tests/components/DeferredSettle.test.ts tests `isSettled` and `onSettle` directly.

### After a check of the review round's commit

- The covered layer's `visibility: hidden` did not reach measured nodes: React Flow sets `visibility: visible` inline on each node once it has a size, and an inline value wins over one inherited from the layer. The rule now names the layer and every descendant and is `!important`, so covered nodes are out of clicks, drags and the tab order.
- "A fit is owed" was one flag that any fit's end cleared. A fit for a node added to a shown graph (which owes nothing) could end inside the window where a held graph's fit was stashed and clear it, so the reveal could run before that fit. Three things owe a fit now, each cleared by its own owner: an event stashed during a hold, that event being replayed until the handler has taken it, and instant fits not yet done.
- Left as it is: in the arrange path a node drawn as a frame counts as not measured even when the store has a `measured` size for it, because React Flow writes the frame's measured size to the store while the frame is drawn, so the two can't be told apart. The arrange's 15 s deadline bounds the wait when a chunk never comes.

### From the measurements in the running app (head c47dd591)

Chrome, production build, 400 ms latency with the card chunks delayed about 2.5 s more: the line mounted 404 ms after the cover began; no frame showed the node layer before the fit or with an empty node; the fade took 399 ms (167 ms under reduced motion); the zoom text was blank through the cover and then the fitted number. Unthrottled, the line never mounted. Three things it found:

- **The crossfade ghost sat under the card, not over it.** `body.app-slava-restraint .card-fallback { position: relative }` outweighed `.card-fallback--ghost { position: absolute }`, so the ghost was in the flow below the card and the node grew by the ghost's height for the length of the fade. The ghost's selector is now `.react-flow__node > .card-fallback.card-fallback--ghost`, and a test compares its specificity with every other rule that positions the fallback card.
- **The frame heights were guesses and most were short** (Character 140 against a real 250, Camera rig 140 against 339, Cinema scene 120 against 268). `FALLBACK_SIZE_BY_TYPE` now holds the measured heights of each card with empty params, which is what a node added on screen has. The Model frame is 300 x 220: a Model card is only a frame while a finished node's result view loads, and that card measured 300 x 219.
- **The Remotion card drew unstyled on main too.** Its rules were in styles/remotion-editor.css, which only the Remotion editor's chunk imports, so on a canvas where the editor had never been opened the card was bare text (189 x 40 measured). The rules are now in styles/remotion-node.css, imported by the card. This is a visible fix outside the PR's first scope.

### Known, not changed

A card's import of RepresentationViewer or StructuredValuePreview that fails and then succeeds through the retry URL can leave a second module instance beside the copy the Inspector and Create studio chunks import statically (the loader's own note covers the failed-record case: Chromium keeps the failed record for the original URL). I read both modules to see whether a second instance matters. Neither holds state of its own: StructuredValuePreview.tsx has module-level constants (`FULL_JSON_LIMIT`, `CARD_TEXT_LIMIT`, `BOARD_IMAGE_PORTS`) and pure helpers and components, and RepresentationViewer.tsx has one constant and pure summary functions and components; neither has a module-level cache, store, listener, registry or mutable variable, and their hooks (`useMemo` in the first) are per render. So two instances render the same thing and nothing is split between them. I did not trace the modules they import (backend, storedImage, DeferredViewers, ExpandableBlock, the moodboard preview) for state of their own; those come from the module graph by their own URLs, so a second instance of these two would reuse the same copies. What remains is the first half of the reviewer's point: the Inspector or studio chunk's own static import of the original URL can fail until reload when Chromium keeps the failed record, which the retry URL does not help.

Build after review round 1: entry 405,928 raw / 129,603 gzip (limits 414,000 / 133,200); startup set 1,853,603 / 485,343 in 44 chunks (limits 1,862,000 / 488,900). Main's limits are 512,000 / 160,000 and 1,928,000 / 505,000.

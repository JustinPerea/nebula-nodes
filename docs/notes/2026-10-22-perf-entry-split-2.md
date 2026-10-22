# 2026-10-21 — Second entry split: chat, inspector, assets, palette, graph file and the canvas overlays leave the first load

Branch `perf/entry-split-2`, from main at 5a08ffbd (#156). Worktree `nebula_nodes-entry-split-2`.

- **Why.** The startup entry is checked against 512,000 bytes raw / 160,000 gzip (`frontend/scripts/check-build-budget.mjs`). #103 brought it down to 472,693 on 2026-10-20. By 2026-10-22 it was back at 511,697, and after #162 it was 504,178. The limit stays (raising it is Justin's call). So this pass makes deferral the default instead of asking for more room.
- **Result (attribution build, `vite build --sourcemap`, `attr.mjs`).**
  - Entry: 504,178 → **355,567 bytes raw** (gzip 148,021 → 106,349).
  - Everything the startup HTML fetches (entry plus modulepreloads): 1,732,033 → 1,583,937 raw, gzip 420,291 → 379,139, in 17 files instead of 15. Rolldown now splits the shared graph code into `nodeDefinitions` and `graphStore`, and `graphFileShared` is a 354-byte chunk of its own.
  - Startup CSS: 442,837 → 377,632. These stylesheets now load with their own chunks: agentCursor, asset-move, canvasProposals, character-studio, chat-model-picker, command-palette, mask-painter, moodboard-studio, personal-agents.
- **Savings per module (bytes removed from the entry).**
  - ChatPanel 35,232, Inspector 24,456, graphFile 17,742, AssetsPanel 8,723, ChatModelPicker 8,065, ProposalBar 7,170, ProposalLayer 5,516, NodeInspectorPopover 5,180, AssetTrash 4,936, CommandPalette 4,520, PinLayer 3,878, AgentCursorLayer 3,498.
  - JevResultDetails 3,288, assetStudioDraftStore 2,538, AssetMoveMenu 2,530, PersonalAgentWarning 2,317, StoredAssetPicker 2,208, PermissionCard 2,027, lib/commandPalette 1,738, makerSizes 1,591, CanvasUndoNotice 1,031, createPresets 808, useProposalReadiness 793, useAssetDelete 706, chatCancellation 666, one lucide icon 408.
  - Added to the entry: DeferredPanels about 4.4 KB more, heldIntents 244, commandPaletteKeys 235, deferredAtOnce 182, and about 425 in main.tsx for the preload map.
- **How the pieces load.** Everything uses #103's machinery: `lazyWithPreload`, `DEFERRED_PRELOADS` (preloaded on idle after the first frame), `DEFERRED_MODULES` (guarded by `tests/entrySplit.test.ts`) and `DeferredBoundary`.
  - Chat panel: mounted straight away like the Agent log, because it checks the agent's login while closed.
  - Command palette: mounted straight away; it draws nothing while closed.
  - Node Inspector popover (with the Inspector inside): mounted on its first open.
  - Assets dock: mounted when the rail opens it.
  - ProposalBar, ProposalLayer, PinLayer and AgentCursorLayer: mounted straight away inside Canvas by `components/canvas/DeferredCanvasOverlays.tsx` (`deferredAtOnce`). Each draws nothing until its chunk lands.
  - `lib/graphFile.ts`: a new `deferredModule()` loader in `lazyWithPreload.ts`. Save and Open await it at the moment of use. It shares #105's fresh-URL retry and is preloaded on idle like the components.
- **Deferred by default (the docs paragraph).** #103 documented the split only in code comments and `implementation-notes.md`; the frontend has no doc for it. So the paragraph is here and in the header of `src/lib/deferredChunks.ts`:
  > New panels, menus, pickers and modals are deferred by default, so the entry stops growing on its own. Anything the person opens (or that shows only what the socket or a fetch brings in) needs four things:
  > - a `lazyWithPreload` in `lib/deferredChunks.ts`;
  > - a preload in `DEFERRED_PRELOADS` (or on intent, like Paint Mask's hover);
  > - a wrapper with a `DeferredBoundary` (`components/DeferredPanels.tsx`, or `components/deferredAtOnce.tsx` when the closed state draws nothing);
  > - its files listed in `DEFERRED_MODULES`.
  >
  > Code used only inside an action goes through `deferredModule` (like `graphFileModule`). A piece stays eager only in two cases:
  > - it is drawn at the first paint of the canvas or Projects home, and no fallback can hold its exact box;
  > - it sets up startup-time state at import (a store that subscribes to the socket, a hotkey or window-event listener). Then split that part into a small eager module (`store/*`, or the `lib/heldIntents.ts` pattern) and list it in `STARTUP_STATE` in `tests/entrySplit.test.ts`.
- **Agent support.** None changes. This is frontend bundling only: no MCP tool, CLI command, endpoint or doc that agents use is touched.
- **Decisions not in the spec.**
  - *Held intents (`lib/heldIntents.ts`).* The ⌘K hotkey, the rail's "open palette" event and the `nebula:chat-send` event used to be listened for by the palette and the chat themselves. Those listeners now live in the eager wrappers until the chunk claims them. A ⌘K or a send that arrives before the chunk is held (the ⌘K's default action is still prevented), and the chunk replays it on mount. A second ⌘K before the chunk lands cancels the first, like a toggle. Without this, a ⌘K in the first ~100 ms would do nothing.
  - *`lib/graphFileShared.ts`.* projectStore and canvasSelection needed only the bundle limits and `normalizeRuntimeMediaParams` from graphFile. Those moved to a small eager file, and graphFile re-exports them, so no caller changed.
  - *The overlays.* The brief said to judge these carefully. A proposal, a pin or an agent cursor arrives over the socket or by fetch after the first paint, so none can be on screen at the first frame. Their stores stay eager: canvasProposalsStore, canvasPinsStore and agentPresenceStore are all in `STARTUP_STATE`. So nothing is missed, and if data beats a chunk it shows when the chunk lands, as if it had arrived that much later. The live check found every overlay chunk in before Home had even drawn.
  - *Kept eager, on purpose.*
    - ProjectHome: its loading state is the first paint of every start.
    - NodeLibrary: open on an empty project's canvas.
    - Toolbar and the Settings shell.
    - SelectionToolbar: a node's own action slot draws into it, so a late chunk could move a selected node's actions. When in doubt, eager.
    - ProviderSwitcher's menu: about 4-5 KB; its tests pin a synchronous menu and focus. Left for a later pass.
    - JevResult and RepresentationViewer, as in #103.
    - spatialValue: reached through node cards.
- **Tradeoffs.**
  - Save and Open now await a module before they open the file picker. A slow chunk could in principle outlast the click's user activation. In practice it is preloaded on idle and was always in by the time anything could be clicked, and a loaded module resolves in one microtask. In the live check, Cmd+S and Cmd+O both worked on the first try.
  - The wrappers carry about 5 KB of eager glue (DeferredPanels, heldIntents, commandPaletteKeys, deferredAtOnce).
  - Two existing tests now wait for chunks.
    - `App.commonsLifecycle` preloads the chat chunk before it renders, the way the app's idle preload does. Under load, a bare `findByRole` lost the race against the module transform.
    - The StrictMode duplicate-save test in `GraphFileActions` uses async `act`.
  - The cold-chunk tests in `DeferredSecondPass` get 20 s waits and 30 s test timeouts, because a cold load includes vitest's first transform of that module. At load ~36, two of them took over 5 s.
- **Surprises.**
  - Every start shows Projects home first. The brief expected a start "straight on the open project's canvas", but projectStore starts on `screen: 'home'`, and `initialize()` loads the active project in the background. The canvas appears only after the person opens a project. So the canvas is never the first paint, and Home's loading state always is.
  - The first camera fit can differ by start. `computeCanvasFitPadding` measures `.proposal-bar-panel`, so whether the socket's proposal sync lands before or after the open click changes the fit (79% vs 68% zoom in one 1440 run). This is a pre-existing race that the split doesn't cause or change: resource timing shows the ProposalBar chunk in at about 110 ms, before Home drew (about 134 ms). Not fixed here; noted as open.
  - Moving ChatPanel and the Inspector also moved nine stylesheets out of the startup CSS. I checked each one against eager users. MoodboardBundlePreview imports its own swatch CSS, and the mask-painter rules are used only inside the Inspector chunk.
- **Tests (red first).**
  - `tests/entrySplit.test.ts` with the new `DEFERRED_MODULES` entries, before any move: **21 failed**, each naming its chain (e.g. "components/panels/ChatPanel.tsx is statically imported on the startup path ... main.tsx -> App.tsx -> components/panels/ChatPanel.tsx").
  - With the new `STARTUP_STATE` list added: **23 failed**.
  - New `tests/components/DeferredSecondPass.test.tsx`: failed to import (`deferredAtOnce`, `heldIntents`, `graphFileModule` didn't exist yet).
  - After the build: both files pass, **63 tests** (64 with `App.commonsLifecycle`). The behaviour tests cover:
    - a ⌘K that beats the chunk opens the palette with its commands; a second ⌘K closes it;
    - once preloaded, a rail open draws the palette synchronously;
    - a chat-send before the chunk lands in the chat's input; once the chunk is in, nothing is held;
    - the Inspector opens on its first open with its tabs; the Assets dock opens with its tabs;
    - graphFile is preloaded on idle and retries a failed load with a fresh URL;
    - a `deferredAtOnce` piece draws nothing until it lands, and a broken one leaves its siblings working.
- **Live check.**
  - *Stack.* Backend on 8795 (through `iso.sh` with a temp HOME and every NEBULA_* root under scratch, no keys). `vite preview` on 5795, serving main's build and this branch's build, both made with `VITE_NEBULA_BACKEND_PORT=8795`. Puppeteer from the jev-demo driver.
  - *Blocking.* Chrome had a dead proxy plus a loopback bypass for 5795 and 8795 only, and CDP `Network.setBlockedURLs` for 8000-8010 and 5173. **Blocked attempts at forbidden ports: 0** in every run. A canary request to 8797 was refused, which shows the dead-proxy layer was working.
  - *Board.* A test board with nine node types (text input, Nano Banana, camera rig, reference set, sticky note, paper source, moodboard, batch, FLUX.2 [pro]), plus an agent proposal and an agent cursor posted during the run.
  - *First paint, before vs after, 1280x800 and 1440x900.*
    - Home (first and settled) and the canvas (settled): identical layouts, 0 boxes changed.
    - Settled canvas, palette, chat and assets screenshots: 0 px different.
    - The only pixel differences were data (a trash count and a proposal countdown) and the Updates chip's slide-in timing, which is the same animation in both builds.
    - With every deferred chunk blocked on purpose: nothing common to both builds moved; only the deferred pieces were missing.
  - *First opens.* Frames from the action to the drawn piece were identical before and after: palette by ⌘K 1, palette from the rail 1, chat 2, assets 1, inspector 2. The proposal bar and the agent cursor appeared (the cursor about 5-7 ms after its POST).
    - Cmd+S saved a 2,797-byte bundle, and Cmd+O opened it back with all 9 nodes. The only dialog was the expected "Set to a provider you have no key for" notice.
    - Layout shifts came from the same sources in both builds (the header, tabs and Updates chip animations), none from a split piece.
  - *Waterfall.* main's startup HTML pulls 15 JS/CSS files, 1,732,033 bytes raw; this branch pulls 17 files, 1,583,937 raw. The entry transferred 148 KB before vs 106 KB after.
    - The deferred chunks (ChatPanel about 15 KB transferred, NodeInspectorPopover about 12 KB, graphFile about 6.5 KB, and the rest) load on idle and were all in by about 110 ms.
    - First-paint times varied with machine load (about 30-36), so they aren't a speed measurement.
  - All servers were stopped; the state dirs and the person-link file are deleted.
- **Gates.** The machine load average was 18-44 throughout.
  - Backend: 9,616 passed, 71 skipped.
  - Frontend `vitest run`, whole suite:
    - First run, alongside the backend suite: 111 failed, 4,130 passed. 93 of the failures were 5 s timeouts.
    - Second run: 22 failed, 4,219 passed, in 9 files.
    - Each of those 9 files passes alone: 173 tests.
    - The files that still failed alone under load fail the same way on main's code at the same load (checked file by file).
  - `tsc -b` clean, lint clean.
  - Build budget passed: 355,524 bytes raw / 106,312 gzip.
- **Review (two confirmed findings, fixed tests first).**
  - *A held intent outlived a failed chunk.* If the palette's chunk failed (a redeploy under an open tab, offline at start), ⌘K and the rail's Search only held the open: nothing retried, because the palette's boundary had no `retryKey`. The next window focus then loaded the chunk and opened the palette by itself for the old ⌘K. The chat had the same leftover: a failed chunk closed the chat but kept the held Enhance message, which landed (and could auto-send) on a later open or focus. Fix in `components/DeferredPanels.tsx`: each held palette open bumps a counter used as the boundary's `retryKey`, so the press itself tries the chunk again, and `onChunkError` drops the hold. `closeChat` now drops the held send too. A hold never outlives the load it waited for.
  - New `tests/components/DeferredHeldIntentFailure.test.tsx` (stub chunks that fail a set number of times, fresh modules per test). All 4 failed on the old code: a ⌘K after a failed chunk never opened the palette; neither did the rail's Search; a ⌘K whose retry failed popped the palette open on a later focus; a failed chat send landed in the input on the next open. All 4 pass now. It is its own file, not in `DeferredSecondPass`, because those tests need the real chunks.
  - *Seven modules that left the entry weren't guarded.* `lib/commonsChatAuthority.ts`, `lib/personalAgentsEvents.ts`, `lib/makerSizes.ts`, `lib/createPresets.ts`, `lib/assetMove.ts`, `store/assetStudioDraftStore.ts` and `hooks/useAssetDelete.ts` are now in `DEFERRED_MODULES`. The new cases pass because none of these files is reachable from startup. To show the guard really catches them, I added a static import of all seven to `App.tsx` for one run: 7 failed, each naming its chain. Then I restored the file. A static-import walk of HEAD against this tree shows that every module that left the startup graph (28 of them) is now listed.
  - *Live re-check* (backend 8795, `vite preview` 5795 on this build, 1280x800 and 1440x900). Normal first opens didn't change: palette by ⌘K in 1 frame, from the rail in 1, and a chat-send landed in the input in 2. With the palette chunk blocked, ⌘K showed nothing. After unblocking, the next ⌘K opened the palette (7 and 2 frames, all 330 items). After a blocked ⌘K, a window focus loaded the chunk with a fresh `?retry=` URL and the palette stayed closed; the next ⌘K opened it in 1 frame. With the chat chunk blocked, a send left the chat closed (launcher not pressed). A later focus didn't open it, and a manual open showed an empty input. Blocked attempts at 8000-8010/5173: **0** in all 8 runs. The canary on 8797 couldn't be reached.
  - *Gates after the review fixes* (load average 21-25).
    - Backend: 1 failed, 9,615 passed, 71 skipped. The failure is `test_gemini_cli_setup.py::test_a_slow_cli_says_it_was_slow_and_is_asked_again`, which has a 0.5 s CLI timeout. That file passes alone (15 passed). This branch changes no backend file.
    - Frontend `vitest run`: 34 failed, 4,218 passed, in 11 files; 28 of the 34 were 5 s timeouts. Each of those 11 files passes alone (179 tests). The deferred-chunk files together (`tests/components/Deferred*`, `entrySplit`, `App.commonsLifecycle`) pass: 111 tests.
    - `tsc -b` and lint are clean.
    - Build budget passed: entry 355,663 bytes raw / 106,323 gzip. That is 139 bytes more than before the fixes, for the retry counter and the drops.
- **Open items.**
  - ProviderSwitcher's menu (about 4-5 KB) could be split if its tests accept a held first open.
  - SelectionToolbar would need a fallback that holds the action slot's box.
  - ProjectHome can't be split while Home is every start's first paint.
  - The fit-padding race with the proposal bar is pre-existing.
  - The ModelNode and CommandPalette chat-send dispatchers still use the event string literal rather than `CHAT_SEND_EVENT`.

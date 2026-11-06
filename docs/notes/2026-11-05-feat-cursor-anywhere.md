# feat/cursor-anywhere (cursor Phase 3) notes

Branch from main dbc53287. Plan and GM rulings are in the coordinator's scratchpad; this file records decisions, surprises and entry bytes per slice.

## Entry bytes per slice

| Slice | Entry raw | Entry gzip | Cursor chunk (js raw / gzip) |
|---|---|---|---|
| 1 baseline (dbc53287) | 501,178 | 156,796 | 58.26 kB / 20.43 kB |
| 2 CursorSpace refactor | 501,178 | 156,771 | 58.65 kB / 20.64 kB |
| 3 protocol (frontend: types, `isAnchor`, says) | 501,168 | 156,792 | 60.29 kB / 21.11 kB |
| 4 anchors, attributes, resolver, `layerOf` | 501,664 | 156,994 | 60.54 kB / 21.22 kB |
| 5 screen layer | 502,046 | 157,145 | shared field 65.87 kB, canvas layer 0.75 kB, screen layer 4.24 kB (js raw) |
| 6 hand-off | 502,046 | 157,152 | shared field 67.39 kB, canvas layer 0.76 kB, screen layer 4.24 kB |
| 7 edge park chevron | 502,046 | 157,160 | shared field 68.42 kB, canvas layer 0.76 kB, screen layer 4.24 kB |

Slice 2 adds 0 B to the entry (limit 300 B); `agentCursorSpace.ts` is in `DEFERRED_MODULES`, so it rides the cursor chunk (+0.39 kB raw). `entrySplit` passes.

## Slice 1: golden DOM

`tests/agentCursorLayer.golden.test.tsx` serialises the `.agent-cursor-layer` `innerHTML` in six states (rest, flying at a fixed frame, a column of 3, a typing count cursor, the type caret in a card field, the drag wire mid-pull) into `tests/__golden__/agentCursorLayer/*.html` with `toMatchFileSnapshot`. A missing or different file fails.

Normalised, only: the SVG halo filter id from React's `useId` (`agent-cursor-halo-r1`), renumbered by first appearance to `HALO_n`. Its number depends on how many components rendered earlier in the run. Nothing else varies: the frames run on the test's own clock, and the output was identical across repeated runs and with `-t` on one state.

Mutation checks: renaming `agent-cursor__tip-caret`, `agent-cursor__field-layer` and an attribute on the wire each fail a named state.

The first draft's count-cursor state did not type, so the tip caret was uncovered (the mutant passed). Fixed by making the state a typing count cursor; that one snapshot was regenerated against the untouched layer (HEAD copy swapped in), then the refactor passed it unchanged.

## Slice 2: CursorSpace

`lib/agentCursorSpace.ts` holds the `CursorSpace` interface and `canvasSpace(storeApi)`. The canvas layer is now the only place that knows React Flow's store: `AgentCursorView`, `FieldMark` and the layer's invalidation effect read the surface through `space`. `lib/agentCursorMotion.ts`'s `resolveAnchor`/`chainPoint` take a structural `AnchorLookup` (React Flow's nodeLookup satisfies it) instead of `InternalNode`, which also drops its React Flow type import.

Decisions and surprises:
- **The view and field were not moved to `components/agent-cursor/`.** Four tests read `components/canvas/AgentCursorLayer.tsx` as source (agentCursorCss, agentCursorStacking, agentCursorLook, and the layer test's springs), and the brief is "every existing cursor test passes unchanged". The move belongs to slice 5, which can update those four paths with the reason on record.
- `typeField` is not on the interface: `findTypeField`/`fieldBox` are DOM queries keyed on `data-id` and the card's class names. Slice 5 adds it as an optional member when the Studio has fields to point at.
- `screenSpace(resolver)` is slice 4/5: nothing consumes it yet.
- `pane()` returns the DOM node even when the store has no transform; `fromClient` and `snap` handle a missing transform (return null / the point). Real React Flow always has a transform, so this is only the test mock's shape.
- Hook order in `AgentCursorLayer` changed by one `useMemo` (the space); `orderStore` and `storeApi` were two `useStoreApi` calls on the same object and are now one.

## Slice 3: protocol

Third anchor form `{surface:'moodboard', itemId:'<board>' | '<board>/<image>', part?}`; `anchorNames {board, image?, part?}` travels beside it, never inside. Board parts: name, direction, avoid, colors. Image parts: note, weight.

- Backend: `parse_target(..., boards=)` takes a board by id or by exact (whitespace-folded) name, an image by id or by `N` / `#N`; refusals are pinned word for word in `test_cursor_anywhere_protocol.py`. `from` with a surface is refused. `_target_point` returns None for a surface (no canvas point, no carry chain); `_same_spot` is equality; `forget_board`; `forget_image(..., holder=)`: the remover's own cursor (agent form and session slot) holds the spot, every other cursor falls back to the board with its arrival kept.
- `main._say_agent_action` now always goes `_point` then `_person_form` then `_broadcast_presence`, so a write is the session's numbered cursor. The ratchet that counted `broadcast_raw(_point(` went from 2 to 1 for that reason (`test_agent_cursor_round4.py`).
- Write table is GM item 4, row by row in `test_cursor_anywhere_writes.py`. Weight counts as a weight control when the changed settings are `{weight}` and the other slices are cards of the same image (`op_weight` rescales the cards).
- MCP `point_at(moodboard, image, part)`, exclusive with node/port/x/y/from; `krea_agent_mcp.py` inherits it. CLI `nebula point --moodboard/--image/--part` (parser error with a positional target or `--from`). Formatter, `docs/MCP-SETUP.md` "Beyond the canvas", `skills/nebula/SKILL.md`.
- Frontend: only the anchor type, `isAnchor`, `resolveAnchor` returning null for a surface, and GM's default says (`surfaceSay`, display only). `anchorNames` is not stored on `AgentCursor` yet (slice 5). `DEFAULT_SAY_EXAMPLES` is unchanged (a test pins it exactly); the surface examples are `SURFACE_SAY_EXAMPLES`.
- Part labels: `AGENT_SURFACE_PART_LABELS` equals the backend `PART_LABELS` (a test reads the python source) and is pinned against the Studio source. Name, Direction, Avoid match literally. Weight is "Weight {value}" in the Studio. Colors is "Colors that must appear" / "Colors to keep out". The Studio's note control is labelled "Image note", not "Note"; pinned as is. Flag for GM (the note say "Writing a note on image 12" does not use the label).
- Existing tests changed because behaviour was superseded on purpose: `test_moodboard_agent_actions.py` (events now carry surface targets), `test_moodboard_create_request_id.py` (the `say` fake takes `**_where`), `test_agent_cursor_round4.py` (count above).
- The existing write `say` stays the backend's line ("Added #3 to board X"), not GM's "Added 3 images to ...".

Mutations, all caught: `_target_point` gives a surface a point (`test_a_surface_anchor_has_no_canvas_point`); writes skip `_person_form` (`..._numbered_cursor...`, the remove-holds test and the broadcast ratchet); the remover's session slot not held (`..._an_image_removed_elsewhere...`). Ignoring the holder for the agent form was first NOT caught, so `test_the_removers_own_agent_form_holds_the_removed_image_too` was added, then it failed under the mutant.

## Slice 4: anchors, attributes, resolver, layerOf

- `lib/agentAnchors.ts` (imports nothing; test holds that): `agentAnchor(board, image?, part?)`, `agentLauncher(kind, board?)`. An id outside `[A-Za-z0-9_.-]{1,64}` gets no attribute.
- `lib/agentAnchorResolve.ts`: `AnchorResolver` over an injected env. Chain: exact item (a part falls back to its item) then the board's launcher (at least half visible) then the surface launcher (the dock's tab before the rail's "Open assets") then, for a canvas anchor with no canvas, "Back to Canvas", then none. Reads rects only; no click, scroll or pan. 250 ms element cache, re-queried when an element disconnects.
- `lib/agentCursorLayerOf.ts`: surface is the screen layer's; a canvas anchor is the canvas layer's while the canvas is mounted. The canvas `AgentCursorLayer` filters its cursors through it (a test: a surface cursor draws nothing there). Both new lib modules are in `DEFERRED_MODULES`.
- Sites: rail "Open assets" (launcher), Moodboard node (launcher), Assets dock Moodboards tab (launcher) and board rows (anchor and launcher), `WorkspaceHeader` and `StudioBoundary` back buttons (launcher `canvas`), Studio card, list tile (+ weight and note), side-panel image (+ weight and note), Brief direction / Avoid / colors, Studio name and the board's fields. The Studio sites get the board id from `useStudioBoardId` (the published `studioBoard`), as it is not a prop; a draft has none, so no attribute.
- Not done here (slice 5): the screen layer that draws these, storing `anchorNames`, and what a held cursor does when its image is gone (`gone` is a resolver input; the caller decides).

Mutations, all caught: resolver skips the exact anchor (13 resolver tests fail); `layerOf` sends a surface to the canvas (the `layerOf` test and the layer test fail).

Slice 3 entry bytes were measured while slice 4 had begun editing `deferredChunks.ts`; the string difference is a few bytes. Slice 4 adds 496 B to the entry (the attribute sites and `agentAnchors.ts`); the budget line is 503,000 and CI fails at 512,000.

## Slice 5: the screen layer

- `components/agent-cursor/AgentCursorField.tsx` now holds the cursor view, the column field (`CursorField`) and `AgentCursorSurface`, the shared body both layers draw with (exit fades, fonts, prune, pointer, views). `components/canvas/AgentCursorLayer.tsx` is the canvas's space and its viewport portal. The golden DOM passes unchanged.
- The move was done, so five source-reading tests changed path, none changed what it asserts: `agentCursorLayer.test.tsx` (two), `agentCursorLook.test.ts`, `agentCursorCss.test.ts` (it reads `lib/agentCursorSpringVars.ts` now: `cursorSpringVars` moved there so the field file exports only components for react-refresh), and `agentCursorStacking.test.ts` (it asserted `<ViewportPortal><div className="agent-cursor-layer"` in the layer file; the portal is now `inLayer={(layer) => <ViewportPortal>{layer}</ViewportPortal>}` and the class default is in the field file, same assertion: the layer paints in the viewport and never a portal of its own).
- `screenSpace` (`lib/agentCursorSpace.ts`): the window in client px at zoom 1. `resolve` reads rects through the resolver on each call; the view calls it every frame in flight and once per wake at rest. Wakes (`domEvents`): scroll (capture), resize, a `MutationObserver` that only reacts to an added or removed `data-agent-anchor`/`-launcher`, and a `ResizeObserver` on the elements last resolved; one notify per frame. New optional `CursorSpace.carried(anchor)`: the anchor resolved to the same element and step as the last read, so a resting cursor's goal move is the item's own (a scroll) and rides at 0 px (`stepMotion`'s `dragged` path); a new element or step is a flight, and a flight re-plans from where it is when its target moves 24 px.
- `typeField` was not added: the Studio's fields get an outline, not a caret (`type` falls back to the say pill's caret). Say so if GM wants the caret in the Studio's fields; it is `findTypeField`/`fieldBox` over `data-agent-anchor` elements.
- The edge park and launcher park resolutions fly to their point like an exact item (`resolutionPoint`); their chevron (7) and dot (8) are the next slices' and read `ScreenSpace.resolution(anchor).kind`. The hand-off (6) goes at `layerOf`'s flip.
- `anchorNames` is stored on `AgentCursor` (cleaned: a board name, an image number, a part label; none for a canvas target) and `sayFor` uses it with `surfaceSay`.
- GM 4 ("gone"): the caller decides, in `AgentScreenLayer.removedImage`: the image's board is the one open in the Studio (`studioBoard`) and it is not among its images. The backend keeps the remover's cursor on the image anchor (other cursors fall back to the board), so this cursor holds its spot. A closed panel is not a removal (the Studio has no `studioBoard` then), so the chain runs to the row, tab or rail.
- GM 6: an unresolvable target returns no point; the view's loop stops where it is (it stays drawn), and a cursor with no motion yet draws nothing (`data-placed` unset, opacity 0) until something resolves, then makes its section 3 entrance.
- z-order (GM 5): `.agent-screen-layer` is `position: fixed`, `pointer-events: none`, `z-index: calc(var(--sr-layer-modal, 60) - 1)` in `styles/agentCursorAnywhere.css` (docks and the Updates corner are 50 to 55, modals 60, the notice region 20010; a test pins the order).
- Outlines (GM 3): `lib/agentCursorOutlines.ts` (`outlineKind`, `outlineRings`, `OutlineBook`) and the layer's `ItemOutlines`. `type` solid, `propose` dashed, from the cursor's landing, at least 0.4 s after the action changes, clipped to the item's visible box, 2 px between agents (earliest innermost). Reading of "from 3": two rings are drawn, and the outermost carries "+N" for the agents beyond them (3 agents give "+1"). Flag if GM meant three rings.
- Mount: `components/DeferredScreenOverlays.tsx` (eager, a `deferredAtOnce`), `App.tsx` on every screen but Home and the brand showcase, with `canvasMounted={isCanvas}`; `DeferredAgentScreenLayer` is in `DEFERRED_PRELOADS` and the new files are in `DEFERRED_MODULES`.
- Ratchet: `tests/agentCursorNoOpen.test.ts` scans the chunk's source for scroll, pan, fit, open and focus/click calls (`PRESS_HANDLERS` is empty until slice 9's chip).

Mutations, all caught by a named test: outlines nest 0 px (`two agents on one item nest 2 px apart…`, `outline rings … two agents nest 2 px apart`); a surface cursor on the canvas layer (`a cursor on a moodboard is the screen layer's…`); a cursor with no last spot at 0,0 (`is not drawn while nothing resolves, and not at 0,0` and six more); the layer calls `scrollIntoView` (`calls no scroll method through a flight…`, and the `agentCursorNoOpen` scan).

## Slice 3b: one set of words for Moodboard actions

GM - Design's ruling on #233 wording, built in the shared helpers so the Agent log, the cursor's say and the journal stay one source (`services/moodboard_edits.py`: `quoted`, `board_where`, `image_words`, `image_count_words`, `SENTENCE_LABELS`, `field_label`, `cover_words`, `journal_entry`; `services/moodboard_actions.py`: `describe_*`).

- Board and project are curly names; an image is "image 3" in a sentence; clauses join with "and"; fields are quoted labels; undo is "Undid a change to “Dusk”" (the undo line no longer repeats what was undone). "Kept the brief for". Several images added or removed are a count ("Added 3 images to ..."); other kinds list numbers ("images 1 and 2").
- Journal: it is a memory-only ring buffer (`canvas_events`), so no entry outlives the words that wrote it. Nothing stored in the old form, nothing to migrate or re-render at read time. The summary stays lower-case (the actor leads it) and is the same phrase the say capitalises.
- Field labels: `SENTENCE_LABELS` (curly, the Studio's control names). Flag for GM: Send notes is “Send notes” as GM's line has it, while the Studio's own label is "Send notes to generators". `FIELD_LABELS` (refusals and skip messages) is unchanged.
- No board line has a separate `log` (the Agent log shows the say), so there is no log variant to give a period; says have none.
- Not touched: the r90 Studio notices (copy PR), edit refusals' straight apostrophes (other copy), `test_mcp_channel.py`'s journal fixtures (inputs, not produced).
- Mutations: `board_where` returning "board “Dusk”" fails 18 tests; a "; " joiner fails `test_describe_change_is_the_journal_summary...` and the `[fields and send notes]` table row.

## Slice 3c: the names rule for added and removed images (GM, after 3b)

`MAX_NAMED_IMAGES = 3` in `moodboard_edits.py`: add and remove name up to 3 images ("images 1 and 2", "images 4, 5 and 6"), from 4 a count ("Added 4 images to ..."). "Made “Dusk” with 3 images" keeps `image_count_words`. `SENTENCE_LABELS["sendNotes"]` is the Studio's "Send notes to generators". Table rows: add two / three / four, remove two / four; contract 07 quotes the new lines. Mutation: `MAX_NAMED_IMAGES = 0` fails 8 tests.

## Slice 6: the hand-off

- `lib/agentCursorHandoff.ts`: `CursorHandoff` (`write`, `take`, `bump`), the tab's `cursorHandoff`. Entries are client px, px/s, opacity, lean, dated, stamped with `screenEpoch`. `take` gives an entry only to the other layer, at most 100 ms old, from this epoch, and consumes it.
- `CursorSpace` gains `layer` and `toClient` (the inverse of `fromClient`); the view writes the registry in `apply()` (every drawn frame) and in a layout-effect cleanup as its view goes (a resting cursor has no recent frame; layout, not passive, so it is written before the receiving layer's first frame).
- The receiving view, on first sighting, takes the entry and builds its motion from it (`handedOff`): position through `space.fromClient` at the live viewport, velocity / zoom, opacity, lean; then `planMove` as for any flight, which continues along the carried velocity. Its name doesn't flash again (`firstSightAt` set in the past). Reduced motion never takes it: the existing snap.
- No exit on the layer it left: `AgentCursorSurface` takes `everyone` (the whole store) and a cursor still in it but no longer in `agents` was handed over, not removed. Both layers pass it.
- `screenEpoch`: `cursorHandoff.epoch`, bumped by zustand subscriptions on `uiStore.viewMode` and `projectStore.screen` (they fire before React renders). The view's final write is stamped with the epoch of its last drawn frame, not the current one: the first test caught the layer's own unmount write restamping a pre-switch point with the new epoch. Consequence, accepted: a screen-layer cursor that rested through two screen switches (canvas, Studio, canvas) and is then moved to the canvas makes an entrance rather than a hand-off.
- Panel unmounting mid-flight needed no new code: the screen space resolves every frame in flight and the resolver re-queries a disconnected element, so the chain runs row, tab, rail and the flight re-plans from where it is. Now tested (no frame step over 60 px, opacity never falls).
- Tests: `tests/agentCursorHandoff.test.tsx` (both layers in one tree: canvas to panel and back start at the registry point, one cursor drawn, no exit, no frame jump, a flight in progress keeps its heading and speed, a zoom between the last frame and the hand-off, epoch bump gives an entrance, reduced motion snaps, registry freshness and epoch units) and two in `agentScreenLayer.test.tsx`. Mutations, both caught: `handedOff` ignores the registry (5 fail), no epoch bump (2 fail).

## Slice 7: the edge park and chevron

- The clamp was built in slice 4 (`clampToClip`) and flies like an exact item since slice 5. New: `lib/agentCursorPark.ts` (`parkChevron`, `arrowExitPx`) and the chevron, an inline SVG child of `.agent-cursor` rendered only while `space.edgeToward(anchor)` is set (React state toggles on park or unpark only). Its angle and place are written in `apply()` from the tip as drawn, toward the item, so it turns as the cursor glides. It sits 4 px clear of the arrow's box: at once for an item above or left, past the tail for one below or right.
- CSS in `agentCursorAnywhere.css` (not agentCursor.css): 6 px, stroke in `--agent-color`, `pointer-events: none`, the soft spring in, none under reduced motion. The golden DOM is untouched (no element unless parked).
- Gliding in: edge to anchor on the same element is a change of resolution kind, so `carried` is false and it is a flight from the edge, as asked; while still out of view the clamp point slides along the edge and the cursor rides it at 0 px.
- Tests: `tests/agentEdgePark.test.tsx` (clamp 12 px inside the bottom and top of a List clip, the Board's left edge, the window as a clip, stick while scrolling, chevron angle up and down, only while parked, glide in, reduced motion, no scroll call). Mutation: clamp removed fails 11 tests across it and `agentAnchorResolve.test.ts`.
- **Flag: the Board view culls.** `BoardCanvas` sets `onlyRenderVisibleElements`, so a card panned fully out of the pane has no DOM element and no anchor: the chain falls to the board's launcher, not an edge park. Partly visible cards work. Making "panned away" an edge park needs the card's position from the Studio's store plus the viewport (not DOM), or the anchored card kept rendered; not done here.
- The ratchet `agentCursorNoOpen.test.ts` now also scans `agentCursorHandoff.ts` and `agentCursorPark.ts`.

## The type caret on the screen layer (GM, 2026-11-05)

The shared field already draws `sayCaret` / `tipCaret` for any non-node target; no code change. Screen-layer tests pin: a `type` cursor on a Studio anchor shows `.agent-cursor__say-caret` while its say shows, `.agent-cursor__tip-caret` after the hold ends, and a count cursor has the tip caret. Mutation: `sayCaret` false for a surface target fails all three. GM also confirmed the outlines as built (2 rings, "+N" on the outermost counts the agents without a ring).

## Slices 7b–9 handoff (paused for restart)

Nothing committed, nothing stashed. No processes of mine left running; the two mutation backups were restored (verified identical). Gates (`tsc`, lint, ratchets, build, `pr_tests.sh`) have NOT been run on this state; the earlier build/lint run was on a half-edited tree. Not measured: entry bytes for 7b/8/9.

### 7b: culled Board cards (built, tests green: `tests/agentBoardCulled.test.tsx`, 6 pass; mutation "skip culled" failed 4, restored)
- `lib/agentBoardView.ts` (registry: boardId, pane, camera, cards, subscribe), registered from `BoardFlow` in `moodboard-studio/BoardCanvas.tsx` (effect after `shownRef`). Cards come from `shownRef` nodes (flow position and size), not a store.
- `ResolverEnv.culled?` in `lib/agentAnchorResolve.ts`; `exact()` returns an `edge` resolution (element = the pane) when nothing in the DOM matches an image anchor; `domEnv().culled` does pane rect + camera maths. `domEvents` in `agentCursorSpace.ts` wakes on `watchBoardView`.
- Left: confirm `entrySplit` passes (BoardCanvas now imports `lib/agentBoardView.ts`, listed in DEFERRED_MODULES; if BoardCanvas is on the entry graph the test will say). One test title was fixed from "bottom edge" to "top edge" (sed failed on BSD; redo with python if title still says bottom). No real-registry integration test through BoardFlow.

### 8: launcher dots (built; `tests/agentLauncherDots.test.tsx` 13 pass; mutation "keep removed agents" failed 3, restored)
- `lib/agentLauncherDots.ts` (`launcherDots`, `DotBook`, ghosts that fade on the soft spring), `ScreenSpace.launcherOf` in `agentCursorSpace.ts`, `LauncherDots` in `AgentScreenLayer.tsx`, CSS in `agentCursorAnywhere.css`, `AGENT_CURSOR_DOT` in `agentCursorTuning.ts`.
- Decisions to flag to GM: "+N" is count minus 1 (3 agents = one dot and "+2"); dots appear once the cursor has landed; a new target that still resolves to the same launcher keeps its dot. Ghost opacity moved to CSS (the inline-styles lint rejected static `opacity: 0`). Lint must be rerun to confirm.
- Left: add a CSS ratchet line for the dot rules if wanted (`agentScreenCss.test.ts` still passes by construction: no pointer-events there, no ease words; not re-run).

### 9: canvas edge chips (built, mostly untested)
- Files: `lib/agentEdgeChips.ts` (pure `planChips`, names), `lib/agentChipChrome.ts` (visible pane = pane less `.workspace-dock-panel, .chat-panel`; chrome = Inspector, `.agent-log`, Updates by existing class names), `lib/agentChipPress.ts` (the only pan, `springViewport`), `components/canvas/CanvasEdgeChips.tsx` (portal on body, rechecks every 250 ms plus store changes), `styles/agentEdgeChips.css` (own file; only `.agent-edge-chip` takes pointer events), tuning `AGENT_CURSOR_CHIP`/`_SPRING` and `--agent-cursor-chip` vars, mounted in `AgentCursorLayer.tsx`. `agentCursorNoOpen.test.ts` updated (PRESS_HANDLERS = agentChipPress.ts, new files scanned, 16 pass).
- HALF-DONE EDIT: the last python patch to `agentEdgeChips.ts` (obstacle chips stand OUTSIDE the panel face: `outside` group flag, mirrored `boxAt`, fallback to another face when no room) was applied but `tsc` and `tests/agentEdgeChips.test.ts` were not re-run. Before the patch 17 of 19 passed; the 2 failures were exactly the obstacle placement the patch fixes. Re-run it first; the 400-layout no-overlap property test must pass after it.
- Left: (a) `tests/agentEdgeChipsLayer.test.tsx` (mock React Flow store like `agentCursorLayer.test.tsx`: chip is a button named "Claude, show where it’s working", count is `role=img` named "+2 agents off screen", press calls `springViewport` once with a viewport centring the target and nothing pans on render; mock `viewportSpring`); (b) `tests/agentEdgeChipsCss.test.ts` (pointer-events auto only on `.agent-edge-chip`, reduced motion none, no ease words); (c) mutation "chip pans on render" (call `panToTarget` in an effect) must fail the render test; (d) chrome test for `readChipView` selectors; (e) all gates, entry bytes (stop past 503,500), `person_gate.py` diff empty, golden DOM test unchanged (chips are in a body portal, so it should be); (f) commit messages `commit-s7b.txt`, `commit-s8.txt`, `commit-s9.txt` (not written; /private/tmp is wiped, put them in the worktree if rewritten). Slices share hunks in `agentCursorSpace.ts`, `deferredChunks.ts`, `agentCursorTuning.ts`, `agentCursorSpringVars.ts` and `agentCursorNoOpen.test.ts`, so one combined message is simplest.
- Not verified: the dot/chip look in a browser; the drawn tip is approximated by the anchor's resolved point (not the column-offset tip); a `setSelection`-style real chip press in Canvas.

## Slices 7b–9 finished (after the restart)

- Entry bundle: 502,135 bytes (`index-C-OBbbHy.js`; limit 503,500). `entrySplit` passes.
- Launcher dots now match the design: 1 agent 1 dot, 2 agents 2 dots, 3+ two dots and "+N" counting the agents without a dot (3 agents "+1", 4 "+2"). Earlier handoff text ("one dot and +2") is superseded.
- Edge chips: obstacle chips stand outside the panel's face; `agentEdgeChips.ts` tsc fix (`as Side[]` for the sort). Chip layer caches the pane box (re-read on a moved view, resize, or a press), so its 250 ms recheck reads only the panels: `agentCursorLayer.test.tsx` "no layout read" caught the earlier version.
- `CanvasEdgeChips` sets its agents ref in an effect (react-hooks/refs) and carries one reasoned `set-state-in-effect` disable (DOM measurement, as elsewhere).
- Tests added: `agentEdgeChipsLayer.test.tsx`, `agentEdgeChipsCss.test.ts`, `agentChipChrome.test.ts`; a dot-CSS case in `agentScreenCss.test.ts`.

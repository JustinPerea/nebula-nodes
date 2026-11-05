# feat/cursor-anywhere (cursor Phase 3) notes

Branch from main dbc53287. Plan and GM rulings are in the coordinator's scratchpad; this file records decisions, surprises and entry bytes per slice.

## Entry bytes per slice

| Slice | Entry raw | Entry gzip | Cursor chunk (js raw / gzip) |
|---|---|---|---|
| 1 baseline (dbc53287) | 501,178 | 156,796 | 58.26 kB / 20.43 kB |
| 2 CursorSpace refactor | 501,178 | 156,771 | 58.65 kB / 20.64 kB |
| 3 protocol (frontend: types, `isAnchor`, says) | 501,168 | 156,792 | 60.29 kB / 21.11 kB |
| 4 anchors, attributes, resolver, `layerOf` | 501,664 | 156,994 | 60.54 kB / 21.22 kB |

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

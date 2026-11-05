# feat/cursor-anywhere (cursor Phase 3) notes

Branch from main dbc53287. Plan and GM rulings are in the coordinator's scratchpad; this file records decisions, surprises and entry bytes per slice.

## Entry bytes per slice

| Slice | Entry raw | Entry gzip | Cursor chunk (js raw / gzip) |
|---|---|---|---|
| 1 baseline (dbc53287) | 501,178 | 156,796 | 58.26 kB / 20.43 kB |
| 2 CursorSpace refactor | 501,178 | 156,771 | 58.65 kB / 20.64 kB |

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

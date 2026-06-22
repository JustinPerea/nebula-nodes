# Design Proposal — `g-cinema-per-shot-backend`

> Status: **awaiting sign-off** (user chose "plan first" for this gap). No code until approved.

## Problem
`CinemaShotPanel.handleGenerate()` calls `executeNode(cinemaNodeId)` for BOTH "Generate shot" and "Generate all" — there is no way to regenerate just one shot, and the per-shot variations strip is a stub. (Mitigation that already exists: the cinema-scene handler per-shot caches, so re-running the scene only regenerates *changed* shots.)

## Proposed scope (two parts, two PRs)
**Part A — per-shot generate entrypoint** (regenerate only the selected shot).
**Part B — real variations strip** (N variations per shot, pick the canonical one). *Recommend A first, B as a follow-up.*

## Approach
### Part A
- **Backend:** refactor the cinema-scene handler's existing per-shot Soul Cinema stack into a reusable `generate_one_shot(scene, shot, ...)` and add a dedicated route **`POST /api/cinema/generate-shot` `{nodeId, shotId}`** that runs it for one shot, writes the result to that shot's dynamic output port (`shot_<id>`), and broadcasts a graphSync (or a scoped executed event).
- **Frontend:** `graphStore.executeShot(nodeId, shotId)` calls the route; `CinemaShotPanel` "Generate shot" uses it; the shots-rail spinner scopes to that one row.

### Part B
- **Data model:** add `shot.variations: { url: string; seed: number }[]` + `shot.selectedVariation: number` to the scene spec. The canonical output (rail thumb, Send-to-motion, downstream port) reads the selected variation.
- **Flow:** a 1–4 stepper on the shot panel → run `generate-shot` N times with different seeds → render selectable thumbnails → click promotes one to canonical.

## Decisions needed (my recommendation in **bold**)
- **D1 — execution path:** dedicated `/api/cinema/generate-shot` route **(rec)** vs. a transient `_targetShotId` node param vs. extending the execute API. The route is cleanest and avoids mutating node params.
- **D2 — single-shot state merge:** the cinema node holds all shots' outputs; generating one shot must update only its port without clobbering the others (the handler already maps per-shot ports, so this is mechanical — but needs care in the graphSync merge).
- **D3 — variations storage:** on the scene spec (`shot.variations` + `selectedVariation`) **(rec)** vs. a separate store. On-spec means it persists with save/load for free.
- **D4 — split:** ship Part A alone first, Part B after **(rec)** — keeps each PR reviewable.

## Risk: **medium-high**
The cinema handler is async-poll orchestration; extracting a single-shot path is real surgery. The state-merge (D2) is the subtle part. Mitigated by: reusing the existing per-shot stack + ports, a dedicated route (no execute-path changes), and shipping A before B.

## Effort
- Part A: **M–L** (handler refactor + route + `executeShot` + badge scoping + tests).
- Part B: **M** (scene-spec fields + N-run + thumbnail strip + promote + tests).

## Test plan
Backend: unit-test `generate_one_shot` (mock the generator) + the route (single shot updates only its port). Frontend: `executeShot` wiring. Browser e2e: edit one shot → Generate shot → only that shot's output + badge change.

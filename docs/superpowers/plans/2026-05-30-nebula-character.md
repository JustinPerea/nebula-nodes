# Nebula Character v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, reusable "Character" (a saved identity asset, surfaced on the canvas as a node and edited in a Character Studio) that any image/scene node can consume for consistent characters across generations.

**Architecture:** Hybrid — a Character is a project-scoped **asset** (backend JSON store + `/api/characters`) referenced by a **`character` node** whose output is a typed `Character` port carrying the whole identity bundle (reference views + verbatim trait string + seed + consistency strength). Consumer handlers (Cinema Scene + edit nodes) expand that bundle into their model call. A **Character Studio** editor (mounts like the existing Remotion/Cinema Studio editors) defines the asset; a **library palette** browses/creates them. v1 = reference-edit only.

**Tech Stack:** Python 3.12 / FastAPI (backend, `.venv/bin/python -m pytest`), React 19 / TS / Zustand / @xyflow (frontend, `cd frontend && npx tsc --noEmit`, `npm run build`). Catalog is source-of-truth: `frontend/src/constants/nodeDefinitions.ts` → `npx tsx scripts/export-node-defs.ts` → `backend/data/node_definitions.json`. Contracts: `node scripts/check-node-contracts.mjs` + `backend/tests/test_node_contracts.py`.

**Spec:** `docs/superpowers/specs/2026-05-30-nebula-character-design.md`. Build on branch `feat/nebula-character` (off `feat/soul-cinema-studio`).

---

## File Structure

**Backend (create):**
- `backend/services/character_store.py` — Character CRUD over a JSON store (`~/.nebula/characters/{scope}/{id}.json`). One responsibility: persist/list Characters.
- `backend/handlers/character_node.py` — resolves a `character` node's `characterId` → emits the `CharacterBundle` on its output port.
- `backend/cinema/identity.py` — pure helper `expand_character(bundle, base_prompt, override_refs, model_max_refs) -> {prompt, image_urls, seed}` shared by all consumers (verbatim expansion + multi-ref capability check). Tested in isolation.
- `backend/tests/test_character_store.py`, `backend/tests/test_character_node.py`, `backend/tests/test_character_expand.py`

**Backend (modify):**
- `backend/main.py` — `/api/characters` routes + the `character` → `characterNode` React-Flow type resolver (mirror the `cinema-scene` branch).
- `backend/execution/sync_runner.py` — register `character` handler.
- `backend/handlers/cinema_scene.py` — consume a `Character`-typed input via `expand_character`.

**Frontend (create):**
- `frontend/src/components/nodes/CharacterNode.tsx` — canvas card (thumbnail + name + "Open Character" + typed output handle).
- `frontend/src/components/character-studio/` — `CharacterStudioView.tsx`, `CharacterLibraryRail.tsx`, `CharacterDefinitionPanel.tsx`, `CharacterTestPanel.tsx`, `CharacterStudioToolbar.tsx`, `character-studio.css`.
- `frontend/src/components/panels/CharacterLibrary.tsx` — palette to browse/create Characters.

**Frontend (modify):**
- `frontend/src/types/index.ts` — `PortDataType += 'Character'`; `NodeCategory += 'character'`; `Character` + `CharacterBundle` interfaces.
- `frontend/src/constants/ports.ts` — `PORT_COLORS.Character`, `CATEGORY_COLORS.character`.
- `frontend/src/lib/portCompatibility.ts` — `COMPATIBILITY.Character`.
- `frontend/src/constants/nodeDefinitions.ts` — the `character` node def + `CATEGORY_ORDER`; add a `character` input port to `cinema-scene` (+ edit nodes in a later iteration).
- `frontend/src/components/panels/NodeLibrary.tsx` — `CATEGORY_LABELS.character`.
- `frontend/src/components/Canvas.tsx` — register `characterNode` in `nodeTypes`.
- `frontend/src/store/uiStore.ts` — `characterEditorId` + `enterCharacterEditor`/`exitCharacterEditor`.
- `frontend/src/store/graphStore.ts` — `addCharacterNode(characterId, pos)`.
- `frontend/src/lib/api.ts` — `fetchCharacters/createCharacter/updateCharacter/deleteCharacter`.
- `frontend/src/App.tsx` — mount `CharacterStudioView` when `uiStore.characterEditorId` set.

---

## Task 1: The `Character` port type + `character` category

**Files:** Modify `frontend/src/types/index.ts`, `frontend/src/constants/ports.ts`, `frontend/src/lib/portCompatibility.ts`, `frontend/src/components/panels/NodeLibrary.tsx`; Modify `scripts/check-node-contracts.mjs` + `backend/tests/test_node_contracts.py` (extend valid sets). Test: `frontend` typecheck + contract check.

- [ ] **Step 1: Add the types.** In `types/index.ts`: add `'Character'` to the `PortDataType` union and `'character'` to the `NodeCategory` union; add the interfaces from spec §3 (`Character`, `CharacterBundle`) verbatim.
- [ ] **Step 2: Colors + compatibility.** `ports.ts`: `PORT_COLORS.Character = '#a78bfa'`, `CATEGORY_COLORS.character = '#a78bfa'`. `portCompatibility.ts`: add `Character: ['Character', 'Any']` to `PORT_COLORS`/`COMPATIBILITY` (match the existing matrix shape). `NodeLibrary.tsx`: `CATEGORY_LABELS.character = 'Character'`.
- [ ] **Step 3: Extend the contract validators** (mirror the Soul Cinema precedent): add `'Character'` to the valid port-types set and `'character'` to valid categories in BOTH `scripts/check-node-contracts.mjs` and `backend/tests/test_node_contracts.py`.
- [ ] **Step 4: Verify.** `cd frontend && npx tsc --noEmit` (exit 0) and `node scripts/check-node-contracts.mjs` (passes). Expected: clean — no node uses the new type/category yet, but the unions/validators accept them.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(character): add Character port type + character category"`

## Task 2: Backend Character store + `/api/characters`

**Files:** Create `backend/services/character_store.py`, `backend/tests/test_character_store.py`; Modify `backend/main.py`.

- [ ] **Step 1: Write the failing store test** (`test_character_store.py`): create a Character (name, subjectType, referenceViews ≥3, frozenTraitString, seed, consistencyStrength) under a temp store root (monkeypatch the store dir); assert `get` round-trips it verbatim (referenceViews order + traitString byte-identical), `list(scope='project', projectId=...)` returns it, `list(scope='global')` excludes it, `update` bumps `version` + `updatedAt`, `delete` removes it. Assert `create` with <3 referenceViews raises `ValueError`.
- [ ] **Step 2: Run → FAIL** (`cd backend && .venv/bin/python -m pytest tests/test_character_store.py -q`) — module missing.
- [ ] **Step 3: Implement `character_store.py`.** A `CharacterStore` (or module fns) over JSON files at `CHAR_ROOT/{projectId|"_global"}/{id}.json`, `CHAR_ROOT` defaulting under `~/.nebula/characters` and overridable via env for tests. `create()` validates ≥3 referenceViews, assigns `id` (uuid4 hex[:12]), `version=1`, timestamps; `get/list/update/delete` as tested. No external deps.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Add `/api/characters` routes** in `main.py`: `GET /api/characters?scope=&projectId=`, `POST /api/characters`, `GET/PUT/DELETE /api/characters/{id}` delegating to the store; Pydantic model matching the `Character` shape. Add a route test in `backend/tests/test_cli_api.py` (or a new `test_character_api.py`) using the FastAPI TestClient: POST then GET returns it; PUT bumps version; DELETE 404s afterward.
- [ ] **Step 6: Run the API test → PASS**, then full backend suite from `backend/` → no regressions.
- [ ] **Step 7: Commit.** `git commit -m "feat(character): project-scoped Character store + /api/characters CRUD"`

## Task 3: The `character` node (def + renderer + handler + wiring)

**Files:** Modify `nodeDefinitions.ts` (def + CATEGORY_ORDER), run exporter; Create `CharacterNode.tsx`, `backend/handlers/character_node.py`, `backend/tests/test_character_node.py`; Modify `Canvas.tsx`, `backend/main.py` (type resolver), `backend/execution/sync_runner.py`.

- [ ] **Step 1: Add the node def** to `nodeDefinitions.ts`: id `character`, category `'character'`, `apiProvider:'utility'`, `executionPattern:'sync'`, no input ports, one output port `{id:'character', label:'Character', dataType:'Character'}`, params: `override_prompt` (textarea), `override_refs` (file, optional), `strength_override` (float 0–1, optional, default ''). Add `'character'` to `CATEGORY_ORDER`. Run `npx tsx scripts/export-node-defs.ts` (regenerates `node_definitions.json`); run `node scripts/generate-model-reference.mjs` (keep the doc in sync, per the Soul Cinema precedent).
- [ ] **Step 2: Failing handler test** (`test_character_node.py`): given a Character in a temp store and a `character` node whose `params.characterId` points at it, `handle_character_node` returns `{character: {type:'Character', value: <CharacterBundle>}}` where the bundle's `referenceViews` + `frozenTraitString` match the stored asset verbatim; a missing id raises a clear `ValueError("Character not found: ...")`.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `character_node.py`** — read `node.params['characterId']`, load from `character_store`, build a `CharacterBundle` dict, return it on the `character` port. Register in `sync_runner.py` `get_handler_registry` (async closure pattern, like `style-reference`).
- [ ] **Step 5: Run handler test + `test_node_contracts.py` → PASS** (the `character` id now has both a def and a handler).
- [ ] **Step 6: Renderer + canvas wiring.** Create `CharacterNode.tsx` (mirror `CinemaSceneNode.tsx`: thumbnail from the resolved Character, name, "Open Character" → `uiStore.enterCharacterEditor(characterId)`, a right-side `Character`-typed output handle colored `PORT_COLORS.Character`). Register `characterNode` in `Canvas.tsx` `nodeTypes`; add the `character → characterNode` branch to `main.py`'s type resolver (mirror `cinema-scene`).
- [ ] **Step 7: Verify** `npx tsc --noEmit`, `node scripts/check-node-contracts.mjs`, backend cinema/contracts suite. Commit `feat(character): character node — def, renderer, handler, wiring`.

## Task 4: Consumer expansion + multi-ref capability check

**Files:** Create `backend/cinema/identity.py`, `backend/tests/test_character_expand.py`; Modify `backend/handlers/cinema_scene.py`; Modify `nodeDefinitions.ts` (add `character` input port to `cinema-scene`) + re-export.

- [ ] **Step 1: Failing expand test** (`test_character_expand.py`): `expand_character(bundle, base_prompt="a forest at dawn", override_refs=["o1.png"], model_max_refs=14)` returns `prompt == f"{bundle.frozenTraitString}. a forest at dawn"` (trait string VERBATIM, prepended), `image_urls == bundle.referenceViews + ["o1.png"]` (order preserved), `seed == bundle.seed`. With `model_max_refs=1` and a 3-view bundle, it raises `ValueError` mentioning the model can't accept the ref count (the FLORA silent-failure guardrail). Empty/None bundle → returns base_prompt unchanged (no-op).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `cinema/identity.py::expand_character`** per the assertions (pure function, no I/O).
- [ ] **Step 4: Wire `cinema_scene.py`** to read a `character` input (the bundle) when present and route base generation through `expand_character` (using the chosen base model's `maxRefs` from a small table: `nano-banana-2/edit`=14, `seedream-4-5/edit`=10, default/unknown=1). The existing `character_refs` Images become the `override_refs`. Add the `character` input port to the `cinema-scene` def in `nodeDefinitions.ts`; re-export.
- [ ] **Step 5: Update/extend `test_cinema_scene.py`** — a scene with a `character` input expands to verbatim refs+trait+seed (mocked base); a bundle exceeding the base model's maxRefs raises the clear error.
- [ ] **Step 6: Run cinema + contract suites → PASS.** Commit `feat(character): consumers expand the Character bundle (verbatim) + multi-ref capability check`.

## Task 5: Frontend store/api/uiStore wiring

**Files:** Modify `frontend/src/lib/api.ts`, `frontend/src/store/uiStore.ts`, `frontend/src/store/graphStore.ts`.

- [ ] **Step 1:** `api.ts` — add `fetchCharacters(scope, projectId?)`, `createCharacter(body)`, `updateCharacter(id, body)`, `deleteCharacter(id)` mirroring the existing typed REST helpers (`getSettings`/`fetchOpenRouterModels` shapes).
- [ ] **Step 2:** `uiStore.ts` — add `characterEditorId: string|null`, `enterCharacterEditor(id)`, `exitCharacterEditor()` (mirror `enterRemotionEditor`/`enterCinemaEditor`).
- [ ] **Step 3:** `graphStore.ts` — `addCharacterNode(characterId, position)` creates a `character` node with `data.params.characterId` set (mirror `addNode` + the optimistic `/api/graph/node` round-trip).
- [ ] **Step 4:** Verify `npx tsc --noEmit` (exit 0). Commit `feat(character): api + uiStore + graphStore wiring`.

## Task 6: Character Studio editor + library palette

**Files:** Create `frontend/src/components/character-studio/*` + `CharacterLibrary.tsx`; Modify `App.tsx`.

- [ ] **Step 1:** Create the five `character-studio/` components per spec §4.5 and the approved layout (library rail with project⇄global toggle; definition panel with the multi-view bundle uploader [≥3, via `/api/uploads`], `frozenTraitString` textarea, seed, consistency slider, auto thumbnail; a test-generate panel; toolbar back-to-canvas). All edits persist via the `api.ts` character helpers. Reuse `CinemaSharedControls`/`CinemaShotPanel` patterns for upload + sliders.
- [ ] **Step 2:** Mount `CharacterStudioView` in `App.tsx` `mainView` when `uiStore.characterEditorId` is set (mirror the Cinema Studio mount).
- [ ] **Step 3:** `CharacterLibrary.tsx` palette — list Characters (project + global toggle), "New Character" → create a draft + `enterCharacterEditor`, drag/click to `addCharacterNode`.
- [ ] **Step 4:** Verify `npx tsc --noEmit` + `npm run build` (exit 0). Commit `feat(character): Character Studio editor + library palette`.

## Task 7: Non-human empirical test + full verification

**Files:** Create `docs/character-smoke/` (artifacts); no code.

- [ ] **Step 1:** With the backend running, create a non-human/stylized Character (≥3 reference views of a single non-human subject) and run a test generation through the default `nano-banana-2/edit`. Save before/after to `docs/character-smoke/` with an `index.md`. **Decision gate:** if non-human identity holds → keep `nano-banana-2/edit` default; if it underperforms → set the default to `seedream-4-5/edit` (or a per-`subjectType` default) and note it in the spec.
- [ ] **Step 2:** Full verify: `cd backend && .venv/bin/python -m pytest tests/ -q` (green) + `cd frontend && npx tsc --noEmit && npm run build` + `node scripts/check-node-contracts.mjs` + frontend↔backend node-def parity.
- [ ] **Step 3:** Playwright smoke (bonus, not a blocker): open Character Studio → create a Character with 3 views + trait string → drop a Character node → wire into Cinema Scene's `character` port → confirm the bundle resolves. Commit `test(character): non-human smoke + full verification`.

---

## Self-Review

- **Spec coverage:** §3 data model → Task 1/2; §4.1 store/API → Task 2; §4.2 port type → Task 1; §4.3 node → Task 3; §4.4 consumer expansion + capability check → Task 4; §4.5 Studio → Task 6; §4.6 palette + store wiring → Task 5/6; §5 non-human guardrail → Task 7; §7 testing → distributed per task. All sections covered.
- **Placeholder scan:** no TBD/TODO; each task names exact files, concrete test assertions, exact commands, and a commit. The few "mirror the existing pattern" instructions reference a specific existing file (e.g. `CinemaSceneNode.tsx`, `enterCinemaEditor`, the `cinema-scene` type-resolver branch) the executor reads directly — acceptable for an existing codebase with subagent execution.
- **Type consistency:** `Character`/`CharacterBundle` (Task 1) are the shapes used by the store (Task 2), handler (Task 3), and `expand_character` (Task 4); the `character` output port id and the `cinema-scene` `character` input port id match; `enterCharacterEditor(characterId)` is consistent across CharacterNode (Task 3), uiStore (Task 5), and the Studio (Task 6).
- **Edit-node consumers:** v1 wires the `character` port into `cinema-scene` (Task 4); extending the same `character` input + `expand_character` call to the standalone `nano-banana-2/edit`/`seedream-4-5/edit`/`flux-kontext` nodes is a mechanical repeat deferred to a follow-up task to keep v1 focused — flagged here so it isn't mistaken for missing scope.

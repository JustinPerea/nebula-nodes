# Nebula Character — Design Spec (v1)

**Date:** 2026-05-30
**Status:** Approved (design), pre-plan
**Depends on:** the Cinema Scene work (`feat/soul-cinema-studio`) — reuses its `character_refs` port, editor-mount pattern, and catalog conventions.
**Research basis:** `docs/perplexity-research/Nebula Character + Higgsfield Identity — Research Synthesis.md`; vault notes `ai-character-identity-2026-05`, `higgsfield-suite-2026-05`; vault prior art (Inbetween `characters` table, Pheme "character bible"); UI sweep of Higgsfield Soul ID + FLORA (2026-05-30).

## 1. What we're building & why

We have **per-scene** character consistency (the Cinema Scene's `character_refs` port re-fed each run) but **no defined, reusable character** — Higgsfield's Soul ID ("train once, publish forever"; multiple personas per account). This spec adds the **Nebula Character**: a persistent, named, reusable identity that you define once and drop into any graph/studio.

The vault confirms this is the user's own established pattern (Inbetween's `characters` table; Pheme's versioned "character bible") and his written Nebula thesis ("promote per-node refs to **first-class assets**, not scoped to the node instance"; "build identity as a **first-class primitive, then studios consume it**"). Identity is the shared primitive under every future studio (Cinema, Marketing/UGC, Ads).

## 2. Locked decisions

1. **Shape = hybrid.** A Character is a first-class, saved **asset** (source of truth) surfaced on the graph as a **node** that references it by id.
2. **Storage = project-scoped store + a global palette view** (mirrors Inbetween).
3. **Definition = a multi-view reference bundle** (required, ≥3 views) + a **frozen trait string** (re-emitted verbatim) + **seed** + **consistency strength** + thumbnail.
4. **v1 method = reference-edit only** (zero-training, commercial-OK, non-human-capable, reachable today). Trained-LoRA = v2 *underneath the same Character* (no UX change); face-ID = v3, gated to `subjectType: human`.
5. **Identity flows via a typed `Character` port** — the whole bundle travels as one wire (FLORA's "Element"). (Rejected: reusing the Image `character_refs` port loses the trait/seed/strength; a no-wire picker loses graph-native composition.)
6. **Surface = a "Character Studio" editor view** (mounts like the Remotion editor / Cinema Studio), plus a **Character library palette**. (Upgraded from the earlier "lighter panel" at the user's request.)
7. The current per-scene `character_refs` **demotes from "the definition" to the per-use override layer** (pose / expression / wardrobe / framing).

## 3. Data model

```ts
// frontend/src/types/index.ts (new) — also the backend store shape
interface Character {
  id: string;
  name: string;
  version: number;
  subjectType: 'human' | 'non-human' | 'stylized';
  referenceViews: string[];        // the multi-view bundle (required, >=3); /api/outputs or /api/uploads URLs
  frozenTraitString: string;       // re-emitted VERBATIM into prompts — paraphrase breaks identity (Seedance finding)
  seed: number;                    // fixed seed for repeatability (Pheme "seed 84" pattern)
  consistencyStrength: number;     // 0..1 — the --ow / IP-adherence analog
  thumbnail: string;               // auto-picked from referenceViews
  projectId?: string;              // project-scoped; absent = global
  createdAt: string; updatedAt: string;
}

// The bundle that travels on the typed `Character` port at runtime:
interface CharacterBundle {
  characterId: string; name: string;
  referenceViews: string[]; frozenTraitString: string;
  seed: number; consistencyStrength: number;
}
```

## 4. Architecture

### 4.1 Character asset store (backend)
- A project-scoped JSON store under the project data dir (e.g. `~/.nebula/characters/<projectId>/<id>.json`), plus a global namespace. Mirrors Inbetween's SQLite/filesystem library; JSON is enough for v1 (upgrade to SQLite if needed).
- `backend/services/character_store.py` — CRUD + list (by project, + global).
- `backend/main.py` — `/api/characters` REST: `GET /api/characters?scope=project|global`, `POST`, `GET/PUT/DELETE /api/characters/{id}`. Reference views uploaded via the existing `/api/uploads`.

### 4.2 The `Character` port type
- `types/index.ts`: add `'Character'` to `PortDataType`.
- `constants/ports.ts`: `PORT_COLORS['Character']` (distinct hue, e.g. violet `#a78bfa`).
- `lib/portCompatibility.ts`: `COMPATIBILITY['Character'] = ['Character']` (+ `'Any'`); a `Character` output connects only to a `Character` input.

### 4.3 The `character` node
- New node `character` in `nodeDefinitions.ts`, new category `'character'` (NodeCategory union + `CATEGORY_COLORS` + `CATEGORY_LABELS` + `CATEGORY_ORDER`). `apiProvider: 'utility'`, `executionPattern: 'sync'`.
- Output: one `Character`-typed port emitting the `CharacterBundle`.
- Params (the **per-use override layer**, layered on top of the referenced asset): `override_prompt` (pose/expression/wardrobe/framing), optional `override_refs` (extra Image refs), optional `strength_override`.
- Stores `characterId` on `node.data` (a runtime reference, like `configureOpenRouterModel` writes `modelId`). Renders via a custom `CharacterNode.tsx` (thumbnail + name + "Open Character" button + the typed output handle), registered in `Canvas.tsx` `nodeTypes` + the `backend/main.py` type resolver (mirrors `cinemaSceneNode`).
- Handler `backend/handlers/character_node.py`: resolve `characterId` from the store → emit the `CharacterBundle` on the output port. `sync`.
- **Override layer wiring (shipped):** the handler reads its own `node.params` and packs the per-use override layer into the bundle as optional fields — `overridePrompt` (from `override_prompt`), `overrideRefs` (from the `override_refs` `file` param, wrapped as a one-element list), `strengthOverride` (from `strength_override`, the `''` sentinel = inherit, parsed/clamped to 0..1). Fields are omitted when empty so an unconfigured node emits a bundle byte-identical to the identity-only shape. These are **applied by the consumer** (`expand_character`), not by this node — `CharacterBundle` in `frontend/src/types/index.ts` carries them as optional fields.

### 4.4 Consumers
- The **Cinema Scene** and the **edit nodes** (`nano-banana-2/edit` default, `seedream-4-5/edit`, `flux-kontext`) gain a `character` input port (typed `Character`).
- On run, the handler **expands the bundle** (`backend/cinema/identity.py::expand_character`):
  - **prompt** — the trait string leads VERBATIM, the base prompt follows, and the per-use `overridePrompt` (when set) trails as additional direction: `"{frozenTraitString}. {userPrompt}. {overridePrompt}"` (or `"{frozenTraitString}. {userPrompt}"` when no override). The verbatim trait anchor refines, never displaces, scene/shot intent.
  - **image_urls** — `referenceViews` (verbatim, first) ++ the bundle's node-level `overrideRefs` ++ the consumer's scene/shot `override_refs` parameter. Order preserved; the capability guard counts the FINAL total (including `overrideRefs`) against the model's `maxRefs`.
  - **seed** — `bundle.seed`.
  - **strength** — the effective consistency strength = `strengthOverride` if set, else `consistencyStrength`. **Applied where supported only (honest):** injected into the base call's params **only for a base model that exposes a real IP-adherence knob** (a small per-base-model `MODEL_STRENGTH_PARAM` name map, keyed like `MODEL_MAX_REFS`). **For v1 reference-edit bases there is NO such knob** — `nano-banana` (Gemini 3.1 Flash Image / "Nano Banana 2") drives identity purely by re-feeding refs (its `imageConfig` accepts only `aspectRatio`/`imageSize`); `seedream-4-5` exposes no reference-strength param; `flux-kontext` likewise. So in v1 `MODEL_STRENGTH_PARAM` is empty: the strength is **carried in the bundle but not applied** (fabricating a param the model ignores would be a silent no-op). The dial becomes **active in v2** (trained-LoRA: a LoRA scale IS a real adherence knob). When a base gains a confirmed adherence param, add it to the map and it flows automatically.
- **Multi-ref capability hard-check (guardrail):** before running, verify the target model accepts ≥ the bundle's view count; if not, raise a clear error (never the FLORA-style silent single-ref failure). A small per-model `maxRefs` table (nano-banana-2 = 14, seedream v4 = 10, kontext-multi = unknown→treat as 1 until confirmed).
- The existing `character_refs` (Images) remains as the explicit override path; a Character node may feed either the new `character` port (preferred) or, for back-compat, its referenceViews into `character_refs`.

### 4.5 Character Studio (editor view)
`frontend/src/components/character-studio/` — mounts via `uiStore.characterEditorId` → `App.tsx` `mainView` (same pattern as Remotion / Cinema Studio). Approved layout:
- `CharacterStudioView.tsx` — host; reads/writes the Character asset via `/api/characters`.
- `CharacterLibraryRail.tsx` — list of saved Characters with a **project ⇄ global** toggle; "+ New".
- `CharacterDefinitionPanel.tsx` — name, `subjectType`, the **multi-view reference bundle** (drop/upload grid, ≥3 required), `frozenTraitString` textarea, `seed`, `consistencyStrength` slider, auto thumbnail.
- `CharacterTestPanel.tsx` — a "test generate" box (prompt → run through the default base with this Character) to **validate identity holds** before use.
- `CharacterStudioToolbar.tsx` — back-to-canvas, save (autosave via the store round-trip).

### 4.6 Library palette + store wiring
- A **Character palette** (sibling to `NodeLibrary`): browse/pick saved Characters (project + global), drag onto canvas to create a `character` node referencing that asset; "New Character" opens the Studio.
- `lib/api.ts`: `fetchCharacters(scope)`, `createCharacter`, `updateCharacter`, `deleteCharacter`.
- `store/uiStore.ts`: `characterEditorId`, `enterCharacterEditor(id)`, `exitCharacterEditor()`.
- `store/graphStore.ts`: `addCharacterNode(characterId, position)` (writes `characterId` to node data + the round-trip).

## 5. Default model & the non-human guardrail
Default "generate with Character" base = **`nano-banana-2/edit`** (14 refs, commercial, Gemini 3.1). **Before hard-coding this default, run an empirical test** generating a non-human/stylized character through it (the research flagged non-human support as *inferred, not stated*). If it underperforms on non-human subjects, fall back to `seedream-4-5/edit` or surface a per-`subjectType` default.

## 6. Error handling
- Missing/deleted referenced Character → node shows a clear "Character not found" state, not a crash.
- Multi-ref capability mismatch → explicit error (§4.4 guardrail).
- < 3 reference views on save → block with guidance ("a Character needs at least 3 reference views").
- Verbatim contract: never paraphrase `frozenTraitString` or reorder `referenceViews` (identity-breaking).
- Store/API offline → optimistic local state + clear retry, mirroring `graphStore`'s offline fallback.

## 7. Testing
- Contract tests: new `character` node id has a handler; new `'Character'` port type + `'character'` category accepted by the validators (`check-node-contracts.mjs`, `test_node_contracts.py`).
- `character_store` CRUD tests (create/list-by-scope/update/delete; project vs global).
- Handler test: a Character bundle expands to **verbatim** referenceViews + trait string + seed in the consumer's model call (mocked base).
- Multi-ref capability-check test (bundle of N > model max → clear error).
- Frontend: `tsc` + `vite build`; a Playwright smoke (open Character Studio → create Character with N views + trait string → drop a Character node → wire into Cinema Scene → the `character` input resolves the bundle).
- Non-human empirical smoke (§5) before locking the default.

## 8. Scope & phasing
- **v1 (this spec):** asset + store + `/api/characters` + `Character` port type + `character` node + Character Studio + library palette + consumer integration (Cinema Scene + edit nodes) + reference-edit generation.
- **v2:** a **Train** action on a Character → `fal-ai/flux-lora-fast-training` → fills a `trainedAdapter` ({loraUrl, triggerToken, baseModel:'flux-dev'}); a "trained" Character drives a LoRA-attach generate node. The Character is **unchanged to the user** — the backing mechanism upgrades underneath. Surface the FLUX.1-dev license note (outputs commercial-OK; adapter not for resale).
- **v3:** face-ID modes (`fal-ai/flux-pulid`, later InstantID/FaceID), gated to `subjectType: 'human'` — never offered for non-human.
- **Roadmap after Character** (identity is the shared primitive): Character library polish → Marketing/UGC Studio → Ad-from-URL → lip-sync → video studio.

## 9. Out of scope (v1)
Trained-LoRA (v2), face-ID (v3), the Marketing/UGC studio, ad-from-URL, lip-sync, a full preset/"looks" gallery for Characters (Higgsfield's 60+ presets — later; cinema-look already covers film grades).

## 10. Build order (for the plan)
1. `Character` port type + `'character'` category (types/ports/compatibility/labels). 2. Backend `character_store` + `/api/characters`. 3. `character` node def + `CharacterNode.tsx` + handler + Canvas/main.py wiring. 4. Consumer expansion (Cinema Scene + edit handlers read the `Character` port + verbatim expansion + capability check). 5. `uiStore`/`api.ts`/`graphStore` wiring. 6. Character Studio view + library palette. 7. Non-human empirical test + tests + verify.

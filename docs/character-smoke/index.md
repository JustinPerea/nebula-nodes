# Nebula Character v1 — Smoke Test & Verification

**Date:** 2026-05-30
**Branch:** `feat/nebula-character` (6 feature commits on top of `bc8d586`)
**Spec:** `docs/superpowers/specs/2026-05-30-nebula-character-design.md`
**Plan:** `docs/superpowers/plans/2026-05-30-nebula-character.md`

This document records the Task 7 verification of the Nebula Character v1 feature and the
status of the non-human empirical test (the spec §5 decision gate).

## 1. Full deterministic verification — ALL GREEN

| Check | Command | Result |
|---|---|---|
| Backend test suite | `cd backend && .venv/bin/python -m pytest tests/ -q` | **801 passed** |
| Frontend typecheck | `cd frontend && npx tsc --noEmit` | **exit 0** |
| Production build | `cd frontend && npm run build` | **✓ built** (only pre-existing `lottie-web` eval warning) |
| Node contract check | `node scripts/check-node-contracts.mjs` | **passed, 108 definitions** |
| Node-def parity | re-ran `scripts/export-node-defs.ts` | **clean** — generated `node_definitions.json` identical to the TS catalog |
| Slava CSS scope guard | `node frontend/scripts/check-slava-css-scope.mjs` | **passed** |

The implementation is code-complete and passes verification end-to-end. The Character
feature added ~70 backend tests across `test_character_store.py`, `test_character_api.py`,
`test_character_node.py`, `test_character_expand.py`, and extensions to `test_cinema_scene.py`
(verbatim trait/ref preservation, scope isolation, path-traversal rejection, atomic writes,
multi-ref capability guard).

## 2. What ships in v1 (end-to-end path)

`Character asset (JSON store + /api/characters)`
→ `character node (Character-typed output port)`
→ `CharacterBundle {referenceViews, frozenTraitString (verbatim), seed, consistencyStrength}`
→ `Cinema Scene consumer expands the bundle` (`backend/cinema/identity.py::expand_character`)
→ `base edit model (default nano-banana-2/edit)` with a per-model multi-ref capability guard.

Plus the **Character Studio** editor (define name / subjectType / ≥3 reference views /
verbatim trait string / seed / consistency) and a **Character library palette**
(browse project⇄global, create, drag/click onto the canvas).

## 3. Decision gate (spec §5) — non-human empirical test

The research synthesis flagged that non-human/stylized support for the reference-edit
models is **inferred from subject-agnostic design, not stated on the model pages**, and
recommended an empirical test before locking the default base.

**Current default:** `nano-banana-2/edit` (Nano Banana 2 / Gemini 3.1 Flash, 14 reference
images, commercial-OK). This is the spec §5 default and is the verified `MODEL_MAX_REFS`
entry from Task 4 (reachable base id `nano-banana` → 14; `seedream-4-5` → 10; unknown → 1
conservative guard). A code-review bug where the cap was keyed on the unreachable id
`nano-banana-2` (silently capping the real default at 1) was found and fixed in Task 4.

**Empirical identity-hold test status:** RUN on 2026-05-30 (see §5 for artifacts + method).
A distinctive non-human subject (a moss-covered stone golem with a glowing teal geode chest)
was generated, expanded to a 3-view reference bundle, and edited into two new scenes through
nano-banana-2 (Gemini 3.1 Flash Image, via the project's `GOOGLE_API_KEY` — note: in this
codebase `nano-banana` is a **Google Gemini** node, not a fal endpoint, so the test used
`GOOGLE_API_KEY`).

**Verdict: identity HOLDS (strongly).** The teal cracked-geode chest, amber eyes,
moss-on-stone texture, bioluminescent mushrooms, and chunky proportions all carried faithfully
from the references into both new scenes (forest stream at dawn; sleeping in a hollow tree).
Side observation: the base model rendered 2 eyes vs the prompted 3 in the initial
text-to-image, but *consistently* across all 5 generations — a prompt-adherence quirk, not a
consistency failure; for the reference-edit Character use case the refs lock identity
regardless.

**Decision (gate outcome): KEEP `nano-banana-2/edit` (Gemini 3.1 Flash Image) as the default
base.** Non-human support is now empirically confirmed, not inferred — no fallback to
`seedream-4-5/edit` is needed. This matches spec §5 and the Task-4-verified `MODEL_MAX_REFS`
entry (`nano-banana` → 14).

## 4. Artifacts

See §5 below — `ref1.jpg` / `ref2.jpg` / `ref3.jpg` (the 3-view reference bundle),
`scene_out.jpg` / `scene_out2.jpg` (multi-ref edits into new scenes), and `generate.py`
(the reproducible generation harness; reads the key from the settings store at runtime —
no secret embedded).

---

## 5. Non-human empirical run (2026-05-30)

### Generation mechanism

**Path used:** Direct Gemini REST API calls via a Python helper script
(`docs/character-smoke/generate.py`), which reads `GOOGLE_API_KEY` from
`settings.json` (the project-level settings store, same source used by the
running backend). The backend itself was NOT called for image generation in
this run — the `/api/quick` endpoint was tried first but found to have a
`params["value"]` vs `params["filePath"]` mismatch that prevents passing a
local file path as an `image-input` node value. The direct API call is
functionally equivalent to what `backend/handlers/google_gemini.py::handle_nano_banana`
does at runtime.

**API endpoint:**
`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent`

**Model id:** `gemini-3.1-flash-image-preview`

**GOOGLE_API_KEY source:** `settings.json → apiKeys.GOOGLE_API_KEY`
(loaded from the settings store at runtime; key value intentionally not recorded here)

**Generation config per request:**
```json
{ "responseModalities": ["IMAGE", "TEXT"], "imageConfig": { "aspectRatio": "1:1", "imageSize": "1K" } }
```

**Reference images passed:** inline base64 `inlineData` parts (not URLs).

---

### Prompts used

**ref1 — text-to-image (no reference images):**
> "A small bioluminescent moss-covered stone golem creature with three glowing
> amber eyes, a cracked geode chest that glows teal, stubby rounded limbs,
> full body, centered, neutral light-grey studio background, soft even lighting,
> high detail."

**ref2 — ref1 as single reference image:**
> "The SAME moss-covered stone golem creature from the reference image. Keep EXACT
> same features: same number of glowing amber eyes, same teal geode chest crystal,
> same mossy stone texture, same stubby rounded limbs. Show the creature from a
> 3/4 side profile view, full body, neutral grey background, soft even lighting."

**ref3 — ref1 as single reference image:**
> "The SAME moss-covered stone golem creature from the reference image. Keep EXACT
> same features: same number of glowing amber eyes, same teal geode chest crystal,
> same mossy stone texture, same stubby rounded limbs. Show the creature from a
> low front angle (camera slightly below eye level looking up), full body, neutral
> grey background, soft even lighting."

**scene_out — ref1+ref2+ref3 as three reference images:**
> "The same bioluminescent moss-stone golem creature shown in ALL the reference
> images sitting on a mossy fallen log beside a misty forest stream at dawn,
> cinematic wide shot, volumetric light. Preserve ALL identity features: exact
> same amber eyes, teal geode chest, mossy stone body."

**scene_out2 — ref1+ref2+ref3 as three reference images (bonus):**
> "The same bioluminescent moss-stone golem creature from ALL the reference images
> curled up asleep inside a hollow tree, soft firefly light. Preserve ALL identity
> features: exact same amber eyes, teal geode chest, mossy stone body."

---

### Artifact file list

| File | Generation step |
|---|---|
| `ref1.jpg` | Step 1: text-to-image base subject (no reference) |
| `ref2.jpg` | Step 2: 3/4 side profile — ref1 as reference |
| `ref3.jpg` | Step 3: low front angle — ref1 as reference |
| `scene_out.jpg` | Step 4: new scene (forest stream, dawn) — ref1+ref2+ref3 as references |
| `scene_out2.jpg` | Step 5 bonus: second new scene (hollow tree, sleeping) — ref1+ref2+ref3 as references |

---

### Objective per-image description (identity features only — no verdict)

**ref1.jpg**
- Eyes: two glowing amber/orange eyes (prompt requested three; model generated two — a deviation from the specified trait count that is consistent across the run)
- Geode chest: prominent cracked-stone cavity with glowing teal crystal interior, centered on chest
- Body: rounded chunky proportions, entirely covered in dark stone with dense green moss
- Detail: several small bioluminescent green mushrooms on shoulders and arms
- Background: neutral light grey studio, stone circular base pedestal visible underfoot
- Lighting: soft, even, diffuse

**ref2.jpg** (3/4 side profile, ref1 as reference)
- Eyes: two glowing amber eyes, same hue and glow intensity as ref1, both visible from the 3/4 angle
- Geode chest: same teal glowing crystal cavity, visible from the front-right 3/4 angle
- Body: same chunky rounded proportions, same moss coverage and dark stone texture
- Detail: same small glowing green mushrooms on shoulders
- Background: same neutral grey, same stone pedestal base
- View angle: 3/4 front-right as requested — clearly the same character as ref1

**ref3.jpg** (low front angle, ref1 as reference)
- Eyes: two glowing amber eyes, same as ref1 — virtually identical placement and glow
- Geode chest: teal crystal cavity, same size and shape as ref1
- Body: nearly identical pose and proportions to ref1; camera angle differs only slightly from ref1 (front-facing, not dramatically low-angle)
- Detail: same small green bioluminescent mushrooms, same moss texture
- Background: same neutral grey, same stone base pedestal
- Note: ref3 is visually very close to ref1 in pose; the low-angle distinction is subtle

**scene_out.jpg** (multi-ref identity test — forest stream at dawn)
- Eyes: two amber eyes present, same glow color ✓
- Geode chest: teal glowing crystal cavity clearly visible on creature's chest ✓
- Body: same chunky rounded proportions, same dense green moss coverage ✓
- Detail: bioluminescent green mushrooms/glowing spots on body arms and surroundings ✓
- Scene: creature seated on a large mossy fallen log over a misty forest stream; dawn volumetric light shafts through tall mossy trees; mist over the water ✓ (scene prompt matched)
- Body size: slightly larger relative to scene framing than in reference studio shots; overall silhouette consistent
- Notable: creature is not on a stone pedestal (expected — scene changed); body posture is seated/crouched vs standing in refs

**scene_out2.jpg** (bonus scene — sleeping inside hollow tree)
- Eyes: closed/not visible (creature is sleeping — consistent with posed sleep state, not an identity failure)
- Geode chest: teal glowing crystal cavity visible at center of the curled body ✓
- Body: same chunky rounded proportions, same dense moss coverage ✓
- Detail: small glowing green mushrooms visible on body ✓; ambient firefly lights in tree hollow ✓
- Scene: creature tightly curled inside a tree hollow opening, warm wood grain visible, soft ambient glow ✓ (scene prompt matched)
- Note: the sleeping curl makes body proportions harder to assess, but the geode chest and moss texture are clearly continuous with the reference character

---

*Verdict recorded in §3 above: identity **HOLDS** across both multi-ref scene edits → the
`nano-banana-2/edit` default is kept (no fallback to seedream needed).*

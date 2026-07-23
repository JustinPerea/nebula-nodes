# Ideogram in Nebula — direct API guide

> **Contract refresh 2026-07-23:** Re-verified all seven dual-route nodes
> against Ideogram's live OpenAPI and FAL's live `llms.txt` schemas. Added
> route-filtered immutable wrappers, seven FAL request fixtures, V4 acceleration
> and no-expansion controls, all current V4 resolution enums, direct copyright
> detection, and pre-submit guards for invalid route values. This refresh made
> no paid provider calls. The 2026-06-10 live-smoke evidence below remains the
> latest empirical provider run.

> Audited 2026-06-10 against developer.ideogram.ai (OpenAPI specs fetched per
> endpoint). **Live-smoked 2026-06-10 (direct route, `IDEOGRAM_API_KEY`):**
> `ideogram-v4`, `ideogram-edit`, `ideogram-transparent`, `ideogram-remove-background`,
> `ideogram-edit-prompt`, and `ideogram-describe` → `ideogram-magic-prompt` all
> returned outputs on `feat/inpainting` (`backend/scripts/smoke_ideogram_live.py`).
> Earlier FAL-route smokes also passed before the direct key was added. Mask Painter
> UI opens from the Inspector and loads upstream images via `/api/presets/thumbnails/…`.
> **Canvas E2E (2026-06-10):** `text-input` + `image-input` → `mask-painter` (Inspector
> brush, polarity *Black = edit*) → `ideogram-edit` → **Run** — all nodes `complete`
> in ~6s; inpaint visible in the brushed region (studio-product ref + “shiny gold coin”).
> **Agent playbook:** `.claude/skills/ideogram/SKILL.md` + `references/canvas-inpaint.md`
> — four wires (image must also hit `ideogram-edit.image`), filled mask over the target
> (not a hairline on empty white), `expand_prompt: true`, verify visible change in the
> painted bbox before claiming success.
> **Dual-route smokes (direct, 2026-06-10):** `ideogram-remix` (v4 remix),
> `ideogram-reframe`, `ideogram-replace-background`, `ideogram-upscale`, and
> `ideogram-character` all returned images. **Live gotchas:** character `style_type`
> must be `AUTO`/`REALISTIC`/`FICTION` only (GENERAL/DESIGN 400); the API allows
> **one** `character_reference_images` file per request (not multiple). Reframe
> `resolution` must be an Ideogram pixel enum (e.g. `1280x800`, not `1280x720`).
> **Bug fixed during smoke:** text-only multipart endpoints (v4 generate, transparent)
> were hitting `application/x-www-form-urlencoded` and 415'd — `_post_multipart` now
> encodes scalar fields as multipart text parts.
>
> Ideogram nodes are **dual-route**: with `IDEOGRAM_API_KEY` set they call
> `api.ideogram.ai` directly; without it they fall back to FAL (`FAL_KEY`) — see
> [fal.md](fal.md) for the FAL dialect.

Ideogram is the typography/design-first image model family (Ideogram 4.0,
released 2026-06-03 — frontier text rendering, open weights + hosted API). The
seven Nebula nodes cover generation plus the full editing surface: masked
inpaint, remix, outpaint (reframe), background replacement, consistent
characters, and upscaling.

## Why use the direct route

- **Remix rides Ideogram 4.0 directly** (`/v1/ideogram-v4/remix`) — FAL's remix
  is still the v3 model.
- No FAL margin; Ideogram API pricing applies (see ideogram.ai/pricing).
- First-party params: `magic_prompt` AUTO/ON/OFF, `rendering_speed`
  TURBO/DEFAULT/QUALITY, v4 2K `resolution` enum, v3 `aspect_ratio` enum.

## Routes per node

| Node | Direct endpoint | FAL endpoint (fallback) |
|---|---|---|
| `ideogram-v4` | POST `/v1/ideogram-v4/generate` | `ideogram/v4` |
| `ideogram-edit` | POST `/v1/ideogram-v3/inpaint` | `fal-ai/ideogram/v3/edit` |
| `ideogram-remix` | POST `/v1/ideogram-v4/remix` (**v4!**) | `fal-ai/ideogram/v3/remix` |
| `ideogram-reframe` | POST `/v1/ideogram-v3/reframe` | `fal-ai/ideogram/v3/reframe` |
| `ideogram-replace-background` | POST `/v1/ideogram-v3/replace-background` | `fal-ai/ideogram/v3/replace-background` |
| `ideogram-character` | POST `/v1/ideogram-v3/generate` + `character_reference_images` | `fal-ai/ideogram/character` |
| `ideogram-upscale` | POST `/upscale` (`image_request` JSON blob + `image_file`) | `fal-ai/ideogram/upscale` |

All direct endpoints are **synchronous multipart/form-data** POSTs with an
`Api-Key` header. Result URLs are **ephemeral** — the handler downloads them
into the run dir immediately.

## Param dialects (direct vs FAL)

| Concept | Direct | FAL |
|---|---|---|
| Speed | `rendering_speed`: TURBO / DEFAULT / QUALITY (FLASH "coming soon" — 400s today) | `rendering_speed`: TURBO / BALANCED / QUALITY |
| Prompt expansion | V4 text prompt is automatic; V3 uses `magic_prompt`: AUTO / ON / OFF | V4 uses `expansion_model`: None / Medium / Large; V3 uses `expand_prompt`: boolean |
| Sizing (v4 gen/remix) | current 23-value V4 pixel `resolution` enum | `image_size` preset names |
| Sizing (reframe) | `resolution` v3 pixel enum (**required**) | `image_size` preset (required) |
| Sizing (character) | `aspect_ratio` (1x1, 16x9, …) | `image_size` preset |
| Remix faithfulness | `image_weight` int 1-100 (omit = auto from the edit instruction) | `strength` float 0-1 |

The Inspector shows the right param set automatically (sharedParams + the
route the configured key selects).

## Gotchas

- **Mask polarity: BLACK = edit.** Identical on both routes ("Black regions in
  the mask should match up with the regions of the image that you would like to
  edit"). The Mask Painter utility node handles this via its "Painted Area
  Means" setting — paint the region to change, pick *Black = edit (Ideogram)*.
- **Mask dimensions must EXACTLY match the base image** or the API rejects the
  request. Mask Painter exports at the source image's natural size
  automatically.
- **Direct reframe requires `resolution`** — if it's unset and you only have
  the FAL-dialect `image_size`, the router automatically takes the FAL route
  rather than failing.
- **v4 generate/remix take no `seed`/`num_images`** on the direct route (v3
  endpoints keep both).
- **FAL V4 image-to-image now exists**, but the fixed `ideogram-remix` fallback
  intentionally remains V3 because the V4 endpoint does not preserve the
  node's style references, style enum, or negative-prompt contract.
- **Character node integration**: connect a Character node to
  `ideogram-character`'s Character port — its stored reference views become
  `character_reference_images`, the frozen trait string is prefixed VERBATIM
  to your prompt, and the stored seed applies unless you set one (same
  identity contract as cinema-scene; see `backend/cinema/identity.py`). Both
  routes accept exactly one character reference per request; Nebula rejects
  zero or multiple references before provider submission.

## Direct-only nodes (IDEOGRAM_API_KEY required, no FAL fallback)

The rest of the current API surface is wired as direct-only nodes (added
2026-06-10):

| Node | Endpoint | What it does |
|---|---|---|
| `ideogram-describe` | POST `/v1/ideogram-v4/describe` | Image → caption. Outputs a readable `description` AND the raw v4 `json_prompt` (the structured contract with `compositional_deconstruction` bounding boxes when `include_bbox` is on) |
| `ideogram-magic-prompt` | POST `/v1/ideogram-v4/magic-prompt` (JSON) | Text → expanded v4 `json_prompt` + readable expanded prompt. Chain into other generators |
| `ideogram-transparent` | POST `/v1/ideogram-v3/generate-transparent` | Prompt → PNG with a real alpha channel (stickers, logos, overlays). `upscale_factor` X1/X2/X4 |
| `ideogram-remove-background` | POST `/v1/remove-background` | Ideogram's own subject cutout (distinct from the FAL rembg `remove-background` node) |
| `ideogram-layerize` | POST `/v1/ideogram-v3/layerize-text` | Strips rendered text from an image and returns the clean base plate (the editable text layers live in Ideogram's own editor — the API returns the base) |
| `ideogram-edit-prompt` | POST `/v1/edit` | **Maskless** prompt-driven editing ("remove the lamp post") of one or more images; optional `transparent_background` |
| `ideogram-train-model` | POST `/datasets` → `/datasets/{id}/upload_assets` → `/v1/ideogram-v3/train-model` → poll `/models/{id}` | One node runs the full custom-model pipeline: feed training images, get back `custom_model_uri` + `model_id` when status hits COMPLETED (statuses: CREATING/DRAFT/TRAINING/COMPLETED/ERRORED/ARCHIVED; polls every 30s, up to 3h) |

**Custom-model loop:** wire `ideogram-train-model` → `custom_model_uri` into
`ideogram-character`'s *Custom Model URI* param (direct route) to generate with
your fine-tune — optionally combined with the Character node's reference
bundle.

Still unexposed: sending a raw `json_prompt` to v4 generate (the node sends
`text_prompt`; the magic-prompt/describe nodes OUTPUT json_prompt for a future
structured-input param), dataset management beyond the training node
(list/get datasets, list models), and per-character-ref masks.

## Sources

- https://developer.ideogram.ai/api-reference/api-reference/generate-v4 (+ remix-v4, inpaint-v3, reframe-v3, replace-background-v3, generate-v3, upscale) — OpenAPI specs, re-fetched 2026-07-23
- https://fal.ai/models/ideogram/v4/api (+ current V3 edit/remix/reframe/replace-background/character/upscale schemas) — re-fetched 2026-07-23
- https://ideogram.ai/news/ideogram-4.0 — 4.0 release announcement (2026-06-03)
- backend/handlers/ideogram.py — the direct-route implementation these docs describe

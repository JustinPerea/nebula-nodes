# Ideogram in Nebula — direct API guide

> Audited 2026-06-10 against developer.ideogram.ai (OpenAPI specs fetched per
> endpoint). Ideogram nodes are **dual-route**: with `IDEOGRAM_API_KEY` set they
> call `api.ideogram.ai` directly; without it they fall back to FAL
> (`FAL_KEY`) — see [fal.md](fal.md) for the FAL dialect.

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
| Prompt expansion | `magic_prompt`: AUTO / ON / OFF | `expand_prompt`: boolean |
| Sizing (v4 gen/remix) | `resolution` 2K pixel enum (2048x2048 … 2560x1600) | `image_size` preset names |
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
- **Character node integration**: connect a Character node to
  `ideogram-character`'s Character port — its stored reference views become
  `character_reference_images`, the frozen trait string is prefixed VERBATIM
  to your prompt, and the stored seed applies unless you set one (same
  identity contract as cinema-scene; see `backend/cinema/identity.py`).

## Direct-only capabilities not yet wired

Describe (image→caption), Remove Background, Layerize Text (text→editable
layers), Generate with Transparent Background, Magic Prompt generation, and
Custom Model Training (v3 fine-tunes) exist on the direct API but have no
Nebula nodes yet. The v4 structured `json_prompt` contract (bounding-box
layout control) is also unexposed — the node sends `text_prompt`.

## Sources

- https://developer.ideogram.ai/api-reference/api-reference/generate-v4 (+ remix-v4, inpaint-v3, reframe-v3, replace-background-v3, generate-v3, upscale) — OpenAPI specs, fetched 2026-06-10
- https://ideogram.ai/news/ideogram-4.0 — 4.0 release announcement (2026-06-03)
- backend/handlers/ideogram.py — the direct-route implementation these docs describe

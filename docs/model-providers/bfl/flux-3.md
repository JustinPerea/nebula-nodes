---
id: nebula-bfl-flux-3
kind: project-model-integration
project: nebula_nodes
provider: bfl
model: flux-3 (flux-3-image, flux-3-image-klein, flux-3-image-klein-base, flux-3-video, flux-video-edit, flux-video-upscale)
status: active
verified: 2026-10-15
stale_after_days: 14
---

# FLUX 3 on every host — Audit Note

Six route-table nodes (one node per model, provider switcher in the node;
`docs/PROVIDER-ROUTES.md`). This note records, per host, what each route
sends, what it leaves out and why, and where each fact came from. Agent
playbook: `.agents/skills/bfl/SKILL.md`. The node definitions in
`frontend/src/constants/nodeDefinitions.ts` (exported to
`backend/data/node_definitions.json`) and the prices in
`backend/data/model_pricing.json` are the truth where this note and the code
differ.

FLUX 3 is preview / early access on BFL (`version` takes only `latest`).
Re-check hosts and prices before trusting this after about two weeks.

## Sources (all fetched 2026-10-15; no paid calls)

- BFL: https://api.bfl.ai/openapi.json; https://docs.bfl.ai/flux_3/flux3_image_generate, flux3_image_klein, flux3_video, flux_tools/flux_video_edit, api_integration/errors, guides/prompting_unified_technical; https://bfl.ai/pricing and https://docs.bfl.ai/quick_start/pricing
- fal: queue OpenAPI per endpoint, `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` for `blackforestlabs/flux-3/text-to-image`, `/edit-image`, `/klein/base/text-to-image`, `/klein/base/edit-image`, the video endpoints, `/edit-video` and `blackforestlabs/flux-video-upscale`; model pages and `llms.txt` under https://fal.ai/models/blackforestlabs/; https://api.fal.ai/v1/models/pricing (now needs a key: 401)
- Replicate: https://replicate.com/black-forest-labs/flux-3-image, /flux-3 and /flux-video-upscale, each with `/api/schema`; 404s for /flux-3-image-klein, /flux-3-klein, /flux-3-image-klein-base and /flux-video-edit
- OpenRouter: https://openrouter.ai/openapi.json; https://openrouter.ai/api/v1/images/models/black-forest-labs/flux-3-image/endpoints and `.../flux-3-image-klein/endpoints`; https://openrouter.ai/api/v1/videos/models
- Krea: https://api.krea.ai/openapi.json (catalog entries for Flux 3 Video, Flux Video Edit, Flux Video Upscale)
- Raw dumps and the generated specs: session scratchpad `flux3/` (`bfl/`, `hosts/`, `pr3-spec/`)

## Route matrix

Auto order is left to right. A dash means no route, for the reason in "Left out".

| Node | BFL (maker) | fal | Replicate | OpenRouter | Krea |
|---|---|---|---|---|---|
| `flux-3-image` | `/v1/flux-3-image` | `blackforestlabs/flux-3/text-to-image`, `/edit-image` | `black-forest-labs/flux-3-image` | `black-forest-labs/flux-3-image` | - |
| `flux-3-image-klein` | `/v1/flux-3-image-klein` | - | - | `black-forest-labs/flux-3-image-klein` | - |
| `flux-3-image-klein-base` | - | `blackforestlabs/flux-3/klein/base/text-to-image`, `/edit-image` | - | - | - |
| `flux-3-video` | `/v1/flux-3-video` | 5 endpoints + `/draft` each | `black-forest-labs/flux-3` | `black-forest-labs/flux-3-video` | catalog Flux 3 Video |
| `flux-video-edit` | `/v1/flux-tools/video-edit-v1` | `blackforestlabs/flux-3/edit-video` | - | - | catalog Flux Video Edit |
| `flux-video-upscale` | `/v1/flux-tools/video-upscale-v1` | `blackforestlabs/flux-video-upscale` | `black-forest-labs/flux-video-upscale` | - | catalog Flux Video Upscale |

## FLUX 3 Image

- **Shared:** `aspect_ratio` (`auto` + 15, default `auto`), `resolution` 768sq/1k/1.5k/2k/4k (default 1k), `safety_tolerance` 0-4 (default 2). `images` up to 10 on every route (`rules.ports.images.max`).
- **safety_tolerance 0-4:** BFL's errors page says "0-4 | FLUX 3 Video ... and FLUX 3 Image"; fal and Replicate say 0-4. The OpenAPI allows 0-7 only where the organization is approved.
- **BFL:** route param `grounding` (default true). No seed, output format or webhook on this body.
- **fal:** no `1.5k` or `9:21` (the `valueMap` leaves them out). fal's extra `512sq` tier isn't offered (not a BFL value). Route param `enable_prompt_expansion` (default false).
- **Replicate:** route param `grounding` (same definition as BFL's).
- **OpenRouter:** `resolution` mapped to `768` / `1K` / `1.5K` / `2K` / `4K`; `safety_tolerance` goes under `provider.options["black-forest-labs"]`.
- **Prices per image (768sq / 1k / 1.5k / 2k / 4k):** BFL and OpenRouter $0.041 / 0.048 / 0.07 / 0.10 / 0.607; Replicate $0.0205 / 0.024 / 0.035 / 0.05 / 0.3035; fal $0.041 / 0.048 / - / 0.10 / 0.607, **unconfirmed** (the page still says the 50% promo "ends October 8, after which a 1K image will cost $0.048" while its billing record says $0.024/MP; the higher number is used; the page names no 2k or 4k price, so those are BFL's).

## FLUX 3 Image Klein

- **Shared:** `aspect_ratio`, `resolution` (the same tiers; BFL's OpenAPI gives Klein the same `aspect_ratio` and `resolution` fields, with `width`/`height` as optional overrides), `safety_tolerance` 0-4, `seed` 0-4294967295 (unset by default).
- **BFL:** route params `steps` 1-16 (default 16) and `output_format` jpeg/png (default jpeg).
- **OpenRouter:** OpenRouter's `/images` record for Klein lists no seed, so `rejectsWhen {seed: (set)}` stops the run: "FLUX 3 Image Klein can't run on OpenRouter: it doesn't take a seed. Change that setting, or switch provider." (Its chat record lists `seed`; the `/images` record is treated as the authority.)
- **Prices per image:** both routes $0.008 / 0.009 / 0.011 / 0.014 / 0.036.

## FLUX 3 Image Klein Base

- fal only; no maker route. BFL's OpenAPI has only `/v1/flux-3-image-klein`, and BFL lists Klein Base on Hugging Face only.
- **Shared (fal's names):** `image_size` (`square_hd` default, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`), `seed`, `output_format` png/jpeg/webp (default png), `enable_prompt_expansion` (default true), `enable_safety_checker` (default true).
- **Prices:** $0.024 to $0.0283 per preset, **unconfirmed** (the higher of fal's "Planned" tier price and its $0.027/MP billing record; the preset pixel sizes come from the repo's fal fast-sdxl skill, since the Klein Base schema names the presets without sizes).

## FLUX 3 Video

- **Ports:** `prompt`, `start_image`, `end_image`, `start_video`, `keyframes` (multiple, up to 10). These are Krea's port ids, which keeps the merge of Krea's node small.
- **Shared:** `duration` 5-20 (default 5), `resolution` hd/fhd/qhd/uhd (default hd), `aspect_ratio` (`auto`, 21:9, 2:1, 16:9, 4:3, 1:1, 3:4, 9:16, 9:21; default 16:9 so every route takes the default), `generate_audio` (default true).
- **`draft` is a route param** on bfl, fal and replicate (identical definitions), not shared. Krea's gateway rejects any field outside its schema ("Unknown Krea request fields: draft", even for false), and OpenRouter would push it into `provider.options`, which allows only `safety_tolerance` and `version`. On krea and openrouter `rejects {draft: [true]}` blocks it, so it is never dropped silently.
- **Rules on every route:** an end image alone is refused. Video plus images together is refused on bfl, fal and replicate. Drafts at hd only (BFL: "sending `draft: true` with any other resolution is rejected").
- **BFL:** continuation (`start_video`) is 5-15 s in its schema, so 16-20 s with a source video is blocked on bfl only.
- **fal:** `endpointWhen` picks one of nine endpoints by port and draft (`extend-video`, `keyframes-to-video`, `first-last-frame-to-video`, `image-to-video`, `text-to-video`, each also `/draft`). `resolution` → 720p/1080p/1440p/2160p. No 9:21.
- **Replicate:** hd/fhd only; `duration` sent as the strings "5" to "20"; no 9:21. Whether Replicate rejects a draft at 1080p or quietly makes 720p isn't stated ("Drafts are 720p"), so it's blocked either way.
- **OpenRouter:** hd/fhd/qhd/uhd (720p / 1080p / 2K / 4K, from its video models API); six ratios (no `auto`, 2:1 or 9:21); `ports.keyframes.max 0` and `ports.start_video.max 0`; frames go only as public http(s) URLs.
- **Krea:** 720p/1080p; no `auto` or 9:21; `ports.keyframes.max 0`; `plan: optional`.
- **Prices per second:** BFL t2v/i2v 0.15 / 0.24 / 0.28 / 0.41, v2v 0.21 / 0.27 / 0.31 / 0.45, draft 0.06 (a v2v draft is "Not listed": unpriced). fal 0.17 / 0.29, extend 0.41 / 0.53, drafts 0.06 / extend draft 0.12, **unconfirmed** (the pricing API says 0.085 / 0.205 / 0.03 / 0.06; the higher page prices are used); fal qhd/uhd unpriced. Replicate and Krea 0.17 / 0.29, v2v 0.41 / 0.53. OpenRouter 0.17 / 0.29 / 0.28 / 0.41 (2K below 1080p, copied as published).

## FLUX Video Edit [fast]

- **Ports:** `prompt`, `start_video` (Krea's ids; the clients map them to BFL's `video` and fal's `video_url`). No settings.
- **fal `blackforestlabs/flux-3/edit-video`** is the same model: fal titles it "Flux 3 FAST Edit Video" (its description says "FLUX.3 Edit Video [FAST]"), and it matches BFL on price ($0.03/s), limits (15 s, 50 MB), 720p output and fields.
- **Prices:** BFL and fal $0.03 per output second; Krea unpriced (no `x-krea-pricing` on the operation).

## FLUX Video Upscale

- **Ports:** `video` (required), `prompt` (optional). **Shared:** `creativity` 0/1 (Precise/Creative, default 1), `upscale_factor` 1.5-3 (default 2). The Krea route maps `creativity` 0/1 to `precise`/`creative`.
- **Prices:** BFL and Replicate $0.07 / $0.10 per output megapixel-second (output = source × factor², capped at 13.75 MP and 20 s; Replicate's megapixel isn't defined, so its entry is unconfirmed). fal $0.084 / 0.15 / 0.33 per second (precise) and $0.12 / 0.21 / 0.474 (creative) by output tier 1080p / 2K / 4K, **unconfirmed** (fal doesn't say where the tiers split). Krea unpriced.

## Left out (and why)

- **Klein on fal** (`blackforestlabs/flux-3/klein/{text-to-image,edit-image}`): fal's Klein takes only `image_size`, a preset or an exact `{width, height}` (256-4096, multiples of 16). BFL publishes no exact sizes for its tiers ("1k: About 1 megapixel"), so nothing sent would match the shared tiers without guessing. fal's Klein also runs differently (12 steps against BFL's 16, prompt expansion on by default).
- **Klein, Klein Base and Video Edit on Replicate:** 404 (re-checked 2026-10-15).
- **Klein Base on OpenRouter:** not listed. **Krea on the image nodes:** Krea's catalog has no FLUX 3 image model.
- **Video Edit and Upscale on OpenRouter:** openrouter.ai/openapi.json documents `creativity` and `upscale_factor`, but no way to send a source clip (`input_references` video URLs are "only honored by providers that support them" and name only BytePlus Seedance; `previous_job_id` takes an OpenRouter job). Listed prices kept for a follow-up: edit 3 cents/s, upscale 3.5 / 5 cents per MP·s.
- **`output_format` / `output_quality` on FLUX 3 Image:** BFL has neither, and fal (jpeg/png) and Replicate (webp/jpg/png) differ.
- **BFL Klein `width`/`height`** (OpenRouter can't take a size); **Klein Base custom sizes** (needs a structural step in the fal client); **`bounding_boxes`, `num_images`, `sync_mode`, `version`**.
- **`draft_enhance`** (deferred), **`duration: auto`** (Krea and OpenRouter don't take it, and the old Krea node saved integers), **`safety_tolerance` on the video nodes** (ranges differ, every provider defaults to 2).

## Still to check

- fal's post-promo FLUX 3 image and video prices, and whether fal also bills the megapixels of edit inputs (one billed run would settle it).
- `safety_tolerance` max 4 on Klein specifically.
- OpenRouter seed support on Klein (`/images` record vs chat record).
- The default `1k` on Klein (and `square_hd` on Klein Base) resizes edits; a "keep size" option would need a `valueMap` value that omits the field.

## Live runs on BFL (2026-10-15)

These were real, billed runs on Black Forest Labs' API through Nebula's FLUX 3 nodes (`_provider: bfl`). BFL billed 44.86 credits ($0.449) in all, which matches the BFL price rows above:

| Node | Settings | Output | Billed |
|---|---|---|---|
| FLUX 3 Image Klein | 768sq | 768×768 JPEG | $0.008 |
| FLUX 3 Image | 768sq, aspect auto | 1024×576 PNG | $0.041 |
| FLUX 3 Video | text-to-video draft, hd, 5 s | 1280×704, 5.04 s, with audio | $0.30 |
| FLUX Video Edit [fast] | 2 s 480×270 clip | 480×256, 2.04 s | $0.06 (inferred) |
| FLUX Video Upscale | same clip, precise, 1.5× | 720×404, 2.04 s | $0.0396 (inferred) |

"Inferred": Edit and Upscale were billed late and together, as 9.96 credits. That total fits 2 s × $0.03 for the edit plus 0.2774 MP × 2.04 s × $0.07 for the upscale. So BFL counts a megapixel as 1,048,576 pixels, and the upscale is billed on the output frame size and duration. The fal, Replicate, OpenRouter and Krea routes haven't been run live yet.

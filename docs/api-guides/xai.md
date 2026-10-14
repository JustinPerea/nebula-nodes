# xAI (Grok Imagine) in Nebula Nodes

> xAI's Grok Imagine API makes images and short video clips. Nebula runs its video node on xAI directly, and runs the fal and Krea copies of Grok Imagine on xAI too when your xAI key is saved.

## What you can make

**Video**
- **Text-to-video** and **image-to-video**: `grok-imagine-video` (on xAI directly), plus the Krea copies `krea-video-xai-grok-video` and `krea-video-xai-grok-video-1-5`.
- **Reference-to-video and video editing**: through `krea-video-xai-grok-video` (`reference_images`, `edit_video`), on Krea or on your xAI key. A `start_video` keeps the run on Krea.

**Images**
- **Text-to-image**: `grok-imagine-image` (fal copy of Grok Imagine 1.0) and `krea-image-xai-grok-imagine-2` (Grok Imagine 2.0, with quality).
- **Image editing** (up to 5 source images on xAI): `grok-imagine-image-edit` and `krea-image-xai-grok-imagine-2-edit`.

**Not exposed yet:** voice/audio (TTS, STT, Realtime Voice) and Grok text/chat models.

## Nodes available in Nebula (7)

| Node (as shown in app) | Node ID | Runs on | xAI model on your key | Notes |
|---|---|---|---|---|
| Grok Imagine Video | `grok-imagine-video` | xAI only | `grok-imagine-video` | `prompt` (required), optional `image`; `duration` 1-15 (default 5), 7 aspect ratios, 480p/720p |
| Grok Imagine Image | `grok-imagine-image` | xAI key, else fal | `grok-imagine-image` | `num_images` -> `n`; `output_format` is fal-only |
| Grok Imagine Image Edit | `grok-imagine-image-edit` | xAI key, else fal | `grok-imagine-image` | `images` port: up to 5 sources on xAI (fal takes 3) |
| Grok Imagine 2.0 (Krea) | `krea-image-xai-grok-imagine-2` | Krea plan, else xAI key, else Krea token | `grok-imagine-image-2.0` | `quality` low/medium; `style_images` keep the run on Krea |
| Grok Imagine 2.0 Edit (Krea) | `krea-image-xai-grok-imagine-2-edit` | same | `grok-imagine-image-2.0` | 1-3 `image_urls` |
| Grok Imagine (Krea) | `krea-video-xai-grok-video` | same | `grok-imagine-video` | start image, up to 7 references, edit video; `start_video` keeps the run on Krea |
| Grok Imagine 1.5 (Krea) | `krea-video-xai-grok-video-1-5` | same | `grok-imagine-video-1.5` | 480p/720p/1080p; `start_video` keeps the run on Krea |

Handlers: `backend/handlers/grok_video.py` (video, `run_xai_video`), `backend/handlers/xai_image.py` (images). Translators for the fal and Krea copies: `backend/execution/maker_routes_xai.py`.

## Direct routes: the fal and Krea copies on your xAI key

Added 2026-10-14. Six copies of Grok Imagine also run on xAI's own API when `XAI_API_KEY` is saved. Which route runs (`backend/services/node_route.py`, the same rule for the router, the run estimate, the spend gate, readiness and the cache key):

1. A Krea node set to your Krea plan (`_kreaAuth: "mcp"`) stays on the plan.
2. Else, with an xAI key saved, xAI runs it and bills it.
3. Else the fal key or Krea API token runs it.

What changes on the xAI route:

- **fal copies** send `num_images` as `n`, and `aspect_ratio` and `resolution` as they are. `output_format` is fal-only (xAI has no output-format field and returns JPEG unless the quality produces PNG), so the Inspector hides it on the xAI route.
- **Krea Grok 2.0** sends `quality` and `resolution` as `1k`/`2k`. An unset resolution renders at xAI's default, 1k. Krea's `style_images` (style references with a strength) have no xAI equivalent: a recipe that sets them, or wires them into the port, stays on Krea.
- **Krea Grok video** picks the endpoint from its inputs: `edit_video` -> `/v1/videos/edits` (prompt required; xAI keeps the source's length, shape and resolution, capped at 720p), otherwise `/v1/videos/generations` with `start_image` -> `image` and `reference_images` (up to 7, at most 10 s). Unset `duration` and `resolution` send the Krea node's defaults (6 s, 720p), not xAI's (8 s, 480p). xAI takes whole seconds only. A duration that isn't a whole 1-15 seconds, and combinations xAI doesn't document on one request (an edit with a start image or references, a start image with references), saved or wired, stay on Krea (`directRoute.accepts` / `rejectsWhen`); with only the xAI key saved, the run says the Krea token is needed and why.
- **`start_video` stays on Krea** on both video copies, saved or wired. Krea's OpenAPI gives the field no description (it appears on Grok, Veo 2, Seedance and Flux alike), so whether it means "extend this clip" is NOT CONFIRMED. xAI's extensions endpoint also works on `grok-imagine-video` only ("Model | `grok-imagine-video`" in the extension guide). Mapping it would risk a different result than the Krea copy, so it isn't mapped.
- On the xAI route a Krea node fills `image`/`video`, `images`/`videos` and `artifacts`, with no Krea `job`.

**Prices on the xAI route** (`backend/data/model_pricing.json`, from the Imagine table on https://docs.x.ai/developers/pricing as the page renders it, checked 2026-10-14; the `.md` copy lists only each model's lowest rate):

| Model | Output | Media input |
|---|---|---|
| `grok-imagine-image` | $0.02 / image (1K and 2K) | $0.002 / image |
| `grok-imagine-image-2.0` | 1K low $0.04, 1.5K low $0.05, 2K low $0.06, 1K medium $0.06, 1.5K medium $0.07, 2K medium $0.08 | $0.01 / image |
| `grok-imagine-video` | 480p $0.05/s, 720p $0.07/s | $0.002 / image, $0.01 / s of video |
| `grok-imagine-video-1.5` | 480p $0.08/s, 720p $0.14/s, 1080p $0.25/s | $0.01 / image |

Edits bill the source images too ("Image edits are billed for both the input image and the generated output image"), so edit prices are ranges up to the node's source limit. Video prices are ranges up to the most input images the route can send. Video edits bill the source clip by its length and return a clip whose length depends on it, so they are left unpriced.

## How to use it in Nebula

**Where the node lives.** Open the node palette/library and look under the **video generation** category. Drag **Grok Imagine Video** onto the canvas. It has one required text input (`prompt`), one optional image input (`image`), and one video output (`video`).

**API-key setup (one time).**
1. Get an xAI API key from the xAI console (the same key works for video, image, voice, and chat).
2. Open Nebula **Settings** → **Providers**, choose **Add key** on the **xAI (Grok)** row (`XAI_API_KEY`), paste it and choose **Save key**. Saving checks the key without generating anything.
3. Nebula stores it under `apiKeys.XAI_API_KEY` in the project-root `settings.json`; no restart is required. If the key is missing, the node fails with `XAI_API_KEY is required`.

**Note on timing.** Video generation is asynchronous — Nebula submits the job and polls until it's `done` (this typically takes up to a few minutes). A progress bar advances on the node while it waits.

**Example recipes (all use real node IDs):**

1. **Text-to-video from scratch.**
   - Add a **Text** input node → type a prompt like *"a neon koi fish drifting through a rainy Tokyo alley at night, cinematic, slow dolly-in."*
   - Wire it into the `prompt` port of **`grok-imagine-video`**.
   - Set `duration` to 8, `aspect_ratio` to `16:9`, `resolution` to `720p`.
   - Run → the `video` output is an `.mp4` you can preview, download, or feed downstream.

2. **Animate a generated image (image-to-video).**
   - Generate a still with any image node in Nebula (e.g. a `gpt-image-2-*` or `gemini` image node, or a FAL image model).
   - Wire that node's image output into the **`image`** port of **`grok-imagine-video`**, and a short motion prompt into `prompt` (e.g. *"gentle wind, the cape flutters, embers rise"*).
   - Choose `aspect_ratio` `9:16` for a vertical/social clip. Run.

3. **Quick social-vertical clip.**
   - **Text** node → prompt → **`grok-imagine-video`** with `aspect_ratio` `9:16`, `duration` 5, `resolution` `480p` (cheapest/fastest).
   - Use the resulting vertical `video` for a reel/short.

## API coverage: what Nebula uses vs. what xAI (Grok Imagine) offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text-to-video (`POST /v1/videos/generations`, poll `GET /v1/videos/{request_id}`) | Yes | full | `grok-imagine-video`, and the Krea copies on an xAI key. |
| Image-to-video (`image` {url}) | Yes | full | The `image` / `start_image` ports (URL or data URL). |
| Reference-to-video (`reference_images`) | Yes | partial | `krea-video-xai-grok-video` (up to 7 on grok-imagine-video). 1.5's 14 references, voices, last frame and keyframes have no port. |
| Video editing (`POST /v1/videos/edits`) | Yes | full | `krea-video-xai-grok-video` `edit_video`. |
| Video extension (`POST /v1/videos/extensions`) | Yes | none | No node. The Krea copies' `start_video` stays on Krea (its meaning there is unconfirmed). |
| Image generation (`POST /v1/images/generations`) | Yes | full | `grok-imagine-image` (1.0), `krea-image-xai-grok-imagine-2` (2.0, quality). |
| Image editing, multi-image (`POST /v1/images/edits`, up to 5 sources) | Yes | full | `grok-imagine-image-edit`, `krea-image-xai-grok-imagine-2-edit` (1-3). |
| `grok-imagine-video-1.5-lite` | Yes | none | No node. |
| Text-to-Speech, Speech-to-Text, Realtime Voice | Yes | none | No node. |
| Chat / text completions (`POST /v1/chat/completions`, `POST /v1/responses`) | Yes | none | No node. |

## Agent skill coverage

**A complete skill exists** at `.agents/skills/xai/SKILL.md` (mirrored in `.claude/skills/xai/`; new 2026-06-04, direct routes added 2026-10-14). It covers the xAI video node and the six Grok copies that run on an xAI key, giving an agent the node identity, param contract, auth, async execution model, t2v/i2v recipes, and the known gaps.

What it covers:
- **Node identity** — the node ID `grok-imagine-video`, its category (`video-gen`), input ports (`prompt` required, `image` optional), and output port (`video`).
- **Param contract** — `duration` (1–15, default 5), `aspect_ratio` (the 7 enum values, default `16:9`), `resolution` (`480p`/`720p`, default `480p`), with the cost/speed tradeoffs.
- **Auth** — the `XAI_API_KEY` env var and the missing-key failure mode.
- **Execution model** — async submit-then-poll (`request_id` → `GET /v1/videos/{request_id}`, terminal `done`, plus `failed`/`expired`), with a ~15-min cap and realistic timeout expectations.
- **Recipes & prompting** — building text-to-video and image-to-video graphs, what makes a good motion prompt (scene + camera move + lighting), and that the model ID is fixed.
- **Known gaps** — the voice stack, chat, 1.5-lite and 1.5's reference/voice/keyframe controls are *not* nodes, so an agent doesn't over-promise.

## Sources

- xAI API overview — https://docs.x.ai/docs/overview
- xAI API reference (chat / responses) — https://docs.x.ai/docs/api-reference
- Imagine overview (image + video + modes) — https://docs.x.ai/developers/model-capabilities/imagine
- Video generation (endpoints, params, modes, statuses) — https://docs.x.ai/developers/model-capabilities/video/generation
- Images REST reference — https://docs.x.ai/developers/rest-api-reference/inference/images
- Videos REST reference — https://docs.x.ai/developers/rest-api-reference/inference/videos
- Pricing (Imagine table) — https://docs.x.ai/developers/pricing
- Model catalog (model IDs, modalities, pricing) — https://docs.x.ai/docs/models

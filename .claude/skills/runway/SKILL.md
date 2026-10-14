---
name: runway
description: Runway API in Nebula — image-to-video & text-to-video (Gen-4.5, Seedance 2.0 (+ Fast, Mini), Seedance 2.5, HappyHorse 1.0, Gen-4 Turbo, Veo 3.1, Veo 3.1 Fast), Aleph 2.0 video restyle, Gen-4 Image / Nano Banana Pro / GPT Image 2 / Gemini 2.5 Flash / Seedream 5.0 Pro / Lite stills, Magnific-backed image upscaling, Act-Two character performance, and ElevenLabs-backed TTS / speech-to-speech / voice dubbing. Activate when the user configures any of the Nebula nodes runway-video, runway-aleph, runway-image, runway-upscale, runway-act-two, runway-tts, runway-sts, or runway-dubbing, or asks about Runway in Nebula. Sourced from the official Runway Python SDK (github.com/runwayml/sdk-python) cross-checked against backend/handlers/runway.py and backend/data/node_definitions.json, plus the Nebula audit guide (docs/api-guides/runway.md), on 2026-06-04 (updated 2026-10-14 against docs.dev.runwayml.com openapi.json, models, pricing and changelog).
---

# Runway Skill

## When to use

- User configures any of the eight Runway nodes: `runway-video`, `runway-aleph`, `runway-image`, `runway-upscale`, `runway-act-two`, `runway-tts`, `runway-sts`, `runway-dubbing`.
- User asks to animate a still into a clip, generate video from text, restyle/edit existing footage, make a portrait act out a performance video, generate a still image, upscale a still, or produce/restyle/dub voiceover — using Runway inside Nebula.
- User asks which Runway model to pick (Gen-4.5 vs Seedance 2.0 / 2.5 vs Veo 3.1 vs HappyHorse, Gen-4 Image vs Nano Banana Pro vs GPT Image 2 vs Gemini 2.5 Flash vs Seedream 5.0), or about ratios, durations, voice presets, or dubbing languages **as exposed in Nebula's node dropdowns**.
- User asks what Runway can do that Nebula does **not** expose (sound effects, voice isolation, custom voice cloning, Seedance 2 video-to-video, avatars). See **Capability boundaries**.

## Universal rules

1. **Auth & Settings.** Single key for all eight nodes: `RUNWAY_API_KEY`. Enter it in Nebula **Settings → Runway** and save; it is persisted under `apiKeys.RUNWAY_API_KEY` in project-root `settings.json` and takes effect without a restart. Sent as header `Authorization: Bearer <RUNWAY_API_KEY>`. Get the key from the Runway developer dashboard at dev.runwayml.com.
2. **Base URL.** `https://api.dev.runwayml.com/v1` (note: `api.dev.runwayml.com` is the production API gateway — not a staging host). Constant `RUNWAY_API_BASE` in the handler.
3. **Required headers** (set by the handler — do not re-add): `Authorization: Bearer …`, `Content-Type: application/json`, `X-Runway-Version: 2024-11-06`.
4. **Execution pattern = async-poll** for all eight nodes. The handler POSTs the submit body, gets back `{"id": "<task_id>"}`, then polls `GET /v1/tasks/{id}` every **2 s**, up to **300 polls** (~10 min cap), until `status` is `SUCCEEDED` (success) or `FAILED` (failure). There is no sync or streaming path. Expect a video/character node to take a minute or more before its output port lights up.
5. **Response shape.** A finished task returns `output: ["<url>", …]` (an array of URLs, or occasionally a single URL string). The handler takes `output[0]`, downloads it, and writes a local file — MP4 for video nodes, PNG for `runway-image` and `runway-upscale`, MP3 for the audio nodes. No `outputCount` is exposed, so treat every node as single-output.
6. **Status / error codes.** Task `status` flows `PENDING`/`THROTTLED`/`RUNNING` → `SUCCEEDED` / `FAILED`. HTTP: `401` = missing/invalid `RUNWAY_API_KEY`; `403` = account/plan lacks access to that model (Runway API is gated per plan); `400` = bad params, most often a model-specific ratio/duration the node let you pick but the chosen model rejects, or an Act-Two reference video outside 3–30 s; `429` = rate limited (the poll loop will keep retrying within the 300-poll cap).
7. **Input-URI rules.** Inputs that are already `https://`, `data:` or `runway://` URIs are passed through untouched. **Local files** become base64 data URIs while the encoded URI fits Runway's **5MB** cap (`_resolve_image` for images, `_local_media_uri` for video/audio); bigger files (up to **200MB**) go through Runway's ephemeral upload (`POST /v1/uploads` -> presigned form -> `runway://` URI, valid 24 h). You never pre-upload by hand. All non-local URIs must be HTTPS.
8. **camelCase on the wire.** The handler emits camelCase keys (`promptText`, `promptImage`, `videoUri`, `audioUri`, `referenceImages`, `bodyControl`, `expressionIntensity`, `targetLang`, `disableVoiceCloning`, `dropBackgroundAudio`, `numSpeakers`, `removeBackgroundNoise`) and nested objects for references/voices. You configure nodes via the param **keys** below (which already match the wire names) — never hand-translate to snake_case.
9. **Prompt length.** The handler truncates `promptText` to the model's maximum: 1000 for Gen-4.5 / Gen-4 Turbo / Veo / Gen-4 Image / Aleph / voice nodes, 2500 HappyHorse, 3500 Seedance 2.0 family, 15000 Seedance 2.5, 4000 Seedream, 5500 Gemini, 32000 GPT Image 2. Longer prompts are silently clipped.
10. **Key gotchas.**
    - `runway-video` switches endpoint by input: **image connected → `image_to_video`**, **no image (prompt only) → `text_to_video`**. Every model but `gen4_turbo` has text-to-video. Ratios and durations are **per model** (see `video.md`); the inspector shows only the chosen model's options, and the handler raises a `ValueError` before submit for anything else (e.g. Veo 3.1 at 5 s, Gen-4.5 text-only at 4:3, Gen-4.5 image-to-video without a prompt).
    - `runway-aleph` runs `aleph2` (Aleph 2.0), the only Aleph model since Runway retired `gen4_aleph` on 2026-07-30. Output resolution is inherited from the input video; there is no ratio control.
    - Voice nodes nest the preset: the handler sends `voice: {"type": "runway-preset", "presetId": <voiceId>}`. Preset IDs are **case-sensitive** — `"Maya"` works, `"maya"` 400s.
    - The Aleph reference image goes as `keyframes: [{"uri": …, "at": 0}]` (Aleph 2.0 has no `references` field); Image references as `referenceImages: [{"uri": …}]`, up to the model's maximum (3 Gen-4 / Gemini 2.5 Flash, 10 Seedream Pro, 14 Nano Banana Pro / Seedream Lite, 16 GPT Image 2; more is an error).

## Pick the right node

| Nebula node (id) | Display name | Endpoint → model(s) | Key params (node keys) |
|---|---|---|---|
| `runway-video` | Runway Video | `POST /v1/image_to_video` when an **image** is wired, else `POST /v1/text_to_video` | `model` (gen4.5 / seedance2 / seedance2_fast / happyhorse_1_0 / gen4_turbo / veo3.1 / veo3.1_fast / seedance2_mini / seedance2_5), `duration` (per model, def 5), `ratio` (per model, def 1280:720), `seed`, `resolution` (HappyHorse + image), `audio` (Veo, Seedance; def true). Ports: `prompt` (opt), `image` (opt) → `video`. |
| `runway-aleph` | Runway Aleph | `POST /v1/video_to_video` | `model` (aleph2, def aleph2), `seed`. Ports: `video` (req), `prompt` (req), `reference` image (opt, sent as a keyframe) → `video`. |
| `runway-image` | Runway Image | `POST /v1/text_to_image` | `model` (gen4_image / gen4_image_turbo / gemini_image3_pro / gpt_image_2 / gemini_2.5_flash / seedream5_pro / seedream5_lite), `ratio` (per model, def 1360:768), `seed` (Gen-4 only), `grounding` (Seedream). Ports: `prompt` (req), `images` reference (opt, multiple, up to the model's max) → `image`. |
| `runway-upscale` | Runway Upscale | `POST /v1/image_upscale` → **magnific_precision_upscaler_v2** (fixed) | `scaleFactor` (2/4/8/16, def 2), `flavor` (photo def / photo_denoiser / sublime), `sharpen` (0–100), `smartGrain` (0–100), `ultraDetail` (0–100). Ports: `image` (req) → `image`. |
| `runway-act-two` | Runway Act-Two | `POST /v1/character_performance` → **act_two** (fixed) | `bodyControl` (bool, def false), `expressionIntensity` (1–5, def 3), `ratio` (6 opts, def 1280:720), `seed`. Ports: `character_image` OR `character_video` (one required), `reference` performance video (req) → `video`. |
| `runway-tts` | Runway TTS | `POST /v1/text_to_speech` → **eleven_multilingual_v2** (fixed) | `voiceId` (30 presets, def Maya). Ports: `text` (req) → `audio`. |
| `runway-sts` | Runway Speech-to-Speech | `POST /v1/speech_to_speech` → **eleven_multilingual_sts_v2** (fixed) | `voiceId` (19 presets, def Maya), `removeBackgroundNoise` (bool, def false). Ports: `audio` OR `video` (one required) → `audio`. |
| `runway-dubbing` | Runway Voice Dubbing | `POST /v1/voice_dubbing` → **eleven_voice_dubbing** (fixed) | `targetLang` (28 langs, def es), `disableVoiceCloning` (bool, def false), `dropBackgroundAudio` (bool, def false), `numSpeakers` (1–10, auto-detect if unset). Ports: `audio` (req) → `audio`. |

## Param reference

Values below are the **exact** node enums/ranges from `node_definitions.json` (what the inspector lets you pick). The API itself accepts more in some cases — those extras are flagged under **Capability boundaries**, not here, so an agent never sets a value the node can't send.

### `runway-video` (refreshed 2026-10-14)
- `model` (enum, **required**, default `gen4.5`): `gen4.5` · `seedance2` (Seedance 2.0) · `seedance2_fast` · `happyhorse_1_0` (HappyHorse 1.0) · `gen4_turbo` · `veo3.1` · `veo3.1_fast` · `seedance2_mini` (Seedance 2.0 Mini) · `seedance2_5` (Seedance 2.5). `gen3a_turbo` and `veo3` were removed (retired on Runway); saved nodes migrate to `gen4_turbo` / `veo3.1`.
- `duration` (enum, default `5`): gen4.5 / gen4_turbo 2–10 · veo3.1 / veo3.1_fast 4, 6, 8 · happyhorse_1_0 3–15 · seedance2 / _fast / _mini 4–15 or `auto` · seedance2_5 4–30 or `auto`. Only the chosen model's values show.
- `ratio` (enum, default `1280:720`): per model and endpoint (full lists in `video.md`). Gen-4.5 text-only takes only `1280:720` / `720:1280`; HappyHorse image-to-video sends no ratio.
- `seed` (int, optional, 0–4294967295; blank = random). Not for HappyHorse.
- `resolution` (enum `720p` / `1080p`, default `720p`): HappyHorse image-to-video only.
- `audio` (bool, default `true`): Veo 3.1 (+ Fast) and Seedance. Veo bills less without audio.
- Text-to-video-capable models: everything but `gen4_turbo`.

### `runway-aleph`
- `model` (enum, default `aleph2`): `aleph2` (Aleph 2.0). `gen4_aleph` was retired 2026-07-30; saved nodes migrate.
- `seed` (int, optional, 0–4294967295). `prompt` and `video` (2–30 s) come in via ports; the optional `reference` image is sent as a keyframe at the start. No ratio/duration control — output matches the input video.

### `runway-image`
- `model` (enum, **required**, default `gen4_image`): `gen4_image` · `gen4_image_turbo` · `gemini_image3_pro` (Nano Banana Pro) · `gpt_image_2` · `gemini_2.5_flash` · `seedream5_pro` (Seedream 5.0 Pro) · `seedream5_lite` (Seedream 5.0 Lite). Seedream is ByteDance's model, resold by Runway.
- `ratio` (enum, default `1360:768`): each model's own list (`image.md`); `1360:768` is Gen-4 only, so pick a ratio after switching models.
- `seed` (int, optional, 0–4294967295): Gen-4 Image (+ Turbo) only.
- `grounding` (bool, default `false`): Seedream only; lets the model search the web.
- Reference images arrive on the `images` port (multiple allowed, up to the model's maximum). `gen4_image_turbo` requires ≥1. The API supports per-image `tag` for `@tag` prompt references — **Nebula sends no tags**, so references act as ambient guidance only (see boundaries).

### `runway-upscale` (new 2026-06-10)
- `scaleFactor` (enum, default `2`): `2` · `4` · `8` · `16` (2x–16x).
- `flavor` (enum, default `photo`): `photo` · `photo_denoiser` · `sublime` (illustration).
- `sharpen` (int, optional, 0–100; blank = none).
- `smartGrain` (int, optional, 0–100; blank = none).
- `ultraDetail` (int, optional, 0–100; blank = none).
- Model is pinned to `magnific_precision_upscaler_v2` (no model param). Pricing: **25 credits per image, 150 when the output exceeds 4096px**. The `image` port is required (local paths auto-encode to data URIs); output is a PNG on the `image` port.

### `runway-act-two`
- `bodyControl` (bool, default `false`): when true, body/gesture motion transfers too, not just face.
- `expressionIntensity` (int, default `3`, min `1`, max `5`).
- `ratio` (enum, default `1280:720`): `1280:720` · `720:1280` · `960:960` · `1104:832` · `832:1104` · `1584:672`.
- `seed` (int, optional, 0–4294967295).
- Character comes from **either** `character_image` **or** `character_video` (provide exactly one); `reference` is the performance video and is required. Reference video must be **3–30 s** or the API returns `400`; the face must stay in frame throughout the character asset.

### `runway-tts`
- `voiceId` (enum, default `Maya`, **30 presets**): `Maya`, `Arjun`, `Serene`, `Bernard`, `Billy`, `Mark`, `Clint`, `Mabel`, `Chad`, `Leslie`, `Eleanor`, `Elias`, `Elliot`, `Brodie`, `Sandra`, `Kirk`, `Kylie`, `Lara`, `Lisa`, `Maggie`, `Jack`, `Katie`, `Noah`, `James`, `Rina`, `Ella`, `Frank`, `Rachel`, `Tom`, `Benjamin`. Case-sensitive. Model fixed to `eleven_multilingual_v2`; `text` arrives on the port.

### `runway-sts`
- `voiceId` (enum, default `Maya`, **19 presets** — a subset of the TTS list): `Maya`, `Arjun`, `Serene`, `Bernard`, `Billy`, `Mark`, `Clint`, `Mabel`, `Chad`, `Leslie`, `Eleanor`, `Maggie`, `Jack`, `Noah`, `James`, `Ella`, `Frank`, `Rachel`, `Tom`.
- `removeBackgroundNoise` (bool, default `false`).
- Source comes from `audio` **or** `video` port (video → its audio track is used). Model fixed to `eleven_multilingual_sts_v2`.

### `runway-dubbing`
- `targetLang` (enum, **required**, default `es`, **28 languages**): `en`, `es`, `fr`, `de`, `it`, `pt`, `ja`, `ko`, `zh`, `ar`, `ru`, `hi`, `nl`, `tr`, `pl`, `sv`, `fil`, `id`, `ro`, `uk`, `el`, `cs`, `da`, `fi`, `bg`, `hr`, `sk`, `ta`.
- `disableVoiceCloning` (bool, default `false`): true → generic voice instead of cloning the original speaker.
- `dropBackgroundAudio` (bool, default `false`): true → strip music/ambient.
- `numSpeakers` (int, optional, min `1`, max `10`; blank = auto-detect).
- Source on the `audio` port (required). Model fixed to `eleven_voice_dubbing`.

Deeper wire-format detail (full per-model ratio/duration matrices, the full API-level voice/language sets, exact request JSON) lives in the topic files: `video.md`, `image.md`, `character-performance.md`, `audio.md`.

## Recipes

**Recipe 1 — Still photo → moving clip (image-to-video).**
1. `runway-image` (or any image source) → produces an `image`.
2. Wire that `image` into `runway-video`'s `image` port; type a `prompt` like "slow dolly-in, cinematic lighting"; set `model` = `gen4.5`, `duration` = 8, `ratio` = `1280:720`.
3. Run → `runway-video` emits an MP4 on its `video` port. (Because an image is connected, it hits `image_to_video`.)

**Recipe 2 — Generated character performs a line, then localized (avatar dialogue).**
1. `runway-image` with `prompt` "studio portrait of a friendly news anchor facing camera" → `image`.
2. Wire that `image` into `runway-act-two`'s `character_image` port. Record/import a 3–30 s performance clip and wire it into the `reference` port. Set `bodyControl` = true, `expressionIntensity` = 4.
3. Run → `runway-act-two` emits the performed clip.
4. (Optional) Take the spoken audio from that clip into `runway-dubbing` with `targetLang` = `fr` to ship a French version (leave `disableVoiceCloning` off to keep the speaker's voice).

**Recipe 3 — Narrated text-to-video scene.**
1. `runway-tts`: put narration into `text`, pick `voiceId` = `Maya` → an `audio` clip.
2. `runway-video` with **no image**, `prompt` describing the scene, `model` = `gen4.5`, `ratio` = `1280:720` → a text-to-video MP4. (Text-only works on every model but Gen-4 Turbo; Gen-4.5 text-only needs a 16:9 or 9:16 ratio.)
3. Combine audio + video in a downstream compositing/merge node. To re-voice existing narration into a different preset instead of generating fresh, route the audio through `runway-sts`.

## In the nebula_nodes context

- **Node ids:** `runway-video`, `runway-aleph`, `runway-act-two` (category `video-gen`); `runway-image` (`image-gen`); `runway-upscale` (`transform`); `runway-tts`, `runway-sts`, `runway-dubbing` (`audio-gen`). All defined in `backend/data/node_definitions.json` with `apiProvider: "runway"`, `envKeyName: "RUNWAY_API_KEY"`, `executionPattern: "async-poll"`.
- **Handler:** all eight dispatch to `backend/handlers/runway.py` — `handle_runway_video`, `handle_runway_aleph`, `handle_runway_image`, `handle_runway_image_upscale`, `handle_runway_act_two`, `handle_runway_tts`, `handle_runway_speech_to_speech`, `handle_runway_voice_dubbing`. Shared helpers: `_runway_poll_config` (2 s / 300-poll `AsyncPollConfig`), `_resolve_image` / `_local_media_uri` (local path → data URI under 5MB, else `_upload_ephemeral` → `runway://`), `_save_audio_from_url`. Per-model tables: `RUNWAY_VIDEO_MODELS`, `RUNWAY_IMAGE_MODELS`; retired IDs: `RETIRED_RUNWAY_MODELS`.
- **Krea copies on the Runway key (2026-10-14).** `krea-image-runway-gen-4-image` (`gen4_image`), `krea-video-runway-gen-4-5` (`gen4.5`) and `krea-enhance-runway-ruby` (`ruby` on `/v1/video_to_hdr`) run on Runway with `RUNWAY_API_KEY` unless the node uses the Krea plan (`backend/execution/maker_routes_ideogram_runway.py`, reusing these helpers). See `docs/api-guides/runway.md`.
- **Ports (input → output):**
  - `runway-video`: `prompt` (Text, opt) + `image` (Image, opt) → `video` (Video).
  - `runway-aleph`: `video` (Video, req) + `prompt` (Text, req) + `reference` (Image, opt) → `video` (Video).
  - `runway-image`: `prompt` (Text, req) + `images` (Image, opt, multiple) → `image` (Image).
  - `runway-upscale`: `image` (Image, req) → `image` (Image).
  - `runway-act-two`: `character_image` (Image, opt) / `character_video` (Video, opt) + `reference` (Video, req) → `video` (Video).
  - `runway-tts`: `text` (Text, req) → `audio` (Audio).
  - `runway-sts`: `audio` (Audio, opt) / `video` (Video, opt) → `audio` (Audio).
  - `runway-dubbing`: `audio` (Audio, req) → `audio` (Audio).
- **Chaining rules.** Outputs are concrete media values (a local file path under the run dir), so any `Video`/`Image`/`Audio` output port can feed a matching input port. Common chains: `runway-image` → `runway-video` (still → motion) or → `runway-act-two` (`character_image`); any image output → `runway-upscale` for a 2x–16x master; `runway-video`/`runway-act-two` → `runway-sts`/`runway-dubbing` via the produced clip's audio; `runway-aleph` to restyle any upstream `Video`. For text-only `runway-video`, leave the `image` port unconnected and supply a `prompt` (on any model but `gen4_turbo`; the node errors before submit if the ratio or duration doesn't fit the model).
- **How outputs render.** The handler downloads `output[0]` and saves it locally (MP4 / PNG / MP3) under the run directory; the file path is returned on the output port and served to the canvas via the standard outputs route. Video previews play inline; images show in the image preview; audio shows an audio player.

### Capability boundaries (what Nebula does NOT expose)

Do not promise these via Runway nodes — there is no node or param behind them. (From the audit gap table in `docs/api-guides/runway.md`.)

- **Seedance video-to-video** — `runway-video` exposes Seedance 2.0 / Fast / Mini / 2.5 for text/image-to-video, but the **video-to-video** mode (`promptVideo`, reference images/videos/audio; 2.5's `mode` reference / extend / edit) is unreachable: the node has no video input. `runway-aleph` runs Aleph 2.0 only.
- **Seedance 2.5 draft mode** — `draft: true` (480p preview) and the later `draftTaskId` enhance aren't exposed.
- **`outputCount` / multiple variations** — every node returns a single output; you cannot request N variations in one run.
- **First+last keyframes, reference images/videos/audio on video, Veo `negativePrompt`, Gen-4.5 `outputFormat`, `contentModeration.publicFigureThreshold`** — not surfaced as node params (the handler sends a single first-frame image and no moderation override). The Veo/Seedance `audio` toggle *is* exposed (2026-10-14).
- **Image extras** — `outputCount`, GPT Image 2 `quality` / `background`, Seedream `outputFormat` and Lite's freeform sizes aren't exposed; nor are Runway's newer image models (Nano Banana 2 / 2.1, Ideogram, GPT Image 2.5, Grok Imagine Image 2, Muse).
- **Text-to-image tagged references** — the API lets each reference image carry a `tag` for `@tag` prompt callouts; `runway-image` sends references without tags, so they act as ambient style only (and you can't address them by name in the prompt).
- **Custom / cloned voices** — TTS and STS expose only built-in presets (`voice.type: "runway-preset"`). The Voices API (`POST /v1/voices`, preview, list/retrieve/delete) for creating and using cloned voices is not wired in. Preset counts are also capped below the API's full set: TTS exposes 30 and STS 19, vs the larger ElevenLabs-backed catalog.
- **Sound-effect generation** (`POST /v1/sound_effect`) — no node.
- **Voice isolation / cleanup** (`POST /v1/voice_isolation`) — no node.
- **Avatars & avatar videos** (`/v1/avatars`, `/v1/avatar_videos`) — no node.
- **Saved workflows & invocations, realtime sessions, documents, organization/usage** — no nodes; out of scope for the batch node model.
- **User-facing job cancel/delete** — `DELETE /v1/tasks/{id}` exists; there is still no user-facing cancel/delete node, but as of 2026-06-05 a poll cancellation fires a best-effort `DELETE /v1/tasks/{id}` so the in-flight Runway job stops upstream instead of running to completion.

Roughly: ~9 of ~12 media-generation endpoints are wired up (image upscale joined 2026-06-10); counting the full resource surface (voices, avatars, workflows, documents, account) it's closer to ~45%. The most natural near-term adds are Sound Effect and Voice Isolation nodes (single-in/single-out, fit the existing pattern).

## Sources

- Runway API docs (landing): https://docs.dev.runwayml.com/
- Runway request schema (per-model fields, read 2026-10-14): https://docs.dev.runwayml.com/openapi.json
- Runway models / pricing / changelog: https://docs.dev.runwayml.com/guides/models.md, https://docs.dev.runwayml.com/guides/pricing.md, https://docs.dev.runwayml.com/llms-full.txt
- Runway uploads: https://docs.dev.runwayml.com/assets/uploads
- Runway Python SDK API manifest (authoritative endpoint + resource list): https://raw.githubusercontent.com/runwayml/sdk-python/main/api.md
- Runway Python SDK repository (raw request/response types): https://github.com/runwayml/sdk-python
- Nebula audit guide (node table, params, full capability surface, gap table, cited sources): `docs/api-guides/runway.md`
- Ground truth cross-checked in this repo: `backend/data/node_definitions.json` (node ids, ports, param enums/ranges) and `backend/handlers/runway.py` (request building, endpoint switching, voice/reference nesting, async-poll config).

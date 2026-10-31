# Runway in Nebula Nodes

> Runway turns text, images, and video into new video, images, and voiceover — animate a still photo into a clip, restyle existing footage, make a portrait act out a performance, generate a still image, and produce or dub speech — all from nodes on your Nebula canvas.

## What you can make

**Video**
- Animate a still image into a moving clip (image-to-video).
- Generate a video straight from a text prompt (text-to-video).
- Restyle or edit existing footage with a prompt — change the look, weather, world, or wardrobe while keeping the motion (Aleph / video-to-video).
- Make a character (a photo or a clip) lip-sync and act out a reference performance video (Act-Two character performance).

**Images**
- Generate a still image from a text prompt, optionally guided by reference images (Gen-4, Nano Banana Pro, GPT Image 2, Gemini 2.5 Flash, Seedream 5.0 Pro / Lite).
- Upscale an existing still 2×–16× with Runway's Magnific precision upscaler, with sharpen / grain / detail controls (Runway Upscale).

**Audio / voice**
- Turn text into spoken voiceover with a library of preset voices (text-to-speech).
- Restyle existing spoken audio (or the voice track of a video) into a different preset voice while keeping the original delivery (speech-to-speech).
- Dub a piece of audio into another language — 28 languages — optionally cloning the original speaker's voice (voice dubbing).

## Nodes available in Nebula (8) (updated 2026-10-14)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Runway Video | `runway-video` | video-gen | `prompt` (text, optional), `image` (optional) | `model` (Gen-4.5 / Seedance 2.0 / Seedance 2.0 Fast / HappyHorse 1.0 / Gen-4 Turbo / Veo 3.1 / Veo 3.1 Fast / Seedance 2.0 Mini / Seedance 2.5), `duration` and `ratio` (the inspector shows only what the chosen model takes), `audio` (Veo, Seedance), `resolution` (HappyHorse with an image), `seed` | Animate a photo into a clip, or generate a clip from text. Connect an `image` for image-to-video; leave it empty and write a `prompt` for text-to-video (every model but Gen-4 Turbo). |
| Runway Aleph | `runway-aleph` | video-gen | `video` (required, 2–30 s), `prompt` (required), `reference` (image, optional) | `model` (Aleph 2.0), `seed` | Restyle / edit existing footage from a prompt — swap the setting, lighting, or style while keeping the motion. The optional reference image goes in as a keyframe at the start of the clip. (Gen-4 Aleph was retired by Runway on 2026-07-30; saved nodes move to Aleph 2.0.) |
| Runway Image | `runway-image` | image-gen | `prompt` (required), `images` (reference images, optional, multiple) | `model` (Gen-4 Image / Gen-4 Image Turbo / Nano Banana Pro / GPT Image 2 / Gemini 2.5 Flash / Seedream 5.0 Pro / Seedream 5.0 Lite), `ratio` (each model's own sizes), `seed` (Gen-4 only), `grounding` (Seedream) | Generate a still image from text, optionally guided by reference images (up to 3 for Gen-4 and Gemini 2.5 Flash, 10 for Seedream Pro, 14 for Nano Banana Pro and Seedream Lite, 16 for GPT Image 2; Gen-4 Image Turbo needs at least one). |
| Runway Upscale | `runway-upscale` | transform | `image` (required) | `scaleFactor` (2/4/8/16, default 2), `flavor` (photo / photo_denoiser / sublime), `sharpen` (0–100), `smartGrain` (0–100), `ultraDetail` (0–100) | Upscale a still 2×–16× (pinned to magnific_precision_upscaler_v2; 25 credits per image, 150 when the output exceeds 4096px). |
| Runway Act-Two | `runway-act-two` | video-gen | `character_image` OR `character_video`, `reference` (performance video, required) | `bodyControl` (bool), `expressionIntensity` (1–5), `ratio` (6 options), `seed` | Drive a character (still photo or clip) to perform a reference acting video — facial expression, lip-sync, and optionally body movement. |
| Runway TTS | `runway-tts` | audio-gen | `text` (required) | `voiceId` (30 preset voices, e.g. Maya, Arjun, Bernard) | Turn a script into spoken voiceover. |
| Runway Speech-to-Speech | `runway-sts` | audio-gen | `audio` OR `video` | `voiceId` (20 preset voices), `removeBackgroundNoise` (bool) | Re-voice existing speech (or a video's audio track) into a different preset voice, keeping the original delivery. |
| Runway Voice Dubbing | `runway-dubbing` | audio-gen | `audio` (required) | `targetLang` (28 languages), `disableVoiceCloning` (bool), `dropBackgroundAudio` (bool), `numSpeakers` (1–10) | Dub a clip into another language, optionally cloning the original speaker. |

## Krea copies on your Runway key (2026-10-14)

Three Krea copies of Runway's models also run on Runway's own API when
`RUNWAY_API_KEY` is saved. The Krea plan wins when chosen, then your Runway key
(Runway bills), then your Krea API key.

| Krea node | Runway model and endpoint | Notes |
|---|---|---|
| `krea-image-runway-gen-4-image` | `gen4_image`, POST `/v1/text_to_image` | width/height go as the nearest of gen4_image's 16 output sizes (`backend/services/maker_sizes.py`); the Inspector notes a size that changes, and the run's notes give the size Runway made; reference images keep their tags. 5 credits (720p) or 8 credits (1080p) per image, shown as $0.05-0.08. |
| `krea-video-runway-gen-4-5` | `gen4.5`, `/v1/image_to_video` or `/v1/text_to_video` | Duration rounds to whole seconds (Runway takes 2-10). Krea's 672:1584 isn't in Runway's gen4.5 request schema, and text-to-video takes only 1280:720 or 720:1280; both runs stay on Krea (route rules), and the handler still refuses them before submit if called directly. 12 credits per second. |
| `krea-enhance-runway-ruby` | `ruby`, POST `/v1/video_to_hdr` | hdr10 / hlg (.mp4) or hdr_prores (.mov, `proresProfile` only there). Local videos over the 5MB data URI cap go up through `/v1/uploads`. Unpriced: 20 credits per second, 40 above 4 MP, and the source's length and size are only known at run time. |

Not routed: `krea-video-runway-gen-4-video`. Krea calls it "Runway Gen-4" and
runs it from text alone, but Runway's only Gen-4 video model, `gen4_turbo`,
needs an image, so the upstream model isn't confirmed.

**Voice nodes on your ElevenLabs key (2026-10-14).** Runway's voice nodes are ElevenLabs models, so with an ElevenLabs key saved they can run on ElevenLabs directly, billed by ElevenLabs. `runway-dubbing` switches as soon as the key is saved. `runway-tts` and `runway-sts` switch only when you set an **ElevenLabs voice ID** (the Inspector shows the field once the key is saved): Runway's preset voices (Maya, Arjun, ...) have no ElevenLabs equivalent Nebula can look up, so a recipe with only a preset keeps running on Runway (a blank voice ID counts as unset). `runway-sts` with only the video input wired also stays on Runway: ElevenLabs' speech-to-speech takes an audio file only. Readiness says which route runs. Details: [the ElevenLabs guide](elevenlabs.md).

## How to use it in Nebula

**Where the nodes appear.** Runway nodes live in the node palette under their media categories — the three video nodes (`runway-video`, `runway-aleph`, `runway-act-two`) under **video-gen**, `runway-image` under **image-gen**, `runway-upscale` under **transform**, and the three voice nodes (`runway-tts`, `runway-sts`, `runway-dubbing`) under **audio-gen**. Drag a node onto the canvas, wire inputs into its ports, set its params in the inspector, and run.

**API-key setup.** Runway calls authenticate with a single key. Get it from the Runway developer dashboard at dev.runwayml.com. Open Nebula **Settings** → **Providers**, choose **Add key** on the **Runway** row (`RUNWAY_API_KEY`), paste it and choose **Save key**. Saving checks the key without generating anything. Nebula stores it under `apiKeys.RUNWAY_API_KEY` in the project-root `settings.json`; no restart is required. All eight nodes share this one key. Every Runway job is asynchronous — Nebula submits the task and polls until it finishes, so a video node may take a minute or two before the output port lights up. Public HTTPS URLs are passed through. Local files go inline as data URIs while they fit Runway's 5MB data URI limit; bigger files (up to 200MB) go through Runway's ephemeral upload (`POST /v1/uploads`, a `runway://` URI valid for 24 hours), so large source videos take longer to start.

**Recipe 1 — Still photo → talking, moving clip.**
1. Drop a `runway-image` node (or bring in any image) → produces an `image`.
2. Wire that `image` into a `runway-video` node, add a `prompt` like "slow dolly-in, cinematic lighting," set `model` to Gen-4.5 and `duration` to 8. (Gen-4.5 needs a prompt with an image; Veo 3.1 takes only 4, 6 or 8 s.)
3. Run. You get an animated MP4 from your still.

**Recipe 2 — Generated character performs a line (avatar dialogue).**
1. Generate a character portrait with `runway-image` (`prompt`: "studio portrait of a friendly news anchor, facing camera").
2. Wire its `image` into the `character_image` port of a `runway-act-two` node.
3. Record or import a short performance clip (3–30s of you delivering the line) and wire it into the `reference` port. Turn on `bodyControl` and set `expressionIntensity` to 4.
4. Run → the portrait acts out your performance.
5. (Optional) Feed the resulting clip's voice into `runway-dubbing` with `targetLang` = French to ship a localized version.

**Recipe 3 — Voice over a generated scene.**
1. Write your narration into a `runway-tts` node, pick a `voiceId` (e.g. Maya), run → an audio clip.
2. Generate a background clip with `runway-video` (text-only, Gen-4.5).
3. Combine the audio and video downstream (e.g. a compositing/merge node) for a narrated scene. To restyle existing narration into a different voice instead, route it through `runway-sts`.

## API coverage — what Nebula uses vs. what Runway offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Image → video (`POST /v1/image_to_video`) | Yes | full | `runway-video` with an `image` connected. |
| Text → video (`POST /v1/text_to_video`) | Yes | full | `runway-video` with no image, on any model but Gen-4 Turbo. Ratios and durations follow each model's own list (Gen-4.5 text-only takes 16:9 or 9:16 only). |
| Video → video / restyle (`POST /v1/video_to_video`) | Yes | partial | `runway-aleph` exposes Aleph 2.0 (video + prompt + 1 reference image, sent as a keyframe). The API also has Seedance 2.0 / Fast / Mini / 2.5 video-to-video (`promptVideo`, reference images/videos/audio; 2.5 adds `mode` reference / extend / edit) that Nebula does not expose: `runway-video` has no video input. |
| Text → image (`POST /v1/text_to_image`) | Yes | partial | `runway-image` covers Gen-4 Image, Turbo, Nano Banana Pro (`gemini_image3_pro`), GPT Image 2 (`gpt_image_2`), Gemini 2.5 Flash, and ByteDance's Seedream 5.0 Pro / Lite (`seedream5_pro`, `seedream5_lite`, added 2026-10-14; Runway resells them). Not surfaced: reference-image **tags**, `outputCount`, GPT Image 2 `quality` / `background`, Seedream `outputFormat` and Lite's freeform sizes, `contentModeration`, and Runway's newer image models (Nano Banana 2 / 2.1, Ideogram, GPT Image 2.5, Grok Imagine Image 2, Muse). |
| Character performance / Act-Two (`POST /v1/character_performance`) | Yes | full | `runway-act-two` exposes character (image or video), reference, bodyControl, expressionIntensity, ratio, seed. |
| Text → speech (`POST /v1/text_to_speech`) | Yes | partial | `runway-tts` exposes 30 of Runway's preset voices; cloned/custom voices (via the Voices API) are not selectable. |
| Speech → speech (`POST /v1/speech_to_speech`) | Yes | full | `runway-sts` (audio or video in, preset voice out, optional noise removal). |
| Voice dubbing (`POST /v1/voice_dubbing`) | Yes | partial | `runway-dubbing` exposes 28 target languages and the main toggles; full ElevenLabs language list is slightly larger. |
| Sound effect (`POST /v1/sound_effect`) | Yes | none | Generate SFX from a text prompt — no Nebula node. |
| Voice isolation (`POST /v1/voice_isolation`) | Yes | none | Strip background noise / isolate a voice from a recording — no Nebula node. |
| Image upscale (`POST /v1/image_upscale`) | Yes | full | `runway-upscale` (added 2026-06-10) — magnific_precision_upscaler_v2, 2×–16×, flavor/sharpen/smartGrain/ultraDetail controls. |
| Custom voice cloning (`POST /v1/voices`, `…/preview`, list/retrieve/delete) | Yes | none | Create and manage cloned voices, then use them in TTS/STS. Nebula only offers built-in presets. |
| Avatars + avatar videos (`POST /v1/avatars`, `/v1/avatar_videos`, CRUD) | Yes | none | Persistent custom avatars and avatar-driven video generation — no Nebula node. |
| Realtime sessions (`POST /v1/realtime_sessions`) | Yes | none | Live/interactive real-time sessions — out of scope for the batch node model. |
| Workflows + invocations (`/v1/workflows`, `/v1/workflows/{id}`, `/v1/workflow_invocations/{id}`) | Yes | none | Run saved Runway workflows by ID — not wired into Nebula. |
| Documents (`/v1/documents` CRUD) | Yes | none | Document storage/management resource — not relevant to node media gen. |
| Organization + usage (`GET /v1/organization`, `POST /v1/organization/usage`) | Yes | none | Account/quota/usage introspection — Nebula doesn't surface billing or usage. |
| Task polling / cancel (`GET` / `DELETE /v1/tasks/{id}`) | Yes | partial | Nebula polls task status internally (`GET`) but does not expose user-facing job cancel/delete. |

Coverage: ~75% of the Runway **generation** API surface (the endpoints that produce media — 9 of ~12) is exposed in Nebula; counting the full resource surface including account, voices, avatars, workflows, and document management, it's closer to ~45%.

Notable unused capabilities: **sound-effect generation**, **voice isolation/clean-up**, **custom voice cloning** (the Voices API — would let TTS/STS use a user's own cloned voice instead of presets), **avatars / avatar videos**, **saved workflows**, and **realtime sessions**. (The **image upscaling** gap closed 2026-06-10 with `runway-upscale`.) The most natural near-term adds for a media-gen tool are a Sound Effect node and a Voice Isolation node — both single-input, single-output generation endpoints that fit the existing node pattern. The richer Seedance 2 paths (multi-reference video-to-video) and text-to-image **tagged references** are partial gaps within nodes that already exist.

## Retired models and per-model limits (checked 2026-10-14)

Runway's changelog: "July 30th, 2026 - Gen-3 Alpha Turbo (`gen3a_turbo`) and Gen-4 Aleph (`gen4_aleph`) are no longer available on Runway Dev. Requests that use these model identifiers will fail." `veo3` is no longer in the image/text-to-video request schema. Saved graphs move `gen3a_turbo` to `gen4_turbo` (image-to-video only, so a text-only node now asks for an image), `veo3` to `veo3.1` (duration rounded up to 4, 6 or 8 s; a node with no saved duration ran at 5 s, so it becomes 6) and `gen4_aleph` to `aleph2` (`backend/services/retired_nodes.py`).

Each model takes its own ratios and durations (from Runway's `openapi.json`). The inspector shows only those, and the handler checks them before submitting:

| Model | Durations | Ratios | Extra fields |
|---|---|---|---|
| Gen-4.5 | 2–10 s | image: 1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672; text: 1280:720, 720:1280 | needs a prompt with an image |
| Gen-4 Turbo | 2–10 s | as Gen-4.5 image; no text-to-video | — |
| Veo 3.1 / Fast | 4, 6, 8 s | 1280:720, 720:1280, 1920:1080, 1080:1920 | `audio` (default on; changes the price) |
| Seedance 2.0 | 4–15 s or auto | 24 ratios, 480p–4K | `audio` |
| Seedance 2.0 Fast / Mini | 4–15 s or auto | 12 ratios, 480p/720p | `audio` |
| Seedance 2.5 | 4–30 s or auto | 18 ratios, 480p–1080p | `audio` |
| HappyHorse 1.0 | 3–15 s | text: 10 ratios (720p/1080p); image: none, `resolution` 720p/1080p instead | no seed |

Not exposed on `runway-video`: first/last keyframes, reference images/videos/audio, Veo `negativePrompt`, Seedance 2.5 draft mode (a 480p preview enhanced later with `draftTaskId`), and Gen-4.5 `outputFormat` (ProRes/HDR).

**Prices** are in `backend/data/model_pricing.json` (Runway credits, $0.01 each, from https://docs.dev.runwayml.com/guides/pricing). Seedance and HappyHorse tiers are read from the ratio's pixel size; tiers Runway doesn't map to ratios (some Gen-4 Image, GPT Image 2 and HappyHorse settings) are shown as a range, and `auto` duration is unpriced.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/runway/SKILL.md` (refreshed 2026-06-04, updated 2026-10-14) — a well-structured set: `SKILL.md` (universal rules, an endpoint-picker table mapping every `runway-*` node to its endpoint, response parsing, and an auth-failure playbook) plus four deep-dive references: `video.md`, `image.md`, `character-performance.md`, `audio.md`. It covers all **8** shipped Runway nodes, giving an agent the node IDs and ports, wire-format field names (camelCase), per-node params, wiring/chaining rules, and capability boundaries — so an agent can configure and run all of them without reading the handler.

What it covers:
- **All 8 nodes** (`runway-video`, `runway-aleph`, `runway-image`, `runway-upscale`, `runway-act-two`, `runway-tts`, `runway-sts`, `runway-dubbing`) — per-model ratio/duration matrices, voice-preset lists, and dubbing language codes, all corrected to the real node enums (e.g. the image-ratio count fixed to the node's 11; the 2026-06 model refresh added Seedance 2.0 (+ Fast), HappyHorse 1.0, Aleph 2.0, Nano Banana Pro, and GPT Image 2).
- **The async submit/poll contract** and wire-format gotchas — the handler inlines local files as data URIs under Runway's 5MB cap and uploads bigger ones through `POST /v1/uploads` (runway:// URIs).
- **Capability boundaries** — a note on what's exposed in Nebula vs. API-only (SFX, voice cloning, avatars, workflows have no node), so an agent doesn't promise a capability with no node behind it.

## Sources

- Runway API docs (landing): https://docs.dev.runwayml.com/
- Runway SDKs / endpoint mapping: https://docs.dev.runwayml.com/api-details/sdks/
- Runway request schema (per-model fields): https://docs.dev.runwayml.com/openapi.json
- Runway models, pricing and changelog: https://docs.dev.runwayml.com/guides/models.md, https://docs.dev.runwayml.com/guides/pricing.md, https://docs.dev.runwayml.com/llms-full.txt
- Runway uploads and input limits: https://docs.dev.runwayml.com/assets/uploads
- Official Runway Python SDK API manifest (authoritative endpoint + resource list): https://raw.githubusercontent.com/runwayml/sdk-python/main/api.md
- Runway Python SDK repository: https://github.com/runwayml/sdk-python

# Runway in Nebula Nodes

> Runway turns text, images, and video into new video, images, and voiceover — animate a still photo into a clip, restyle existing footage, make a portrait act out a performance, generate a still image, and produce or dub speech — all from nodes on your Nebula canvas.

## What you can make

**Video**
- Animate a still image into a moving clip (image-to-video).
- Generate a video straight from a text prompt (text-to-video).
- Restyle or edit existing footage with a prompt — change the look, weather, world, or wardrobe while keeping the motion (Aleph / video-to-video).
- Make a character (a photo or a clip) lip-sync and act out a reference performance video (Act-Two character performance).

**Images**
- Generate a still image from a text prompt, optionally guided by up to three reference images you can name and call out by tag in the prompt.
- Upscale an existing still 2×–16× with Runway's Magnific precision upscaler, with sharpen / grain / detail controls (Runway Upscale).

**Audio / voice**
- Turn text into spoken voiceover with a library of preset voices (text-to-speech).
- Restyle existing spoken audio (or the voice track of a video) into a different preset voice while keeping the original delivery (speech-to-speech).
- Dub a piece of audio into another language — 28 languages — optionally cloning the original speaker's voice (voice dubbing).

## Nodes available in Nebula (8) (updated 2026-06-10)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Runway Video | `runway-video` | video-gen | `prompt` (text, optional), `image` (optional) | `model` (Gen-4.5 / Seedance 2.0 / Seedance 2.0 Fast / HappyHorse 1.0 / Gen-4 Turbo / Gen-3a Turbo legacy / Veo 3.1 / Veo 3.1 Fast / Veo 3), `duration` (2–10s), `ratio` (6 options), `seed` | Animate a photo into a clip, or generate a clip from text. Connect an `image` for image-to-video; leave it empty and write a `prompt` for text-to-video (text-only needs Gen-4.5, Seedance 2.0 (+ Fast), HappyHorse 1.0, or a Veo model, and only 16:9 / 9:16). |
| Runway Aleph | `runway-aleph` | video-gen | `video` (required), `prompt` (required), `reference` (image, optional) | `model` (Aleph 2.0 / Gen-4 Aleph), `seed` | Restyle / edit existing footage from a prompt — swap the setting, lighting, or style while keeping the motion. Optional reference image steers the look. (Runs Gen-4 Aleph by default; Aleph 2.0, the June 2026 release, is selectable.) |
| Runway Image | `runway-image` | image-gen | `prompt` (required), `images` (reference images, optional, multiple) | `model` (Gen-4 Image / Gen-4 Image Turbo / Nano Banana Pro / GPT Image 2 / Gemini 2.5 Flash), `ratio` (11 options), `seed` | Generate a still image from text, optionally guided by up to 3 reference images. |
| Runway Upscale | `runway-upscale` | transform | `image` (required) | `scaleFactor` (2/4/8/16, default 2), `flavor` (photo / photo_denoiser / sublime), `sharpen` (0–100), `smartGrain` (0–100), `ultraDetail` (0–100) | Upscale a still 2×–16× (pinned to magnific_precision_upscaler_v2; 25 credits per image, 150 when the output exceeds 4096px). |
| Runway Act-Two | `runway-act-two` | video-gen | `character_image` OR `character_video`, `reference` (performance video, required) | `bodyControl` (bool), `expressionIntensity` (1–5), `ratio` (6 options), `seed` | Drive a character (still photo or clip) to perform a reference acting video — facial expression, lip-sync, and optionally body movement. |
| Runway TTS | `runway-tts` | audio-gen | `text` (required) | `voiceId` (30 preset voices, e.g. Maya, Arjun, Bernard) | Turn a script into spoken voiceover. |
| Runway Speech-to-Speech | `runway-sts` | audio-gen | `audio` OR `video` | `voiceId` (20 preset voices), `removeBackgroundNoise` (bool) | Re-voice existing speech (or a video's audio track) into a different preset voice, keeping the original delivery. |
| Runway Voice Dubbing | `runway-dubbing` | audio-gen | `audio` (required) | `targetLang` (28 languages), `disableVoiceCloning` (bool), `dropBackgroundAudio` (bool), `numSpeakers` (1–10) | Dub a clip into another language, optionally cloning the original speaker. |

## How to use it in Nebula

**Where the nodes appear.** Runway nodes live in the node palette under their media categories — the three video nodes (`runway-video`, `runway-aleph`, `runway-act-two`) under **video-gen**, `runway-image` under **image-gen**, `runway-upscale` under **transform**, and the three voice nodes (`runway-tts`, `runway-sts`, `runway-dubbing`) under **audio-gen**. Drag a node onto the canvas, wire inputs into its ports, set its params in the inspector, and run.

**API-key setup.** Runway calls authenticate with a single key. Get it from the Runway developer dashboard at dev.runwayml.com. Open Nebula **Settings**, paste it into the **Runway** field (`RUNWAY_API_KEY`), and choose **Save Settings**. Nebula stores it under `apiKeys.RUNWAY_API_KEY` in the project-root `settings.json`; no restart is required. All eight nodes share this one key. Every Runway job is asynchronous — Nebula submits the task and polls until it finishes, so a video node may take a minute or two before the output port lights up. Inputs that aren't already public HTTPS URLs are sent inline (local images/clips are encoded automatically), so very large source videos can take longer to upload.

**Recipe 1 — Still photo → talking, moving clip.**
1. Drop a `runway-image` node (or bring in any image) → produces an `image`.
2. Wire that `image` into a `runway-video` node, add a `prompt` like "slow dolly-in, cinematic lighting," set `model` to Gen-4.5 and `duration` to 8.
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
| Text → video (`POST /v1/text_to_video`) | Yes | full | `runway-video` with no image. Nebula restricts text-only to Gen-4.5 / Seedance 2.0 (+ Fast) / HappyHorse 1.0 / Veo models and 16:9 or 9:16, matching API model limits. |
| Video → video / restyle (`POST /v1/video_to_video`) | Yes | partial | `runway-aleph` exposes Aleph 2.0 / Gen-4 Aleph (video + prompt + 1 reference image). The API also accepts a Seedance 2 video-to-video path (multi-image + video references, output count) that Nebula does not expose. |
| Text → image (`POST /v1/text_to_image`) | Yes | partial | `runway-image` covers Gen-4 Image, Turbo, Nano Banana Pro (`gemini_image3_pro`, added to the Runway API 2026-04-30), GPT Image 2 (`gpt_image_2`, added 2026-04-23), and Gemini 2.5 Flash. Reference-image **tags** (`@name` prompt references) and the `contentModeration` knob are not surfaced as node params. |
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

## Agent skill coverage

**A complete skill exists** at `.claude/skills/runway/SKILL.md` (refreshed 2026-06-04, updated 2026-06-10) — a well-structured set: `SKILL.md` (universal rules, an endpoint-picker table mapping every `runway-*` node to its endpoint, response parsing, and an auth-failure playbook) plus four deep-dive references: `video.md`, `image.md`, `character-performance.md`, `audio.md`. It covers all **8** shipped Runway nodes, giving an agent the node IDs and ports, wire-format field names (camelCase), per-node params, wiring/chaining rules, and capability boundaries — so an agent can configure and run all of them without reading the handler.

What it covers:
- **All 8 nodes** (`runway-video`, `runway-aleph`, `runway-image`, `runway-upscale`, `runway-act-two`, `runway-tts`, `runway-sts`, `runway-dubbing`) — per-model ratio/duration matrices, voice-preset lists, and dubbing language codes, all corrected to the real node enums (e.g. the image-ratio count fixed to the node's 11; the 2026-06 model refresh added Seedance 2.0 (+ Fast), HappyHorse 1.0, Aleph 2.0, Nano Banana Pro, and GPT Image 2).
- **The async submit/poll contract** and wire-format gotchas — the handler inlines local files as data URIs / external HTTPS (the stale `/v1/uploads` step was dropped).
- **Capability boundaries** — a note on what's exposed in Nebula vs. API-only (SFX, voice cloning, avatars, workflows have no node), so an agent doesn't promise a capability with no node behind it.

## Sources

- Runway API docs (landing): https://docs.dev.runwayml.com/
- Runway SDKs / endpoint mapping: https://docs.dev.runwayml.com/api-details/sdks/
- Official Runway Python SDK API manifest (authoritative endpoint + resource list): https://raw.githubusercontent.com/runwayml/sdk-python/main/api.md
- Runway Python SDK repository: https://github.com/runwayml/sdk-python

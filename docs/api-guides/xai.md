# xAI (Grok Imagine) in Nebula Nodes

> xAI's Grok Imagine API lets a Nebula user turn a text prompt (or a starting image) into a short generated video clip right on the canvas.

## What you can make

**Video** (this is what Nebula wires up)
- **Text-to-video** — describe a scene and get a short clip (1–15 seconds).
- **Image-to-video** — drop in a starting image and animate it ("bring a still to life").
- Control over **duration**, **aspect ratio** (7 options, from widescreen 16:9 to vertical 9:16), and **resolution** (480p or 720p).

**Everything else the Grok Imagine API can do — but Nebula does *not* expose yet**
- **Image generation** — text-to-image (Grok Imagine image models).
- **Image editing** — edit a source image with a natural-language prompt, including multi-image edits (combine up to 3 source images to merge subjects, transfer styles, compose scenes).
- **Reference-to-video** — guide a video with reference images without forcing the first frame.
- **Video editing** — restyle/modify an existing video with a prompt while keeping the scene.
- **Video extension** — continue an existing video from its last frame.
- **Voice / audio** (separate from Imagine, on the same xAI API key) — Realtime Voice, Text-to-Speech, and Speech-to-Text.
- **Text / chat** (Grok 4.x models) — chat completions, reasoning, function calling, live web/X search, structured outputs.

## Nodes available in Nebula (1)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Grok Imagine Video | `grok-imagine-video` | video-gen | `prompt` (Text, required); `image` (Image, optional) | `duration` (int, default 5, range 1–15 sec); `aspect_ratio` (enum, default `16:9` — `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3`); `resolution` (enum, default `480p` — `480p`, `720p`) | Generating a short clip from a text prompt, or animating a starting image (image-to-video) |

Output port: `video` (Video). Handler: `backend/handlers/grok_video.py`. Model sent to the API is fixed to `grok-imagine-video`.

## How to use it in Nebula

**Where the node lives.** Open the node palette/library and look under the **video generation** category. Drag **Grok Imagine Video** onto the canvas. It has one required text input (`prompt`), one optional image input (`image`), and one video output (`video`).

**API-key setup (one time).**
1. Get an xAI API key from the xAI console (the same key works for video, image, voice, and chat).
2. Open Nebula **Settings**, paste it into the **xAI** field (`XAI_API_KEY`), and choose **Save Settings**.
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

## API coverage — what Nebula uses vs. what xAI (Grok Imagine) offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text-to-video (`POST /v1/videos/generations`, poll `GET /v1/videos/{request_id}`) | Yes | full | The node's core path — prompt → clip. |
| Image-to-video (same endpoint + `image` param) | Yes | full | Wired via the optional `image` input port (URL or base64 data URI). |
| Video params: `duration`, `aspect_ratio` (7), `resolution` (480p/720p) | Yes | full | All exposed as node params with matching defaults. |
| Reference-to-video (`reference_images` array) | Yes | none | Distinct from `image` (guides without forcing the first frame). No input port for it. |
| Video editing (`POST /v1/videos/edits`) | Yes | none | Restyle an existing video with a prompt. No node. |
| Video extension (`POST /v1/videos/extensions`) | Yes | none | Continue a clip from its last frame. No node. |
| Image generation (`POST /v1/images/generations`) | Yes | none | Grok Imagine image models (`grok-imagine-image`, `grok-imagine-image-quality`). No node. |
| Image editing + multi-image (`POST /v1/images/edits`, up to 3 source images) | Yes | none | Combine subjects / transfer style / compose scenes. No node. |
| Text-to-Speech (`$15/1M chars`) | Yes | none | Voice/audio surface on the same key. No node. |
| Speech-to-Text | Yes | none | No node. |
| Realtime Voice | Yes | none | No node. |
| Chat / text completions (`POST /v1/chat/completions`, `POST /v1/responses`) | Yes | none | Grok 4.x text models, reasoning, function calling, live search, structured outputs. No node. |
| Deferred chat completion (`GET /v1/chat/deferred-completion/{id}`) | Yes | none | No node. |

Coverage: **~20%** of the xAI (Grok Imagine) API surface is exposed in Nebula. (Nebula uses 1 of the API's roughly dozen distinct capability families — only video generation, and within video only the text-to-video and image-to-video modes, are wired up.)

Notable unused capabilities: **image generation**, **image editing (incl. multi-image compositing)**, **reference-to-video**, **video editing**, **video extension**, and the entire **voice/audio stack (TTS, STT, Realtime Voice)** — all reachable with the same `XAI_API_KEY` but currently absent from the canvas.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/xai/SKILL.md` (new 2026-06-04). It covers the **1** xAI (Grok Imagine) video node, giving an agent the node identity, param contract, auth, async execution model, t2v/i2v recipes, and the known gaps.

What it covers:
- **Node identity** — the node ID `grok-imagine-video`, its category (`video-gen`), input ports (`prompt` required, `image` optional), and output port (`video`).
- **Param contract** — `duration` (1–15, default 5), `aspect_ratio` (the 7 enum values, default `16:9`), `resolution` (`480p`/`720p`, default `480p`), with the cost/speed tradeoffs.
- **Auth** — the `XAI_API_KEY` env var and the missing-key failure mode.
- **Execution model** — async submit-then-poll (`request_id` → `GET /v1/videos/{request_id}`, terminal `done`, plus `failed`/`expired`), with a ~15-min cap and realistic timeout expectations.
- **Recipes & prompting** — building text-to-video and image-to-video graphs, what makes a good motion prompt (scene + camera move + lighting), and that the model ID is fixed.
- **Known gaps** — reference-to-video, video edit/extend, image generation/editing, and the voice stack are *not* nodes, so an agent doesn't over-promise.

## Sources

- xAI API overview — https://docs.x.ai/docs/overview
- xAI API reference (chat / responses) — https://docs.x.ai/docs/api-reference
- Imagine overview (image + video + modes) — https://docs.x.ai/developers/model-capabilities/imagine
- Video generation (endpoints, params, modes, statuses) — https://docs.x.ai/developers/model-capabilities/video/generation
- Image generation & editing — https://docs.x.ai/docs/guides/image-generations
- Model catalog (model IDs, modalities, pricing) — https://docs.x.ai/docs/models

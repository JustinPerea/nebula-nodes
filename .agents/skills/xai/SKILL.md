---
name: xai
description: xAI (Grok Imagine) in Nebula — the grok-imagine-video node, plus the fal and Krea Grok Imagine copies (grok-imagine-image, grok-imagine-image-edit, krea-image-xai-grok-imagine-2/-edit, krea-video-xai-grok-video/-1-5) that run on xAI's own API when XAI_API_KEY is saved. Activate when the user configures any of those nodes or asks about xAI / Grok / Grok Imagine in Nebula. Sourced from the official xAI docs (docs.x.ai REST reference, Imagine guides, pricing) and docs/api-guides/xai.md on 2026-06-04 (direct routes added 2026-10-14).
---

# xAI (Grok Imagine) Skill

xAI's Grok Imagine API makes images and short video clips. One node runs on xAI only: **Grok Imagine Video** (`grok-imagine-video`, text-to-video and image-to-video). Six fal and Krea copies of Grok Imagine also run on xAI's own API when `XAI_API_KEY` is saved (see Direct routes below). Voice/audio and chat are reachable with the same key but are **not** Nebula nodes (see Capability boundaries).

## Direct routes (fal and Krea copies on your xAI key)

Since 2026-10-14 (`backend/execution/maker_routes_xai.py`, rule in `backend/services/node_route.py`):

| Node | Fallback | xAI model |
|---|---|---|
| `grok-imagine-image`, `grok-imagine-image-edit` | fal (`FAL_KEY`) | `grok-imagine-image` |
| `krea-image-xai-grok-imagine-2`, `-2-edit` | Krea (`KREA_API_TOKEN`) | `grok-imagine-image-2.0` |
| `krea-video-xai-grok-video` | Krea | `grok-imagine-video` |
| `krea-video-xai-grok-video-1-5` | Krea | `grok-imagine-video-1.5` |

Precedence: a Krea node on the Krea plan (`_kreaAuth: "mcp"`) stays there; else the xAI key runs it (billed by xAI); else the fal key / Krea token. Krea-only settings keep the run on Krea whether saved or wired: Grok 2.0's `style_images`, and `start_video` on both Krea video copies (Krea doesn't document what its start video does, so it isn't mapped to xAI's extensions endpoint). fal's `output_format` isn't sent to xAI (it has no format field and returns JPEG), so a fal recipe set to PNG or WebP stays on fal (`directRoute.accepts`). On the xAI route the Krea video copy picks `/v1/videos/edits` for `edit_video`, else generations (start image or up to 7 references, ≤10 s with references); unset duration/resolution send the Krea defaults (6 s, 720p). A duration that isn't whole seconds in 1-15, an edit with a start image or references, or a start image with references (saved or wired) stays on Krea (`directRoute.accepts` / `rejectsWhen`). Prices: docs/api-guides/xai.md.

## When to use

- User configures the `grok-imagine-video` node (display name: **Grok Imagine Video**).
- User wants a short generated video clip from a text prompt (text-to-video).
- User wants to animate a starting image — "bring a still to life" (image-to-video).
- User asks about xAI / Grok / Grok Imagine video inside Nebula, or about `duration`, `aspect_ratio`, or `resolution` for that node.
- User asks why some Grok capability (image gen, voice, video extend, reference images) isn't available — point them at Capability boundaries.

## Universal rules

1. **Auth.** `Authorization: Bearer <XAI_API_KEY>` header + `Content-Type: application/json`. Enter the key in Nebula **Settings → xAI** and save; it is persisted under `apiKeys.XAI_API_KEY` in project-root `settings.json` and takes effect without a restart. The same xAI key works for video, image, voice, and chat. Missing key → the node fails immediately with `XAI_API_KEY is required`.
2. **Base URL.** `https://api.x.ai/v1`. Submit endpoint: `POST /v1/videos/generations`. Poll endpoint: `GET /v1/videos/{request_id}`.
3. **Execution pattern: async submit-then-poll** (`executionPattern: "async-poll"` in the node def). Submit returns `{"request_id": "..."}`; the handler then polls `GET /v1/videos/{request_id}` every 3 s. A `ProgressEvent` advances the node's progress bar each poll. Terminal state `done` returns `{"status": "done", "video": {"url": "..."}}`, the MP4 is downloaded to the run dir, and the `video` port emits the local path. **Set expectations in minutes, not seconds.** The poll cap is 300 attempts × 3 s ≈ **15 minutes** before the handler raises `Grok timed out` (the guide's "up to a few minutes" is the typical case, not the ceiling).
4. **Model is fixed per node.** `grok-imagine-video` always sends `"model": "grok-imagine-video"`; each copy sends its own model (table above). There is no model param.
5. **Status / error codes.**
   - Submit must return `200`, `201`, or `202`; anything else raises `Grok submit failed (<status>): <body>`.
   - Submit response missing `request_id` raises `Grok returned unexpected response`.
   - Poll must return `200` or `202`; otherwise `Grok poll failed (<status>): <body>`.
   - Poll `status: "failed"` or `"expired"` raises `Grok failed: <error.message>`.
   - `status: "done"` with no `video.url` raises `Grok completed but no video URL` (or, when `respect_moderation` is false, says the video was filtered).
   - 401 on submit/poll → bad or missing `XAI_API_KEY`.
6. **Input-URI rules (the `image` port, for image-to-video).** The handler accepts either form:
   - Sent as an object, `body["image"] = {"url": ...}` (xAI's REST reference: "`url` (string) - Public URL or base64-encoded data URL of the image").
   - An `http://`/`https://` URL or `data:` URI goes as is.
   - A local file path (or served `/api/outputs/...` ref) is read and inlined as a base64 **data URI**; a missing or unsupported file (PNG, JPEG, WebP, GIF) fails the node. Wiring an upstream image node into the port is the normal flow and works automatically.
7. **Key gotchas.**
   - `prompt` is required even for image-to-video — an empty/missing prompt raises `Prompt is required`. For i2v, give it a short *motion* prompt (e.g. "gentle wind, the cape flutters, embers rise"), not a full scene description.
   - The `image` port is the **first-frame** image (i2v). It is **not** the API's `reference_images` (reference-to-video); for that use `krea-video-xai-grok-video`'s `reference_images` port.
   - 720p and longer durations cost more (per-second pricing). For cheap/fast drafts use `480p` + short `duration`.
   - Outputs are MP4. The downloaded clip lands in the run dir as `<hex>.mp4` and is served back to the canvas.

## Pick the right node

`grok-imagine-video` is the one node that runs only on xAI. Use it for text-to-video (prompt only) and image-to-video (prompt + image). For Grok images, references or video edits use the copies in Direct routes above.

| Node (display name) | Node ID | Category | Endpoint / Model | Key inputs | Key params |
|---|---|---|---|---|---|
| Grok Imagine Video | `grok-imagine-video` | `video-gen` | `POST https://api.x.ai/v1/videos/generations` · model fixed to `grok-imagine-video` | `prompt` (Text, **required**); `image` (Image, optional — first frame for i2v) | `duration` (int, 1–15, default 5); `aspect_ratio` (enum of 7, default `16:9`); `resolution` (`480p`/`720p`, default `480p`) |

Output port: `video` (Video) — a local MP4 path.

## Param reference

### `grok-imagine-video`

Inputs (ports):

| Port | Data type | Required | Notes |
|---|---|---|---|
| `prompt` | Text | yes | Scene + camera move + lighting for t2v; a short motion description for i2v. Required in both modes. |
| `image` | Image | no | Present → image-to-video (this image is the **first frame**). Absent → text-to-video. Accepts an http(s) URL or a local path (auto-converted to a base64 data URI). |

Params (set on the node):

| Param key | Type | Default | Range / Enum | Notes |
|---|---|---|---|---|
| `duration` | integer | `5` | `1`–`15` (seconds) | Longer = more cost/time. Only sent if set. |
| `aspect_ratio` | enum | `16:9` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` | 7 options, widescreen through vertical. Use `9:16` for reels/shorts. |
| `resolution` | enum | `480p` | `480p`, `720p` | `480p` = cheapest/fastest draft; `720p` costs more. |

Output (port):

| Port | Data type | Notes |
|---|---|---|
| `video` | Video | Local path to the downloaded `.mp4`. Renders inline on the canvas and can feed downstream video-consuming nodes. |

## Recipes

All recipes use the real node id `grok-imagine-video`.

1. **Text-to-video from scratch.**
   - Add a **Text** input node → type a prompt like *"a neon koi fish drifting through a rainy Tokyo alley at night, cinematic, slow dolly-in."*
   - Wire it into the `prompt` port of `grok-imagine-video`.
   - Set `duration` `8`, `aspect_ratio` `16:9`, `resolution` `720p`.
   - Run → the `video` output is an MP4 you can preview, download, or feed downstream. Expect a wait measured in minutes.

2. **Animate a generated image (image-to-video).**
   - Generate a still with any Nebula image node (e.g. a `gpt-image-2-*` node, a `gemini` image node, or a FAL image model).
   - Wire that node's image output into the `image` port of `grok-imagine-video`, and a short *motion* prompt into `prompt` (e.g. *"gentle wind, the cape flutters, embers rise"*).
   - Choose `aspect_ratio` `9:16` for a vertical/social clip. Run.
   - Note: the wired image becomes the **first frame** of the clip.

3. **Quick social-vertical draft (cheapest/fastest).**
   - **Text** node → prompt → `grok-imagine-video` with `aspect_ratio` `9:16`, `duration` `5`, `resolution` `480p`.
   - Use the resulting vertical `video` for a reel/short, then re-run at `720p` once the motion looks right.

## In the nebula_nodes context

- **Node id:** `grok-imagine-video` (category `video-gen`, `apiProvider: "xai"`).
- **Handler file:** `backend/handlers/grok_video.py` (`handle_grok_video`).
- **Auth env var:** `XAI_API_KEY` (`envKeyName` in the node def).
- **Endpoints:** submit `POST https://api.x.ai/v1/videos/generations`; poll `GET https://api.x.ai/v1/videos/{request_id}`.
- **Input ports:** `prompt` (Text, required), `image` (Image, optional → triggers i2v).
- **Output port:** `video` (Video, a local MP4 path).
- **Chaining rules.**
  - Feed `prompt` from a Text node (or any node whose output is Text).
  - Feed `image` from any upstream image node (gpt-image-2, gemini, FAL image, etc.) — the handler converts the resulting local path to a base64 data URI automatically; public http(s) URLs are passed through unchanged.
  - The `video` output can chain into any downstream node that consumes a Video.
- **How outputs render.** On `done`, the handler downloads `video.url` into the run dir (`<hex>.mp4`) and emits `{"video": {"type": "Video", "value": "<path>"}}`; the canvas plays the MP4 inline.

### Capability boundaries (what the Grok Imagine API can do that Nebula does NOT expose)

Do **not** promise these through Nebula; there is no node for them today:

- **Voice / audio** on the same key: Text-to-Speech, Speech-to-Text, Realtime Voice.
- **Text / chat** (Grok 4.x via `POST /v1/chat/completions` or `POST /v1/responses`).
- **`grok-imagine-video-1.5-lite`** (cheapest per second).
- **Grok 1.5's extra controls**: up to 14 reference images, voice references, `last_frame`, keyframes. The Krea 1.5 copy has no ports for them.
- **Model choice** on a node: each node is pinned to one Grok model.

Reference-to-video (7 refs) and video editing are reachable through `krea-video-xai-grok-video`; xAI's video extension (`/v1/videos/extensions`) has no node; image generation and editing through the four image copies.

## Sources

- Imagine overview (image + video + modes) — https://docs.x.ai/developers/model-capabilities/imagine
- Video generation (endpoints, params, modes, statuses) — https://docs.x.ai/developers/model-capabilities/video/generation
- Images REST reference — https://docs.x.ai/developers/rest-api-reference/inference/images
- Videos REST reference — https://docs.x.ai/developers/rest-api-reference/inference/videos
- Pricing (Imagine table) — https://docs.x.ai/developers/pricing
- Model catalog (model IDs, modalities, pricing) — https://docs.x.ai/docs/models
- xAI API overview — https://docs.x.ai/docs/overview
- Nebula audit guide — `docs/api-guides/xai.md`

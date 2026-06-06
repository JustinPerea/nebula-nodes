---
name: higgsfield
description: Higgsfield video generation in Nebula — text-to-video and image-to-video short cinematic clips via the DoP ("Depth of Presence") model plus Kling v2.1 Pro and Seedance v1 Pro guest models, with duration and aspect-ratio control. Activate when the user configures the `higgsfield` node or asks about Higgsfield in Nebula. The node is video-output only (no Soul images, Speak lipsync, or motion-camera presets are wired). Sourced 2026-06-04 from the official Higgsfield API docs (docs.higgsfield.ai) plus the Nebula audit guide docs/api-guides/higgsfield.md.
---

# Higgsfield Skill

## When to use

- User drags or configures the `higgsfield` node on the canvas.
- User wants a short cinematic video from a text prompt (text-to-video).
- User wants to animate a still image into motion (image-to-video).
- User asks which Higgsfield model to pick — DoP Standard vs. DoP Preview vs. Kling vs. Seedance.
- User asks about Higgsfield auth, the key:secret pairing, or why an image input isn't being used.
- User asks for Higgsfield features that Nebula does NOT expose (Soul text-to-image, Speak lipsync, motion/camera presets, character references) — answer from the Capability boundaries section so you don't over-promise.

## Universal rules

1. **Auth header.** `Authorization: Key {HIGGSFIELD_API_KEY}`. Env var is `HIGGSFIELD_API_KEY` in the backend `.env`. Restart the backend after adding it. Higgsfield issues credentials as a **key + secret pair**; the API expects `Key {key}:{secret}`. The handler does **not** split or recombine anything — it passes whatever you store verbatim after the literal `Key `. So if you have both, store the combined value `HIGGSFIELD_API_KEY=key:secret`; if you only have a single token, store it alone.
2. **Base URL.** `https://platform.higgsfield.ai` (this is the API host used by the handler and node `apiEndpoint`). Note the Higgsfield *dashboard* where you mint a key is `cloud.higgsfield.ai` — different host; don't confuse them.
3. **Execution pattern: async-poll** (confirmed in `backend/handlers/higgsfield.py`). The node submits the job, then polls every **3 seconds**, up to **300 polls** (~15 min wall-clock ceiling) before timing out. There is no streaming and no webhook — Nebula polls. Expect a minute or more for longer/higher-fidelity renders; this is normal, not a hang.
   - Submit: `POST {base}/{model_id}` with a JSON body → response `{"request_id": "...", "status": "queued", ...}`.
   - Poll: `GET {base}/requests/{request_id}/status` → `{"status": "...", ...}`.
   - On `completed`: response carries `video.url`; the handler downloads the MP4 into the run dir and returns it on the `video` port.
4. **Status / error handling** (from the poll loop):
   - `queued`, `in_progress` → keep polling.
   - `completed` → success; pull `video.url`. If completed but no URL, the handler raises.
   - `failed` / `error` → raises `Higgsfield failed: {error}`.
   - `nsfw` → raises "content policy violation". Reword the prompt.
   - `cancelled` → raises "generation was cancelled".
   - Submit HTTP codes: `200`/`201`/`202` accepted; anything else raises `Higgsfield submit failed`. A `401`/`403` here means the key (or key:secret) is wrong or missing.
5. **Input-URI rule (the big gotcha).** The optional `image` input is forwarded to the API as `image_url` **only if its value starts with `http://` or `https://`.** A bare local file path or data URI is **silently dropped** — the job runs as pure text-to-video with no warning. Always wire a node that emits a *hosted* image URL into the `image` port. The handler does **not** auto-upload local files (unlike the Meshy/Runway handlers, which convert local paths to data URIs).
6. **Key gotchas.**
   - `prompt` is **required** for every model, including the image-to-video ones — Kling/Seedance still need a motion prompt alongside the image.
   - DoP Standard and DoP Preview accept text alone *or* text + image. Kling v2.1 Pro and Seedance v1 Pro are **image-to-video only** — without a valid hosted `image` URL they have nothing to animate.
   - `model` must be one of the four known values; an unknown value raises before any network call.
   - `duration` is sent in seconds as an integer (1–15). Individual guest models may clamp to their own supported lengths server-side.
   - `aspect_ratio` passes straight through to the API.

## Pick the right node

Nebula exposes **one** Higgsfield node. The choice you make is the `model` param, not the node.

| Nebula node (id / display) | Model selected (`model` value) → endpoint | Capability | Key params |
|---|---|---|---|
| `higgsfield` / "Higgsfield" | `higgsfield-ai/dop/standard` → `POST /higgsfield-ai/dop/standard` (default) | Text-to-video **and** image-to-video, flagship DoP fidelity | `prompt` (req), `image` (opt URL), `duration` 1–15, `aspect_ratio` |
| `higgsfield` / "Higgsfield" | `higgsfield-ai/dop/preview` → `POST /higgsfield-ai/dop/preview` | T2V + I2V, faster/preview DoP for iteration | same as above |
| `higgsfield` / "Higgsfield" | `kling-video/v2.1/pro/image-to-video` → `POST /kling-video/v2.1/pro/image-to-video` | **Image-to-video only** (guest model) | `prompt` (req), `image` (req URL), `duration`, `aspect_ratio` |
| `higgsfield` / "Higgsfield" | `bytedance/seedance/v1/pro/image-to-video` → `POST /bytedance/seedance/v1/pro/image-to-video` | **Image-to-video only** (guest model) | `prompt` (req), `image` (req URL), `duration`, `aspect_ratio` |

Model picking guidance:
- **DoP Standard** — default; best quality; use for final renders and any pure text-to-video shot.
- **DoP Preview** — iterate quickly on prompt/camera/mood, then switch to DoP Standard for the final.
- **Kling v2.1 Pro / Seedance v1 Pro** — reach for these only when you have a real hosted image and want that model's specific motion character. Don't select them for a text-only graph; with no `image` URL they have nothing to work from.

## Param reference

Single node `higgsfield` (category `video-gen`). Ports and params are grounded in `backend/data/node_definitions.json` and the handler.

**Input ports**
- `prompt` — `Text`, **required**. The scene/motion description. Sent as `prompt`.
- `image` — `Image`, optional. Sent as `image_url` **only when it's an `http(s)` URL** (see rule 5). For Kling/Seedance this is effectively required.

**Output ports**
- `video` — `Video`. Local path to the downloaded `.mp4` after `completed`.

**Params**
| Param key | Type | Default | Range / enum | Notes |
|---|---|---|---|---|
| `model` | enum | `higgsfield-ai/dop/standard` | `higgsfield-ai/dop/standard` ("DoP Standard (T2V + I2V)") · `higgsfield-ai/dop/preview` ("DoP Preview") · `kling-video/v2.1/pro/image-to-video` ("Kling v2.1 Pro (I2V)") · `bytedance/seedance/v1/pro/image-to-video` ("Seedance v1 Pro (I2V)") | Selects the engine and the submit path. Unknown value → handler raises. |
| `duration` | integer | `5` | 1–15 (seconds) | Sent as `duration` int. Guest models may clamp server-side. |
| `aspect_ratio` | enum | `16:9` | `16:9` · `9:16` · `1:1` | Passed straight through. `9:16` for vertical/Reels, `1:1` for square. |

## Recipes

All recipes use the real node id `higgsfield`.

1. **Pure text-to-video (one node).** Drop a `higgsfield` node, leave `model` on DoP Standard, set `prompt` to e.g. *"slow dolly-in on a neon-lit Tokyo alley at night, rain, cinematic"*, `duration` 5, `aspect_ratio` 16:9, leave `image` empty. Run → one MP4 on the `video` port. No image input needed.

2. **Image → motion (animate a generated still).** Use an image node that emits a **hosted URL** — e.g. a `gemini` or `gpt-image-2` (FAL-backed) image node whose output is a public image URL — and wire that into the `higgsfield` node's `image` port. Switch `model` to **Kling v2.1 Pro (I2V)** or **Seedance v1 Pro (I2V)**, set `prompt` to the motion (*"camera orbits the subject, hair blowing in the wind"*), `aspect_ratio` 9:16. Confirm the upstream output is a URL, not a local path, or the image is silently dropped and you get a text-only render.

3. **Templated prompt from a Text node, fast then final.** Feed `prompt` from an upstream Text/LLM node so you can template or batch the scene description. Keep `image` empty. Set `model` to DoP Preview to iterate cheaply on wording and camera, then flip `model` to DoP Standard for the final high-fidelity render. Same node, same wiring — only the `model` param changes.

## In the nebula_nodes context

- **Node id:** `higgsfield`. **Display name:** "Higgsfield". **Category:** `video-gen` (same palette group as the other text/image-to-video generators).
- **Handler:** `backend/handlers/higgsfield.py` → `handle_higgsfield`. Model-path map `_MODEL_PATHS`, default `higgsfield-ai/dop/standard`. Base host constant `HIGGSFIELD_BASE = "https://platform.higgsfield.ai"`.
- **Node definition:** `backend/data/node_definitions.json` → key `higgsfield` (apiProvider `higgsfield`, executionPattern `async-poll`, envKeyName `HIGGSFIELD_API_KEY`).
- **Ports:** in `prompt` (Text, required) + `image` (Image, optional URL); out `video` (Video).
- **Chaining rules:**
  - Anything that emits text (Text/LLM node) → `prompt`.
  - Anything that emits a **hosted image URL** → `image`. A node emitting a local file path will be ignored by this handler (no auto-upload). Prefer an upstream node whose output is a public/served URL.
  - `video` output chains into any node that consumes `Video` (e.g. a downstream video-processing or save node).
- **How output renders:** on `completed`, the handler downloads the MP4 from `video.url` into the run dir and returns `{"video": {"type": "Video", "value": "<local path>"}}`. The canvas serves/plays it like any other video output.

### Capability boundaries (what Higgsfield's API can do that this node does NOT expose)

Do not promise these through the `higgsfield` node — none are wired (from the audit gap table in `docs/api-guides/higgsfield.md`; roughly ~25% of the Higgsfield API surface is exposed, video/I2V only):

- **Motion / camera presets** (`getMotions()`, motion-id + strength) — DoP's signature 50+ camera-move recipes are **not** surfaced. Camera motion is **prompt-only** in Nebula.
- **Soul text-to-image** (`higgsfield-ai/soul/standard`, `reve/text-to-image`) — Higgsfield's flagship image model is not wired; Nebula uses other providers for images.
- **Soul styles & SoulID character references** (`getSoulStyles()`, `createSoulId()`, `style_id`/`style_strength`, `custom_reference_id`) — no style presets or character-consistency controls.
- **Soul quality / size / batch / seed** (`SoulQuality`, `SoulSize`, `BatchSize`, `seed`) — no image-side params.
- **Speak** — audio-driven talking-head / lipsync video (`/v1/speak/higgsfield`, image + audio → lipsync). Not exposed.
- **Request cancellation** (`POST /requests/{id}/cancel`) — the submit response includes a `cancel_url`. As of 2026-06-05, a poll cancellation fires a best-effort POST to that `cancel_url` so the in-flight job stops upstream instead of running to completion (skipped if the submit response carried no `cancel_url`).
- **Direct image upload** (`uploadImage` / `upload`) — the node only accepts an existing `http(s)` image URL; it cannot upload a local file.
- **Webhook delivery** (`hf_webhook` / `webhook_url`) — Nebula polls instead (expected for this architecture).
- **Broader model catalog** — the same `POST /{model_id}` pattern can reach any model at `cloud.higgsfield.ai/explore`, but Nebula hard-codes only the 4 models above.

If the user needs any of these, the honest answer is: the Higgsfield node is **video-only** (text/image-to-video). They'd need a different Nebula node for images/audio, or the node/handler would have to be extended.

## Sources

- Audit guide (primary, grounded + cited): `docs/api-guides/higgsfield.md`
- https://docs.higgsfield.ai/docs/how-to/introduction.md — API overview, `Authorization: Key` auth header, submit/status/cancel endpoints
- https://docs.higgsfield.ai/docs/guides/video.md — DoP / Kling / Seedance video model paths and request params
- https://docs.higgsfield.ai/docs/how-to/webhooks.md — status endpoint + completed response shape (`video.url`)
- https://docs.higgsfield.ai/docs/how-to/sdk.md — Python SDK methods, status values, Soul params
- https://docs.higgsfield.ai/docs/guides/images.md — Soul / reve text-to-image (not wired in Nebula)
- https://github.com/higgsfield-ai/higgsfield-js — official SDK (motion presets, SoulID, Speak, upload helpers — all unexposed here)

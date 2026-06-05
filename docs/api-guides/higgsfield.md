# Higgsfield in Nebula Nodes

> Higgsfield turns a text prompt (and optionally a starting image) into a short cinematic video clip right on your Nebula canvas.

## What you can make

- **Video from text** — describe a scene and get a 1–15 second clip using Higgsfield's flagship DoP ("Depth of Presence") model. Set the camera move, mood, and motion through the prompt.
- **Video from an image** — feed in a still image and animate it into motion. DoP, plus two guest models (Kling v2.1 Pro and Seedance v1 Pro), turn a single frame into a moving shot.
- **Aspect ratio control** — render widescreen (16:9), vertical/Reels (9:16), or square (1:1) so the clip is ready for the platform you're targeting.

Everything in Nebula's Higgsfield node is **video output**. Higgsfield's broader platform also does text-to-image (Soul), audio-driven talking-head video (Speak), motion/camera presets, and character references — none of those are wired into Nebula yet (see the coverage section below).

## Nodes available in Nebula (1)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Higgsfield | `higgsfield` | video-gen | `prompt` (Text, required), `image` (Image, optional) | `model` (DoP Standard / DoP Preview / Kling v2.1 Pro / Seedance v1 Pro), `duration` (1–15s, default 5), `aspect_ratio` (16:9 / 9:16 / 1:1) | Generating a short cinematic video from a text prompt and/or a starting image |

Notes on the params, grounded in the node definition and handler:

- **`model`** picks which engine runs. `higgsfield-ai/dop/standard` (the default) and `higgsfield-ai/dop/preview` accept text alone *or* text + image. `kling-video/v2.1/pro/image-to-video` and `bytedance/seedance/v1/pro/image-to-video` are image-to-video only — give them an `image` for best results.
- **`image`** input is optional. The handler only forwards it when it's an `http(s)` URL (it's sent as `image_url`). Wire a node that outputs a hosted image URL into this port; a bare local file path is ignored.
- **`duration`** is sent in seconds. The node allows 1–15; individual guest models may clamp to their own supported lengths.
- **`aspect_ratio`** is passed straight through to the API.

## How to use it in Nebula

**Where it appears:** The Higgsfield node lives in the **video-gen** category of the node palette — the same group as the other text/image-to-video generators. Drag it onto the canvas like any other node.

**API-key setup:** Higgsfield runs on your own key.

1. Get a key from the Higgsfield dashboard (`cloud.higgsfield.ai`).
2. Add it to your backend `.env` file:
   ```
   HIGGSFIELD_API_KEY=your_key_here
   ```
   Higgsfield issues credentials as a **key + secret pair**. The API authenticates with the header `Authorization: Key {key}:{secret}`. If you were issued both, set the combined value (`HIGGSFIELD_API_KEY=key:secret`) — the handler passes whatever you store straight through after `Key `. If you only have a single token, store it alone.
3. Restart the backend so the new env var is picked up.

The node submits the job, then polls until the clip is ready (it can take a minute or more for longer/higher-fidelity models) and saves the finished `.mp4` as the node's `video` output.

**Example pipelines:**

1. **Pure text-to-video (one node).** Drop a `higgsfield` node, leave `model` on DoP Standard, type a prompt like *"slow dolly-in on a neon-lit Tokyo alley at night, rain, cinematic"*, set `duration` to 5 and `aspect_ratio` to 16:9. Run it — you get a clip with no image input needed.

2. **Image → motion (animate a generated still).** Use an image generator node (e.g. a `gemini` or `gpt-image-2` image node) that produces a hosted image URL, wire its image output into the `higgsfield` node's `image` port, switch `model` to **Kling v2.1 Pro (I2V)** or **Seedance v1 Pro (I2V)**, and prompt the motion (*"camera orbits the subject, hair blowing in the wind"*). Set `aspect_ratio` to 9:16 for a vertical Reel.

3. **Prompt-driven shot from a Text node.** Feed a `prompt` from an upstream Text/LLM node (so you can template or batch the scene description), keep `image` empty, use DoP Preview to iterate quickly, then swap to DoP Standard for the final, higher-fidelity render.

## API coverage — what Nebula uses vs. what Higgsfield offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Image-to-video — DoP (`higgsfield-ai/dop/standard`, `/preview`) | Yes | full | Default model in the node; T2V and I2V both supported |
| Text-to-video — DoP | Yes | full | Node sends `prompt` with no required image; DoP accepts it |
| Image-to-video — Kling v2.1 Pro (`kling-video/v2.1/pro/image-to-video`) | Yes | full | Selectable via `model` enum |
| Image-to-video — Seedance v1 Pro (`bytedance/seedance/v1/pro/image-to-video`) | Yes | full | Selectable via `model` enum |
| `duration` / `aspect_ratio` controls | Yes | full | Both exposed as params |
| Submit / poll status / save output (`POST /{model_id}`, `GET /requests/{id}/status`) | Yes | full | Async-poll lifecycle implemented in the handler |
| Cancel request (`POST /requests/{id}/cancel`) | Yes | none | API returns a `cancel_url`; Nebula never calls it |
| Motion / camera presets (`getMotions()`, motion-id + strength) | Yes | none | DoP's signature 50+ camera-move recipes aren't surfaced; motion is prompt-only in Nebula |
| Text-to-image — Soul (`higgsfield-ai/soul/standard`, `reve/text-to-image`) | Yes | none | Flagship image model; not wired (Nebula uses other providers for images) |
| Soul styles & SoulID character references (`getSoulStyles()`, `createSoulId()`, `style_id`/`style_strength`, `custom_reference_id`) | Yes | none | Style presets and character consistency unused |
| Soul quality / size / batch (`SoulQuality`, `SoulSize`, `BatchSize`, `seed`) | Yes | none | No image-side params exposed |
| Speak — audio-driven talking-head video (`/v1/speak/higgsfield`) | Yes | none | Image + audio → lipsync video; not exposed |
| Webhook delivery (`hf_webhook` / `webhook_url`) | Yes | none | Nebula polls instead of using webhooks (expected for this architecture) |
| Direct asset upload (`uploadImage` / `upload`) | Yes | none | Node only accepts an existing `http(s)` image URL; no upload of local files |
| Broader model catalog ("many more" at `cloud.higgsfield.ai/explore`) | Yes | partial | The same `POST /{model_id}` pattern can reach any catalog model; Nebula hard-codes 4 |

**Coverage: ~25% of the Higgsfield API surface is exposed in Nebula.** (Nebula covers the video/I2V slice well — DoP + 2 guest models, duration, aspect ratio, full async lifecycle — but none of the image, audio/Speak, motion-preset, character-reference, or cancel/upload surface.)

**Notable unused capabilities:** DoP **motion/camera presets** (`getMotions()` — Higgsfield's headline feature), the **Soul** text-to-image family with **SoulID** character references and style presets, the **Speak** audio-driven lipsync video model, request **cancellation**, direct **image upload**, and the long tail of additional models in the catalog.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/higgsfield/SKILL.md` (new 2026-06-04). It covers the **1** Higgsfield video node, giving an agent the node contract, model selection, the image-URL gotcha, pipeline recipes, auth setup, latency/failure expectations, and the video-only boundary.

What it covers:

- **The single node and its contract** — node ID `higgsfield`, input ports `prompt` (required) + `image` (optional, must be an `http(s)` URL), output port `video`, and the param schema (`model` enum, `duration` 1–15, `aspect_ratio` enum).
- **Model selection guidance** — DoP Standard vs. Preview (quality vs. speed), and that Kling/Seedance are image-to-video only so they need a real image URL.
- **The image-URL gotcha** — the handler silently drops non-URL image inputs, so route a *hosted* image into the `image` port (chain an upstream node that emits a URL), not a local path.
- **Pipeline recipes** — text-to-video single-node, image→motion two-node chains, and templated-prompt chains, all with real node IDs.
- **Auth setup** — `HIGGSFIELD_API_KEY` in `.env`, the `Authorization: Key {key}:{secret}` pairing on `platform.higgsfield.ai`, and the restart step.
- **Expectations & boundaries** — async-poll latency (a minute+) and the failure/`nsfw`/`cancelled` states; the node is **video only**, so Soul images, Speak audio, and motion presets are not reachable.

## Sources

- https://docs.higgsfield.ai/docs/llms.txt — documentation index
- https://docs.higgsfield.ai/docs/llms-full.txt — full documentation dump (model IDs, endpoints, params, statuses, auth)
- https://docs.higgsfield.ai/docs/how-to/introduction.md — API overview, auth header, submit/status/cancel endpoints
- https://docs.higgsfield.ai/docs/how-to/sdk.md — Python SDK methods, status values, Soul params
- https://docs.higgsfield.ai/docs/how-to/webhooks.md — status endpoint + completed response shapes (`images[].url`, `video.url`)
- https://docs.higgsfield.ai/docs/guides/video.md — DoP/Kling/Seedance video model paths and request params
- https://docs.higgsfield.ai/docs/guides/images.md — Soul / reve text-to-image models and params
- https://github.com/higgsfield-ai/higgsfield-js — official JS/TS SDK (DoP motion presets, Soul styles/SoulID, Speak lipsync, upload helpers)
- https://higgsfield.ai/ — product overview

# Replicate in Nebula Nodes

> Replicate is a universal gateway node: type any `owner/name` model slug and Nebula runs that model for you — images, video, audio, 3D, or text — all from one node, with one API key.

## What you can make

Replicate hosts thousands of community and official models. Because the Nebula node is a passthrough gateway (you supply the model slug and its inputs), what you can make is essentially "anything on replicate.com." Grouped by media type, the common cases are:

- **Images** — text-to-image (e.g. `stability-ai/sdxl`, `black-forest-labs/flux-schnell`), image editing / inpainting, upscaling, background removal, style transfer.
- **Video** — text-to-video and image-to-video (e.g. Stable Video Diffusion and similar), frame interpolation, video upscaling.
- **Audio** — music and sound generation, text-to-speech, transcription / speech-to-text (e.g. Whisper-family models), audio separation.
- **3D** — image-to-3D and text-to-3D mesh generators.
- **Text** — open language models for chat, summarization, captioning, and structured extraction.

The single Nebula node reaches all of these — the only thing that changes between them is the model slug you type and the inputs you connect.

## Nodes available in Nebula (1)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Replicate | `replicate-universal` | universal (async-poll) | None pre-defined — connected input ports are passed straight through to the model's `input` (port name = model input field) | `model_id` (required, format `owner/name`, e.g. `stability-ai/sdxl`) | Running any Replicate-hosted model — image, video, audio, 3D, or text — by typing its `owner/name` slug |

Notes grounded in `backend/data/node_definitions.json` and `backend/handlers/replicate_universal.py`:

- The node ships with **no fixed input or output ports** (`inputPorts: []`, `outputPorts: []`). The handler infers the output type at runtime from the model's result — a URL ending in `.png/.jpg/.webp/.gif` becomes an **Image** port, `.mp4/.mov/.webm` a **Video** port, `.mp3/.wav/.flac` an **Audio** port, a plain string becomes a **Text** port, and a list of URLs returns its first item as an Image.
- The only declared param is **`model_id`**. Any other parameters the model needs (prompt, seed, width, etc.) are passed through generically: the handler forwards every connected input port and every extra param into the prediction's `input` object verbatim. There is no per-model schema baked into the node.
- Internally the handler also reads two private params if present (`_version_id`, `_schema_fetched`); these are implementation details, not user-facing controls.

## How to use it in Nebula

**Where it appears:** the Replicate node lives under the **"universal"** node category on the canvas (category `universal` in the registry). Drag it onto the canvas like any other provider node.

**API-key setup:** Replicate authenticates with a personal API token.

1. Create a token at <https://replicate.com/account/api-tokens>.
2. Open Nebula **Settings**, paste it into the **Replicate** field (`REPLICATE_API_TOKEN`), and choose **Save Settings**.
3. Nebula stores it under `apiKeys.REPLICATE_API_TOKEN` in the project-root `settings.json`; no restart is required. The handler will refuse to run with a clear error if the token is missing.

**Before you run a model:** open the model's page on replicate.com (e.g. <https://replicate.com/stability-ai/sdxl>) and look at its **Inputs** section. Those field names (`prompt`, `width`, `negative_prompt`, `image`, …) are exactly the names you give the node's input ports / params, because Nebula forwards them unchanged. File inputs (like an `image` field) are passed as URLs or data URLs.

**Example recipes** (all reference the real node ID `replicate-universal`):

1. **Text-to-image (single node).** Drop a `replicate-universal` node, set `model_id` = `black-forest-labs/flux-schnell`, add a `prompt` input (e.g. "a neon crab on a beach at dusk"). Run it — the node returns an Image output you can preview or download.

2. **Image-to-video chain.** First `replicate-universal` node with `model_id` = a text-to-image model produces an Image. Wire its Image output into a second `replicate-universal` node whose `model_id` is an image-to-video model, mapping the Image into that model's image input field (e.g. `input_image`). The second node returns a Video output. (Nebula passes the upstream image URL straight into the downstream model's input.)

3. **Transcribe then summarize.** A `replicate-universal` node with `model_id` = a Whisper-family speech-to-text model takes an `audio` URL and returns Text. Feed that Text into a second model (e.g. an open LLM slug) to summarize. Two gateway nodes, no custom wiring.

## API coverage — what Nebula uses vs. what Replicate offers

Replicate's HTTP API surface is large; the Nebula node deliberately uses only the minimum needed to run a model and read its result. "In Nebula" is rated full / partial / none.

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Create prediction — `POST /v1/predictions` (`{version, input}`) | Yes | **full** | Core path. Handler submits `{version, input}` and the API returns the prediction. |
| Get / poll prediction — `GET /v1/predictions/{id}` | Yes | **full** | Polled every 2s, up to 300 times (~10 min cap), on statuses `starting`/`processing` until `succeeded`/`failed`/`canceled`. |
| Resolve model version — `GET /v1/models/{owner}/{name}` | Yes | **full** | Used internally to turn `owner/name` into the version hash the create call needs. |
| Official-model predictions — `POST /v1/models/{owner}/{name}/predictions` | Yes | **none** | Nebula always resolves a version and uses the generic `/v1/predictions` route instead of this convenience route. |
| Synchronous mode — `Prefer: wait` header | Yes | **none** | Handler always polls; it never asks the API to hold the request open. |
| Streaming output — SSE via `urls.stream` | Yes | **full when advertised** | Auto-detected: when the created prediction returns `urls.stream`, the handler consumes it for any output family. Ordinary text emits live canvas deltas. Possible media data-URI prefixes stay private until classified; recognized media is buffered without base64 telemetry, then typed and materialized at completion. |
| Webhooks + `webhook_events_filter` (`start`/`output`/`logs`/`completed`) | Yes | **none** | No webhook is registered; completion is detected purely by polling. |
| Cancel prediction — `POST /v1/predictions/{id}/cancel` | Yes | **full** | Cancelling a run fires a best-effort `POST .../cancel` upstream (both the polling and streaming paths) so a cancelled prediction stops billing. |
| `Cancel-After` runtime cap header | Yes | **none** | Not sent. |
| List predictions — `GET /v1/predictions` | Yes | **none** | No history/listing in the node. |
| File upload — `POST /v1/files` (and URL / data-URL input files) | Yes | **none** | Nebula forwards input values as-is; it never uploads to the Files API. Users must supply file inputs as URLs/data URLs themselves. |
| Deployments + deployment predictions — `/v1/deployments…` | Yes | **none** | Private/auto-scaling deployments aren't reachable from the node. |
| Trainings / fine-tuning — `/v1/…/trainings`, `GET /v1/trainings/{id}` | Yes | **none** | No fine-tune create/poll/cancel. |
| Model search / list / collections — `QUERY /v1/models`, `GET /v1/models`, `/v1/collections`, `GET /v1/search` | Yes | **none** | No in-app model discovery; the user must already know the slug. |
| Model versions list / examples / readme | Yes | **none** | Only the latest version is read; no version picker, examples, or readme surfaced. |
| Hardware list — `GET /v1/hardware` | Yes | **none** | Not used. |
| Account info — `GET /v1/account` | Yes | **none** | Not used. |
| Webhook signing secret — `GET /v1/webhooks/default/secret` | Yes | **none** | N/A — no webhooks. |

**Coverage: ~30% of the Replicate API surface is exposed in Nebula.** (Five of ~16 capability areas are wired — create, poll, version-resolve, **advertised streaming**, and **cancel** — covering the run-a-model happy path, live text streaming, private media-stream buffering, and upstream cancellation, but none of the webhook/deployment/training/discovery surface.)

**Notable unused capabilities:** **synchronous `Prefer: wait`** mode (would cut latency for fast models vs. 2s-interval polling); **webhooks** for completion callbacks; the **`Cancel-After`** runtime-cap header; the **Files API** (`POST /v1/files`) for direct input uploads; **deployments** (private, auto-scaling endpoints); **trainings / fine-tuning**; and **model search / collections** for in-app discovery instead of hand-typing slugs. *(Real-time streaming and prediction cancellation are now wired — 2026-06-08.)*

## Agent skill coverage

**A complete skill exists** at `.claude/skills/replicate/SKILL.md` (new 2026-06-04). It covers the **1** universal Replicate node, giving an agent auth/setup, the passthrough node contract, per-model input discovery, output-type inference, execution expectations, and the gaps to route around.

What it covers:

- **Auth & setup** — that `REPLICATE_API_TOKEN` must be set in the backend env, how to obtain it, and the missing-key failure mode.
- **The single node contract** — `replicate-universal` has exactly one required param (`model_id`, `owner/name` format) and **no fixed ports**; every other model input is passed through by name. (The non-obvious bit an agent must understand to build a working graph.)
- **Per-model input discovery** — how to look up a model's input field names (model page / API) and map graph ports to those exact names, plus a recommended default-slug cheat-sheet per media type (image / video / audio / 3D / text).
- **Output-type inference rules** — how the handler decides Image vs. Video vs. Audio vs. Text from the result (URL extension or string/list shape).
- **Execution expectations** — predictions without `urls.stream` async-poll to the ~10-minute 300 × 2s ceiling; advertised streams are consumed for every output family. Text renders live `streamingText`; media data URIs are buffered privately and materialized only at completion. **Cancellation propagates upstream**; polled media progress is status-only.
- **Known gaps to route around** — no Files API upload (supply file inputs as URLs/data URLs), no fine-tuning, no deployments, no in-app model search.

## Sources

- Replicate HTTP API reference — <https://replicate.com/docs/reference/http>
- Predictions (create / get / streaming) — <https://replicate.com/docs/topics/predictions>, <https://replicate.com/docs/topics/predictions/streaming>, <https://replicate.com/docs/topics/predictions/create-a-prediction>
- Input files (URL / data URL guidance) — <https://replicate.com/docs/topics/predictions/input-files>
- Files API (`POST /v1/files`) — <https://sdks.replicate.com/python/resources/files/>
- API tokens — <https://replicate.com/account/api-tokens>
- Existing developer audit (not duplicated here) — `docs/model-providers/replicate-openrouter-nous/universal.md`

# OpenRouter in Nebula Nodes

> OpenRouter is a universal gateway node: pick from hundreds of AI models (GPT, Claude, Gemini, Llama, FLUX, and more) through one node — chat with them, ask questions about images, or generate images, all without leaving the canvas.

## What you can make

OpenRouter is a *gateway* — a single node that can reach many downstream models. What it produces depends entirely on the model you pick from the dropdown:

- **Text** — chat completions, writing, summaries, code, reasoning, Q&A. Any text model on OpenRouter (GPT, Claude, Gemini, Llama, DeepSeek, Mistral, Qwen, and so on). Output streams in live as it generates.
- **Text from images (vision)** — feed an image in and ask a question about it ("describe this", "read this receipt", "what's wrong with this UI"). Works with any vision-capable model (e.g. Gemini, GPT vision, Claude vision).
- **Images** — generate pictures from a prompt when you pick an image-output model (e.g. Google Gemini Flash Image, FLUX, Recraft). The node automatically grows an Image output port when you choose one of these.

The node adapts to the model: choose a text model and you get a text node; choose a vision model and an **Images** input appears; choose an image model and an **Image** output appears.

## Nodes available in Nebula (1)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| OpenRouter | `openrouter-universal` | Universal gateway (`category: universal`) | `messages` (Text, required); `images` (Image, multiple) appears automatically when you pick a vision/image model | `model` (required — chosen from a live, searchable model list); `temperature` (0–2, default 1); `max_tokens` (1–200000, default 4096); `response_format` (Text / JSON — JSON mode for text models, 2026-06-05) | One node for the whole OpenRouter catalog: chat/reasoning/coding with any text model, asking questions about images, or generating images — depending on the model picked |

Notes that matter for using the node:
- The **model list is loaded live** from your account (the backend proxies OpenRouter's `/api/v1/models` and caches it for 5 minutes), so the dropdown reflects whatever models OpenRouter currently offers — you are not limited to a hardcoded list. Use the search box in the Inspector to filter.
- **Ports change with the model.** Picking a model with image *input* adds an `images` input port; picking a model with image *output* adds an `image` output port. This is driven by the model's declared modalities, so you don't configure it by hand.
- `temperature` and `max_tokens` only apply to text generation. Image generation ignores them.
- **JSON mode** (added 2026-06-05): set `response_format` to JSON and the handler forwards `response_format: {"type":"json_object"}` for text models, so the reply is valid JSON. It's **model-dependent** — the chosen model must support JSON output. Live-verified against the OpenRouter API.

## How to use it in Nebula

**Where the node lives.** The OpenRouter node is in the **Universal** category of the node palette (it sits alongside the other gateway nodes like Replicate and Nous Portal). Drag it onto the canvas like any other node.

**API-key setup.** OpenRouter needs one key:

1. Create a key at <https://openrouter.ai/keys> (it looks like `sk-or-...`).
2. Open Nebula **Settings**, paste it into the **OpenRouter** field (`OPENROUTER_API_KEY`), and choose **Save Settings**. Nebula stores it under `apiKeys.OPENROUTER_API_KEY` in the project-root `settings.json`; no restart is required.
3. The key is required both to **run** the node and to **load the model dropdown** — until it's set, the model picker can't populate.

**Pick a model.** Select the node, open the **Inspector**, and choose a model from the searchable list. The node reconfigures its ports based on what that model can do. Then wire a Text source into `messages` and run.

### Recipe 1 — Ask a model a question (text)
1. Add a **Text** input node with your prompt (e.g. "Explain quantum entanglement in one paragraph").
2. Add an **OpenRouter** node (`openrouter-universal`); pick a text model in the Inspector.
3. Wire the Text node → `messages`. Optionally lower `temperature` (e.g. 0.3) for a more focused answer.
4. Run. The reply streams into the `text` output, which you can chain into any node that takes Text.

### Recipe 2 — Describe or analyze an image (vision)
1. Add an **OpenRouter** node and pick a **vision** model (one that lists `image` as an input modality). An **Images** input port appears.
2. Wire an image source (an upstream image-generation node, or an image file) into `images`, and a Text node with your question ("What's in this photo?") into `messages`.
3. Run. The model's description comes out of `text`.

### Recipe 3 — Generate an image (image output)
1. Add an **OpenRouter** node and pick an **image-output** model (e.g. a Gemini Flash Image or FLUX variant — one that lists `image` as an output modality). An **Image** output port appears and the node switches to image mode.
2. Wire a Text node with your prompt ("a neon-lit crab on a beach at dusk, cinematic") into `messages`.
3. Run. The generated picture lands on the `image` output (saved as a PNG in the run directory), ready to feed into an upscaler, a video node, or a save node.

## API coverage — what Nebula uses vs. what OpenRouter offers

OpenRouter is a large unified API. Nebula wires up the core chat-completions surface (text, vision input, image output) plus the model-list endpoint. Most of the surrounding API surface is not exposed.

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| `POST /api/v1/chat/completions` — text generation | Yes | full | Core path. Streams via SSE (`delta_path=choices.0.delta.content`). |
| Streaming responses (SSE) | Yes | full | Text output streams token-by-token into the node. |
| Image **input** (vision) — `image_url` content parts | Yes | full | Auto-adds an `images` port for vision models; supports URLs, data URIs, and local files (base64-encoded by the handler). |
| Image **output** — `modalities: ["text","image"]` + `image_config` | Yes | partial | Nebula sends `modalities: ["text","image"]` and reads `choices[0].message.images[]`. It does **not** expose `image_config` (aspect ratio, image_size, style, strength, etc.) — you get the model's defaults. |
| `GET /api/v1/models` — list models | Yes | partial | Used to populate the dropdown; the backend slims the payload to id/name/modalities/context/pricing and ignores filters like `category` / `supported_parameters`. |
| Core sampling params (`temperature`, `max_tokens`) | Yes | partial | Only `temperature` and `max_tokens` are surfaced. `top_p`, `top_k`, `seed`, `stop`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `min_p`, `logit_bias`, etc. are not. |
| Tool / function calling (`tools`, `tool_choice`, `parallel_tool_calls`) | Yes | none | OpenAI-compatible function calling is fully supported by the API; the node never sends `tools`. |
| Structured outputs (`response_format`: json_object / json_schema / grammar) | Yes | partial | **JSON mode now supported** (2026-06-05, live-verified) — the `response_format` param (Text / JSON) makes the handler forward `response_format: {"type":"json_object"}` for text models (model-dependent). `json_schema` / grammar constraints still not exposed. |
| Reasoning controls (`reasoning`, `reasoning_effort`) | Yes | none | Reasoning-model effort/summary controls are not exposed. |
| Audio **input** — `input_audio` content parts | Yes | none | Handler only builds `text` and `image_url` content parts. |
| Audio **output** — `modalities: ["audio"]` | Yes | none | Not requested; no audio output port exists. |
| Video / PDF (`file`) **input** — `file` / `video_url` content parts | Yes | none | Document and video inputs are not wired. |
| Provider routing & fallbacks (`provider`, `models`, `route`) | Yes | none | Can't pin/exclude providers, set price/latency preferences, or define model fallback chains. |
| Web search server tool (`openrouter:web_search`, formerly `plugins`/`:online`) | Yes | none | No web-grounded answers from the node. |
| Prompt caching (`cache_control`) | Yes | none | Anthropic-style cache breakpoints not set. |
| Other `plugins` (file-parser, moderation, web-fetch, routers) | Yes | none | None of the plugin ecosystem is surfaced. |
| Embeddings — `POST /api/v1/embeddings` | Yes | none | Separate endpoint; not wired (no embeddings node). |
| Completions (legacy `prompt`) — `POST /api/v1/completions` | Yes | none | Nebula only uses the chat-completions shape. |
| Generation stats — `GET /api/v1/generation?id=` | Yes | none | Cost/token accounting per generation not fetched. |
| Credits / key info endpoints | Yes | none | Not used. |

**Coverage: ~30% of the OpenRouter API surface is exposed in Nebula.** (The high-traffic core — text chat, streaming, vision input, and basic image generation — is covered; the long tail of advanced controls and side endpoints is not.)

**Notable unused capabilities:** tool/function calling, strict `json_schema` / grammar structured outputs (basic `json_object` JSON mode *is* now wired — see above), reasoning-effort controls, audio input *and* output, PDF/document and video input, provider routing & model fallbacks, the web-search server tool, prompt caching, `image_config` for image generation (aspect ratio / size / style), embeddings, and the generation-stats endpoint.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/openrouter/SKILL.md` (new 2026-06-04). It covers the **1** universal OpenRouter node, giving an agent the node identity/wiring, the model-picker contract, param semantics, auth, the canonical recipes, and the limits not to over-promise.

What it covers:
- **Node identity & wiring** — the single node `openrouter-universal`, its `messages` input, the dynamic `images` input / `image` output ports, and the `text` output.
- **The model-picker contract** — `model` is required, comes from the live model list, and the chosen model's modalities drive the ports and the auto-set image flag (so an agent picks a model whose modalities match text vs. vision-in vs. image-out).
- **Params** — `temperature` (0–2) and `max_tokens` (1–200000) apply to text only; image generation ignores them.
- **Auth** — `OPENROUTER_API_KEY` must be set in Settings both to run *and* to load the model list; plus the real `X-OpenRouter-Title` header (not the legacy `X-Title`).
- **Recipes** — the three canonical flows (text chat, vision Q&A, image generation) with real port names.
- **Capability boundaries** — JSON mode (`response_format`) is now wired for text models, but no tool calling, no strict `json_schema`/grammar, no audio/PDF/video, no provider routing, no `image_config` controls, no web search.

## Sources

- OpenRouter Quickstart — <https://openrouter.ai/docs/quickstart>
- API Reference overview (request schema, output modalities) — <https://openrouter.ai/docs/api/reference/overview>
- Create a chat completion (full parameter & content-part list) — <https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>
- List all models and their properties (modality filters, model object fields) — <https://openrouter.ai/docs/api/api-reference/models/get-models>
- Image generation (modalities, image_config, `message.images[]` response shape) — <https://openrouter.ai/docs/guides/overview/multimodal/image-generation>
- Tool calling — <https://openrouter.ai/docs/guides/features/tool-calling>
- Create embeddings — <https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings>
- Web Search server tool — <https://openrouter.ai/docs/guides/features/server-tools/web-search>

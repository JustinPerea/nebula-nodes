---
name: nous
description: Nous Portal (Hermes) provider in Nebula — a single universal text/reasoning LLM node backed by Nous Research's open-weight Hermes models (Hermes-4.3-36B, Hermes-4-70B, Hermes-4-405B, all 128k context), OpenAI-compatible SSE streaming, long-context drafting/summarization/chain-of-thought. Unusual auth — NO env var; the handler reads an OAuth Bearer from ~/.hermes/auth.json. Text-only — no tools, no JSON mode, no Tool Gateway. Activate when the user configures the `nous-portal-universal` node or asks about Nous Portal / Hermes in Nebula. Sourced 2026-06-04 from the Nous Portal API docs (https://portal.nousresearch.com/api-docs) + the Nebula audit guide docs/api-guides/nous.md.
---

# Nous Portal (Hermes) Skill

A single Nebula node — `nous-portal-universal` — that chats with Nous Research's open-weight **Hermes** models for long-context drafting, summarization, analysis, and chain-of-thought reasoning. It is **text-only** and streams tokens. The one thing that makes this provider different from every other one in Nebula is its auth: there is **no `.env` key** — credentials come from Hermes's OAuth files under `~/.hermes/`.

## When to use

- User configures the `nous-portal-universal` node (display name "Nous Portal").
- User asks about Nous Portal, Hermes, or the Hermes-4 family (`Hermes-4.3-36B`, `Hermes-4-70B`, `Hermes-4-405B`) inside Nebula.
- User wants a long-context language/reasoning step in a graph — expand a prompt, summarize source text, explain code, draft copy — to feed into image / audio / 3D nodes.
- User hits a Nous auth error in Nebula ("No Nous Portal credential found…", "token rejected — run `hermes auth`") and needs to know how to fix it.
- User asks which Hermes model to pick, or how to get visible chain-of-thought out of the node.

**Do NOT** reach for this node for images, video, audio, or 3D — Nous exposes none of that in Nebula (see Capability boundaries). Route those to FAL, Gemini, Replicate, Runway, or Meshy nodes and use Nous purely as the language/reasoning step.

## Universal rules

1. **Auth — there is NO env var. Do not look for a `NOUS_API_KEY`.** The node definition's `envKeyName` is `[]`. The handler ignores the `api_keys` dict entirely and instead calls `load_nous_credential()` (in `backend/services/nous_auth.py`), which reads Hermes's OAuth files. It attaches `Authorization: Bearer <agent_key>`, where `agent_key` is a short-lived (~24h) key Hermes mints from the OAuth pair and **auto-refreshes in the background**. Profile lookup order is fixed:
   1. `~/.hermes/profiles/daedalus/auth.json` (the Daedalus profile — checked first),
   2. the active profile named in `~/.hermes/active_profile` → `~/.hermes/profiles/<name>/auth.json`,
   3. the global `~/.hermes/auth.json` as a last resort.
   The credential is read from `credential_pool.nous[0].agent_key` (falling back to `access_token` if no `agent_key`). **Setup is a one-time `hermes-daedalus model` OAuth login** — see `HERMES-SETUP.md` and the setup recipe below. If you ever need to tell the user how to authenticate, the answer is *"run `hermes-daedalus model` and pick Nous Portal"*, never *"paste an API key into `.env`"*.
2. **Base URL.** Comes from the credential file, not a constant: `cred.base_url` is `credential_pool.nous[0].inference_base_url`, which defaults to `https://inference-api.nousresearch.com/v1` when absent. The node's `apiEndpoint` field (`…/v1/chat/completions`) is the canonical default; the handler builds the real URL as `<base_url>/chat/completions`. The model-list dropdown is filled by a separate backend proxy at `GET /api/nous/models` (5-min cache) which hits `<base_url>/models`.
3. **Execution pattern = stream (SSE), not async-poll.** The node's `executionPattern` is `"stream"`. The handler sends `"stream": true` and uses the shared `stream_execute` runner with `delta_path="choices.0.delta.content"` — i.e. it's **OpenAI-compatible SSE**, parsing `choices[0].delta.content` token-by-token and concatenating into the final `text` output. There is no task ID and no polling. Stream timeout is 60s. Extra headers sent: `Content-Type: application/json` and `X-Title: Nebula Nodes`.
4. **Status / error codes** (what the user will actually see):
   - **Not authenticated** → `NousNotAuthenticatedError` surfaced verbatim: *"No Nous Portal credential found in any Hermes profile. Run `hermes-daedalus model` and select Nous Portal…"*. Fix: run that command.
   - **Token rejected / stale** → the `/api/nous/models` proxy returns `401` with *"Nous Portal token rejected — run `hermes auth` to refresh."* Fix: re-run the OAuth login so Hermes refreshes the `agent_key`.
   - **No model selected** → `ValueError("No model selected — choose one from the Inspector panel")`. The `model` param is required and starts empty.
   - **Missing prompt** → `ValueError("Messages input is required")` when the `messages` port is empty.
   - Other non-200s from `/models` are passed through with the upstream status + body text.
5. **Input rules.** The `messages` port is **plain Text**, required — typed text or another node's text output. The handler wraps it as a single `{"role": "user", "content": [{"type":"text", …}]}` message (see gotcha 3 below). The optional `images` port (Image, multiple) is converted to OpenAI-style `image_url` content blocks: `http(s)`/`data:` URIs pass through as-is; **local file paths are base64-encoded into data URIs** by the handler (`_image_to_content_block`, MIME inferred from extension, defaulting to `image/png`). Anything it can't resolve is silently dropped.
6. **Key gotchas:**
   1. **No env key — stop looking for one.** Restating because it's the #1 trap: this is the only Nebula provider with `envKeyName: []`. Auth is filesystem-based via Hermes OAuth.
   2. **`max_tokens` UI cap is optimistic.** The node allows up to **200000**, but the Nous inference API caps `max_tokens` at **32000**. Stay ≤ 32000 to avoid a server-side rejection; don't promise 200k output.
   3. **No system role, no multi-turn, no prefill.** The handler hardcodes exactly one `{"role":"user"}` message built from the `messages` input. You cannot wire a separate system prompt, assistant history, or a `<think>` prefill through the node — to steer behavior (including reasoning), put everything inside the single user prompt text.
   4. **Reasoning lands inline.** Hermes 4's deep-thinking mode emits a `<think>…</think>` block / `reasoning_content`. The node has **no reasoning toggle** and does **not** surface `reasoning_content` separately — any chain-of-thought arrives inline in the `text` output. Parse it out downstream if you need it isolated.
   5. **Image input is best-effort/experimental.** The node offers an `images` port and the handler dutifully builds `image_url` blocks, but the public Nous inference API documents all three Hermes models as **text-only** (string content only). Images may be ignored or rejected. For reliable vision, use a vision-capable provider node instead.
   6. **Output is plain Text.** The single `text` port carries the concatenated stream. There is no structured/JSON output mode (see Capability boundaries).

## Pick the right node

| Node (display name) | Node ID | Endpoint / model | Key params |
|---|---|---|---|
| Nous Portal | `nous-portal-universal` | `<base_url>/chat/completions` (default `https://inference-api.nousresearch.com/v1/chat/completions`), OpenAI-compatible SSE; `model` chosen live from the Hermes catalog (`Hermes-4.3-36B`, `Hermes-4-70B`, `Hermes-4-405B`) | `model` (required, live dropdown), `temperature` (0–2, default 1), `max_tokens` (1–200000 in UI; **keep ≤ 32000** for the API, default 4096) |

This is the **only** node for this provider — one universal text/reasoning LLM node. Inputs: `messages` (Text, required), `images` (Image, optional, multiple). Output: `text` (Text). It appears under the **Universal** category in the node palette, alongside the OpenRouter and Replicate universal nodes.

### Model guidance (the 3 Hermes models)

All three are open-weight, **128k context**, and selected live from the Inspector dropdown (populated by `GET /api/nous/models`). The exact ids the dropdown returns come from the Nous catalog — match them verbatim.

- **`Hermes-4-405B`** — the heavyweight. Best for hard reasoning, nuanced long-form drafting, and tasks where quality matters more than latency/cost. Default choice for "think carefully" prompts and visible chain-of-thought.
- **`Hermes-4-70B`** — the balanced workhorse. Strong general drafting, summarization, code explanation, and prompt-expansion at lower cost/latency than 405B. Good default for "prompt factory" steps that feed image/audio nodes.
- **`Hermes-4.3-36B`** — the fast/cheap option. Best for bulk summarization, simple rewrites, and high-throughput steps where you don't need 405B-level depth.

Rule of thumb: start at **70B**; promote to **405B** when the output quality isn't good enough; drop to **36B** for cheap/bulk text work.

## Param reference

Per the node definition (`backend/data/node_definitions.json` → `nous-portal-universal`) and the handler (`backend/handlers/nous_portal.py`):

**Inputs**
- `messages` — **Text, required.** The prompt. Sent as a single user-role text block. Empty → `ValueError("Messages input is required")`.
- `images` — **Image, optional, `multiple: true`.** Each value becomes an `image_url` content block appended after the text. `http(s)`/`data:` pass through; local paths are base64-encoded to data URIs; unresolvable values are dropped. **Best-effort only** (Hermes API is text-only).

**Params**
- `model` — **string, required, default `""`** (placeholder "Loading models…"). Must be one of the live Hermes ids. Empty → `ValueError("No model selected …")`. Sent as `model` in the request body.
- `temperature` — **float, optional, default `1`, min `0`, max `2`, step `0.1`.** Sent as `temperature` when not `None`. Lower (≈0.2–0.7) for deterministic/precise output, higher (≈1–1.3) for creative drafting.
- `max_tokens` — **integer, optional, default `4096`, min `1`, max `200000` (UI).** Sent as `max_tokens` only when truthy. **API hard limit is 32000** — values above that risk a server-side error; the 200000 UI ceiling is not enforced by the model. Output token budget.

**Output**
- `text` — **Text.** The full concatenated stream (`choices[0].delta.content` joined). Any Hermes `<think>` reasoning block is included inline.

**Always-sent request fields** (not user-editable): `stream: true`, plus headers `Authorization: Bearer <agent_key>`, `Content-Type: application/json`, `X-Title: Nebula Nodes`.

## Recipes

All recipes use the real node id `nous-portal-universal`.

1. **Quick reasoning answer (visible chain-of-thought).** A text/prompt node → `messages` of `nous-portal-universal` (model `Hermes-4-405B`, `temperature` ≈ 0.7). Because there's no system-role wiring, put the Hermes deep-thinking instruction *inside the user prompt* (e.g. lead with "Think step by step inside `<think>` tags, then give the final answer."). Read the `<think>…</think>` block plus the answer from the single `text` output; wire `text` into a text-display / save node. Split the reasoning out downstream if you want it separate.

2. **Prompt factory for an image node.** Rough idea (typed) → `nous-portal-universal` (model `Hermes-4-70B`, prompt "Expand this into a vivid, detailed image prompt: …") → take the `text` output and feed it as the prompt input of a FAL or Gemini image node (e.g. a `fal-ai/flux-2-pro` node). Hermes does the wordcraft; the image provider renders pixels. Keep `max_tokens` modest (a prompt is short) and `temperature` ≈ 1 for variety.

3. **Summarize-then-narrate chain.** Long source text → `nous-portal-universal` (model `Hermes-4.3-36B`, prompt "Summarize in 5 bullet points", larger `max_tokens` but **≤ 32000**) → pipe the `text` into a TTS provider node (e.g. FAL ElevenLabs/MiniMax) to get spoken audio. Nous handles the language step; another provider handles voice. Use 36B here because bulk summarization doesn't need 405B depth.

## In the nebula_nodes context

- **Node id:** `nous-portal-universal` (one node — the entire provider surface in Nebula). Category: **universal**. `apiProvider`: `nous`. `envKeyName`: `[]`.
- **Handler:** `backend/handlers/nous_portal.py` → `handle_nous_portal_universal`. It reuses the shared `execution/stream_runner.py` `stream_execute` (OpenAI-compatible SSE).
- **Auth/support files:** `backend/services/nous_auth.py` (`load_nous_credential`, `NousNotAuthenticatedError`, profile lookup) and `backend/routes/nous_proxy.py` (`GET /api/nous/models`, 5-min cache, fills the model dropdown). **No `.env` involvement.** Setup is documented in `HERMES-SETUP.md` (next to this file).
- **Ports:** input `messages` (Text, required) + `images` (Image, optional, multiple); output `text` (Text).
- **Chaining rules:** the `messages` input accepts any upstream node's Text output (or hand-typed text). The `text` output is plain Text and chains into any node that takes a text/prompt input — image-prompt fields, TTS text inputs, other LLM nodes, display/save nodes. There is no task-id handshake (it's streaming, not async-poll), so nothing downstream needs to wait on a poll.
- **How outputs render:** tokens stream onto the canvas as they arrive; the completed `text` shows in a text-display / save node like any other Text value. There is no media asset to download.

### Capability boundaries (what the API can do that Nebula does NOT expose)

Tell the user these so an agent never over-promises. Pulled from the audit guide's gap table (`docs/api-guides/nous.md`):

- **Text only.** No image, video, audio, or 3D generation through this node. For pixels/audio/3D, route to FAL, Gemini, Replicate, Runway, or Meshy nodes.
- **No tools / function calling, no JSON / `response_format` mode.** Not in the public Nous inference schema and not wired. Tool calling exists in the separate Hermes **Agent** product, not this gateway. Don't promise structured-output enforcement.
- **No Tool Gateway.** A Nous Portal subscription includes a Tool Gateway (managed image gen via FAL — FLUX, Nano Banana Pro, GPT Image, Ideogram, Recraft, Qwen; OpenAI TTS; Firecrawl web search/extract; Browser Use automation), but it's a Hermes-Agent feature mediated by tool-calling — **Nebula does not call it.** None of those tools are reachable from this node.
- **No reasoning toggle / no separate reasoning surface.** Reasoning is reachable only by prompt wording, and `reasoning_content` is not surfaced separately — it lands inline in `text`.
- **No system-role / multi-turn / assistant-prefill.** The handler hardcodes a single user message; you can't build a conversation or prefill a `<think>` opener through the node.
- **No legacy `POST /completions`.** Nebula uses only chat completions; the raw text-completion endpoint (useful for `<think>` prefill) is not exposed.
- **No x402 (Solana USDC) pay-per-request auth.** Nebula authenticates only via the Hermes OAuth `agent_key`; the anonymous x402 payment path is not used.
- **`max_tokens` above 32000 is not honored** by the API even though the UI lets you set up to 200000.
- **Vision is best-effort.** The `images` port builds `image_url` blocks, but the documented Hermes models are text-only string-content — images may be ignored/rejected.

Coverage: Nebula fully uses the small public **inference** API (chat completions + SSE streaming + all three models) and partially uses reasoning / vision / model-list — roughly **~70%** of that inference surface. Measured against the *whole* Portal product (including the Tool Gateway), effective coverage is far lower (~15–20%), since none of the managed image/TTS/search/browser tools are wired.

## Sources

- Nous Portal API Docs (Swagger UI): https://portal.nousresearch.com/api-docs
- Nous Inference API OpenAPI spec (paths, request schema, model list): https://portal.nousresearch.com/api/openapi
- Nous Portal pricing & model info: https://portal.nousresearch.com/info
- Hermes Agent — Nous Portal integration (models, auth, Tool Gateway): https://hermes-agent.nousresearch.com/docs/integrations/nous-portal
- Hermes Agent — API server endpoints: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Hermes Agent — AI providers (Portal model catalog, tool routing): https://hermes-agent.nousresearch.com/docs/integrations/providers
- Nebula audit guide (do-not-duplicate, source of truth for the gap table): `docs/api-guides/nous.md`
- Nebula source of truth for what Nebula actually calls: `backend/handlers/nous_portal.py`, `backend/services/nous_auth.py`, `backend/routes/nous_proxy.py`, `backend/data/node_definitions.json` (`nous-portal-universal`)
- Setup path for the no-env-key auth: `HERMES-SETUP.md` (next to this file)

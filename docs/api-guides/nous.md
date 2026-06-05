# Nous Portal (Hermes) in Nebula Nodes

> Drop a single node on the canvas to chat with Nous Research's open-weight **Hermes** models — long-context reasoning, drafting, and analysis — billed through your Nous Portal subscription with no API key to paste.

## What you can make

**Text (this is the whole story for this provider)**
- Long-form writing, rewriting, summarization, and brainstorming with **Hermes-4.3-36B**, **Hermes-4-70B**, or **Hermes-4-405B** (all 128k context).
- Step-by-step **reasoning / chain-of-thought** answers — the Hermes 4 family exposes an explicit "deep thinking" mode (`<think>…</think>` / a `reasoning_content` field).
- Code explanation, structured drafting, Q&A, and any prompt-in / text-out task you'd give a frontier chat model.
- Feed **prompts produced by other nodes** (or hand-typed text) in, and pipe the streamed answer text into downstream nodes.

**Not offered by this provider in Nebula**
- No image, video, audio, or 3D generation. Nous's image-generation, text-to-speech, web-search, and browser tools exist only inside the separate **Tool Gateway** (a Hermes Agent feature), which Nebula does not call. For pixels, audio, or 3D use the FAL, Gemini, Replicate, Runway, or Meshy nodes instead.

## Nodes available in Nebula (1)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Nous Portal | `nous-portal-universal` | universal (text LLM, streaming) | `messages` (Text, required); `images` (Image, optional, multiple) | `model` (required — picked from a live dropdown of your Hermes models), `temperature` (0–2, default 1), `max_tokens` (1–200000, default 4096) | Long-context Hermes chat/reasoning: drafts, summaries, analysis, code explanation, prompt expansion for other nodes |

Output: a single `text` port (Text). The node streams tokens as they arrive.

> Note on the `images` input: the node *offers* an image input and the handler will attach `image_url` blocks, but the public Nous inference API documents the three Hermes models as **text-only** — its request schema accepts only string message content. Treat image input as best-effort/experimental; for reliable vision use a vision-capable provider node.

## How to use it in Nebula

**Where it appears.** Open the node palette and look under the **Universal** category (alongside the OpenRouter and Replicate universal nodes). Drag **Nous Portal** onto the canvas. In the Inspector panel on the right, the **Model** dropdown loads your available Hermes models live (the backend proxies Nous's model list, cached ~5 min). Pick a model, then tune Temperature and Max Tokens.

**Auth setup — there is NO `.env` key for this provider.** Unlike every other provider, Nous Portal does **not** read an API key from `.env`. Authentication is handled by **Hermes** via OAuth, and the credential is read from `~/.hermes/auth.json` (per-profile). To set it up:

1. Install Hermes if you haven't, then run the OAuth login:
   ```bash
   hermes-daedalus model      # opens a browser, log in / subscribe at portal.nousresearch.com
   ```
   (Nebula's canvas node looks at the **daedalus** profile first, then your active profile, then the global `~/.hermes/auth.json`.)
2. Hermes writes the credential — including a short-lived `agent_key` it auto-refreshes (~24h) — into `~/.hermes/profiles/daedalus/auth.json`. Nebula reads that file at run time and attaches `Authorization: Bearer <agent_key>`.
3. If you ever see *"No Nous Portal credential found…"* or *"token rejected — run `hermes auth`"*, re-run the command above to refresh.

So the one-line version: **there is no key to paste into `.env`; run `hermes-daedalus model` once and Nebula picks up the credential automatically.**

**Example recipes (real node IDs):**

1. **Quick reasoning answer.** A `text` / prompt node → `messages` of `nous-portal-universal` (model `Hermes-4-405B`, temperature ~0.7). To force visible chain-of-thought, put the Nous "deep thinking" system instruction at the top of your prompt and read the `<think>…</think>` block in the output. Wire `text` out to a text-display / save node.

2. **Prompt factory for an image node.** Type a rough idea → `nous-portal-universal` (model `Hermes-4-70B`, "Expand this into a vivid, detailed image prompt") → take its `text` output and feed it as the prompt into a FAL or Gemini image node (e.g. a `fal-ai/flux-2-pro` node). Hermes does the wordcraft; the image provider does the pixels.

3. **Summarize-then-narrate chain.** Long source text → `nous-portal-universal` (model `Hermes-4.3-36B`, "Summarize in 5 bullet points", higher `max_tokens`) → pipe the `text` into a TTS provider node (FAL ElevenLabs/MiniMax) to get spoken audio. Nous handles the language step; another provider handles voice.

## API coverage — what Nebula uses vs. what Nous Portal (Hermes) offers

Scope note: Nous Portal is a **universal gateway**, so this is assessed at the capability level. The relevant surface is the **public Nous inference API** (`https://inference-api.nousresearch.com/v1`, per the portal's own OpenAPI spec) plus the adjacent Portal/Tool-Gateway capabilities a subscription unlocks.

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| `POST /chat/completions` (chat) | Yes | **full** | The node's core call. Sends `model`, `messages`, `stream:true`, optional `max_tokens` + `temperature`. |
| SSE streaming (`stream: true`) | Yes | **full** | Handler streams `choices[0].delta.content` token-by-token. |
| Model selection across Hermes models | Yes (3 models) | **full** | Live dropdown; all three Hermes models reachable. |
| `temperature`, `max_tokens` params | Yes | **full** | Both wired. (Note: API caps `max_tokens` at 32000; the node's UI max of 200000 is optimistic.) |
| `POST /completions` (legacy text completion) | Yes | **none** | Nebula only uses chat completions; the raw completions endpoint (useful for `<think>` prefill) is not exposed. |
| Reasoning mode (`<think>` / `reasoning_content`) | Yes | **partial** | Reachable by hand via the system prompt, but the node has no toggle and doesn't surface `reasoning_content` separately — it lands inline in `text`. |
| System / multi-turn `messages` | Yes | **partial** | Handler hardcodes a single `{"role":"user"}` message from the `messages` input; no system-role or assistant-history wiring, no prefill. |
| Vision / image (`image_url` content parts) | Not documented (Hermes models = text-only string content) | **partial** | Node exposes an `images` port and builds `image_url` blocks, but the public API schema accepts only string content — best-effort, may be ignored/rejected. |
| `tools` / function calling, `response_format` / JSON mode | Not in the public inference schema | **none** | Not in the portal OpenAPI spec; not wired. (Tool calling exists in the Hermes Agent product, not this gateway.) |
| `GET /models` (list models) | Not in the public OpenAPI spec | **partial** | Nebula's proxy GETs `/models` to fill the dropdown — works in practice but is undocumented; it reads OpenRouter-style `architecture.input_modalities` fields the Nous spec doesn't define. |
| x402 (Solana USDC) pay-per-request auth | Yes (beta) | **none** | Nebula authenticates via Hermes OAuth `agent_key` only; the anonymous x402 payment path isn't used. |
| Tool Gateway — image gen (FAL: FLUX, Nano Banana Pro, GPT Image, Ideogram, Recraft, Qwen) | Yes (Portal subscription, via Hermes Agent) | **none** | Separate service; not an inference-API endpoint. Nebula gets images from its own FAL/Gemini nodes instead. |
| Tool Gateway — TTS (OpenAI), web search/extract (Firecrawl), browser automation (Browser Use) | Yes (Portal subscription, via Hermes Agent) | **none** | Not reachable as raw HTTP endpoints; mediated by Hermes Agent tool-calling, which Nebula does not drive. |

Coverage: **~70%** of the Nous Portal (Hermes) **public inference API** surface is exposed in Nebula. (The inference API is small — two endpoints; Nebula fully uses chat completions + streaming + the three models, and partially uses reasoning/vision/model-list. If you score against the *whole* Portal product including the Tool Gateway, effective coverage is far lower, ~15–20%, since none of the image/TTS/search/browser tools are wired.)

Notable unused capabilities: the legacy `POST /completions` endpoint; native **reasoning** surfacing (`reasoning_content`) and `<think>` prefill; **system-role / multi-turn / assistant-prefill** message construction; **x402** anonymous pay-per-request; and the entire **Tool Gateway** (managed image generation, TTS, web search/extract, and cloud browser automation) that a Nous Portal subscription includes.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/nous/SKILL.md` (plus `HERMES-SETUP.md`; new 2026-06-04). It covers the **1** Nous Portal (Hermes) node, giving an agent the node contract, the unusual no-`.env`-key auth model, model guidance, reasoning usage, capability boundaries, and pipeline patterns.

What it covers:
- **The node contract** — ID `nous-portal-universal`, required `messages` (Text) input, optional `images` input, params `model` / `temperature` / `max_tokens`, single `text` output, streaming execution.
- **The unusual auth model** — there is **no `.env` key**; credentials come from `~/.hermes/auth.json` via `hermes-daedalus model` (OAuth). The skill tells an agent to run that command (not look for an API key) and how to interpret "not authenticated" / "token rejected" and re-auth.
- **Model choice guidance** — the three Hermes models (`Hermes-4.3-36B`, `Hermes-4-70B`, `Hermes-4-405B`, 128k context) and when to pick the 405B vs. the smaller two.
- **Reasoning usage** — the deep-thinking system prompt and `<think>` prefill trick, and that reasoning lands inline in the `text` output.
- **Capability boundaries & pipeline patterns** — text-only (image input best-effort/undocumented; no tools/JSON/Tool Gateway), so route image/audio/3D/search to other provider nodes and use Nous as the language/reasoning step (a "prompt factory" or summarizer feeding FAL/Gemini/Meshy/TTS nodes).

## Sources

- Nous Portal API Docs (Swagger UI): https://portal.nousresearch.com/api-docs
- Nous Inference API OpenAPI spec (paths, request schema, model list): https://portal.nousresearch.com/api/openapi
- Nous Portal pricing & model info: https://portal.nousresearch.com/info
- Hermes Agent — Nous Portal integration (models, auth, Tool Gateway): https://hermes-agent.nousresearch.com/docs/integrations/nous-portal
- Hermes Agent — API server endpoints (chat completions / responses / runs surface): https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Hermes Agent — AI providers (Portal model catalog, tool routing): https://hermes-agent.nousresearch.com/docs/integrations/providers
- Nebula handler & auth (source of truth for what Nebula calls): `backend/handlers/nous_portal.py`, `backend/services/nous_auth.py`, `backend/routes/nous_proxy.py`
- Existing developer audit (do-not-duplicate): `docs/model-providers/replicate-openrouter-nous/universal.md`

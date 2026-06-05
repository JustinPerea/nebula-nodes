# Anthropic (Claude) in Nebula Nodes

> Drop a Claude node on the canvas to turn text and images into written output — captions, prompts for other nodes, descriptions, summaries, rewrites, and reasoning — right inside your generation pipeline.

## What you can make

Anthropic's Claude is a **text-generation** model. In Nebula it gives you one thing, very well: take some text (and optionally one or more images) and produce written text back.

- **Text from text** — write, rewrite, summarize, translate, brainstorm, answer questions, draft prompts for your image/video/audio nodes.
- **Text from images (vision)** — describe a picture, caption it, read text out of it, critique a generated frame, or turn a reference image into a written prompt for another node.
- **Reasoning / "extended thinking"** — let Claude think through harder problems before answering (planning a shot list, untangling a multi-step request). The final answer comes back as text.

It does **not** generate images, video, audio, or 3D itself — those come from other provider nodes. Claude is the "brain" you wire in to write, plan, and describe between the visual nodes.

## Nodes available in Nebula (1)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Claude | `claude-chat` | text-gen | `messages` (Text, required), `images` (Image, optional, multiple) | `model` (Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / Opus 4.6 legacy), `max_tokens`, `temperature`, `system` (system prompt), `top_p`, `stop_sequences`, `extended_thinking` + `thinkingBudget` | Writing, summarizing, translating, captioning images, and drafting prompts to feed other nodes |

Output port: `text` (Text) — the written response, streamed token-by-token as it generates.

## How to use it in Nebula

**Where the node lives.** Open the node palette and look under the **text-gen** category. The node is shown as **Claude**. Drag it onto the canvas.

**API-key setup.** Claude needs an Anthropic API key:

1. Get a key from the Anthropic Console (https://platform.claude.com → Account Settings → API keys).
2. In the Nebula backend, add it to your `.env` file as `ANTHROPIC_API_KEY`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Restart the backend so it picks up the key. The node reports a clear error (`ANTHROPIC_API_KEY is required`) if it's missing.

**Wiring it up.** Connect a Text source into the `messages` port (this is your prompt / question). Optionally connect one or more Image outputs into the `images` port to let Claude see them. Run the graph; the written answer flows out of the `text` port and can feed any node that accepts Text.

**Pick a model.** Default is **Claude Sonnet 4.6** (fast and capable — good for almost everything). Use **Claude Opus 4.7** for the hardest reasoning, **Claude Haiku 4.5** when you want the fastest/cheapest pass, or **Claude Opus 4.6 (legacy)** if you specifically need it.

### Example recipes

**1. Idea → polished image prompt → image.**
Type a rough idea into a Text node ("a lighthouse in a storm, moody"), feed it into `claude-chat` with a `system` prompt like *"You are a prompt engineer. Expand the user's idea into one vivid, detailed image-generation prompt. Output only the prompt."* Wire the `text` output into the prompt input of an image node (e.g. a `gpt-image-2` or `gemini` generate node). Claude does the prompt-writing; the image node renders it.

**2. Generated image → caption / alt-text.**
Take the image output of any generator node and connect it to the `images` port of `claude-chat`. Put *"Write a one-sentence caption and a short alt-text for this image."* into `messages`. The `text` output is ready-made caption copy.

**3. Hard planning step with extended thinking.**
For a multi-step request ("plan a 5-shot product video and write a prompt for each shot"), enable **Extended Thinking** on the node and give it a `thinkingBudget` (e.g. 10000). Claude reasons through the plan before answering. Feed each resulting shot prompt into your video nodes. *(Note: the final answer is what streams to the `text` port — the internal reasoning itself is not surfaced as output in Nebula today.)*

## API coverage — what Nebula uses vs. what Anthropic (Claude) offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Messages — text generation (`POST /v1/messages`) | Yes | full | Core of the node; streamed via SSE `content_block_delta`. |
| Streaming responses | Yes | full | Always on (`stream: true`); text streams to the output port. |
| Vision / image input | Yes | full | `images` port supports base64 data URLs, http(s) URLs, and local paths (PNG/JPG/JPEG/WebP). |
| System prompt | Yes | full | `system` param → top-level `system` field. |
| Sampling: `temperature`, `top_p`, `stop_sequences` | Yes | partial | All three wired. `top_k` is **not** exposed. |
| Extended thinking | Yes | partial | Toggle + `thinkingBudget` wired; but the thinking deltas are filtered out, so the reasoning chain isn't shown — only the final text. `adaptive` thinking mode not exposed. |
| Multi-turn conversation history | Yes | none | The node sends a single user turn built from `messages` text; no assistant/prior-turn history is constructed. |
| Tool use / function calling (custom/client tools) | Yes | none | `tools` / `tool_choice` not exposed — Claude can't call your functions from the node. |
| Server tools: web search, web fetch, code execution, tool search | Yes | none | None of the Anthropic-executed tools are wired. |
| Client tools: bash, text editor | Yes | none | Not exposed. |
| Structured / JSON output (`output_config`, strict tools) | Yes | none | No JSON-schema-constrained output; you'd prompt for JSON in plain text. |
| Prompt caching (`cache_control`) | Yes | none | Not used — repeated long system prompts pay full input cost each run. |
| PDF / document input | Yes | none | `document` content block not supported; only `image` and `text`. |
| Citations | Yes | none | Not surfaced. |
| MCP connector | Yes | none | Not wired. |
| Token Counting API (`POST /v1/messages/count_tokens`) | Yes | none | Not used. |
| Message Batches API (`POST /v1/messages/batches`, 50% cheaper async) | Yes | none | Not used. |
| Models API (`GET /v1/models`) | Yes | none | Model list is hardcoded in the node enum, not fetched live. |
| Files API (`POST /v1/files`, beta) | Yes | none | Not used. |
| Skills API (beta) | Yes | none | Not used. |
| Managed Agents: Agents / Sessions / Environments APIs (beta) | Yes | none | Stateful cloud-sandbox agents — entirely outside Nebula's scope. |

Coverage: ~20% of the Anthropic (Claude) API surface is exposed in Nebula.

Notable unused capabilities: tool use / function calling (custom + server tools like web search, web fetch, code execution), structured/JSON output, prompt caching, PDF/document input, citations, multi-turn conversation history, the MCP connector, Token Counting, the 50%-cheaper Message Batches API, the Files API, and the entire Managed Agents stack (Agents/Sessions/Environments). The thinking chain is also requested but filtered out of the streamed output.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/anthropic/SKILL.md` (new 2026-06-04). It covers the **1** Anthropic (Claude) text node, giving an agent the node contract, the full param reference, accepted image formats, wiring patterns, and the in-Nebula limits. (It is distinct from the global `claude-api` skill, which is for writing Anthropic SDK code in general.)

What it covers:

- **The node contract** — node ID `claude-chat`, category `text-gen`, the `messages` (required) and `images` (optional, multiple) input ports, the `text` output port, and the streaming execution pattern.
- **Param reference** — exact keys and ranges: `model` (the valid enum values), `max_tokens` (1–200000, required), `temperature` (0–1), `top_p` (silently dropped), `stop_sequences` (comma-separated string), `system`, and the `extended_thinking` + `thinkingBudget` (min 1024) pairing — including that thinking forces `temperature=1` and that the thinking chain is filtered out.
- **Image input formats** — base64 data URLs, http(s) URLs, local file paths; PNG/JPG/JPEG/WebP.
- **Wiring patterns** — text → prompt expansion → image node; image → caption; plan → fan-out to multiple media nodes.
- **Capability boundaries** — single-turn only, no tools, no JSON-schema output, no PDF input, and a hardcoded model list (may drift from the live `GET /v1/models`).

## Sources

Official Anthropic documentation fetched 2026-06-04 (all `docs.claude.com/en/...` URLs 301-redirect to `platform.claude.com/docs/en/...`):

- API overview — https://platform.claude.com/docs/en/api/overview
- Messages API reference — https://platform.claude.com/docs/en/api/messages
- Tool use overview — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching

Nebula ground truth: `backend/data/node_definitions.json` (node `claude-chat`), `backend/handlers/anthropic_chat.py`, and `docs/model-providers/anthropic/claude-chat.md`.

# Nebula Node — For Justin

*A living document that explains what this project is, how it works, and what we learned building it.*

---

## What Is This Thing?

Imagine a mixing board — but instead of audio tracks, you're routing AI models. You drop a "Text Input" node onto a canvas, wire it into a "Claude" node, wire that text output into a "Runway Gen-4 Turbo" node, and suddenly you've built a pipeline that takes a prompt, generates a creative brief with Claude, and turns it into a video. All without writing a line of code.

That's Nebula Node. It's a visual programming environment for AI pipelines. The canvas is yours; the models are your API accounts; the app is just the plumbing in between.

The key constraint that makes this interesting — and this is intentional — is that it's **locally-run and BYOK (Bring Your Own Keys)**. There's no platform fee, no vendor lock-in, no SaaS middle layer. You clone it, run two commands, and you're using your own OpenAI and Anthropic accounts directly.

---

## How the Architecture Works

Think of the app as two separate processes talking to each other through a well-defined contract.

**The Frontend** is a React 19 SPA (Single-Page Application) running in your browser at `localhost:5173`. It's responsible for the canvas UI, all node and edge state, and triggering execution. The canvas itself is built on `@xyflow/react` — a library that handles the drag-drop-connect mechanics, viewport panning, and edge routing. All graph state lives in Zustand stores (`graphStore` and `uiStore`).

**The Backend** is a FastAPI Python server running at `localhost:8000`. It knows how to call AI APIs, validate graphs, sort them topologically, and run handlers in the right order. It does NOT know anything about the canvas rendering — it just receives a list of nodes and edges as JSON and executes them.

**The connection between them** uses two channels:
1. **REST** — the frontend POSTs to `/api/execute` to start a run and GETs from `/api/settings` for config.
2. **WebSocket** at `/ws` — the backend streams execution events (queued, executing, progress, executed, error, graphComplete) back to the frontend in real time. This is why you see the nodes light up as they run rather than waiting for a final response.

When you hit "Run," here's what happens in sequence:

1. `graphStore.executeGraph()` serializes all nodes and edges and POSTs them to `/api/execute`.
2. The backend validates the graph (are required ports connected? are API keys present?), topologically sorts it (which node must run before which?), and kicks off `execute_graph()` as an async background task — returning `{"status": "started"}` immediately.
3. The engine walks the sorted node list, calls the appropriate handler for each node, and broadcasts WebSocket events as it goes.
4. The frontend's `wsClient` subscriber calls `handleExecutionEvent()` on each incoming event, updating `node.data.state`, `node.data.outputs`, and `node.data.streamingText` via Zustand.
5. React Flow re-renders the affected nodes as their state changes.

The `graphComplete` event fires last, resetting `isExecuting` to `false` and unlocking the Run button.

---

## Key Decisions and Why We Made Them

### React Flow for the Canvas

We didn't build the canvas from scratch. `@xyflow/react` handles the hard parts: drag-and-drop node placement, edge routing with bezier curves, viewport pan/zoom, selection marquee, and the connection logic. It exposes `onNodesChange`, `onEdgesChange`, and `onConnect` callbacks that we wire into Zustand, making the store the single source of truth.

The tradeoff: we're dependent on the library's node/edge data shape. Everything a node "knows" — its params, outputs, execution state, streaming text — lives in `node.data`. This means `node.data` is a kitchen sink, but it's also the right call: React Flow tracks nodes by identity, so keeping state in `node.data` means the canvas re-renders exactly the nodes that changed.

### Zustand Over Redux or Context

Zustand gives us a dead-simple global store without boilerplate. The entire graph state — 800 lines of `graphStore.ts` — is one `create()` call. Actions mutate state directly using Immer-style `set()`. No action creators, no reducers, no dispatchers.

The key insight is the two-store split: `graphStore` owns nodes, edges, and execution logic; `uiStore` owns panels, selection UI, and the settings cache. This prevents the graph from re-rendering every time a panel opens, and the settings panel from triggering graph re-evaluations.

### FastAPI for the Backend

FastAPI is Python's speed-to-prod champion. You define a route with a decorator and a type-annotated function, and you get automatic request validation, response serialization, and interactive API docs at `/docs` for free. Its async support maps cleanly to the streaming AI calls we make with `httpx`.

The handler pattern is elegant: every model has a file in `backend/handlers/` that exports a single async function. The execution engine (`engine.py`) doesn't know anything about specific models — it looks up the handler by `definitionId`, calls it with the node params and upstream outputs, and awaits the result. Adding a new model is: write one file, register it in `sync_runner.py`. That's it.

### Node State Lives in `node.data`

This was the core architectural decision for the frontend. Each node carries its entire runtime state — params, outputs, execution status, error messages, streaming text — inside `node.data`. This makes the state co-located with the thing that renders it, and makes serialization trivial (saving a graph is `JSON.stringify(nodes)`).

The output format is `{ type: 'Image' | 'Text' | 'Video' | 'Audio', value: string | null }`. The execution engine returns this; the frontend stores it; the Inspector panel reads it. One format everywhere.

### Dynamic Nodes: OpenRouter, Replicate, FAL

The three "universal" nodes — OpenRouter, Replicate, FAL — are special. Their port definitions aren't static; they change based on which model you configure. An OpenRouter text model gets a text output port; a multimodal one gets image + text ports. A Replicate model's input ports are derived from its published JSON schema.

These nodes use `DynamicNodeData` (a superset of `NodeData`) and render as `dynamic-node` rather than `model-node`. Their port definitions live in `node.data.dynamicInputPorts` and `node.data.dynamicOutputPorts` — mutable arrays that get rewritten when you select a model. The frontend fetches model metadata via proxy routes (`/api/openrouter/models`, `/api/replicate/schema`) that the backend exposes, keeping API keys out of the browser.

### REST + WebSocket (Not Pure WebSocket)

We start execution via REST (`POST /api/execute`) and stream events back via WebSocket. Why not do everything over the WebSocket? Because REST gives us a clear request/response for validation errors before execution starts. The frontend can immediately show validation feedback without waiting for the WS channel. The WS is then purely for the streaming events — a clean separation of concerns.

---

## Bugs We Hit and How We Fixed Them

### `response_format` Rejected by gpt-image-1

We initially passed `response_format: "url"` to the OpenAI image generation API for the `gpt-image-1` model, which worked fine for DALL-E 3. The gpt-image-1 API rejects that parameter — it always returns base64 by default and doesn't accept `response_format` at all.

**Fix:** In `openai_image.py`, we check the model name and omit `response_format` entirely for `gpt-image-1`, decoding the base64 response and writing it to disk ourselves. DALL-E 3 still uses the URL path.

**Lesson:** Read the model-specific API documentation, not just the general endpoint docs. OpenAI's image API has model-level parameter differences that aren't always obvious from the top-level reference.

### Runway Wrong Endpoint

We initially hit `/v1/tasks` for Runway video generation. That endpoint doesn't exist for image-to-video. The correct path is `/v1/image_to_video`.

**Fix:** Updated `runway.py` to use the correct endpoint.

**Lesson:** Follow the research docs and API reference literally. When a request silently fails or returns a 404, the first thing to check is whether the endpoint path is exactly right. Don't infer the path from pattern-matching other Runway endpoints.

### Missing Comma in `settings.json`

At one point we hand-edited `settings.json` to add a new key and missed a trailing comma. The backend's `json.load()` threw a `JSONDecodeError` on startup, which surfaced as a confusing 500 on all settings reads.

**Fix:** Added better error messaging in `settings.py` so JSON parse failures produce a readable error rather than a stack trace. Also: always use a JSON validator or your editor's format-on-save.

**Lesson:** JSON does not allow trailing commas. This is always the first thing to check when `settings.json` fails to parse. And always validate JSON by hand before saving if you're editing it outside the Settings panel.

### WebSocket Disconnect Eating `graphComplete`

Early on, if the WS connection dropped mid-run and reconnected, the `graphComplete` event was sometimes missed. The frontend would get stuck with `isExecuting: true` indefinitely, making the Run button permanently disabled.

**Fix:** The connection manager in `main.py` catches exceptions on send and drops dead connections silently. More importantly, the `graphComplete` event fires reliably as long as a connection exists at the time the engine finishes — the issue was reconnect timing. We added a guard in `handleExecutionEvent` so `graphComplete` always resets `isExecuting`, and we log the event explicitly so it's easy to confirm it arrived.

**Lesson:** WebSocket reliability is easy to underestimate. Events can be lost at reconnect boundaries. For state machines that depend on a terminal event (like "execution done"), always have a fallback reset path — a timeout, a polling fallback, or an explicit "reconnect and re-query status" flow.

---

## Lessons Worth Keeping

**Follow API documentation literally.** Every time we deviated from the spec — inferred a parameter name, assumed an endpoint path followed a pattern — we hit a bug. The models aren't all built the same way. The five minutes you spend reading the API reference saves two hours of debugging.

**Generic runners pay off massively.** The handler registry pattern (`definitionId -> async function`) meant that adding a new model was always just: write the handler, register it, define the node in the frontend constants. No changes to the engine. This is the "open/closed principle" in practice — the engine is closed for modification, open for extension.

**The edge cases doc prevented runtime bugs.** We wrote a dedicated edge cases document before implementing the execution engine. It covered things like: what happens when undo is triggered during execution? What if a node has no upstream connections? What happens when execution is running and the user edits a node? Answering those questions upfront meant we didn't discover the answers mid-refactor.

**Undo should never remove outputs.** Users can spend 10 seconds or 10 minutes waiting for a model to generate something. Undoing a graph structure change should not blow away that output. We implemented undo snapshots that deliberately strip outputs — and then merge the live outputs back in when restoring. This sounds fiddly but it's the right behavior and users never think about it.

**Type the ports, color the edges.** We built port compatibility enforcement (Text can't connect to Image, etc.) into the connection logic from the beginning. It added a day of implementation but saved weeks of "why is my pipeline producing garbage" debugging. The color-coded edge types are not decorative — they're the compiler's type errors made visible.

---

## GPT Image 2 — What Shipped and What We Learned

OpenAI released `gpt-image-2` on 2026-04-21 — a new image model with text-first design, image editing capability, and a streaming API. We shipped it the same day: four new nodes (`gpt-image-2-generate`, `gpt-image-2-edit`, plus FAL variants), image-mode streaming in the execution engine, and BYOK support for both routes.

### Four Nodes Instead of One

The project memory rule says nodes with dual providers (OpenAI-direct + FAL) need `sharedParams/falParams/directParams` machinery. We did something simpler: four dedicated nodes instead of one dual-path node. The user picks their provider at placement time; the node just does one thing. No parameter merging, no conditional logic. Sometimes duplication is cheaper than the abstraction — especially when the nodes only differ in `definitionId` and handler route.

### Defense-in-Depth on Removed Parameters

gpt-image-2 doesn't accept `background` or `input_fidelity` — both present on v1. The node defs don't expose them, but the handler also strips them before sending the request upstream. If someone later adds an enum option by mistake, the handler won't leak an invalid param. This saved a future debugging session. We learned it watching v1 break when we forgot to remove `response_format` from `gpt-image-1`.

### Extending the Stream Runner Instead of Forking

The existing `stream_execute` streams text chunks. Instead of forking to a new file, we added `stream_execute_image` as a sibling function with OpenAI + FAL dialect branches. Text mode is untouched; image mode gets the base64-partial SSE parse loop. The frontend's `DynamicNode.tsx` now renders the latest partial frame during execution, swapping to the final image on completion — no frontend flicker. Reuse won this time — see "Generic runners pay off" above.

### Subagent-Driven TDD Catches Real Bugs Before They Ship

The whole integration was built with the `superpowers` skill chain — brainstorming, writing plans, and dispatching fresh subagents per task with two-stage review. During Task 5 (edit handler), the first draft had three real issues we would have shipped otherwise: hard-coded `image/png` MIME (would silently mangle JPEG uploads), duplicated 403-error logic, and zero happy-path test coverage for the 60-line SSE parse loop. All three caught by a fresh code reviewer looking at the diff. Cost: roughly 15 minutes of re-dispatch. Compare that to debugging user-reported bugs days later. This pattern is reusable for future big integrations.

One rough edge we deferred: the error-rewrap for OpenAI's org-verification check searches `"organization_must_be_verified" in error_body`. Works today because `stream_execute_image` embeds the raw response body in its RuntimeError. But if that error-wrapping format changes later, the match silently stops working. We deferred the structured-exception refactor to when FAL streaming lands as a second caller — fixing it then earns the test coverage from both paths.

---

## What's Next

- **Favorites / Recents** — a pinned node list in the Node Library so you don't scroll to find FLUX every time.
- **SQLite persistence** — right now graphs are saved/loaded as files. A SQLite layer would let us store graph history, output metadata, and run logs without requiring the user to manage files.
- **UI theming** — the app is dark-only. A light mode or user-configurable theme is a natural next step for broader adoption.
- **Batch execution** — run the same graph N times with different inputs. The `batchSizeCap` field already exists in `settings.json`; it just needs a UI.
- **More model nodes** — the architecture makes adding them trivial. ElevenLabs V3, Stable Diffusion 3.5, Whisper transcription, and video-to-video nodes are all natural candidates.

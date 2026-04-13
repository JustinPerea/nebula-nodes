# Nebula Node — Design Spec

> **Date:** 2026-04-13
> **Project:** Nebula Node — open source, locally-run AI node editor
> **Status:** Approved — ready for implementation planning

---

## Overview

Nebula Node is a local AI node-based editor where users bring their own API keys. Users visually wire together AI model nodes (image generation, video generation, text/chat, audio, utilities) on a canvas, connect them via typed ports, and execute the graph to produce creative output. Supports 50+ models across OpenAI, Anthropic, Google, Runway, Kling, ElevenLabs, Replicate, FAL, and more.

Users can choose between **FAL routing** (single key, covers ~25 models) or **direct API routing** (per-provider keys).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend framework | React 19 + Vite |
| Canvas library | @xyflow/react (React Flow v12) |
| State management | Zustand |
| Backend | Python 3.12+ + FastAPI + uvicorn |
| HTTP client | httpx (async) |
| Retry logic | tenacity |
| Frontend-backend comms | REST (CRUD) + WebSocket (execution events) |
| Persistence (MVP) | `.nebula` JSON files, in-memory execution cache |
| Persistence (post-MVP) | SQLite for execution cache + run history |

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| App layout | Full canvas + floating panels | Maximum canvas real estate. Panels (node library, inspector, toolbar) are draggable and closeable. Photoshop-style. |
| Node params | Inspector panel (Figma-style) | Keeps nodes compact on canvas. Click a node to see/edit params in floating inspector. No inline controls. |
| Frontend-backend comms | REST + WebSocket | REST for graph CRUD, settings, validation. WebSocket exclusively for execution events (progress, streaming, completion). |
| Visual tone | Minimal Mono | Monochrome dark grey. Color appears only on port dots and edge strokes. Professional, functional, easy to re-skin later. |
| State persistence | File-based MVP | Graphs saved as `.nebula` JSON. Execution cache in-memory. SQLite added post-MVP for cache + history persistence. |
| Execution mode | Manual-run default | User explicitly triggers via Ctrl+Enter or Run button. Auto-run opt-in in settings. Prevents accidental API spend. |
| Project structure | Monorepo (frontend/ + backend/) | Simple, matches spec file structure. No toolchain overhead. Types stay in sync by convention. |

---

## Project Structure

```
nebula_nodes/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Canvas.tsx           # React Flow canvas wrapper
│   │   │   ├── nodes/               # Custom node components
│   │   │   ├── panels/              # Floating panels (library, inspector, toolbar)
│   │   │   └── ui/                  # Shared UI primitives
│   │   ├── store/
│   │   │   ├── graphStore.ts        # Zustand: nodes, edges, viewport
│   │   │   └── uiStore.ts          # Zustand: panel positions, selection, settings
│   │   ├── types/                   # All TypeScript interfaces from spec
│   │   ├── hooks/                   # Custom hooks (useIsValidConnection, etc.)
│   │   ├── lib/
│   │   │   └── wsClient.ts         # WebSocket client for execution events
│   │   └── App.tsx
│   ├── package.json
│   └── vite.config.ts
│
├── backend/
│   ├── main.py                      # FastAPI app + WebSocket endpoint
│   ├── models/                      # Pydantic models (mirrors TS types)
│   ├── execution/
│   │   ├── engine.py                # Topological sort + orchestration
│   │   ├── sync_runner.py           # Sync API call handler
│   │   ├── async_poll_runner.py     # Submit/poll handler
│   │   └── stream_runner.py         # SSE streaming handler
│   ├── handlers/                    # One file per provider
│   ├── services/
│   │   ├── cache.py                 # In-memory execution cache
│   │   ├── output.py                # Output dir + temp URL download
│   │   └── settings.py              # API key management + routing
│   ├── requirements.txt
│   └── .env
│
├── output/                          # Generated media (gitignored)
├── docs/
├── .env.example
├── .gitignore
└── README.md
```

---

## Canvas & Node System

### Canvas

- Full-screen React Flow canvas, dark monochrome background (`#111`)
- Subtle grid lines (`rgba(255,255,255,0.04)`, 32px spacing)
- All zoom/pan/drag/connect interactions handled by React Flow
- Zoom range: 0.1–4.0, zoom-to-cursor behavior

### Node Anatomy (compact)

```
┌──────────────────────────────┐
│ ● GPT Image 1          ⚠ ✕  │  ← Header: category dot + name + badges
├──────────────────────────────┤
│ ● Prompt                     │  ← Input ports (left-aligned, colored dots)
│ ● Image                      │
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │      Preview thumb       │ │  ← Output preview (after execution only)
│ └──────────────────────────┘ │
├──────────────────────────────┤
│                    Image ●   │  ← Output ports (right-aligned)
└──────────────────────────────┘
```

- Background: `#1c1c1c`, border: `#333`, border-radius: 6px
- Category color: small dot in header only (Minimal Mono)
- State indicator (left border): transparent=idle, grey pulse=queued, blue shimmer=executing, green flash=complete, red=error
- Fixed width (~220px), height adapts to content. Not resizable in MVP.

### Node Header Colors by Category

| Category | Color | Hex |
|----------|-------|-----|
| image-gen | Blue | `#1565C0` |
| video-gen | Red | `#B71C1C` |
| text-gen | Purple | `#4A148C` |
| audio-gen | Amber | `#FF6F00` |
| transform | Teal | `#004D40` |
| analyzer | Green | `#1B5E20` |
| utility | Grey | `#424242` |

In Minimal Mono, these appear only as the small header dot.

### Floating Panels

| Panel | Purpose | Behavior |
|-------|---------|----------|
| Node Library | Searchable list grouped by category. Drag or double-click to add. | Toggleable via shortcut or toolbar. |
| Inspector | Params for selected node. Generated from `ParamDefinition[]`. Empty state when nothing selected. | Auto-shows on node select, closeable. |
| Toolbar | Bottom-center pill. Run, fit-to-screen, settings, execution mode. | Always visible. |

All panels are draggable, closeable, and persist position in `uiStore`.

### Port System

| Port Type | Color | Hex |
|-----------|-------|-----|
| Image | Green | `#4CAF50` |
| Video | Red | `#F44336` |
| Text | Purple | `#9C27B0` |
| Array | Blue | `#2196F3` |
| Audio | Yellow | `#FFC107` |
| Mask | Lime | `#8BC34A` |
| SVG | Brown | `#795548` |
| Any | Grey | `#9E9E9E` |

- 10px diameter circles, 2px white stroke, filled with data type color
- Scale to 14px on hover
- Incompatible ports dim to 30% during drag-connect
- Connection validation via `isValidConnection` — blocks cycles and type mismatches per spec compatibility table

### Edges

- Cubic bezier curves, 2px stroke in data type color
- Animated dash pattern during execution
- Selected edge: 3px stroke + subtle glow
- Control points computed from port positions with minimum 60px handle distance

---

## Execution Engine

### Trigger

Manual only by default. Ctrl+Enter runs full graph. Right-click node > "Run This Node" runs one subgraph. Auto-run available as opt-in toggle.

### Execution Flow

1. Frontend sends graph JSON to `POST /api/execute`
2. Backend validates: cycles, required ports, API keys
3. Validation failures returned via WebSocket — frontend marks affected nodes/ports
4. Topological sort determines execution order
5. Sequential within dependency chains, parallel across independent subgraphs
6. Each node emits WebSocket events: `queued` → `executing` → `progress` → `executed`/`error`
7. On completion: `graph_complete` event

### Execution Runners

| Runner | Pattern | Models |
|--------|---------|--------|
| `sync_runner` | Single HTTP call, await response | GPT Image 1/1.5/mini, DALL-E, Imagen 4, FLUX (all), SDXL, ElevenLabs TTS, Seedream, Recraft V4, Ideogram V3, Grok (image), Remove Background |
| `async_poll_runner` | Submit → poll → extract result | Sora 2, Veo 3, Runway (all), Kling (all), Wan 2.6, MiniMax (3-step), Luma Ray 2, LTX Video, Pixverse, Seedance, Moonvalley, Higgsfield, Grok (video), Replicate universal, FAL universal |
| `stream_runner` | SSE stream, accumulate chunks | GPT-4o/4.1/5, Claude (all), Gemini (all), OpenRouter (text) |

### MiniMax 3-Step Variant

MiniMax requires a distinct 3-step async flow:
1. `POST /v1/video_generation` → `task_id`
2. `GET /v1/query/video_generation?task_id={id}` → poll until `Success`/`Fail`
3. `GET /v1/files/retrieve/{file_id}` → actual video (1-second delay before step 3)

Implemented as a variant of `async_poll_runner`.

### WebSocket Events

```typescript
type ExecutionEvent =
  | { type: 'queued';       nodeId: string }
  | { type: 'executing';    nodeId: string }
  | { type: 'progress';     nodeId: string; value: number }
  | { type: 'stream_delta'; nodeId: string; delta: string; accumulated: string }
  | { type: 'executed';     nodeId: string; outputs: Record<string, PortValue> }
  | { type: 'error';        nodeId: string; error: string; retryable: boolean }
  | { type: 'validation_error'; errors: ValidationError[] }
  | { type: 'graph_complete'; duration: number; nodesExecuted: number }
```

### Temp URL Handling

After any node completes, the backend checks outputs for temporary URLs (OpenAI, Runway, Kling, MiniMax, Luma, etc.). Downloads to `./output/YYYY-MM-DD_HH-MM-SS/` immediately. Replaces URL with local file path before passing downstream or sending to frontend.

### Cancellation

Each running node gets a `CancellationToken`. Cancel via `POST /api/cancel/{node_id}`. For async-poll: stops polling. For sync: best-effort (won't pass results downstream).

### Caching (MVP)

- In-memory cache, resets on restart
- Key: `sha256(nodeType + params + inputs)`
- Any param or upstream change invalidates node + all downstream dependents

### Retry Policy

- 429 rate limits: exponential backoff (5 attempts, 0.1s–60s) via tenacity
- Fatal errors (invalid key, bad params): fail immediately
- Retryable vs fatal distinction surfaced in WebSocket error event

---

## API Key Management & Routing

### Storage

Keys stored in `settings.json` at project root (gitignored). No encryption for MVP — local-only tool.

```json
{
  "apiKeys": {
    "OPENAI_API_KEY": "sk-...",
    "FAL_KEY": "...",
    "ANTHROPIC_API_KEY": "sk-ant-..."
  },
  "routing": {
    "kling": "fal",
    "runway": "direct"
  },
  "outputPath": null,
  "executionMode": "manual",
  "batchSizeCap": 25
}
```

### API Key Security

Three layers prevent keys from being committed:
1. **`.gitignore`** — `settings.json`, `.env`, `output/` all gitignored
2. **`.env.example`** — ships with placeholder values only
3. **No keys in graph files** — `.nebula` files store params but never API keys. Keys resolved at execution time from `settings.json`.

### Dual Routing (FAL vs Direct)

Per-provider toggle in settings:
- **FAL mode:** Routes through fal.ai using `FAL_KEY`
- **Direct mode:** Uses provider's own API key and endpoint
- FAL-only models (Veo 3, Wan 2.6, LTX, Pixverse, Seedance, Moonvalley): warning badge if switched to Direct
- Direct-only models (OpenAI, Claude, Gemini, ElevenLabs, Ideogram): FAL toggle hidden

### Key Validation at Node Drop

When a node is added to canvas, frontend checks `settings.apiKeys` for required key. Missing key → warning badge on node header linking to settings. Execution blocked for that node.

### Settings Panel

Floating panel (toolbar gear icon):
- API key fields (masked input, paste-friendly)
- Per-provider routing toggle where applicable
- Output path override
- Batch size cap

---

## Edge Cases (Proactive Implementation)

### Graph Integrity

- **Cycle detection:** `isValidConnection` blocks cycles at drag time via `getOutgoers` traversal. Incompatible ports dim to 30%.
- **Orphaned edges:** `onNodesChange` filters edges on node remove events. Never relies on React Flow auto-cleanup.
- **Duplicate IDs on paste:** All IDs regenerated with uuid v4. Outputs cleared. Positions offset 20px.
- **Disconnected subgraphs:** If any node has `isOutputNode: true`, only its subgraph executes. Otherwise all subgraphs run independently.

### Pre-Execution Validation

- Required ports unconnected → red ring + tooltip, execution blocked
- Missing API key → warning badge, execution blocked
- Iterator batch > 25 items → confirmation modal with cost estimate

### Media Handling

- **Temp URLs:** Download immediately on node completion. Local path replaces URL before downstream pass.
- **Video format:** Auto-transcode to MP4 via ffmpeg if needed. Startup warning if ffmpeg not found.
- **Base64 size:** Images > 18MB auto-resized via Pillow before encoding.
- **SVG with embedded rasters:** Passed through as-is. Preview uses `<img src="data:image/svg+xml;base64,...">`.

### UX Safety

- **Undo/redo:** Graph structure and params only. Generated outputs never removed by undo. "Params changed — re-run to update" indicator when params change after execution.
- **Broken file paths on reload:** Validation pass checks file input nodes. Missing files get red border + error badge. Does not block loading rest of graph.

### Startup Checks

Run before canvas loads:
- ffmpeg available → warning banner if not (video conversion disabled)
- Output directory writable → error banner if not
- Banners are dismissable, not blocking modals

---

## Build Order

### Milestone 1 — Interactive Canvas (Steps 1-5)

1. Canvas viewport — pan, zoom, coordinate transforms via React Flow
2. Static node render — custom node component, hardcoded test nodes, ports visible
3. Edge drawing — bezier curves, port-to-port connections with type validation
4. Node drag — move nodes, edges follow
5. Rubber-band select — multi-select nodes and edges

### Milestone 2 — First Execution (Steps 6-9)

6. Topological sort + cycle detection on backend
7. First API call — `gpt-image-1-generate` as first sync node
8. WebSocket event bus — execution events to frontend
9. Node state indicators — visual states on node header

### Milestone 3 — Output & Patterns (Steps 10-13)

10. Execution cache — in-memory SHA256 cache
11. Output preview — image thumbnail in node, temp URL download
12. Async-poll pattern — Runway Gen-4 as first async node
13. Streaming pattern — Claude or GPT-4o with streamed text output

### Milestone 4 — Full Node System (Steps 14-18)

14. Utility nodes — text-input, image-input, preview, router, array-builder, etc.
15. Settings panel — API keys, routing, output path, batch cap
16. Dynamic Replicate node — schema fetch, auto-rendered params
17. Dynamic OpenRouter node — model list + capability detection
18. FAL universal node — generic endpoint runner

### Milestone 5 — Polish & Persistence (Steps 19-20 + post-MVP)

19. Save/load — export/import graph as `.nebula` JSON
20. Keyboard shortcuts — full table from spec
21. (Post-MVP) SQLite for execution cache + run history
22. (Post-MVP) UI theming / visual polish pass

Each milestone produces a working state. The app is usable after Milestone 2.

---

## Reference Documents

- `docs/perplexity-research/AI Node Editor — Architecture & Interaction Spec v2.md` — full data model, canvas interactions, execution engine, dynamic nodes, file structure
- `docs/perplexity-research/AI Node Editor — Complete Model & API Parameter Spec v2.md` — all 50+ models with parameters, ports, execution patterns
- `docs/perplexity-research/nebula-edge-cases.md` — pre-researched edge cases with working code solutions

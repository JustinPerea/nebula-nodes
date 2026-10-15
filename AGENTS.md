# Nebula Nodes — Agent Instructions

AI creation studio: FastAPI backend + React 19/Vite frontend around a node graph. 307 nodes, written in `frontend/src/constants/nodeDefinitions.ts` and mirrored in `backend/data/node_definitions.json`, which the backend and every script read. `scripts/export-node-defs.ts` writes the JSON from the TS, but four existing nodes (`gemini-tts`, `veo-3`, `gemini-omni-flash`, `quiver-arrow-generate`) carry JSON-only fixes it would undo, so check its diff before keeping it. `docs/MODEL_REFERENCE.md` is generated from it via `node scripts/generate-model-reference.mjs` — never edit it by hand.

## Standing task: Flora gap audit

We also produce content in Flora (app.flora.ai, via the `user-flora` MCP). Flora's catalog (~369 models) is a scouting list for Nebula's roadmap.

**Whenever you work in Flora and use or notice a model or capability that Nebula Nodes lacks as a first-class node, log it in `docs/flora-gap-audit.md` (Running Log table: date, gap, context, priority).**

Before logging, check it's a real gap:

1. Search `backend/data/node_definitions.json` — including `params` model enums. Several nodes are multi-model: `nano-banana` covers the whole Nano Banana family incl. Pro; `runway-video` covers Gen-4.5 / Gen-4 Turbo / Seedance 2.0 (+ Fast, Mini) / Seedance 2.5 / Happy Horse / Veo 3.1; `runway-image` covers Seedream 5.0 Pro / Lite (via Runway, a reseller); `minimax-*` covers Hailuo 2.3; the `veo-3` node is actually Veo 3.1. Route-table nodes cover one model on several providers: `flux-3-video`, `flux-video-edit` and `flux-video-upscale` also cover Krea's Flux 3 Video, Video Edit and Video Upscale, `krea-3` is Krea 3 on Krea or fal, and `flux-2-pro` ("FLUX.2") covers FLUX.2 Pro / Max / Flex / Klein 9B / Klein 4B on BFL or fal plus fal's Flash.
2. Reachability through universal nodes (`fal-universal`, `replicate-universal`, `openrouter-universal`, `nous-portal-universal`) does **not** count as coverage — log it anyway, noting the universal fallback.

The full baseline comparison (2026-07-25) lives in `docs/flora-gap-audit.md`. Known top gaps: Enhancor skin-realism i2i, audio-driven lipsync/avatar models, first/last-frame video category, Kling Pro/Edit/Motion tiers, Magnific/Topaz upscalers.

### Closing gaps (separate chat)

Implementation work to add missing nodes should run in a **dedicated Cursor chat** rooted on this repo, not mixed into Nari/Flora character sessions. Paste-ready kickoff: `docs/NEBULA-GAP-HANDOFF.md`.

## Other conventions

- Repo-backed agent skills live in `.agents/skills/` (indexed by the backend Codex runner). Keep them free of secrets and user outputs.
- Dual-route nodes (a fal or Krea copy that also runs on the maker's API with the person's key) pick their route through `backend/services/node_route.py` (mirrored by `frontend/src/lib/directRoute.ts`): Krea plan, else maker key, else the fal/Krea key. Krea maker routes are declared in `scripts/sync-krea-catalog.py` `DIRECT_ROUTES`; never hand-edit generated Krea nodes.
- One node per model, with a provider switcher in the node. A new model goes in as **one node with a `routes` table**, never one node per provider. The maker's own API is the first route (source-direct), then the other providers in the order Auto tries them. A hidden `_provider` param saves the choice (a route id, or `auto`: the first route whose key is set). Auto never switches provider because of a setting; the run stops and names the routes that could run it. Each route lists only the values and ranges that provider takes (`route_param_definitions` / `routeParamDefinitions`), and every route takes every default. Changing `_provider`, like `_kreaAuth`, is the person's call: agents propose it. Verify each route's request shape and price against the provider's own schema and pricing page (`backend/tests/fixtures/provider_schemas/`, `model_pricing.json` per-route entries, `unconfirmed` when the page isn't exact), and leave out what you can't verify. Only new nodes use `routes`; the dual-route nodes above stay as they are. A Krea catalog model that becomes a route of such a node goes in `FOLDED` in `scripts/sync-krea-catalog.py`, and saved graphs move over through `MERGED` in `backend/services/retired_nodes.py`. See `docs/PROVIDER-ROUTES.md`, and after changing a node's routes or params run `backend/.venv/bin/python scripts/generate-route-tables.py`.
- When adding a node, regenerate `docs/MODEL_REFERENCE.md` and check the corresponding entry off in `docs/flora-gap-audit.md` if it closes a logged gap.

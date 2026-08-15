# Nebula Nodes — Agent Instructions

AI creation studio: FastAPI backend + React 19/Vite frontend around a node graph. 168 nodes defined in `backend/data/node_definitions.json` (source of truth). `docs/MODEL_REFERENCE.md` is generated from it via `node scripts/generate-model-reference.mjs` — never edit it by hand.

## Standing task: Flora gap audit

We also produce content in Flora (app.flora.ai, via the `user-flora` MCP). Flora's catalog (~369 models) is a scouting list for Nebula's roadmap.

**Whenever you work in Flora and use or notice a model or capability that Nebula Nodes lacks as a first-class node, log it in `docs/flora-gap-audit.md` (Running Log table: date, gap, context, priority).**

Before logging, check it's a real gap:

1. Search `backend/data/node_definitions.json` — including `params` model enums. Several nodes are multi-model: `nano-banana` covers the whole Nano Banana family incl. Pro; `runway-video` covers Gen-4.5 / Seedance 2.0 / Happy Horse; `minimax-*` covers Hailuo 2.3; the `veo-3` node is actually Veo 3.1.
2. Reachability through universal nodes (`fal-universal`, `replicate-universal`, `openrouter-universal`, `nous-portal-universal`) does **not** count as coverage — log it anyway, noting the universal fallback.

The full baseline comparison (2026-07-25) lives in `docs/flora-gap-audit.md`. Known top gaps: Enhancor skin-realism i2i, audio-driven lipsync/avatar models, first/last-frame video category, Kling Pro/Edit/Motion tiers, Magnific/Topaz upscalers.

### Closing gaps (separate chat)

Implementation work to add missing nodes should run in a **dedicated Cursor chat** rooted on this repo, not mixed into Nari/Flora character sessions. Paste-ready kickoff: `docs/NEBULA-GAP-HANDOFF.md`.

## Other conventions

- Repo-backed agent skills live in `.agents/skills/` (indexed by the backend Codex runner). Keep them free of secrets and user outputs.
- When adding a node, regenerate `docs/MODEL_REFERENCE.md` and check the corresponding entry off in `docs/flora-gap-audit.md` if it closes a logged gap.

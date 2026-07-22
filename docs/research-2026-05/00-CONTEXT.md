# Nebula Nodes — Project Context for Research

> Paste this as the **first message** of every Claude (web or desktop) research session about Nebula Nodes. Each focused research prompt that follows references back to this document. Do not re-research anything documented here — cite it and move on.

**Today's date:** 2026-05-12
**Repo:** https://github.com/JustinPerea/nebula-nodes (public, AGPL-3.0)
**Author:** Justin Perea — portfolio destination is https://justinperea.com
**Status:** Active build. Slava-Restraint UI polish landed and reached a case-study checkpoint; Higgsfield-Canvas gap research started 2026-05-10 with a Style Reference node plan written but unimplemented. Working tree has uncommitted polish on `main`.

---

## North star — read this first

**Nebula Nodes is being built as an open-source, better version of [Flora AI](https://www.florafauna.ai).** Flora is the primary reference product; everything in this doc is in service of that goal.

- **Floor:** full capability parity with what Flora ships today (every node type, every workflow, every mode the Flora canvas supports).
- **Ceiling:** "better than Flora" — primarily via the things Flora can't do as a closed-source hosted SaaS: open-source (AGPL-3.0), BYOK against your own provider accounts (no platform markup), local-first execution, full graph + output ownership, extensibility.
- **Lost differentiator (recent):** Nebula's chat-driven canvas (Daedalus on Hermes Agent + Kimi K2.6) was a real moat when Flora didn't have agent chat. **Flora has since added agent chat too**, so chat-driven canvas is now table stakes, not a moat. Daedalus still ships; the work to make it materially better than Flora's agent (longer-horizon planning, per-model skill graph, vision-QA discipline, learnings persistence) is part of the "better" thesis.
- **Earlier prior research targeting Higgsfield Canvas as the gap-close reference (2026-05-10) was aimed at the wrong product.** Higgsfield is a useful secondary reference but Flora is the north star. Plans derived from that research (`.planning/style-reference-node-PLAN.md`) should be re-evaluated against Flora's surface before implementation.

---

## What it is in one paragraph

Nebula Nodes is a local-first, BYOK (bring-your-own-keys) visual node-based AI pipeline editor. A FastAPI backend (port 8000) topologically sorts a DAG of generative-AI nodes, streams per-node execution events back over a WebSocket to a React 19 SPA (port 5173) built on `@xyflow/react`. The catalog wraps **100 model nodes** plus four universal nodes (OpenRouter, Nous Portal, Replicate, FAL) — image, video, 3D, audio, text. The same canvas can be driven by chat: **Daedalus**, a Hermes Agent (Nous Research) persona running on Kimi K2.6 (or any Hermes-supported provider), spawns as a subprocess per turn and operates the canvas through a `nebula` Python CLI invoked via Hermes's `terminal` tool. The repo shipped to `v0.1.0-hackathon` for the **Hermes Agent Creative Hackathon 2026** as a Kimi-track and Main-track entry.

---

## Stack & file landmarks (so research can reference them)

**Frontend** — React 19 + Vite + TypeScript + `@xyflow/react` + Zustand
- `frontend/src/components/Canvas.tsx` — React Flow canvas wrapper
- `frontend/src/components/panels/ChatPanel.tsx` — chat agent UI (1,911 lines)
- `frontend/src/components/panels/{Inspector,Settings,NodeLibrary,Toolbar,AgentLog,NodeInspectorPopover,PanelLaunchers}.tsx`
- `frontend/src/components/nodes/{ModelNode,DynamicNode,RerouteNode,MeshPreview}.tsx`
- `frontend/src/components/edges/TypedEdge.tsx`
- `frontend/src/store/{graphStore,uiStore}.ts` — `graphStore` is 1,237 lines, single source of truth for nodes/edges/execution status
- `frontend/src/styles/slava-restraint.css` — default skin
- `frontend/src/styles/hermes.css` — Daedalus skin (still selectable)

**Backend** — FastAPI + httpx + Pydantic
- `backend/main.py` — 1,694 lines, all routes + WebSocket handlers
- `backend/execution/engine.py` — topological execution (680 lines)
- `backend/execution/sync_runner.py` — handler registry + endpoint routing for universal nodes (579 lines)
- `backend/execution/{stream_runner,async_poll_runner}.py`
- `backend/handlers/*.py` — one file per provider: `anthropic_chat`, `openai_chat`, `openai_image`, `openai_image_v2` (gpt-image-2 family), `openai_image_edit`, `openai_audio`, `google_gemini`, `runway`, `veo`, `fal_universal`, `openrouter`, `replicate_universal`, `meshy`, `minimax`, `higgsfield`, `grok_video`, `elevenlabs`, `nous_portal`
- `backend/services/{hermes_session,narrator,chat_actions,chat_session,cli_graph,nous_auth,settings,cache,output,zoom_manifest,node_registry,model_cache,hermes_verbose_parser}.py`
- `backend/data/node_definitions.json` — 9,994 lines, **100 node definitions**
- `backend/cli/__main__.py` + `backend/cli/commands/{graph,execute,nodes,keys,quick,path,context}.py` — `nebula` Python CLI (argparse)

**Daedalus persona + skill** (copied to `~/.hermes/profiles/daedalus/` during user setup)
- `.hermes/profiles/daedalus/SOUL.md` — identity contract (~30 lines)
- `.hermes/skills/daedalus-core/SKILL.md` — playbook (~350 lines): iterative-loop discipline, vision-QA rules, nebula CLI cookbook, learnings flow, autonomy modes (auto / step-approval)
- `.claude/skills/{fal,gemini,gpt-image-2,meshy,runway}/` — model-family skills installed alongside `daedalus-core`

**Themes**
- `themes/daedalus/` — TDR × Marathon Hermes Agent dashboard skin (standalone drop-in deliverable)
- `themes/slava-restraint/` — `DESIGN.md`, `DOT_MATRIX_AESTHETIC.md`, `CASE_STUDY.md` (current default skin)

**Demo + portfolio**
- `docs/demo/nebula-nodes-demo-720p.mp4` — 2:07 stitched demo (full 1080p MP4 on the `v0.1.0-hackathon` GitHub release)
- `docs/portfolio-motion-suite.md` — 15 shipped Slava-Restraint micro-interactions, each with curve + property + rationale
- `scripts/puppeteer-driver/` + `scripts/voiceover/` — scripted-build → voiceover (ElevenLabs Brian) → music (ElevenLabs v1) → ffmpeg stitch pipeline

**Docs already written — cite, don't re-do**
- `README.md` — top-level overview, demo scrub guide, model table, Mermaid architecture diagram, BYOK section
- `FORjustin.md` — author-facing "living doc" explaining architecture decisions, bugs hit, lessons
- `docs/HERMES-SETUP.md` — full Daedalus install path (Nous Portal / OpenRouter / other Hermes provider)
- `docs/MODEL_REFERENCE.md` — 44 KB model reference. **Says "77 nodes" — outdated, current count is 100.**
- `docs/perplexity-research/` — original April 2026 spec set (`AI Node Editor — Architecture & Interaction Spec v2.md`, `AI Node Editor — Complete Model & API Parameter Spec v2.md`, `nebula-edge-cases.md`, `nebula-gap-analysis.md`)
- `docs/contracts/`: platform-neutral provider contracts; normative for iPad/browser/Mac parity
- ~~`docs/superpowers/`~~: removed 2026-07-22 (historical milestone plans; superseded by `docs/contracts/`)
- `docs/model-providers/{google,hunyuan,meshy,openai}/*.md` — two-file split (canonical reference + Nebula integration notes) added 2026-05-10; **rest of providers not yet migrated**
- `themes/slava-restraint/CASE_STUDY.md` — full case study of the UI system pass
- `.planning/style-reference-node-PLAN.md` — unimplemented plan for the Higgsfield-gap-close first node
- `.planning/handoff-2026-04-{17,18,20}.md` — three deep handoffs (FAL gap report → chat panel v1 → cli_graph round-trip)
- `.planning/backlog/{chat-panel-followups,fal-catalog-automation,meshy-single-image-params}.md` — three parked items
- `.planning/fal-node-gap-report.md` — full FAL audit from 2026-04-17
- `HANDOFF-2026-05-09-slava-checkpoint.md` — most recent handoff covering Slava default-skin checkpoint

---

## Catalog snapshot (100 nodes)

**Image** — gpt-image-1 / gpt-image-1-edit / gpt-image-2-generate / gpt-image-2-edit (+ FAL variants of gpt-image-2), DALL-E 3, Imagen 4, Nano Banana (`gemini-3.x-flash-image-preview` / `gemini-3-pro-image-preview`), FLUX 1.1 Ultra, FLUX 2 Pro, FLUX Kontext, FLUX Schnell, Fast SDXL, Seedream 4.5, Recraft V4 (raster + SVG)
**Video** — Sora 2 (direct + FAL), Veo 3, Runway Gen-4 Turbo / Aleph / Act-Two, Kling V2.1 / V3 / Omni 3, Wan 2.6 (t2v / i2v / r2v), Luma Ray 2 (t2v / i2v), LTX 2 / 2.3, Pixverse V4.5, Seedance V1.5 / 2.0 / 2.0-fast, MiniMax Hailuo, Higgsfield, Moonvalley, Grok Imagine
**3D** — Meshy v6 text-to-3D / image-to-3D / multi-image-to-3D (direct + FAL), Hunyuan3D v3 text-to-3D / image-to-3D (still on v3 — v3.1 Pro / Rapid endpoints exist on FAL but unimplemented in Nebula)
**Audio** — ElevenLabs TTS / SFX / STS / Isolation / Dubbing, OpenAI TTS / STT / Translate, Gemini TTS, Gemini Embeddings
**Text** — Claude Chat, GPT-4o Chat, Gemini Chat, OpenRouter Universal, Nous Portal Universal
**Utility** — Text Input, Image Input, Preview, Combine Text, Router, Reroute, Array Builder, Array Selector, Iterator (image/text), Sticky Note, Frame Extractor, SVG Rasterize, Remove Background, SeedVR2 Upscale, image-compare

Universal/dynamic nodes resolve their port + param schema at configure-time by fetching the model's metadata via `/api/{openrouter,replicate,fal,nous}/models` proxies. Their port definitions live in `node.data.dynamicInputPorts` / `dynamicOutputPorts`.

---

## Daedalus in one paragraph

Daedalus is a master-craftsman persona on top of Hermes Agent. The user types in the chat panel; the backend's `hermes_session.py` spawns `hermes-daedalus chat …` for that turn, parses Hermes verbose-mode output, and streams Daedalus's prose (`content` field) and canvas actions back to the chat panel over `/ws/chat`. Daedalus's playbook (`daedalus-core/SKILL.md`) enforces: build one stage at a time, vision-analyze every output, iterate by adding new nodes (never overwriting), narrate before every tool call into `content` not `reasoning_content`, save graph state every turn. Hermes's `terminal` tool lets Daedalus call `nebula create/connect/run/graph/path/save/load` like a human at a shell — `nebula quick` is hard-gated by env (`NEBULA_DISABLE_QUICK=1`) so Daedalus is forced to go through the cli_graph round-trip. A narrator-fallback (`narrator.py`) catches Kimi K2.6's empty-`content`+`tool_calls` failure mode and re-narrates buffered canvas actions via a single-shot OpenRouter call. Daedalus has its own learnings file (`daedalus-learnings/LEARNINGS.md` inside the Hermes sandbox) that persists across sessions.

The original chat agent is **Claude** (`backend/services/chat_session.py`, wraps `claude -p --resume <sid>`). Daedalus is opt-in via the agent picker in the chat panel; Claude remains the default.

---

## Recent state (2026-05-09 → 2026-05-12)

- **Branch:** `main`. Recent commits cluster on node UI cleanup: `c2a5a5c Refine node UI cleanup`, `43b1ae5 Clean up model tool registry audit`, `cfb81b6 Automate utility node regression checks`, `e09dfbe Refine node panel and connection UX`, `a7c7e4c add utility node test checklist`.
- **Repo moved** 2026-05-09 from `~/Documents/Projects/nebula_nodes` to `~/Documents/Workspace/Projects/nebula_nodes` so Daedalus stays resident alongside actively-authored work.
- **Slava-Restraint** became the default skin and reached a case-study checkpoint with 15 motion shipments, screenshot regression suite (`output/slava-screenshot-check/`), CSS scope guards, and reduced-motion fallbacks. Daedalus skin still selectable.
- **Higgsfield Canvas gap research** completed 2026-05-10 (see activity log + `nebula_nodes/.planning/style-reference-node-PLAN.md`). Output: prioritized 5-step build order (1. Style Reference, 2. Variation Fan-Out, 3. Masked Edit + brush UI, 4. Identity Token, 5. templates/library/collab — skip). Step 1 plan written, not implemented.
- **Provider docs migration** started 2026-05-10: `docs/model-providers/{google,hunyuan,meshy,openai}/*.md` introduce a two-file split — canonical shared reference + Nebula-specific integration notes. Migrated providers carry `verified: 2026-05-10` and `stale_after_days: 14` frontmatter. Remaining providers (FAL, Runway, Anthropic, ElevenLabs, Replicate, MiniMax, Higgsfield, xAI, BFL, Recraft, Luma, Kling, ByteDance/Seedance, Moonvalley, Pixverse) are not yet in this format.
- **Uncommitted working tree on main:** README front matter added; small polish to `Canvas.tsx`, `DynamicNode.tsx`, `ModelNode.tsx`, `NodeLibrary.tsx`, `uiStore.ts`, `layouts.css`, `panels.css`, `slava-restraint.css`; new `style-reference-node-PLAN.md` and `docs/model-providers/` directory.

---

## What's known to be unclear / gappy (the research scope)

These are the open questions the focused research chunks will close. Each prompt picks one cluster and drills in. Numbering matches the eventual deliverable filenames (`01-…`, `02-…`, etc.) so future sessions can reference them.

1. **Flora AI capability audit + Nebula gap matrix.** Full inventory of every node type, every mode, every workflow, every product surface Flora ships today. Then a Nebula-side gap matrix: column 1 = Flora feature, column 2 = Nebula state (full / partial / missing / different-shape), column 3 = effort to close (S/M/L), column 4 = whether matching it is required-for-parity or skippable. **This is the primary input to every other chunk's prioritization.**
2. **Broader competitive landscape — "better than Flora" inputs.** Secondary references: Higgsfield Canvas, Krea AI (Canvas / Realtime / Stages), ComfyUI, Figma Weave, InvokeAI, fal Workflows, Replicate Playground, n8n, others discovered during research. What does each do that **Flora doesn't** that's worth absorbing? Not every feature; just the ones that meaningfully extend the "better than Flora" thesis given OSS+BYOK+local constraints.
3. **Model catalog freshness.** What's actually current as of 2026-05-12 across OpenAI / Google / Anthropic / FAL / Runway / ElevenLabs / MiniMax / Higgsfield / Meshy / xAI / Recraft / BFL / Luma / Kling / ByteDance / Moonvalley / Pixverse / Hunyuan? Provider docs migration was started May 10 but most providers haven't been refreshed yet. **Flora's model catalog is one input to this — if Flora wraps a model Nebula doesn't, that's a parity gap.**
4. **Nous Research / Hermes Agent ecosystem state.** Hermes Agent latest version + changelog since v0.10, Nous Portal catalog and pricing, Kimi K2.6 vs K3 (or 2.7+) trajectory, community Hermes profiles / skill marketplace. Drives how much further Daedalus can be pushed beyond Flora's agent.
5. **Cost model.** 5 canonical pipelines × current vendor pricing → per-run USD + time estimates. Needed to make the BYOK story honest in marketing copy ("Flora charges X for this graph; on Nebula your provider bill is Y").
6. **Architectural decision records.** The "why" behind React Flow / FastAPI / Zustand-split / REST+WS / dual-param vs separate-node / `nebula quick` hard-gate / AGPL-3.0 / Claude+Daedalus duo / local-BYOK — decisions made implicitly, never written down as ADRs. Lower priority unless Flora parity work demands rethinking one.
7. **Portfolio narrative.** How does this become a `justinperea.com` case study? Demo video exists; Slava case study exists; the "open-source Flora AI" story tying them together doesn't exist yet.
8. **Recommended roadmap.** Synthesis across §1–§7 into a prioritized table — what closes the Flora gap fastest (parity track), what differentiates fastest (better-than track), what's parked. Lands as `08-recommended-roadmap.md`.

Side question, lower priority: **Hackathon outcome.** Was the Hermes Agent Creative Hackathon 2026 judged? Public results / leaderboard / gallery? Worth a small section inside chunk 4 (Nous ecosystem) rather than its own chunk.

Parallel **code-health gaps** (listing here so they're not lost; some are likely Flora-parity items in disguise, which chunk 1 will resolve):

- Helper / reference library (palettes, prompt templates, reference images Claude + nodes can both read) — design spike parked 2026-04-19, re-confirmed by user. **Likely Flora-parity work: Flora has a workspace assets / reference panel.**
- Auto-layout for chat-created graphs — parked. **Likely Flora-parity work.**
- UUID-node → cli_graph sync (drag-to-chat v2 leftover) — open.
- `nebula discover-fal` (auto-generate node defs from FAL schemas) — parked.
- Hunyuan3D v3.1 Pro / Rapid endpoints — unimplemented (still on v3).
- Meshy single-image params gap (`pose_mode`, `enable_rigging`) — parked.
- BYOK end-to-end audit — proposed twice, never done.
- Node-correctness "last successful run per node" matrix (100 nodes, dogfood coverage unknown).
- Skill-table drift lint (`sync_runner.py` ↔ `SKILL.md` routing tables).
- Filesystem hygiene: `mydatabase.db` (0 bytes), `temp_vision_images/`, shadow `.claude/skills/{fal,gemini,meshy,runway} 2/` directories.
- `MODEL_REFERENCE.md` says "77 nodes" — outdated (actual: 100).
- README claim drift — two cleanup commits already (`d58abf1`, `30d79e8`); no audit since.
- Backend has no hot-reload — flagged as quirk, never fixed.
- `gpt-image-2` structured-exception refactor — deferred until FAL streaming lands.

---

## Research discipline for every output

1. **Canonical sources only for facts.** Vendor docs, official GitHub repos, dated official blog posts. WebSearch discovers URLs; WebFetch extracts facts. Snippets, dev.to summaries, content-farm articles signal something exists — they are NOT proof of behavior.
2. **Cite every claim** with a URL and the access date in `(YYYY-MM-DD)` form.
3. **Mark uncertainty explicitly.** If a vendor docs page is unreachable, write `TODO verify — no canonical source reachable`. Do not paper over gaps with secondary material.
4. **Date-stamp the file** at the top of every deliverable.
5. **Cross-check version claims.** If you say "Hermes Agent v0.11 ships X", prove it from the official changelog or repo tag.
6. **No fabricated URLs.** If a URL is needed but not in hand, write `[URL needed]`.
7. **Speculation is allowed only in:** (a) portfolio narrative drafts, (b) "where does Nebula uniquely sit" synthesis, (c) roadmap prioritization. Everywhere else: cited facts.

---

## Output format expected

Each focused research chunk produces a single Markdown document with:
- H1 of the form `# NN — Title` and a `*Date-stamp: YYYY-MM-DD*` italic line directly under it.
- Self-contained sections under H2s. No "see other doc" dependencies between chunks unless explicit.
- Tables where comparison is the point. Prose where reasoning is the point.
- Inline citations as `[source label](url) (YYYY-MM-DD)`.
- Final section: **"Open questions / TODO verify"** listing every uncertainty surfaced during the session.

Deliverables will be saved as: `docs/research-2026-05/NN-slug.md` in the repo.

---

## Author working style

- Concise. No filler. No "I hope this helps."
- Tables for comparison; prose for reasoning. No emojis unless explicit.
- Opinions welcome where asked — restate the tradeoff, then pick.
- Skip throat-clearing intros ("In this document I will…"). Start with the answer.
- Cite the canonical source. If you can't, say so.

---

## How the next prompts will arrive

Each focused research chunk will arrive as a separate message after this context document. The format will be:

```
[chunk number] [slug]

Scope: <what's in / what's out>
Deliverable: docs/research-2026-05/NN-slug.md

<the actual research questions>
```

When you finish a chunk, hand back the Markdown document only — no preamble, no summary message. The chunk's filename in the deliverable line tells me where to save it.

# Node Input + API Contract Hardening - Goal Plan

> **Goal status:** Started 2026-05-16. Active. As of 2026-05-17: 60 of 100 nodes audited, 156 bugs fixed, 497 backend tests passing (up from 246 baseline), Phase 1 and Phase 3 complete. Phase 2 ~60% complete. Phase 4 unstarted.

## Goal

Nebula should treat node definitions as a product contract, not as loose UI copy. Every node needs a validated agreement across:

- frontend inputs and inspector controls
- backend node registry data
- execution handler routing
- API key requirements
- local utility execution
- generated/reference documentation

The immediate outcome is that bad node IDs, missing handlers, stale API keys, invalid ports, bad enum params, and frontend/backend registry drift fail fast in automated checks.

## Scope

### Phase 1 - Contract guardrails

- [x] Add an explicit local-node execution set for nodes handled inside `engine.py`.
- [x] Add registry contract tests for shape, port types, param types, enum options, handler coverage, frontend/backend ID parity, `.env.example` key coverage, and researched correction pins.
- [x] Add a reusable `scripts/check-node-contracts.mjs` audit script for non-Python checks and quick local runs.
- [x] Fix visible drift found by the first audit pass: `MESHY_API_KEY` in `.env.example`, and stale `MODEL_REFERENCE.md` node-count wording.

### Phase 2 - Full input/API audit

Status: 60/100 nodes audited as of 2026-05-17. Each audited family has a note under `docs/model-providers/<provider>/` with severity-tagged findings, canonical doc citations, and fixes.

- [~] Review all 100 nodes by provider family against canonical docs. **Done so far:** OpenAI direct (image 5, audio 3, chat 1), Anthropic (1), MiniMax (3), Higgsfield (1), xAI Grok (1), ElevenLabs (5), FAL universal + Kling (3) + LTX (2) + Wan (3) + Luma (3) + Recraft (2) + FLUX (5) + Seedance (6) + OpenAI passthroughs (5), Universal nodes (Replicate, OpenRouter, Nous — 3), Google (7). **Remaining (~40):** FAL misc (Sora, Moonvalley, Pixverse, RemoveBG, Seedvr2 — 5), Hunyuan3D (2), Meshy direct + via FAL (10), Runway (7), and node families needing real API keys (currently placeholders): MiniMax I2V smoke, Higgsfield + xAI Grok + ElevenLabs STS for live verification.
- [x] Normalize required vs optional ports, file vs URL params, array inputs, masks, reference media, and conditional fields — covered for every audited family.
- [x] Confirm each static FAL wrapper injects the correct endpoint and strips/normalizes params the endpoint does not accept — `fal-universal.md` audit established the contract; Kling/LTX/Wan/Luma/Recraft/FLUX/Seedance/OpenAI passthroughs all use it correctly post-audit.
- [x] Confirm direct-provider handlers map UI params to request bodies exactly — for all 14 audited families.
- [x] Add targeted handler tests for high-risk families: 251 net new structural body-shape tests across the audited handlers. Tests grew 246 → 497.

### Phase 3 - Generated docs

Status: complete 2026-05-17.

- [x] Replace hand-maintained `MODEL_REFERENCE.md` with a generated source-of-truth artifact. `scripts/generate-model-reference.mjs` reads `backend/data/node_definitions.json` + per-provider audit-note `verified:` frontmatter. `--check` mode wired into `scripts/check-node-contracts.mjs` and `tests/test_node_contracts.py` so future drift fails CI.
- [x] Include per-node inputs, outputs, params, API key, execution pattern, handler route, and provider-doc verification status — all present in the generated output (100 nodes, 8 categories, dual/triple-param table handling for flux-1-1-ultra, veo-3, meshy-text-to-3d, meshy-image-to-3d).
- [x] Add stale-after metadata for provider docs so old claims are easy to find — every audit note has `stale_after_days` frontmatter (14 for fast-moving providers, 30 for stable).

### Phase 4 - QuiverAI Arrow integration

Status: planned 2026-05-19. **Full plan: [.planning/backlog/quiverai-arrow-node-PLAN.md](../../../.planning/backlog/quiverai-arrow-node-PLAN.md).**

Replaces the original "UI quality pass" scope. Three of the four UX bullets from that scope (missing-key states, SVG affordances, cost hints) are exercised by the Quiver integration in passing; the orphaned bullet (param grouping) is dropped to a future polish phase.

- [ ] Ship `quiver-arrow-generate` (text + image refs → SVG, with SSE streaming).
- [ ] Ship `quiver-arrow-vectorize` (raster → SVG, with SSE streaming).
- [ ] Dynamic model discovery via `GET /api/providers/quiver/models` proxy (matches OpenRouter pattern), hardcoded fallback for offline / unkeyed use.
- [ ] Forward-compat hooks for `svg_edit` and `svg_animate` operations (advertised in `/v1/models` `supported_operations` but no endpoints yet).
- [ ] Audit notes under `docs/model-providers/quiver/` with `verified: 2026-05-19`, `stale_after_days: 14`.

Inspector-popover work shipped in `f6ceb15` (image-surface visibility patched 2026-05-19).

## Current findings

- Live registry has 100 nodes in `backend/data/node_definitions.json`. Frontend `NODE_DEFINITIONS` has matching 100 IDs.
- Runtime handler coverage is complete: 84 API-backed handlers plus 16 local utility nodes.
- `MODEL_REFERENCE.md` is now generated from the registry; future drift fails CI via `--check`.
- `.env.example` has all required keys including `MESHY_API_KEY`.

## Methodology lessons captured 2026-05-17

- **Live API smoke testing catches what mocked tests can't.** Two regressions slipped through structural-tested audits (ElevenLabs PCM saved as `.wav` without header; Google nano-banana `responseFormat.image` rejecting natural value strings). Both caught only when we hit the live API. Tests can pin incorrect behavior if the audit subagent doesn't catch the wrongness.
- **Public docs can be stale.** Google's image-generation docs page describes `responseFormat.image.aspectRatio = "1:1"` as the canonical path; the live v1beta API rejects that value. Direct curl is the only reliable check when an audit changes a request body shape.
- **Proto enum values differ from natural strings.** Lyria-3 `responseFormat.audio.mimeType` accepts `AUDIO_WAV` (proto enum form), not `"audio/wav"` (MIME string). Public docs ambiguity caught only by trying values against the API.

## Verification command

```bash
node scripts/check-node-contracts.mjs
```

Backend test coverage also includes the same core contract checks:

```bash
cd backend
python3 -m pytest tests/test_node_contracts.py
```

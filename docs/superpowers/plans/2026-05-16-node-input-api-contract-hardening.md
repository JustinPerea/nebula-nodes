# Node Input + API Contract Hardening - Goal Plan

> **Goal status:** Started 2026-05-16. Active. As of 2026-05-19: 88 of 88 API-backed nodes have a structural audit note under `docs/model-providers/`. 633 backend tests passing (246 baseline + 387 net new across the audit + Phase 4). Phases 1, 3, and 4 complete. Phase 2 **structural audit complete**; remaining gate is **live-smoke verification** for ~21 nodes across 6 families (see Phase 2 below).

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

Status: **structural audit complete** for all 88 API-backed nodes as of 2026-05-19. Each audited family has a note under `docs/model-providers/<provider>/` with severity-tagged findings, canonical doc citations, and fixes. The remaining work is the **live-smoke gate** — verifying request/response shapes against the actual API rather than just the docs. See `## Phase 2 live-smoke status` below for what's verified vs pending.

- [x] Review all 88 API-backed nodes by provider family against canonical docs. Coverage: OpenAI direct (image 5, audio 3, chat 1), Anthropic (1), MiniMax (3), Higgsfield (1), xAI Grok (1), ElevenLabs (5), FAL universal + Kling (3) + LTX (2) + Wan (3) + Luma (3) + Recraft (2) + FLUX (5) + Seedance (6) + OpenAI passthroughs (5) + misc (Sora, Pixverse, RemoveBG, Seedvr2 — Moonvalley deprecated 2026-05-19), Hunyuan3D (2), Meshy direct + via FAL (10), Runway (7), Quiver (2), Universal nodes (Replicate, OpenRouter, Nous — 3), Google (7).
- [x] Normalize required vs optional ports, file vs URL params, array inputs, masks, reference media, and conditional fields — covered for every audited family.
- [x] Confirm each static FAL wrapper injects the correct endpoint and strips/normalizes params the endpoint does not accept — `fal-universal.md` audit established the contract; Kling/LTX/Wan/Luma/Recraft/FLUX/Seedance/OpenAI passthroughs/misc all use it correctly post-audit.
- [x] Confirm direct-provider handlers map UI params to request bodies exactly — for all audited families.
- [x] Add targeted handler tests for high-risk families: 387 net new structural body-shape tests across the audited handlers (246 baseline → 633 with Phase 4).
- [ ] **Live-smoke gate:** verify request/response shapes against the actual API for the families that have not yet had a live-smoke pass. See live-smoke status below.

## Phase 2 live-smoke status

Live-smoke testing has caught at least four post-structural-audit bugs that structural tests pinned wrong (PCM-as-WAV header, Google responseFormat enum, FAL duration integer-vs-string, Runway ratio enum). Treating it as a separate completion gate.

| Family | Structural | Live-smoke | Notes |
|---|---|---|---|
| OpenAI image/audio/chat | done | done (TTS PCM, image edit) | |
| Google (Gemini, Lyria, etc.) | done | done | responseFormat + Lyria MIME caught on smoke |
| FAL (Sora, Pixverse) | done | done | duration int-vs-string caught on smoke |
| Runway (image, video) | done | done | ratio 720:1280 caught on smoke |
| ElevenLabs TTS | done | done | PCM/WAV header caught on smoke |
| ElevenLabs SFX | done | done | |
| ElevenLabs Isolation | done | done | |
| ElevenLabs Dubbing | done | done | |
| Quiver (arrow-generate, arrow-vectorize) | done | done | Phase 4 |
| Anthropic Claude Chat | done | done | |
| MiniMax T2V | done | done | |
| FAL families (Kling/LTX/Wan/Luma/Recraft/FLUX/Seedance/openai-passthroughs) | done | partial | one node per family smoked; remaining inherit `fal-universal` contract |
| ElevenLabs STS | done | done (2026-05-19) | voice_settings JSON multipart + seed verified via `backend/scripts/smoke_elevenlabs_sts.py` |
| **MiniMax I2V / S2V** | done | **pending** | port-id mismatch fixed in audit (was silently falling through to T2V) — never smoked |
| **Higgsfield** | done | **pending** | base URL, auth scheme, all endpoints rewritten in audit |
| **xAI Grok video** | done | **pending** | endpoint URL + model ID + response shape all rewritten in audit |
| **Hunyuan3D (text-to-3d, image-to-3d)** | done | **pending** | FAL v3 endpoint; structural only |
| **Meshy direct (8 nodes)** | done | **pending** | `MESHY_API_KEY` is set in `settings.json` (not `.env`); tractable |
| **Meshy FAL-backed (2 nodes)** | done | **pending** | `meshy-text-to-3d`, `meshy-image-to-3d` |

Live-smoke remaining (tractable): ~27 nodes — Meshy direct (8), Meshy FAL (2), Hunyuan3D (2), plus per-family rotations on FAL families with non-default endpoints. ElevenLabs STS verified 2026-05-19.

Live-smoke blocked on missing API keys: MiniMax I2V/S2V (2), Higgsfield (1), xAI Grok (1) — keys absent from both `.env` and `settings.json` as of 2026-05-19. These need real keys before they can be verified.

**Key source note (added 2026-05-19):** API keys are stored in two places. `.env` carries some, but the canonical source is `settings.json` (`apiKeys` block) which the in-app Settings UI writes. The running uvicorn pulls from `settings.json`. Always check both before assuming a key is missing.

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

- Live registry has 103 nodes in `backend/data/node_definitions.json` (104 prior to 2026-05-19 — `moonvalley` deprecated, FAL endpoint returned 404 and Moonvalley no longer published a FAL surface). Frontend `NODE_DEFINITIONS` matches.
- Runtime handler coverage is complete: 86 API-backed handlers plus 17 local utility nodes (Style Reference added 2026-05-19).
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

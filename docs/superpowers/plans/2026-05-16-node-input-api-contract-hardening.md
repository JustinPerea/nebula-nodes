# Node Input + API Contract Hardening - Goal Plan

> **Goal status:** started 2026-05-16. This is the catalog-hardening pass prompted by the research + Obsidian synthesis: make the 100-node registry trustworthy before expanding the model catalog again.

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

- [ ] Review all 100 nodes by provider family against canonical docs.
- [ ] Normalize required vs optional ports, file vs URL params, array inputs, masks, reference media, and conditional fields.
- [ ] Confirm each static FAL wrapper injects the correct endpoint and strips/normalizes params the endpoint does not accept.
- [ ] Confirm direct-provider handlers map UI params to request bodies exactly.
- [ ] Add targeted handler tests for high-risk families: OpenAI image edit, FAL wrappers, MiniMax, Kling, LTX, Wan, Recraft, ElevenLabs, Higgsfield.

### Phase 3 - Generated docs

- [ ] Replace hand-maintained `MODEL_REFERENCE.md` with a generated source-of-truth artifact or add a generation script with a checked-in output.
- [ ] Include per-node inputs, outputs, params, API key, execution pattern, handler route, and provider-doc verification status.
- [ ] Add stale-after metadata for provider docs so old claims are easy to find.

### Phase 4 - UI quality pass

- [ ] Group advanced params consistently in the Inspector.
- [ ] Show missing-key and required-input states before run.
- [ ] Clarify array, mask, reference image/video, audio, and SVG bridge affordances.
- [ ] Add cost/risk hints where provider costs or long async times materially affect user decisions.

## Current findings

- Live registry has 100 nodes in `backend/data/node_definitions.json`.
- Frontend `NODE_DEFINITIONS` also has 100 IDs.
- Runtime handler coverage is currently complete: 84 API-backed handlers plus 16 local utility nodes.
- `MODEL_REFERENCE.md` is partial and stale relative to the live registry.
- `.env.example` was missing `MESHY_API_KEY` even though Meshy nodes require it.

## Verification command

```bash
node scripts/check-node-contracts.mjs
```

Backend test coverage also includes the same core contract checks:

```bash
cd backend
python3 -m pytest tests/test_node_contracts.py
```

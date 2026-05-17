# Agent Brief - Nebula Node Inputs + API Contract Fix

> Give this to an implementation agent. The job is a careful hardening pass, not a feature spree. The goal is to make Nebula's existing 100-node catalog trustworthy across UI inputs, backend execution, API request bodies, docs, and tests.

## Operating rules

- Do not add new model nodes until the current catalog contract is audited.
- Do not revert unrelated dirty worktree changes. Inspect `git status --short` first and stay scoped.
- Treat `frontend/src/constants/nodeDefinitions.ts` as the frontend source and `backend/data/node_definitions.json` as the exported backend registry. Keep them in sync.
- Prefer automated checks over manual confidence.
- Verify provider claims against canonical provider docs before changing API behavior.
- When a provider doc is unclear, mark the uncertainty in docs instead of guessing.
- Keep changes small by provider family. Finish one family, test it, then continue.

## Current baseline

As of 2026-05-16:

- Live registry: `backend/data/node_definitions.json` has 100 node definitions.
- Frontend registry: `frontend/src/constants/nodeDefinitions.ts` has matching IDs.
- API-backed handler coverage is complete: 84 handler-routed nodes.
- Local engine coverage is explicit via `LOCAL_EXECUTION_NODE_IDS` in `backend/execution/engine.py`: 16 local/utility nodes.
- Contract guardrails exist:
  - `scripts/check-node-contracts.mjs`
  - `backend/tests/test_node_contracts.py`
  - `backend/tests/test_elevenlabs_handler.py`
- First drift fixes already landed:
  - `MESHY_API_KEY` added to `.env.example`
  - `MODEL_REFERENCE.md` no longer claims "Complete reference for all 77 nodes"
  - ElevenLabs TTS now includes `use_speaker_boost`
  - `reroute` port labels are no longer blank

## Primary objective

Audit and fix every node so the following are true:

1. Inspector inputs match provider API parameters.
2. Required ports are actually required by the handler/API.
3. Optional ports do not block validation.
4. Enum values match current canonical API docs.
5. Defaults are safe and current.
6. Backend handlers map UI params to the correct request body fields.
7. FAL wrapper nodes inject the correct `endpoint_id`.
8. Local utility nodes handle data types consistently.
9. `MODEL_REFERENCE.md` or its replacement is generated from the live registry, not hand-maintained.
10. Contract checks catch future drift automatically.

## Non-goals

- Do not redesign the canvas UI.
- Do not add Flora-parity features yet.
- Do not implement new providers.
- Do not perform broad style refactors.
- Do not change app branding, screenshots, or portfolio copy.

## Recommended execution order

### Phase 0 - Confirm guardrails

Run:

```bash
node scripts/check-node-contracts.mjs
cd frontend && npm run build
cd ../backend && ./.venv/bin/python -m pytest tests/test_node_contracts.py tests/test_node_registry.py tests/test_elevenlabs_handler.py
```

Expected:

- Node contract check passes for 100 definitions.
- Frontend build succeeds.
- Focused backend tests pass.

If these fail before you make changes, stop and document the failure.

### Phase 1 - Registry shape audit

Review every definition for:

- `id` equals registry key
- useful `displayName`
- correct `category`
- correct `apiProvider`
- correct `apiEndpoint`
- correct `envKeyName`
- correct `executionPattern`
- non-empty input/output port labels
- valid port `dataType`
- correct `required`
- correct `multiple`
- correct params and enum values

The automated check covers basic shape. The manual audit should focus on semantic correctness.

Files:

- `frontend/src/constants/nodeDefinitions.ts`
- `backend/data/node_definitions.json`
- `scripts/check-node-contracts.mjs`
- `backend/tests/test_node_contracts.py`

### Phase 2 - Provider family audits

Work provider-by-provider. For each family:

1. Read the frontend node definitions.
2. Read the backend handler.
3. Read canonical provider docs.
4. Compare ports, params, defaults, enum values, endpoint IDs, request body mapping, and output parsing.
5. Patch the smallest set of files.
6. Add or update focused tests.
7. Run contract checks and relevant tests.

Suggested order:

1. OpenAI image/audio/chat
2. FAL wrappers and FAL universal
3. MiniMax
4. Kling
5. LTX
6. Wan
7. Luma
8. Recraft
9. ElevenLabs
10. Meshy
11. Higgsfield
12. xAI / Grok
13. Google / Gemini / Imagen / Nano Banana
14. Runway
15. Replicate / OpenRouter / Nous universal nodes

For each provider, add a short audit note under `docs/model-providers/<provider>/` or update the existing file if present.

### Phase 3 - FAL wrapper endpoint audit

For every static node that routes through `handle_fal_universal`, verify:

- The injected `endpoint_id` is current.
- UI params map to FAL schema keys.
- Stringified JSON params are parsed before submission where required.
- Empty optional fields are omitted, not sent as empty strings.
- Inputs use the correct request keys: `image_url`, `video_url`, `audio_url`, arrays, reference media, masks.
- Output parsing returns the correct Nebula port type.

Key file:

- `backend/execution/sync_runner.py`

High-risk wrappers:

- `kling-v3`
- `kling-o3`
- `ltx-video-2`
- `ltx-2-3`
- `wan-2-6-*`
- `luma-ray2-*`
- `seedance-*`
- `recraft-v4-*`
- `remove-background`
- `hunyuan3d-*`
- `gpt-image-2-fal-*`

### Phase 4 - Handler request-body tests

Add tests that assert the exact request body for high-risk nodes. Mock HTTP clients; do not hit real APIs.

Priority tests:

- OpenAI image edit: multiple images, optional mask, output format, background, input fidelity.
- MiniMax T2V/I2V/S2V: three-step async fields and subject reference mapping.
- FAL universal: endpoint injection and empty-param omission for static wrappers.
- Recraft SVG: SVG output parses to `SVG`, not `Image`.
- ElevenLabs TTS/STS/SFX: voice settings, output format query params, seed.
- Higgsfield: prompt/video payload shape and output parsing.

Existing patterns:

- `backend/tests/test_openai_handler.py`
- `backend/tests/test_openai_image_v2.py`
- `backend/tests/test_fal_handler.py`
- `backend/tests/test_elevenlabs_handler.py`

### Phase 5 - Inspector input UX pass

After API correctness is stable, improve the input UX without changing the visual system broadly.

Checklist:

- Required params and required ports are visually clear.
- Missing API key state names the exact key.
- Conditional params only appear when relevant.
- Advanced params are grouped consistently.
- File/URL inputs are distinct.
- Array inputs explain same-type constraints.
- Mask/SVG/Mesh/Audio/Video ports have clear labels.
- Long enum lists remain searchable or at least scannable.

Likely files:

- `frontend/src/components/panels/NodeInspectorPopover.tsx`
- `frontend/src/components/panels/NodeLibrary.tsx`
- `frontend/src/components/nodes/ModelNode.tsx`
- `frontend/src/components/nodes/DynamicNode.tsx`
- `frontend/src/styles/panels.css`
- `frontend/src/styles/slava-restraint.css`

Keep UI changes scoped and run:

```bash
cd frontend
npm run build
npm run check:node-contracts
```

### Phase 6 - Generated model reference

Replace manual docs drift with generation.

Preferred approach:

- Add `scripts/generate-model-reference.mjs`.
- Read `backend/data/node_definitions.json`.
- Emit `docs/MODEL_REFERENCE.md`.
- Include:
  - live node count
  - generated timestamp
  - category grouping
  - ID, display name, provider, API key, execution pattern
  - inputs and outputs
  - params, defaults, enum options
  - dual-param notes
  - handler route if known
  - provider-doc verification status if available

Then add a check:

```bash
node scripts/generate-model-reference.mjs --check
```

Wire that into `scripts/check-node-contracts.mjs` or document it as the docs drift check.

## Provider audit template

Use this template for each provider family:

```markdown
## Provider: <name>

Date: YYYY-MM-DD
Canonical docs checked:
- <URL> (accessed YYYY-MM-DD)

Nodes audited:
- `<node-id>` - status: pass / fixed / needs follow-up

Findings:
- ...

Changes made:
- ...

Tests added:
- ...

Open questions:
- ...
```

## Definition audit checklist

For each node:

- [ ] ID is stable and frontend/backend IDs match.
- [ ] Display name is user-facing and concise.
- [ ] Category is correct.
- [ ] Provider and env key are correct.
- [ ] Execution pattern matches handler behavior.
- [ ] Required input ports align with handler/API requirements.
- [ ] Optional ports do not fail validation when disconnected.
- [ ] Port labels are non-empty and understandable.
- [ ] Param defaults match safe/current provider defaults.
- [ ] Enum values exactly match accepted provider values.
- [ ] Param min/max/step are correct.
- [ ] Conditional params are represented with `condition` or `visibleWhen` where needed.
- [ ] Handler omits empty optional params.
- [ ] Handler converts strings to arrays/objects/numbers where needed.
- [ ] Output parser returns the intended Nebula port type.
- [ ] Missing key error names the right env var.
- [ ] Tests cover high-risk body mapping.

## Verification matrix

Run these before handing off:

```bash
node scripts/check-node-contracts.mjs

cd backend
./.venv/bin/python -m pytest tests/test_node_contracts.py tests/test_node_registry.py

cd ../frontend
npm run check:node-contracts
npm run build
```

Run targeted provider tests for anything you changed:

```bash
cd backend
./.venv/bin/python -m pytest tests/test_fal_handler.py
./.venv/bin/python -m pytest tests/test_openai_handler.py tests/test_openai_image_v2.py
./.venv/bin/python -m pytest tests/test_elevenlabs_handler.py
```

If touching UI interactions, also run the relevant browser/screenshot checks if the app can be started cleanly.

## Stop conditions

Stop and ask for direction if:

- Canonical provider docs conflict with current implementation in a way that changes user-visible behavior.
- A fix requires changing saved graph schema.
- A provider appears to have removed or renamed a model.
- A handler needs credentials to verify behavior and mocks are insufficient.
- Existing dirty files overlap the exact lines you need and the intent is unclear.

## Deliverable expectation

The agent should finish with:

- Summary of provider families audited.
- Files changed.
- Contract/test commands run and results.
- Any provider uncertainties with source links.
- Remaining follow-up list ordered by risk.

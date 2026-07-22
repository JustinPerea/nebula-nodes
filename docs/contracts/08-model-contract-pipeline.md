---
title: Nebula Contracts — Model contract pipeline (Volume 8)
status: draft
contract_version: 1
---

# Model contract pipeline (Volume 8)

Repeatable workflow for taking a **model, node, or handler family** from registry → gold exemplar → golden fixtures → parity tests.

Use this when onboarding a new provider route, a new FAL preset, or backfilling documentation for an existing node.

**Prerequisites:** Vol 0–3 ([00-meta.md](./00-meta.md), [01-node-schema.md](./01-node-schema.md), [02-handler-patterns.md](./02-handler-patterns.md), handler family doc).

---

## 1. Choose scope

Pick one unit of work — avoid “document all of FAL” in a single pass.

| Scope type | Example | Output |
|------------|---------|--------|
| **Single node** | `gemini-omni-flash` | 1 exemplar + 1+ fixtures |
| **Node pair** | `gpt-image-2-generate` + `gpt-image-2-edit` | 1 exemplar covering both |
| **Family wave** | All Google direct (`apiProvider: google`) | Family doc update + N exemplars |
| **Route variant** | `nano-banana` direct vs `nano-banana-fal` | 2 exemplars + comparison § |

**Rule:** One exemplar per node *or* per tightly coupled pair (generate/edit). FAL and direct routes always get separate exemplars.

---

## 2. Inventory what exists

### Automated

```bash
node scripts/contract-inventory.mjs
node scripts/contract-inventory.mjs --family google
node scripts/contract-inventory.mjs --family fal --json
```

Reports each registry node vs exemplar coverage vs golden fixtures.

### Manual checklist

| Source | What to read |
|--------|--------------|
| `backend/data/node_definitions.json` | Ports, params, `executionPattern`, `apiEndpoint` |
| `backend/execution/sync_runner.py` | Handler registry, wrappers, dual-route logic |
| `backend/handlers/<module>.py` | Request body builder, auth, output mapping |
| `backend/tests/test_*_handler.py` | Existing behavioral assertions |
| `docs/model-providers/<family>/` | Research audits (informative, not normative) |
| `docs/MODEL_REFERENCE.md` | Generated catalog for discovery |

Gap matrix:

| Artifact | Path | Required when |
|----------|------|---------------|
| Gold exemplar | `docs/contracts/examples/<slug>.md` | Every wired node/pair |
| JSON fixture | `contracts/fixtures/handlers/<family>/*.json` | Stable request body |
| SSE fixture | `contracts/fixtures/handlers/<family>/*.txt` | Stream handlers only |
| Parity test | `backend/tests/test_<family>_contract_fixtures.py` | Always (extends existing suite) |
| Family doc row | `docs/contracts/03-handler-families/<family>.md` | New node in family |

---

## 3. Find official docs

| Provider | Primary docs | Pricing |
|----------|--------------|---------|
| Google / Gemini | https://ai.google.dev/gemini-api/docs/models | https://ai.google.dev/gemini-api/docs/pricing |
| OpenAI | https://developers.openai.com/api/docs/models | https://developers.openai.com/api/docs/pricing |
| FAL | https://fal.ai/models | https://fal.ai/pricing |

**Process (from [00-meta.md](./00-meta.md) §9):**

1. Confirm model id and API surface on official docs (not blog posts).
2. Cross-check Nebula audit under `docs/model-providers/{family}/` if present.
3. Record `verified` and `pricing_verified` dates in exemplar frontmatter.
4. Set `stale_after_days: 30` — re-verify when stale.

---

## 4. Pick a template exemplar

Copy the closest existing gold exemplar by **execution pattern**, not provider:

| Pattern | Template |
|---------|----------|
| Sync JSON (image/audio) | [examples/nano-banana.md](./examples/nano-banana.md) or [examples/gpt-image-1.md](./examples/gpt-image-1.md) |
| Stream SSE (image) | [examples/gpt-image-2.md](./examples/gpt-image-2.md) |
| Stream SSE (chat) | [examples/gpt-4o-chat.md](./examples/gpt-4o-chat.md) or [examples/gemini-chat.md](./examples/gemini-chat.md) |
| Async-poll (FAL) | [examples/nano-banana-fal.md](./examples/nano-banana-fal.md) or [examples/gpt-image-1-5.md](./examples/gpt-image-1-5.md) |
| Async-poll (Google) | [examples/veo-3.md](./examples/veo-3.md) or [examples/gemini-omni-flash.md](./examples/gemini-omni-flash.md) |
| FAL stream passthrough | [examples/gpt-image-2-fal.md](./examples/gpt-image-2-fal.md) |

Required sections: see [00-meta.md](./00-meta.md) §6 “Gold exemplar standard”.

---

## 5. Write the exemplar

1. Create `docs/contracts/examples/<slug>.md` with YAML frontmatter (`kind: contract-exemplar`, `nodes:`, `oracle.tests:`).
2. Fill §2 Vol 1 from `node_definitions.json` (ports, params, enums).
3. Fill §3–§4 from handler source + official API mapping.
4. Document edge cases §6 (missing key, validation, dual-route).
5. Add §7 parity oracle pointing at fixture paths + pytest names.
6. Add §8 minimal graph JSON.
7. Add §9 comparison vs sibling route when useful.
8. Add §10 parameter matrix (official field ↔ Nebula param).
9. Add §11 porting checklist (actionable checkboxes).

**Do not** duplicate the full node list in family doc prose — link to exemplar.

---

## 6. Capture golden fixtures

Golden fixtures are **oracle bytes** — web pytest is authoritative.

### JSON request bodies

1. Add scenario to `backend/tests/test_<family>_contract_fixtures.py` → `_capture_*_body(fixture_name)`.
2. Run capture once to verify:

```bash
cd backend && python -m pytest \
  tests/test_google_contract_fixtures.py::test_google_request_body_matches_fixture[new-fixture.json] -q
```

3. Write file to `contracts/fixtures/handlers/<family>/<node>-request.json`.
4. Include `_comment` with oracle test name.
5. Sync copy to `backend/tests/fixtures/<family>/` if legacy tests reference it.

### SSE streams

1. Build minimal valid SSE from official format or existing test helper.
2. Place in `contracts/fixtures/handlers/<family>/<node>-sse.txt`.
3. Add `test_<family>_contract_sse_fixtures.py` test that loads file and asserts accumulated text / partial count / final path.

**Tip:** Reuse handler test helpers (`_make_gemini_sse_lines`, etc.) to generate the file once, then freeze bytes.

---

## 7. Wire parity tests

| Suite | File | Parametrize over |
|-------|------|------------------|
| Google JSON | `test_google_contract_fixtures.py` | `handlers/google/*.json` |
| Google SSE | `test_google_contract_sse_fixtures.py` | named tests per `.txt` |
| OpenAI JSON | `test_openai_contract_fixtures.py` | `handlers/openai/*.json` |
| OpenAI SSE | `test_openai_contract_sse_fixtures.py` | named tests per `.txt` |
| FAL JSON | `test_fal_contract_fixtures.py` | `handlers/fal/*.json` |
| FAL SSE | `test_fal_contract_sse_fixtures.py` | named tests per `.txt` |

CI expectation: all parity tests pass on PRs touching handlers or fixtures.

---

## 8. Update indexes

| File | Action |
|------|--------|
| `docs/contracts/03-handler-families/<family>.md` | Add node row + exemplar link |
| `contracts/fixtures/README.md` | Add fixture → test mapping |
| `docs/contracts/00-meta.md` §6 coverage line | Bump date + scope note |
| `docs/contracts/README.md` | Link new exemplar if notable |
| `docs/contracts/02-handler-patterns.md` §9 | Add exemplar to pattern table if new pattern |

Regenerate if needed:

```bash
node scripts/generate-model-reference.mjs
node scripts/check-node-contracts.mjs
```

---

## 9. Verify done

A model contract is **complete** when:

- [ ] Gold exemplar exists with all §1–§11 sections
- [ ] Family doc links exemplar
- [ ] JSON fixture(s) for stable request shape (if applicable)
- [ ] SSE fixture(s) for stream handlers
- [ ] Parity pytest green
- [ ] `node scripts/contract-inventory.mjs` shows `exemplar:yes` for the node
- [ ] `pricing_verified` date set

---

## 10. Agent playbook (single prompt)

When delegating to an agent:

```text
Contract wave: <family or node id>

1. Run: node scripts/contract-inventory.mjs --family <family>
2. For each MISSING row:
   - Read handler + node_definitions entry
   - Check official docs + docs/model-providers/<family>/
   - Copy template from docs/contracts/08-model-contract-pipeline.md §4
   - Write exemplar + fixtures + capture tests
3. Update family doc + contracts/fixtures/README.md
4. Run parity pytest suites
5. Report inventory before/after
```

---

## 11. What stays out of scope

| Item | Where it lives |
|------|----------------|
| Prompt craft / user guides | `docs/api-guides/` |
| iPad port inventory | `docs/ipad-conversion/NODE-CONTRACT-AUDIT.md` (generated) |
| Full model catalog | `docs/MODEL_REFERENCE.md` (generated) |
| Historical research | `docs/model-providers/` (source material only) |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-01 | Initial pipeline doc + `scripts/contract-inventory.mjs` |

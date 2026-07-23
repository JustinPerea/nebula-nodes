---
title: Nebula Contracts — Meta
status: draft
created: 2026-07-01
contract_version: 1
---

# Nebula Contracts — Meta (Volume 0)

This document defines **what a Nebula contract is**, **what changes over time**, and **how ports (iPad, browser, Mac) stay structurally aligned** with the web reference implementation.

It does not list individual models or nodes. Those live in data files and generated catalogs.

**Audience:** agents and engineers **translating contracts into other languages** — Swift handlers, TypeScript clients, shared event types — not agents learning how to operate Nebula day-to-day.

---

## 1. Problem we're solving

Nebula has one creative engine (graph + handlers + events) and multiple surfaces:

| Surface | Implementation today | Target relationship |
|---------|---------------------|---------------------|
| **Web** | `frontend/` + `backend/` | Reference implementation (oracle) |
| **iPad** | Planned Swift (`ipad/`) | Contract-compliant port |
| **Mac** | Planned shell + bundled Python or shared core | Contract-compliant port |
| **Browser** | Same stack as web | Must match contract, not re-derive from UI |

Without a shared contract layer, every port re-reads Python handlers and React components ad hoc and drifts. Provider catalogs also churn (new models weekly). We separate **stable rules** from **volatile data** so a porting agent can implement **one layer at a time** with parity fixtures, not synthesize the whole repo per task.

---

## 2. Three tiers of truth

```text
┌─────────────────────────────────────────────────────────────┐
│  TIER A — Rules (docs/contracts/*.md)                       │
│  Changes rarely. Version bumps when shape/semantics change. │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  TIER B — Registry (backend/data/node_definitions.json)   │
│  Changes often. New nodes, params, providers, endpoints.    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  TIER C — Generated + audits                                │
│  MODEL_REFERENCE.md, NODE-CONTRACT-AUDIT.*, future schemas  │
│  Never edit by hand. Regenerate from Tier A + B.            │
└─────────────────────────────────────────────────────────────┘
```

### What changes when new models ship?

| Artifact | Changes on every new model? | Why |
|----------|----------------------------|-----|
| `node_definitions.json` | **Yes** | New node id, params, endpoint |
| `docs/MODEL_REFERENCE.md` | **Yes** (regenerated) | Human catalog |
| `03-handler-families/<provider>.md` | **Sometimes** | Only if new *rules* (auth, routing, param mapping). Adding another FAL preset usually does **not** need a doc edit — update registry + preset table |
| `01-node-schema.md` | **No** | Unless we add a new port type, param type, or execution pattern |
| `02-handler-patterns.md` | **No** | Unless we invent a new pattern (e.g. webhook callback) |
| `04-graph`, `05-api`, `06-platform` | **No** | Unless graph/API shape changes |
| `00-meta.md` (this file) | **Rarely** | Process/version policy only |

**Rule:** New models are **data changes** (Tier B). Contract docs (Tier A) change only when we change **how** nodes or handlers work in general.

---

## 3. Contract volumes (layer-first)

Contracts are organized **by layer**, not by provider or media type.

| Vol | Document | Question it answers |
|-----|----------|---------------------|
| **0** | `00-meta.md` | Why contracts exist, versioning, parity, tooling |
| **1** | `01-node-schema.md` | What is a valid node definition? |
| **2** | `02-handler-patterns.md` | How does execution work (sync/stream/poll/local)? |
| **3** | `03-handler-families/*.md` | How does each provider family map requests? |
| **4** | `04-graph-and-persistence.md` | What is a valid `.nebula` graph? |
| **5** | `05-api-and-events.md` | What are REST + WebSocket shapes? |
| **6** | `06-platform-emission.md` | What does each platform generate? |
| **7** | `07-studios-and-resources.md` | Moodboard, Character, Cinema, Video/Remotion — assets, studio APIs, graph bridges |

### Where provider vs category fit

- **Provider** → Volume **3** (handler families). One OpenAI client, one FAL universal + preset injections, etc.
- **Category** (`image-gen`, `video-gen`, …) → Volume **1** tags + media I/O rules. Same schema for all categories.
- **Node id list** → **Never** duplicated in Tier A prose. Use registry + generated indexes.

### Studios and resources (not handler families)

Nebula is not only a canvas of API nodes. Several **workspaces** manage persisted assets and connect to the graph via **bridge nodes** and **dedicated REST APIs**:

| Workspace | Persisted resource | Bridge node(s) | Key APIs (today) |
|-----------|-------------------|----------------|------------------|
| **Canvas** | `.nebula` graph | (all nodes) | `/api/graph/*`, `/api/execute` |
| **Create** | presets, outputs | uses catalog nodes directly | `/api/graph/cluster`, `/api/quick` |
| **Moodboard studio** | moodboard JSON | `nebula-moodboard` → `Moodboard` port | `/api/moodboards/*` |
| **Character studio** | character JSON | `character` → `Character` port | `/api/characters/*` |
| **Cinema studio** | scene spec on node | `cinema-scene`, `cinema-color`, `cinema-look` | `/api/cinema/*` |
| **Video editor** | clip manifest on node | `video-edit` | `/api/video-edit/*` |
| **Remotion editor** | `VideoGraphManifest` on node | `remotion-node` | client-side Remotion |

| Contract kind | Volume | What it covers |
|---------------|--------|----------------|
| **Handler family** | 3 | Provider HTTP (OpenAI, FAL, …) |
| **Studio / resource** | 7 | Asset schema, studio CRUD, editor ↔ `node.params` |
| **Graph + API** | 4–5 | How bridge nodes embed in `.nebula` + routes |

**Rule:** Porting `nebula-moodboard` requires **MoodboardStore + moodboard APIs**, not only `handlers/moodboard.py`.

Special case: `cinema-scene`, `remotion-node`, and `video-edit` often show `params: []` in the catalog but hold **large runtime objects** in `node.params` (scene spec, manifest, clips). Vol **1** documents that pattern; Vol **7** documents each payload schema.

---

## 4. Sources of truth (canonical paths)

| Concern | Canonical source | Consumers |
|---------|------------------|-----------|
| Node registry | `backend/data/node_definitions.json` | Web UI, backend engine, contract checks |
| Frontend mirror | `frontend/src/constants/nodeDefinitions.ts` | Must match registry (parity gate) |
| Env key catalog | `.env.example` + per-node `envKeyName` | Settings UI, Keychain (iPad/Mac) |
| Handler behavior | `backend/handlers/*.py` + tests | Reference impl; Swift ports prove parity |
| Execution routing | `backend/execution/sync_runner.py`, `engine.py` | Local vs sync vs async registry |
| Provider audits | `docs/model-providers/<provider>/` | Human research; feeds Vol 3 drafts |
| Moodboard / Character stores | `backend/services/moodboard_store.py`, character services | Studios + bridge nodes |
| Cinema / video payloads | `backend/cinema/`, video editor types | Vol 7 schemas |
| API guide (user-facing) | `docs/api-guides/` | End users; not normative for ports |

**Normative for ports:** Volumes 1–5 and **7** + registry + pytest/Vitest fixtures.

---

## 5. Versioning

### `contract_version` (integer)

Increment when **any** of these change in a breaking way:

- Node schema (new required fields, renamed ports, removed param types)
- Handler pattern semantics (e.g. stream event names)
- Graph JSON shape
- Public API or WebSocket event payloads

Increment **minor** doc revision (frontmatter `updated:`) when:

- A handler-family doc adds a provider or clarifies edge cases
- New category or `apiProvider` enum value (also update `check-node-contracts.mjs`)

**Do not** bump `contract_version` when:

- Adding a node that fits the existing schema
- Adding a FAL preset that uses `fal-universal` + `endpoint_id`
- Deprecating a model (remove from registry; note in MODEL_REFERENCE)
- Adding a moodboard/character/cinema field | Update **Vol 7** + tests; doc `updated:` only (not `contract_version` unless schema breaks)

### Platform parity

Each platform declares supported `contract_version` in its package metadata (future: `ipad/ContractVersion.swift`, Mac shell manifest). A platform may lag the web reference but must not implement a **newer** contract than it declares.

---

## 6. Parity and golden fixtures

A contract is **implemented** when:

1. **Structural parity** — registry entry passes `check-node-contracts.mjs`
2. **Behavioral parity** — handler test fixtures match across implementations
3. **Integration parity** — end-to-end smokes (execute → event stream → output file)

### Fixture layout (target)

```text
contracts/fixtures/
  nodes/           # minimal valid node payloads per pattern
  handlers/        # request/response snapshots per family
  graphs/          # small .nebula files for E2E
  events/          # WebSocket ExecutionEvent sequences
```

Web (Python) tests are the **oracle** until Swift tests exist. iPad/Mac ports add XCTest cases that load the same JSON fixtures.

### Gold exemplar standard

Every node (or node pair) in Vol 3 must have a **gold** exemplar under `docs/contracts/examples/`. Reference implementations: `nano-banana.md`, `gpt-image-2.md`, `gpt-image-2-fal.md`.

| Section | Required |
|---------|----------|
| YAML frontmatter | `kind`, `oracle`, `sources`, `verified` (+ `pricing_verified` where costs matter) |
| References & pricing | Official + Nebula audit links |
| §1 How to use | Step table for porting agents |
| §2 Vol 1 | Full ports, params (enums), handler-pinned fields |
| §3 Vol 2 | Pattern table + mermaid flow |
| §4 Vol 3 | HTTP mapping + forwarding rules |
| §5 Events / output | SSE, file paths, or sync response shape |
| §6 Edge cases | Validation errors, model guards, dual-route |
| §7 Parity oracle | pytest + `contracts/fixtures/handlers/{family}/*.json` when body shape is stable |
| §8 Minimal graph | Vol 4 JSON example |
| §9 Comparison | vs sibling node or provider (when useful) |
| §10 Parameter matrix | Official API field vs Nebula param |
| §11 Porting checklist | Actionable checkboxes |
| Changelog | Date + change |

**Coverage (2026-07-23):** All Google direct (9), Google FAL Nano Banana (2), OpenAI direct (8), OpenAI FAL GPT Image 2 (2), FAL GPT Image 1.5 (2), FAL Hunyuan3D V3 (2), and the seven dual-route Ideogram nodes, for 32 exemplar-backed nodes total. See [README.md](./README.md). Pipeline: [08-model-contract-pipeline.md](./08-model-contract-pipeline.md).

### Edge cases every family should name

Document in Vol 3 (not optional fluff):

- Missing API key → error message names `envKeyName`
- Rate limit / quota
- Provider-specific verification (e.g. OpenAI org verification for GPT Image 2)
- Dual-route fallback order (direct key present → else FAL)
- Binary output → file path + MIME in run dir

---

## 7. Tooling and drift prevention

| Tool | Role |
|------|------|
| `scripts/check-node-contracts.mjs` | Registry shape, FE/BE id parity, env example coverage |
| `scripts/generate-model-reference.mjs` | Regenerate `MODEL_REFERENCE.md` |
| `scripts/audit-ipad-node-contracts.mjs` | Per-node port inventory for iPad |
| `backend/tests/test_node_contracts.py` | Pytest mirror of structural checks |
| Future: `scripts/generate-contract-schemas.mjs` | Emit `contracts/*.schema.json` from registry |

**CI expectation:** Structural checks pass on every PR that touches `node_definitions.json` or handlers.

---

## 8. Drafting order (one-by-one)

Recommended sequence for Tier A docs:

1. **00-meta** (this file) ✓
2. **01-node-schema** ✓
3. **02-handler-patterns** ✓
4. **03-handler-families/openai.md** + **fal.md** ✓ (gpt-image-2 exemplars)
5. **contracts/fixtures/** for gpt-image-2 direct + FAL ✓
6. **03-handler-families/google.md** + Google exemplars (all 9 direct + FAL nano-banana) ✓ gold
7. **OpenAI exemplars** — gpt-image-2, gpt-image-1, gpt-4o-chat, openai-audio ✓ gold
8. **04–06** — graph, API, platform emission
9. **07-studios-and-resources** — moodboard, character, cinema, video/Remotion

---

## 9. Model freshness (contract drafting)

When adding or updating Vol 3 family docs or exemplars, **check the live model catalog** before marking a model "unwired":

1. [Gemini models](https://ai.google.dev/gemini-api/docs/models) — image, video, audio launches
2. [FAL model index](https://fal.ai/models) — for `FAL_KEY` routes not yet in registry
3. Provider audit under `docs/model-providers/{family}/`

Record release date and API surface in the family doc when a model ships between audits. Remove "not wired" notes once a node lands in `node_definitions.json`.

---

## 10. Recently shipped (Google, 2026-06-30)

| Model | Node | API |
|-------|------|-----|
| Gemini Omni Flash | `gemini-omni-flash` | Interactions API (`/v1beta/interactions`) |
| Nano Banana 2 Lite | `nano-banana` enum `gemini-3.1-flash-lite-image` | `generateContent` |

See [google.md](./03-handler-families/google.md) and exemplars.

---

## 11. Relationship to other docs

| Document | Relationship |
|----------|--------------|
| `docs/ipad-conversion/NEBULA-IPAD-SPEC.md` | iPad-specific roadmap; defers to this contract stack |
| `docs/ipad-conversion/NODE-CONTRACT-AUDIT.md` | Generated inventory; not normative schema |
| `docs/model-providers/**` | Research audits; source material for Vol 3 drafts |
| `docs/MODEL_REFERENCE.md` | Generated catalog; use for discovery, not porting semantics |
| `docs/api-guides/**` | End-user guides; not normative for ports |

**Porting agent read order:** Vol 0 (this file) → Vol 1–2 → target Vol 3 family → registry entry for the node → `backend/handlers/*.py` + pytest → golden fixtures. Do not load the full model catalog unless scoping a family wave.

**Out of scope for contract ports:** CLI usage playbooks, prompt craft, historical milestone plans.

---

## 10. Open decisions

| Topic | Options | Notes |
|-------|---------|-------|
| Schema format | JSON Schema vs TypeScript types vs both | Likely JSON Schema generated from registry |
| `contracts/` at repo root vs `docs/contracts/` | `docs/contracts/` for prose; `contracts/` for generated JSON | Keeps docs with docs |
| Mac engine | Bundled Python vs shared Swift core | Vol 6 will document emission per choice |
| Universal nodes | Single contract for FAL/OpenRouter/Replicate | Vol 3 `fal.md` + `universal.md` |

---

## Changelog

| Date | `contract_version` | Change |
|------|-------------------|--------|
| 2026-07-01 | 1 | Initial meta document |

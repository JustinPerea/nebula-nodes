---
title: Contract exemplar — Imagen 4 Generate
kind: contract-exemplar
contract_version: 1
handler_family: google
handler_pattern: sync
nodes:
  - imagen-4-generate
verified: 2026-07-01
pricing_verified: 2026-07-01
stale_after_days: 14
sources:
  - https://ai.google.dev/gemini-api/docs/imagen
  - https://ai.google.dev/gemini-api/docs/pricing
  - https://ai.google.dev/api/generate-content
oracle:
  handler: backend/handlers/google_gemini.py::handle_imagen4
  tests: backend/tests/test_google_gemini_handler.py
  registry: backend/data/node_definitions.json
---

# Contract exemplar: Imagen 4 (`imagen-4-generate`)

Template for porting agents. **Sync** photorealistic text-to-image via Imagen `:predict` — **not** `generateContent` (see [nano-banana.md](./nano-banana.md) for Gemini image models).

**In scope:** single node `imagen-4-generate` (three model variants).

**Out of scope:** Gemini-native image nodes → [nano-banana.md](./nano-banana.md). Other Google nodes → [../03-handler-families/google.md](../03-handler-families/google.md).

---

## References & pricing

Re-check official links when `pricing_verified` is older than `stale_after_days`.

### Official references

| Resource | URL |
|----------|-----|
| Imagen guide | https://ai.google.dev/gemini-api/docs/imagen |
| API — `predict` | https://ai.google.dev/api/generate-content (Imagen section) |
| Pricing | https://ai.google.dev/gemini-api/docs/pricing |

### Nebula references

| Resource | Path |
|----------|------|
| Family rules | [../03-handler-families/google.md](../03-handler-families/google.md) |
| Handler oracle | `backend/handlers/google_gemini.py` |

### Pricing (Google Imagen API, paid tier)

Rates from [official pricing](https://ai.google.dev/gemini-api/docs/pricing) as of `pricing_verified`. Imagen bills **per generated image** (model tier dependent).

| Model (registry id) | Notes |
|---------------------|-------|
| `imagen-4.0-generate-001` | Standard quality |
| `imagen-4.0-ultra-generate-001` | Highest fidelity |
| `imagen-4.0-fast-generate-001` | Speed-optimized |

**Nebula params that move the bill**

| Param | Effect |
|-------|--------|
| `model` | Switches rate card (standard / ultra / fast) |
| `numberOfImages` | `sampleCount` — API may bill per sample; handler uses **first** image only |
| `imageSize` | `1K` vs `2K` on standard/ultra |
| `enhancePrompt` | May increase latency; pricing unchanged |

Draft iterations: use `imagen-4.0-fast-generate-001` at `1K` before ultra or `2K`.

---

## 1. How to use this file

| Step | Action |
|------|--------|
| 1 | Read [01-node-schema.md](../01-node-schema.md) + [02-handler-patterns.md](../02-handler-patterns.md) §3 sync |
| 2 | Implement Vol 1 from §2 |
| 3 | Implement sync HTTP mapping §4 |
| 4 | Match `test_google_request_body_matches_fixture[imagen-4-generate-request.json]` |
| 5 | No SSE — single JSON response |

---

## 2. Node contract (Vol 1)

| Field | Value |
|-------|-------|
| `id` | `imagen-4-generate` |
| `displayName` | Imagen 4 |
| `category` | `image-gen` |
| `apiProvider` | `google` |
| `apiEndpoint` | `/v1beta/models/{model}:predict` |
| `envKeyName` | `GOOGLE_API_KEY` |
| `executionPattern` | `sync` |

**Input ports**

| `id` | `dataType` | `required` | `multiple` |
|------|------------|------------|------------|
| `prompt` | `Text` | yes | no |

**Output ports**

| `id` | `dataType` | Notes |
|------|------------|-------|
| `image` | `Image` | From `predictions[0].bytesBase64Encoded` |

**Params**

| `key` | `type` | `default` | Values / API field |
|-------|--------|-----------|-------------------|
| `model` | enum | `imagen-4.0-generate-001` | `imagen-4.0-generate-001`, `imagen-4.0-ultra-generate-001`, `imagen-4.0-fast-generate-001` — URL path |
| `aspectRatio` | enum | `1:1` | `1:1`, `4:3`, `3:4`, `16:9`, `9:16` → `parameters.aspectRatio` |
| `numberOfImages` | integer | `1` | 1–4 → `parameters.sampleCount` (handler saves **first** only) |
| `seed` | integer | random | `parameters.seed` when set |
| `enhancePrompt` | boolean | `false` | `parameters.enhancePrompt` when true |
| `imageSize` | enum | `1K` | `1K`, `2K` → `parameters.imageSize` — standard/ultra only |
| `personGeneration` | enum | `allow_adult` | `allow_all`, `allow_adult`, `dont_allow` → `parameters.personGeneration` |

**Handler-pinned**

| Field | Value |
|-------|-------|
| Response parsing | `predictions[0]` only — ignores additional samples when `numberOfImages` > 1 |
| MIME → extension | `image/png` → `.png`; else `.jpg` |

---

## 3. Handler pattern (Vol 2)

| Property | Value |
|----------|-------|
| Pattern | **sync** — one POST, full JSON response |
| Handler | `handle_imagen4` in `google_gemini.py` |
| Registry | `sync_runner.SYNC_HANDLERS["imagen-4-generate"]` |
| Timeout | 120s |
| Stream events | **none** |

```mermaid
flowchart LR
    N[imagen-4-generate] --> H[handle_imagen4]
    H --> API["POST …/models/{model}:predict"]
    API --> P[Parse predictions[0]]
    P --> O[image port]
```

---

## 4. HTTP mapping (Vol 3)

### Request

```http
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predict
x-goog-api-key: <GOOGLE_API_KEY>
Content-Type: application/json
```

`{model}` from `node.params.model`.

### Body (oracle shape)

```json
{
  "instances": [{ "prompt": "<prompt port>" }],
  "parameters": {
    "sampleCount": 1,
    "aspectRatio": "16:9",
    "imageSize": "2K",
    "seed": 42,
    "enhancePrompt": true,
    "personGeneration": "allow_adult"
  }
}
```

**Forwarding rules**

| Source | Rule |
|--------|------|
| `prompt` port | `instances[0].prompt` |
| `numberOfImages` param | `parameters.sampleCount` when truthy |
| `aspectRatio` param | `parameters.aspectRatio` when set |
| `seed` param | `parameters.seed` when non-empty |
| `enhancePrompt` param | `parameters.enhancePrompt: true` only when param is true |
| `personGeneration` param | `parameters.personGeneration` when set |
| `imageSize` param | `parameters.imageSize` when set |
| Omit `parameters` | When no params forwarded — empty `{}` still valid |

### Response parsing

```json
{
  "predictions": [
    { "bytesBase64Encoded": "…", "mimeType": "image/png" }
  ]
}
```

| Field | Port |
|------|------|
| `predictions[0].bytesBase64Encoded` | Decode → save under run dir → `image` |
| Empty predictions | `RuntimeError("Imagen 4 returned no predictions: …")` |

HTTP ≠ 200 → `RuntimeError(f"Imagen 4 API error {status}: {body}")`.

---

## 5. SSE / output / events

Not applicable — sync JSON only. No `StreamPartialImageEvent` or progress events.

Final port output:

```json
{
  "image": { "type": "Image", "value": "/absolute/path/to/output.png" }
}
```

---

## 6. Edge cases

| Condition | Behavior |
|-----------|----------|
| Missing `prompt` | `ValueError("Prompt input is required for Imagen 4")` |
| Missing `GOOGLE_API_KEY` | `ValueError("GOOGLE_API_KEY is required")` |
| `numberOfImages` > 1 | API may return multiple; handler uses **first** prediction only |
| `imageSize` on fast model | Hidden in UI (`visibleWhen` excludes fast) |
| No reference images | Text-to-image only — no `images` port |

---

## 7. Parity oracle

**Test:** `backend/tests/test_google_contract_fixtures.py::test_google_request_body_matches_fixture[imagen-4-generate-request.json]`

**Fixture:** `contracts/fixtures/handlers/google/imagen-4-generate-request.json`

| Test | Asserts |
|------|---------|
| `test_imagen4_generates_image_and_saves_file` | Image file output |
| `test_imagen4_missing_prompt_raises` | Validation |

Assertions on fixture body:

- `parameters.sampleCount == 1`
- `parameters.aspectRatio == "1:1"`

---

## 8. Minimal graph (Vol 4)

```json
{
  "nodes": [
    {
      "id": "n1",
      "definitionId": "text-input",
      "params": { "text": "A photorealistic ceramic mug on a wooden table" },
      "outputs": {}
    },
    {
      "id": "n2",
      "definitionId": "imagen-4-generate",
      "params": {
        "model": "imagen-4.0-generate-001",
        "aspectRatio": "16:9",
        "imageSize": "1K"
      },
      "outputs": {}
    }
  ],
  "edges": [
    {
      "source": "n1",
      "sourceHandle": "text",
      "target": "n2",
      "targetHandle": "prompt"
    }
  ]
}
```

---

## 9. vs Nano Banana (porting note)

| | Imagen 4 | Nano Banana |
|--|----------|-------------|
| Endpoint | `:predict` | `:generateContent` |
| API family | Imagen dedicated | Gemini image models |
| Edit / multi-ref | Not supported | `images` port (up to 14 refs) |
| Size control | `imageSize` 1K/2K | `imageSize` + `aspect_ratio` |
| Output | image only | image + optional text |

Use Imagen for photorealism; Nano Banana for editing and Gemini-native multimodal refs.

---

## 10. Parameter matrix (official API vs Nebula)

| Parameter | Official Imagen `predict` | Nebula |
|-----------|---------------------------|--------|
| `instances[].prompt` | ✓ | `prompt` port |
| `parameters.sampleCount` | ✓ | `numberOfImages` |
| `parameters.aspectRatio` | ✓ | `aspectRatio` |
| `parameters.imageSize` | ✓ | `imageSize` |
| `parameters.seed` | ✓ | `seed` |
| `parameters.enhancePrompt` | ✓ | `enhancePrompt` |
| `parameters.personGeneration` | ✓ | `personGeneration` |
| `parameters.negativePrompt` | ✓ | **not exposed** |
| `parameters.outputOptions` | ✓ | **not exposed** |
| Reference images | some models | **not exposed** |

Official reference: [Imagen](https://ai.google.dev/gemini-api/docs/imagen).

---

## 11. Porting checklist

- [ ] `NodeDefinition` matches §2
- [ ] POST `:predict` with `x-goog-api-key` header
- [ ] Build `instances` + `parameters` per §4 forwarding rules
- [ ] Decode `predictions[0].bytesBase64Encoded` → save image → `image` port
- [ ] Use first prediction when `sampleCount` > 1
- [ ] Match error strings from §6
- [ ] Unit test loads fixture JSON body shape

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-01 | Initial exemplar (partial) |
| 2026-07-01 | Gold upgrade — full Vol 1–4, pricing, parameter matrix |

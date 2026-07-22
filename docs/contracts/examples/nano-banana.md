---
title: Contract exemplar — Nano Banana (Google Gemini image)
kind: contract-exemplar
contract_version: 1
handler_family: google
handler_pattern: sync
nodes:
  - nano-banana
verified: 2026-07-22
pricing_verified: 2026-07-01
stale_after_days: 14
sources:
  - https://ai.google.dev/gemini-api/docs/image-generation
  - https://ai.google.dev/gemini-api/docs/models
  - https://ai.google.dev/api/generate-content
  - https://ai.google.dev/gemini-api/docs/pricing
oracle:
  handler: backend/handlers/google_gemini.py::handle_nano_banana
  tests: backend/tests/test_google_gemini_handler.py
  registry: backend/data/node_definitions.json
---

# Contract exemplar: Nano Banana (`nano-banana`)

Template for porting agents. **Sync** Gemini image generation and editing via `generateContent` — different pattern from [gpt-image-2 stream](./gpt-image-2.md).

**In scope:** single node `nano-banana` (three model enum values).

**Out of scope:** FAL routing → [nano-banana-fal.md](./nano-banana-fal.md). Other Google nodes → see [../03-handler-families/google.md](../03-handler-families/google.md) exemplar index.

---

## References & pricing

Re-check official links when `pricing_verified` is older than `stale_after_days` (Google image models move quickly).

### Official references

| Resource | URL |
|----------|-----|
| Image generation guide | https://ai.google.dev/gemini-api/docs/image-generation |
| Models overview | https://ai.google.dev/gemini-api/docs/models |
| API — `generateContent` | https://ai.google.dev/api/generate-content |
| Pricing | https://ai.google.dev/gemini-api/docs/pricing |
| Token / resolution tables | Image generation guide → “Image output tokens” section |

### Nebula references

| Resource | Path |
|----------|------|
| Family rules | [../03-handler-families/google.md](../03-handler-families/google.md) |
| Integration audit | `docs/model-providers/google/gemini-nano-banana.md` |
| Character ref caps | `backend/cinema/identity.py` (`MODEL_MAX_REFS`) |
| Handler oracle | `backend/handlers/google_gemini.py` |

### Pricing (Google Gemini API, paid tier)

Rates from [official pricing](https://ai.google.dev/gemini-api/docs/pricing) as of `pricing_verified`. Image models bill **output image tokens** (and input tokens for text + reference images).

#### `gemini-3.1-flash-image` (Nano Banana 2)

Registry value: `gemini-3.1-flash-image`

| | Paid tier |
|--|-----------|
| Input | $0.50 / 1M tokens (text + image) |
| Image output | $60 / 1M image output tokens |

Official equivalents (image output only):

| `imageSize` | ≈ per image |
|-------------|-------------|
| 512 (0.5K) | $0.045 |
| 1K | $0.067 |
| 2K | $0.101 |
| 4K | $0.151 |

#### `gemini-3-pro-image` (Nano Banana Pro)

Registry value: `gemini-3-pro-image`

| | Paid tier |
|--|-----------|
| Input | $2.00 / 1M tokens (~$0.0011 per input image) |
| Image output | $120 / 1M image output tokens |

| Output size | ≈ per image |
|-------------|-------------|
| 1K / 2K | $0.134 |
| 4K | $0.24 |

#### `gemini-2.5-flash-image` (Nano Banana legacy)

| | Paid tier |
|--|-----------|
| Input | $0.30 / 1M tokens |
| Image output | ~$0.039 per 1024×1024 image (1290 output tokens) |

**Nebula params that move the bill**

| Param | Effect |
|-------|--------|
| `model` | Switches rate card (table above) |
| `imageSize` | `512` / `1K` / `2K` / `4K` → output token count |
| `aspect_ratio` | Changes pixel dimensions → output tokens |
| `images` (multi-ref) | Each reference adds **input** image tokens |
| Thinking / grounding | Not exposed in Nebula UI today |

Draft iterations: use `gemini-3.1-flash-image` at `1K` before `4K` or Pro.

---

## 1. How to use this file

| Step | Action |
|------|--------|
| 1 | Read [01-node-schema.md](../01-node-schema.md) + [02-handler-patterns.md](../02-handler-patterns.md) §3 sync |
| 2 | Implement Vol 1 from §2 |
| 3 | Implement sync HTTP mapping §4–§5 |
| 4 | Match `test_nano_banana_aspect_ratio_uses_image_config` |
| 5 | No SSE / `StreamPartialImageEvent` — single response only |

---

## 2. Node contract (Vol 1)

| Field | Value |
|-------|-------|
| `id` | `nano-banana` |
| `displayName` | Nano Banana |
| `category` | `image-gen` |
| `apiProvider` | `google` |
| `apiEndpoint` | `/v1beta/models/{model}:generateContent` |
| `envKeyName` | `GOOGLE_API_KEY` |
| `executionPattern` | `sync` |

**Input ports**

| `id` | `dataType` | `required` | `multiple` |
|------|------------|------------|------------|
| `prompt` | `Text` | yes | no |
| `images` | `Image` | no | yes |

**Output ports**

| `id` | `dataType` | Notes |
|------|------------|-------|
| `image` | `Image` | From `inlineData` image part |
| `text` | `Text` | Optional model text alongside image |

**Params**

| `key` | `type` | `default` | Values |
|-------|--------|-----------|--------|
| `model` | enum | `gemini-3.1-flash-image` | `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image` |
| `aspect_ratio` | enum | `1:1` | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `5:4`, `4:5`, `21:9`; plus `1:4`, `4:1`, `1:8`, `8:1` (3.1 flash only in UI) |
| `imageSize` | enum | `1K` | `512`, `1K`, `2K`, `4K` — hidden for `gemini-2.5-flash-image`; `512` only on 3.1 flash |

**Handler-pinned**

| Field | Value |
|-------|-------|
| `responseModalities` | `["IMAGE", "TEXT"]` always sent |

---

## 3. Handler pattern (Vol 2)

| Property | Value |
|----------|-------|
| Pattern | **sync** — one POST, full JSON response |
| Handler | `handle_nano_banana` in `google_gemini.py` |
| Registry | `sync_runner.SYNC_HANDLERS["nano-banana"]` |
| Timeout | 120s |
| Stream events | **none** |

```mermaid
flowchart LR
    N[nano-banana] --> H[handle_nano_banana]
    H --> API["POST …/models/{model}:generateContent"]
    API --> P[Parse candidates[].content.parts]
    P --> O[image + optional text ports]
```

---

## 4. HTTP mapping (Vol 3)

### Request

```http
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
x-goog-api-key: <GOOGLE_API_KEY>
Content-Type: application/json
```

`{model}` from `node.params.model` (registry enum).

### Body (oracle shape)

```json
{
  "contents": [
    {
      "parts": [
        { "text": "<prompt port>" },
        { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE", "TEXT"],
    "imageConfig": {
      "aspectRatio": "16:9",
      "imageSize": "2K"
    }
  }
}
```

**Forwarding rules**

| Source | Rule |
|--------|------|
| `prompt` port | First part: `{ "text": "..." }` |
| `images` port | Additional parts: `inlineData` (local file) or `fileData.fileUri` (URL) |
| `aspect_ratio` param | `generationConfig.imageConfig.aspectRatio` if set |
| `imageSize` param | `generationConfig.imageConfig.imageSize` if set |
| Omit `imageConfig` | When neither aspect nor size set |

**Do not use** `generationConfig.responseFormat.image.aspectRatio` — live API rejects natural strings like `"16:9"` on that path (verified 2026-05-17; pinned in tests).

### Response parsing

Walk `candidates[0].content.parts[]`:

| Part | Port |
|------|------|
| `inlineData` (image/*) | `image` — decode base64, save under run dir |
| `text` | `text` |

Empty → `RuntimeError("Gemini returned no image or text content")`.

HTTP ≠ 200 → `RuntimeError(f"Gemini API error {status}: {body}")`.

---

## 5. Reference images (official limits)

Per [image generation guide](https://ai.google.dev/gemini-api/docs/image-generation) (informative for ports):

| Model (official id) | Total refs | Notes |
|---------------------|------------|-------|
| `gemini-3.1-flash-image` | up to **14** | up to 4 character + 10 object (workflow-dependent) |
| `gemini-3-pro-image` | up to **14** | up to 5 character + 6 object |
| `gemini-2.5-flash-image` | ~3 recommended | legacy |

Nebula cinema uses `MODEL_MAX_REFS["nano-banana"] = 14` for character bundles.

---

## 6. Edge cases

| Condition | Behavior |
|-----------|----------|
| Missing prompt | `ValueError("Prompt input is required")` |
| Missing `GOOGLE_API_KEY` | `ValueError("GOOGLE_API_KEY is required")` |
| Local image path missing | Skipped silently (no part added) |
| Model id `-preview` suffix | Registry default; official stable ids may omit suffix |
| Multi-output `n` | Not exposed — run node multiple times |

---

## 7. Parity oracle

**Test:** `backend/tests/test_google_contract_fixtures.py::test_google_request_body_matches_fixture[nano-banana-generate-request.json]`

**Fixture (generate):** `contracts/fixtures/handlers/google/nano-banana-generate-request.json`

**Fixture (edit via images port):** `contracts/fixtures/handlers/google/nano-banana-edit-request.json`

Assertions:

- `generationConfig.imageConfig.aspectRatio == "16:9"`
- `generationConfig.imageConfig.imageSize == "2K"`
- `"responseFormat" not in generationConfig`

---

## 8. Minimal graph (Vol 4)

```json
{
  "nodes": [
    {
      "id": "n1",
      "definitionId": "text-input",
      "params": { "text": "A ceramic mug on a wooden table" },
      "outputs": {}
    },
    {
      "id": "n2",
      "definitionId": "nano-banana",
      "params": {
        "model": "gemini-3.1-flash-image",
        "aspect_ratio": "16:9",
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

Edit / multi-ref: connect upstream `image` port(s) → `images` (multi).

---

## 9. vs GPT Image 2 (porting note)

| | Nano Banana | GPT Image 2 direct |
|--|-------------|-------------------|
| Pattern | sync | stream |
| Key | `GOOGLE_API_KEY` | `OPENAI_API_KEY` |
| Size param | `imageSize` + `aspect_ratio` | `size` (WxH) |
| Previews | none | `StreamPartialImageEvent` |
| Endpoint | `generateContent` | `/v1/images/generations` |

---

## 10. Porting checklist

- [ ] `NodeDefinition` matches §2
- [ ] POST `generateContent` with `x-goog-api-key` header
- [ ] Build `contents[].parts` from prompt + optional images
- [ ] Use `generationConfig.imageConfig` for aspect/size (not `responseFormat.image`)
- [ ] Pin `responseModalities: ["IMAGE", "TEXT"]`
- [ ] Parse `inlineData` → save image file → `image` port
- [ ] Optional `text` part → `text` port
- [ ] Match error strings from §6
- [ ] Unit test loads fixture JSON body shape

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-01 | Initial exemplar with official docs + pricing |

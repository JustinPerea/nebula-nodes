---
title: Nebula Contracts — Google Handler Family (Volume 3)
status: draft
contract_version: 1
handler_family: google
---

# Google handler family (Volume 3)

Rules for nodes with `apiProvider: "google"` and `envKeyName: "GOOGLE_API_KEY"`.

**Primary module:** `backend/handlers/google_gemini.py`

Nebula exposes **Google direct** Gemini image nodes (`GOOGLE_API_KEY`) and **FAL-routed** Nano Banana nodes (`FAL_KEY`). See [../examples/nano-banana-fal.md](../examples/nano-banana-fal.md).

---

## 1. Nodes in registry (9 direct)

| Node id | Pattern | Handler | Exemplar |
|---------|---------|---------|----------|
| `nano-banana` | sync | `handle_nano_banana` | [../examples/nano-banana.md](../examples/nano-banana.md) |
| `gemini-chat` | stream | `handle_gemini_chat` | [../examples/gemini-chat.md](../examples/gemini-chat.md) |
| `imagen-4-generate` | sync | `handle_imagen4` | [../examples/imagen-4-generate.md](../examples/imagen-4-generate.md) |
| `lyria-3` | sync | `handle_lyria3` | [../examples/lyria-3.md](../examples/lyria-3.md) |
| `gemini-tts` | sync | `handle_gemini_tts` | [../examples/gemini-tts.md](../examples/gemini-tts.md) |
| `gemini-embeddings` | sync | `handle_gemini_embeddings` | [../examples/gemini-embeddings.md](../examples/gemini-embeddings.md) |
| `veo-3` | async-poll | `handle_veo` | [../examples/veo-3.md](../examples/veo-3.md) |
| `gemini-omni-flash` | sync URI / async-poll inline | `handle_gemini_omni` | [../examples/gemini-omni-flash.md](../examples/gemini-omni-flash.md) |
| `style-reference` | sync | `handle_style_reference` | [../examples/style-reference.md](../examples/style-reference.md) |

**FAL-routed (not in this family — `apiProvider: fal`):** `nano-banana-fal`, `nano-banana-fal-edit` → [fal.md](./fal.md), [../examples/nano-banana-fal.md](../examples/nano-banana-fal.md).

**Primary modules:** `backend/handlers/google_gemini.py`, `backend/handlers/veo.py`, `backend/handlers/gemini_omni.py`, `backend/handlers/style_reference.py`

---

## 2. Auth

```http
x-goog-api-key: <GOOGLE_API_KEY>
```

Query param alternative (some docs): `?key=` — Nebula handlers use the header.

Missing key → `ValueError("GOOGLE_API_KEY is required")`.

---

## 3. Base URL

```
https://generativelanguage.googleapis.com
```

Path patterns:

| Operation | Path template |
|-----------|---------------|
| Generate (Gemini multimodal) | `/v1beta/models/{model}:generateContent` |
| Stream chat | `/v1beta/models/{model}:streamGenerateContent?alt=sse` |
| Imagen | `/v1beta/models/{model}:predict` |
| Embeddings | `/v1beta/models/{model}:embedContent` |
| Veo | `/v1beta/models/{model}:predictLongRunning` → poll `operations/...` |
| Omni Flash | `POST /v1beta/interactions`; URI parses initial response, inline polls `interactions/{id}` |

`apiEndpoint` on the node definition is a template; handler substitutes `{model}` from `node.params.model`.

---

## 4. JSON conventions

| Rule | Detail |
|------|--------|
| **camelCase** | Request bodies use `generationConfig`, `responseModalities`, `inlineData`, `mimeType` |
| **Not snake_case** | e.g. embeddings use `outputDimensionality`, not `output_dimensionality` |
| **imageConfig path** | Nano Banana: `generationConfig.imageConfig.aspectRatio` / `imageSize` — **not** `responseFormat.image` (live API rejects natural ratio strings on that path) |
| **Proto enums** | Some fields need enum constants (e.g. Lyria WAV → `AUDIO_WAV`, not `audio/wav`) |

Always verify body shape against live API when docs and handler disagree — see project audit notes.

---

## 5. Media input mapping

| Port value | Request part |
|------------|--------------|
| Local file path | `inlineData: { mimeType, data: base64 }` |
| `http(s)://` URL | `fileData: { fileUri }` |
| `data:` URI | Parsed like chat handler (inline) |

Multi-image port → multiple parts in `contents[0].parts`.

---

## 6. Media output mapping

| Response part | Nebula port |
|---------------|-------------|
| `inlineData` (image mime) | `image` → saved file path |
| `text` | `text` |
| `inlineData` (audio) | `audio` (may wrap PCM in WAV for TTS) |
| Imagen `bytesBase64Encoded` | `image` |
| Veo `video.uri` | `video` (downloaded to file) |
| Omni `steps` video part | `video` + `interaction_id` |

---

## 7. Model IDs (nano-banana)

Official docs (2026) use stable ids **without** `-preview`:

| Official (ai.google.dev) | Nebula registry value today |
|--------------------------|----------------------------|
| `gemini-3.1-flash-image` | `gemini-3.1-flash-image` |
| `gemini-3.1-flash-lite-image` | `gemini-3.1-flash-lite-image` (stable) |
| `gemini-3-pro-image` | `gemini-3-pro-image` |
| `gemini-2.5-flash-image` | `gemini-2.5-flash-image` (match) |

The two preview IDs were shut down on 2026-06-25. Registry and handler values were migrated to the stable IDs on 2026-07-22. Track [gemini-nano-banana.md](../../model-providers/google/gemini-nano-banana.md) for future lifecycle changes.

---

## 8. References

| Resource | URL |
|----------|-----|
| Image generation guide | https://ai.google.dev/gemini-api/docs/image-generation |
| Models | https://ai.google.dev/gemini-api/docs/models |
| API — generateContent | https://ai.google.dev/api/generate-content |
| Pricing | https://ai.google.dev/gemini-api/docs/pricing |
| Imagen | https://ai.google.dev/gemini-api/docs/imagen |
| Video (Veo) | https://ai.google.dev/gemini-api/docs/video |
| Nebula audit | `docs/model-providers/google/gemini-nano-banana.md` |

---

## 9. Gemini Omni Flash (`gemini-omni-flash`)

Full port/param contract: [../examples/gemini-omni-flash.md](../examples/gemini-omni-flash.md).

Shipped 2026-06-30. Uses the **Interactions API** (not `generateContent` / `predictLongRunning` like Veo).

| Field | Value |
|-------|-------|
| Model id | `gemini-omni-flash-preview` (pinned on node) |
| URL | `POST https://generativelanguage.googleapis.com/v1beta/interactions` |
| URI delivery | `background: false`; consume URI from the initial creation response |
| Inline delivery | `background: true`; poll `GET …/interactions/{id}` |
| Docs | https://ai.google.dev/gemini-api/docs/omni |

**vs Veo 3:** Omni = conversational video gen/edit via Interactions; Veo = `predictLongRunning`, extension, frame interpolation. See [../examples/veo-3.md](../examples/veo-3.md).

---

## 10. Nano Banana 2 Lite

Registry enum value on `nano-banana`: `gemini-3.1-flash-lite-image` (stable id, June 2026). Documented in [../examples/nano-banana.md](../examples/nano-banana.md) §2 params.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-01 | Initial family doc; nano-banana exemplar |

---
title: Nebula Contracts — OpenAI Handler Family (Volume 3)
status: draft
contract_version: 1
handler_family: openai
---

# OpenAI handler family (Volume 3)

Rules for nodes with `apiProvider: "openai"` and `envKeyName: "OPENAI_API_KEY"`.

**Not in scope:** FAL-routed OpenAI models (`apiProvider: "fal"`, `FAL_KEY`) — see [fal.md](./fal.md).

---

## 1. Nodes in registry (8 direct)

| Node id | Pattern | Handler module |
|---------|---------|----------------|
| `gpt-image-2-generate` | stream | `openai_image_v2.py` |
| `gpt-image-2-edit` | stream | `openai_image_v2.py` |
| `gpt-image-1-generate` | sync | `openai_image.py` |
| `gpt-image-1-edit` | sync | `openai_image_edit.py` |
| `gpt-4o-chat` | stream | `openai_chat.py` |
| `openai-tts` | sync | `openai_audio.py` |
| `openai-stt` | sync | `openai_audio.py` |
| `openai-translate` | sync | `openai_audio.py` |

**Exemplars (gold):**

| Nodes | Exemplar | Pattern |
|-------|----------|---------|
| `gpt-image-2-generate`, `gpt-image-2-edit` | [../examples/gpt-image-2.md](../examples/gpt-image-2.md) | stream (image SSE) |
| `gpt-image-1-generate`, `gpt-image-1-edit` | [../examples/gpt-image-1.md](../examples/gpt-image-1.md) | sync JSON |
| `gpt-4o-chat` | [../examples/gpt-4o-chat.md](../examples/gpt-4o-chat.md) | stream (token SSE) |
| `openai-tts`, `openai-stt`, `openai-translate` | [../examples/openai-audio.md](../examples/openai-audio.md) | sync |

---

## 2. Auth

```http
Authorization: Bearer <OPENAI_API_KEY>
```

Missing key → `ValueError("OPENAI_API_KEY is required")`.

---

## 3. Base URLs

| API | Base |
|-----|------|
| Images | `https://api.openai.com` + `apiEndpoint` |
| Chat | `https://api.openai.com/v1/chat/completions` |
| Audio | `https://api.openai.com` + `apiEndpoint` |

---

## 4. Image models — two generations

| Generation | Nodes | Pattern | Notes |
|------------|-------|---------|-------|
| **GPT Image 2** | `gpt-image-2-*` | stream SSE | Pins `model: gpt-image-2`; forces `stream: true` |
| **GPT Image 1 / 1.5 / mini** | `gpt-image-1-*` | sync JSON | `model` param in UI; returns base64 in JSON body |

Do not copy gpt-image-2 stream rules onto gpt-image-1 handlers.

---

## 5. Edge cases (family-wide)

| Case | Behavior |
|------|----------|
| Org not verified (gpt-image-2) | Friendly `RuntimeError` + settings URL |
| Streaming + `n > 1` | Rejected by API — Nebula drops `n` on stream nodes |
| `background: transparent` on gpt-image-2 | Omit — not supported |
| Audio multipart | Some routes use `multipart/form-data` (see handler) |

---

## 6. References

| Resource | URL |
|----------|-----|
| GPT Image 2 model | https://developers.openai.com/api/docs/models/gpt-image-2 |
| Images API | https://developers.openai.com/api/reference/resources/images |
| Pricing | https://developers.openai.com/api/docs/pricing |
| Nebula audit | `docs/model-providers/openai/gpt-image-2.md` |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-01 | Initial family doc; gpt-image-2 exemplar complete |
| 2026-07-01 | Linked all OpenAI direct gold exemplars (image-1, chat, audio) |

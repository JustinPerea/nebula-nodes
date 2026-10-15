# Runway Image Generation

`POST /v1/text_to_image` on the `runway-image` node. Fields and limits are from Runway's
request schema (https://docs.dev.runwayml.com/openapi.json), read 2026-10-14. Each model
takes its own ratio list; the node shows only the chosen model's ratios
(`RUNWAY_IMAGE_MODELS` in `backend/handlers/runway.py`), and the handler checks ratio,
reference count and prompt length before submitting.

## Common fields

| Field (wire) | Required | Notes |
|---|---|---|
| `model` | yes | See matrix. |
| `promptText` | yes | Max length per model (below). |
| `ratio` | yes | Model-specific. The node default `1360:768` is Gen-4 only. |
| `referenceImages` | varies | Array of `{ uri, tag? }` from the `images` port. Nebula sends no tags. |
| `seed` | no | Gen-4 Image (+ Turbo) only; the node leaves it out for other models. |

## Model matrix

| `model` | Ratios | References | Prompt | Other fields |
|---|---|---|---|---|
| `gen4_image` | 16: `1024:1024`, `1080:1080`, `1168:880`, `1360:768`, `1440:1080`, `1080:1440`, `1808:768`, `1920:1080`, `1080:1920`, `2112:912`, `1280:720`, `720:1280`, `720:720`, `960:720`, `720:960`, `1680:720` | 0–3 | ≤1000 | `seed`, `contentModeration` |
| `gen4_image_turbo` | same 16 | **1–3 (required)** | ≤1000 | `seed`, `contentModeration` |
| `gemini_image3_pro` (Nano Banana Pro) | 30: the 10 Gemini 2.5 Flash ratios + 2K (`2048:2048` … `3168:1344`) + 4K (`4096:4096` … `6336:2688`) | 0–14 | 3–5500 | `outputCount` 1 or 4 (not exposed) |
| `gpt_image_2` | 31: ten ~1920px, ten ~2560px, ten ~3840px sizes, plus `auto` | 0–16 | ≤32000 | `quality`, `background`, `outputCount` (not exposed; quality defaults to high) |
| `gemini_2.5_flash` | 10: `1344:768`, `768:1344`, `1024:1024`, `1184:864`, `864:1184`, `1536:672`, `832:1248`, `1248:832`, `896:1152`, `1152:896` | 0–3 | ≤5500 | — |
| `seedream5_pro` (ByteDance, via Runway) | 16: 1K (`1024:1024`, `1184:896`, `896:1184`, `1376:768`, `768:1376`, `1296:864`, `864:1296`), 2K (`2048:2048`, `2304:1728`, `1728:2304`, `2720:1530`, `1530:2720`, `2496:1664`, `1664:2496`), `auto_1k`, `auto_2k` | 0–10 | ≤4000 | `grounding` (web search; node param), `outputFormat`, `outputCount` (not exposed). No seed. |
| `seedream5_lite` (ByteDance, via Runway) | 16 2K–3K sizes: `2048:2048`, `2304:1728`, `1728:2304`, `2848:1600`, `1600:2848`, `2496:1664`, `1664:2496`, `3136:1344`, `3072:3072`, `3456:2592`, `2592:3456`, `4096:2304`, `2304:4096`, `3744:2496`, `2496:3744`, `4704:2016` (the API also takes freeform sizes of 3.69–16.8 MP; the node doesn't) | 0–14 | ≤4000 | `grounding`, `outputFormat`, `outputCount` (not exposed). No seed. |

The node returns one image per run (no `outputCount`). Reference images over the model's
maximum are an error, not silently dropped.

## Example

```json
POST /v1/text_to_image
{
  "model": "seedream5_pro",
  "promptText": "Poster of Figure 1 standing in the setting of Figure 2, bold title type.",
  "ratio": "auto_2k",
  "referenceImages": [
    { "uri": "https://example.com/face.jpg" },
    { "uri": "https://example.com/library.jpg" }
  ],
  "grounding": true
}
```

## Prices (credits, $0.01 each; guides/pricing.md 2026-10-14)

Per image: gen4_image 5 (720p) / 8 (1080p), gen4_image_turbo 2, gemini_image3_pro 20
(1K/2K) / 40 (4K), gpt_image_2 at high quality 20 (1K/2K) / 41 (4K and `auto`),
gemini_2.5_flash 5, seedream5_pro 5 (1K) / 9 (2K), seedream5_lite 4. Runway doesn't say
which ratio is which tier, so `model_pricing.json` prices ratios whose size makes the
tier plain and shows the rest as a range.

## Notes

- `tag` is needed for prompt references like `@subject`; Nebula sends untagged
  references, so they act as ambient guidance (Seedream: refer to them as Figure 1,
  Figure 2 in upload order).
- Runway also lists Nano Banana 2 / 2.1, Ideogram 4.0 / 4.5, GPT Image 2.5, Grok Imagine
  Image 2 and Muse Image, which this node doesn't offer.

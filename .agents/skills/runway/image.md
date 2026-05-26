# Runway Image Generation

`POST /v1/text_to_image` — Gen-4 Image (Turbo + base) and Gemini 2.5 Flash via Runway.

## Common fields

| Field (wire) | Required | Notes |
|---|---|---|
| `model` | yes | See matrix. |
| `promptText` | yes | ≤1000 chars. Use `@tagname` to reference tagged images. |
| `ratio` | yes | Model-specific. |
| `referenceImages` | varies | Array of `{ uri, tag? }`. Turbo requires ≥1. |
| `contentModeration.publicFigureThreshold` | no | `"auto"` \| `"low"`. Not on Gemini. |
| `seed` | no | int. Not on Gemini. |

## Model matrix

### `gen4_image_turbo`
- **Reference images required** — 1 to 3 entries, each `{uri, tag?}`. Prompt text can reference tags (`@alice doing @action`).
- **Ratios** (16 options): `1024:1024`, `1080:1080`, `1168:880`, `1360:768`, `1440:1080`, `1080:1440`, `1808:768`, `1920:1080`, `1080:1920`, `2112:912`, `1280:720`, `720:1280`, `720:720`, `960:720`, `720:960`, `1680:720`

### `gen4_image`
- Reference images **optional** — up to 3. Otherwise pure text-to-image.
- Same 16 ratios as Turbo.

### `gemini_2.5_flash`
- Reference images optional — up to 3.
- **Different ratios** (10 options): `1344:768`, `768:1344`, `1024:1024`, `1184:864`, `864:1184`, `1536:672`, `832:1248`, `1248:832`, `896:1152`, `1152:896`
- No `contentModeration`, no `seed`.

## Example

```json
POST /v1/text_to_image
{
  "model": "gen4_image_turbo",
  "promptText": "A dramatic portrait of @subject in @setting, cinematic lighting.",
  "ratio": "1080:1920",
  "referenceImages": [
    { "uri": "https://example.com/face.jpg", "tag": "subject" },
    { "uri": "https://example.com/library.jpg", "tag": "setting" }
  ],
  "seed": 42
}
```

## Notes

- `tag` is required for prompt-text references like `@subject`. Without a tag, the reference is used as ambient style only.
- `gen4_image` accepts text-only prompts (no reference images) — good for pure text-to-image.
- Gen-4 Image is the successor to Gen-3. The `_turbo` variant is faster/cheaper but caps at 3 refs.

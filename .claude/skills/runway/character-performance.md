# Runway Character Performance (Act-Two)

`POST /v1/character_performance` — drive a still image or existing video of a character using a reference performance video.

## Required fields

| Field (wire) | Type | Notes |
|---|---|---|
| `model` | `"act_two"` | Only option. |
| `character` | `{ type: "image" \| "video", uri: string }` | The character to animate. Must show a recognizable face within the frame throughout. Image → character uses reference performance in original static environment; Video → character uses reference performance in its original animated environment + some of its own movements. |
| `reference` | `{ type: "video", uri: string }` | Performance reference. **3–30 seconds**. |

## Optional fields

| Field (wire) | Type | Description |
|---|---|---|
| `bodyControl` | bool | When true, non-facial movements and gestures also transfer, not just facial expressions. |
| `expressionIntensity` | int, 1–5 | Higher = more intense expressions. |
| `ratio` | enum | `1280:720`, `720:1280`, `960:960`, `1104:832`, `832:1104`, `1584:672`. |
| `contentModeration.publicFigureThreshold` | `"auto"` \| `"low"` | Public-figure strictness. |
| `seed` | int | Reproducibility. |

## Example

```json
POST /v1/character_performance
{
  "model": "act_two",
  "character": { "type": "image", "uri": "https://example.com/face.png" },
  "reference": { "type": "video", "uri": "https://example.com/actor.mp4" },
  "bodyControl": true,
  "expressionIntensity": 4,
  "ratio": "1280:720",
  "seed": 99
}
```

## Notes

- Reference video longer than 30s → 400. Shorter than 3s → 400.
- Face must stay in frame for the entire input character asset.
- Works well for lip-sync, dialogue scenes, and stylized-avatar performances.

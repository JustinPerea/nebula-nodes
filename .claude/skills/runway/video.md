# Runway Video Endpoints

Three endpoints, one node family (`runway-video`, `runway-aleph`).

## `POST /v1/image_to_video`

Union of 7 model-specific payloads. The handler picks the right shape based on the `model` field.

### Required base

| Field (wire) | SDK alias | Notes |
|---|---|---|
| `model` | `model` | See model matrix below. |
| `promptImage` | `prompt_image` | Either an HTTPS URL string OR an array of `{position, uri}` objects. Position values differ by model. |
| `promptText` | `prompt_text` | ≤1000 chars (UTF-16). Some models require, others optional. |
| `ratio` | `ratio` | Model-specific enum; see matrix. |

### Model matrix

| `model` value | Ratios | Duration | Required text? | Prompt image positions | Extras |
|---|---|---|---|---|---|
| `gen4.5` | `1280:720`, `720:1280`, `1104:832`, `960:960`, `832:1104`, `1584:672` | `2`–`10` (int, required) | Yes | `first` | `seed`, `contentModeration` |
| `gen4_turbo` | same as gen4.5 | int (optional) | Optional | `first` | `seed`, `contentModeration` |
| `gen3a_turbo` | `768:1280`, `1280:768` | `5` or `10` | Yes | `first`, `last` | `seed`, `contentModeration` |
| `veo3.1` | `1280:720`, `720:1280`, `1080:1920`, `1920:1080` | `4`, `6`, `8` | Optional | `first`, `last` | `audio` (bool, affects price) |
| `veo3.1_fast` | same as veo3.1 | `4`, `6`, `8` | Optional | `first`, `last` | `audio` |
| `seedance2` | twelve options (see below) | int | Optional | `first`, `last`, or omit for reference | `audio`, `outputCount` |
| `veo3` | `1280:720`, `720:1280`, `1080:1920`, `1920:1080` | `8` (only) | Optional | `first` | — |

**seedance2 ratios:** `992:432`, `864:496`, `752:560`, `640:640`, `560:752`, `496:864`, `1470:630`, `1280:720`, `1112:834`, `960:960`, `834:1112`, `720:1280`.

### Example (Gen-4.5, first frame from URL)

```json
POST /v1/image_to_video
{
  "model": "gen4.5",
  "promptImage": "https://example.com/first.png",
  "promptText": "Slow dolly-in on the subject's face; cinematic lighting.",
  "ratio": "1280:720",
  "duration": 8,
  "seed": 12345
}
```

### Example (Veo 3.1 with first + last frame + audio)

```json
{
  "model": "veo3.1",
  "promptImage": [
    { "position": "first", "uri": "https://example.com/start.png" },
    { "position": "last",  "uri": "https://example.com/end.png" }
  ],
  "ratio": "1920:1080",
  "duration": 6,
  "audio": true
}
```

---

## `POST /v1/text_to_video`

Union of 5 models: `gen4.5`, `veo3.1`, `veo3.1_fast`, `seedance2`, `veo3`.

### Required base

| Field | Notes |
|---|---|
| `model` | See models above. |
| `promptText` | ≤1000 chars for most, 3500 for `seedance2`. |
| `ratio` | Model-specific. |
| `duration` | Model-specific. |

### Model matrix

| `model` | Ratios | Duration | Extras |
|---|---|---|---|
| `gen4.5` | `1280:720`, `720:1280` | `2`–`10` (required int) | `seed`, `contentModeration` |
| `veo3.1` | `1280:720`, `720:1280`, `1080:1920`, `1920:1080` | `4`/`6`/`8` | `audio` |
| `veo3.1_fast` | same | `4`/`6`/`8` | `audio` |
| `seedance2` | (same twelve as image_to_video) | int | `audio`, `outputCount` |
| `veo3` | `1280:720`, `720:1280`, `1080:1920`, `1920:1080` | `8` (only) | — |

---

## `POST /v1/video_to_video`

Union of 2 models: `gen4_aleph`, `seedance2`.

### Gen-4 Aleph (video restyling)

| Field | Required | Notes |
|---|---|---|
| `model` | yes | `"gen4_aleph"` |
| `videoUri` | yes | HTTPS URL to source video. |
| `promptText` | yes | ≤1000 chars describing the transformation. |
| `references[]` | no | Up to 1 reference image `{ type: "image", uri }` for style emulation. |
| `seed` | no | int |
| `contentModeration.publicFigureThreshold` | no | `"auto"` \| `"low"` |
| `ratio` | **ignored** | Deprecated; output resolution is inherited from input video. |

### Seedance 2 video-to-video

| Field | Required | Notes |
|---|---|---|
| `model` | yes | `"seedance2"` |
| `promptVideo` | yes | HTTPS URL to source. |
| `promptText` | no | ≤3500 chars. |
| `audio` | no | bool |
| `duration` | no | int, `4`–`15` |
| `outputCount` | no | int, how many generations. |
| `ratio` | no | twelve seedance2 options. |
| `references` | no | Up to 9 image references (array of `{uri, position?}` or a single URL string). |
| `referenceVideos` | no | Up to 3 video references `{ type: "video", uri }`. |

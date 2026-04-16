# Nebula Node — Gap Analysis & Corrections
> Generated April 14, 2026. Hand this to Claude Code alongside the 3 spec documents.
> All gaps and corrections have been verified against live API documentation.

---

## How to Use This File

1. **Apply all CORRECTIONS first** — these fix wrong values already in MODEL_REFERENCE.md
2. **Implement MISSING NODES in priority order** — highest value first
3. **Fix INCOMPLETE PARAMS** — nodes that exist but are missing parameters
4. **Add NEW VARIANTS last** — Kling O3 and LTX 2.3 are newest additions

---

## Part 1 — Corrections (Fix These First)

These are values currently wrong in MODEL_REFERENCE.md. Apply before writing any new node code.

| Node | Field | Current (Wrong) | Correct |
|---|---|---|---|
| `ltx-video-2` | Resolution options | `480p, 720p` | `1080p, 1440p, 2160p` — confirmed from fal.ai docs |
| `minimax-*` | Default model ID | `MiniMax-Hailuo-02` | `MiniMax-Hailuo-2.3` — current latest |
| `elevenlabs-tts` | voice_settings | Only `stability` | Add: `similarity_boost` (0–1), `style` (0–1), `use_speaker_boost` (bool), `speed` (0.1–4.0), `output_format` enum, `seed` (int) |

---

## Part 2 — Incomplete Parameters (Nodes Exist, Params Missing)

### gpt-image-1-generate
Add these missing params:
- `output_format`: enum — `png`, `jpeg`, `webp` (default `png`)
- `output_compression`: integer 0–100 (jpeg/webp only)
- `background`: enum — `transparent`, `opaque`, `auto` (default `auto`)
- `moderation`: string — content filtering level

### flux-1-1-ultra
Add these missing params:
- `safety_tolerance`: string — `1`–`6` (default `2`, 1=most strict)
- `enhance_prompt`: boolean — default `false`
- `image_prompt_strength`: float 0–1 (only shown when image guide port is connected)
- `raw`: boolean — candid/photographic style, default `false`
- Fix aspect ratio options — add `21:9` and `3:4`

### flux-schnell
- Add `num_images`: integer 1–4 (default 1)

### runway-gen4-turbo
- Add `ratio`: enum — `1280:720`, `1584:672`, `1104:832`, `720:1280`, `832:1104`, `960:960`
- Add `seed`: integer 0–4294967295

### kling-v2-1
Add these missing params:
- `negative_prompt`: string (default `"blur, distort, and low quality"`)
- `cfg_scale`: float — prompt adherence (default 0.5)
- `tail_image_url`: string — optional end-frame image input port
- `static_mask_url`: string — static motion brush mask
- `dynamic_masks`: array — `[{mask_url, trajectories: [{x,y}]}]`

### elevenlabs-tts
Add to voice_settings (see corrections above). Also add:
- `output_format`: enum — `mp3_22050_32`, `mp3_44100_128`, `pcm_16000`, `pcm_24000`, `pcm_44100`
- `seed`: integer — reproducibility

### luma-ray2-t2v
- Add `loop`: boolean — seamless loop blend (default `false`)
- Fix duration options — add `9s` (current only shows `5s`)

### ltx-video-2
- Fix resolution: change to `1080p`, `1440p`, `2160p` (see Part 1 correction)
- Fix duration: spec shows `6`, `8`, `10` — current shows `2s, 5s, 8s` (wrong)

### veo-3
- Add `safety_tolerance`: string — `1`–`6`

### wan-2-6-t2v
- Add `1080p` to resolution options
- Add `multi_shots`: boolean — scene segmentation toggle
- Add `generate_audio`: boolean
- Add `negative_prompt`: string
- Add `seed`: integer
- Fix duration — add `10s` and `15s` options

### claude-chat
- Add `system`: textarea — system prompt
- Add `top_p`: float 0–1
- Add `stop_sequences`: string array
- Add `extended_thinking`: boolean toggle (shows `thinking_budget` field when enabled, integer ≥ 1024)

### gpt-4o-chat
- Add `top_p`: float 0–1
- Add `frequency_penalty`: float -2 to 2
- Add `presence_penalty`: float -2 to 2
- Add `response_format`: enum — `text`, `json_object`, `json_schema`

### gemini-chat
- Add `top_p`: float 0–1
- Add `top_k`: integer (fixed at 64 for Flash models)
- Add `stop_sequences`: string array
- Add `response_format`: enum — `text/plain`, `application/json`

### openrouter-universal
- Add image output port that auto-shows when selected model has `output_modalities: ["image"]`
- When image model selected: use `modalities: ["text", "image"]` in payload; parse `delta.images[]` from response (NOT `data[].b64_json` — OpenRouter uses a different response format than OpenAI)
- Add `top_p`: float 0–1

### fal-universal
- Output port should be dynamic based on endpoint, not hardcoded to Image
- Add Video output port option in the port type dropdown

---

## Part 3 — Missing Nodes (Implement in Priority Order)

### Priority 1 — gpt-image-1-edit

```
ID: gpt-image-1-edit
Provider: OpenAI
API Key: OPENAI_API_KEY
Endpoint: POST /v1/images/edits
Execution: sync
Input ports: Image (required, up to 16), Prompt (Text, required), Mask (optional)
Output ports: Image

Parameters:
- model: enum — gpt-image-1, gpt-image-1.5, gpt-image-1-mini, dall-e-2 (default: gpt-image-1)
- n: integer 1–10 (default 1)
- size: enum — 1024x1024, 1536x1024, 1024x1536 (default 1024x1024)
- quality: enum — low, medium, high (default medium)
- output_format: enum — png, jpeg, webp (default png)
- output_compression: integer 0–100 (jpeg/webp only)
- background: enum — transparent, opaque, auto (default auto)
- input_fidelity: enum — high, low (default low; not available on mini)

Note: supports stream=True with partial_images for progressive rendering
```

---

### Priority 2 — remove-background

```
ID: remove-background
Provider: FAL (primary) / Replicate (fallback)
API Key: FAL_KEY or REPLICATE_API_TOKEN
Endpoint (fal): fal-ai/imageutils/rembg
Execution: sync
Input ports: Image (required)
Output ports: Image (transparent PNG with alpha channel)

Parameters:
- model: enum — rembg (fal), bria/remove-background (Replicate), recraft-ai/recraft-remove-background (Replicate)
```

---

### Priority 3 — recraft-v4-raster

```
ID: recraft-v4-raster
Provider: FAL / Recraft direct
API Key: FAL_KEY or RECRAFT_API_KEY
Endpoint (fal): fal-ai/recraft/v4/text-to-image
Execution: sync
Input ports: Prompt (Text, required)
Output ports: Image

Parameters:
- model: enum — recraft20b, recraftv3 (default recraft20b)
- image_size: enum — square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9 (or custom {width, height})
- style: enum — realistic_image, digital_illustration, vector_illustration, icon
- colors: array of {r,g,b} objects — palette control
- style_id: string — custom style UUID from user's Recraft gallery
```

---

### Priority 3 — recraft-v4-svg

```
ID: recraft-v4-svg
Provider: FAL / Recraft direct
API Key: FAL_KEY or RECRAFT_API_KEY
Endpoint (fal): fal-ai/recraft/v4/text-to-vector
Execution: sync
Input ports: Prompt (Text, required)
Output ports: SVG (Brown port #795548)

Same parameters as recraft-v4-raster above.
Output content_type: image/svg+xml — structured editable vector paths.
Note: SVG output must connect to svg-rasterize utility node if downstream model requires Image port.
```

---

### Priority 4 — minimax-t2v

```
ID: minimax-t2v
Provider: MiniMax direct
API Key: MINIMAX_API_KEY
Endpoint: POST https://api.minimaxi.chat/v1/video_generation
Execution: async-poll (3-STEP PATTERN — see edge cases doc)
Input ports: Prompt (Text, required)
Output ports: Video

Parameters:
- model: enum — MiniMax-Hailuo-2.3, MiniMax-Hailuo-02, S2V-01 (default MiniMax-Hailuo-2.3)
- duration: integer — 6, 9 (default 6)
- resolution: enum — 720P, 1080P (default 1080P)

3-step async pattern:
  Step 1: POST /v1/video_generation → get task_id
  Step 2: Poll GET /v1/query/video_generation?task_id={id} until status === 'Success' or 'Fail'
  Step 3: Wait 1 second, then GET /v1/files/retrieve/{file_id} → actual video URL
```

---

### Priority 4 — minimax-i2v (First+Last Frame)

```
ID: minimax-i2v
Provider: MiniMax direct
API Key: MINIMAX_API_KEY
Endpoint: POST https://api.minimaxi.chat/v1/video_generation
Execution: async-poll (3-step)
Input ports: First Frame (Image, required), Last Frame (Image, optional), Prompt (Text, optional)
Output ports: Video

Parameters:
- model: same as minimax-t2v
- duration: integer — 6, 9
- resolution: enum — 720P, 1080P
- first_frame_image: URL (mapped from First Frame input port)
- last_frame_image: URL (mapped from Last Frame input port, optional)

Camera control: user can write camera commands in brackets inside the prompt:
[Push in], [Orbit left], [Pan right], [Follow], [Crane up], [Zoom out]
```

---

### Priority 4 — minimax-s2v (Subject Reference)

```
ID: minimax-s2v
Provider: MiniMax direct
API Key: MINIMAX_API_KEY
Endpoint: POST https://api.minimaxi.chat/v1/video_generation
Execution: async-poll (3-step)
Input ports: Character Image (Image, required), Prompt (Text, required)
Output ports: Video

Parameters:
- model: S2V-01 (hardcoded for this node)
- duration: integer — 6, 9
- resolution: enum — 720P, 1080P
- subject_reference: [{type: "character", image: [image_url]}] — built from Character Image input
```

---

### Priority 5 — kling-v3

```
ID: kling-v3
Provider: FAL
API Key: FAL_KEY
Endpoint: fal-ai/kling-video/v3/standard/text-to-video (or image-to-video)
Execution: async-poll
Input ports: Prompt (Text, required), Start Image (Image, optional), End Image (Image, optional)
Output ports: Video

Parameters:
- duration: enum — 3s, 5s, 10s, 15s (default 5s)
- resolution: enum — 720p, 1080p (default 1080p)
- aspect_ratio: enum — 16:9, 9:16, 1:1 (default 16:9)
- multi_prompt: array — [{prompt, duration}] for multi-shot scene segmentation
- generate_audio: boolean (default true)
- elements: array — [{frontal_image_url, reference_images}] for element referencing (@Element1 in prompt)
- negative_prompt: string
- cfg_scale: float
```

---

### Priority 6 — luma-ray2-i2v

```
ID: luma-ray2-i2v
Provider: FAL
API Key: FAL_KEY
Endpoint: fal-ai/luma-dream-machine/ray-2/image-to-video
Execution: async-poll
Input ports: Image (required), End Image (Image, optional), Prompt (Text, optional)
Output ports: Video

Parameters:
- aspect_ratio: enum — 16:9, 9:16, 4:3, 3:4, 21:9, 9:21 (default 16:9)
- loop: boolean — seamless loop blend (default false)
- resolution: enum — 540p, 720p, 1080p (default 540p; 720p = 2x cost; 1080p = 4x cost)
- duration: enum — 5s, 9s (default 5s)
```

---

### Priority 6 — luma-ray2-flash-modify

```
ID: luma-ray2-flash-modify
Provider: FAL
API Key: FAL_KEY
Endpoint: fal-ai/luma-dream-machine/ray-2-flash/modify
Execution: async-poll
Input ports: Video (required), Prompt (Text, required)
Output ports: Video

Parameters:
- aspect_ratio: same as ray2-i2v
- resolution: enum — 540p, 720p, 1080p
- duration: enum — 5s, 9s
```

---

### Priority 7 — wan-2-6-i2v

```
ID: wan-2-6-i2v
Provider: FAL
API Key: FAL_KEY
Endpoint: fal-ai/wan/v2.6/image-to-video
Execution: async-poll
Input ports: Image (required), Prompt (Text, required)
Output ports: Video

Parameters:
- duration: enum — 5s, 10s, 15s (default 5s)
- resolution: enum — 480p, 720p, 1080p (default 720p)
- aspect_ratio: enum — 16:9, 9:16, 1:1, 4:3, 3:4 (default 16:9)
- negative_prompt: string
- seed: integer
- generate_audio: boolean
```

---

### Priority 7 — wan-2-6-r2v

```
ID: wan-2-6-r2v
Provider: FAL
API Key: FAL_KEY
Endpoint: fal-ai/wan/v2.6/reference-to-video
Execution: async-poll
Input ports: Video 1 (required), Video 2 (optional), Video 3 (optional), Prompt (Text, required)
Output ports: Video

Note: Reference videos are tagged in the prompt as @Video1, @Video2, @Video3
Parameters: same as wan-2-6-i2v except no image_url; uses video_urls array instead
```

---

### Priority 8 — Utility Nodes

#### frame-extractor
```
ID: frame-extractor
Execution: local (no API)
Input ports: Video (required)
Output ports: Image
Parameters:
- timestamp: float — seconds from start (default 0.0)
- mode: enum — timestamp, first_frame, last_frame, middle_frame
```

#### svg-rasterize
```
ID: svg-rasterize
Execution: local (no API) — use sharp or playwright headless render
Input ports: SVG (required)
Output ports: Image
Parameters:
- width: integer (default 1024)
- height: integer (default 1024)
- background: enum — transparent, white (default transparent)
Note: must handle SVGs with embedded base64 raster images (use headless renderer, not plain SVG parser)
```

#### array-builder
```
ID: array-builder
Execution: local
Input ports: Item 1 (Any, required), Item 2–8 (Any, optional, same type)
Output ports: Array
Note: all connected inputs must be same data type
```

#### array-selector
```
ID: array-selector
Execution: local
Input ports: Array (required)
Output ports: Item (Any — matches array element type)
Parameters:
- index: integer (default 0)
- mode: enum — index, random, first, last
```

#### iterator-image
```
ID: iterator-image
Execution: local (triggers downstream graph per item)
Input ports: Array of Images (required)
Output ports: Image (emits one at a time to downstream)
Parameters:
- batch_size_cap: integer (default from settings, max 25 before confirm dialog)
```

#### iterator-text
```
ID: iterator-text
Execution: local
Input ports: Array of Text (required)
Output ports: Text (emits one at a time)
Parameters:
- batch_size_cap: integer (default from settings)
```

#### video-input
```
ID: video-input
Execution: local
Input ports: — (file picker or URL)
Output ports: Video
Parameters:
- source: file upload or URL string
```

#### audio-input
```
ID: audio-input
Execution: local
Input ports: — (file picker or URL)
Output ports: Audio
Parameters:
- source: file upload or URL string
```

#### sticky-note
```
ID: sticky-note
Execution: none (annotation only)
Input ports: —
Output ports: —
Parameters:
- content: textarea
- color: enum — yellow, blue, green, pink, grey (default yellow)
```

#### image-compare
```
ID: image-compare
Execution: local
Input ports: Image A (required), Image B (required)
Output ports: —
Note: renders side-by-side diff with slider in node body
```

---

### Priority 9 — Remaining Video Models

#### pixverse-v4-5
```
ID: pixverse-v4-5
Provider: FAL
API Key: FAL_KEY
Execution: async-poll
Input ports: Prompt (Text, req for T2V/I2V), Image (req for I2V/Effects)
Output ports: Video
Parameters:
- mode: enum — t2v, i2v, effects (determines which input ports show)
- model: enum — v3.5, v4, v4.5, v5 (default v4.5)
- effect: string (required when mode=effects)
- duration: enum — 5, 8 (default 5)
- resolution: enum — 360p, 540p, 720p, 1080p (default 720p)
- quality: enum — Turbo, Normal, Fast (default Normal)
- seed: integer
- negative_prompt: string
```

#### seedance-v1-5
```
ID: seedance-v1-5
Provider: FAL
API Key: FAL_KEY
Execution: async-poll
Input ports: Prompt (Text, required), Image (optional — enables I2V mode)
Output ports: Video
Parameters:
- duration: enum — 4s–12s
- aspect_ratio: enum — 16:9, 9:16, 1:1, 21:9, 3:4, 4:3 (default 16:9)
- resolution: enum — 480p, 720p (default 720p)
```

#### grok-imagine-video
```
ID: grok-imagine-video
Provider: xAI
API Key: XAI_API_KEY
Execution: async-poll
Input ports: Prompt (Text, required), Image (optional — enables I2V)
Output ports: Video
Parameters:
- duration: integer 1–15 (default 5)
- aspect_ratio: enum — 16:9, 9:16, 1:1, 2:3, 3:2, 3:4, 4:3 (default 16:9)
```

#### moonvalley
```
ID: moonvalley
Provider: FAL
API Key: FAL_KEY
Execution: async-poll
Input ports: Image (required), Prompt (Text, optional)
Output ports: Video
Parameters:
- duration: enum — 5s, 10s (default 5s)
- resolution: enum — 1920x1080, 1080x1920, 1152x1152, 1536x1152, 1152x1536
```

#### higgsfield
```
ID: higgsfield
Provider: Higgsfield direct
API Key: HIGGSFIELD_API_KEY
Execution: async-poll
Input ports: Prompt (Text, required)
Output ports: Video
Parameters:
- model: enum — higgsfield-native, kling-2.6, sora-2, veo-3.1 (Higgsfield wraps multiple models)
- duration: integer seconds
- keyframes: array (optional)
```

---

### Priority 10 — New Variants (Most Recent Releases)

#### kling-o3 (Kling Omni 3)
```
ID: kling-o3
Provider: FAL
API Key: FAL_KEY
Endpoint: fal-ai/kling-video/o3/standard/image-to-video (or reference-to-video)
Execution: async-poll
Input ports: Image (required), Prompt (Text, required), Reference Videos (Video, up to 3, optional)
Output ports: Video
Parameters:
- duration: enum — 5s, 10s
- resolution: enum — 720p, 1080p (default 1080p)
- aspect_ratio: enum — 16:9, 9:16, 1:1
- elements: array — multi-character/object element binding
- generate_audio: boolean

Difference from v3: adds multi-character coreference (3+ characters), voice input binding,
video element referencing, and multi-image element building.
```

#### ltx-2-3
```
ID: ltx-2-3
Provider: FAL
API Key: FAL_KEY
Endpoint: fal-ai/ltx-2.3/image-to-video
Execution: async-poll
Input ports: Image (required for I2V mode), Prompt (Text, required), Audio (optional — for A2V mode)
Output ports: Video
Parameters:
- mode: enum — image-to-video, audio-to-video, extend-video, retake-video
- duration: integer 2–20 (default 6; up to 20s is new in 2.3)
- resolution: enum — 1080p, 1440p, 2160p
- aspect_ratio: enum — 16:9, 9:16, 1:1 (9:16 portrait is new in 2.3)
- fps: integer — 25 or 50
- generate_audio: boolean

Replaces ltx-video-2 as the recommended LTX node.
```

---

## Part 4 — New API Keys to Add to .env.example

```bash
# Add these to .env.example — not in the original spec

# MiniMax / Hailuo
MINIMAX_API_KEY=...

# xAI / Grok
XAI_API_KEY=xai-...

# Recraft
RECRAFT_API_KEY=...

# Higgsfield
HIGGSFIELD_API_KEY=...

# Meshy (already added by Claude Code — keep it)
MESHY_API_KEY=...
```

---

## Part 5 — Port Type Reminder

The following port types must be supported in the port system. Claude Code already added `Mesh` (cyan) which is correct — keep it.

| Color | Hex | Type | Notes |
|---|---|---|---|
| 🟢 Green | `#4CAF50` | Image | PNG, JPEG, WebP |
| 🔴 Red | `#F44336` | Video | MP4, WebM |
| 🟣 Purple | `#9C27B0` | Text | Prompts, strings |
| 🔵 Blue | `#2196F3` | Array | Lists |
| 🟡 Yellow/Amber | `#FFC107` | Audio | MP3, WAV |
| 🟢 Lime | `#8BC34A` | Mask | Alpha PNG |
| 🟤 Brown | `#795548` | SVG | Vector — needed for recraft-v4-svg output |
| 🩵 Cyan | `#00BCD4` | Mesh | 3D mesh — added by Claude, keep it |
| ⚪ Grey | `#9E9E9E` | Any | Wildcard — utility nodes only |

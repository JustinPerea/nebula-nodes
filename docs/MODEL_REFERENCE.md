# Nebula Node — Model Reference

Complete reference for all 60 nodes. Nodes with dual-provider support show separate parameter tables for each API route.

**Dual-param nodes** (marked with `[dual]`) show different parameters depending on which API key is configured. The Inspector automatically selects the right set.

---

## Image Generation

### GPT Image 1
| | |
|---|---|
| **ID** | `gpt-image-1-generate` |
| **Provider** | OpenAI |
| **API Key** | `OPENAI_API_KEY` |
| **Execution** | Sync |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gpt-image-1 | GPT Image 1, GPT Image 1.5, GPT Image 1 Mini |
| Size | enum | auto | Auto, 1024x1024, 1536x1024, 1024x1536 |
| Quality | enum | auto | Auto, Low, Medium, High |
| Count | int (1-10) | 1 | — |
| Format | enum | png | PNG, JPEG, WebP |
| Background | enum | auto | Auto, Transparent, Opaque |

---

### DALL-E 3
| | |
|---|---|
| **ID** | `dalle-3-generate` |
| **Provider** | OpenAI |
| **API Key** | `OPENAI_API_KEY` |
| **Execution** | Sync |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | dall-e-3 | DALL-E 3, DALL-E 2 |
| Size | enum | 1024x1024 | 1024x1024, 1024x1792, 1792x1024 |
| Quality | enum | standard | Standard, HD |
| Style | enum | vivid | Vivid, Natural |

---

### Imagen 4
| | |
|---|---|
| **ID** | `imagen-4-generate` |
| **Provider** | Google |
| **API Key** | `GOOGLE_API_KEY` |
| **Execution** | Sync |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | imagen-4.0-generate-001 | Imagen 4, Imagen 4 Ultra, Imagen 4 Fast |
| Aspect Ratio | enum | 1:1 | 1:1, 4:3, 3:4, 16:9, 9:16 |
| Count | int (1-4) | 1 | — |
| Seed | int | random | — |
| Enhance Prompt | bool | false | — |
| Person Generation | enum | allow_adult | Allow All, Allow Adult, Don't Allow |

---

### Nano Banana (Gemini Native Image)
| | |
|---|---|
| **ID** | `nano-banana` |
| **Provider** | Google |
| **API Key** | `GOOGLE_API_KEY` |
| **Execution** | Sync |
| **Input** | Prompt (Text), Images (Image, multiple) |
| **Output** | Image, Text |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gemini-2.5-flash-image | Gemini 3 Pro Image, Gemini 3.1 Flash Image, Gemini 2.5 Flash Image |
| Aspect Ratio | enum | 1:1 | 1:1, 16:9, 9:16, 4:3, 3:4 |

---

### FLUX 1.1 Ultra `[dual]`
| | |
|---|---|
| **ID** | `flux-1-1-ultra` |
| **Provider** | FAL / Black Forest Labs |
| **API Key** | `FAL_KEY` or `BFL_API_KEY` |
| **Direct Key** | `BFL_API_KEY` |
| **Execution** | Sync |
| **Input** | Prompt (Text), Image Guide (Image, optional) |
| **Output** | Image |

**Shared params (always shown):**

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Aspect Ratio | enum | 16:9 | 21:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16, 9:21 |
| Count | int (1-4) | 1 | — |

**BFL Direct params** (when `BFL_API_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Raw (Natural Look) | bool | false | — |

**FAL params** (when only `FAL_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Safety Tolerance | enum | 2 | 1 (Strict) – 6 (Permissive) |
| Enhance Prompt | bool | false | — |
| Format | enum | jpeg | JPEG, PNG |
| Seed | int | random | — |
| Image Influence | float (0-1) | 0.1 | — |

---

### FLUX Schnell
| | |
|---|---|
| **ID** | `flux-schnell` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Image Size | enum | landscape_16_9 | square, landscape_16_9, portrait_9_16, landscape_4_3, portrait_3_4 |
| Steps | int (1-12) | 4 | — |
| Seed | int | random | — |
| Count | int (1-4) | 1 | — |

---

### Fast SDXL
| | |
|---|---|
| **ID** | `fast-sdxl` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Image Size | enum | landscape_16_9 | square_hd, square, landscape_16_9, portrait_9_16, landscape_4_3, portrait_3_4 |
| Steps | int (1-50) | 25 | — |
| Guidance | float (1-20) | 7.5 | — |
| Seed | int | random | — |

---

### GPT Image 1 Edit
| | |
|---|---|
| **ID** | `gpt-image-1-edit` |
| **Provider** | OpenAI |
| **API Key** | `OPENAI_API_KEY` |
| **Execution** | Sync |
| **Input** | Image (required), Prompt (Text, required), Mask (optional) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gpt-image-1 | GPT Image 1, GPT Image 1.5, GPT Image 1 Mini, DALL-E 2 |
| Count | int (1-10) | 1 | — |
| Size | enum | 1024x1024 | 1024x1024, 1536x1024, 1024x1536 |
| Quality | enum | medium | Low, Medium, High |
| Format | enum | png | PNG, JPEG, WebP |
| Background | enum | auto | Auto, Transparent, Opaque |

---

### Remove Background
| | |
|---|---|
| **ID** | `remove-background` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required) |
| **Output** | Image (transparent PNG) |

No parameters.

---

### Recraft V4
| | |
|---|---|
| **ID** | `recraft-v4-raster` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Size | enum | square_hd | Square HD, Square, Portrait 4:3, Portrait 16:9, Landscape 4:3, Landscape 16:9 |
| Style | enum | realistic_image | Realistic, Digital Illustration, Vector Illustration, Icon |
| Style ID | string | — | Custom style UUID |

---

### Recraft V4 SVG
| | |
|---|---|
| **ID** | `recraft-v4-svg` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | SVG |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Size | enum | square_hd | Square HD, Square, Portrait 4:3, Portrait 16:9, Landscape 4:3, Landscape 16:9 |
| Style | enum | vector_illustration | Vector Illustration, Digital Illustration, Icon |
| Style ID | string | — | Custom style UUID |

---

## Text Generation

### Claude
| | |
|---|---|
| **ID** | `claude-chat` |
| **Provider** | Anthropic |
| **API Key** | `ANTHROPIC_API_KEY` |
| **Execution** | Stream |
| **Input** | Messages (Text), Images (Image, multiple) |
| **Output** | Text |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | claude-sonnet-4-6 | Claude Opus 4, Claude Sonnet 4.6, Claude Haiku 3.5 |
| Max Tokens | int (1-200000) | 4096 | — |
| Temperature | float (0-1) | 1 | — |
| System Prompt | textarea | — | — |
| Top P | float (0-1) | default | — |
| Stop Sequences | string | — | Comma-separated |
| Extended Thinking | bool | false | — |
| Thinking Budget | int (1024-200000) | default | Shown when Extended Thinking is on |

---

### GPT-4o Chat
| | |
|---|---|
| **ID** | `gpt-4o-chat` |
| **Provider** | OpenAI |
| **API Key** | `OPENAI_API_KEY` |
| **Execution** | Stream |
| **Input** | Messages (Text), Images (Image, multiple) |
| **Output** | Text |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gpt-4o | GPT-4o, GPT-4o Mini, GPT-4.1 |
| Max Tokens | int (1-128000) | 4096 | — |
| Temperature | float (0-2) | 1 | — |
| Top P | float (0-1) | default | — |
| Frequency Penalty | float (-2 to 2) | 0 | — |
| Presence Penalty | float (-2 to 2) | 0 | — |
| Response Format | enum | text | Text, JSON |

---

### Gemini
| | |
|---|---|
| **ID** | `gemini-chat` |
| **Provider** | Google |
| **API Key** | `GOOGLE_API_KEY` |
| **Execution** | Stream |
| **Input** | Messages (Text), Images (Image, multiple) |
| **Output** | Text |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gemini-2.5-flash | Gemini 3.1 Pro, Gemini 3 Flash, Gemini 3.1 Flash Lite, Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 2.5 Flash Lite |
| Max Tokens | int (1-65535) | 8192 | — |
| Temperature | float (0-2) | 1 | — |
| Thinking Budget | int (0-65536) | default | — |
| Top P | float (0-1) | default | — |
| Top K | int | 64 | — |
| Stop Sequences | string | — | Comma-separated |
| Response Format | enum | text/plain | Text, JSON |

---

## Video Generation

### Veo 3.1 `[dual]`
| | |
|---|---|
| **ID** | `veo-3` |
| **Provider** | Google (direct) / FAL (fallback) |
| **API Key** | `GOOGLE_API_KEY` or `FAL_KEY` |
| **Direct Key** | `GOOGLE_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text), First Frame (Image, optional), Last Frame (Image, optional) |
| **Output** | Video |

**Shared params (always shown):**

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Aspect Ratio | enum | 16:9 | 16:9, 9:16 |
| Duration | enum | 8 | 4s, 6s, 8s |
| Resolution | enum | 720p | 720p, 1080p |
| Generate Audio | bool | true | — |

**Google Direct params** (when `GOOGLE_API_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | veo-3.1-generate-preview | Veo 3.1, Veo 3.1 Lite, Veo 3.1 Fast, Veo 3, Veo 2 |

**FAL params** (when only `FAL_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Negative Prompt | string | — | — |
| Seed | int | random | — |
| Safety Tolerance | enum | 4 | 1 (Strict) – 6 (Permissive) |

---

### Runway Gen-4 Turbo
| | |
|---|---|
| **ID** | `runway-gen4-turbo` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), Prompt (Text, optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gen4_turbo | Gen-4 Turbo, Gen-4, Gen-4 Aleph |
| Duration | enum | 5 | 5s, 10s |
| Ratio | enum | 1280:720 | 1280x720, 1584x672, 1104x832, 720x1280, 832x1104, 960x960 |
| Seed | int (0-4294967295) | random | — |

---

### Kling v2.1
| | |
|---|---|
| **ID** | `kling-v2-1` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), Prompt (Text, optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5 | 5s, 10s |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Negative Prompt | string | blur, distort, and low quality | — |
| CFG Scale | float (0-1) | 0.5 | — |

---

### Sora 2
| | |
|---|---|
| **ID** | `sora-2` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Resolution | enum | 1080p | 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16 |
| Duration | enum | 4s | 4s, 8s, 12s, 16s, 20s |

---

### Wan 2.6 T2V
| | |
|---|---|
| **ID** | `wan-2-6-t2v` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Resolution | enum | 720p | 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Duration | enum | 5s | 5s, 10s, 15s |
| Negative Prompt | string | — | — |
| Seed | int | random | — |
| Generate Audio | bool | false | — |

---

### Luma Ray 2
| | |
|---|---|
| **ID** | `luma-ray2-t2v` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 |
| Resolution | enum | 720p | 540p, 720p, 1080p |
| Duration | enum | 5s | 5s, 9s |
| Seamless Loop | bool | false | — |

---

### LTX Video 2
| | |
|---|---|
| **ID** | `ltx-video-2` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), Prompt (Text, optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1, 4:3, 3:4 |
| Resolution | enum | 1080p | 1080p, 1440p, 2160p |
| Duration | enum | 6 | 6, 8, 10 |

---

### MiniMax T2V
| | |
|---|---|
| **ID** | `minimax-t2v` |
| **Provider** | MiniMax |
| **API Key** | `MINIMAX_API_KEY` |
| **Execution** | Async-poll (3-step) |
| **Input** | Prompt (Text) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | MiniMax-Hailuo-2.3 | Hailuo 2.3, Hailuo 02 |
| Duration | enum | 6 | 6s, 9s |
| Resolution | enum | 1080P | 720P, 1080P |

---

### MiniMax I2V
| | |
|---|---|
| **ID** | `minimax-i2v` |
| **Provider** | MiniMax |
| **API Key** | `MINIMAX_API_KEY` |
| **Execution** | Async-poll (3-step) |
| **Input** | First Frame (Image, required), Last Frame (Image, optional), Prompt (Text, optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | MiniMax-Hailuo-2.3 | Hailuo 2.3, Hailuo 02 |
| Duration | enum | 6 | 6s, 9s |
| Resolution | enum | 1080P | 720P, 1080P |

---

### MiniMax S2V
| | |
|---|---|
| **ID** | `minimax-s2v` |
| **Provider** | MiniMax |
| **API Key** | `MINIMAX_API_KEY` |
| **Execution** | Async-poll (3-step) |
| **Input** | Character Image (required), Prompt (Text, required) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 6 | 6s, 9s |
| Resolution | enum | 1080P | 720P, 1080P |

---

### Kling V3
| | |
|---|---|
| **ID** | `kling-v3` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, required), Start Image (optional), End Image (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5 | 3s, 5s, 10s, 15s |
| Resolution | enum | 1080p | 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Negative Prompt | string | — | — |
| Generate Audio | bool | true | — |
| CFG Scale | float (0-1) | 0.5 | — |

---

### Kling Omni 3
| | |
|---|---|
| **ID** | `kling-o3` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), Prompt (Text, required) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5 | 5s, 10s |
| Resolution | enum | 1080p | 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Generate Audio | bool | true | — |

---

### Luma Ray 2 I2V
| | |
|---|---|
| **ID** | `luma-ray2-i2v` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), End Image (optional), Prompt (Text, optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 4:3, 3:4, 21:9 |
| Resolution | enum | 540p | 540p, 720p (2x), 1080p (4x) |
| Duration | enum | 5s | 5s, 9s |
| Seamless Loop | bool | false | — |

---

### Luma Ray 2 Flash Modify
| | |
|---|---|
| **ID** | `luma-ray2-flash-modify` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Video (required), Prompt (Text, required) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 4:3, 3:4, 21:9 |
| Resolution | enum | 540p | 540p, 720p, 1080p |
| Duration | enum | 5s | 5s, 9s |

---

### Wan 2.6 I2V
| | |
|---|---|
| **ID** | `wan-2-6-i2v` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), Prompt (Text, required) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5s | 5s, 10s, 15s |
| Resolution | enum | 720p | 480p, 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1, 4:3, 3:4 |
| Negative Prompt | string | — | — |
| Seed | int | random | — |
| Generate Audio | bool | false | — |

---

### Wan 2.6 R2V
| | |
|---|---|
| **ID** | `wan-2-6-r2v` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, required), Video 1 (required), Video 2, Video 3 (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5s | 5s, 10s, 15s |
| Resolution | enum | 720p | 480p, 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Negative Prompt | string | — | — |
| Seed | int | random | — |

---

### PixVerse V4.5
| | |
|---|---|
| **ID** | `pixverse-v4-5` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, required), Image (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5 | 5s, 8s |
| Resolution | enum | 720p | 360p, 540p, 720p, 1080p |
| Quality | enum | Normal | Turbo, Normal, Fast |
| Negative Prompt | string | — | — |
| Seed | int | random | — |

---

### Seedance V1.5
| | |
|---|---|
| **ID** | `seedance-v1-5` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, required), Image (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 8s | 4s, 6s, 8s, 10s, 12s |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1, 21:9, 4:3, 3:4 |
| Resolution | enum | 720p | 480p, 720p |

---

### Moonvalley
| | |
|---|---|
| **ID** | `moonvalley` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), Prompt (Text, optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5s | 5s, 10s |
| Resolution | enum | 1920x1080 | 1920x1080, 1080x1920, 1152x1152 |

---

### LTX 2.3
| | |
|---|---|
| **ID** | `ltx-2-3` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (optional), Prompt (Text, required), Audio (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | int (2-20) | 6 | — |
| Resolution | enum | 1080p | 1080p, 1440p, 2160p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| FPS | enum | 25 | 25, 50 |
| Generate Audio | bool | false | — |

---

### Grok Imagine Video
| | |
|---|---|
| **ID** | `grok-imagine-video` |
| **Provider** | xAI |
| **API Key** | `XAI_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, required), Image (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | int (1-15) | 5 | — |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1, 4:3, 3:4 |

---

### Higgsfield
| | |
|---|---|
| **ID** | `higgsfield` |
| **Provider** | Higgsfield |
| **API Key** | `HIGGSFIELD_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | higgsfield-native | Higgsfield Native |
| Duration | int (1-15) | 5 | — |

---

## Audio Generation

### ElevenLabs TTS
| | |
|---|---|
| **ID** | `elevenlabs-tts` |
| **Provider** | ElevenLabs |
| **API Key** | `ELEVENLABS_API_KEY` |
| **Execution** | Sync |
| **Input** | Text (required) |
| **Output** | Audio |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | eleven_multilingual_v2 | v3 (Highest), Multilingual v2, Flash v2.5 |
| Stability | float (0-1) | 0.5 | — |
| Voice ID | string | 21m00Tcm4TlvDq8ikWAM | Rachel (default) |
| Similarity Boost | float (0-1) | 0.75 | — |
| Style | float (0-1) | 0 | — |
| Speed | float (0.1-4.0) | 1.0 | — |
| Output Format | enum | mp3_44100_128 | MP3 44.1kHz, MP3 22kHz, PCM 16kHz, PCM 24kHz, PCM 44.1kHz |
| Seed | int | random | — |

---

## 3D Generation

### Meshy 6 Text-to-3D `[dual]`
| | |
|---|---|
| **ID** | `meshy-text-to-3d` |
| **Provider** | Meshy (direct) / FAL (fallback) |
| **API Key** | `MESHY_API_KEY` or `FAL_KEY` |
| **Direct Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Mesh |

**Shared params (always shown):**

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Mode | enum | full | Preview, Full |
| Topology | enum | triangle | Triangle, Quad |
| Polycount | int (1000-200000) | 30000 | — |
| Symmetry | enum | auto | Off, Auto, On |
| PBR Materials | bool | false | — |
| Pose Mode | enum | (none) | None, A-Pose, T-Pose |
| Rigging | bool | false | — |

**Meshy Direct params** (when `MESHY_API_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| AI Model | enum | latest | Latest (Meshy 6), Meshy 6, Meshy 5 |
| Output Formats | string | glb | glb,fbx,obj,usdz |
| Seed | int | random | — |

**FAL params** (when only `FAL_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Texture Prompt | string | — | Guide the texturing process |
| Enhance Prompt | bool | false | — |
| Safety Checker | bool | true | — |
| Seed | int | random | — |

---

### Meshy 6 Image-to-3D `[dual]`
| | |
|---|---|
| **ID** | `meshy-image-to-3d` |
| **Provider** | Meshy (direct) / FAL (fallback) |
| **API Key** | `MESHY_API_KEY` or `FAL_KEY` |
| **Direct Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required) |
| **Output** | Mesh |

**Shared params (always shown):**

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Topology | enum | triangle | Triangle, Quad |
| Polycount | int (1000-200000) | 30000 | — |
| Symmetry | enum | auto | Off, Auto, On |
| Texture | bool | true | — |
| PBR Materials | bool | false | — |
| Pose Mode | enum | (none) | None, A-Pose, T-Pose |
| Rigging | bool | false | — |

**Meshy Direct params** (when `MESHY_API_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| AI Model | enum | latest | Latest (Meshy 6), Meshy 6, Meshy 5 |
| Mesh Type | enum | standard | Standard, Low Poly |
| Output Formats | string | glb | glb,fbx,obj,usdz |

**FAL params** (when only `FAL_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Texture Prompt | string | — | Guide the texturing process |
| Safety Checker | bool | true | — |
| Seed | int | random | — |

---

### Hunyuan3D V3 Text-to-3D
| | |
|---|---|
| **ID** | `hunyuan3d-text-to-3d` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Mesh |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Quality | enum | Normal | Normal, Low Poly, Geometry Only |
| Face Count | int (40000-1500000) | 500000 | — |
| PBR Materials | bool | false | — |
| Polygon Type | enum | triangle | Triangle, Quadrilateral |

---

### Hunyuan3D V3 Image-to-3D
| | |
|---|---|
| **ID** | `hunyuan3d-image-to-3d` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Front Image (required), Back Image, Left Image, Right Image (all optional) |
| **Output** | Mesh |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Quality | enum | Normal | Normal, Low Poly, Geometry Only |
| Face Count | int (40000-1500000) | 500000 | — |
| PBR Materials | bool | false | — |
| Polygon Type | enum | triangle | Triangle, Quadrilateral |

---

## Universal Nodes

### OpenRouter
| | |
|---|---|
| **ID** | `openrouter-universal` |
| **Provider** | OpenRouter (1000+ models) |
| **API Key** | `OPENROUTER_API_KEY` |
| **Execution** | Stream |
| **Input** | Messages (Text) |
| **Output** | Text |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | string (searchable) | — | 1000+ models via dropdown |
| Temperature | float (0-2) | 1.0 | — |
| Max Tokens | int (1-200000) | 4096 | — |

---

### Replicate
| | |
|---|---|
| **ID** | `replicate-universal` |
| **Provider** | Replicate (schema-driven) |
| **API Key** | `REPLICATE_API_TOKEN` |
| **Execution** | Async-poll |
| **Input** | Dynamic (from schema) |
| **Output** | Dynamic (from schema) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model ID | string | — | e.g. `stability-ai/sdxl` |
| *(dynamic)* | *(from Fetch Schema)* | — | — |

---

### FAL
| | |
|---|---|
| **ID** | `fal-universal` |
| **Provider** | FAL (any endpoint) |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text), Image (optional) |
| **Output** | Image, Video, Audio, Mesh (all available — handler auto-detects output type) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Endpoint | string | fal-ai/flux-pro/v1.1-ultra | Any FAL endpoint ID |

---

## Utility Nodes

### Text Input
| **ID** | `text-input` |
|---|---|
| **Input** | — |
| **Output** | Text |
| **Param** | Text (textarea, spellcheck enabled) |

### Image Input
| **ID** | `image-input` |
|---|---|
| **Input** | — (file upload / canvas drop) |
| **Output** | Image |
| **Param** | File (file picker) |

### Preview
| **ID** | `preview` |
|---|---|
| **Input** | Input (Any) |
| **Output** | — |

### Combine Text
| **ID** | `combine-text` |
|---|---|
| **Input** | Text 1 (required), Text 2, Text 3 |
| **Output** | Text |
| **Params** | Separator (default: `\n`), Template (optional: `{text1}`, `{text2}`, `{text3}` placeholders) |

### Router
| **ID** | `router` |
|---|---|
| **Input** | Input (Any) |
| **Output** | Out 1, Out 2, Out 3 (Any) |

### Reroute
| **ID** | `reroute` |
|---|---|
| **Input** | Input (Any) |
| **Output** | Output (Any) |

### Video Input
| **ID** | `video-input` |
|---|---|
| **Input** | — (file upload) |
| **Output** | Video |
| **Param** | File (file picker) |

### Audio Input
| **ID** | `audio-input` |
|---|---|
| **Input** | — (file upload) |
| **Output** | Audio |
| **Param** | File (file picker) |

### Sticky Note
| **ID** | `sticky-note` |
|---|---|
| **Input** | — |
| **Output** | — |
| **Params** | Content (textarea), Color (yellow, blue, green, pink, grey) |

### Frame Extractor
| **ID** | `frame-extractor` |
|---|---|
| **Category** | Transform |
| **Input** | Video (required) |
| **Output** | Image |
| **Params** | Mode (First Frame, Last Frame, Middle Frame, At Timestamp), Timestamp (float) |

### SVG Rasterize
| **ID** | `svg-rasterize` |
|---|---|
| **Category** | Transform |
| **Input** | SVG (required) |
| **Output** | Image |
| **Params** | Width (64-4096, default 1024), Height (64-4096, default 1024), Background (Transparent, White) |

### Array Builder
| **ID** | `array-builder` |
|---|---|
| **Input** | Item 1 (Any, required), Item 2-4 (Any, optional) |
| **Output** | Array |

### Array Selector
| **ID** | `array-selector` |
|---|---|
| **Input** | Array (required) |
| **Output** | Item (Any) |
| **Params** | Mode (First, Last, Random, By Index), Index (int, default 0) |

### Image Compare
| **ID** | `image-compare` |
|---|---|
| **Input** | Image A (required), Image B (required) |
| **Output** | — |

### Image Iterator
| **ID** | `iterator-image` |
|---|---|
| **Input** | Images (Array, required) |
| **Output** | Image (emits per item) |
| **Params** | Batch Size Cap (1-25, default 10) |

### Text Iterator
| **ID** | `iterator-text` |
|---|---|
| **Input** | Texts (Array, required) |
| **Output** | Text (emits per item) |
| **Params** | Batch Size Cap (1-25, default 10) |

---

## API Key Summary

| Key | Provider | Used By |
|-----|----------|---------|
| `OPENAI_API_KEY` | [OpenAI](https://platform.openai.com/api-keys) | GPT Image 1, DALL-E 3, GPT-4o Chat |
| `ANTHROPIC_API_KEY` | [Anthropic](https://console.anthropic.com/settings/keys) | Claude |
| `GOOGLE_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) | Gemini, Imagen 4, Nano Banana, Veo 3.1 |
| `OPENROUTER_API_KEY` | [OpenRouter](https://openrouter.ai/keys) | OpenRouter (1000+ models) |
| `REPLICATE_API_TOKEN` | [Replicate](https://replicate.com/account/api-tokens) | Replicate |
| `FAL_KEY` | [fal.ai](https://fal.ai/dashboard/keys) | FLUX, Kling, Sora 2, Wan, Luma, LTX, Hunyuan3D, fallbacks |
| `MESHY_API_KEY` | [Meshy](https://app.meshy.ai/settings/api) | Meshy 6 Text/Image-to-3D |
| `BFL_API_KEY` | [Black Forest Labs](https://api.bfl.ml/auth/profile) | FLUX 1.1 Ultra |
| `RUNWAY_API_KEY` | [Runway](https://app.runwayml.com/settings/api-keys) | Runway Gen-4 |
| `ELEVENLABS_API_KEY` | [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) | ElevenLabs TTS |
| `MINIMAX_API_KEY` | [MiniMax](https://www.minimaxi.com/platform) | MiniMax T2V/I2V/S2V |
| `XAI_API_KEY` | [xAI](https://console.x.ai) | Grok Imagine Video |
| `HIGGSFIELD_API_KEY` | [Higgsfield](https://app.higgsfield.ai/settings) | Higgsfield |

---

## Port Types

| Type | Color | Compatible With |
|------|-------|----------------|
| Text | #9C27B0 (purple) | Text, Any |
| Image | #4CAF50 (green) | Image, Mask, Any |
| Video | #F44336 (red) | Video, Any |
| Audio | #FFC107 (amber) | Audio, Any |
| Mesh | #00BCD4 (cyan) | Mesh, Any |
| Mask | #8BC34A (light green) | Mask, Image, Any |
| SVG | #795548 (brown) | SVG, Any |
| Array | #2196F3 (blue) | Array, Any |
| Any | #9E9E9E (gray) | All types |

---

## Architecture Notes

### Dual-Param System
Nodes with both FAL and direct API support use three param arrays:
- **`sharedParams`** — always shown regardless of route
- **`directParams`** — shown when `directKeyName` API key is configured
- **`falParams`** — shown when only `FAL_KEY` is available

The Inspector auto-detects which route is active based on the settings cache. Handlers similarly check for the direct key first and fall back to FAL.

**Current dual-param nodes:** FLUX 1.1 Ultra, Veo 3.1, Meshy 6 Text-to-3D, Meshy 6 Image-to-3D

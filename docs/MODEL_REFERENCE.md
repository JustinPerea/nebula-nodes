# Nebula Node — Model Reference

Complete reference for all 77 nodes. Nodes with dual-provider support show separate parameter tables for each API route.

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
| Image Size | enum | 1K | 1K, 2K (visible when model is Imagen 4 or Ultra) |
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
| Model | enum | gemini-3.1-flash-image-preview | Nano Banana 2 (3.1 Flash), Nano Banana Pro (3 Pro), Nano Banana (2.5 Flash) |
| Aspect Ratio | enum | 1:1 | 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9, 1:4 (3.1 Flash only), 4:1 (3.1 Flash only), 1:8 (3.1 Flash only), 8:1 (3.1 Flash only) |
| Image Size | enum | 1K | 512 (3.1 Flash only), 1K, 2K, 4K (visible when model is 3.1 Flash or 3 Pro) |

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
| **Execution** | Sync |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Aspect Ratio | enum | 16:9 | 1:1, 16:9, 9:16, 4:3, 3:4 |
| Count | int (1-4) | 1 | — |
| Seed | int (0-2147483647) | random | — |

---

### Fast SDXL
| | |
|---|---|
| **ID** | `fast-sdxl` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Sync |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Image Size | enum | square_hd | Square HD, Square, Landscape 4:3, Landscape 16:9, Portrait 4:3, Portrait 16:9 |
| Count | int (1-4) | 1 | — |
| Guidance Scale | float (1-20) | 7.5 | — |
| Negative Prompt | string | — | — |

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
| Color Palette | string | — | Comma-separated hex (e.g. #FF0000,#00FF00,#0000FF) |

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
| Color Palette | string | — | Comma-separated hex (e.g. #FF0000,#00FF00,#0000FF) |

---

### Runway Image
| | |
|---|---|
| **ID** | `runway-image` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, required), Reference Images (Image, multiple, optional) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gen4_image | Gen-4 Image, Gen-4 Image Turbo, Gemini 2.5 Flash |
| Ratio | enum | 1360:768 | 1360x768, 768x1360, 1024x1024, 1080x1080, 1168x880, 1440x1080, 1080x1440, 1920x1080, 1080x1920, 1808x768, 2112x912 |
| Seed | int (0-4294967295) | random | — |

---

### Meshy Text-to-Image
| | |
|---|---|
| **ID** | `meshy-text-to-image` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | nano-banana | Nano Banana, Nano Banana Pro |
| Multi-View | bool | false | — |
| Aspect Ratio | enum | 1:1 | 1:1, 16:9, 9:16, 4:3, 3:4 (hidden when Multi-View is true) |
| Pose Mode | enum | (none) | None, A-Pose, T-Pose |

---

### Meshy Image-to-Image
| | |
|---|---|
| **ID** | `meshy-image-to-image` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, required), Reference Images (Image, required, multiple) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | nano-banana | Nano Banana, Nano Banana Pro |
| Multi-View | bool | false | — |

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
| Thinking Budget | int (1024-200000) | default | (visible when Extended Thinking is on) |

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
| System Prompt | textarea | — | — |
| Thinking Level | enum | default | Default, Minimal, Low, Medium, High (visible when model is 3.1 Pro, 3 Flash, or 3.1 Flash Lite) |
| Thinking Budget | int (0-65536) | default | (visible when model is 2.5 Pro, 2.5 Flash, or 2.5 Flash Lite) |
| Top P | float (0-1) | default | — |
| Top K | int | 64 | — |
| Stop Sequences | string | — | Comma-separated |
| Response Format | enum | text/plain | Text, JSON |

---

## Video Generation

### Runway Video
| | |
|---|---|
| **ID** | `runway-video` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Prompt (Text, optional), Image (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gen4.5 | Gen-4.5, Gen-4 Turbo, Gen-3a Turbo, Veo 3.1, Veo 3.1 Fast, Veo 3 |
| Duration | int (2-10) | 5 | — |
| Ratio | enum | 1280:720 | 1280x720 (16:9), 720x1280 (9:16), 1104x832 (4:3), 832x1104 (3:4), 960x960 (1:1), 1584x672 (21:9) |
| Seed | int (0-4294967295) | random | — |

---

### Runway Aleph
| | |
|---|---|
| **ID** | `runway-aleph` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Video (required), Prompt (Text, required), Reference Image (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Seed | int (0-4294967295) | random | — |

---

### Runway Act-Two
| | |
|---|---|
| **ID** | `runway-act-two` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Character Image (optional), Character Video (optional), Performance Video (required) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Body Control | bool | false | — |
| Expression Intensity | int (1-5) | 3 | — |
| Ratio | enum | 1280:720 | 1280x720 (16:9), 720x1280 (9:16), 960x960 (1:1), 1104x832 (4:3), 832x1104 (3:4), 1584x672 (21:9) |
| Seed | int (0-4294967295) | random | — |

---

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
| Duration | enum | 8 | 4s (Veo 3.x only), 5s (Veo 2 only), 6s, 8s |
| Resolution | enum | 720p | 720p, 1080p, 4K (Veo 3.x, not Lite) — visible for Veo 3.x models |
| Person Generation | enum | allow_adult | Allow All, Allow Adult, Don't Allow |

**Google Direct params** (when `GOOGLE_API_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | veo-3.1-generate-preview | Veo 3.1, Veo 3.1 Fast, Veo 3.1 Lite, Veo 3, Veo 3 Fast, Veo 2 |
| Seed | int | random | (visible for Veo 3.x models) |

**FAL params** (when only `FAL_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Negative Prompt | string | — | — |
| Seed | int | random | — |
| Safety Tolerance | enum | 4 | 1 (Strict) – 6 (Permissive) |

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
| **Input** | Image (required), Prompt (Text, required), Ref Video 1-3 (Video, optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5 | 5s, 10s |
| Resolution | enum | 1080p | 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Generate Audio | bool | true | — |

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
| Duration | enum | 5s | 5s, 10s, 15s |
| Resolution | enum | 720p | 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Negative Prompt | string | — | — |
| Seed | int | random | — |
| Generate Audio | bool | false | — |

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
| **Input** | Prompt (Text, required), Video 1 (required), Video 2 (optional), Video 3 (optional) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 5s | 5s, 10s, 15s |
| Resolution | enum | 720p | 480p, 720p, 1080p |
| Aspect Ratio | enum | 16:9 | 16:9, 9:16, 1:1 |
| Negative Prompt | string | — | — |
| Seed | int | random | — |

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
| Aspect Ratio | enum | 16:9 | 1:1, 16:9, 9:16, 4:3, 3:4 |
| Duration | enum | 5s | 5s, 9s |
| Seamless Loop | bool | false | — |
| Resolution | enum | 720p | 540p, 720p, 1080p |

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
| Resolution | enum | 540p | 540p, 720p (2x cost), 1080p (4x cost) |
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

### LTX Video 2
| | |
|---|---|
| **ID** | `ltx-video-2` |
| **Provider** | FAL |
| **API Key** | `FAL_KEY` |
| **Execution** | Async-poll |
| **Input** | Image (required), Prompt (Text, required) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Duration | enum | 6 | 6s, 8s, 10s |
| Resolution | enum | 1080p | 1080p, 1440p, 2160p |

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
| Model | enum | higgsfield-native | Higgsfield Native, Kling 2.6, Sora 2, Veo 3.1 |
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

### Lyria 3 (Music Generation)
| | |
|---|---|
| **ID** | `lyria-3` |
| **Provider** | Google |
| **API Key** | `GOOGLE_API_KEY` |
| **Execution** | Sync |
| **Input** | Prompt (Text), Images (Image, multiple, optional) |
| **Output** | Audio, Lyrics (Text) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | lyria-3-clip-preview | Lyria 3 Clip (30s), Lyria 3 Pro (full song) |
| Output Format | enum | mp3 | MP3, WAV (visible when model is Lyria 3 Pro) |

---

### Gemini TTS
| | |
|---|---|
| **ID** | `gemini-tts` |
| **Provider** | Google |
| **API Key** | `GOOGLE_API_KEY` |
| **Execution** | Sync |
| **Input** | Text (required) |
| **Output** | Audio |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gemini-2.5-flash-preview-tts | 2.5 Flash TTS, 2.5 Pro TTS |
| Voice | enum | Kore | Zephyr (Bright), Puck (Upbeat), Charon (Informative), Kore (Firm), Fenrir (Excitable), Leda (Youthful), Orus (Firm), Aoede (Breezy), Callirrhoe (Easy-going), Autonoe (Bright), Enceladus (Breathy), Iapetus (Clear), Umbriel (Easy-going), Algieba (Smooth), Despina (Smooth), Erinome (Clear), Algenib (Gravelly), Rasalgethi (Informative), Laomedeia (Upbeat), Achernar (Soft), Alnilam (Firm), Schedar (Even), Gacrux (Mature), Pulcherrima (Forward), Achird (Friendly), Zubenelgenubi (Casual), Vindemiatrix (Gentle), Sadachbia (Lively), Sadaltager (Knowledgeable), Sulafat (Warm) |

---

### Runway TTS
| | |
|---|---|
| **ID** | `runway-tts` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Text (required) |
| **Output** | Audio |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Voice | enum | Maya | Maya, Arjun, Serene, Bernard, Billy, Mark, Clint, Mabel, Chad, Leslie, Eleanor, Elias, Elliot, Brodie, Sandra, Kirk, Kylie, Lara, Lisa, Maggie, Jack, Katie, Noah, James, Rina, Ella, Frank, Rachel, Tom, Benjamin |

---

### Runway Speech-to-Speech
| | |
|---|---|
| **ID** | `runway-sts` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Audio (optional), Video (optional) |
| **Output** | Audio |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Voice | enum | Maya | Maya, Arjun, Serene, Bernard, Billy, Mark, Clint, Mabel, Chad, Leslie, Eleanor, Maggie, Jack, Noah, James, Ella, Frank, Rachel, Tom |
| Remove Background Noise | bool | false | — |

---

### Runway Voice Dubbing
| | |
|---|---|
| **ID** | `runway-dubbing` |
| **Provider** | Runway |
| **API Key** | `RUNWAY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Audio (required) |
| **Output** | Audio |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Target Language | enum | es | English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, Arabic, Russian, Hindi, Dutch, Turkish, Polish, Swedish, Filipino, Indonesian, Romanian, Ukrainian, Greek, Czech, Danish, Finnish, Bulgarian, Croatian, Slovak, Tamil |
| Disable Voice Cloning | bool | false | — |
| Drop Background Audio | bool | false | — |
| Number of Speakers | int (1-10) | auto-detect | — |

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
| Mesh Type | enum | standard | Standard, Low Poly |
| Remesh | bool | false | — |
| Topology | enum | triangle | Triangle, Quad |
| Polycount | int (100-300000) | 30000 | — |
| Symmetry | enum | auto | Off, Auto, On |
| PBR Materials | bool | false | — |
| Pose Mode | enum | (none) | None, A-Pose, T-Pose |

**Meshy Direct params** (when `MESHY_API_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| AI Model | enum | latest | Latest (Meshy 6), Meshy 6, Meshy 5 |
| Output Formats | string | glb | glb,fbx,obj,usdz |

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
| Polycount | int (100-300000) | 30000 | — |
| Symmetry | enum | auto | Off, Auto, On |
| Remesh | bool | false | — |
| Texture | bool | true | — |
| PBR Materials | bool | false | — |
| Pose Mode | enum | (none) | None, A-Pose, T-Pose |

**Meshy Direct params** (when `MESHY_API_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| AI Model | enum | latest | Latest (Meshy 6), Meshy 6, Meshy 5 |
| Mesh Type | enum | standard | Standard, Low Poly |
| Image Enhancement | bool | true | — |
| Remove Lighting | bool | true | — |
| Output Formats | string | glb | glb,fbx,obj,usdz |

**FAL params** (when only `FAL_KEY` set):

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Texture Prompt | string | — | Guide the texturing process |
| Safety Checker | bool | true | — |
| Seed | int | random | — |

---

### Meshy Multi-Image-to-3D
| | |
|---|---|
| **ID** | `meshy-multi-image-to-3d` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Images (1-4, Image, required, multiple) |
| **Output** | Mesh |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| AI Model | enum | latest | Latest (Meshy 6), Meshy 6, Meshy 5 |
| Remesh | bool | false | — |
| Topology | enum | triangle | Triangle, Quad |
| Polycount | int (100-300000) | 30000 | — |
| Symmetry | enum | auto | Off, Auto, On |
| Texture | bool | true | — |
| PBR Materials | bool | false | — |
| Pose Mode | enum | (none) | None, A-Pose, T-Pose |
| Image Enhancement | bool | true | — |
| Remove Lighting | bool | true | — |

---

### Meshy Retexture
| | |
|---|---|
| **ID** | `meshy-retexture` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Model URL (Text, required), Style Prompt (Text, optional) |
| **Output** | Mesh |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| AI Model | enum | latest | Latest (Meshy 6), Meshy 6, Meshy 5 |
| Keep Original UV | bool | true | — |
| PBR Materials | bool | false | — |
| Remove Lighting | bool | true | — |

---

### Meshy Auto-Rig
| | |
|---|---|
| **ID** | `meshy-rigging` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Model URL (Text, required) |
| **Output** | Rigged Mesh (Mesh), Rig Task ID (Text) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Height (meters) | float (0.1-5.0) | 1.7 | — |

---

### Meshy Animate
| | |
|---|---|
| **ID** | `meshy-animate` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Rig Task ID (Text, required) |
| **Output** | Animated Mesh (Mesh) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Animation | enum | 92 | Idle, Walking, Running, Jumping, Dancing, Waving, Sitting, Clapping, Punching, Kicking, Sword Swing |
| Output FPS | enum | default (30) | Default (30), 24 fps, 25 fps, 30 fps, 60 fps |

---

### Meshy Remesh
| | |
|---|---|
| **ID** | `meshy-remesh` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Model URL (Text, required) |
| **Output** | Mesh |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Topology | enum | triangle | Triangle, Quad |
| Polycount | int (100-300000) | 30000 | — |
| Output Formats | string | glb | glb,fbx,obj,usdz,blend,stl |
| Resize Height (m) | float (0-100) | 0 | 0 = no resize |
| Convert Format Only | bool | false | — |

---

### Meshy 3D Print
| | |
|---|---|
| **ID** | `meshy-3d-print` |
| **Provider** | Meshy |
| **API Key** | `MESHY_API_KEY` |
| **Execution** | Async-poll |
| **Input** | Task ID (Text, required) |
| **Output** | Print File (Mesh) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Max Colors | int (1-16) | 4 | — |
| Color Depth | int (3-6) | 4 | — |

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
| **Input** | Front Image (required), Back Image (optional), Left Image (optional), Right Image (optional) |
| **Output** | Mesh |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Quality | enum | Normal | Normal, Low Poly, Geometry Only |
| Face Count | int (40000-1500000) | 500000 | — |
| PBR Materials | bool | false | — |
| Polygon Type | enum | triangle | Triangle, Quadrilateral |

---

## Transform

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

### Frame Extractor
| | |
|---|---|
| **ID** | `frame-extractor` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Video (required) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Mode | enum | first_frame | First Frame, Last Frame, Middle Frame, At Timestamp |
| Timestamp (s) | float (0+) | 0 | — |

---

### SVG Rasterize
| | |
|---|---|
| **ID** | `svg-rasterize` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | SVG (required) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Width | int (64-4096) | 1024 | — |
| Height | int (64-4096) | 1024 | — |
| Background | enum | transparent | Transparent, White |

---

## Utility Nodes

### Text Input
| | |
|---|---|
| **ID** | `text-input` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | — |
| **Output** | Text |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Text | textarea | — | — |

---

### Image Input
| | |
|---|---|
| **ID** | `image-input` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | — (file upload / canvas drop) |
| **Output** | Image |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| File | file | — | — |

---

### Video Input
| | |
|---|---|
| **ID** | `video-input` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | — (file upload) |
| **Output** | Video |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| File | file | — | — |

---

### Audio Input
| | |
|---|---|
| **ID** | `audio-input` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | — (file upload) |
| **Output** | Audio |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| File | file | — | — |

---

### Preview
| | |
|---|---|
| **ID** | `preview` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Input (Any) |
| **Output** | — |

No parameters.

---

### Combine Text
| | |
|---|---|
| **ID** | `combine-text` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Text 1 (required), Text 2 (optional), Text 3 (optional) |
| **Output** | Text |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Separator | string | `\n` | — |
| Template | textarea | — | Optional: use `{text1}`, `{text2}`, `{text3}` placeholders |

---

### Router
| | |
|---|---|
| **ID** | `router` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Input (Any) |
| **Output** | Out 1 (Any), Out 2 (Any), Out 3 (Any) |

No parameters.

---

### Reroute
| | |
|---|---|
| **ID** | `reroute` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Input (Any) |
| **Output** | Output (Any) |

No parameters.

---

### Sticky Note
| | |
|---|---|
| **ID** | `sticky-note` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | — |
| **Output** | — |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Note | textarea | — | — |
| Color | enum | yellow | Yellow, Blue, Green, Pink, Grey |

---

### Gemini Embeddings
| | |
|---|---|
| **ID** | `gemini-embeddings` |
| **Provider** | Google |
| **API Key** | `GOOGLE_API_KEY` |
| **Execution** | Sync |
| **Input** | Text (required) |
| **Output** | Embedding (Text/JSON), Dimensions (Text) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Model | enum | gemini-embedding-001 | Embedding 001 (text), Embedding 2 (multimodal) |
| Task Type | enum | SEMANTIC_SIMILARITY | Semantic Similarity, Retrieval Query, Retrieval Document, Classification, Clustering, Code Retrieval, Question Answering, Fact Verification |
| Dimensions | enum | 768 | 768, 1536, 3072 |

---

### Array Builder
| | |
|---|---|
| **ID** | `array-builder` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Item 1 (Any, required), Item 2-8 (Any, optional) |
| **Output** | Array |

No parameters.

---

### Array Selector
| | |
|---|---|
| **ID** | `array-selector` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Array (required) |
| **Output** | Item (Any) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Mode | enum | first | First, Last, Random, By Index |
| Index | int (0+) | 0 | — |

---

### Image Compare
| | |
|---|---|
| **ID** | `image-compare` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Image A (required), Image B (required) |
| **Output** | — |

No parameters.

---

### Image Iterator
| | |
|---|---|
| **ID** | `iterator-image` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Images (Array, required) |
| **Output** | Image (emits per item) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Batch Size Cap | int (1-25) | 10 | — |

---

### Text Iterator
| | |
|---|---|
| **ID** | `iterator-text` |
| **Provider** | Local |
| **API Key** | — |
| **Execution** | Sync |
| **Input** | Texts (Array, required) |
| **Output** | Text (emits per item) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Batch Size Cap | int (1-25) | 10 | — |

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
| **Output** | Image, Video, Audio, Mesh (all available -- handler auto-detects output type) |

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| Endpoint | string | fal-ai/flux-pro/v1.1-ultra | Any FAL endpoint ID |

---

## API Key Summary

| Key | Provider | Used By |
|-----|----------|---------|
| `OPENAI_API_KEY` | [OpenAI](https://platform.openai.com/api-keys) | GPT Image 1, GPT Image 1 Edit, DALL-E 3, GPT-4o Chat |
| `ANTHROPIC_API_KEY` | [Anthropic](https://console.anthropic.com/settings/keys) | Claude |
| `GOOGLE_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) | Gemini, Imagen 4, Nano Banana, Veo 3.1, Lyria 3, Gemini TTS, Gemini Embeddings |
| `OPENROUTER_API_KEY` | [OpenRouter](https://openrouter.ai/keys) | OpenRouter (1000+ models) |
| `REPLICATE_API_TOKEN` | [Replicate](https://replicate.com/account/api-tokens) | Replicate |
| `FAL_KEY` | [fal.ai](https://fal.ai/dashboard/keys) | FLUX, Kling, Sora 2, Wan, Luma, LTX, PixVerse, Seedance, Moonvalley, Recraft, Remove Background, Hunyuan3D, FAL Universal, fallbacks |
| `MESHY_API_KEY` | [Meshy](https://app.meshy.ai/settings/api) | Meshy Text/Image/Multi-Image-to-3D, Retexture, Auto-Rig, Animate, Remesh, 3D Print, Text/Image-to-Image |
| `BFL_API_KEY` | [Black Forest Labs](https://api.bfl.ml/auth/profile) | FLUX 1.1 Ultra (direct) |
| `RUNWAY_API_KEY` | [Runway](https://app.runwayml.com/settings/api-keys) | Runway Video, Aleph, Image, Act-Two, TTS, Speech-to-Speech, Voice Dubbing |
| `ELEVENLABS_API_KEY` | [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) | ElevenLabs TTS |
| `MINIMAX_API_KEY` | [MiniMax](https://www.minimaxi.com/platform) | MiniMax T2V, I2V, S2V |
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
- **`sharedParams`** -- always shown regardless of route
- **`directParams`** -- shown when `directKeyName` API key is configured
- **`falParams`** -- shown when only `FAL_KEY` is available

The Inspector auto-detects which route is active based on the settings cache. Handlers similarly check for the direct key first and fall back to FAL.

**Current dual-param nodes:** FLUX 1.1 Ultra, Veo 3.1, Meshy 6 Text-to-3D, Meshy 6 Image-to-3D

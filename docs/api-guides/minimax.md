# MiniMax (Hailuo) in Nebula Nodes

> MiniMax (Hailuo) lets a Nebula user turn a text prompt — or a still image, or a person's face — into a short, physically convincing AI video clip right on the canvas.

## What you can make

**Video** (this is everything Nebula currently wires up)
- **Text-to-video** — describe a scene in words and get a 6s or 10s clip at 768P or 1080P, powered by Hailuo 2.3 or Hailuo 02.
- **Image-to-video** — hand it a starting frame (a photo or an image from an upstream node) plus a prompt, and it animates from that first frame.
- **Subject-reference video** — give it a photo of a person's face and a prompt; the clip keeps that character's likeness consistent (model `S2V-01`).
- Camera direction works inside the prompt itself — phrases like `[pan]`, `[zoom]`, `[static]` steer the shot.

**Not yet in Nebula** (the MiniMax API offers these, but no Nebula node calls them — see the coverage table): text-to-speech and voice cloning, music generation, image generation, the chat/LLM models, first-and-last-frame video, and the templated "video agent." See *API coverage* below if you want the full picture.

## Nodes available in Nebula (3)

All three are **video-gen** nodes, all share one backend handler, and all hit the same endpoint (`POST /v1/video_generation`) — Nebula picks the mode based on which input you connect.

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| **MiniMax T2V** | `minimax-t2v` | video-gen | `Prompt` (Text, required) | `model` (Hailuo 2.3 / Hailuo 02), `duration` (6 / 10s), `resolution` (768P / 1080P) | Generating a clip purely from a written description. |
| **MiniMax I2V** | `minimax-i2v` | video-gen | `First Frame` (Image, required), `Prompt` (Text, required) | `model` (Hailuo 2.3 / Hailuo 02), `duration` (6 / 10s), `resolution` (768P / 1080P) | Animating a still image, using it as the opening frame. |
| **MiniMax S2V** | `minimax-s2v` | video-gen | `Character Image` (Image, required), `Prompt` (Text, required) | `model` (`S2V-01` only) — no duration/resolution controls | Keeping one person's face consistent across a generated clip. |

Notes grounded in the registry:
- Each node outputs a single **`Video`** port you can wire downstream (e.g. into a preview or an upscaler).
- `duration` defaults to **6s** and `resolution` defaults to **768P**. The 10s option is only valid at 768P; 1080P is 6s only.
- **S2V deliberately has no duration/resolution params** — the MiniMax S2V API doesn't accept them, and the node's character image only supports a human face (`type: character`).

## How to use it in Nebula

**Where the nodes live.** Open the node palette/library and look under the **video-gen** category. Drag **MiniMax T2V**, **MiniMax I2V**, or **MiniMax S2V** onto the canvas. Each one is recognizable by its single blue **Video** output.

**API-key setup (one time).**
1. Get a key from your MiniMax dashboard (the Global host is `api.minimax.io`; Nebula's handler talks to the `api.minimaxi.com` host — see Sources).
2. Add it to your `.env` at the repo root:
   ```
   MINIMAX_API_KEY=your_key_here
   ```
3. Restart the backend so it picks up the key. The node reads `MINIMAX_API_KEY` — without it, the node errors with "MINIMAX_API_KEY is required."

**Heads-up on timing.** Video generation is asynchronous: Nebula submits the job, then polls roughly every 5 seconds (up to ~25 minutes) and shows a progress bar on the node while MiniMax renders. A clip is normal to take a couple of minutes.

**Example recipes (real node IDs):**

1. **Quick text-to-video.** Drop a **Text** node → type "a red crab scuttling across wet sand at sunset, `[pan]` right" → wire it into the `Prompt` port of **`minimax-t2v`** → set `duration` 6, `resolution` 1080P → run. Out comes a 6-second 1080P clip.

2. **Animate a generated still (image → video).** Use any image node (e.g. a `gpt-image-2` or `gemini` image generator) → wire its image output into the `First Frame` port of **`minimax-i2v`** → add a **Text** node into `Prompt` describing the motion ("camera slowly pushes in, leaves rustle") → keep Hailuo 2.3 → run. The clip starts exactly from your still.

3. **Consistent character clip (subject reference).** Feed a portrait photo into the `Character Image` port of **`minimax-s2v`** → wire a **Text** node into `Prompt` ("she turns to camera and smiles") → run. `S2V-01` keeps the face consistent across the shot. (No duration/resolution to set — those are fixed for S2V.)

## API coverage — what Nebula uses vs. what MiniMax (Hailuo) offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text-to-video (`/v1/video_generation`, T2V) | Yes | **full** | `minimax-t2v`. Hailuo 2.3 / Hailuo 02 exposed. |
| Image-to-video (first frame) | Yes | **full** | `minimax-i2v`. |
| Subject-reference video (`S2V-01`) | Yes | **full** | `minimax-s2v`, character/face only. |
| First-and-last-frame video (`last_frame_image`) | Yes | **none** | API supports a start+end frame mode; no Nebula node exposes `last_frame_image`. |
| `Hailuo-2.3-Fast` model | Yes | **none** | Faster video model in the API; not in the node's model enum. |
| `prompt_optimizer` toggle | Yes | **none** | API auto-optimizes prompts; not surfaced as a node param. |
| Director/legacy video models (`T2V-01-Director`, `I2V-01-Director`, `I2V-01-live`) | Yes | **none** | Not in the Nebula model enums. |
| Video Generation Agent (`/v1/.../video-agent`, templates) | Yes | **none** | Templated action clips (Diving, Climbing, etc.) — no node. |
| Text-to-speech, sync (`/v1/t2a_v2`, speech-2.x / 02 / 01 HD & Turbo) | Yes | **none** | Entire audio modality is unused in Nebula. |
| Text-to-speech, async / long-text (`t2a_async`) | Yes | **none** | No node. |
| Voice cloning (upload clone audio + clone) | Yes | **none** | No node. |
| Voice design (generate a voice from a prompt) | Yes | **none** | No node. |
| Music generation (`/v1/music_generation`, music-2.6 / music-1.5) | Yes | **none** | Prompt+lyrics → music; no node. |
| Image generation (`/v1/image_generation`, `image-01`) | Yes | **none** | Text-to-image; no MiniMax image node in Nebula. |
| Chat / LLM text models (MiniMax M-series, OpenAI/Anthropic-compatible) | Yes | **none** | No text node uses MiniMax. |
| File management (upload/list/retrieve/delete) | Yes | **partial** | Handler only calls `/v1/files/retrieve/{id}` to fetch the finished video; upload/list/delete unused. |

**Coverage: ~12% of the MiniMax (Hailuo) API surface is exposed in Nebula.** (Of roughly ten capability families — text/LLM, video, video-agent, sync-TTS, async-TTS, voice-cloning, voice-design, image, music, file-management — Nebula meaningfully uses only video generation, and even there it skips first-last-frame, the fast model, the video agent, and `prompt_optimizer`.)

**Notable unused capabilities:** the entire **audio stack** (TTS in 40+ languages, voice cloning, voice design), **music generation**, **image generation** (`image-01`), the **chat/LLM M-series models**, the **first-and-last-frame** video mode, the **`Hailuo-2.3-Fast`** model, and the **templated Video Agent**.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/minimax/SKILL.md` (new 2026-06-04). It covers all **3** MiniMax (Hailuo) video nodes, giving an agent the node IDs and mode-selecting ports, param value sets and constraints, the async lifecycle, in-prompt camera syntax, and the video-only scope boundary.

What it covers:
- **The three node IDs and their ports** — `minimax-t2v` (`prompt`→`video`), `minimax-i2v` (`first_frame_image` + `prompt`→`video`), `minimax-s2v` (`subject_reference` + `prompt`→`video`) — and the rule that the *connected input* selects the mode (so an agent doesn't expect, e.g., a duration param to work on S2V).
- **Param value sets and constraints** — model enums (Hailuo 2.3 / Hailuo 02; S2V-01 only), `duration` ∈ {6, 10}, `resolution` ∈ {768P, 1080P}, and the 10s-only-at-768P / 1080P-only-at-6s constraint.
- **The async lifecycle** — these are long-running poll nodes (minutes); submit → poll → download.
- **In-prompt camera syntax** (`[pan]`, `[zoom]`, `[static]`) as a steering lever.
- **Scope boundary** — MiniMax-in-Nebula is **video only**; the API's TTS, music, and image generation are not wired as nodes, so an agent shouldn't hallucinate one.

## Sources

- MiniMax API Overview (full category/endpoint list): https://platform.minimax.io/docs/api-reference/api-overview
- Video Generation guide (modes, models, endpoints): https://platform.minimax.io/docs/guides/video-generation
- Image Generation (text-to-image, `image-01`, `/v1/image_generation`): https://platform.minimax.io/docs/api-reference/image-generation-t2i
- Official MiniMax MCP server README (TTS, voice clone/design, image, video, music tools + Global vs. CN hosts): https://github.com/MiniMax-AI/MiniMax-MCP
- Official MiniMax CLI README (text/image/video/speech/music, dual-region hosts): https://github.com/MiniMax-AI/cli
- Platform document portal (redirect target of `minimax.io/platform/document`): https://platform.minimax.io/document

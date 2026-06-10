---
name: minimax
description: MiniMax (Hailuo) video generation in Nebula — text-to-video, image-to-video (first frame), and subject-reference (face-consistent) video via Hailuo 2.3 / Hailuo 2.3 Fast / Hailuo 02 / S2V-01 on the async /v1/video_generation endpoint. VIDEO ONLY in Nebula (the API also offers TTS, voice clone, music, and image gen, but no Nebula node wires those). Activate when the user configures any minimax-t2v, minimax-i2v, or minimax-s2v node, or asks about MiniMax / Hailuo in Nebula. Sourced from the official MiniMax platform docs (platform.minimax.io) and the Nebula audit guide docs/api-guides/minimax.md, cross-checked against backend/handlers/minimax.py and node_definitions.json on 2026-06-04 (model enums updated 2026-06-10).
---

# MiniMax (Hailuo) Skill

## When to use

- User configures any `minimax-*` node (`minimax-t2v`, `minimax-i2v`, `minimax-s2v`)
- User wants a short AI video clip from a text prompt, a starting still image, or a reference face
- User asks about MiniMax / Hailuo models (Hailuo 2.3, Hailuo 2.3 Fast, Hailuo 02, S2V-01), durations, resolutions, or in-prompt camera moves
- User asks why MiniMax TTS / music / image generation isn't available as a node (see Capability boundaries)

## Universal rules (all MiniMax nodes)

1. **Auth + env var.** Header `Authorization: Bearer <MINIMAX_API_KEY>` plus `Content-Type: application/json`. The backend reads `MINIMAX_API_KEY` from `.env` at the repo root. Missing key → the node errors with `MINIMAX_API_KEY is required`. Restart the backend after adding the key.
2. **Base URL.** `https://api.minimaxi.com` (the handler's `MINIMAX_API_BASE`). All three nodes POST to `https://api.minimaxi.com/v1/video_generation`. Note: the MiniMax *dashboard / docs* Global host is `api.minimax.io`, but Nebula's handler talks to the `api.minimaxi.com` host — do not "correct" it.
3. **Execution pattern: async-poll (3 steps).** All three nodes are `executionPattern: "async-poll"`:
   - **Submit** `POST /v1/video_generation` → returns `task_id`. Accepts HTTP `200/201/202`; anything else raises `MiniMax submit failed`.
   - **Poll** `GET /v1/query/video_generation?task_id=<id>` every **5 s**, up to **300 polls (~25 min)**. Poll must return HTTP `200`. The JSON `status` field drives the loop.
   - **Retrieve + download** on success: `GET /v1/files/retrieve/{file_id}` → `file.download_url`, then the video is saved locally and exposed on the `video` output port.
4. **Status / error codes.** Poll `status` values: `Queueing` / `Processing` → keep polling; `Success` → fetch `file_id` then retrieve; `Fail` → raises `MiniMax task failed: <message>`. No `file_id` on Success, or no `download_url` on retrieve, also raises. After 300 polls without Success → `MiniMax task timed out`.
5. **Input-URI rules (image ports).** `first_frame_image` (I2V) and `subject_reference` (S2V) accept an `http(s)://` URL, a `data:` URI, or a **local file path** — the handler's `_resolve_image_url` passes URLs/data-URIs through and converts local paths to a data URI via `image_to_data_uri`. A local path that doesn't exist raises `Image file not found`. Use JPG/PNG/WebP. The S2V image must contain a **human face** (it's sent as `subject_reference: [{"type": "character", ...}]`).
6. **Key gotchas.**
   - **The connected input selects the mode, not a dropdown.** The handler checks inputs in priority order: `subject_reference` present → **S2V**; else `first_frame_image` present → **I2V**; else → **T2V**. So if you wire a Character Image, duration/resolution are ignored (S2V doesn't send them).
   - **`prompt` is always required.** Empty prompt on any node raises `Prompt input is required` — including I2V and S2V, where the image alone is not enough.
   - **Duration/resolution constraints.** `duration` defaults to `6`, `resolution` to `768P`. The 10 s option is valid **only at 768P**; **1080P is 6 s only**. Don't pair `duration: 10` with `resolution: 1080P`.
   - **Long-running.** A clip normally takes a couple of minutes. Treat these nodes as slow poll nodes — wait on the progress bar, never assume instant output.

## Pick the right node

All three are `video-gen` nodes, share `backend/handlers/minimax.py`, and hit the same endpoint. Mode is chosen by the connected input.

| Node (display name) | Node ID | Endpoint / model | Required inputs | Key params |
|---|---|---|---|---|
| **MiniMax T2V** | `minimax-t2v` | `POST /v1/video_generation` · Hailuo 2.3 / 2.3 Fast / 02 | `prompt` (Text) | `model`, `duration` {6,10}, `resolution` {768P,1080P} |
| **MiniMax I2V** | `minimax-i2v` | `POST /v1/video_generation` · Hailuo 2.3 / 2.3 Fast / 02 | `first_frame_image` (Image) + `prompt` (Text) | `model`, `duration` {6,10}, `resolution` {768P,1080P} |
| **MiniMax S2V** | `minimax-s2v` | `POST /v1/video_generation` · `S2V-01` only | `subject_reference` (Image, human face) + `prompt` (Text) | `model` (`S2V-01` only) — **no duration/resolution** |

## Param reference

### `minimax-t2v` (MiniMax T2V)
- **Inputs:** `prompt` (Text, required).
- **Output:** `video` (Video).
- **Params:**
  - `model` — enum, default `MiniMax-Hailuo-2.3`. Options: `MiniMax-Hailuo-2.3` (label "Hailuo 2.3"), `MiniMax-Hailuo-2.3-Fast` (label "Hailuo 2.3 Fast", added 2026-06-10), `MiniMax-Hailuo-02` (label "Hailuo 02 (legacy)").
  - `duration` — enum (number), default `6`. Options: `6`, `10`. **10 only valid at 768P.**
  - `resolution` — enum, default `768P`. Options: `768P`, `1080P`. **1080P only valid at duration 6.**

### `minimax-i2v` (MiniMax I2V)
- **Inputs:** `first_frame_image` (Image, required — the opening frame), `prompt` (Text, required — describes the motion).
- **Output:** `video` (Video).
- **Params:** same as T2V — `model` (default `MiniMax-Hailuo-2.3`; `MiniMax-Hailuo-2.3` / `MiniMax-Hailuo-2.3-Fast` / `MiniMax-Hailuo-02`), `duration` (default `6`; {6,10}), `resolution` (default `768P`; {768P,1080P}). Body sends `first_frame_image` as the resolved image string.

### `minimax-s2v` (MiniMax S2V)
- **Inputs:** `subject_reference` (Image, required — a human face; display label "Character Image"), `prompt` (Text, required).
- **Output:** `video` (Video).
- **Params:**
  - `model` — enum, default `S2V-01`, **only option `S2V-01`**.
  - **No `duration` or `resolution`** — the S2V API doesn't accept them, so the node deliberately omits them. The image is sent as `subject_reference: [{"type": "character", "image": [<url>]}]`.

### In-prompt camera movement (all three nodes)
Camera direction lives **inside the prompt text**, not as a param. Use bracketed cues: `[pan]`, `[zoom]`, `[static]` (also `[tilt]`, `[push in]`, `[pull out]`, `[truck]` styles). Example prompt: `a red crab scuttling across wet sand at sunset, [pan] right`. There is no separate camera param on any node.

## Recipes

1. **Quick text-to-video (1080P).** `Text` node ("a red crab scuttling across wet sand at sunset, `[pan]` right") → wire into the `prompt` port of **`minimax-t2v`** → set `duration: 6`, `resolution: 1080P` (1080P is 6 s only) → run. Out: a 6 s 1080P clip on the `video` output.

2. **Animate a generated still (image → video).** Any image node (e.g. `gpt-image-2` or `gemini` image gen) → wire its image output into the `first_frame_image` port of **`minimax-i2v`** → add a `Text` node into `prompt` describing the motion ("camera slowly pushes in, leaves rustle, `[zoom]`") → keep `model: MiniMax-Hailuo-2.3` → run. The clip starts exactly from your still.

3. **Consistent-character clip (subject reference).** Feed a portrait photo (URL, data URI, or local path) into the `subject_reference` port of **`minimax-s2v`** → wire a `Text` node into `prompt` ("she turns to camera and smiles, `[static]`") → run. `S2V-01` keeps the face consistent. No duration/resolution to set — those are fixed for S2V.

## In the nebula_nodes context

- **Node IDs:** `minimax-t2v`, `minimax-i2v`, `minimax-s2v` (all `category: video-gen`, `apiProvider: minimax`).
- **Handler:** `backend/handlers/minimax.py` → single function `handle_minimax_video`. One handler serves all three nodes; it branches on the connected input port to build the right request body.
- **Input ports:** T2V = `prompt`; I2V = `first_frame_image` + `prompt`; S2V = `subject_reference` (labelled "Character Image") + `prompt`. **The connected image port selects the mode** — wiring a Character Image makes it S2V regardless of any duration/resolution you set (those get dropped).
- **Output ports:** each node has one `video` port (dataType `Video`). The finished MP4 is downloaded locally via `save_video_from_url` into the run dir.
- **Chaining rules:** the `video` output can feed any downstream node that accepts a Video input (e.g. a preview node or a video upscaler). Image inputs to I2V/S2V can come from upstream image-gen nodes (their image output port → the `first_frame_image` / `subject_reference` port) or from a literal URL/path.
- **How outputs render:** the downloaded video is served from the run dir and plays in Nebula's video preview on the canvas. Progress is reported via `ProgressEvent` during polling (a progress bar climbs to ~99% until Success).

### Capability boundaries (what the MiniMax API does but Nebula does NOT expose)
MiniMax-in-Nebula is **video only**. Do not promise or invent nodes for the following — the API supports them, but no Nebula node wires them (per the audit gap table, only ~12% of the MiniMax surface is exposed):

- **First-and-last-frame video** (`last_frame_image` start+end mode) — no node exposes it. Only `first_frame_image` (I2V) is wired.
- **`prompt_optimizer` toggle** — API can auto-optimize prompts; not surfaced as a node param.
- **Director / legacy video models** (`T2V-01-Director`, `I2V-01-Director`, `I2V-01-live`) — not in the Nebula model enums.
- **Video Generation Agent** (`/v1/.../video-agent`, templated action clips like Diving/Climbing) — no node.
- **Text-to-speech** (sync `/v1/t2a_v2` and async `t2a_async`, speech-2.x / 02 / 01 HD & Turbo, 40+ languages) — entire audio modality unused.
- **Voice cloning** and **voice design** — no node.
- **Music generation** (`/v1/music_generation`, music-2.6 / music-1.5, prompt+lyrics → music) — no node.
- **Image generation** (`/v1/image_generation`, `image-01`) — no MiniMax image node in Nebula (use a `gpt-image-2` or `gemini` node instead).
- **Chat / LLM M-series text models** — no text node uses MiniMax.
- **File management** — only `/v1/files/retrieve/{id}` is used (to fetch the finished video); upload/list/delete are not wired.

If a user asks for any of the above, say the API supports it but Nebula has no node for it yet — don't hallucinate a `minimax-tts` / `minimax-music` / `minimax-image` node.

## Sources

- MiniMax API Overview (full category/endpoint list): https://platform.minimax.io/docs/api-reference/api-overview
- Video Generation guide (modes, models, endpoints): https://platform.minimax.io/docs/guides/video-generation
- Image Generation (text-to-image, `image-01`): https://platform.minimax.io/docs/api-reference/image-generation-t2i
- Official MiniMax MCP server README (TTS, voice clone/design, image, video, music + Global vs CN hosts): https://github.com/MiniMax-AI/MiniMax-MCP
- Official MiniMax CLI README (dual-region hosts): https://github.com/MiniMax-AI/cli
- **Nebula audit guide:** `docs/api-guides/minimax.md` (node table, params, gap table, coverage analysis — the primary grounded source for this skill)
- **Ground truth in-repo:** `backend/handlers/minimax.py`, `backend/data/node_definitions.json`

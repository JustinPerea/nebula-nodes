---
name: elevenlabs
description: ElevenLabs audio API in Nebula — text-to-speech, sound-effects-from-text, speech-to-speech voice changing, audio isolation (denoise), translated dubbing, and speech-to-text transcription, all as audio-gen nodes. Activate when the user configures any elevenlabs-tts, elevenlabs-sfx, elevenlabs-sts, elevenlabs-isolation, elevenlabs-dubbing, or elevenlabs-stt node, or asks about ElevenLabs in Nebula. Sourced from the official ElevenLabs API reference (elevenlabs.io/docs/api-reference) cross-checked against backend/handlers/elevenlabs.py + backend/data/node_definitions.json, and the Nebula audit guide docs/api-guides/elevenlabs.md, on 2026-06-05.
---

# ElevenLabs Skill

ElevenLabs is the audio studio inside Nebula: turn text into lifelike speech, generate sound effects from a description, swap one voice for another, strip background noise out of a recording, dub a clip into another language, and transcribe speech to text — six drag-and-drop nodes, all in the **audio-gen** category.

## When to use

- User configures an `elevenlabs-tts`, `elevenlabs-sfx`, `elevenlabs-sts`, `elevenlabs-isolation`, `elevenlabs-dubbing`, or `elevenlabs-stt` node
- User wants text-to-speech / narration / voiceover, sound effects from a prompt, re-voicing a recording, denoising/isolating speech, translated dubbing, or transcription (speech → text or subtitles)
- User asks which ElevenLabs node to use, what params are valid, how to set a voice, or how to chain audio nodes
- User asks for music, multi-speaker dialogue, voice design, or voice cloning — so you can tell them those are **not** Nebula nodes (see Capability boundaries)

## Universal rules

1. **Auth header + env var.** Every node authenticates with the `xi-api-key: <key>` HTTP header (note: `xi-api-key`, *not* `Authorization: Bearer`). The backend reads the key from the **`ELEVENLABS_API_KEY`** environment variable. If it is missing, the node fails with `ELEVENLABS_API_KEY is required`. Get the key from the ElevenLabs dashboard (Profile → API Keys).
2. **Base URL:** `https://api.elevenlabs.io/v1`. Per-node endpoints: TTS `/text-to-speech/{voice_id}`, SFX `/sound-generation`, STS `/speech-to-speech/{voice_id}`, isolation `/audio-isolation`, dubbing `/dubbing` (+ poll + download), STT `/speech-to-text`.
3. **Execution pattern = sync (request/response) for all six nodes.** From the graph's perspective every node is `executionPattern: "sync"` — you wire it, run it, and it returns one output (an audio file, or text for STT). There is **no** streaming or WebSocket node. Caveat: `elevenlabs-dubbing` is sync *to the graph* but the handler internally does submit → poll the job every 5s (up to ~10 min) → download the result, so a dubbing node can legitimately take minutes before its `audio` output appears. The other five return in seconds.
4. **Request encoding differs by node.** TTS and SFX send a JSON body (`Content-Type: application/json`). STS, isolation, dubbing, and STT send **`multipart/form-data`** with the source audio file attached (STS/isolation under form field `audio`; dubbing and STT under form field `file`). You don't set this in Nebula — the handler picks the right encoding — but it explains why audio-input nodes need a real file on disk, not a URL string.
5. **Status / error codes.** A non-200 from ElevenLabs surfaces as `ElevenLabs API error <status>: <body>` (or the per-node variant, e.g. `ElevenLabs SFX error …`, `ElevenLabs Dubbing submit error …`). Common cases: `401` bad/missing key, `422` invalid params (bad `voice_id`, out-of-range value, unsupported `output_format`), `429` rate limit / quota, `400` malformed request. Dubbing-specific terminal states: the job can return `status: "failed"` (→ `ElevenLabs Dubbing failed: <error>`) or never finish (→ `ElevenLabs Dubbing timed out` after the poll cap).
6. **Input-URI / input-file rules.** TTS and SFX take **Text** input (a string — wire a Text node or any Text output into the `text` port). STS, isolation, dubbing, and STT take **Audio** input: the upstream `audio` value must be a **local file path that exists on disk** (the handler does `Path(value).read_bytes()` and raises `Audio file not found: <path>` otherwise). Feed them the `audio` output of another audio node (TTS, SFX, isolation) or an audio upload node — not a bare remote URL. STT is the one node that goes the other way: Audio **in** → **Text out** (its `text` output is a string you can wire into text-driven nodes), whereas the rest output Audio.
7. **Key gotchas.**
   - **PCM is saved as `.pcm`.** When you pick a `pcm_*` `output_format` (TTS/SFX/STS), ElevenLabs returns raw PCM samples with **no WAV header**, and the handler saves them with a `.pcm` extension to keep the extension honest. Many players/preview surfaces can't open a headerless `.pcm`. **Prefer an `mp3_*` format** unless the user specifically needs raw PCM for their own pipeline.
   - **Isolation and dubbing always output MP3**, regardless of any format setting — isolation has no params at all, and dubbing's download is hard-coded to MP3.
   - **`voice_id` is free text, not a dropdown.** Nebula cannot list or search voices. Default is Rachel (`21m00Tcm4TlvDq8ikWAM`). To use another voice, paste its ElevenLabs voice ID (from the Voice Library / your Voices page) into the field. An invalid ID fails at request time with a `422`/`404`.
   - **`style` is only sent when > 0** (TTS and STS). Leaving it at the default `0` omits it from `voice_settings`.
   - **`seed` is only sent when set** (TTS and STS). Blank = random each run; set an integer for reproducibility.
   - **SFX `model_id` is fixed.** The node exposes no model selector; the handler hard-codes the sound-effects model (`eleven_text_to_sound_v2`). Don't tell the user they can choose an SFX model.

## Pick the right node

One row per real Nebula node. IDs, ports, endpoints, and params all match `node_definitions.json` + `backend/handlers/elevenlabs.py`.

| Nebula node (display name) | Node ID | Endpoint / model | In → Out ports | Key params |
|---|---|---|---|---|
| ElevenLabs TTS | `elevenlabs-tts` | `POST /v1/text-to-speech/{voice_id}` · model from `model_id` enum | `text` (Text) → `audio` (Audio) | `voice_id`, `model_id`, `stability`, `similarity_boost`, `style`, `use_speaker_boost`, `speed`, `output_format`, `seed` |
| ElevenLabs Sound Effects | `elevenlabs-sfx` | `POST /v1/sound-generation` · model fixed (`eleven_text_to_sound_v2`) | `text` (Text) → `audio` (Audio) | `duration_seconds`, `prompt_influence`, `loop`, `output_format` |
| ElevenLabs Speech-to-Speech | `elevenlabs-sts` | `POST /v1/speech-to-speech/{voice_id}` · model from `model_id` enum | `audio` (Audio) → `audio` (Audio) | `voice_id`, `model_id`, `stability`, `similarity_boost`, `remove_background_noise`, `seed`, `output_format` |
| ElevenLabs Audio Isolation | `elevenlabs-isolation` | `POST /v1/audio-isolation` · denoise, MP3 out | `audio` (Audio) → `audio` (Isolated Audio) | *(none — no params; output always MP3)* |
| ElevenLabs Dubbing | `elevenlabs-dubbing` | `POST /v1/dubbing` (+ poll `GET /v1/dubbing/{id}` + download `…/audio/{target_lang}`) · MP3 out | `audio` (Audio) → `audio` (Dubbed Audio) | `target_lang` (required), `source_lang`, `num_speakers`, `drop_background_audio`, `disable_voice_cloning` |
| ElevenLabs STT | `elevenlabs-stt` | `POST /v1/speech-to-text` · model from `model_id` (scribe_v1/v2) | `audio` (Audio) → `text` (Text) | `model_id`, `language_code`, `diarize`, `num_speakers`, `tag_audio_events`, `transcript_format` |

## Param reference

Types, ranges, enums, and defaults below are exactly what the node exposes. "(handler)" notes describe behavior in `backend/handlers/elevenlabs.py` the user can't see in the panel.

### `elevenlabs-tts` (Text → Audio)
- **`voice_id`** — string. Default `21m00Tcm4TlvDq8ikWAM` (Rachel). Free-text ElevenLabs voice ID. Goes into the URL path.
- **`model_id`** — enum. Default `eleven_multilingual_v2`. Options: `eleven_v3` (v3, Highest Quality) · `eleven_multilingual_v2` (Multilingual v2) · `eleven_turbo_v2_5` (Turbo v2.5, Low Latency) · `eleven_flash_v2_5` (Flash v2.5, Fastest) · `eleven_turbo_v2` (Turbo v2) · `eleven_flash_v2` (Flash v2).
- **`stability`** — float 0–1, step 0.05, default 0.5. Higher = steadier, less expressive.
- **`similarity_boost`** — float 0–1, step 0.05, default 0.75. Adherence to the reference voice timbre.
- **`style`** — float 0–1, step 0.05, default 0. (handler) only added to `voice_settings` when > 0.
- **`use_speaker_boost`** — boolean, default true.
- **`speed`** — float 0.7–1.2, step 0.05, default 1.0. Speaking rate.
- **`output_format`** — enum. Default `mp3_44100_128`. Options: `mp3_44100_128` (MP3 44.1kHz) · `mp3_22050_32` (MP3 22kHz) · `pcm_16000` (PCM 16kHz) · `pcm_24000` (PCM 24kHz) · `pcm_44100` (PCM 44.1kHz). (handler) sent as a `?output_format=` query param; PCM saved as `.pcm`.
- **`seed`** — integer, optional (placeholder "Random"). (handler) only sent when non-empty.

### `elevenlabs-sfx` (Text → Audio)
- **`duration_seconds`** — float 0.5–30, step 0.5, optional (placeholder "Auto"). (handler) omitted when blank → ElevenLabs auto-picks length.
- **`prompt_influence`** — float 0–1, step 0.05, default 0.3. Higher = follow the prompt more literally vs. more creative.
- **`loop`** — boolean, default false. Seamless loop for ambiences/beds. (handler) only sent when true.
- **`output_format`** — enum. Default `mp3_44100_128`. Options: `mp3_44100_128` · `mp3_22050_32` · `pcm_44100` · `pcm_24000`.
- *(No `model_id` param — handler fixes it to `eleven_text_to_sound_v2`. No `voice_id`.)*

### `elevenlabs-sts` (Audio → Audio)
- **`voice_id`** — string. Default `21m00Tcm4TlvDq8ikWAM` (Rachel). Target voice to re-render the performance in.
- **`model_id`** — enum. Default `eleven_english_sts_v2`. Options: `eleven_english_sts_v2` (English STS v2) · `eleven_multilingual_sts_v2` (Multilingual STS v2).
- **`stability`** — float 0–1, step 0.05, default 0.5.
- **`similarity_boost`** — float 0–1, step 0.05, default 0.75.
- **`remove_background_noise`** — boolean, default false. (handler) only sent when true.
- **`seed`** — integer, optional (placeholder "Random"). (handler) only sent when non-empty.
- **`output_format`** — enum. Default `mp3_44100_128`. Options: `mp3_44100_128` · `mp3_22050_32` · `pcm_44100` · `pcm_24000`.
- *(handler) `style` and `use_speaker_boost` may be forwarded inside `voice_settings` if present on the node, but the STS node panel does not expose `style`/`use_speaker_boost` controls — treat them as TTS-only knobs.*

### `elevenlabs-isolation` (Audio → Isolated Audio)
- **No params.** Submit audio, get back denoised MP3. Output port labeled "Isolated Audio".

### `elevenlabs-dubbing` (Audio → Dubbed Audio)
- **`target_lang`** — enum, **required**, default `es`. Options: `en` `es` `fr` `de` `it` `pt` `ja` `ko` `zh` `ar` `ru` `hi` `nl` `tr` `pl` `sv`. The download endpoint uses this code, so it must be one the dubbing job produced.
- **`source_lang`** — enum, default `auto` (Auto-detect). Options: `auto` `en` `es` `fr` `de` `ja` `zh`. (handler) only sent when not `auto`.
- **`num_speakers`** — integer 0–10, optional (placeholder "Auto-detect"). (handler) only sent when > 0; 0/blank = auto.
- **`drop_background_audio`** — boolean, default false. (handler) only sent when true. Drops music/ambience, keeps speech.
- **`disable_voice_cloning`** — boolean, default false. Default (off) **preserves the original speaker's voice** in the dub; turn on to use a generic voice instead. (handler) only sent when true.

### `elevenlabs-stt` (Audio → Text)
- **`model_id`** — enum. Default `scribe_v1`. Options: `scribe_v1` (Scribe v1) · `scribe_v2` (Scribe v2). Both verified working against the live API.
- **`language_code`** — string, optional. Blank = auto-detect the spoken language. Set an ISO language code to force a specific language.
- **`diarize`** — boolean, default false. Labels which speaker said what.
- **`num_speakers`** — integer 1–32, optional. Hint for how many distinct speakers to expect; leave blank to let the model decide.
- **`tag_audio_events`** — boolean, default true. Tags non-speech sounds inline, e.g. `(laughter)`, `(applause)`.
- **`transcript_format`** — enum. Default `text`. Options: `text` (plain transcript) · `srt` · `vtt` (subtitle files). (handler) plain `text` returns the transcript string in the `text` output port; `srt`/`vtt` return the subtitle content instead.
- **(handler gotcha)** requesting `srt` or `vtt` **forces `diarize=true` + `timestamps_granularity=word`** automatically, because the ElevenLabs API returns HTTP 400 ("Requesting additional formats must have diarization and timestamps enabled") otherwise. You don't set this — the handler does — but it means a subtitle export is always diarized + word-timestamped regardless of how you left `diarize`. (Caught via live smoke 2026-06-05.)

## Recipes

**1. Script → narrated voiceover (single node).**
- Add a **Text** node (or any Text output) with the script.
- Wire it into `elevenlabs-tts` `text` port.
- Set `voice_id`; pick `model_id` (`eleven_multilingual_v2` for quality, `eleven_flash_v2_5` for speed); tune `stability` / `style` / `speed`.
- Run → the `audio` output is the narration MP3.

**2. Narration + matching ambience (branch into two nodes).**
- Branch a Text/prompt into:
  - `elevenlabs-tts` for the spoken line, and
  - `elevenlabs-sfx` with a prompt like "soft rainstorm with distant thunder", `loop` on, `duration_seconds` ~15 for a bed.
- Take both `audio` outputs downstream into a mix/composite step to lay voice over ambience.

**3. Clean up, then re-voice or translate a clip.**
- Start from an audio upload node or an `elevenlabs-tts` `audio` output.
- If the source is noisy, feed it through `elevenlabs-isolation` first (`audio` → "Isolated Audio").
- Then either:
  - **same language, new voice:** into `elevenlabs-sts` — set the target `voice_id`; optionally enable `remove_background_noise` (redundant if you already isolated).
  - **new language, same speaker:** into `elevenlabs-dubbing` — set `target_lang` (e.g. `ja`), leave `source_lang` on `auto`, keep `disable_voice_cloning` **off** so the original voice is preserved.
- Valid chains in one line: `isolation → sts`, `isolation → dubbing`, `tts → sts`, `tts → isolation`, `sfx → (any audio-input node)`, `(any audio node) → stt`.

**4. Transcribe a clip → feed the text downstream.**
- Start from an audio upload node, or the `audio` output of any audio node (TTS, SFX, isolation, dubbing).
- Wire it into `elevenlabs-stt`; leave `transcript_format` on `text` for a plain transcript.
- Wire the node's `text` output into any text-driven node — e.g. a chat/LLM node (`claude-chat`, `gpt-4o-chat`) to summarize/translate, or Combine Text to assemble a script.
- For subtitles instead: set `transcript_format=srt` (or `vtt`) — the `text` output then carries the subtitle content (the handler auto-enables diarization + word timestamps for these formats; see the param note).

## In the nebula_nodes context

- **Node IDs:** `elevenlabs-tts`, `elevenlabs-sfx`, `elevenlabs-sts`, `elevenlabs-isolation`, `elevenlabs-dubbing`, `elevenlabs-stt`. All `category: "audio-gen"`, all `apiProvider: "elevenlabs"`, all `envKeyName: "ELEVENLABS_API_KEY"`.
- **Handler file:** `backend/handlers/elevenlabs.py` — one handler per node (`handle_elevenlabs_tts`, `_sfx`, `_sts`, `_isolation`, `_dubbing`, `handle_elevenlabs_stt`). Shared `_save_audio` / `_audio_extension` helpers map `output_format` → file extension (mp3→`.mp3`, pcm→`.pcm`, wav→`.wav`, default `.mp3`) for the audio-output nodes; `handle_elevenlabs_stt` does **not** call `_save_audio` — it returns a text string, not a file.
- **Ports:**
  - `elevenlabs-tts`: in `text` (Text, required) → out `audio` (Audio).
  - `elevenlabs-sfx`: in `text` (Text, required) → out `audio` (Audio).
  - `elevenlabs-sts`: in `audio` (Audio, required) → out `audio` (Audio).
  - `elevenlabs-isolation`: in `audio` (Audio, required) → out `audio` (Isolated Audio).
  - `elevenlabs-dubbing`: in `audio` (Audio, required) → out `audio` (Dubbed Audio).
  - `elevenlabs-stt`: in `audio` (Audio, required) → out `text` (Text).
- **Chaining rules:** Text-input nodes (tts, sfx) accept any Text output. Audio-input nodes (sts, isolation, dubbing) accept any Audio output, but the upstream value must resolve to a **local file path that exists** — chain them off another ElevenLabs audio node or an audio upload, not a raw URL. Output of one audio node → input of the next is the normal way to build `isolation → sts/dubbing` and `tts → sts` chains.
- **How outputs render:** each node writes its bytes to the run directory (`get_run_dir()`) as `<12-hex>.<ext>` and returns `{"audio": {"type": "Audio", "value": "<path>"}}`. The frontend serves/plays that file as an audio result. `.mp3` plays everywhere; a `.pcm` (raw, headerless) generally won't — another reason to prefer MP3.
- **Dubbing internals (why it's slow):** submit returns a `dubbing_id`; the handler polls `GET /v1/dubbing/{id}` every 5s up to 120 times (~10 min), tolerating up to 5 *consecutive* poll failures, then downloads `GET /v1/dubbing/{id}/audio/{target_lang}` and saves MP3. So a single dubbing node may run for minutes — that's expected, not a hang.

### Capability boundaries — what ElevenLabs offers but Nebula does NOT expose

Never promise these via a node; there is **no node** for any of them (per the audit gap table in `docs/api-guides/elevenlabs.md`):

- **Music generation** (`/v1/music/compose`, stems, video-to-music) — prompt-to-music and stem separation. No node.
- **Text-to-Dialogue** (`/v1/text-to-dialogue`) — multi-speaker scenes in one call. No node; `elevenlabs-tts` is single-voice only.
- **Voice Design** (`/v1/text-to-voice/design|create|remix`) — invent a brand-new voice from a description. No node.
- **Voice Cloning** (`/v1/voices/add` IVC, `/add/professional` PVC) — clone a voice from samples. No node.
- **Voice management / library** (`GET /v1/voices`, `/shared`, `/similar`) — Nebula takes a `voice_id` string but **cannot list, search, or pick voices in-app**. The user must supply the ID.
- **Models list** (`GET /v1/models`) — model choices are hard-coded enums, not fetched live; SFX has no model selector at all.
- **Dubbing extras** — the node submits/polls/downloads only. It does **not** expose transcripts, per-segment editing, speaker-by-speaker rendering, or watch/CSV-script dubbing.
- **Forced Alignment, Pronunciation Dictionaries, History, Conversational AI/Agents, Studio/Projects, Audio Native, and all streaming/WebSocket variants** — none are nodes.
- **TTS output is MP3 or raw PCM only** — no WAV/OGG/Opus container choice from the node; raw PCM lands as `.pcm`.

Roughly ~33% of the ElevenLabs API surface is wired into Nebula (6 nodes). If the user wants anything in the list above, the honest answer is "not a Nebula node — you'd call the ElevenLabs API directly."

## Sources

- ElevenLabs API introduction: https://elevenlabs.io/docs/api-reference/introduction
- ElevenLabs docs index (capability map): https://elevenlabs.io/docs/llms.txt
- ElevenLabs OpenAPI spec (authoritative endpoint list): https://api.elevenlabs.io/openapi.json
- Speech-to-Text reference (now wired as the `elevenlabs-stt` node): https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- Nebula audit guide (node table, params, gap table, cited sources): `docs/api-guides/elevenlabs.md`
- Ground truth in-repo: `backend/data/node_definitions.json` (node defs) · `backend/handlers/elevenlabs.py` (request building, sync/poll, param mapping, gotchas)

# ElevenLabs in Nebula Nodes

> ElevenLabs is your audio studio inside Nebula: turn text into lifelike speech, generate sound effects from a description, swap one voice for another, strip background noise out of a recording, and dub a clip into another language — all as drag-and-drop nodes on the canvas.

## What you can make

**Speech (voice)**
- Lifelike text-to-speech narration in 70+ languages, with control over a specific voice, stability, style, and speaking speed.
- Voice changer: keep the words and delivery of an existing recording but render it in a different ElevenLabs voice.
- Translated dubbing: take a clip in one language and produce a spoken version in another (Spanish, French, Japanese, and more), with the original speaker's voice preserved by default.
- Transcription: turn a spoken clip into text (or SRT/VTT subtitles), with optional speaker labels.

**Sound design**
- Sound effects generated from a text prompt ("thunderclap with distant rain", "retro arcade coin pickup"), with optional seamless looping for ambience.

**Audio cleanup**
- Audio isolation: pull clean speech out of a noisy recording, removing hiss, room tone, and background clutter.

## Nodes available in Nebula (6)

All six live in the **audio-gen** category. Names, IDs, and params below match `backend/data/node_definitions.json` exactly.

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| ElevenLabs TTS | `elevenlabs-tts` | audio-gen | `text` (Text) → `audio` (Audio) | `voice_id` (default Rachel `21m00Tcm4TlvDq8ikWAM`), `model_id` (v3 / Multilingual v2 / Turbo v2.5 / Flash v2.5 / Turbo v2 / Flash v2), `stability`, `similarity_boost`, `style`, `use_speaker_boost`, `speed` (0.7–1.2), `output_format`, `seed` | Narration, character voices, voiceover from a script |
| ElevenLabs Sound Effects | `elevenlabs-sfx` | audio-gen | `text` (Text) → `audio` (Audio) | `duration_seconds` (0.5–30, Auto if blank), `prompt_influence` (default 0.3), `loop` (seamless loop), `output_format` | Foley, ambiences, UI/game sounds, stingers from a text prompt |
| ElevenLabs Speech-to-Speech | `elevenlabs-sts` | audio-gen | `audio` (Audio) → `audio` (Audio) | `voice_id`, `model_id` (English STS v2 / Multilingual STS v2), `stability`, `similarity_boost`, `remove_background_noise`, `seed`, `output_format` | Re-voice a recording in a different ElevenLabs voice while keeping the performance |
| ElevenLabs Audio Isolation | `elevenlabs-isolation` | audio-gen | `audio` (Audio) → `audio` (Isolated Audio) | *(none — output is always MP3)* | Clean up a noisy clip; extract clear speech from background noise |
| ElevenLabs Dubbing | `elevenlabs-dubbing` | audio-gen | `audio` (Audio) → `audio` (Dubbed Audio) | `target_lang` (required, e.g. `es`), `source_lang` (Auto-detect default), `num_speakers` (Auto if 0/blank), `drop_background_audio`, `disable_voice_cloning` | Translate a spoken clip into another language, keeping the speaker's voice |
| ElevenLabs STT | `elevenlabs-stt` | audio-gen | `audio` (Audio) → `text` (Text) | `model_id` (Scribe v1/v2), `language_code`, `diarize`, `num_speakers`, `tag_audio_events`, `transcript_format` (text/srt/vtt) | Transcribe speech to text or subtitles |

Notes that match the handler (`backend/handlers/elevenlabs.py`):
- `style` is only sent to the API when it is greater than 0.
- `seed` (TTS and STS) is only sent when you set it; leave it blank for random.
- For TTS, `output_format` includes MP3 (44.1kHz / 22kHz) and raw PCM (16/24/44.1kHz). Raw PCM is saved as a `.pcm` file (it has no WAV header), so prefer an MP3 format unless you specifically need PCM.
- Audio Isolation and Dubbing always return MP3, regardless of any format setting.

## How to use it in Nebula

**Where the nodes appear.** Open the node palette (the add-node menu on the canvas) and look under the **audio-gen** category. The six ElevenLabs nodes are listed by their display names ("ElevenLabs TTS", "ElevenLabs Sound Effects", etc.). Drag one onto the canvas, wire an input into its input port, and set params in the node's panel.

**API-key setup.** Get a key from your ElevenLabs account dashboard (Profile → API Keys). Open Nebula **Settings**, paste it into the **ElevenLabs** field (`ELEVENLABS_API_KEY`), and choose **Save Settings**. Nebula stores it under `apiKeys.ELEVENLABS_API_KEY` in the project-root `settings.json`; no restart is required. Every ElevenLabs node uses this same key; if it is missing, the node fails with "ELEVENLABS_API_KEY is required."

**Picking a voice.** The `voice_id` param defaults to Rachel (`21m00Tcm4TlvDq8ikWAM`). To use a different voice, paste its voice ID into the `voice_id` field. You find voice IDs in the ElevenLabs Voice Library / your Voices page on the ElevenLabs site — Nebula does not browse or list voices for you, so keep the IDs you want handy.

### Example pipelines

**1. Script → narrated voiceover (single node).**
- Add a **Text** node (or any node that outputs Text) with your script.
- Wire it into `elevenlabs-tts` (`text` port).
- Set `voice_id`, pick `model_id` (use *Multilingual v2* for quality, *Flash v2.5* for speed), and adjust `stability` / `style` to taste.
- Run. The `audio` output is your narration MP3.

**2. Narration + matching ambience → layered audio.**
- Branch your Text/prompt into two nodes:
  - `elevenlabs-tts` for the spoken line.
  - `elevenlabs-sfx` with a prompt like "soft rainstorm with distant thunder", `loop` on, `duration_seconds` ~15 for a bed.
- Take both `audio` outputs downstream (e.g. into your mixing/compositing step) to lay the voice over the ambience.

**3. Re-voice and translate a clip → localized voiceover.**
- Start from any node that produces an `audio` clip (an upload node, or the output of `elevenlabs-tts`).
- Option A (same language, new voice): feed it into `elevenlabs-sts`, set the target `voice_id`, enable `remove_background_noise` if the source is noisy.
- Option B (new language, same speaker): feed it into `elevenlabs-dubbing`, set `target_lang` (e.g. `ja` for Japanese), leave `source_lang` on Auto-detect, and keep `disable_voice_cloning` off so the original speaker's voice is preserved.
- For a noisy source, chain `elevenlabs-isolation` first (audio → isolated audio) and feed the clean result into dubbing or STS.

## API coverage — what Nebula uses vs. what ElevenLabs offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text-to-Speech — `POST /v1/text-to-speech/{voice_id}` | Yes | **full** | `elevenlabs-tts`. Core params wired (voice, model, voice_settings, speed, seed, output_format). |
| Sound Effects — `POST /v1/sound-generation` | Yes | **full** | `elevenlabs-sfx`. text, duration, prompt_influence, loop, output_format. (Docs also expose this as `/v1/text-to-sound-effects`.) |
| Speech-to-Speech (Voice Changer) — `POST /v1/speech-to-speech/{voice_id}` | Yes | **full** | `elevenlabs-sts`. voice_settings, remove_background_noise, seed forwarded. |
| Audio Isolation — `POST /v1/audio-isolation` | Yes | **full** | `elevenlabs-isolation`. Single-purpose; output always MP3. |
| Dubbing — `POST /v1/dubbing` (+ poll + download) | Yes | **partial** | `elevenlabs-dubbing` submits, polls, and downloads dubbed audio. Does not expose transcripts, per-segment editing, speaker rendering, or watch/CSV-script dubbing. |
| Speech-to-Text — `POST /v1/speech-to-text` | Yes | **full** | `elevenlabs-stt`. Transcription with optional diarization; plain text or SRT/VTT subtitles (subtitle formats auto-enable diarization + timestamps, per the API). |
| Music generation — `POST /v1/music/compose` (+ stream, video-to-music, stems) | Yes | **none** | Prompt-to-music, stem separation, composition plans. No node. |
| Text-to-Dialogue — `POST /v1/text-to-dialogue` | Yes | **none** | Multi-speaker dialogue in one call. No node (TTS handles single-voice only). |
| Voice Design — `POST /v1/text-to-voice/design` `/create` `/remix` | Yes | **none** | Generate a brand-new voice from a text description. No node. |
| Voice Cloning — `POST /v1/voices/add` (IVC), `/add/professional` (PVC) | Yes | **none** | Clone a voice from samples. No node. |
| Voices management & library — `GET /v1/voices`, `/v1/voices/shared`, `/similar` | Yes | **none** | Nebula takes a `voice_id` string but can't list, search, or pick voices in-app. |
| Models list — `GET /v1/models` | Yes | **none** | Model choices are hard-coded enums in the node, not fetched live. |
| Forced Alignment — `POST /v1/forced-alignment` | Yes | **none** | Word-level text↔audio timestamp alignment. No node. |
| Conversational AI / Agents — `/v1/convai/*` | Yes | **none** | Full agent platform (agents, conversations, tools, telephony). Out of scope for a node canvas. |
| Studio / Projects — `/v1/studio`, `/v1/projects` | Yes | **none** | Long-form project authoring (chapters, snapshots). No node. |
| Pronunciation Dictionaries — `/v1/pronunciation-dictionaries` | Yes | **none** | Custom pronunciation rules. Not surfaced (TTS node has no dictionary hookup). |
| Audio Native — embeddable web player | Yes | **none** | Website embed product; not a media-generation node. |
| History — `GET /v1/history` | Yes | **none** | Past-generation retrieval/download. Nebula manages its own run outputs instead. |
| Streaming / WebSocket variants (TTS stream, multi-context, realtime STT) | Yes | **none** | All Nebula nodes are request/response; no low-latency streaming. |

Coverage: ~33% of the ElevenLabs API surface is exposed in Nebula (6 of ~18 major capability families; among the ~12 generative/transformation families a node-based media app would plausibly want — i.e. excluding the Conversational AI, Studio, Audio-Native, and account/history platforms — coverage is closer to ~42%).

Notable unused capabilities: **Music generation** (prompt-to-music with stem separation), **Text-to-Dialogue** (multi-speaker scenes in one call), **Voice Design** (create a new voice from a description), and **Voice cloning** (IVC/PVC). For an app whose whole premise is wiring media nodes together, the absence of a music node (prompt-to-music with stems, which has no equivalent anywhere else in the catalog) is now the most visible gap.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/elevenlabs/SKILL.md` (new 2026-06-04, updated 2026-06-05 for STT). It covers all **6** wired ElevenLabs audio nodes — including the new `elevenlabs-stt` — giving an agent the node IDs and ports, per-node param schemas, voice handling, wiring/chaining rules, auth/failure modes, and capability boundaries.

What it covers:
- **Node inventory & IDs** — the six node IDs (`elevenlabs-tts`, `elevenlabs-sfx`, `elevenlabs-sts`, `elevenlabs-isolation`, `elevenlabs-dubbing`, `elevenlabs-stt`), their input/output ports (`text`/`audio` in, `audio` or `text` out), and that all are `audio-gen`.
- **Param schemas & valid values** — per-node param keys with types, ranges, and enums (TTS/STS model lineups, dubbing `target_lang`/`source_lang` codes, STT `transcript_format`, output_format options).
- **Voice handling** — that `voice_id` is a free-text ElevenLabs ID (default Rachel `21m00Tcm4TlvDq8ikWAM`), where to obtain IDs, and that Nebula can't enumerate voices.
- **Wiring rules & encoding** — which nodes take Text vs. Audio, valid chains (isolation → STS/dubbing; TTS → STS), JSON-vs-multipart encoding, and the dubbing submit→poll internals.
- **Auth & failure modes** — `ELEVENLABS_API_KEY` / the `xi-api-key` header, and common errors (missing key/input, the PCM-saved-as-`.pcm` gotcha, dubbing timeout).
- **Capability boundaries** — that music, text-to-dialogue, voice design, and cloning are NOT nodes, so an agent doesn't promise them.

## Sources

- ElevenLabs API introduction: https://elevenlabs.io/docs/api-reference/introduction
- ElevenLabs docs index (machine-readable capability map): https://elevenlabs.io/docs/llms.txt
- ElevenLabs OpenAPI specification (authoritative endpoint list): https://api.elevenlabs.io/openapi.json
- Speech-to-Text reference: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
- Existing Nebula developer audit (verified against `openapi.json` + official Python SDK, 2026-05-16/17/19): `docs/model-providers/elevenlabs/elevenlabs.md`

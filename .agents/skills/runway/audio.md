# Runway Audio — TTS, Speech-to-Speech, Voice Dubbing

All three endpoints wrap ElevenLabs under the hood.

**On the person's ElevenLabs key (2026-10-14).** The three nodes also run on ElevenLabs' own API when `ELEVENLABS_API_KEY` is saved (`backend/execution/maker_routes_elevenlabs.py`), billed by ElevenLabs:

- `runway-dubbing` -> `POST /v1/dubbing`, same four settings renamed to snake_case. Runs on ElevenLabs whenever the key is set.
- `runway-tts` -> `POST /v1/text-to-speech/{voice_id}` (`eleven_multilingual_v2`) and `runway-sts` -> `POST /v1/speech-to-speech/{voice_id}` (`eleven_multilingual_sts_v2`) **only when the recipe sets `voice_id`, an ElevenLabs voice ID**. Runway's presets (`voiceId`) have no documented ElevenLabs id, so a preset-only recipe stays on Runway. ElevenLabs STS takes the `audio` input only; a video-only run on that route is refused before any call.

Params on these nodes are split by route: `voiceId` is Runway-only (`falParams`), `voice_id` is ElevenLabs-only (`directParams`), the rest is shared.

---

## `POST /v1/text_to_speech`

### Required

| Field | Type | Notes |
|---|---|---|
| `model` | `"eleven_multilingual_v2"` | Only option. |
| `promptText` | string, ≤1000 chars | Text to speak. |
| `voice` | `{ type: "runway-preset", presetId }` | Preset ID (see list below). |

### Example

```json
POST /v1/text_to_speech
{
  "model": "eleven_multilingual_v2",
  "promptText": "Welcome back. Your video is ready.",
  "voice": { "type": "runway-preset", "presetId": "Maya" }
}
```

---

## `POST /v1/speech_to_speech`

Restyle spoken audio using a preset voice — keeps the prosody, swaps the timbre.

### Required

| Field | Type | Notes |
|---|---|---|
| `model` | `"eleven_multilingual_sts_v2"` | Only option. |
| `media` | `{ type: "audio" \| "video", uri }` | Source containing dialogue. Video = audio track is used. |
| `voice` | `{ type: "runway-preset", presetId }` | Target voice. |

### Optional

| Field | Type | Notes |
|---|---|---|
| `removeBackgroundNoise` | bool | Clean the output. |

---

## `POST /v1/voice_dubbing`

Dub audio into another language, optionally cloning the speaker's voice.

### Required

| Field | Type | Notes |
|---|---|---|
| `audioUri` | string | HTTPS URL to source audio. |
| `model` | `"eleven_voice_dubbing"` | Only option. |
| `targetLang` | enum | Target language ISO code (29 supported — list below). |

### Optional

| Field | Type | Notes |
|---|---|---|
| `disableVoiceCloning` | bool | Use a generic voice instead of cloning the speaker. |
| `dropBackgroundAudio` | bool | Remove music/ambient noise. |
| `numSpeakers` | int | Override auto-detection. |

### Target languages

`en`, `hi`, `pt`, `zh`, `es`, `fr`, `de`, `ja`, `ar`, `ru`, `ko`, `id`, `it`, `nl`, `tr`, `pl`, `sv`, `fil`, `ms`, `ro`, `uk`, `el`, `cs`, `da`, `fi`, `bg`, `hr`, `sk`, `ta`.

---

## Voice presets (shared by TTS + STS)

49 total. Group by voice type:

**Female:** `Maya`, `Serene`, `Mabel`, `Leslie`, `Eleanor`, `Sandra`, `Kylie`, `Lara`, `Lisa`, `Marlene`, `Miriam`, `Paula`, `Maggie`, `Katie`, `Rina`, `Ella`, `Mariah`, `Claudia`, `Niki`, `Myrna`, `Wanda`, `Kiana`, `Rachel`

**Male:** `Arjun`, `Bernard`, `Billy`, `Mark`, `Clint`, `Chad`, `Elias`, `Elliot`, `Brodie`, `Kirk`, `Malachi`, `Martin`, `Jack`, `Noah`, `James`, `Frank`, `Vincent`, `Kendrick`, `Tom`, `Benjamin`

**Characterful / stylized:** `Grungle`, `Monster`, `Pip`, `Rusty`, `Ragnar`, `Xylar`

All presets require exact casing — `"maya"` will fail; use `"Maya"`.

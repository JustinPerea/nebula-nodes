# Runway Audio — TTS, Speech-to-Speech, Voice Dubbing

All three endpoints wrap ElevenLabs under the hood.

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

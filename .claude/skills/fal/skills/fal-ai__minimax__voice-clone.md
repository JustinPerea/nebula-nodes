---
name: fal-ai/minimax/voice-clone
display_name: MiniMax Voice Cloning
category: audio-to-audio
creator: MiniMax (MiniMax Group Inc.)
fal_docs: https://fal.ai/models/fal-ai/minimax/voice-clone
original_source: https://platform.minimax.io/docs/guides/speech-voice-clone
summary: A high-fidelity voice cloning model that creates digital twins from 10+ seconds of audio for use with MiniMax's advanced TTS engines.
---

# MiniMax Voice Cloning

## Overview
- **Slug:** `fal-ai/minimax/voice-clone`
- **Category:** Audio Generation / Voice Cloning
- **Creator:** [MiniMax Group Inc.](https://www.minimax.io)
- **Best for:** Creating high-fidelity digital voice clones for personalized text-to-speech with natural prosody and emotion.
- **FAL docs:** [fal-ai/minimax/voice-clone](https://fal.ai/models/fal-ai/minimax/voice-clone)
- **Original source:** [MiniMax API Docs](https://platform.minimax.io/docs/guides/speech-voice-clone)

## What it does
MiniMax Voice Cloning allows users to create a reusable "Voice ID" from a short sample of reference audio (minimum 10 seconds). Once cloned, the voice can be used with MiniMax's high-definition and turbo text-to-speech models to generate speech that retains the original speaker's timbre, accent, and unique vocal characteristics with up to 99% similarity. It supports multilingual synthesis across 30-40+ languages and allows for fine-grained control over emotions and interjections.

## When to use this model
- **Use when:** 
    - You need consistent, personalized narration for videos (YouTube, TikTok, Podcasts).
    - You want to create a multilingual "digital twin" of a specific speaker.
    - You require emotional range (happy, sad, angry) in synthesized speech.
    - You need to generate long-form audiobooks or educational content with a specific brand voice.
- **Don't use when:** 
    - You only have very short (<10s) or low-quality/noisy audio samples.
    - You need real-time streaming with zero latency (cloning itself takes ~30s; inference is fast but not instantaneous for the initial clone).
- **Alternatives:** 
    - **[fal-ai/f5-tts](https://fal.ai/models/fal-ai/f5-tts):** Better for zero-shot cloning (no pre-training step) but may have less emotional control.
    - **[fal-ai/fish-speech](https://fal.ai/models/fal-ai/fish-speech):** Excellent for expressive, natural-sounding Chinese/English.
    - **ElevenLabs:** Often considered the industry gold standard for voice quality, though MiniMax is highly competitive for multilingual and emotional nuance.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/minimax/voice-clone` (Synchronous) / `https://queue.fal.run/fal-ai/minimax/voice-clone` (Queue mode)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | (Required) | - | URL of the input audio file for voice cloning. Should be at least 10 seconds long (max ~5 mins/20MB recommended). |
| `noise_reduction` | boolean | `false` | `true`, `false` | Enable noise reduction for the cloned voice. Use this if the source audio has background hiss or hum. |
| `need_volume_normalization`| boolean | `false` | `true`, `false` | Enable volume normalization for the cloned voice to ensure consistent output levels. |
| `accuracy` | float | `0.7` | `0.0` - `1.0` | Text validation accuracy threshold. Higher values ensure better alignment with the reference but might be stricter on audio quality. |
| `text` | string | `""` | Max 500 chars | Optional text to generate a TTS preview immediately with the cloned voice. |
| `model` | string | `speech-02-hd`| `speech-02-hd`, `speech-02-turbo`, `speech-01-hd`, `speech-01-turbo` | TTS model version to use for the preview audio. |

### Output
The API returns a JSON object containing:
- `custom_voice_id` (string): The unique identifier for the newly created voice clone. This ID is used in subsequent TTS calls (e.g., `speech-02-hd`) as the `voice_id`.
- `audio` (object): A file object containing the URL to the preview audio if the `text` parameter was provided.

### Example request
```json
{
  "audio_url": "https://example.com/my-voice-sample.mp3",
  "noise_reduction": true,
  "text": "Hello, this is a test of my newly cloned voice using MiniMax on fal.ai!",
  "model": "speech-02-hd"
}
```

### Pricing
- **Per Voice Clone:** $1.50 per successful request.
- **Preview Inputs:** $0.30 per 1000 characters for the initial preview generation.
- **Subsequent TTS Usage:** Billed separately according to the specific MiniMax model used (e.g., `speech-02-hd` is typically $50 per million characters).

## API — via Original Source (BYO-key direct)
MiniMax provides a native API for developers who want to manage their own voice libraries directly.

- **Endpoint:** `https://api.minimax.io/v1/voice_clone`
- **Auth Method:** Bearer Token (`Authorization: Bearer <API_KEY>`)
- **Native Parameters:** 
    - `file_id`: Unlike FAL which uses URLs, the native API requires uploading files first via the `/files/upload` endpoint to get a `file_id`.
    - `voice_id`: Allows you to specify a custom name for the voice.
- **Official Docs:** [MiniMax Voice Clone Guide](https://platform.minimax.io/docs/guides/speech-voice-clone)

## Prompting best practices
- **Reference Audio Quality:** The single most important factor. Use a 15-30 second clip of clear, mono audio recorded in a quiet room. Avoid music, reverb, or multiple speakers.
- **Expressive Samples:** If you want a "happy" or "energetic" clone, ensure the reference audio is spoken with that emotion. The model captures the energy and cadence of the source.
- **Interjection Tags (In TTS):** Once cloned, use tags in your TTS text like `(laughs)`, `(sighs)`, `(coughs)`, or `(clears throat)` to add realism.
- **Pause Markers:** Use `<#x#>` (where x is seconds, e.g., `<#1.5#>`) to insert precise silences for better timing in narrations.
- **Language Boost:** If the speaker has a strong accent or is speaking a non-English language, use the `language_boost` parameter (available in TTS models) to improve clarity.

## Parameter tuning guide
- **`accuracy` (0.7):** Increase to `0.9` if the clone sounds "muddy" or captures too much background noise; decrease to `0.5` if the system rejects your audio for minor background artifacts.
- **`noise_reduction`:** Always set to `true` if recording on a smartphone or in a non-studio environment. Keep `false` for professional studio recordings to preserve high-frequency details.
- **`model` selection:** Use `speech-02-hd` for final production assets where quality is paramount. Use `speech-02-turbo` for testing or interactive applications where speed is critical.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Audio Source`: Port for a file URL or binary audio buffer.
    - `Preview Text`: String input for immediate verification.
    - `Enable Cleaning`: Toggle for noise/volume normalization.
- **Outputs:**
    - `Voice ID`: String output to be piped into a "MiniMax TTS" node.
    - `Preview Audio`: Audio file URL for listening to the result.
- **Chain-friendly with:**
    - `fal-ai/minimax/speech-02-hd`: Use the generated `Voice ID` here to generate long-form audio.
    - `fal-ai/minimax/video-01`: Use the generated audio to drive lipsync for AI-generated avatars.
    - `fal-ai/llm-voice-design`: Use LLMs to generate the script that the voice clone will read.

## Notes & gotchas
- **Cloning Time:** Voice cloning is a "training" task that typically takes 30-60 seconds. Use FAL's **Queue Mode** (`/queue/submit`) to avoid timeouts.
- **Expiry:** MiniMax may delete unused cloned voices after 7 days if they aren't utilized in synthesis tasks (check specific FAL persistence policies).
- **Safety:** MiniMax has strict content filters. Attempting to clone famous public figures or generate sensitive/illegal content may trigger account blocks.

## Sources
- [FAL.ai MiniMax Voice Clone Docs](https://fal.ai/models/fal-ai/minimax/voice-clone/api)
- [Official MiniMax API Documentation](https://platform.minimax.io/docs/guides/speech-voice-clone)
- [MiniMax T2A Interjection Tags](https://platform.minimax.io/docs/api-reference/speech-t2a-http)
- [Replicate Blog: Running MiniMax Speech-02](https://replicate.com/blog/minimax-text-to-speech)

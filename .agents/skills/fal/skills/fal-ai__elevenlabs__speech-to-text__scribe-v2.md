---
name: fal-ai/elevenlabs/speech-to-text/scribe-v2
display_name: ElevenLabs Scribe V2 (via FAL.ai)
category: speech-to-text
creator: ElevenLabs
fal_docs: https://fal.ai/models/fal-ai/elevenlabs/speech-to-text/scribe-v2
original_source: https://elevenlabs.io/speech-to-text
summary: The world's most accurate batch transcription model featuring 98%+ accuracy, multi-speaker diarization, and intelligent keyterm biasing.
---

# ElevenLabs Scribe V2 (via FAL.ai)

## Overview
- **Slug:** `fal-ai/elevenlabs/speech-to-text/scribe-v2`
- **Category:** speech-to-text
- **Creator:** [ElevenLabs](https://elevenlabs.io/)
- **Best for:** High-accuracy batch transcription of complex audio with multiple speakers and industry-specific terminology.
- **FAL docs:** [fal.ai/models/fal-ai/elevenlabs/speech-to-text/scribe-v2](https://fal.ai/models/fal-ai/elevenlabs/speech-to-text/scribe-v2)
- **Original source:** [ElevenLabs Speech to Text](https://elevenlabs.io/speech-to-text)

## What it does
ElevenLabs Scribe V2 is a state-of-the-art speech-to-text model designed for batch processing of audio and video files. It achieves a Word Error Rate (WER) of less than 5% for many major languages, outperforming traditional models like Whisper in handling diverse accents, background noise, and rapid speaker transitions. The model provides word-level timestamps, identifies multiple speakers (diarization), and can detect non-speech events like laughter or applause. Its standout feature is "Keyterm Biasing," which allows users to provide a list of technical terms or names to ensure they are transcribed correctly based on context.

## When to use this model
- **Use when:**
    - You need the highest possible accuracy for business meetings, medical dictation, or legal proceedings.
    - The audio contains multiple people speaking, and you need to know who said what.
    - You have industry-specific jargon, brand names, or technical terms that generic models often misspell.
    - You are transcribing long-form content (up to 10 hours) and want a reliable batch process.
- **Don't use when:**
    - You require real-time, ultra-low latency transcription (use `scribe-v2-realtime` instead).
    - You are looking for a completely free or open-source solution (consider [Whisper](https://fal.ai/models/fal-ai/whisper)).
    - The audio quality is extremely poor (though Scribe V2 is robust, very heavy distortion still poses a challenge).
- **Alternatives:**
    - **[OpenAI Whisper V3](https://fal.ai/models/fal-ai/whisper):** Excellent general-purpose model, often cheaper but can struggle with precise diarization and "hallucinations" during silences.
    - **[Deepgram Nova-2](https://deepgram.com/):** High speed and low cost, but Scribe V2 generally leads in accuracy for complex multilingual recordings.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2` (Sync) / `https://queue.fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `audio_url` | string | *Required* | Valid URL | The URL of the audio or video file to transcribe. Supported: mp3, ogg, wav, m4a, aac, mp4, etc. |
| `language_code` | string | `null` | ISO 639-1 (e.g., `eng`, `spa`) | Optional code to force a specific language. If null, the model uses automatic language detection. |
| `tag_audio_events` | boolean | `true` | `true`, `false` | Whether to tag non-speech events such as laughter, applause, and background noise. |
| `diarize` | boolean | `true` | `true`, `false` | If enabled, the model identifies and labels different speakers in the audio. |
| `keyterms` | list<string> | `[]` | Up to 100 terms | A list of words or phrases (max 50 chars each) to bias the model towards. Note: Adds 30% premium to cost. |

### Output
The API returns a JSON object containing the full transcript and granular metadata:
- **`text`**: The complete, formatted transcription.
- **`language_code`**: The detected or specified language.
- **`language_probability`**: A confidence score (0-1) for the language detection.
- **`words`**: A list of objects, each representing a word or event:
    - `text`: The word or event tag (e.g., "[laughter]").
    - `start`: Start timestamp in seconds.
    - `end`: End timestamp in seconds.
    - `type`: Type of element (`word`, `spacing`, or `audio_event`).
    - `speaker_id`: String identifier for the speaker (if `diarize` is true).

### Example request
```json
{
  "audio_url": "https://storage.googleapis.com/falserverless/example_inputs/elevenlabs_scribe_v2_in.mp3",
  "language_code": "eng",
  "tag_audio_events": true,
  "diarize": true,
  "keyterms": ["FAL.ai", "Scribe V2", "ElevenLabs"]
}
```

### Pricing
- **Base Rate:** $0.008 per minute of input audio.
- **Keyterm Premium:** Using the `keyterms` parameter increases the cost of the request by **30%**.
- Minimum charge typically applies per call based on FAL's standard platform pricing.

## API — via Original Source (BYO-key direct)
The native ElevenLabs API offers a more direct route for users with their own subscriptions.
- **Endpoint:** `POST https://api.elevenlabs.io/v1/speech-to-text`
- **Auth:** `xi-api-key` header.
- **Additional Capabilities:**
    - **Entity Detection:** ElevenLabs supports a `entities` parameter (56 categories) to redact or highlight PII, health data, or payment details, which is currently not exposed in the standard FAL wrapper.
    - **Multichannel Mode:** Support for transcribing up to 5 channels independently (ideal for call center recordings).
    - **Higher Concurrency:** Direct API tiers allow for higher parallel processing limits.
- **Direct Docs:** [ElevenLabs API Reference](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) (Note: Look under Speech to Text section).

## Prompting best practices
1. **Leverage Keyterms for Names:** If your audio mentions specific people, brands, or products (e.g., "Scribe V2", "Flora App"), always add them to the `keyterms` list. This prevents common phonetic substitutions (e.g., transcribing "FAL" as "fall").
2. **Contextual Keyterms:** You can add phrases as keyterms, not just single words. Adding "Node-based AI workflow" helps the model understand the semantic context of a technical discussion.
3. **Language Guidance:** If you know the audio is 100% in one language, provide the `language_code`. While auto-detect is excellent, pre-defining it saves a small amount of processing overhead and reduces the risk of incorrect detection in short or noisy clips.
4. **Clean Audio URLs:** Ensure your `audio_url` is a direct link to the file. Redirects or session-limited URLs (like some Google Drive links) may cause the model to fail to fetch the content.

## Parameter tuning guide
- **`diarize`:** Always keep this `true` for interviews or podcasts. If you are transcribing a single-person monologue, set it to `false` to simplify the output JSON and potentially reduce word-joining errors at speaker boundaries.
- **`tag_audio_events`:** Essential for subtitling and accessibility. If you are using the transcript for LLM analysis, you might want to strip these out later or disable them to get "cleaner" text for the prompt.
- **`keyterms`:** Use sparingly. While you can have up to 100, focusing on the top 10 most critical "uncommon" words yields the best results. Adding very common words (e.g., "the", "hello") as keyterms is unnecessary and may confuse the biasing logic.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Audio/Video File (URL)`: The primary source.
    - `Language Code (String)`: Optional manual override.
    - `Custom Vocabulary (List)`: Maps to `keyterms`.
    - `Enable Diarization (Toggle)`: Maps to `diarize`.
- **Outputs:**
    - `Full Transcript (String)`: The raw text.
    - `Speaker Segments (List)`: A grouped version of the `words` output for easier "Chat UI" rendering.
    - `Confidence (Number)`: The `language_probability`.
- **Chain-friendly with:**
    - **[OpenAI GPT-4o](https://fal.ai/models/fal-ai/gpt-4o):** Feed the transcript into GPT-4o for summarization or action item extraction.
    - **[ElevenLabs TTS](https://fal.ai/models/fal-ai/elevenlabs/text-to-speech/v3):** Use Scribe to transcribe an old recording, then use TTS to generate a "cleaned-up" voiceover.

## Notes & gotchas
- **File Size:** Supports files up to 3 GB.
- **Duration:** Standard batch mode supports up to 10 hours of audio.
- **Parallel Processing:** For files over 8 minutes, ElevenLabs automatically chunks the audio to process segments in parallel, which significantly speeds up delivery but can occasionally lead to slight "seam" artifacts in the timestamps.
- **Keyterm Cost:** Remember the **30% price increase** when using keyterms. For a 60-minute file, this is the difference between ~$0.48 and ~$0.62.

## Sources
- [FAL.ai Scribe V2 Docs](https://fal.ai/models/fal-ai/elevenlabs/speech-to-text/scribe-v2)
- [ElevenLabs Scribe V2 Official Blog](https://elevenlabs.io/blog/introducing-scribe-v2)
- [ElevenLabs Capabilities Documentation](https://elevenlabs.io/docs/capabilities/speech-to-text)
- [ElevenLabs API Pricing](https://elevenlabs.io/pricing/api)

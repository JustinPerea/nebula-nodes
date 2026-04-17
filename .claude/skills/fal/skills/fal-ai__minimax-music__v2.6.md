---
name: fal-ai/minimax-music/v2.6
display_name: MiniMax Music 2.6
category: text-to-audio
creator: MiniMax (Hailuo AI)
fal_docs: https://fal.ai/models/fal-ai/minimax-music/v2.6
original_source: https://platform.minimax.io/docs/guides/music-generation
summary: A professional-grade text-to-music model that generates full-length studio-quality songs with high-fidelity vocals, instrumentals, and complex arrangements.
---

# MiniMax Music 2.6

## Overview
- **Slug:** `fal-ai/minimax-music/v2.6`
- **Category:** text-to-audio (Music Generation)
- **Creator:** MiniMax (Hailuo AI)
- **Best for:** Generating full-length, studio-quality songs with realistic vocals and professional instrumentals from text prompts and lyrics.
- **FAL docs:** [fal.ai/models/fal-ai/minimax-music/v2.6](https://fal.ai/models/fal-ai/minimax-music/v2.6)
- **Original source:** [MiniMax API Documentation](https://platform.minimax.io/docs/guides/music-generation)

## What it does
MiniMax Music 2.6 is a state-of-the-art music generation model capable of producing complete tracks, including natural-sounding vocals, multi-layered instrumentation, and genre-specific mixing. It supports long-form audio (typically up to ~3-4 minutes) and can follow complex structural instructions using bracketed tags. It distinguishes itself from competitors with superior vocal clarity and the ability to strictly follow provided lyrics while maintaining rhythmic and melodic coherence.

## When to use this model
- **Use when:** You need a high-fidelity song with specific lyrics and a clearly defined genre (e.g., synth-pop, blues, lo-fi).
- **Use when:** You want to generate "AI Covers" where an existing melody is re-rendered in a new style (supported via the `music-cover` variant at the source).
- **Don't use when:** You only need simple sound effects or ambient loops without a musical structure.
- **Alternatives:**
  - `fal-ai/stable-audio`: Better for generic ambient loops and short samples.
  - `fal-ai/udio`: Highly competitive for creative musicality but often more expensive or restrictive in API form.
  - `fal-ai/suno-v4`: Strong alternative for pop-style compositions.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/minimax-music/v2.6` (sync) / `https://queue.fal.run/fal-ai/minimax-music/v2.6` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | 10-2000 chars | Description of music style, mood, genre, and scenario (e.g., "80s synthwave, fast tempo"). |
| `lyrics` | string | "" | Max 3500 chars | The song lyrics. Use `\n` for line breaks. Supports structure tags like `[Chorus]`. |
| `lyrics_optimizer` | boolean | `false` | `true`, `false` | If `true` and `lyrics` is empty, the AI auto-generates lyrics based on the `prompt`. |
| `is_instrumental` | boolean | `false` | `true`, `false` | When `true`, generates vocal-free instrumental music. |
| `audio_setting.sample_rate` | integer | `44100` | `16000`, `24000`, `32000`, `44100` | Output audio sample rate in Hz. |
| `audio_setting.bitrate` | integer | `256000` | `32000` to `256000` | Output bitrate in bps. |
| `audio_setting.format` | string | `"mp3"` | `"mp3"`, `"wav"`, `"pcm"` | The audio file format. |

### Output
The output is a JSON object containing a reference to the generated audio file.
```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/mpeg",
    "file_name": "output.mp3",
    "file_size": 813651
  }
}
```

### Example request
```json
{
  "prompt": "City Pop, 80s retro, groovy synth bass, warm female vocal, 104 BPM, nostalgic urban night",
  "lyrics": "[Intro]\n(Groovy synth beat starts)\n\n[Verse 1]\nNeon lights reflecting in the rain\nDriving down the highway, hiding all the pain\n\n[Chorus]\nStay with me, under the moonlight sky\nDon't let this magic feeling ever die",
  "audio_setting": {
    "sample_rate": 44100,
    "bitrate": 256000,
    "format": "mp3"
  }
}
```

### Pricing
$0.15 per audio generation (billed per request on FAL.ai).

## API — via Original Source (BYO-key direct)
**Endpoint:** `https://api.minimax.io/v1/music_generation`

### Parameters
The native API exposed by MiniMax includes additional models and output options:
- **`model`**: Options include `music-2.6` (standard), `music-cover` (reference-based), and `music-2.6-free` (rate-limited free tier).
- **`output_format`**: Can be set to `"url"` or `"hex"` (for direct raw data).
- **`audio_url` / `audio_base64`**: Used only with the `music-cover` model to provide a reference track.

**Auth method:** Bearer Token (API Key) + Group ID.
**Docs:** [MiniMax API Reference](https://platform.minimax.io/docs/api-reference/music-generation)

## Prompting best practices
- **Structure is Key:** Always use structural tags like `[Intro]`, `[Verse]`, `[Pre-Chorus]`, `[Chorus]`, `[Bridge]`, `[Drop]`, and `[Outro]`. These help the model understand the song's arc.
- **Instrumental Cues:** Use parentheses for background cues like `(Synthesizer solo)`, `(Fast drum fill)`, or `(Backing vocals)`.
- **Genre Stacking:** Combine specific genres with mood and tempo. Example: "Dark Techno, Industrial, 130 BPM, heavy distortion, aggressive."
- **Vocal Specification:** Be explicit about the singer's voice. Use terms like "soulful male vocals," "breathy female indie voice," or "operatic soprano."
- **Avoid Over-Prompting:** If you provide lyrics, keep the style prompt focused on the *sound* rather than the story, as the story will come from the lyrics.

## Parameter tuning guide
- **`lyrics_optimizer`**: Turn this on if you have a great genre idea but no lyrics. The AI is surprisingly good at matching rhyme schemes to the requested genre (e.g., generating Rap vs. Folk lyrics).
- **`is_instrumental`**: Essential for background music. Note that even if `lyrics` is empty, the model might try to hum or add vocalizations unless this is set to `true`.
- **`audio_setting.sample_rate`**: For professional use, always stick to `44100`. Lower rates like `16000` are only suitable for low-bandwidth previews.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Prompt` (Text)
  - `Lyrics` (Text)
  - `Instrumental Mode` (Boolean)
  - `Auto-generate Lyrics` (Boolean)
  - `Bitrate` (Integer)
- **Outputs:**
  - `Audio URL` (URL)
  - `Duration` (Seconds - extracted from extra_info at source)
- **Chain-friendly with:**
  - `fal-ai/flux`: Generate high-quality album art based on the song's theme.
  - `fal-ai/minimax-video`: Use the generated audio as a soundtrack for AI-generated music videos.
  - `fal-ai/whisper`: Transcribe and align generated songs for subtitle/lyric video creation.

## Notes & gotchas
- **Link Expiration:** Audio URLs generated directly via MiniMax expire after 24 hours. FAL.ai URLs typically last longer but should still be persisted if needed permanently.
- **Lyric Limits:** While the character limit is high (3500), songs over 4 minutes may sometimes experience "hallucinations" in the melody towards the end.
- **Safety Filters:** The model will refuse to generate lyrics containing explicit hate speech or extreme violence, though it is generally permissive for standard artistic expression.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/minimax-music/v2.6)
- [MiniMax API Documentation](https://platform.minimax.io/docs/guides/music-generation)
- [MiniMax Pricing & Release Info](https://www.minimax-music.com/minimax-music-2-6)

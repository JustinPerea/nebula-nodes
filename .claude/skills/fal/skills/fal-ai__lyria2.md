---
name: fal-ai/lyria2
display_name: Lyria 2
category: text-to-audio
creator: Google DeepMind
fal_docs: https://fal.ai/models/fal-ai/lyria2
original_source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/lyria/lyria-002
summary: Google's professional-grade 48kHz music generation model for creating high-fidelity instrumental tracks from text.
---

# Lyria 2

## Overview
- **Slug:** fal-ai/lyria2
- **Category:** Text-to-Audio / Music Generation
- **Creator:** Google DeepMind
- **Best for:** Generating high-fidelity, professional-grade instrumental music and cinematic soundscapes.
- **FAL docs:** [fal-ai/lyria2](https://fal.ai/models/fal-ai/lyria2)
- **Original source:** [Google DeepMind Lyria](https://deepmind.google/models/lyria/) / [Google Cloud Vertex AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/lyria/lyria-002)

## What it does
Lyria 2 is an advanced music generation model developed by Google DeepMind, designed to produce high-fidelity audio tracks (48kHz WAV) from textual descriptions. It excels at maintaining musical consistency, complex instrumentation, and professional production quality across various genres, from orchestral scores to electronic beats. While it is primarily focused on instrumental output in its current API form, it is capable of following intricate prompt instructions including mood, tempo, and arrangement.

## When to use this model
- **Use when:** You need high-quality background music for videos, cinematic scores, or unique loops for music production.
- **Use when:** You require specific control over elements to *exclude* via negative prompting.
- **Don't use when:** You need tracks longer than 30 seconds (fixed duration).
- **Don't use when:** You need vocal/lyric generation (currently limited to instrumental in the FAL.ai implementation).
- **Alternatives:** 
    - **Stable Audio:** Often better for longer, more varied ambient textures.
    - **AudioLDM 2:** A good open-source alternative for simpler sound effects and textures.
    - **Suno/Udio:** Better if your primary goal is full songs with vocals (though these are typically closed platforms).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/lyria2` (sync) / `https://queue.fal.run/fal-ai/lyria2` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | N/A | The text prompt describing the music you want to generate. Includes genre, mood, instruments, and tempo. |
| `negative_prompt` | `string` | `""` | N/A | A description of what to exclude from the generated audio (e.g., "vocals, drums, low quality"). |
| `seed` | `integer` | `null` | Integer | A seed for deterministic generation. Providing the same seed with the same prompt will attempt to produce identical audio. |

### Output
The output is a JSON object containing a reference to the generated audio file.
```json
{
  "audio": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "audio/wav",
    "file_name": "output.wav",
    "file_size": 123456
  }
}
```

### Example request
```json
{
  "prompt": "A lush, ambient soundscape featuring the serene sounds of a flowing river, complemented by the distant chirping of birds, and a gentle, melancholic piano melody that slowly unfolds.",
  "negative_prompt": "vocals, drums, fast tempo",
  "seed": 42
}
```

### Pricing
- **Cost:** $0.10 per 30-second generation ([FAL.ai Pricing](https://fal.ai/models/fal-ai/lyria2)).

## API — via Original Source (BYO-key direct)
Google offers Lyria 2 (model ID `lyria-002`) through **Google Cloud Vertex AI**.
- **Endpoint:** `https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{REGION}/publishers/google/models/lyria-002:predict`
- **Auth Method:** Google Cloud IAM / Service Account Token.
- **Extra Parameters:** 
    - `sample_count`: Allows generating up to 4 samples per request (not currently exposed in FAL's top-level schema).
- **Official Docs:** [Vertex AI Lyria Documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/lyria-music-generation)

## Prompting best practices
1. **Be Descriptive:** Combine multiple categories: **Genre + Mood + Instruments + Tempo + Quality**. (e.g., "90s Boom Bap, gritty, lo-fi piano and heavy kicks, 90 BPM, vinyl crackle").
2. **Structural Cues:** Use terms like "intro," "climax," or "loopable" to guide the 30-second composition.
3. **Quality Keywords:** Include terms like "48kHz," "mastered for film," or "studio recording" to push the model toward higher fidelity.
4. **Avoid Vagueness:** Instead of "good music," use "upbeat funk with a slap bass lead and bright brass stabs."
5. **Negative Prompting:** Crucial for removing unwanted "stock music" feel or unwanted vocals. If the output is too busy, add "percussion" to the negative prompt.

## Parameter tuning guide
- **`prompt`**: The primary driver. For more variety, use broader terms; for specific needs, use technical musical jargon (BPM, key signatures).
- **`negative_prompt`**: Use this to refine the "cleanliness" of the track. If you hear artifacts or unwanted humming, explicitly list them.
- **`seed`**: Essential for iterative editing. If you like the rhythm but want a different instrument, keep the seed and slightly modify the prompt instrumentation.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (String)
    - `Negative Prompt` (String)
    - `Seed` (Number)
- **Outputs:**
    - `Audio URL` (URL)
    - `Audio File` (File object for downstream nodes like Video Renderers)
- **Chain-friendly with:**
    - **fal-ai/flux:** Use the generated music as a soundtrack for AI-generated video workflows.
    - **fal-ai/video-to-video:** Pair with visual generation to create full multimedia clips.
    - **Audio Enhancers:** Chain with nodes that perform volume normalization or EQ.

## Notes & gotchas
- **Fixed Duration:** Generations are exactly 30 seconds. There is no native "extension" parameter in the FAL API; users must manually stitch clips.
- **Instrumental Focus:** While the research model supports vocals, the developer API (`lyria-002`) is strictly instrumental.
- **Watermarking:** All outputs are watermarked with Google's **SynthID** for safety and traceability, which is inaudible but detectable by software ([Google DeepMind](https://deepmind.google/technologies/synthid/)).
- **Safety Filters:** Extremely strict on copyrighted content or "in the style of [Specific Artist]" prompts, which may result in blocked requests or generic outputs.

## Sources
- [FAL.ai Lyria 2 Documentation](https://fal.ai/models/fal-ai/lyria2/api)
- [Google Cloud Vertex AI Lyria-002 Docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/lyria/lyria-002)
- [Google DeepMind Lyria Announcement](https://deepmind.google/blog/music-ai-sandbox-now-with-new-features-and-broader-access/)
- [FAL.ai Pricing Page](https://fal.ai/pricing)

# Veo — Video Generation

Sourced from https://ai.google.dev/gemini-api/docs/video (fetched 2026-04-16). Model list and Nebula routes updated 2026-10-10.

## Model map

| Model ID (Gemini API) | Vertex AI ID | Audio | 4K | Refs | Extension | First/Last Frame | Portrait |
|---|---|---|---|---|---|---|---|
| `veo-3.1-generate-preview` | `veo-3.1-generate-001` (GA) | ✅ | ✅ | up to 3 | ✅ | ✅ | ✅ |
| `veo-3.1-fast-generate-preview` | `veo-3.1-fast-generate-001` (GA) | ✅ | ✅ | up to 3 | ✅ | ✅ | ✅ |
| `veo-3.1-lite-generate-preview` | `veo-3.1-lite-generate-001` (preview, text-to-video only) | ✅ | — | — | — | ✅ (Gemini API) | ✅ |

Pick Veo 3.1 unless you're budgeting (Fast / Lite). Veo 3.0, 3.0 Fast and 2.0 shut down on 2026-06-30. The Gemini API preview ids retire on **2026-10-22**; the Vertex GA ids retire "Nov 17 2026 or later".

## Prompt structure

Required:
1. **Subject** — what's in frame (`cityscape`, `puppies`, `a vintage car`)
2. **Action** — what happens (`walking`, `slowly accelerating`, `turning their head`)
3. **Style** — creative direction (`sci-fi`, `film noir`, `cartoon`, `documentary`)

Strongly recommended:
4. **Camera** — positioning + motion (`dolly`, `tracking drone`, `POV`, `low angle`, `extreme close-up`)
5. **Composition** — framing (`wide shot`, `two-shot`, `medium eye-level`)
6. **Lens / focus** — (`shallow focus`, `85mm`, `macro`, `anamorphic`)
7. **Ambiance** — lighting + color (`warm tones`, `blue hour`, `harsh noon`, `neon`)
8. **Audio** — dialogue in quotes, SFX and ambience in natural language

## Camera vocabulary that works

- **Motion:** dolly, dollies forward, pulls back, tracking shot, pan across, crane up, push in, orbit around
- **Angles:** POV, eye-level, low angle, high angle, top-down, Dutch tilt, over-the-shoulder
- **Framing:** extreme close-up, close-up, medium, medium-wide, wide, establishing shot, two-shot

Example:
> Close-up cinematic shot of melting icicles on a frozen rock wall with cool blue tones, zoomed in maintaining close-up detail.

## Audio prompting

### Dialogue
Quote spoken lines exactly and cue the speaker.

> A man murmurs, "This must be it. That's the secret code."

Add delivery notes in parentheses:
> Woman: (Voice tight with fear) "Then what is it?"

### Sound effects
Be explicit, use concrete verbs:
> tires screeching loudly, engine roaring, a rough bark, snapping twigs, footsteps on damp earth.

### Ambient soundscape
Describe the background:
> A faint, eerie hum resonates in the background. Upbeat electronic music with a rhythmic beat.

### Audio safety gate
**Audio is filtered separately from video.** The video may pass but the audio gets dropped — if a dialogue prompt comes back silent, simplify the dialogue or rephrase SFX. Voice extension only works if a voice is present in the last 1 second of the clip.

Full audio-rich example:
> A wide shot of a misty Pacific Northwest forest. Two exhausted hikers push through ferns when the man stops abruptly. Close-up: fresh, deep claw marks in the bark. Man: "That's no ordinary bear." Woman: (Voice tight with fear) "Then what is it?" A rough bark, snapping twigs, footsteps on the damp earth.

## Technical specs

### Duration
- 4, 6, or 8 seconds
- **8 seconds is required** for: 1080p, 4K, reference images, extension

### Aspect ratio
- `"16:9"` (default)
- `"9:16"`

### Resolution
- `"720p"` (default)
- `"1080p"`
- `"4k"` — Veo 3.1 and 3.1 Fast (not Lite)
- Extension is locked to 720p regardless of original
- 1080p and 4K are locked to 8s

### Frame rate
All Veo: 24fps. No override.

## Image-to-video

```python
operation = client.models.generate_videos(
    model="veo-3.1-generate-preview",
    prompt="Panning wide shot of a calico kitten sleeping on a wooden deck at sunset.",
    image=input_image,
)
```

The image is used as the **starting frame**.

## Reference images (Veo 3.1 main + fast)

> **⚠️ NOT EXPOSED IN NEBULA (verified live 2026-06-08).** Although documented below, the live
> Gemini API rejects reference images ("Your use case is currently not supported") on BOTH
> `veo-3.1-generate-preview` and `veo-3.1-fast-generate-preview` with an AI-Studio `GOOGLE_API_KEY`.
> The `veo-3` node has **no** reference-image port. Don't promise subject/wardrobe consistency via
> Veo refs in Nebula; the section below is upstream-API reference only.

Up to 3 asset references preserve subject appearance across the video.

```python
from google.genai import types

dress_ref = types.VideoGenerationReferenceImage(
    image=dress_image, reference_type="asset",
)
glasses_ref = types.VideoGenerationReferenceImage(
    image=glasses_image, reference_type="asset",
)
woman_ref = types.VideoGenerationReferenceImage(
    image=woman_image, reference_type="asset",
)

operation = client.models.generate_videos(
    model="veo-3.1-generate-preview",
    prompt="A woman wearing the blue dress and round glasses walks through a flower market at golden hour.",
    config=types.GenerateVideosConfig(
        reference_images=[dress_ref, glasses_ref, woman_ref],
    ),
)
```

Use when you need consistent character, product, or wardrobe across shots.

## First/last frame interpolation (Veo 3.1 only)

```python
operation = client.models.generate_videos(
    model="veo-3.1-generate-preview",
    prompt="The sunset deepens as clouds drift across the horizon.",
    image=first_frame,
    config=types.GenerateVideosConfig(last_frame=last_frame),
)
```

Prompt describes the **transition between** the frames.

## Video extension (Veo 3.1 main + fast, not Lite)

Extends by 7 seconds, up to 20 times (140+ seconds total).

```python
operation = client.models.generate_videos(
    model="veo-3.1-generate-preview",
    video=previous_video.video,
    prompt="The man continues walking down the alley, a sudden gust lifts loose paper.",
    config=types.GenerateVideosConfig(resolution="720p"),
)
```

Requirements:
- Input video must be **Veo-generated**
- Must be 720p, 9:16 or 16:9
- Must have been generated or referenced within 2 days
- Extension output is always 720p regardless of original

## Async operation handling

Video generation is async. Poll the operation:

```python
operation = client.models.generate_videos(...)

import time
while not operation.done:
    time.sleep(10)
    operation = client.operations.get(operation)

video = operation.response.generated_videos[0]
client.files.download(file=video.video)
```

Expect 11 seconds minimum, up to 6 minutes during peak. In nebula this is already wrapped — look at `[veo] polling operation …` in backend logs for progress.

## Retention

**Videos are deleted after 2 days on Google's side.** Download immediately. In nebula the handler already saves to `output/<timestamp>/` so this is handled — but don't rely on re-fetching old operations.

## Regional restrictions (EU, UK, CH, MENA)

- Veo 3.1: `personGeneration="allow_adult"` only

## Known limitations

- One video per request
- Extension resets the 2-day clock (extended videos are new, treated fresh)
- Safety filters block audio independently — a silent result doesn't mean the full gen failed
- SynthID watermarking is applied to all outputs

## Nebula-specific notes

- Nodes: `veo-3` (displayed "Veo 3.1"; models Veo 3.1 / 3.1 Fast / 3.1 Lite) and `veo-3-flf` (First-Last Frame). Check `nebula graph` for the exact definition ids.
- **Routes, in order** (checked 2026-10-10):
  1. **Vertex AI** when `GOOGLE_VERTEX_CREDENTIALS` (a Google Cloud service-account JSON key, Settings → "Google Vertex AI (service-account JSON, for Veo)") is set. `us-central1`, project from the key, GA `-001` models; Lite is text-to-video only there. Audio is always on.
  2. **Gemini API** with `GOOGLE_API_KEY` on the preview ids (until 2026-10-22).
  3. **fal** with `FAL_KEY`: `fal-ai/veo3.1` / `fal-ai/veo3.1/fast` (Lite runs as Fast), image-to-video or first-last-frame endpoint when frames are wired. No extension; adds `negative_prompt` and `safety_tolerance`.
  After 2026-10-22, failed Gemini API or fal runs suggest adding a Vertex key. `veo-3-flf` uses Vertex when the key is set, else fal.
- Pair Veo with an `image-input` node to do image-to-video (wire image-input.image → `veo-3`'s First Frame `image` port).
- **Extension:** wire the upstream `veo-3` node's **`source_uri`** output → the downstream `veo-3` node's **`Extend Video`** input. On the Gemini API that's Veo's own `files/...` URI (valid ~2 days); wiring the regular `video` output is rejected. On Vertex, `source_uri` is the saved file of a previous Vertex run (or pass a `gs://` URI); Gemini `files/` URIs are rejected. Veo 3.1 and 3.1 Fast only, output locked to **720p**.
- Nebula backs `/api/graph/run` on this with the Veo handler that polls and downloads — you'll see `[veo] poll #N: done=False` in backend logs. Expect 1–6 minutes per 8s clip.

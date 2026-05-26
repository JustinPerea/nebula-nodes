---
name: fal-ai/video-understanding
display_name: Video Understanding
category: vision
creator: Alibaba Cloud (Qwen2-VL)
fal_docs: https://fal.ai/models/fal-ai/video-understanding
original_source: https://qwenlm.github.io/blog/qwen2-vl/
summary: Analyze video content and answer descriptive questions or provide summaries using advanced vision-language processing.
---

# Video Understanding

## Overview
- **Slug:** `fal-ai/video-understanding`
- **Category:** Vision / Video-to-Text
- **Creator:** [Alibaba Cloud (Qwen Team)](https://qwenlm.github.io/blog/qwen2-vl/)
- **Best for:** Answering specific questions about events, objects, or actions within a video.
- **FAL docs:** [fal.ai/models/fal-ai/video-understanding](https://fal.ai/models/fal-ai/video-understanding)
- **Original source:** [Qwen2-VL GitHub](https://github.com/QwenLM/Qwen2-VL)

## What it does
The `fal-ai/video-understanding` model (based on [Qwen2-VL](https://qwenlm.github.io/blog/qwen2-vl/)) is a multimodal vision-language model capable of "watching" video files and reasoning about their content. It can identify objects, describe complex human interactions, summarize scenes, and answer specific natural language questions based on visual evidence ([fal.ai Documentation](https://fal.ai/models/fal-ai/video-understanding)). Unlike simple frame-extraction methods, it leverages [Multimodal Rotary Position Embedding (M-RoPE)](https://arxiv.org/html/2409.12191v1) to maintain temporal coherence over long durations ([Qwen Research](https://arxiv.org/html/2409.12191v1)).

## When to use this model
- **Use when:** You need to automate video captioning, perform visual search within video archives, or extract metadata from security/dashcam footage ([SiliconANGLE](https://siliconangle.com/2024/08/30/alibaba-announces-qwen2-vl-ai-model-advanced-video-analysis-reasoning-capabilities/)).
- **Don't use when:** You need audio-based reasoning (it does not "hear" the video), or for real-time live streaming analysis with sub-second latency ([Qwen Limitations](https://qwenlm.github.io/blog/qwen2-vl/)).
- **Alternatives:**
    - **fal-ai/any-llm/vision:** Better for single-frame analysis or complex document OCR within a single video frame.
    - **Google Gemini 1.5 Pro:** Better for extremely long videos (up to 1 hour) with higher context windows, though often at higher cost ([Google AI](https://ai.google.dev/gemini-api/docs/video-understanding)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/video-understanding` (sync) / `https://queue.fal.run/fal-ai/video-understanding` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `video_url` | `string` | *Required* | Public URL | The URL of the video file to analyze. Supports `mp4`, `mov`, `webm`, `m4v`, `gif` ([fal.ai API](https://fal.ai/models/fal-ai/video-understanding/api)). |
| `prompt` | `string` | *Required* | 1-5000 chars | The question or instruction (e.g., "What is the person in the red shirt doing?") ([fal.ai Schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/video-understanding)). |
| `detailed_analysis` | `boolean` | `false` | `true`, `false` | Whether to request a more thorough, exhaustive description of the video content ([fal.ai API](https://fal.ai/models/fal-ai/video-understanding/api)). |

### Output
The model returns a JSON object containing a single text field:
```json
{
  "output": "The video shows a group of hikers walking up a steep mountain path during sunset..."
}
```

### Example request
```json
{
  "video_url": "https://example.com/sample_video.mp4",
  "prompt": "Summarize the key events in this video.",
  "detailed_analysis": true
}
```

### Pricing
Billed at **$0.01 per 5 seconds** of processed video ([fal.ai Pricing](https://fal.ai/models/fal-ai/video-understanding)). You are only charged for successful outputs.

## API — via Original Source (BYO-key direct)
The underlying architecture is [Qwen2-VL](https://qwenlm.github.io/blog/qwen2-vl/), developed by Alibaba Cloud.
- **Native API:** Available via [Alibaba Cloud Model Studio (DashScope)](https://www.alibabacloud.com/help/en/model-studio/vision).
- **Endpoint:** `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- **Extra Parameters:** Native API supports `fps_custom` and `max_pixels` to control performance vs. cost trade-offs ([Alibaba Docs](https://www.alibabacloud.com/help/en/model-studio/vision)).
- **Auth:** Requires an Alibaba Cloud API Key.

## Prompting best practices
- **Be Specific:** Instead of "What happens?", ask "Who is the main actor and what objects do they interact with?" ([fal.ai Community](https://github.com/fal-ai-community/video-starter-kit)).
- **Temporal References:** Use prompts like "What happens at the beginning vs the end?" to leverage the model's temporal reasoning ([Qwen Research](https://arxiv.org/html/2409.12191v1)).
- **Avoid Ambiguity:** Reference specific colors or locations (e.g., "the car in the background") to avoid confusion in crowded scenes ([Practical DevSecOps](https://www.practical-devsecops.com/glossary/safety-filtering/)).
- **Failure Mode:** Broad prompts on very long videos may result in generic summaries. If detail is needed, use the `detailed_analysis: true` flag.

## Parameter tuning guide
- **`detailed_analysis`:** Toggle this on for surveillance or forensic tasks where every micro-action matters. Keep it off for quick captioning to save on processing latency ([fal.ai API](https://fal.ai/models/fal-ai/video-understanding/api)).
- **`prompt` engineering:** Use "Step-by-step description" to force the model into a chain-of-thought visual reasoning mode, which often yields more accurate results for complex interactions ([Qwen2-VL Blog](https://qwenlm.github.io/blog/qwen2-vl/)).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Video URL` (File/String)
    - `Prompt` (String)
    - `Detailed Analysis` (Boolean)
- **Outputs:**
    - `Analysis Text` (String)
- **Chain-friendly with:**
    - **fal-ai/any-llm:** Pass the analysis text to an LLM to generate social media posts or structured JSON metadata.
    - **fal-ai/elevenlabs:** Use the text output to generate a voiceover for the video based on the AI's description ([fal-ai Video Starter Kit](https://github.com/fal-ai-community/video-starter-kit)).

## Notes & gotchas
- **No Audio:** The model is purely visual. It cannot transcribe speech or identify sounds ([Alibaba Cloud](https://siliconangle.com/2024/08/30/alibaba-announces-qwen2-vl-ai-model-advanced-video-analysis-reasoning-capabilities/)).
- **Rate Limits:** FAL.ai enforced concurrency limits apply; for bulk processing, use the `/queue` endpoint ([fal.ai Queue Documentation](https://docs.fal.ai/model-endpoints/queue)).
- **File Access:** The video URL must be publicly accessible or a Base64 URI. Private cloud storage (S3/GCS) requires signed URLs ([fal.ai API](https://fal.ai/models/fal-ai/video-understanding/api)).

## Sources
- [FAL.ai Video Understanding Documentation](https://fal.ai/models/fal-ai/video-understanding)
- [Qwen2-VL Official Blog](https://qwenlm.github.io/blog/qwen2-vl/)
- [Qwen2-VL Technical Report (arXiv)](https://arxiv.org/html/2409.12191v1)
- [FAL.ai Pricing Page](https://fal.ai/pricing)

---
name: fal-ai/moondream3-preview/query
display_name: Moondream 3 Preview [Query]
category: vision
creator: M87 Labs / Moondream AI
fal_docs: https://fal.ai/models/fal-ai/moondream3-preview/query
original_source: https://huggingface.co/moondream/moondream3-preview
summary: A state-of-the-art vision language model with mixture-of-experts architecture for visual reasoning, object detection, and OCR.
---

# Moondream 3 Preview [Query]

## Overview
- **Slug:** `fal-ai/moondream3-preview/query`
- **Category:** Vision (Visual Question Answering / Visual Reasoning)
- **Creator:** [M87 Labs / Moondream AI](https://moondream.ai/)
- **Best for:** Frontier-level visual reasoning, object detection, and OCR at scale.
- **FAL docs:** [fal.ai/models/fal-ai/moondream3-preview/query](https://fal.ai/models/fal-ai/moondream3-preview/query)
- **Original source:** [Hugging Face Model Card](https://huggingface.co/moondream/moondream3-preview)

## What it does
Moondream 3 is a vision language model (VLM) utilizing a Sparse Mixture-of-Experts (MoE) architecture with 9 billion total parameters (2 billion active). It provides state-of-the-art visual reasoning capabilities, including native object detection, pointing, and OCR. It is designed to be highly efficient, offering fast and inexpensive inference while maintaining frontier-level performance in complex visual tasks.

## When to use this model
- **Use when:** You need high-accuracy visual question answering, complex scene reasoning, or detailed OCR with structure preservation.
- **Don't use when:** You require video-to-text capabilities (this version is image-only) or ultra-low latency that only a sub-1B parameter model can provide.
- **Alternatives:** 
    - **Moondream 2:** A smaller, dense 2B parameter model for simpler tasks or edge deployment.
    - **Qwen-VL:** Another powerful VLM available on FAL, though with different architecture and performance trade-offs.
    - **LLaVA:** A popular open-source VLM often used for general image description.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/moondream3-preview/query` (sync) / `https://queue.fal.run/fal-ai/moondream3-preview/query` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | `string` | *Required* | N/A | URL of the image to be processed. |
| `prompt` | `string` | *Required* | N/A | Query or instruction to be asked about the image. |
| `reasoning` | `boolean` | `true` | `true`, `false` | Whether to include detailed reasoning behind the answer. |
| `temperature` | `float` | `0` | `0` to `1` | Sampling temperature; higher values make output more random. |
| `top_p` | `float` | `1.0` | `0` to `1` | Nucleus sampling probability mass. |

### Output
The output returns a JSON object containing:
- `output`: The primary answer to the query.
- `reasoning`: (Optional) Detailed thought process if `reasoning` was enabled.
- `finish_reason`: The reason generation stopped (e.g., "stop").
- `usage_info`: Detailed performance metrics including `input_tokens`, `output_tokens`, `prefill_time_ms`, and `decode_time_ms`.

### Example request
```json
{
  "image_url": "https://storage.googleapis.com/falserverless/example_inputs/moondream_worker.jpg",
  "prompt": "List the safety measures taken by this worker in a JSON array under 'safety_measures' key",
  "reasoning": true
}
```

### Pricing
- **Input Tokens:** $0.4 per million tokens.
- **Output Tokens:** $3.5 per million tokens.
*(Source: [FAL Playground](https://fal.ai/models/fal-ai/moondream3-preview/query/playground))*

## API — via Original Source (BYO-key direct)
The model can be run locally using the `transformers` library or via the Moondream Cloud API. 
- **Endpoint:** [api.moondream.ai](https://moondream.ai/cloud)
- **Auth Method:** API Key from moondream.ai.
- **Extra Parameters:** The native SDK (via `moondream` Python package) supports specific methods like `model.caption()`, `model.point()`, and `model.detect()`.
- **Docs:** [docs.moondream.ai](https://docs.moondream.ai)

## Prompting best practices
- **Be Specific:** Instead of "What is in the image?", use "Count the number of red apples on the wooden table."
- **Leverage Grounding:** Ask the model to "point to" or "detect" objects to get coordinates (normalized 0-1).
- **Structured Output:** Ask for JSON specifically (as shown in the example) to integrate easily into workflows.
- **Reasoning Toggle:** Enable `reasoning: true` for complex logical tasks to improve accuracy through "Chain of Thought" processing.
- **Failure Mode:** Avoid extremely vague prompts or asking about temporal events in still images.

## Parameter tuning guide
- **Reasoning:** Turn this **ON** for accuracy-critical tasks. It allows the model to "think" before answering, which is a hallmark of the Moondream 3 MoE architecture.
- **Temperature:** Set to `0` for deterministic, factual queries. Increase toward `0.8` for creative image descriptions.
- **Top P:** Usually left at `1.0`. Lowering it can help prune low-probability tokens if the output becomes nonsensical.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:** 
    - `Image` (File or URL)
    - `Prompt` (Text)
    - `Reasoning Toggle` (Boolean)
- **Outputs:** 
    - `Answer` (Text)
    - `Reasoning Path` (Text)
    - `Usage Stats` (Object)
- **Chain-friendly with:** 
    - **Flux 2:** Use Moondream to describe an image, then Flux to regenerate it with modifications.
    - **Stable Diffusion:** Use as a precise captioner for creating LoRA training datasets.
    - **Post-processing LLM:** Feed the structured output into a model like GPT-4o or Claude for further business logic processing.

## Notes & gotchas
- **Preview Status:** As a "preview" model, the architecture and performance may receive updates.
- **VRAM Requirements:** For local inference, the 9B model requires significantly more VRAM (24GB+) than the 2B version unless quantized.
- **Context Window:** Features a massive 32k context window, allowing for many-shot visual prompting.

## Sources
- [FAL.ai Moondream 3 Documentation](https://fal.ai/models/fal-ai/moondream3-preview/query/api)
- [Official Moondream 3 Release Blog](https://moondream.ai/blog/moondream-3-preview)
- [Hugging Face Model Card](https://huggingface.co/moondream/moondream3-preview)
- [Moondream Technical Docs](https://docs.moondream.ai)

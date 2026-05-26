---
name: openrouter/router
display_name: OpenRouter Router
category: llm
creator: OpenRouter
fal_docs: https://fal.ai/models/openrouter/router
original_source: https://openrouter.ai/docs
summary: A unified API gateway providing access to 300+ LLMs from OpenAI, Anthropic, Google, and more with intelligent routing and fallbacks.
---

# OpenRouter Router

## Overview
- **Slug:** `openrouter/router`
- **Category:** LLM (Large Language Model) / Text Generation
- **Creator:** [OpenRouter](https://openrouter.ai)
- **Best for:** Accessing any major LLM (Claude, GPT, Gemini, Llama) through a single, unified API interface.
- **FAL docs:** [fal.ai/models/openrouter/router](https://fal.ai/models/openrouter/router)
- **Original source:** [openrouter.ai/docs](https://openrouter.ai/docs)

## What it does
The **OpenRouter Router** on FAL.ai is a powerful meta-model that acts as a gateway to over 300 different Large Language Models ([FAL.ai](https://fal.ai/models/openrouter/router)). Instead of integrating separate APIs for OpenAI, Anthropic, Google, and Meta, developers can use this single endpoint to swap between models like `gpt-4o`, `claude-3.5-sonnet`, or `gemini-1.5-pro` simply by changing a string parameter ([OpenRouter](https://openrouter.ai/docs/guides/overview/models)). It supports advanced features like reasoning tokens, structured output, and streaming, making it a "Swiss Army knife" for text-based AI workflows.

## When to use this model
- **Use when:** You need to compare multiple models for the same task, require a fallback if a specific provider (like OpenAI) is down, or want to use frontier models like Claude 3.5 without managing multiple billing accounts ([Codecademy](https://www.codecademy.com/article/what-is-openrouter)).
- **Don't use when:** You require extremely low-latency, hardware-level control, or are using a model that isn't yet supported by OpenRouter's aggregation layer.
- **Alternatives:**
    - **fal-ai/any-llm:** A similar routing service on FAL for general LLM access.
    - **Direct Provider APIs:** Use `openai/gpt-4o` directly on FAL if you only ever need OpenAI and want to minimize routing overhead.

## API — via FAL.ai
**Endpoint:** `https://fal.run/openrouter/router` (sync) / `https://queue.fal.run/openrouter/router` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The main prompt for the chat completion. |
| `system_prompt`| string | Optional | N/A | Context or instructions to guide the model's behavior. |
| `model` | string | *Required* | [Model List](https://openrouter.ai/models) | The identifier for the model to use (e.g., `google/gemini-2.5-flash`). |
| `reasoning` | boolean | `false` | `true`, `false` | Whether to include a separate `reasoning` field in the response. |
| `temperature` | float | `1.0` | `0.0` to `2.0` | Controls randomness. Lower is more deterministic. |
| `max_tokens` | integer | Optional | 1+ | Limits the length of the generated response. |

### Output
The output is a JSON object containing the generated text, usage statistics, and optional reasoning tokens.
```json
{
  "output": "The generated response text...",
  "reasoning": "Optional chain-of-thought text...",
  "partial": false,
  "usage": {
    "prompt_tokens": 40,
    "completion_tokens": 227,
    "total_tokens": 267,
    "cost": 0.0005795
  }
}
```

### Example request
```json
{
  "input": {
    "prompt": "Explain quantum entanglement to a five-year-old.",
    "model": "anthropic/claude-3.5-sonnet",
    "temperature": 0.7,
    "reasoning": true
  }
}
```

### Pricing
FAL.ai passes through token-based pricing from OpenRouter. You are charged based on the actual number of input and output tokens used per request ([FAL.ai Pricing](https://fal.ai/pricing)). Prices vary significantly by model:
- **High-end:** `anthropic/claude-3-opus` or `openai/gpt-4o`.
- **Budget:** `google/gemini-1.5-flash` or `meta-llama/llama-3.1-8b`.
- **Free:** Dozens of models are available at $0/token with rate limits ([OpenRouter Pricing](https://openrouter.ai/pricing)).

## API — via Original Source (BYO-key direct)
OpenRouter provides a native, OpenAI-compatible API that offers significantly more parameters than the simplified FAL wrapper.
- **Native Endpoint:** `https://openrouter.ai/api/v1/chat/completions`
- **Extra Parameters:** `top_p`, `top_k`, `presence_penalty`, `frequency_penalty`, `repetition_penalty`, `seed`, `tools` (for function calling), `tool_choice`, `response_format` (for JSON mode), and `plugins` ([OpenRouter API Reference](https://openrouter.ai/docs/api/reference/overview)).
- **Auth Method:** Bearer token (`Authorization: Bearer <OPENROUTER_API_KEY>`).
- **Official Docs:** [openrouter.ai/docs](https://openrouter.ai/docs)

## Prompting best practices
- **Be Model-Specific:** While the API is unified, models have different strengths. Claude prefers XML-style tags, while GPT-4 is more responsive to system instructions.
- **Use System Prompts:** Always define the persona and constraints in the `system_prompt` field rather than mixing them into the user `prompt`.
- **Structure Your Output:** For reliable data extraction, use models that support "Structured Output" (like GPT-4o) and ask for JSON in the prompt.
- **Failure Mode:** If a model returns "Refusal," it is often due to the provider's safety filters (e.g., Anthropic is stricter than Llama).
- **Good Prompt:** `System: You are a senior Python dev. User: Refactor this function into a class.`
- **Bad Prompt:** `Write code. Also make it fast.` (Too vague for routing to different specialized models).

## Parameter tuning guide
- **`temperature`:** Set to `0.0` for code generation or factual extraction. Set to `0.8+` for creative writing.
- **`reasoning`:** Enable this for complex logic or math problems. Models like `deepseek-r1` or `o1` will provide their "inner monologue," which helps in debugging logic errors.
- **`max_tokens`:** Always set a limit when using expensive models to prevent "runaway" generations that could spike your bill.
- **`model` Selection:** Use `google/gemini-1.5-flash` for high-speed, high-volume tasks and `anthropic/claude-3.5-sonnet` for top-tier reasoning and coding.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `System Prompt` (Text)
    - `Model ID` (Dropdown/Text)
    - `Temperature` (Slider: 0-2)
    - `Max Tokens` (Number)
    - `Enable Reasoning` (Switch)
- **Outputs:**
    - `Response Text` (Text)
    - `Reasoning Text` (Text)
    - `Total Cost` (Number)
    - `Token Usage` (Object)
- **Chain-friendly with:**
    - **fal-ai/flux:** Use the Router to generate high-quality image prompts for Flux.
    - **fal-ai/esrgan:** Use the Router to describe an image, generate it with Flux, then upscale with ESRGAN.

## Notes & gotchas
- **Model Availability:** Not every model supports `reasoning` or high `temperature` values; check the [OpenRouter Model List](https://openrouter.ai/models) for specific constraints.
- **Rate Limits:** Free models on OpenRouter are heavily rate-limited (often 20 RPM).
- **Latency:** Because OpenRouter is a routing layer, there is a small overhead (~25-50ms) compared to calling a provider like OpenAI directly ([Codecademy](https://www.codecademy.com/article/what-is-openrouter)).
- **Context Windows:** Be mindful of the `context_length`. If your prompt is too long, the model will return an error or truncate the input.

## Sources
- [FAL.ai OpenRouter Router Documentation](https://fal.ai/models/openrouter/router)
- [OpenRouter Official API Reference](https://openrouter.ai/docs/api/reference/overview)
- [OpenRouter Pricing and Model Catalog](https://openrouter.ai/pricing)
- [Codecademy: What is OpenRouter?](https://www.codecademy.com/article/what-is-openrouter)

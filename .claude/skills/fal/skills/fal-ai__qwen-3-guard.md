---
name: fal-ai/qwen-3-guard
display_name: Qwen 3 Guard [8B]
category: llm
creator: Alibaba Cloud (Qwen Team)
fal_docs: https://fal.ai/models/fal-ai/qwen-3-guard
original_source: https://github.com/QwenLM/Qwen3Guard
summary: A high-performance multilingual safety guardrail model for detecting harmful content across 119 languages.
---

# Qwen 3 Guard [8B]

## Overview
- **Slug:** fal-ai/qwen-3-guard
- **Category:** Large Language Models / Safety & Moderation
- **Creator:** [Alibaba Cloud (Qwen Team)](https://qwenlm.github.io)
- **Best for:** Multilingual text safety classification and content moderation.
- **FAL docs:** [fal.ai/models/fal-ai/qwen-3-guard](https://fal.ai/models/fal-ai/qwen-3-guard)
- **Original source:** [GitHub Repository](https://github.com/QwenLM/Qwen3Guard), [Hugging Face Model Card](https://huggingface.co/Qwen/Qwen3Guard-Gen-8B)

## What it does
Qwen 3 Guard [8B] is a specialized safety moderation model built on the Qwen3 architecture. It is designed to evaluate text (prompts or responses) and classify them into three categories: **Safe**, **Unsafe**, or **Controversial**. Unlike binary classifiers, it provides nuanced feedback by identifying specific risk categories like violence, sexual content, and PII. It supports 119 languages and dialects, making it one of the most robust multilingual guardrail models available.

## When to use this model
- **Use when:** You need to moderate user inputs or LLM outputs for safety, especially in multilingual applications. It is ideal for pre-filtering prompts before sending them to a generation model or post-filtering generated responses.
- **Don't use when:** You need real-time, token-level streaming moderation (use a "Stream" variant if available) or when you require creative text generation (this is a classification model).
- **Alternatives:** 
  - **Llama Guard:** A similar moderation model by Meta, often optimized for English.
  - **fal-ai/qwen-3-8b-instruct:** Use this for the actual chat/task, then use Qwen 3 Guard to verify its output.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/qwen-3-guard` (sync) / `https://queue.fal.run/fal-ai/qwen-3-guard` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The input text to be classified (e.g., a user prompt or an AI-generated response). |

### Output
The output is a JSON object indicating the safety status of the input.

| Field | Type | Description |
|---|---|---|
| `label` | string | The primary classification: `Safe`, `Unsafe`, or `Controversial`. |
| `categories` | list<string> | A list of identified risk categories (e.g., `Violent`, `Sexual Content`, `PII`, `Jailbreak`). *Note: FAL documentation mentions this as a "confidence score" in text, but the schema and examples confirm it returns category names.* |

### Example request
```json
{
  "prompt": "How to make a bomb"
}
```

### Pricing
- **Cost:** $0.002 per 1,000 tokens. [FAL.ai Pricing](https://fal.ai/models/fal-ai/qwen-3-guard)

## API — via Original Source (BYO-key direct)
The original model is open-source and can be self-hosted using frameworks like **vLLM** or **SGLang**. It supports an OpenAI-compatible API format when served.
- **Endpoint:** User-defined (e.g., `http://localhost:8000/v1/chat/completions`)
- **Auth:** Depends on the hosting provider (e.g., API key if using a managed service like Together or Groq, if they carry it).
- **Official Docs:** [QwenLM GitHub](https://github.com/QwenLM/Qwen3Guard)

## Prompting best practices
1. **Include Role Context:** When moderating a response, provide both the user's prompt and the assistant's response to help the model understand context.
   - *Example:* `User: [Prompt] Assistant: [Response]`
2. **Standard Formatting:** Use consistent separators (like newlines) between different parts of the conversation.
3. **Be Specific:** If you are testing for a specific vulnerability (like jailbreaking), ensure the full "attack" text is included.
4. **Failure Mode:** The model may struggle with extremely subtle sarcasm or very long, complex prompts that exceed its effective context window (though it supports up to 128k tokens).

## Parameter tuning guide
FAL.ai provides a simplified interface for this model with only the `prompt` parameter. For self-hosted versions:
- **Temperature:** Should be set to `0` or very low for deterministic classification.
- **Max New Tokens:** Keep low (e.g., 128) as the output labels are typically short.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Text Input` (Maps to `prompt`)
- **Outputs:**
  - `Safety Label` (String: Safe, Unsafe, Controversial)
  - `Risk Categories` (List: e.g., ["Violent"])
- **Chain-friendly with:**
  - **Pre-generation:** Chain user input through Qwen 3 Guard before passing to `fal-ai/flux-1-dev` or `fal-ai/qwen-3-8b-instruct`.
  - **Post-generation:** Chain the output of an LLM through Qwen 3 Guard to ensure the response adheres to safety guidelines before displaying it to the user.

## Notes & gotchas
- **Streaming:** The "Gen" variant (hosted on FAL) does not support streaming as it requires the full context to perform a single-pass classification.
- **Discrepancy:** FAL's UI text labels the `categories` field as "confidence score," but the actual output format contains category strings.
- **Multilingualism:** The model is exceptionally strong in Chinese and English but supports 117 other languages.

## Sources
- [FAL.ai Qwen 3 Guard Documentation](https://fal.ai/models/fal-ai/qwen-3-guard/api)
- [Qwen3Guard Technical Report (arXiv)](https://arxiv.org/abs/2510.14276)
- [Qwen Official GitHub](https://github.com/QwenLM/Qwen3Guard)
- [Hugging Face Model Card](https://huggingface.co/Qwen/Qwen3Guard-Gen-8B)

# Gemini Text Models — Prompting, Structured Output, Thinking

Sourced from `/gemini-api/docs/prompting-strategies`, `/gemini-api/docs/structured-output`, `/gemini-api/docs/thinking` (fetched 2026-04-16).

## Model map (text)

| Model ID | Role |
|---|---|
| `gemini-3.1-pro-preview` | Advanced reasoning, agentic, hardest problems |
| `gemini-3-flash-preview` | Frontier cost/performance for everyday use |
| `gemini-3.1-flash-lite-preview` | Highest throughput, lowest cost |
| `gemini-2.5-pro` | Previous-gen deep reasoning |
| `gemini-2.5-flash` | Previous-gen everyday |
| `gemini-2.5-flash-lite` | Previous-gen budget |

Gemini 3 is the current primary tier. Gemini 2.5 remains supported.

## Core prompt structure

Four ingredients, in rough order of impact:
1. **Instructions** — what to do, explicit constraints
2. **Context** — background, user data, reference material
3. **Examples** — few-shot demonstrations of desired output
4. **Response format** — table, bulleted list, single sentence, JSON, etc.

### Structured prompting (especially for Gemini 3)

Use XML tags or Markdown headings so the model can parse sections:

```xml
<role>You are a senior solution architect.</role>
<constraints>
- No external libraries.
- Reply in a single code block.
</constraints>
<context>
<!-- paste user data here -->
</context>
<task>
<!-- specific request -->
</task>
```

Or Markdown:
```markdown
# Identity
You are a senior solution architect.

# Constraints
- No external libraries allowed.

# Output format
Return a single code block.
```

### Long-context rule

**Put bulk context first, put the question last.** When you're feeding a document/codebase/long transcript, the model responds better if the actual instruction is at the end rather than buried above the data.

## Few-shot over zero-shot

> We recommend to always include few-shot examples in your prompts. Prompts without few-shot examples are likely to be less effective.

Few-shot is especially useful for:
- Output formatting (indentation, delimiters, capitalization)
- Tone and style
- Scope boundaries ("here's what to include/exclude")

Consistency matters — keep XML tags, whitespace, newlines, and separators identical across all examples. Inconsistent examples hurt more than help.

## Role / persona

Put persona in system instructions, not in the user message:
```
system: You are a precise, analytical assistant. Cite sources.
user: [the actual task]
```

For Gemini 3 the docs recommend putting **essential behavioral constraints, role definitions, and output format requirements** in the system instruction rather than the user turn.

## Temperature — don't lower it on Gemini 3

> We strongly recommend keeping the `temperature` at its default value of 1.0.
> Changing the temperature (setting it below 1.0) may lead to unexpected behavior, such as looping or degraded performance.

This is Gemini-specific and counterintuitive if you're used to OpenAI. Keep temperature at 1.0 for Gemini 3. If you need determinism, use structured output + schemas instead of low temperature.

## Gemini 3 output verbosity

Gemini 3 defaults to direct, efficient answers. If you want conversational or expanded responses, **ask for them explicitly**:
> Provide a detailed, conversational explanation, not just the answer.

## Knowledge cutoff + current time

Gemini 3 Flash's knowledge cutoff is January 2025. If your prompt depends on current time, tell it:
```
For time-sensitive queries requiring up-to-date information, use the provided current date.
Today is 2026-04-16.
```

And if you need grounding to real-time data:
```python
config = types.GenerateContentConfig(
    tools=[{"google_search": {}}],
)
```

## Grounded-only behavior

When using tool context/RAG and you don't want the model to wander:
```
You are a strictly grounded assistant limited to the information provided in the User Context.
In your answers, rely only on the facts that are directly mentioned in that context.
If the answer is not in the context, reply "I don't have that information."
```

## Iteration strategies when output is wrong

1. **Rephrase the same instruction** — different words, same meaning
2. **Switch the task shape** — classification → multiple choice, extraction → fill-in-the-blank
3. **Reorder** — `[examples][context][input]` vs `[input][examples][context]`
4. **Raise temperature slightly** if you get the "I can't help with that" fallback
5. **Add tools** (Search, Code Execution) instead of relying on the model's memory

## Structured output (JSON mode)

Use this **instead of** prompt-engineering JSON. It's more reliable.

```python
from google import genai
from pydantic import BaseModel, Field
from typing import List, Optional

class Ingredient(BaseModel):
    name: str = Field(description="Name of the ingredient.")
    quantity: str

class Recipe(BaseModel):
    recipe_name: str
    prep_time_minutes: Optional[int]
    ingredients: List[Ingredient]
    instructions: List[str]

client = genai.Client()
response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents=prompt,
    config={
        "response_mime_type": "application/json",
        "response_json_schema": Recipe.model_json_schema(),
    },
)
recipe = Recipe.model_validate_json(response.text)
```

### Supported schema features
- Types: `string`, `number`, `integer`, `boolean`, `object`, `array`, `null` (use `{"type": ["string", "null"]}`)
- String: `enum`, `format` (`date-time`, `date`, `time`)
- Number/integer: `enum`, `minimum`, `maximum`
- Array: `items`, `prefixItems`, `minItems`, `maxItems`
- Object: `properties`, `required`, `additionalProperties`
- Descriptive: `title`, `description` (feed these — they guide generation)

### Limitations
- **No regex / `pattern`** support
- Very deep or very wide schemas may be rejected — simplify
- Gemini 2.0 models require explicit `propertyOrdering`; Gemini 2.5+/3.x do not
- Unsupported schema properties are silently ignored

### What schema mode guarantees
- ✅ Syntactically valid JSON matching your structure
- ✅ Types match the schema
- ❌ Values are semantically correct
- ❌ Factual accuracy or business-rule enforcement beyond types

**Always validate in application code.** Schema conformance ≠ semantic correctness.

### Streaming structured output
Chunks arrive as valid partial JSON; concatenate for the full result.

```python
stream = client.models.generate_content_stream(
    model="gemini-3-flash-preview",
    contents=prompt,
    config={
        "response_mime_type": "application/json",
        "response_json_schema": Recipe.model_json_schema(),
    },
)
for chunk in stream:
    print(chunk.candidates[0].content.parts[0].text)
```

### Structured output + tools

Combine with Search, URL Context, Code Execution, File Search, Function Calling in one call:
```python
config={
    "tools": [{"google_search": {}}, {"url_context": {}}],
    "response_mime_type": "application/json",
    "response_json_schema": MatchResult.model_json_schema(),
}
```

### Structured output vs function calling

| Use this for | Structured Output | Function Calling |
|---|---|---|
| Format the final response | ✅ | |
| Extract data into known shape | ✅ | |
| Trigger an external action | | ✅ |
| Let the model choose which tool | | ✅ |

Both use JSON schemas; different workflow stages.

## Thinking mode

Thinking is internal reasoning the model does before answering. It improves quality on complex tasks at the cost of latency + tokens (you're billed for thought tokens even if you don't see them).

### Gemini 3: `thinking_level`

| Level | Use for |
|---|---|
| `minimal` | Fact retrieval, classification, chat |
| `low` | Light structured reasoning |
| `medium` | Most standard tasks (default) |
| `high` | Math, complex coding, multi-step planning |

```python
config = types.GenerateContentConfig(
    thinking_config=types.ThinkingConfig(thinking_level="low"),
)
```

### Gemini 2.5: `thinking_budget` (token count)

| Model | Default | Range | `0` (disable) | `-1` (dynamic) |
|---|---|---|---|---|
| 2.5 Pro | dynamic | 128–32768 | not allowed | ✅ |
| 2.5 Flash | dynamic | 0–24576 | ✅ | ✅ |
| 2.5 Flash Lite | no thinking | 512–24576 | ✅ | ✅ |

```python
config = types.GenerateContentConfig(
    thinking_config=types.ThinkingConfig(thinking_budget=1024),  # 0 to disable, -1 for dynamic
)
```

### When to adjust
- **Disable / minimal:** classification, fact lookup, chat, anything under ~50 tokens of real reasoning work
- **Default / medium:** comparisons, analogies, standard Q&A
- **High / large budget:** AIME-style math, multi-file coding, long planning chains

### Thought summaries (`include_thoughts`)

Useful for debugging — see why the model gave a particular answer.

```python
config = types.GenerateContentConfig(
    thinking_config=types.ThinkingConfig(include_thoughts=True),
)
response = client.models.generate_content(...)

for part in response.candidates[0].content.parts:
    if not part.text:
        continue
    if part.thought:
        print("Thought summary:", part.text)
    else:
        print("Answer:", part.text)
```

Streaming gives rolling summaries during generation; non-streaming gives one final summary at the end.

### Token accounting

```python
print("thought tokens:", response.usage_metadata.thoughts_token_count)
print("output tokens:", response.usage_metadata.candidates_token_count)
```

Billed = thought tokens + output tokens.

### Multi-turn thought signatures (Gemini 3)

Pass the entire response back in conversation history, including signatures. Don't:
- Concatenate parts with signatures into a single string
- Merge parts with and without signatures
- Strip signatures from prior turns before the next call

The official SDKs handle this automatically in chat mode.

## Common pitfalls

- **Lowering temperature on Gemini 3** — causes loops / degraded responses. Keep at 1.0.
- **Relying on the model's current-date knowledge** — give it the date explicitly or use search grounding.
- **Expecting semantic correctness from structured output** — it's syntactic only; validate values yourself.
- **Inconsistent few-shot examples** — whitespace, tags, and format must match across all examples.
- **Unused thinking on cheap tasks** — you're paying for thought tokens even on `minimal`. Explicitly disable on 2.5 Flash/Lite if you don't need it.
- **Long context with the instruction at the top** — Gemini 3 works better with instruction last.

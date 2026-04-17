---
name: gemini
description: Best practices for prompting Google's Gemini-family APIs — Gemini text models, Imagen, Nano Banana (Gemini 3.1 Flash Image), and Veo video. Activate when writing prompts, building graphs, or configuring nodes that target any Gemini model, when editing files importing `google-genai` / `@google/genai`, or when the user asks about Imagen, Nano Banana, or Veo. Routes to topic files for deep guidance. Sourced from ai.google.dev with fetch dates noted — verify against the live docs for anything that smells stale.
---

# Gemini Skill

## When to use

- The user asks for image, video, or text generation and the graph is using (or could use) a Google node: `imagen-*`, `gemini-*-image-*`, `nano-banana*`, `veo-*`, or `gemini-2.5/3.1-*` text models.
- Editing nodes or handlers that call the Google AI SDK (`google-genai`, `@google/genai`) or hit `generativelanguage.googleapis.com`.
- Explicit `/skill gemini` or user question about "which Gemini/Imagen/Veo/Nano Banana model should I use?"

## Picking a model — quick decision table

| Need | Model | Why |
|---|---|---|
| Fast, iterative image gen; high volume | `gemini-3.1-flash-image-preview` (Nano Banana 2) | Speed + 512/1K/2K/4K + image search grounding |
| Studio asset, precise text in image, complex layout | `gemini-3-pro-image-preview` (Nano Banana Pro) | Reasoning + high-fidelity text rendering |
| Simple, cheapest image gen | `gemini-2.5-flash-image` (Nano Banana) | Lowest latency |
| Text-to-image where Nano Banana isn't enough | `imagen-4` | Up to 2K, dedicated T2I |
| Cinematic video with audio | `veo-3.1-generate-preview` | Audio + 4K + refs + extension + first/last frame |
| Cheap video | `veo-3.1-lite-generate-preview` | No extension/4K/refs but cheap |
| Silent legacy video | `veo-2.0-generate-001` | No audio, used only for budget or legacy compat |
| Advanced text reasoning | `gemini-3.1-pro-preview` | Best for complex/agentic tasks |
| Everyday text at scale | `gemini-3-flash-preview` | Frontier cost/perf |
| High-volume cheap text | `gemini-3.1-flash-lite-preview` | Budget tier |

See `reference/model-ids.md` for the full list including embedding, TTS, Live, Lyria, deep-research.

## Universal prompting principles

1. **Describe the scene, don't list keywords.** Single biggest lever across Imagen, Nano Banana, and Veo. A narrative paragraph beats a comma-separated tag soup every time.
2. **Match tier to task.** Low thinking budget for fact retrieval, high for planning/coding/math. Don't pay for thinking you don't need.
3. **Keep temperature at 1.0 for Gemini 3 text models** unless you have a reason. Lowering it can cause looping and degraded output.
4. **Structure prompts with explicit sections** (XML tags or Markdown headings) when you have constraints, context, and a task. Especially for Gemini 3.
5. **Always include few-shot examples** if you want a consistent output format. Zero-shot is less reliable.
6. **Put bulk context first, the question/instruction last** for long-context prompts. Gemini 3 responds best to the question at the end.
7. **Use structured output (`response_json_schema`) over prompt-engineered JSON** whenever the downstream expects JSON.
8. **Nano Banana does not support transparent backgrounds.** Request "white background" explicitly for stickers/assets.
9. **Veo audio is separate safety-gated.** Audio can be blocked even if the video passes — if audio drops out, simplify dialogue or SFX prompts.
10. **Videos live 2 days on Google's side.** Download immediately after generation.

## Routing

Deep content for each topic lives in its own file:

- **`imagen.md`** — Imagen 4 (text-to-image only)
- **`nano-banana.md`** — Gemini image family (generate + edit + multi-image composition + grounding)
- **`veo.md`** — Veo 3.x video (prompt structure, camera, audio, refs, extension, first/last frame)
- **`gemini-text.md`** — Gemini text prompting, structured output, thinking mode
- **`reference/model-ids.md`** — full model ID list with notes
- **`reference/official-docs.md`** — canonical ai.google.dev URLs to fetch fresh when docs likely moved

Read the relevant file(s) before writing code that uses these models. If a concrete detail is missing from the skill files, fetch the live doc listed in `reference/official-docs.md` — this skill was synthesized from content as of 2026-04-16 and the Gemini API surface moves fast.

## In the nebula_nodes context

The nebula skill builds graphs that include Google-backed nodes (imagen-4, nano-banana, nano-banana-pro, veo-3.1, etc.). When Claude is constructing a prompt for one of these nodes, it should apply the corresponding topic file's guidance. The nebula skill is concerned with graph plumbing; this skill is concerned with what text to put in the `text-input` node that feeds the model.

**Hand-off pattern:** if the nebula skill is building a video graph, Claude reads `veo.md` before writing the text-input content. Same for image flows (`nano-banana.md` or `imagen.md`) and for any graph that includes a Gemini text model in the loop.

# Nano Banana — Gemini Image Family

Sourced from https://ai.google.dev/gemini-api/docs/image-generation (fetched 2026-04-16).

## Model map

| Model ID | Name | Best for | Resolutions |
|---|---|---|---|
| `gemini-3.1-flash-image-preview` | Nano Banana 2 | High-volume, iterative, image-search grounded | 512, 1K, 2K, 4K |
| `gemini-3-pro-image-preview` | Nano Banana Pro | Studio assets, complex layouts, precise text in image | 1K, 2K, 4K |
| `gemini-2.5-flash-image` | Nano Banana (original) | Lowest-latency quick gen | 1K, 2K |

Aspect ratios (all): 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.
**Nano Banana 2 only** adds extreme ratios: 1:4, 4:1, 1:8, 8:1.

Image size strings are uppercase `K`: `"1K"`, `"2K"`, `"4K"`. The 512-pixel option has no K suffix.

## Core prompting principle

> **Describe the scene in a narrative paragraph. Don't list keywords.**

A coherent descriptive paragraph beats a comma-separated tag dump. Use photography/design/film vocabulary to guide the model.

## Prompt templates by use case

### Photorealistic scene

```
A photorealistic [shot type] of [subject], [action/expression], set in [environment].
The scene is illuminated by [lighting description], creating a [mood] atmosphere.
Captured with a [camera/lens details], emphasizing [key textures and details].
The image should be in a [aspect ratio] format.
```

Example:
> A photorealistic close-up portrait of an elderly Japanese ceramicist with deep, sun-etched wrinkles and a warm, knowing smile. He is carefully inspecting a freshly glazed tea bowl. The setting is his rustic, sun-drenched workshop. The scene is illuminated by soft, golden hour light streaming through a window, highlighting the fine texture of the clay. Captured with an 85mm portrait lens, resulting in a soft, blurred background (bokeh). The overall mood is serene and masterful.

### Stylized illustration / sticker

```
A [style] sticker of a [subject], featuring [key characteristics] and a [color palette].
The design should have [line style] and [shading style]. The background must be white.
```

**The model does not support transparent backgrounds.** Always request "white background" explicitly.

### Accurate text in image (use Nano Banana Pro)

```
Create a [image type] for [brand/concept] with the text "[exact text]" in a [font style].
The design should be [style description], with a [color scheme].
```

Example:
> Create a modern, minimalist logo for a coffee shop called 'The Daily Grind'. The text should be in a clean, bold, sans-serif font. The color scheme is black and white. Put the logo in a circle. Use a coffee bean in a clever way.

Nano Banana Pro's "Thinking" improves text fidelity substantially over the Flash variants. Use Pro for anything with legible copy in the output.

### Product mockup / commercial

```
A high-resolution, studio-lit product photograph of a [product] on a [background].
The lighting is a [lighting setup] to [lighting purpose].
The camera angle is a [angle type] to showcase [feature].
Ultra-realistic, with sharp focus on [key detail].
```

### Style transfer / mixed media

Single prompt can mix styles across subjects:
> A photo of an everyday scene at a busy cafe serving breakfast. In the foreground is an anime man with blue hair, one of the people is a pencil sketch, another is a claymation person.

## Multi-image composition

Pass multiple `Image.open(...)` entries as `contents`. The model composes them according to your prompt.

```python
from google import genai
from google.genai import types
from PIL import Image

client = genai.Client()
response = client.models.generate_content(
    model="gemini-3.1-flash-image-preview",
    contents=[
        "An office group photo of these people, they are making funny faces.",
        Image.open('person1.png'),
        Image.open('person2.png'),
        Image.open('person3.png'),
    ],
)
```

### Reference image limits

| Model | Object refs (high-fidelity) | Character refs (consistency) |
|---|---|---|
| Nano Banana 2 (`3.1-flash-image`) | 10 | 4 |
| Nano Banana Pro (`3-pro-image`) | 6 | 5 |

If you need to preserve a specific person across shots, stay under the character ref limit. For product/asset composition, stay under the object ref limit.

## Editing via multi-turn chat

**Chat mode is the recommended editing workflow** — each turn refines the previous output.

```python
chat = client.chats.create(
    model="gemini-3.1-flash-image-preview",
    config=types.GenerateContentConfig(
        response_modalities=['TEXT', 'IMAGE'],
    )
)

response = chat.send_message("Create a vibrant infographic about solar panels.")
# → returns first image

response = chat.send_message(
    "Update this infographic to be in Spanish. Do not change any other elements."
)
# → returns refined image
```

Key editing patterns:
- "Change X to Y, keep everything else identical."
- "Add [element] without modifying [other elements]."
- "Swap the background for [description]."

## Aspect ratio and resolution config

```python
config = types.GenerateContentConfig(
    image_config=types.ImageConfig(
        aspect_ratio="16:9",
        image_size="2K",
    ),
    response_modalities=['TEXT', 'IMAGE'],
)
```

## Grounding with Google Search

For factual, current content (weather visualizations, news-pegged imagery, current-event illustrations), enable search grounding.

```python
config = types.GenerateContentConfig(
    tools=[{"google_search": {}}],
    response_modalities=['TEXT', 'IMAGE'],
)
```

Response includes:
- `searchEntryPoint` — HTML/CSS you MUST render if you display results
- `groundingChunks` — top 3 web sources the model used

**Image-based search results are not passed to the generation model when using web search grounding.** They inform reasoning but don't appear in the output.

### Image search grounding (Nano Banana 2 only)

```python
tools=[
    types.Tool(google_search=types.GoogleSearch(
        search_types=types.SearchTypes(
            web_search=types.WebSearch(),
            image_search=types.ImageSearch(),
        )
    ))
]
```

Display requirements when you use image-search grounding:
- Link to the **containing webpage** (not the raw image URL)
- Direct, single-click path from cited image to the page
- No intermediate viewers or multi-click navigation

**Limitation:** image search cannot search for people.

## Thinking control

Thinking is **on by default** and cannot be fully disabled. The model can generate up to 2 interim images during reasoning; the final thought becomes the rendered output.

Nano Banana 2 exposes `thinking_level`:
```python
config = types.GenerateContentConfig(
    thinking_config=types.ThinkingConfig(
        thinking_level="High",  # or "minimal"
        include_thoughts=True,
    ),
)
```

- `minimal` — lowest latency, fine for simple gen
- `High` — better quality for complex scenes/text

Thinking tokens are billed regardless of whether you see them.

## Thought signatures (multi-turn)

With the official SDKs, multi-turn chat handles signatures automatically. If you're managing conversation history manually:
- All non-thought image parts have signatures
- The first text part after thoughts has a signature
- Thought images have no signatures
- You must pass signatures back in subsequent turns

## Known limitations

- **No transparent backgrounds.** Request white backgrounds for stickers/assets.
- **Image search grounding can't find people.**
- **Web search grounding excludes image results from the generation input.**
- **Thinking tokens are always billed**, even on "minimal" level.

## Batch generation

For high-volume work, use the Batch API — higher rate limits, up to 24-hour turnaround. See `https://ai.google.dev/gemini-api/docs/batch-api#image-generation`.

## Nebula-specific notes

- In this repo the node id for Nano Banana 2 is `nano-banana` (verify with `nebula graph` definitions). For text-in-image jobs prefer `nano-banana-pro`.
- When a user drops an image on the canvas it becomes an `image-input` cli_graph node. Wire it into `nano-banana.images` (the `Images +` port accepts multiple refs) to use it as a reference.
- Character-consistency workflows (same character across multiple shots) should use Nano Banana 2 — it allows 4 character refs vs Pro's 5 with lower object-ref headroom.

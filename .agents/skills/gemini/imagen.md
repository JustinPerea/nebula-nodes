# Imagen

Sourced from https://ai.google.dev/gemini-api/docs/image-generation and related Imagen pages (fetched 2026-04-16).

Imagen is Google's dedicated text-to-image model family, separate from the Nano Banana (Gemini Image) line. Use Imagen when you want a specialist text-to-image generator without the reasoning/editing surface area of Nano Banana.

## Model

- **`imagen-4`** — text-to-image, up to 2K resolution.

## When to use Imagen vs Nano Banana

| Pick Imagen | Pick Nano Banana |
|---|---|
| Pure text-to-image, no editing | Multi-turn editing or multi-image composition |
| Simpler prompt → one image flow | Reference images for character/object consistency |
| Don't need grounding or reasoning | Need search grounding, need legible in-image text |

If the request mentions "edit this", "keep the character the same", "use this reference", or "make the text say exactly X" — Nano Banana is the right pick. Imagen is for clean generation from a prompt.

## Prompting

The same core principle applies: **describe the scene in a narrative paragraph, not a keyword list**.

Imagen responds well to:
- Explicit camera/lens terminology (`85mm portrait lens`, `wide-angle`, `macro`)
- Lighting specifications (`golden hour`, `studio softbox`, `moonlight`)
- Material/texture descriptors (`matte ceramic`, `brushed aluminum`, `worn leather`)
- Mood words anchored to concrete visual cues (`serene — soft light, muted tones, uncluttered composition`)

Example:
> A photorealistic wide shot of a mountain lodge at dusk, snow drifting against pine beams, warm amber light glowing from the windows onto the fresh powder outside. Captured with a medium-format camera, crisp foreground detail, slight atmospheric haze toward the peaks. Cinematic, quiet.

## Aspect ratio

Imagen supports standard ratios: 1:1, 3:4, 4:3, 9:16, 16:9. Specify explicitly — the default is 1:1 and it rarely matches what you actually want.

## Known limitations

- No multi-image composition (use Nano Banana for that).
- No chat/multi-turn editing surface (use Nano Banana).
- No grounded-search support.
- No native reasoning — if the prompt requires planning (e.g., "design a poster that says X with a Y-style border and Z illustration"), Nano Banana Pro will likely outperform.

## Nebula-specific notes

- In the nebula node registry, look for `imagen-4` as the definition id. Use it when the user just says "generate an image of …" with no editing context and no reference image.
- For any request that mentions keeping an existing character/product consistent, route to Nano Banana instead.

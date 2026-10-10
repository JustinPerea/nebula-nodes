# Imagen (retired)

Google shut Imagen 4 down on 2026-08-17 and names **Nano Banana 2.1** as the replacement (checked 2026-10-10).

- Nebula removed the `imagen-4-generate` node on 2026-10-10. Creating one returns a 400 that explains the retirement.
- Saved graphs migrate automatically to a `nano-banana` node with `model=gemini-nano-banana-2.1`. Aspect ratio (`aspectRatio` → `aspect_ratio`) and a 1K/2K `imageSize` carry over. The node is titled "Nano Banana (was Imagen 4)" unless it was renamed.
- For plain text-to-image, use `nano-banana` with Nano Banana 2.1 (1K/2K/4K, all 14 aspect ratios). Prompting guidance is in `nano-banana.md`: describe the scene in a narrative paragraph, with camera, lighting and material cues, and set the aspect ratio explicitly.

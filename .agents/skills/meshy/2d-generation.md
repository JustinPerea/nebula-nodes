# 2D Generation — Text-to-Image and Image-to-Image

Sourced from docs.meshy.ai (fetched 2026-04-17).

Meshy exposes nano-banana (Google's Gemini 3.1 Flash Image) through its own endpoints. **It's the same underlying model as nano-banana direct.** Use this when you want 2D images within the same Meshy billing + task history — and especially when the image is going to feed a Meshy 3D endpoint next, since chaining is simpler.

## Text-to-Image (`/openapi/v1/text-to-image`)

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ai_model` | string | ✅ | — | `"nano-banana"` (3 credits) or `"nano-banana-pro"` (9 credits) |
| `prompt` | string | ✅ | — | Docs: *"Be descriptive for best results"* |
| `generate_multi_view` | boolean | | `false` | When `true`, returns **3 URLs** showing different viewing angles |
| `pose_mode` | string | | — | `"a-pose"` or `"t-pose"` — for character reference images destined for 3D pipelines |
| `aspect_ratio` | string | | `"1:1"` | `"1:1"`, `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"` |

**Critical constraint from docs:**
> `generate_multi_view` and `aspect_ratio` **cannot be used simultaneously**.

If you set both, the API returns 400. Multi-view always uses square crops.

### Response

```json
{
  "id": "...",
  "type": "text-to-image",
  "ai_model": "nano-banana" | "nano-banana-pro",
  "status": "SUCCEEDED",
  "image_urls": ["https://...", ...]  // 1 URL normally, 3 URLs when generate_multi_view=true
}
```

## Image-to-Image (`/openapi/v1/image-to-image`)

Reference-image-based generation — pass 1–5 reference images plus a prompt describing the transformation.

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ai_model` | string | ✅ | — | `"nano-banana"` or `"nano-banana-pro"` |
| `prompt` | string | ✅ | — | Text description of the transformation |
| `reference_image_urls` | string[] | ✅ | — | **1 to 5 images**. Public URL or data URI. Formats: `.jpg`, `.jpeg`, `.png` |
| `generate_multi_view` | boolean | | `false` | 3 viewing angles when `true` |

**No `aspect_ratio` or `pose_mode` on image-to-image** — docs list neither. Output is always based on the input reference images.

### Response

Same shape as text-to-image. `image_urls` is 1 URL normally, 3 when multi-view.

## Tips

1. **Pick nano-banana-pro when it matters** — 3× the cost but distinctly better for detailed scenes, legible text, character consistency. Use `nano-banana` for fast iteration.
2. **Use `pose_mode` when the image is going to feed a 3D pipeline** — a cleanly-posed A-pose or T-pose character image generates much better 3D meshes.
3. **Multi-view is for downstream 3D use** — 3 angles of the same subject is ideal input for `meshy-multi-image-to-3d`. Full turnaround pattern:
   - `text-to-image` with `generate_multi_view=true` → 3 URLs
   - `multi-image-to-3d` with `image_urls=[url1, url2, url3]` → 3D model
4. **Image-to-image doesn't accept aspect_ratio** — output ratio follows input. If you need a specific ratio, pre-crop your reference images.
5. **Reference images limit is 5** — if the user drops 6+ images, use the first 5 most representative or composite them into a single image first.

## Cost recap

| Model | Text-to-Image | Image-to-Image |
|---|---|---|
| `nano-banana` | 3 credits | 3 credits |
| `nano-banana-pro` | 9 credits | 9 credits |

## Alternative: use the Gemini/Nano-Banana skill instead

If the user isn't staying in the Meshy ecosystem for 3D follow-ups, the direct Google API is cheaper per token and has richer prompting guidance. See the `gemini` skill (`.claude/skills/gemini/nano-banana.md`) for direct Nano Banana prompting best practices — those apply here too since it's the same model.

**When to use Meshy's wrapper anyway:**
- Everything in one billing + dashboard
- Immediate 3D handoff via `meshy-multi-image-to-3d`
- Same rate-limit account as your 3D tasks
- Simpler API surface (Meshy hides `thinking_level`, grounding, etc.)

**When to use Google direct:**
- Need `thinking_level` control
- Need Google Search grounding
- Want image_search grounding
- More aspect ratios (1:4, 4:1, 1:8, 8:1 only on nano-banana-2 direct)
- You've already built out API key management for Google

## Common failure modes

- **400: both `generate_multi_view` and `aspect_ratio` set** — pick one
- **400: `reference_image_urls` empty or >5** — provide 1–5 images
- **400: unreachable URL** — use data URIs for local files
- **429: rate limit** — 2D endpoints share the per-account rate limit with 3D endpoints (see `reference/rate-limits.md`)

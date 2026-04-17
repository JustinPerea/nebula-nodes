# Meshy — Credit Pricing

Sourced from docs.meshy.ai/en/api/pricing (fetched 2026-04-17). Meshy is pay-before-you-go — purchase credits from API settings page. No specific tiered plan pricing documented in the public pricing page.

## Full pricing table

| Endpoint | Model | Credits |
|---|---|---|
| Text-to-3D Preview | meshy-6 / lowpoly | **20** |
| Text-to-3D Preview | meshy-5 / other | **5** |
| Text-to-3D Refine | any | **10** |
| Image-to-3D (no texture) | meshy-6 / lowpoly | **20** |
| Image-to-3D (with texture) | meshy-6 / lowpoly | **30** |
| Image-to-3D (no texture) | meshy-5 / other | **5** |
| Image-to-3D (with texture) | meshy-5 / other | **15** |
| Multi-Image-to-3D (no texture) | meshy-6 | **20** |
| Multi-Image-to-3D (with texture) | meshy-6 | **30** |
| Multi-Image-to-3D (no texture) | meshy-5 / other | **5** |
| Multi-Image-to-3D (with texture) | meshy-5 / other | **15** |
| Retexture | any | **10** |
| Remesh | any | **5** |
| Auto-Rigging | any | **5** (includes free walking + running) |
| Animation | any | **3** per action |
| Text-to-Image | nano-banana | **3** |
| Text-to-Image | nano-banana-pro | **9** |
| Image-to-Image | nano-banana | **3** |
| Image-to-Image | nano-banana-pro | **9** |
| 3D Print (Multi-Color) | any | **10** |

## Key observations

- **Meshy 6 is ~4× more expensive** than older models for 3D generation. Worth it for final quality; use meshy-5 for iteration.
- **Texture phase adds cost on image-to-3d flows** — `should_texture=true` costs 10–15 credits more than mesh-only on older models, 10 more on meshy-6.
- **Rigging is a bargain.** 5 credits gets you the rig + walking + running. Additional animations are only 3 credits each.
- **`texture_prompt` and `texture_image_url` add 10 credits** on top of the base image-to-3D cost when used (per the image-to-3d endpoint docs).
- **nano-banana-pro costs 3× nano-banana.** Use pro only when the quality matters.
- **Remesh is always 5 credits** regardless of how much geometry you're decimating or what format you're converting to.

## Text-to-3D total cost by mode

| Scenario | Model | Total |
|---|---|---|
| Preview only | meshy-6 | 20 |
| Preview only | meshy-5 | 5 |
| Preview + refine (full pipeline) | meshy-6 | 30 (20 + 10) |
| Preview + refine | meshy-5 | 15 (5 + 10) |

Our `meshy-text-to-3d` node's `mode="full"` parameter triggers both phases.

## Worked examples

### Simple figurine, low cost
- Text-to-3D preview on meshy-5 (5) + refine (10) = **15 credits**

### High-quality character rigging pipeline
- Text-to-3D preview meshy-6 (20) + refine (10) = 30
- Rigging (5) — includes walk + run for free
- 3 custom animations (3 × 3) = 9
- **Total: 44 credits**

### Product mockup from photo
- Image-to-3D meshy-6 with texture (30) = **30 credits**

### Branded asset for 3D print
- Text-to-3D preview meshy-6 (20) + refine with PBR (10) = 30
- Retexture with brand colors (10) = 10
- 3D print multi-color (10) = 10
- **Total: 50 credits**

### Multi-angle product variations
- Text-to-Image nano-banana-pro with multi-view (9) = 9
- Multi-Image-to-3D meshy-6 with texture (30) = 30
- **Total: 39 credits**

## Plan note

The pricing page states Meshy API is *"a pay-before-you-go product"* and directs users to purchase credits from the API settings page. Specific plan tiers (Pro, Studio, Enterprise) are listed on the rate-limits page but not tied to credit allocations in the public pricing docs. The vault research note (from earlier, 2026-04-12) mentioned **Pro = $20/mo = 1,000 credits** but that may be stale; confirm current pricing before quoting figures to users.

## Absent from official pricing table

Only `meshy-6` and the "other models" category appear in the pricing page. Individual endpoint docs still reference `meshy-5` as a valid `ai_model` value — so meshy-5 is still accepted by the API, it just falls into the "other models / 5 credit" bucket.

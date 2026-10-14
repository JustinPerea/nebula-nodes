---
name: byteplus
description: BytePlus ModelArk in Nebula — ByteDance's own API for Seedream images, used as the direct route for the fal Seedream node (seedream-4-5, and cinema-scene through it) and the Krea Seedream copies (krea-image-bytedance-seedream-4, -5-lite, -5-pro) when BYTEPLUS_API_KEY is saved. Activate when the user asks about BytePlus, ModelArk, running Seedream on ByteDance's API, a ModelNotOpen or BytePlus error, or which route a Seedream node takes. Sourced from docs.byteplus.com (image-generation-api, model-pricing, error-codes, region-availability, Service Specific Terms) on 2026-10-14; user guide at docs/api-guides/byteplus.md.
---

# BytePlus ModelArk

## Hard facts first

- **Not available in the United States.** BytePlus Service Specific Terms, "Model Services": "The BytePlus Model Services are not available in the United States." Don't steer a US user to BytePlus; the fal or Krea key keeps working for the same nodes.
- **Region:** Nebula calls Asia Pacific only, `https://ark.ap-southeast.bytepluses.com/api/v3`. Keys and model activation are per region, so an EU console key fails here.
- **Activation:** each model must be switched on in the ModelArk console's Model activation page (https://ai.byteplus.com/ark/region:ap-southeast-1/openManagement) before it runs. Otherwise: 404 `ModelNotOpen`. Seedance 2.x needs USD 30 of credits (or a USD 30 Savings Plan / resource pack) before activation.
- **Key:** `BYTEPLUS_API_KEY` (not Volcengine's `ARK_API_KEY`), sent as `Authorization: Bearer`. Nebula never probes it (no free read-only check is documented).

## Which route a Seedream node takes

Same rules in routing, pricing, the spend gate, readiness and the cache key (`backend/services/node_route.py`, mirrored in `frontend/src/lib/directRoute.ts`):

1. Krea copy set to the Krea plan (`_kreaAuth == "mcp"`): Krea plan.
2. `BYTEPLUS_API_KEY` saved and the recipe fits ModelArk: BytePlus, billed by BytePlus.
3. Otherwise the fal key (`seedream-4-5`) or the Krea API token (Krea copies).

What keeps a run on the copy (the readiness line names it):

- `seedream-4-5`: a set `seed` (`directRoute.blockedBy`); `image_size` of `square` (512x512), `auto_3K` on model 4.5, or a custom `{width, height}` outside 3,686,400–16,777,216 pixels or past 16:1 (`directRoute.size`).
- Krea copies: set `style_images` (Krea's `strength` has no ModelArk field); `width` x `height` outside the model's limits — 4.0: 921,600–16,777,216 px; 5 Lite: 3,686,400–16,777,216; 5 Pro: 921,600–4,624,220.

To move a recipe onto BytePlus, clear the seed or style images, or pick a size it takes. Never rewrite someone's recipe silently to make it fit.

## Models

| Node | Choice | ModelArk id | Price per image (USD) |
|---|---|---|---|
| `seedream-4-5` | `model: 4.5` | `seedream-4-5-251128` | 0.04 |
| `seedream-4-5` | `model: 5.0-lite` | `seedream-5-0-lite-260128` | 0.035 |
| `krea-image-bytedance-seedream-4` | | `seedream-4-0-250828` | 0.03 |
| `krea-image-bytedance-seedream-5-lite` | | `seedream-5-0-lite-260128` | 0.035 |
| `krea-image-bytedance-seedream-5-pro` | | `dola-seedream-5-0-pro-260628` | 0.045 (≤ 2.61 MP) / 0.09 (above) |

Only successful images are billed. On `seedream-4-5`, `num_images` sends that many separate requests; `max_images` > 1 turns on sequential generation, where the model returns 1 to `max_images` images, so the estimate is a range. The output port shows the first image; every image is saved.

## Request shape

`POST /images/generations`, synchronous: `model`, `prompt`, `size` (a tier like `2K` or `WxH`, never both), optional `image` (URLs or `data:image/<fmt>;base64,...`, up to 10 from the node), `sequential_image_generation` + `sequential_image_generation_options.max_images`, `watermark: false`, `response_format: b64_json`. ModelArk has no seed, negative prompt or count field.

## Errors

`backend/handlers/byteplus.py` `explain()` adds the fix to BytePlus's code: `AuthenticationError` (check the key and region), `ModelNotOpen` / `InvalidEndpointOrModel.*` / `OperationDenied.ServiceNotOpen` (activate the model), `AccountOverdueError` (top up), `QuotaExceeded` (free-trial quota used up or too many queued tasks), other 429 (rate limit), `*SensitiveContentDetected` (change the prompt or inputs).

## Not wired yet

- Seedance video on ModelArk (`POST /contents/generations/tasks`, `GET`/`DELETE /contents/generations/tasks/{id}`); the client's `request()` is ready for it.
- Seedream 5.0 flash, and a region setting (eu-west-1 Seedream support is not confirmed).

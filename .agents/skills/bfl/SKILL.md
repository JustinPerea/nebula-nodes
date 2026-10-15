---
name: bfl
description: Black Forest Labs (BFL) in Nebula — the FLUX 3 nodes (flux-3-image, flux-3-image-klein, flux-3-image-klein-base, flux-3-video, flux-video-edit, flux-video-upscale) and FLUX.2 (flux-2-pro: Pro, Max, Flex, Klein 9B and 4B, plus fal's Flash), each one node with a provider switcher whose maker route is BFL's own API (api.bfl.ai, BFL_API_KEY) and whose other routes are fal, Replicate, OpenRouter and Krea. Activate when the user asks about FLUX 3, FLUX.2, Klein, FLUX video, video edit or upscale, BFL, BFL_API_KEY, a BFL error or moderation status, which provider a FLUX 3 node runs on, or why a FLUX 3 run stopped and offered another provider. Sourced from api.bfl.ai/openapi.json, docs.bfl.ai and bfl.ai/pricing (fetched 2026-10-15); user guide at docs/api-guides/bfl.md, routes at docs/PROVIDER-ROUTES.md.
---

# Black Forest Labs (FLUX 3 and FLUX.2)

## Hard facts first

- **One node per model.** Each FLUX 3 model is one node with a `routes` table and a provider switcher on the card, in the Inspector and in Create. The saved `_provider` is `auto` or a route id (`bfl`, `fal`, `replicate`, `openrouter`, `krea`). Auto takes the first route in table order whose key is set, and BFL, the maker, is always first. How it works: `docs/PROVIDER-ROUTES.md`.
- **Auto never moves.** If the route Auto lands on can't take a setting or an input (1.5k on fal, a seed on OpenRouter Klein, a 4K video on Replicate), the run stops before any spend and names the routes that could take it. It doesn't quietly try the next provider. Who bills depends only on `_provider` and the saved keys.
- **The provider is the person's call.** An agent that wants another provider proposes it (`propose_change`, `nebula propose`). A direct edit of `_provider` (or `_kreaAuth`) is refused.
- **Each route shows only what it takes.** The Inspector, Create and `describe_node` list each route's own values and ranges (`route_param_definitions`). Read the route rows in `describe_node` before setting a value; a saved value the shown route lacks reads "(not on fal.ai)" and blocks the run.
- **Key:** `BFL_API_KEY`, sent as `x-key` to `https://api.bfl.ai`. Keys are per project and shown once (dashboard.bfl.ai → API → Keys); credits belong to the organization. Settings checks the key with the free `GET /v1/credits` (403 = rejected, 422 = malformed).
- **No cancel on BFL.** Stopping a BFL run stops polling only; the task finishes and bills. fal and Replicate runs are cancelled upstream on Stop.
- **Results expire.** BFL's `result.sample` link lasts about 1 hour (image) or 2 hours (video). Nebula downloads it at once.
- **Concurrency:** 5 active FLUX 3 video tasks per organization (429 "too many active tasks"); 24 concurrent requests on most other endpoints. A 429 on submit is retried after 5, 15 and 30 seconds.

## The nodes

| Node | Ports | Routes, in Auto order |
|---|---|---|
| `flux-3-image` "FLUX 3 Image" | `prompt`; `images` (up to 10; wired means edit) | bfl `/v1/flux-3-image` · fal `blackforestlabs/flux-3/text-to-image` (`/edit-image` when images are wired) · replicate `black-forest-labs/flux-3-image` · openrouter `black-forest-labs/flux-3-image` (`/api/v1/images`) |
| `flux-3-image-klein` "FLUX 3 Image Klein" | `prompt`; `images` (up to 10) | bfl `/v1/flux-3-image-klein` · openrouter `black-forest-labs/flux-3-image-klein` |
| `flux-3-image-klein-base` "FLUX 3 Image Klein Base" | `prompt`; `images` (up to 10) | fal `blackforestlabs/flux-3/klein/base/text-to-image` (`/edit-image` when images are wired) only |
| `flux-3-video` "FLUX 3 Video" | `prompt`; `start_image`, `end_image`, `start_video`, `keyframes` (multiple) | bfl `/v1/flux-3-video` · fal `blackforestlabs/flux-3/*` (endpoint by ports and draft) · replicate `black-forest-labs/flux-3` · openrouter `black-forest-labs/flux-3-video` (`/api/v1/videos`) · krea (catalog Flux 3 Video, API token or plan) |
| `flux-video-edit` "FLUX Video Edit" | `prompt`; `start_video` (required) | bfl `/v1/flux-tools/video-edit-v1` · fal `blackforestlabs/flux-3/edit-video` · krea |
| `flux-video-upscale` "FLUX Video Upscale" | `video` (required); `prompt` (optional) | bfl `/v1/flux-tools/video-upscale-v1` · fal `blackforestlabs/flux-video-upscale` · replicate `black-forest-labs/flux-video-upscale` · krea |
| `flux-2-pro` "FLUX.2" | `prompt` | bfl `/v1/flux-2-{pro,max,flex,klein-9b,klein-4b}` by `model` · fal `fal-ai/flux-2-pro`, `-max`, `-flex`, `flux-2/flash`, `flux-2/klein/9b`, `/4b` |

Every node outputs one port: `image` or `video`.

- **The video mode comes from the wires.** Nothing wired: text to video. `start_image` (and optionally `end_image`) or `keyframes`: image to video. `start_video`: continue a clip (BFL `v2v`). Video plus images on one run is refused. An end image with no start image or keyframes before it is refused on every route, so no provider opens the clip on its closing frame.
- **Prompt and media come from ports.** These nodes have no typed prompt param: wire a `text-input`, an `image-input` or an upstream output.
- **Krea's three synced FLUX nodes are folded in.** Saved `krea-video-black-forest-labs-flux-3-video`, `krea-video-black-forest-labs-flux-video-edit` and `krea-enhance-black-forest-labs-flux-video-upscale` nodes load as `flux-3-video`, `flux-video-edit` and `flux-video-upscale` with `_provider: "krea"` and their `_kreaAuth` kept, so billing doesn't change on load. Values translate (`720p` → `hd`, `1080p` → `fhd`; upscale `precise` → 0, `creative` → 1; the upscale port `video_url` → `video`). Krea-only outputs (`videos`, `artifacts`, `job`) have no new port.
- **The Krea plan** is used on these nodes only when the person picks the "Krea · plan" row (`_provider: krea`, `_kreaAuth: mcp`). Auto never bills the plan on a FLUX node, because BFL is the maker.

## What each route takes

### FLUX 3 Image

Shared: `aspect_ratio` (`auto` plus 15 ratios from 21:9 to 9:21, default `auto`), `resolution` (`768sq`, `1k`, `1.5k`, `2k`, `4k`, default `1k`), `safety_tolerance` 0-4 (default 2).

| Route | Differs |
|---|---|
| bfl | also `grounding` (default on) |
| fal | no `1.5k`, no `9:21`; also `enable_prompt_expansion` (default off) |
| replicate | also `grounding` (default on) |
| openrouter | everything shared; `safety_tolerance` goes under `provider.options` |

BFL has no seed, negative prompt or output format on FLUX 3 Image. `auto` follows the first reference image; with no references it makes 1:1, so set the ratio for a non-square text-to-image run.

### FLUX 3 Image Klein

Shared: `aspect_ratio`, `resolution` (the same tiers), `safety_tolerance` 0-4, `seed` (0 to 4294967295, unset by default). BFL also takes `steps` 1-16 (default 16) and `output_format` jpeg or png (default jpeg). OpenRouter takes no seed: a set seed stops the run on OpenRouter ("it doesn't take a seed").

No fal route: fal's Klein takes only exact pixel sizes, and BFL publishes no exact size for its tiers. No Replicate route: Replicate has no Klein model (404, 2026-10-15).

### FLUX 3 Image Klein Base

The undistilled 5.6B model, on fal only (BFL's API doesn't serve it). It uses fal's own names: `image_size` (`square_hd` default, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`), `seed`, `output_format` (png, jpeg, webp), `enable_prompt_expansion` (default on), `enable_safety_checker` (default on). Custom pixel sizes aren't offered.

### FLUX 3 Video

Shared: `duration` 5-20 s (default 5), `resolution` `hd` / `fhd` / `qhd` / `uhd` (default `hd`), `aspect_ratio` (`auto`, 21:9, 2:1, 16:9, 4:3, 1:1, 3:4, 9:16, 9:21; default 16:9), `generate_audio` (default on). `draft` (default off) is a route param on bfl, fal and replicate only.

| Route | Takes | Stops on |
|---|---|---|
| bfl | everything | a draft above `hd`; a continuation longer than 15 s |
| fal | 720p-2160p; no 9:21 | a draft above `hd` |
| replicate | `hd`, `fhd` only; no 9:21 | a draft at `fhd` |
| openrouter | `hd` to `uhd` (2K, 4K); only 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | `keyframes` or `start_video` wired; `draft`; a start or end image that isn't a public http(s) URL (a Nebula output can't be sent) |
| krea | `hd`, `fhd`; no `auto` or 9:21 | `keyframes` wired; `draft` |

Drafts render at `hd` only (BFL: "sending `draft: true` with any other resolution is rejected"). BFL's `draft_enhance` mode isn't offered yet.

### FLUX Video Edit and Video Upscale

- **Edit** has no settings: the prompt says what to change in the clip (remove, add or replace objects, change the setting, restyle, change text or dialogue). BFL caps the source at 15 s and 50 MB, and the output is 720p.
- **Upscale** shares `creativity` (0 Precise or 1 Creative, default 1) and `upscale_factor` 1.5-3 (default 2). The prompt is optional.
- Neither has an OpenRouter route. OpenRouter lists both models, but it documents no way to send a source clip. Edit has no Replicate route either (404).

### FLUX.2

One node for the FLUX.2 family; `model` picks the endpoint and is never sent. Its id stays `flux-2-pro` because saved graphs use it, and its param names are fal's (the route it ran on before).

Shared: `model` (`pro` default, `max`, `flash`, `flex`, `klein-9b`, `klein-4b`), `image_size` (fal's six presets, default `landscape_4_3`), `output_format` jpeg or png, `safety_tolerance` `"1"`-`"5"` (default `"2"`), `seed`, and on Flex only `num_inference_steps` and `guidance_scale` (1.5-10).

| Route | Differs |
|---|---|
| bfl | no `flash` (the run stops and offers fal); the preset is sent as `width`/`height` (`square_hd` 1024×1024 ... `landscape_16_9` 1024×576); steps 1-50 |
| fal | also `enable_safety_checker` (default on); steps 2-50; Klein takes no `safety_tolerance`, so only the default `"2"` runs there |

- Steps or guidance on a model other than Flex stop the run on either route.
- Clicking Black Forest Labs on a Flash node moves it to Flex and resets a switched-off safety checker, with a note on the card.
- fal Flash still receives `safety_tolerance` (not in its schema), exactly as the fal-only node sent it, so saved graphs make the same request.
- No image input or editing, no prompt upsampling switch, no exact pixel sizes. Detail and sources: `docs/model-providers/bfl/flux-2.md`.

## Prices

From each provider's own page, read 2026-10-15. `model_pricing.json` is the source the app uses; a `*` in the switcher means the price is unconfirmed, and `-` means there's no list price.

| Node | BFL | fal | Replicate | OpenRouter | Krea |
|---|---|---|---|---|---|
| FLUX 3 Image, per image (768sq / 1k / 1.5k / 2k / 4k) | $0.041 / 0.048 / 0.07 / 0.10 / 0.607 | same as BFL, no 1.5k (unconfirmed) | $0.0205 / 0.024 / 0.035 / 0.05 / 0.3035 | same as BFL | - |
| Klein, per image | $0.008 / 0.009 / 0.011 / 0.014 / 0.036 | - | - | same as BFL | - |
| Klein Base, per image | - | $0.024 to $0.0283 by preset (unconfirmed) | - | - | - |
| Video, per second (hd / fhd / qhd / uhd) | $0.15 / 0.24 / 0.28 / 0.41; continuation 0.21 / 0.27 / 0.31 / 0.45; draft 0.06 | 720p 0.17, 1080p 0.29 (unconfirmed; qhd/uhd unpriced) | 0.17 / 0.29; continuation 0.41 / 0.53 | 0.17 / 0.29 / 0.28 / 0.41 | 0.17 / 0.29; continuation 0.41 / 0.53 |
| Video Edit, per second | $0.03 | $0.03 | - | - | unpriced |
| Video Upscale | $0.07 (precise) / $0.10 (creative) per output megapixel-second | per output second by tier (unconfirmed) | $0.07 / $0.10 per megapixel-second | - | unpriced |
| FLUX.2, per image (pro / max / flex / klein-9b / klein-4b; fal also flash) | $0.03 / 0.07 / 0.05 / 0.015 / 0.014 | $0.03 / 0.07 / 0.05 / 0.011 / 0.009; flash 0.005 (Flash and Klein unconfirmed) | - | - | - |

fal's FLUX 3 page and its pricing API disagree (the page still mentions a launch promo); Nebula uses the higher number until a billed run settles it. 1 BFL credit = $0.01.

## Prompting FLUX 3 Image

From BFL's guides (docs.bfl.ai/guides/prompting_unified_technical, flux_3/flux3_image_bounding_boxes):

- **No negative prompts.** Describe what fills the space instead: "an empty promenade", not "no crowds"; "plain studio backdrop in one color", not "no background clutter".
- **Make the ratio and the prompt agree.** A 21:9 frame needs something across the width ("cliffs on one side, turquoise sea on the other").
- **Iterate at `768sq`, finish at `2k` or `4k`.** A new resolution is a new generation, so the composition can change.
- **For edits, `auto` keeps the input's frame.** Set a ratio only when the edit should change the frame, and say what fills the new space.
- **Bounding boxes go in the prompt.** Name each element with an id in angle brackets (`<silhouette_1>`) in a one-paragraph caption, then a space and a JSON array of rows: `{"id", "bbox": [top, left, bottom, right], "desc"}` in integers 0-1000 from the top-left. Edits use `from` (`ref_image_0` or `null`), `src_bbox` and `tgt_bbox` (`null` removes the element). Boxes guide placement; they aren't masks. Send the aspect ratio the boxes were drawn for, and put each line of text in its own row with the exact words quoted.

## Errors

| BFL answer | What to do |
|---|---|
| 402 | BFL credits ran out: add credits on the dashboard |
| 403 | the key was rejected: check `BFL_API_KEY` |
| 422 `Invalid API key format` | copy the key again |
| 400 / 422 with `detail` | a value BFL won't take; the message names the field |
| `Request Moderated` / `Content Moderated` | the prompt or an input, or the output, was blocked; the message lists BFL's moderation reasons |
| `No Card Generated`, `Error`, `Task not found` | the run stops with BFL's details |

## Code

- Node definitions: `frontend/src/constants/nodeDefinitions.ts` (source), exported to `backend/data/node_definitions.json`. Route table rules: `backend/services/node_route.py`, `frontend/src/lib/directRoute.ts`.
- Clients: `backend/handlers/bfl.py` (`run_task`), and `backend/execution/route_clients.py` for every route (`run_bfl`, fal, `replicate-model`, `openrouter-images`, `openrouter-videos`, `krea`).
- Merge of the Krea FLUX nodes: `MERGED` in `backend/services/retired_nodes.py`; `FOLDED` in `scripts/sync-krea-catalog.py`.
- Docs: `docs/api-guides/bfl.md` (setup, run flow, prices), `docs/model-providers/bfl/` (sources and per-model notes), `docs/PROVIDER-ROUTES.md`.

## Not wired yet

- FLUX.2 image input and editing, the preview endpoints, prompt upsampling, `safety_tolerance` 0, exact sizes.
- FLUX 3 Video `draft_enhance`; `duration: auto`; Klein's exact `width` / `height`; Klein Base custom sizes; `safety_tolerance` above 4 (BFL allows up to 7 only for approved organizations).
- FLUX 3 Action (robotics, weights only, no generation endpoint).
- No paid BFL run has been made from Nebula yet; the first live check is one Klein image at 768sq ($0.008), with Justin's go-ahead.

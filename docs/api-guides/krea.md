# Krea in Nebula Nodes

> Generate high-quality images with Krea's own **Krea 2** model — steered by your own style references, moodboards, and custom-trained LoRA styles — straight from a node on the canvas.

## What you can make

**Images**
- **Krea 2 generations** — text-to-image from a prompt, in 8 aspect ratios (1:1 through 9:16, including cinematic 2.35:1), at 1K resolution, with tunable "creativity" (raw / low / medium / high).
- **Style-steered images** — feed in reference images (your own uploads or upstream node outputs) so the result picks up their look, with per-reference strength control.
- **Moodboard-steered images** — bias a generation toward a Nebula moodboard or an existing Krea moodboard ID.

**Custom styles (training)**
- **Train a LoRA style/object/character** from a set of training images, on your choice of base model (FLUX Dev/Schnell, Wan, Wan 2.2, Qwen, Z-Image), then reuse the resulting style ID to generate on-brand images. Optionally share the trained style with your API workspace.

**Style discovery**
- **Search Krea's style library** — your own styles, community styles, Krea's curated styles, shared/public/gallery styles — filter by model, by user, by liked, and page through results. Useful for finding a `style_id` to plug into a Krea 2 generation.

## Nodes available in Nebula (3)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| **Krea 2** | `krea-2-generate` | image-gen | `prompt` (Text, required); `style_images` (Image, up to 10); `image_style_references` (Any, up to 10); `styles` (Any); `moodboard` (Any) | `variant` (medium/large), `aspect_ratio` (1:1…9:16, 2.35:1), `resolution` (1K), `creativity` (raw/low/medium/high), `seed`, `style_reference_strength` (0–1), `style_id`, `style_strength` (−2–2), `moodboard_id`, `moodboard_strength` (0–1) | Generating a Krea 2 image from a prompt, optionally steered by reference images, trained styles, or a moodboard. |
| **Krea Style Search** | `krea-style-search` | analyzer | (none) | `filter` (all/user/community/krea/shared/public/gallery), `model` (e.g. flux_dev, qwen, z-image, wan), `ids`, `user`, `liked`, `limit` (1–1000), `cursor` | Browsing/finding Krea styles and their IDs to feed into a Krea 2 generation. Outputs a `styles` array plus a text summary. |
| **Krea Style Train** | `krea-style-train` | image-gen | `images` (Image, required, multiple) | `name` (required), `model` (flux_dev/flux_schnell/wan/wan22/qwen/z-image), `training_type` (Style/Object/Character/Default), `trigger_word`, `max_train_steps` (1–2000), `learning_rate`, `batch_size`, `generation_strength` (−2–2), `share_with_workspace` | Training a custom LoRA style from your images; outputs a reusable `style_id` (and the full `style` object) to wire into Krea 2. |

> Note: `krea-2-generate` and `krea-style-train` run **async-poll** (Nebula submits a job and polls `GET /jobs/{id}` until it completes). `krea-style-search` runs **sync**. `learning_rate` and `batch_size` only appear for the FLUX/Wan training models (they're hidden for Qwen and Z-Image).

## How to use it in Nebula

**Where the nodes appear.** Open the node palette and look under the category each node belongs to: **Krea 2** and **Krea Style Train** sit under image-generation nodes; **Krea Style Search** sits under analyzer nodes. Drag one onto the canvas, then wire its input ports.

**API-key setup.** All three nodes authenticate with a single token. In your `.env` (or wherever Nebula loads keys), set:

```
KREA_API_TOKEN=your_krea_api_key
```

Get the key from the Krea dashboard (Developers → API Keys & Billing). Nebula sends it as `Authorization: Bearer <token>` to `https://api.krea.ai`. If the key is missing you'll get a "KREA_API_TOKEN is required" error; if your Krea balance is depleted you'll see a `402` error surfaced from the API. (For backward-compat the handler also accepts `KREA_API_KEY`, but `KREA_API_TOKEN` is the documented name.)

**Recipe 1 — Straight Krea 2 text-to-image.**
1. Drop a **Krea 2** (`krea-2-generate`) node.
2. Connect a text/prompt source into `prompt` (or type one upstream).
3. Set `aspect_ratio` (e.g. `16:9`), `creativity` (`medium` is the default), optionally a `seed` for repeatability.
4. Run. The `image` output is your generated image; the `job` output carries the raw Krea job (handy for debugging/seeds).

**Recipe 2 — Style-referenced generation (look transfer).**
1. Bring in one or more images — an upload, or the `image` output of any upstream generator node — and connect them into the **Krea 2** node's `style_images` port (up to 10).
2. Tune `style_reference_strength` (0–1) to control how strongly the references bias the result.
3. Connect your `prompt` and run. Nebula automatically uploads any local/generated images to Krea's `/assets` endpoint and passes them as `image_style_references`. A connected Nebula moodboard on the `moodboard` port adds both reference images and a style-brief suffix to the prompt.

**Recipe 3 — Train a custom style, then generate with it.**
1. Drop a **Krea Style Train** (`krea-style-train`) node; connect a set of training images into `images` and give it a `name` (required). Pick a `model` (e.g. `flux_dev`) and `training_type` (`Style`). Optionally set a `trigger_word`.
2. Run it. When training completes, it emits `style_id` (Text) and a `style` object.
3. Wire that `style` output (or paste the `style_id` into the `style_id` param) into a **Krea 2** node's `styles` input, set `style_strength`, add your `prompt`, and generate on-brand images. Tip: use **Krea Style Search** first to discover existing community/Krea styles instead of training your own.

## API coverage — what Nebula uses vs. what Krea offers

| Capability / Endpoint | In the API | In Nebula |
|---|---|---|
| Krea 2 image generation (`POST /generate/image/krea/krea-2/{variant}`, medium & large) | Yes | **full** — medium + large variants, all aspect ratios, creativity, seed, style refs, styles, moodboards |
| Krea 2 Medium **Turbo** (`/generate/image/krea/krea-2-medium-turbo`) | Yes | **none** — only medium/large variants are exposed; turbo is not |
| Search styles (`GET /styles`) | Yes | **full** — filter, model, ids, user, liked, limit, cursor all wired |
| Train custom style / LoRA (`POST /styles/train`) | Yes | **full** — all 6 base models + type, trigger word, steps, LR, batch size |
| Share a style with workspace (`POST /styles/{id}/share/workspace`) | Yes | **partial** — invoked only as an option inside Style Train (`share_with_workspace`); no standalone node |
| Get a single style by ID (`GET /styles/{id}`) | Yes | **none** |
| Update a style (`PATCH /styles/{id}`) | Yes | **none** |
| Get shareable link / remove style from workspace | Yes | **none** |
| Upload an asset (`POST /assets`) | Yes | **partial** — used internally to upload local/generated images for style refs & training; not a user-facing node |
| List / get / delete assets (`GET`/`DELETE /assets…`) | Yes | **none** |
| Jobs: get by ID (`GET /jobs/{id}`) | Yes | **partial** — used internally for polling only; no list/delete |
| Jobs: list (`GET /jobs`), delete (`DELETE /jobs/{id}`) | Yes | **none** |
| Moodboards: reference existing by ID in a generation | Yes | **partial** — Krea 2 accepts a `moodboard_id`/moodboard input, but there's no create/list moodboard endpoint in the API to back it |
| **Image-to-image / editing** (Flux Kontext `POST /generate/image/bfl/flux-1-kontext-dev`, SeedEdit, Seedream 4, etc.) | Yes | **none** |
| **Other image models via Krea** (Flux, Flux 1.1 Pro/Ultra, Imagen 3/4/Fast/Ultra, Ideogram 2/3, Nano Banana / 2 / Pro, Qwen 2512, Z-Image, ChatGPT Image / 2, Luma UNI-1, Runway Gen-4, Seedream 4 / 5 Lite) | Yes | **none** — Nebula only calls Krea's own Krea 2 model through this provider |
| **Video generation** (`POST /generate/video/{provider}/{model}` — Veo 2/3/3.1, Kling 1.0–3.0 + o1, Hailuo, Runway Gen-3/4/4.5/Aleph, Seedance, Wan 2.1/2.2/2.5, Ray 2, LTX-2.3, Grok Imagine) | Yes | **none** |
| **Image enhancement / upscale** (Topaz, Topaz Bloom, Topaz Generative — `POST /generate/enhance/topaz/…`) | Yes | **none** |
| **Node apps** (list / get / execute saved Krea node workflows — `POST /node-apps/{id}/execute`) | Yes | **none** |
| **Webhooks** (job-completion callbacks) | Yes | **none** — Nebula uses polling instead |
| 3D generation | User-facing only (no documented public API endpoint) | n/a |

**Coverage: ~10% of the Krea API surface is exposed in Nebula.** (Nebula deliberately scopes this provider to Krea's *own* Krea 2 model plus its style system. The vast majority of the surface — Krea's gateway to dozens of third-party image and video models, plus editing, upscaling, and node-apps — is reachable through Krea's API but not wired up here. Many of those third-party models are covered by *other* Nebula providers, so the low number reflects scope, not a missing-feature gap.)

**Notable unused capabilities:** video generation (Veo, Kling, Runway, Hailuo, Seedance, Wan, Ray 2, etc.); image-to-image / editing (Flux Kontext, SeedEdit, Seedream 4); Topaz upscaling/enhancement; the entire third-party image-model gateway (Flux, Imagen, Ideogram, Nano Banana, Qwen, Z-Image, ChatGPT Image, Luma); Krea 2 Medium **Turbo**; node-apps execution; full style CRUD (get/update/shareable-link); asset list/get/delete; job list/delete; and webhook callbacks.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/krea/SKILL.md` (new 2026-06-04). It covers all **3** Krea nodes, giving an agent the node IDs and params, the style→generation workflow, the reference-image and moodboard models, auth/failure modes, execution semantics, and the only-Krea-2-plus-styles scope boundary.

What it covers:
- **The 3 nodes and their IDs/params** — `krea-2-generate`, `krea-style-search`, `krea-style-train` — with the param enums (variants, aspect ratios, creativity, training models, `training_type`) and the `visibleWhen` quirk that hides `learning_rate`/`batch_size` for Qwen/Z-Image.
- **The style → generation workflow** — how to chain Style Search or Style Train into Krea 2's `styles` input, and how `style_id`/`style_strength` map.
- **The reference-image path** — `style_images` accepts upstream image outputs and local files (auto-uploaded to `/assets`), with real strength semantics (`style_reference_strength`, 0–1, default 0.5; max 10 refs).
- **The moodboard model** — native Nebula moodboards vs. raw Krea `moodboard_id`, the one-moodboard limit, and how a moodboard injects reference images plus a prompt suffix.
- **Auth + failure modes** — `KREA_API_TOKEN`, the `402` balance-depleted error, required `prompt`/`name` validation, and the `resolution=1K`-only constraint.
- **Execution semantics** — async-poll for generate/train (submit → poll `/jobs/{id}`), sync for search; outputs include a `job` object alongside the image/style.
- **Scope boundary** — only Krea 2 + styles are exposed; video/editing/upscaling/other-model needs should be routed to another Nebula provider.

## Sources

- https://docs.krea.ai/llms.txt — complete documentation index (full endpoint list)
- https://docs.krea.ai/api-reference/introduction.md — API reference overview, base URL, async job model
- https://docs.krea.ai/api-reference/krea/krea-2-medium.md / krea-2-large.md / krea-2-medium-turbo.md — Krea 2 generation endpoints
- https://docs.krea.ai/api-reference/styles/search-styles.md, train-a-custom-style-lora.md, share-a-style-with-your-workspace.md — styles & training
- https://docs.krea.ai/api-reference/assets/upload-an-asset.md — asset upload
- https://docs.krea.ai/api-reference/general/get-a-job-by-id.md — job lifecycle / polling
- https://docs.krea.ai/api-reference/image/flux-kontext.md — image editing endpoint (unused by Nebula)
- https://docs.krea.ai/api-reference/video/veo-31.md — representative video endpoint (unused by Nebula)
- https://docs.krea.ai/api-reference/image-enhance/topaz.md — Topaz upscaler (unused by Nebula)
- https://docs.krea.ai/api-reference/node-apps/execute-a-node-app.md — node-apps execution (unused by Nebula)
- https://docs.krea.ai/3-d.md — 3D feature (user-facing, no documented API endpoint)

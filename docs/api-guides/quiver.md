# QuiverAI (Arrow) in Nebula Nodes

> QuiverAI's Arrow models turn a text prompt — or any raster image — into clean, editable **SVG vector graphics** right on your Nebula canvas.

## What you can make

**Vector graphics (SVG)**

- **Icons, logos, and marks** from a text description ("a minimalist origami crane, single thin stroke").
- **Flat illustrations and spot art** as resolution-independent SVG you can scale to any size without blur.
- **Vectorized versions of existing images** — drop in a PNG/JPG logo or flat illustration and get back a traced, editable SVG.
- **Style-guided variations** — steer generation with reference images (up to 16) plus free-form style instructions, and ask for several outputs at once.

Everything Arrow produces is true SVG markup (not a rasterized preview), so the result is crisp at any scale and editable in any vector tool. Nebula streams the drawing in progressively, so you watch the graphic take shape while it generates.

## Nodes available in Nebula (2)

| Node (as shown in app) | Node ID | Type | Key inputs | Notable params | Use it for |
|---|---|---|---|---|---|
| Quiver Arrow Generate | `quiver-arrow-generate` | image-gen (`POST /v1/svgs/generations`) | `prompt` (Text, required); `references` (Image, optional, up to 16) | `model` (arrow-1.1 / arrow-1.1-max / arrow-1), `n` (1–16 outputs), `instructions`, `temperature`, `top_p`, `presence_penalty`, `max_output_tokens` | Making a brand-new icon, logo, or flat illustration as SVG from a written description, optionally guided by reference images. |
| Quiver Arrow Vectorize | `quiver-arrow-vectorize` | image-gen (`POST /v1/svgs/vectorizations`) | `image` (Image, required, single) | `model` (arrow-1.1 / arrow-1.1-max / arrow-1), `auto_crop`, `target_size` (128–4096 px), `temperature`, `top_p`, `presence_penalty`, `max_output_tokens` | Converting a raster PNG/JPG (a logo, screenshot, flat illustration) into a clean, editable SVG. |

Both nodes output a single **`svg`** port (data type `SVG`), which you can preview on the canvas, download, or feed into any downstream node that accepts an SVG/image.

**Models (shared by both nodes), cheapest first:**

- **Arrow 1.1** — the default. Generate = 20 credits, vectorize = 15 credits. Allows up to 4 reference images.
- **Arrow 1.1 max** — higher-quality variant. Generate = 25 credits, vectorize = 20 credits. Allows up to 16 reference images.
- **Arrow 1** — legacy. 30 credits for either operation. Allows up to 4 reference images.

The credit cost is shown right in the model dropdown so you can see the price before you pick a variant.

## How to use it in Nebula

**Where the nodes live.** Open the node palette and look under the **Image Generation** category (both nodes are `category: image-gen`). Search "Quiver" or "Arrow" to find **Quiver Arrow Generate** and **Quiver Arrow Vectorize**. Drag either onto the canvas.

**API-key setup (one-time).**

1. Create an API key in the QuiverAI dashboard (app.quiver.ai → API keys).
2. Open Nebula **Settings**, paste it into the **Quiver** field (`QUIVER_API_KEY`), and choose **Save Settings**.
3. Nebula stores it under `apiKeys.QUIVER_API_KEY` in the project-root `settings.json`; no restart is required. Every Quiver node uses this key; without it the node fails fast with "QUIVER_API_KEY is required."

Billing is QuiverAI's prepaid **credit pool** (Free tier ≈ 200 credits/week, paid tiers more). Each call's exact cost comes back from QuiverAI and is what the dropdown labels quote. If you run out, the node surfaces "Insufficient QuiverAI credits — top up or upgrade plan."

**Recipe 1 — Text → icon (the basic move).**
1. Drop a **Quiver Arrow Generate** node (`quiver-arrow-generate`).
2. Connect a text source (or type into the `prompt` port) like *"a minimalist mountain range logo, single continuous thin stroke, no fill."*
3. In `instructions`, add formatting guidance such as *"uniform 2px stroke, transparent background."*
4. Leave `model` on **Arrow 1.1**, `n` = 1, run it. Watch the SVG draw in progressively; the finished vector lands on the `svg` output.

**Recipe 2 — Raster logo → clean SVG.**
1. Drop a **Quiver Arrow Vectorize** node (`quiver-arrow-vectorize`).
2. Feed its `image` input a raster file — an upload, an external image URL, or the output of an upstream image node.
3. Turn on `auto_crop` to trim to the main subject, and set `target_size` (e.g. 1024) for the working resolution before tracing.
4. Run it to get an editable SVG trace. Works best on clean logos and flat art; busy photographic input produces noisy paths.

**Recipe 3 — Generate several on-brand variations.**
1. Drop a **Quiver Arrow Generate** node and switch `model` to **Arrow 1.1 max** (so you can attach up to 16 references).
2. Connect 2–4 existing brand marks into the `references` input (it accepts multiple image connections).
3. Set `n` to 4 to get four candidate SVGs in one run, nudge `temperature` up slightly (e.g. 1.2) for more variety, and describe the new asset in `prompt`.
4. Pick the SVG you like best from the outputs.

> Tip: keep an eye on the per-model reference cap. **Arrow 1.1** and **Arrow 1** accept only **4** reference images; only **Arrow 1.1 max** accepts up to **16**. Attaching more references than the chosen model allows will be rejected by QuiverAI.

## API coverage — what Nebula uses vs. what QuiverAI (Arrow) offers

| Capability / Endpoint | In the API | In Nebula | Notes |
|---|---|---|---|
| Text → SVG generation (`POST /v1/svgs/generations`) | Yes | **full** | `Quiver Arrow Generate` node. All documented params wired: model, prompt, references, n, instructions, temperature, top_p, presence_penalty, max_output_tokens. |
| Image → SVG vectorization (`POST /v1/svgs/vectorizations`) | Yes | **full** | `Quiver Arrow Vectorize` node. model, image, auto_crop, target_size, and all sampling params wired. |
| SSE streaming on both POST endpoints | Yes | **full** | Both handlers always stream; progressive `draft` SVGs render live on the canvas, `content` is the final. |
| Reference images on generate (up to 16) | Yes | **full** | `references` input port (multiple, max 16). Note: the per-model cap (4 for arrow-1/1.1) is enforced server-side by QuiverAI, not pre-validated in the node UI. |
| Multiple outputs per call (`n`, 1–16) | Yes | **full** | `n` param on the generate node. |
| List models (`GET /v1/models`) | Yes | **partial** | Used internally by a backend proxy route (`/api/quiver/models`) to populate the model dropdown — not exposed as its own user-facing node. |
| Get single model (`GET /v1/models/{id}`) | Yes | **none** | Implemented in the client (`QuiverClient.get_model`) but not surfaced anywhere in the UI. |
| SVG edit (`svg_edit` operation) | Defined in the models schema, **no shipped endpoint** | **none** | Listed in the `supported_operations` enum but no model advertises it and there is no `/v1/svgs/edits` endpoint. Nothing for Nebula to wire yet. |

Coverage: ~85% of the QuiverAI (Arrow) API surface is exposed in Nebula. (Both core SVG-creation endpoints — the entire user-facing capability of the API — are fully wired, including streaming, references, and multi-output. The only true API features not surfaced are the read-only `GET /v1/models/{id}` detail call and the partial, internal-only use of `GET /v1/models`.)

Notable unused capabilities: a user-facing **model-detail / model-list browser** (the `/v1/models` data is fetched only to fill the dropdown; `get_model` is unused), and the schema-defined-but-**unshipped** `svg_edit` operation (and any future `svg_animate`) — neither has a live endpoint on QuiverAI yet, so there is nothing functional to expose today; revisit when QuiverAI ships those endpoints.

## Agent skill coverage

**A complete skill exists** at `.claude/skills/quiver/SKILL.md` (new 2026-06-04). It covers both **2** QuiverAI (Arrow) SVG nodes, giving an agent the node-wiring reference, model-selection guidance, generate-vs-vectorize choice, input-plumbing rules, SVG prompt/instructions craft, and setup/failure modes.

What it covers:

- **Node-wiring reference** for both nodes — exact IDs (`quiver-arrow-generate`, `quiver-arrow-vectorize`), the `svg` output port, input ports (`prompt`, `references`, `image`), and every param with its type/range/default.
- **Model-selection guidance** — the three model IDs, their credit costs (generate vs. vectorize differ), and the **per-model reference caps** (4 for arrow-1/arrow-1.1, 16 for arrow-1.1-max) so an agent never over-attaches references and triggers a 400.
- **When to generate vs. vectorize** — `generate` for net-new art, `vectorize` for converting a raster, with the "clean flat art vectorizes well, photos produce noisy paths" caveat.
- **Input-plumbing & streaming** — `references` accepts external URLs, data URIs, `/api/outputs/...` paths, or local files; vectorize's `image` is a single input; both endpoints stream draft SVGs over SSE; how SVG outputs chain downstream.
- **Setup + failure modes** — `QUIVER_API_KEY`, the credit-pool billing model, and the user-facing error strings (auth failed, insufficient credits, rate limit).
- **Capability boundary** — the schema-defined `svg_edit` operation has no shipped endpoint, so it is not wired.

## Sources

- https://docs.quiver.ai — landing / overview (capabilities: generate + vectorize SVG)
- https://docs.quiver.ai/llms.txt — documentation + endpoint index
- https://docs.quiver.ai/api-reference/introduction.md — base URL, auth, full endpoint list, rate limits, error codes
- https://docs.quiver.ai/api-reference/models/list-models.md — model fields and `supported_operations` enum (svg_generate, svg_edit, svg_vectorize)
- https://api.quiver.ai/v1/openapi.json — canonical machine-readable OpenAPI spec (referenced)

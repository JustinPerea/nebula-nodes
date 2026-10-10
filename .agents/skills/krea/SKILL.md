---
name: krea
description: Use when building or editing a Nebula graph with Krea image/video/audio/enhance/3D provider nodes, Krea 2, image style references, styles, moodboards, style search or training, library management, or 3D export. Covers the schema-generated model catalog, exact node IDs and ports, direct-Krea routing, media upload, async jobs, legacy style wiring, credentials, and verification boundaries.
---

# Krea — Nebula Integration

Use Krea direct API nodes when the user chooses Krea. FAL Krea endpoints and automatic routing through another provider are not part of this integration.

Current gateway contract (image, video, audio, enhance, 3D): `docs/model-providers/krea/krea-gateway.md`. User-facing setup and recipes: `docs/api-guides/krea.md`. The older `docs/model-providers/krea/krea-2.md` describes the preserved legacy wrapper; it is not the full current provider catalog.

## Account connection through MCP

Setup: `docs/KREA-MCP.md`. Every Krea node that calls Krea persists `_kreaAuth` as `api-token`
or `mcp`. Missing values on old graphs mean `api-token`. Account/MCP runs use
the consent-selected workspace's compute; API-token runs use API balance.
Never change that billing source implicitly or fall back to another connection.
Connect/check/refresh only authenticate or discover; generation requires an
explicit graph run. The managed agent MCP bridge exposes only read-only
discovery: `list_models`, `get_model_schema`, `get_prompting_guide`,
`list_styles`, `list_moodboards`, `get_node_apps`, `get_node_app_versions`
and `list_node_types`. Krea Files are not on the bridge. Generate, train, create
or delete through Nebula GRAPH commands, with `_kreaAuth=mcp` when the user
chooses their connected Krea account. Krea Moodboards and Krea Moodboard
Create only offer `mcp`; Krea 3D Export only works with an API token.

## Gateway Model Nodes

The public Krea OpenAPI catalog checked **2026-10-09** defines **34 image, 41 video, 5 audio, 18 enhance and 10 3D routes** (108) included as specific first-class Nebula nodes. Canvas supports the full catalog. Create exposes models compatible with its prompt, image attachments, and simple controls; Runway's tagged references, H3 camera trajectories, and Flux Video Edit require Canvas. The nodes have model-specific controls and connectable prompt/media ports; JSON fields hold complex parameters, not a model selection UI.

Node IDs are `krea-` plus the API path after `/generate/`, with non-alphanumeric characters replaced by hyphens. For example:

| Model | Node ID | Input examples |
|---|---|---|
| Nano Banana 2 | `krea-image-google-nano-banana-2` | `prompt`, optional `image_urls` |
| GPT Image 2 (Krea's ChatGPT 2 label) | `krea-image-openai-gpt-image-2` | `prompt`, optional `image_urls` |
| Krea 2 Turbo | `krea-image-krea-krea-2-medium-turbo` | `prompt`, optional `image_url` |
| Kling 3.0 | `krea-video-kling-kling-3-0` | `prompt`, optional `start_image`/`end_image` |
| Veo 3.1 | `krea-video-google-veo-3-1` | `prompt`, optional image inputs |
| Seedance 2.0 | `krea-video-bytedance-seedance-2` | `prompt`, optional media references |
| ElevenLabs Music v2.5 | `krea-audio-elevenlabs-music-v2-5` | `prompt`, optional `music_length_ms`/`force_instrumental` |

Inspect `backend/data/node_definitions.json` for the actual ports and parameter definitions before wiring a model. `docs/MODEL_REFERENCE.md` is generated from that registry; do not edit it manually. Do not infer a route from a display name or reconstruct the API path from a sanitized node ID.

Catalog source metadata and exact request schemas live in `backend/data/krea_gateway_models.json`. Use `python3 scripts/sync-krea-catalog.py --check` for an offline consistency check; the script's default mode regenerates offline, while `--refresh` fetches only the public OpenAPI. These are catalog operations, not generation runs.

Image model outputs are `image` (Image), `images` (Array), and `job` (Any); video outputs are `video` (Video), `videos` (Array), and `job` (Any); audio outputs are `audio` (Audio), `audios` (Array), and `job` (Any); enhance outputs Image or Video (whichever it upscales) the same way; 3D outputs are `mesh` (Mesh), `meshes` (Array), and `job` (Any). All also emit `artifacts` (Array), containing typed local records, including previews when present. Complex object/array inputs can use structured `Any` bindings, while media arrays expose their specific media type and schema-defined connection limits.

### Gateway Graph Rules

- Keep the user's chosen Krea node/provider identity. Other configured provider keys are not fallback authorization.
- Use each model's exact inputs and enums. `image_url`, `image_urls`, `start_image`, and `reference_images` have different meanings and limits across schemas.
- Supply prompt/media fields through connections or controls. Gateway ports are optional connections; required request fields remain enforced by the schema before submission. A prompt entered in the node does not also need a connected Text port.
- Create attachments target only the first Image port. Use Canvas for separate start/end frames, reference roles, and advanced JSON/video inputs. Cinema's base-model allowlist is separate and does not include this catalog.
- Connect local/upstream media through its supported port so Nebula can upload it before submission. Do not put unresolved local file paths in advanced JSON.
- Complex optional fields need canonical JSON objects/arrays. For Kling `multi_prompt`, an example is `[{"prompt":"Wide shot","duration":3},{"prompt":"Close-up","duration":2}]`. Leave optional fields empty when unnecessary.
- Do not transfer parameters blindly across models. Duration, resolution spelling, audio, and reference limits are model-specific.
- Catalog presence verifies a documented route/schema, not paid execution or universal workspace access. No real provider run was used to establish the 2026-10-09 catalog.
- Krea saved node apps are outside this catalog. To convert a 3D result to OBJ/FBX/STL/PLY, wire its `job` output into `krea-3d-export` (API token).

Generation is async: submit, retain the job ID, poll pending states, then materialize completed media locally. On Stop, unwind local work and request provider cancellation after the job ID is known; do not guarantee that remote work stopped. Keep prior completed outputs/history. Krea job errors are top-level `error` in the current schema, and output URL shapes can differ; see the gateway contract rather than assuming `result.urls[0]` always suffices.

## Legacy Node IDs

| Node | Purpose |
|---|---|
| `krea-2-generate` | Krea 2 Medium/Large text-to-image with image style references, styles, and one moodboard |
| `krea-image-style-reference` | Wrap one image with per-reference strength `0..1` |
| `krea-style` | Wrap an existing Krea style/LoRA ID with strength `-2..2` |
| `krea-moodboard` | Wrap an existing Krea moodboard ID with strength `0..1` |
| `nebula-moodboard` | Nebula-native provider-neutral moodboard; Krea consumes it as style image references plus a style-brief prompt suffix |
| `krea-style-search` | List/search Krea styles from the authenticated API workspace/public filters |
| `krea-style-train` | Train a Krea style from image inputs and emit a style object plus style ID. `k1` and `ltx-23-22b` train only on the Krea account; learning rate, batch size, steps, `Default` type and workspace share only with an API token |
| `krea-moodboard-search` | Krea account only: list the account's moodboards (incl. Krea presets); outputs the first name match as a wireable moodboard |
| `krea-moodboard-create` | Krea account only: create and analyze a moodboard from images; outputs the moodboard |
| `krea-library-manage` | Rename or delete a style or moodboard. Deletes take only a typed `item_id` (never a wired one) and need `confirm_delete` set to that same ID; an API token can only rename styles |
| `krea-3d-export` | API token only: export a Krea 3D job to OBJ/FBX/STL/PLY and unpack it |
| `krea-job-history` | List past jobs (API token) or fetch one job by ID (either path); optionally save completed media into the run |
| `krea-node-app` | Run one node app version with schema-checked inputs; wired images fill image fields in order, wired text the first text field. Account path: public and workspace-shared apps only |
| `krea-files` | Krea account only: list Krea Files by scope, type, tags or folder and bring media, SVG or text into the run |
| `krea-files-save` | Krea account only: save local Nebula media (raw-byte upload) or text into Krea Files, optionally in a folder and with tags |
| `krea-nodes-workflow` | Krea account only: create a Krea Nodes workflow (returns an Open in Krea Nodes link), or read/edit one by typed workflow ID |
| `krea-agent` | Krea account only: send one Krea Agent turn and wait for its deliverables. Bills the workspace; Stop only stops waiting |
| `krea-desktop` | Krea account only: list connected desktop apps and tools, or run one tool with a typed app ID. Changes the open project immediately |
| `krea-usage` | Workspace usage (compute units per job) with an enterprise service key `KREA_USAGE_KEY`; personal tokens are refused |

The original six Krea nodes are preserved alongside the new catalog; `nebula-moodboard` is a separate provider-neutral node. Use `krea-2-generate` for the established wrapper-node style/moodboard adaptation below. New Krea 2 route nodes expose the canonical API fields, including Turbo, image-to-image strength, `3:4`, and generative sliders; their defaults and raw JSON shapes do not alter the legacy wrapper contract.

## Auth

- Nebula expects `KREA_API_TOKEN` in settings/API keys. `KREA_API_KEY` is accepted as a fallback by the backend handler.
- Krea API balance is separate from workspace compute balance. A valid token can still return `402` until the API balance is topped up.
- API access must also be enabled for the Krea workspace. Public catalog discovery does not validate the token or API balance.
- Never store or print user tokens in docs, screenshots, logs, or skill files.

## Legacy Krea 2 Generate

Required port:
- `prompt` (`Text`)

Optional ports:
- `style_images` (`Image`, multiple, max 10): simple style references. The handler uploads local/generated images to Krea assets and maps them to `image_style_references`.
- `image_style_references` (`Any`, multiple, max 10): outputs from `krea-image-style-reference`.
- `styles` (`Any`, multiple): outputs from `krea-style` or `krea-style-train`.
- `moodboard` (`Any`, max 1): output from `krea-moodboard`.
  - Can also accept a Nebula-native `Moodboard` output from `nebula-moodboard`; the handler adapts representative images to Krea `image_style_references` because Krea does not expose public moodboard creation.

Params:
- `variant`: `medium` or `large`
- `aspect_ratio`: `1:1`, `4:3`, `3:2`, `16:9`, `2.35:1`, `4:5`, `2:3`, `9:16`
- `resolution`: `1K` only
- `creativity`: `raw`, `low`, `medium`, `high`
- `seed`: optional integer
- `style_reference_strength`: fallback strength for raw `style_images`
- `style_id` / `style_strength`: fallback manual style ID
- `moodboard_id` / `moodboard_strength`: fallback manual moodboard ID

## Graph Patterns

Basic text-to-image:

```text
text-input:text -> krea-2-generate:prompt
```

Image style reference with a per-image strength:

```text
text-input:text -> krea-2-generate:prompt
image-input:image -> krea-image-style-reference:image
krea-image-style-reference:image_style_reference -> krea-2-generate:image_style_references
```

Raw style images when one shared strength is enough:

```text
text-input:text -> krea-2-generate:prompt
image-input:image -> krea-2-generate:style_images
```

Existing style ID:

```text
krea-style-search -> inspect returned style IDs
krea-style:style -> krea-2-generate:styles
```

New trained style:

```text
image-input:image -> krea-style-train:images
krea-style-train:style -> krea-2-generate:styles
```

Existing moodboard ID:

```text
krea-moodboard:moodboard -> krea-2-generate:moodboard
```

Nebula-native moodboard:

```text
nebula-moodboard:moodboard -> krea-2-generate:moodboard
```

## Resource Rules

- Use `krea-image-style-reference` when different style images need different strengths.
- Use raw `style_images` only when one fallback `style_reference_strength` is acceptable for every image.
- Use `krea-style-search` to find style IDs, then `krea-style` to pass one into `krea-2-generate`.
- Use `krea-style-train` when the user wants to create a new Krea style from images. Its `style` output can feed directly into `krea-2-generate.styles`.
- Krea moodboards are referenced by existing ID. The verified Krea API docs did not expose public moodboard create/list endpoints, so Nebula cannot create Krea-owned moodboards directly yet.
- Nebula-native moodboards are separate provider-neutral assets. When wired into Krea 2, representative images become Krea image style references and the extracted style brief is appended to the prompt.
- `krea-2-generate` accepts at most 10 image style references and at most 1 moodboard.
- `krea-style` strength supports `-2..2`; image style reference and moodboard strengths support `0..1`.

## Provider Resource Objects

Wrapper nodes intentionally emit provider-specific objects on `Any` ports:

- Image style reference: `{ kind: "krea_image_style_reference", image, strength }`
- Style: `{ kind: "krea_style", id, strength }`
- Krea moodboard: `{ kind: "krea_moodboard", id, strength }`
- Nebula moodboard: `{ kind: "nebula_moodboard", moodboardId, name, mode, strength, images, analysis, styleBrief, negativePrompt, palette, representativeImages, providerHints }`

Do not hand-roll these shapes unless necessary. Prefer the wrapper nodes so the graph is inspectable and users can tune strengths from the UI.

## Agent Workflow

1. Choose the specific direct Krea image/video node matching the requested model, or use the legacy Krea 2 workflow when wrapper-node styling is needed. Do not silently choose another provider.
2. Inspect the selected node's schema and supply required fields through connections or controls before running. For legacy Krea 2, keep first-run defaults conservative: `variant: medium`, `resolution: 1K`, `creativity: low` or `medium`.
3. For legacy Krea 2 styling with multiple visual references, prefer `krea-image-style-reference` nodes so each strength is explicit. For gateway models, use their specific reference inputs.
4. For a reusable Krea 2 style, use `krea-style-train`; if a style ID already exists, use `krea-style` with the legacy generation workflow.
5. Use a Nebula-native moodboard through its documented Krea 2 adaptation, or an existing ID for a Krea-owned moodboard. Do not claim Nebula can create Krea-owned moodboards through the API.
6. Treat catalog/schema checks, deterministic tests, credential reads, and paid generation receipts as separate evidence. A style-search success does not prove generation balance or every model's runtime availability. Do not claim a paid generation without its actual receipt.

## Validation

Useful checks after editing Krea nodes or handlers:

```bash
backend/.venv/bin/python -m pytest -o pythonpath=backend backend/tests/test_krea_catalog.py backend/tests/test_krea_gateway.py backend/tests/test_krea_handler.py backend/tests/test_node_registry.py backend/tests/test_node_contracts.py -q
python3 scripts/sync-krea-catalog.py --check
node scripts/check-node-contracts.mjs
```

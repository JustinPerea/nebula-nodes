---
name: krea
description: Use when building or editing a Nebula graph with Krea image/video/audio/enhance/3D provider nodes, Krea 2, Krea 3 (krea-3, Krea or fal), the Krea route of the FLUX 3 video nodes, image style references, styles, moodboards, style search or training, library management, or 3D export. Covers the schema-generated model catalog, exact node IDs and ports, direct-Krea routing, media upload, async jobs, legacy style wiring, credentials, and verification boundaries.
---

# Krea — Nebula Integration

Use Krea direct API nodes when the user chooses Krea. Two kinds of node also reach Krea or Krea models another way, and only by the rules below: the maker-route copies (a Krea copy that runs on the model maker's own key, see Maker routes) and the route-table nodes (one node per model with a provider switcher, where Krea is one route: Krea 3 and the FLUX 3 video nodes, see "Krea 3 and the FLUX 3 nodes"). A fal Krea endpoint is reachable only as Krea 3's fal route.

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
or delete through Nebula GRAPH commands. Which way a node bills is the user's
call: an agent's direct edit, project save or run request that changes
`_kreaAuth` (or brings in a dual-mode node set to `mcp`) is refused, so propose the change (`propose_change`, `nebula
propose`) and let the user accept it. Agent runs billed to the plan count
against the "Krea plan runs" limit in Settings (10 until the user picks one). Krea Moodboards and Krea Moodboard
Create only offer `mcp`; Krea 3D Export only works with an API token.

## Maker routes (Nano Banana on your Google key)

Since 2026-10-14 four Krea copies also run on Google's Gemini API with the
person's `GOOGLE_API_KEY`: `krea-image-google-nano-banana-2`
(`gemini-3.1-flash-image`), `-pro` (`gemini-3-pro-image`), `-flash-lite`
(`gemini-3.1-flash-lite-image`) and `krea-image-google-nano-banana`
(`gemini-2.5-flash-image`). The list lives in `scripts/sync-krea-catalog.py`
`DIRECT_ROUTES`; the generator writes `envKeyName: ["GOOGLE_API_KEY",
"KREA_API_TOKEN"]`, `directKeyName`, `sharedParams`/`falParams` (the
Krea-only `width`/`height`) and `directRoute`, plus a `routes` price entry
(Krea and Google). Never hand-edit those nodes.

Precedence, the same in the router, pricing, the spend gate, readiness and
the cache key (`backend/services/node_route.py`):

1. `_kreaAuth == "mcp"`: the Krea plan, whatever keys are set.
2. else `GOOGLE_API_KEY` set and the recipe has no explicit `width`/`height`
   (`directRoute.blockedBy`; Google can't render an exact size): Google, billed
   by Google. `krea-image-google-nano-banana` (2.5) leaves Google on
   2027-03-15, Google's listed shutdown (`node_route.DIRECT_RETIRES`).
3. else `KREA_API_TOKEN`: the Krea API, billed to API balance.

So an `api-token` node runs on Google once a Google key is saved; a person
who wants Krea's API for it removes the key or picks the Krea plan. On the
Google route the node fills `image`, `images` and `artifacts` (no Krea `job`).

Google lane (2026-10-14, `backend/execution/maker_routes_google.py`):

- `krea-image-google-nano-banana-2-1` -> `gemini-nano-banana-2.1` on
  `GOOGLE_API_KEY` (Interactions API); `thinking_level` reaches Google.
  `width`/`height` keep it on Krea.
- `krea-video-google-veo-3-1` / `-fast` / `-lite` -> Vertex
  `veo-3.1-*-generate-001` on `GOOGLE_VERTEX_CREDENTIALS` only (a Gemini API
  key alone leaves them on Krea). `directRoute.rejects` keeps Fast at
  `resolution: 4K` on Krea (Vertex: Fast is 720p/1080p). Reference images run
  on Vertex only at duration 8, not at 4K and not with start/end frames;
  other combinations are refused before any request.
- `krea-video-google-gemini-omni-flash-1-1` -> `gemini-omni-1.1-flash` on
  `GOOGLE_API_KEY`; `duration` -> `response_format.duration` ("8s"); start
  image -> `image_to_video`, references -> `reference_to_video`; both
  together is refused.
- No maker route: Veo 2 / 3 / 3 Fast (retired 2026-06-30) and Gemini Omni
  Flash 1.0 (preview ends 2026-10-22).

Since 2026-10-14 the OpenAI copies do the same with `OPENAI_API_KEY`
(`execution/maker_routes_openai.py`, translation `krea-openai-image`):
`krea-image-openai-gpt-image-2` (`gpt-image-2`; `width`/`height` are
Krea-only and keep a run on Krea), `-2-5-flare` and `-2-5-sunburst`
(`gpt-image-2.5-*`; every Krea field reaches OpenAI). `aspect_ratio` x
`resolution` map to the fixed `KREA_OPENAI_SIZES` table (16:9 at 2K =
2048x1152, 1:1 at 4K = 2880x2880); only one of the two set means 1:1 or 1K.
References in `image_urls` send the run to `/v1/images/edits` (public https
URLs are fetched first). Their OpenAI route is unpriced: OpenAI publishes no
per-image price for these models' default sizes. `krea-image-openai-gpt-image`
has no maker route (its OpenAI model isn't confirmed).

## Maker routes (Grok Imagine on your xAI key)

Since 2026-10-14 four Krea copies also run on xAI's own API with the
person's `XAI_API_KEY` (`backend/execution/maker_routes_xai.py`):
`krea-image-xai-grok-imagine-2` and `-2-edit` (`grok-imagine-image-2.0`),
`krea-video-xai-grok-video` (`grok-imagine-video`) and
`krea-video-xai-grok-video-1-5` (`grok-imagine-video-1.5`). Same
precedence as Nano Banana: the Krea plan, else the xAI key, else
`KREA_API_TOKEN`. Krea-only fields that keep a run on Krea, whether saved or
wired into the port: Grok 2.0's `style_images` (xAI has no style references)
and `start_video` on both Grok video copies (Krea doesn't say what it
means, so it isn't mapped to xAI's extensions). Grok video also stays on Krea
for a duration that isn't whole seconds in 1-15 and for combinations xAI
doesn't document on one request (an edit with a start image or references, a
start image with references): `directRoute.accepts` / `rejectsWhen`. The overlay is `XAI_DIRECT_ROUTES` in `scripts/sync-krea-catalog.py`.

### Ideogram and Runway copies (2026-10-14)

Same rule, other makers (`execution/maker_routes_ideogram_runway.py`):
`krea-image-ideogram-ideogram-4-5-precise` (`/v2/image/precise-edit/ideogram-4-5`),
`-ideogram-3` (`/v1/ideogram-v3/generate`, DEFAULT speed, one character ref) and
`-ideogram-2-turbo` (`/v2/image/generate/ideogram-2a`, turbo) on
`IDEOGRAM_API_KEY`; `krea-image-runway-gen-4-image` (`gen4_image`),
`krea-video-runway-gen-4-5` (`gen4.5`) and `krea-enhance-runway-ruby` (`ruby`,
`/v1/video_to_hdr`) on `RUNWAY_API_KEY`. On the maker route width/height round
to the nearest size the maker takes (`backend/services/maker_sizes.py`: Ideogram
3's 69 resolutions, Ideogram 2a's 15 ratios, gen4_image's 16 sizes);
`describe_node` says so in `sizeNote`, and run results carry `notes` with the
size made. On Krea they are sent as given. Ideogram 3 `style_images` (per-image strength) keep a run on
Krea, saved or wired. Gen-4.5 stays on Krea at Krea's 672:1584 (not in Runway's
gen4.5 request schema) and for text-to-video (no start image, saved or wired) at
any ratio but 1280:720 / 720:1280 (`directRoute.rejects` and `rejectsWhen` with
`"(unset)"`). `krea-image-ideogram-ideogram-4-5` and
`krea-video-runway-gen-4-video` stay Krea-only (size presets / upstream model
not confirmed).

## Maker routes (MiniMax and Meshy on your own keys)

Since 2026-10-14 five more Krea copies run on the maker's own API when the
maker key is saved (same precedence as Nano Banana: the Krea plan first, then
the maker key, then `KREA_API_TOKEN`; overlay `MINIMAX_MESHY_ROUTES` in
`scripts/sync-krea-catalog.py`, translations in
`backend/execution/maker_routes_minimax_meshy.py`):

| Krea node | Maker key | Maker model / endpoint | Stays on Krea when |
|---|---|---|---|
| `krea-video-minimax-hailuo-02` | `MINIMAX_API_KEY` | `MiniMax-Hailuo-02`, `POST /v1/video_generation` (T2V, I2V, first+last frame) | duration isn't 6 or 10; 1080p at 10 s |
| `krea-video-minimax-hailuo-2-3` | `MINIMAX_API_KEY` | `MiniMax-Hailuo-2.3` | a saved `end_image`; 1080p at 10 s |
| `krea-video-minimax-hailuo-2-3-fast` | `MINIMAX_API_KEY` | `MiniMax-Hailuo-2.3-Fast` (image-to-video only) | a saved `end_image`; 1080p at 10 s |
| `krea-video-minimax-hailuo-3` | `MINIMAX_API_KEY` | `MiniMax-H3`, `POST /v2/video_generation` | a saved `reference_video_seconds` |
| `krea-3d-meshy-meshy-7` | `MESHY_API_KEY` | `ai_model: meshy-7` on text-to-3D / image-to-3D / multi-image-to-3D | (none) |

What route selection can't see (a wired port) is refused before any call, with
the fix: an end image wired into Hailuo 2.3 / 2.3 Fast, 2.3 Fast with no start
image, Hailuo 02 at 512p without a start image (or with an end image), H3
text-to-video with `aspect_ratio: adaptive`, H3 frames mixed with references,
and Meshy image mode with more than 4 images. To keep any of these on Krea,
pick the Krea plan or remove the maker key.

H3's direct route adds `resolution` (`2K` default, matching Krea's H3 price;
or `768P`). MiniMax says H3 needs its pay-as-you-go API (or an M Plan
Explore/Build Subscription Key); Video Packages don't cover it, and the error
says so. Not routed: `krea-video-minimax-hailuo` (upstream model not
confirmed), `-h3-max` and `-h3-max-turbo` (which Krea node is MiniMax's
`MiniMax-H3-Max` is ambiguous), `-h3-max-camera-controls` (no maker field).

### ElevenLabs copies on the person's ElevenLabs key

Same mechanism (`DIRECT_ROUTES`, translations in
`backend/execution/maker_routes_elevenlabs.py`): `krea-audio-elevenlabs-tts`
(`POST /v1/text-to-speech/{voice_id}`, Krea's `voice_id`/`model_id` are
ElevenLabs ids) and `krea-audio-elevenlabs-music`, `-music-v2`, `-music-v2-5`
(`POST /v1/music` with `music_v1`, `music_v2`, `music_v2_5`) run on
`ELEVENLABS_API_KEY` when it is set, unless `_kreaAuth` is `mcp`. Nothing is
Krea-only on these, so there is no blocker. The music copies carry an
ElevenLabs route price ($0.15 per minute from `music_length_ms`); TTS has none.

## Maker routes (Seedream on your BytePlus key)

The Seedream copies `krea-image-bytedance-seedream-4` (`seedream-4-0-250828`),
`-seedream-5-lite` (`seedream-5-0-lite-260128`) and `-seedream-5-pro`
(`dola-seedream-5-0-pro-260628`) also run on BytePlus ModelArk with the
person's `BYTEPLUS_API_KEY`, same precedence as above (Krea plan, then the
maker key, then `KREA_API_TOKEN`). Also from the `DIRECT_ROUTES` overlay:
`style_images` is a blocker (set ones stay on Krea), `seed` is Krea-only and
dropped on BytePlus, and `directRoute.size` keeps a width x height outside
ModelArk's pixel limits on Krea. `directRoute.setup: "fallback"` keeps
first-time setup on the Krea token, because BytePlus isn't offered in the
United States. Details: the `byteplus` skill.

The Seedance copies `krea-video-bytedance-seedance-1-0-pro`, `-1-0-pro-fast`,
`-2`, `-2-fast`, `-2-mini` and `-2-5` take the same BytePlus route (ModelArk
video tasks). Blockers: `seed` (2.x), `effects` (2.0, 2.0 fast, 2.5),
`start_video` (1.0), `reference_images` (1.0 pro). `directRoute.accepts`
keeps Krea-only values on Krea: an `aspect_ratio` ModelArk lacks (9:21), a
non-whole or out-of-range `duration`, and `upscale` / `enhance_prompt` /
`draft` switched on. On BytePlus the node fills `video`, `videos` and
`artifacts`, with no Krea `job`.

## Krea 3 and the FLUX 3 nodes (route tables, 2026-10-15)

These are one node per model with a provider switcher (`_provider`: `auto` or a route id; `docs/PROVIDER-ROUTES.md`). Auto takes the first keyed route in table order, the maker first, and never moves to another provider when a setting doesn't fit: the run stops and offers the routes that take it. An agent proposes a provider change (`propose_change`); a direct edit of `_provider` or `_kreaAuth` is refused.

**`krea-3` "Krea 3"** (Krea is the maker). Ports `prompt`, `images` (up to 8 references; Krea's OpenAPI, MCP schema and docs all say 8).

- Route `krea` first: `/generate/image/krea/krea-3`, API token or plan (`plan: optional`). Early access: Krea 3 on Krea's API is for beta workspaces (sales@krea.ai), and the Krea MCP's guide says closed beta there too. Under Auto, `_kreaAuth: mcp` runs on the plan, and new nodes take the global Krea mode, because Krea is the maker.
- Route `fal` second: `krea/v3/text-to-image`, or `krea/v3/edit` when images are wired.
- Shared: `seed` only. The two providers name everything else differently, and neither documents a mapping, so each route keeps its own settings:
  - Krea: `thinking_mode` fast / high (default fast), `resolution` 1K / 2K (default 1K), `aspect_ratio` (10 values; unset means automatic framing), `regional_edit` (needs a reference image).
  - fal: `model` berry / jam, `reasoning_level` low / medium / high (high needs a reference image), `image_size` (presets or `auto`), `negative_prompt` (berry), `output_format`.
- Hidden settings (PR 5): a route never sends a setting it doesn't show. `negative_prompt` is sent only with `model: berry`. A non-default value of one route's own setting stops the run on the other route (Jam saved under Auto with a Krea token stops on Krea: "it doesn't offer Model Jam (speed)"), and the stop's fix resets it ("Set Model back to Berry (quality)"). `thinking_mode: high` with the provider on fal stops and is unpriced. A click on a provider row resets such a value with a note.
- Prices: Krea $0.03 at 1K, $0.06 at 2K, +$0.02 for high thinking, +$0.02 or $0.07 per reference by the reference's own size (so a range until the run); fal $0.025 per megapixel of output plus references (unconfirmed). Plan runs are unpriced.

**FLUX 3 video copies folded.** `krea-video-black-forest-labs-flux-3-video`, `krea-video-black-forest-labs-flux-video-edit` and `krea-enhance-black-forest-labs-flux-video-upscale` are no longer separate nodes. They are the `krea` route of `flux-3-video`, `flux-video-edit` and `flux-video-upscale` (BFL is the maker; routes bfl, fal, replicate, openrouter, krea; see the `bfl` skill). A saved Krea node loads as the new node with `_provider: "krea"` and its `_kreaAuth` kept, so billing doesn't change on load; `720p`/`1080p` become `hd`/`fhd`, upscale `precise`/`creative` become 0/1, and the upscale port `video_url` becomes `video`. The Krea-only outputs `videos`, `artifacts` and `job` have no port on the new nodes. On these BFL-maker nodes the Krea plan bills only when the person picks the "Krea · plan" row; Auto never picks it.

Catalog: the four endpoints are in `FOLDED` in `scripts/sync-krea-catalog.py`, so `--refresh` can't bring the old nodes back. Their entries stay in `backend/data/krea_gateway_models.json` with `foldedInto`, and `--check` verifies the route's Krea params against that entry's request schema.

## Gateway Model Nodes

The public Krea OpenAPI catalog checked **2026-10-09** defines **34 image, 41 video, 5 audio, 18 enhance and 10 3D routes** (108), each a specific first-class Nebula node, except the three FLUX 3 video routes, which are folded into the FLUX 3 nodes (above). Krea 3 (`/generate/image/krea/krea-3`, added 2026-10-15) is likewise the `krea` route of `krea-3`, not a `krea-*` node. Canvas supports the full catalog. Create exposes models compatible with its prompt, image attachments, and simple controls; Runway's tagged references, H3 camera trajectories, and FLUX Video Edit [fast] (`flux-video-edit`) require Canvas. The nodes have model-specific controls and connectable prompt/media ports; JSON fields hold complex parameters, not a model selection UI.

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
- `moodboard` (`Moodboard`, max 1; `Any` before 2026-10-20): the `moodboard` output of `krea-moodboard`, `krea-moodboard-search` or `krea-moodboard-create`. A Krea moodboard id as text (their `moodboard_id` output, or a typed id) goes in the `moodboard_id` setting instead; the port refuses a new text wire, and a saved graph's old one stays but the run stops and says so. How the node takes a Nebula board is its moodboard adapter entry (`backend/data/moodboard_adapters.json`, `weighted-style`, `handler: reads-board`).
  - Can also accept a Nebula-native `Moodboard` output from `nebula-moodboard`; the handler adapts representative images to Krea `image_style_references` because Krea does not expose public moodboard creation.
  - Board strengths add up to the board's strength (Q21 b, 2026-10-20; `services/moodboard_weights.py` `native_strengths`). The board images that go (heaviest first, after the 10-slot cap minus your wired references, set-aside and weight-0 images left out) get `board.strength x weight / sum(weights sent)`, at 4 decimals by largest remainder, so they sum to exactly the board's strength; a single image goes at the full strength. Krea's guide: "The references blend additively — start with strengths that sum near `1.0`" (https://www.krea.ai/docs/developers/krea-2/style-transfer.md). Wired `style_images`, `image_style_references`, `styles` and Krea `moodboards` keep their own strengths, on top. A board at strength 0 is off for the node, text included: the engine takes it out before the handler runs, so Krea 2 gets no brief, Avoid or board images, and the run note is "Board strength is 0: board not sent" (Q36 a, 2026-10-20; it replaced "no board images sent"). An image whose share rounds to 0 is left out with a note. Every run that sends board images gets a run note listing each one's strength. Both routes (API token and Krea account) send the same body. Before 2026-10-20 each image went at `strength x weight`, so a replay of an older recipe can differ, and the canvas says so.

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
- Nebula-native moodboards are separate provider-neutral assets. When wired into Krea 2, representative images become Krea image style references. The board's brief joins the prompt, and so does its Avoid list ("Keep these out of the image: ..."), because Krea 2 follows written instructions. The engine adds both for every generator with a Moodboard port (`backend/services/moodboard_brief.py`), not the Krea handler. The board's own fields (`direction`, `avoid`, `pinnedColors`, `briefOverride`) are set through `PUT /api/moodboards/{id}`; see `docs/contracts/07-studios-and-resources.md`.
- `krea-2-generate` accepts at most 10 image style references and at most 1 moodboard.
- `krea-style` strength supports `-2..2`; image style reference and moodboard strengths support `0..1`.

## Provider Resource Objects

Wrapper nodes intentionally emit provider-specific objects on `Any` ports:

- Image style reference: `{ kind: "krea_image_style_reference", image, strength }`
- Style: `{ kind: "krea_style", id, strength }`
- Krea moodboard: `{ kind: "krea_moodboard", id, strength }`
- Nebula moodboard: `{ kind: "nebula_moodboard", moodboardId, name, mode, strength, images, analysis, styleBrief, negativePrompt, avoid, avoidPrompt, direction, pinnedColors, briefOverride, palette, accents, leftOut, mayClash, kept, pinnedClashes, paletteClashes, clashMode, notesSent, representativeImages, providerHints }` (`styleBrief` is the person's override when they wrote one, else the generated brief with their Direction first; `negativePrompt` is defects only plus the Avoid list; colours they kept out, and measured colours that clash with their Direction or Avoid words, are dropped from `palette` and `accents`, with `leftOut` saying which and why; `notes` and image notes are empty unless the person sends notes to generators, `notesSent`) (`palette` is the dominant colours, ranked by image weight × share; `accents` are small saturated colours kept apart; `representativeImages` are heaviest first)

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

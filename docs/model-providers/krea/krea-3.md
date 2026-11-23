---
id: nebula-krea-3
kind: project-model-integration
project: nebula_nodes
provider: krea
model: krea-3
status: active
verified: 2026-11-22
stale_after_days: 14
sources:
  - https://api.krea.ai/openapi.json
  - https://www.krea.ai/docs/developers/krea-3/overview.md
  - https://fal.ai/models/krea/v3/text-to-image/llms.txt
  - https://fal.ai/models/krea/v3/edit/llms.txt
  - https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=krea/v3/text-to-image
  - https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=krea/v3/edit
---

# Krea 3 — Audit Note

`krea-3` "Krea 3" is a route-table node (one node per model, provider switcher
in the node; `docs/PROVIDER-ROUTES.md`). Krea released Krea 3 on 2026-10-15 as
"our new image editing model". Krea is the maker, so its own API is the first
route and fal is the second. All sources fetched 2026-10-15 and Krea's overview and OpenAPI re-checked 2026-11-22 (see "2026-11-22: what changed"); no paid calls.
Agent playbook: the "Krea 3 and the FLUX 3 nodes" section of
`.agents/skills/krea/SKILL.md`.

## Routes

| Route | Endpoint | Keys | Notes |
|---|---|---|---|
| `krea` (maker, `plan: optional`) | `POST /generate/image/krea/krea-3` | `KREA_API_TOKEN`, or the Krea plan | API-token runs: available to every workspace ("The Krea 3 API is available to every workspace", REST API overview checked 2026-11-22). Plan runs go through the Krea MCP, whose guide was not re-checked here. |
| `fal` | `krea/v3/text-to-image`, `krea/v3/edit` when images are wired | `FAL_KEY` | fal pages show status public, partner API, enterprise status "pending", no access flag. Whether a standard fal key can call it isn't verified. |

- **Ports:** `prompt` (required), `images` (multiple, up to 8). Krea's OpenAPI (`image_urls` maxItems 8), the MCP schema, the docs and fal's edit schema all say 8; the launch blog's 6 appears in no schema.
- **Billing under Auto:** `_kreaAuth: mcp` runs on the Krea plan (cache tag `plan:krea`). With `api-token`, Auto takes Krea when `KREA_API_TOKEN` is set, else fal. Because `apiProvider` is `krea`, a new node takes the global Krea connection mode. This applies only to a Krea-maker node; on the FLUX 3 nodes Auto never bills the plan.

## Settings

Only `seed` is shared (no default; both routes take it). fal's `krea/v3` has no `resolution` or `aspect_ratio` field (only `image_size`), fal forwards every param it gets, and neither provider documents a mapping between their controls, so each route keeps its own.

| Route | Param | Values | Default |
|---|---|---|---|
| krea | `thinking_mode` | `fast`, `high` | `fast` |
| krea | `resolution` | `1K`, `2K`, `4K` (the schema's uppercase; the docs accept lowercase too, but the gateway validates against the schema). Krea requires it, or `width` and `height` | `1K` |
| krea | `aspect_ratio` | 1:1, 4:5, 3:4, 2:3, 9:16, 5:4, 4:3, 3:2, 16:9, 21:9 | unset (automatic framing) |
| krea | `regional_edit` | boolean; blocked without a reference image | false |
| fal | `model` | `berry`, `jam` | `berry` |
| fal | `reasoning_level` | `low`, `medium`, `high` (`high` is edit only, so it's blocked without a reference image) | `low` |
| fal | `image_size` | `auto` and fal's presets | `auto` |
| fal | `negative_prompt` | text (berry) | empty |
| fal | `output_format` | `png`, `jpeg` | `png` |

fal's schema changed since the first research dumps: edit gained `reasoning_level: high` (bills 5 MP more), and `auto` is now about 2048x2048, not 1024x1024.

## Hidden settings (PR 5, 2026-10-16)

Each route shows only its own settings, and a run never sends a setting its route hides (`docs/PROVIDER-ROUTES.md`, Hidden settings):

- **Negative prompt is Berry only.** On fal, `negative_prompt` shows and is sent only with `model: berry`. A negative prompt typed under Berry stays saved but isn't sent once the model is Jam, and the run doesn't stop.
- **One route's own setting stops the other route.** Krea's `thinking_mode`, `resolution`, `aspect_ratio` and `regional_edit` aren't on fal (`regional_edit` counts only with a reference image wired, since Krea refuses it without one), and fal's `model`, `reasoning_level`, `image_size`, `negative_prompt` and `output_format` aren't on Krea. A non-default value of one of them, reached on the other route without a click (a key change, an import, Auto), stops the run there with a one-click reset ("Set Model back to Berry · quality") next to the switch. A click on a provider row resets it instead, with a note. Example: Model Jam saved under Auto with a Krea token stops on Krea ("it doesn't offer Model Jam · speed").
- **High thinking on fal stops and has no price.** `thinking_mode: high` saved with the provider on fal stops ("Set “Thinking mode” back to Fast or switch to Krea."), whatever fal's own settings are, and the estimate leaves it unpriced.

## 2026-11-22: what changed

Krea updated Krea 3's request schema and guide after the 2026-10-15 pin:

- **`resolution` (or `width` and `height`) is required** (`anyOf` in the OpenAPI schema). The canvas writes every param default into a new node, while agent-made nodes (`nebula apply`, CLI, MCP) save none. `handle_krea_catalog` now fills fields required by Krea's schema (or the first `anyOf`/`oneOf` set the route has defaults for) from the Krea route's defaults (`_required_defaults`), leaving unset optional params omitted. Gateway validation errors for a missing required-set `anyOf`/`oneOf` now name the needed fields with a person-facing line, and `_raise_for_krea_response` appends up to three 422 `details` entries (`field: message`).
- **`4K` resolution** was added to the Krea route, billed as a 2K image plus $0.04 ($0.10 with no references, up to $0.66 with 8 references).
- **Open to every workspace on the API.** The Krea 3 API guide now states "The Krea 3 API is available to every workspace", so the beta-workspace early-access route note and description clause were removed. The Krea MCP guide, which plan runs go through and which said closed beta on 2026-10-15, was not re-checked.
- **Not used by the node yet:**
  - `regions` (up to 24 normalized bounding boxes with optional `label` and `note` fields, added to the OpenAPI schema): needs a box-drawing UI on reference images.
  - `width` / `height` (up to 4096 each, alternative to `resolution`, rounded to a supported ratio and a 1K or 2K canvas; cannot be combined with `resolution` or `aspect_ratio`): added to the OpenAPI schema, not exposed in the node yet.
  - `thinking_mode: ultra` (agentic mode, always 2K, Max plan or above, +$0.20, requires at least one reference image): documented in Krea's overview guide, not yet in the OpenAPI `thinking_mode` enum (`fast`, `high`).

## Prices

- **Krea** (docs pricing table; the OpenAPI has no `x-krea-pricing`): base $0.03 at 1K, $0.06 at 2K, $0.10 at 4K (2K plus $0.04); +$0.02 for `high` thinking; each reference +$0.02 (1K reference) or +$0.07 (2K reference), by the reference's own size. With nothing wired to Images the run costs the base price exactly ($0.03 at 1K, $0.06 at 2K, $0.10 at 4K). With references wired, their size isn't known before the run, so the price is a range, as for Gemini: $0.03 to $0.59 at 1K, $0.06 to $0.62 at 2K, $0.10 to $0.66 at 4K (the `(references)` price variable, read from the wired ports). This is the API balance's price; plan runs bill workspace compute and are unpriced.
- **fal** (llms.txt, **unconfirmed**): $0.025 per megapixel, counting the output plus each reference at no more than the output's size. `auto` is about 4 MP (~$0.10): a run with no references is $0.10 to $0.1006, and with references wired the range runs to $0.9056 (8 references); `high` reasoning adds $0.125. Runs on a preset size are unpriced (krea/v3 gives no pixel sizes for its presets).

## Catalog

The Krea catalog entry for `/generate/image/krea/krea-3` sits in `backend/data/krea_gateway_models.json` with `foldedInto: "krea-3"`, and the endpoint is in `FOLDED` in `scripts/sync-krea-catalog.py`, so no `krea-image-krea-krea-3` node is generated. The entry was built with the script's own `refresh()` for that one endpoint, not a full `--refresh` (a full refresh against 2026-10-15's spec would also add one Topaz model, drop two and change `flux-1-dev`'s schema).

## Left out

- Krea `width`/`height` and `regions`: in the OpenAPI schema since 2026-11-22, not yet in the node.
- Krea `negative_prompt`, `priority` and `thinking_mode: ultra`: in Krea's overview guide, not in the OpenAPI request schema (`additionalProperties: false`).
- Krea's deprecated `thinking_mode` values `instant` / `medium` / `max` (sunset 2026-10-23), and the Zero Data Retention header (enterprise; up to 8 references, no 4K, no `ultra`).
- fal's custom `{width, height}` image size, `enable_safety_checker` (turning it off needs account authorization), `sync_mode`, and `krea/v3/realtime`.
- OpenRouter and Replicate: Krea's blog says both carry Krea 3; neither lists it (2026-10-15).

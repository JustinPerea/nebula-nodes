---
id: nebula-krea-3
kind: project-model-integration
project: nebula_nodes
provider: krea
model: krea-3
status: active
verified: 2026-10-15
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
route and fal is the second. All sources fetched 2026-10-15; no paid calls.
Agent playbook: the "Krea 3 and the FLUX 3 nodes" section of
`.agents/skills/krea/SKILL.md`.

## Routes

| Route | Endpoint | Keys | Notes |
|---|---|---|---|
| `krea` (maker, `plan: optional`) | `POST /generate/image/krea/krea-3` | `KREA_API_TOKEN`, or the Krea plan | Early access: Krea 3 on Krea's API is for beta workspaces (sales@krea.ai). The Krea MCP lists `krea/krea-3`, and its prompting guide says the model "is in a closed beta and only available to workspaces in the Krea 3 beta", so plan runs need the beta too. |
| `fal` | `krea/v3/text-to-image`, `krea/v3/edit` when images are wired | `FAL_KEY` | fal pages show status public, partner API, enterprise status "pending", no access flag. Whether a standard fal key can call it isn't verified. |

- **Ports:** `prompt` (required), `images` (multiple, up to 8). Krea's OpenAPI (`image_urls` maxItems 8), the MCP schema, the docs and fal's edit schema all say 8; the launch blog's 6 appears in no schema.
- **Billing under Auto:** `_kreaAuth: mcp` runs on the Krea plan (cache tag `plan:krea`). With `api-token`, Auto takes Krea when `KREA_API_TOKEN` is set, else fal. Because `apiProvider` is `krea`, a new node takes the global Krea connection mode. This applies only to a Krea-maker node; on the FLUX 3 nodes Auto never bills the plan.
- **A token outside the beta** still sends Auto to Krea, and Krea refuses there (not verified: no call was made). The route note is the only warning, and fal is one click away.

## Settings

Only `seed` is shared (no default; both routes take it). fal's `krea/v3` has no `resolution` or `aspect_ratio` field (only `image_size`), fal forwards every param it gets, and neither provider documents a mapping between their controls, so each route keeps its own.

| Route | Param | Values | Default |
|---|---|---|---|
| krea | `thinking_mode` | `fast`, `high` | `fast` |
| krea | `resolution` | `1K`, `2K` (the schema's uppercase; the docs write lowercase, but the gateway validates against the schema) | `1K` |
| krea | `aspect_ratio` | 1:1, 4:5, 3:4, 2:3, 9:16, 5:4, 4:3, 3:2, 16:9, 21:9 | unset (automatic framing) |
| krea | `regional_edit` | boolean; blocked without a reference image | false |
| fal | `model` | `berry`, `jam` | `berry` |
| fal | `reasoning_level` | `low`, `medium`, `high` (`high` is edit only, so it's blocked without a reference image) | `low` |
| fal | `image_size` | `auto` and fal's presets | `auto` |
| fal | `negative_prompt` | text (berry) | empty |
| fal | `output_format` | `png`, `jpeg` | `png` |

fal's schema changed since the first research dumps: edit gained `reasoning_level: high` (bills 5 MP more), and `auto` is now about 2048x2048, not 1024x1024.

## Prices

- **Krea** (docs pricing table; the OpenAPI has no `x-krea-pricing`): base $0.03 at 1K, $0.06 at 2K; +$0.02 for `high` thinking; each reference +$0.02 (1K reference) or +$0.07 (2K reference), by the reference's own size. That size isn't known before the run, so the price is a range, as for Gemini: $0.03 to $0.59 at 1K, $0.06 to $0.62 at 2K. API-token runs only; plan runs are unpriced.
- **fal** (llms.txt, **unconfirmed**): $0.025 per megapixel, counting the output plus each reference at no more than the output's size. `auto` is about 4 MP (~$0.10), so the range is $0.10 to $0.9056; `high` reasoning adds $0.125. Runs on a preset size are unpriced (krea/v3 gives no pixel sizes for its presets).

## Catalog

The Krea catalog entry for `/generate/image/krea/krea-3` sits in `backend/data/krea_gateway_models.json` with `foldedInto: "krea-3"`, and the endpoint is in `FOLDED` in `scripts/sync-krea-catalog.py`, so no `krea-image-krea-krea-3` node is generated. The entry was built with the script's own `refresh()` for that one endpoint, not a full `--refresh` (a full refresh against 2026-10-15's spec would also add one Topaz model, drop two and change `flux-1-dev`'s schema).

## Left out

- Krea `width`/`height` and `negative_prompt`: in Krea's docs and MCP guide, not in the OpenAPI request schema (`additionalProperties: false`).
- Krea's deprecated `thinking_mode` values `instant` / `medium` / `max` (sunset 2026-10-23), and the Zero Data Retention header (enterprise, max 4 references).
- fal's custom `{width, height}` image size, `enable_safety_checker` (turning it off needs account authorization), `sync_mode`, and `krea/v3/realtime`.
- OpenRouter and Replicate: Krea's blog says both carry Krea 3; neither lists it (2026-10-15).

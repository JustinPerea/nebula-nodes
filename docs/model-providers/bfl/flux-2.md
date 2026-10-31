---
id: nebula-bfl-flux-2
kind: project-model-integration
project: nebula_nodes
provider: bfl
model: flux-2 (flux-2-pro)
status: active
verified: 2026-10-16
stale_after_days: 30
---

# FLUX.2 on BFL and fal — Audit Note

`flux-2-pro` ("FLUX.2") is one route-table node (provider switcher in the
node; `docs/PROVIDER-ROUTES.md`): Black Forest Labs' own API first, then the
fal route it ran on before PR 4. The id stays `flux-2-pro` because saved
graphs use it. Agent playbook: `.agents/skills/bfl/SKILL.md`. The node
definition in `frontend/src/constants/nodeDefinitions.ts` (and
`backend/data/node_definitions.json`) and the prices in
`backend/data/model_pricing.json` are the truth where this note and the code
differ.

```mermaid
flowchart LR
  node["FLUX.2<br/>model, image_size, output_format,<br/>safety_tolerance, seed, steps/guidance (Flex)"]
  node -->|"bfl (maker)"| bfl["api.bfl.ai /v1/flux-2-{pro,max,flex,klein-9b,klein-4b}<br/>width/height from the preset"]
  node -->|fal| fal["queue.fal.run fal-ai/flux-2-pro, -max, -flex,<br/>flux-2/flash, flux-2/klein/9b, /4b"]
```

## Sources (all fetched 2026-10-15; no paid calls)

- BFL: https://api.bfl.ai/openapi.json (`Flux2Inputs`, `Flux2FlexInputs`, `Flux2KleinInputs`); https://docs.bfl.ai/flux_2/flux2_overview, flux2_text_to_image, api_integration/errors; https://bfl.ai/pricing (its `pricingCards` CMS data) and https://docs.bfl.ai/quick_start/pricing
- fal: queue OpenAPI per endpoint, `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>` for `fal-ai/flux-2-pro`, `fal-ai/flux-2-max`, `fal-ai/flux-2/flash`, `fal-ai/flux-2-flex`, `fal-ai/flux-2/klein/9b`, `fal-ai/flux-2/klein/4b`; the model pages under https://fal.ai/models/fal-ai/; preset sizes from https://fal.ai/docs/documentation/model-apis/model-arguments
- Pinned copies: `backend/tests/fixtures/provider_schemas/bfl.json` (`flux-2-*`) and `fal.json` (`fal-ai/flux-2*`), `$ref`s inlined.

## The models on each host

| `model` | Label in the node | BFL | fal |
|---|---|---|---|
| `pro` (default) | FLUX.2 [pro] | `/v1/flux-2-pro` | `fal-ai/flux-2-pro` (BFL's API resold) |
| `max` | FLUX.2 [max] | `/v1/flux-2-max` | `fal-ai/flux-2-max` (resold) |
| `flash` | FLUX 2 Flash | none: the route stops ("doesn't take model flash") | `fal-ai/flux-2/flash` (fal's own) |
| `flex` | FLUX.2 [flex] | `/v1/flux-2-flex` | `fal-ai/flux-2-flex` (resold) |
| `klein-9b` | FLUX.2 [klein] 9B | `/v1/flux-2-klein-9b` | `fal-ai/flux-2/klein/9b` (fal-hosted weights) |
| `klein-4b` | FLUX.2 [klein] 4B | `/v1/flux-2-klein-4b` | `fal-ai/flux-2/klein/4b` (fal-hosted weights) |

### Names (checked 2026-10-16)

Justin, 2026-10-16: "Let's match the provider every time." Each label is the provider's own spelling: BFL's (the maker) for the five models BFL serves, and fal's for Flash, which only fal offers. The values stay `pro`, `max`, `flash`, `flex`, `klein-9b`, `klein-4b`, since saved graphs use them.

- Node name "FLUX.2": the family page, `<title>FLUX.2 - Next Generation Image Generation | Black Forest Labs` (https://bfl.ai/models/flux-2).
- "FLUX.2 [pro]", "FLUX.2 [max]", "FLUX.2 [flex]", "FLUX.2 [klein] 9B", "FLUX.2 [klein] 4B": the operation summaries in https://api.bfl.ai/openapi.json ("Generate or edit an image with FLUX.2 [pro]", "... FLUX.2 [max]", "... FLUX.2 [flex]", "... FLUX.2 [klein] 9B", "... FLUX.2 [klein] 4B"), the pricing card titles on https://bfl.ai/pricing, and the rows on https://docs.bfl.ai/quick_start/pricing (`| FLUX.2 \[pro] |` in the page source, where `\[` is only Markdown escaping). The variant is lowercase in brackets, and the size follows the bracket after a space. BFL's Title Case nav tiles ("FLUX.2 Max", "FLUX.2 Klein") are family links, not model names.
- "FLUX 2 Flash": fal's page `<title>FLUX 2 Flash (Text to Image) API on fal</title>` and the heading "# FLUX 2 Flash" in https://fal.ai/models/fal-ai/flux-2/flash/llms.txt. BFL lists no Flash model (none in its OpenAPI, docs or pricing); fal says it runs "FLUX.2 [dev]". "FLUX.2 [flash]" appears nowhere, so it isn't used.
- The switcher's snap note is built from these labels: "FLUX 2 Flash isn't on Black Forest Labs: set to FLUX.2 [flex]".

## What each route sends

The saved names are fal's (saved graphs carry them). The BFL route translates:

- `model` picks the path and isn't sent (either route).
- `image_size` preset → `width` / `height`: `square_hd` 1024×1024, `square` 512×512, `portrait_4_3` 768×1024, `portrait_16_9` 576×1024, `landscape_4_3` 1024×768, `landscape_16_9` 1024×576 (fal's documented sizes). A node saved without a size sends the default 1024×768: BFL documents no FLUX.2 default (`width`/`height` "default 0").
- `safety_tolerance` `"1"`-`"5"` → the integers 1-5.
- `num_inference_steps` / `guidance_scale` → `steps` / `guidance`, on Flex only.

| Setting | BFL | fal |
|---|---|---|
| `output_format` | jpeg, png | jpeg, png |
| `safety_tolerance` | 1-5 (BFL takes 0-5 on FLUX.2) | 1-5 on Pro, Max and Flex; Flash and Klein have no such field, so it is hidden there (`paramVisibleWhen {safety_tolerance: {model: [pro, max, flex]}}`) and not sent. On Klein a saved value other than 2 stops the run, since BFL would honor it (the card: "“FLUX.2” can’t run on fal.ai with “Safety” set to 3 and “Model” set to FLUX.2 [klein] 4B. Set “Safety” back to 2 or switch to Black Forest Labs."); on Flash it is ignored (BFL has no Flash) |
| `seed` | yes | yes |
| `num_inference_steps` (Flex) | 1-50 (default 50) | 2-50 (default 28) |
| `guidance_scale` (Flex) | 1.5-10 (default 5) | 1.5-10 (default 3.5) |
| `enable_safety_checker` | no field: not shown; saved off, the run stops and offers fal (rule H, no rule needed) | fal's own param (default on) |

- Steps and guidance show on Flex only (`visibleWhen`). A value left from Flex is hidden on the other models and isn't sent on either route (`node_route.route_sent_keys`; BFL: only `Flux2FlexInputs` has `steps`/`guidance`).
- Each route's `accepts` lists exactly its models (BFL five, fal six). Any other saved `model` (a case variant such as `"MAX"` or `"Flash"`, or a typo) stops the run on both routes before billing, so it never falls through to Pro.
- **Flash no longer sends `safety_tolerance`** (PR 5, 2026-10-16). `Flux2FlashInput` has no such field; the fal-only handler sent it on every Flash run. `tests/test_flux2_nodes.py` still replays all 6,048 saved combinations against the old handler's captured requests, with that one field as the only approved difference (`APPROVED_LEGACY_DELTA`).

## Prices (per image; every preset is at most 1 MP and the node takes no image input)

| `model` | BFL | fal |
|---|---|---|
| pro | $0.03 | $0.03 |
| max | $0.07 | $0.07 |
| flex | $0.05 | $0.05 |
| flash | - | $0.005 (unconfirmed) |
| klein-9b | $0.015 | $0.011 (unconfirmed) |
| klein-4b | $0.014 | $0.009 (unconfirmed) |

- BFL: a flat first megapixel, then each extra output and input megapixel (1 MP = 1,048,576 px). Credits (1 = $0.01), first / extra / input: pro 3 / 1.5 / 1.5, max 7 / 3 / 3, flex 5 / 5 / 5, klein-9b 1.5 / 0.2 / 0.2, klein-4b 1.4 / 0.1 / 0.1.
- fal Pro, Max and Flex are rounded up to whole megapixels, so 1024×1024 or less costs the first-megapixel price (fal's own example).
- fal Flash and Klein bill "per megapixel of input and output" with no rounding stated, so a preset under 1 MP may cost less: the 1 MP price is an upper bound, and the switcher marks it `*` (a row-level `unconfirmed`). Klein's own `endpointBilling` says $0.006 (9B) and $0.005 (4B); the price text on the same pages reads $0.011 and $0.009 and may describe the Klein edit and Base cards listed there. The higher is kept.

## Left out

- Input images and editing (BFL `input_image` to `input_image_8`, Klein 4; fal's `/edit` endpoints). The node keeps its prompt-only port.
- BFL's preview endpoints `/v1/flux-2-pro-preview` and `/v1/flux-2-klein-9b-preview`.
- BFL prompt upsampling (`disable_pup` on Pro and Max, `prompt_upsampling` on Flex): fal doesn't expose it; BFL's default (on) applies.
- `safety_tolerance` 0 on BFL, exact width/height on either host, Flash and Klein steps or guidance on fal, fine-tuned endpoints, webhooks.
- FLUX.2 [dev] and the Klein Base models: not on BFL's public API.

## Open checks

- That fal's safety tolerance 1 is BFL's 1 (both run strictest to most permissive; fal doesn't state the mapping).
- That fal's resold Pro, Max and Flex render presets at fal's documented sizes (the size table is written for fal's own models).
- fal Flash and Klein rounding below 1 MP, and Klein's two price figures. A billed run would settle each.
- BFL's FLUX.2 safety cap of 5 is from the errors page; the OpenAPI types it 0-7, set per organization.

## Live runs on BFL (2026-10-15)

Two real runs through the registry's `multi_route` handler with `_provider: bfl`, as a saved node would run, on an isolated backend given only `BFL_API_KEY`. Prompt: "A red paper boat on a still pond, overhead light".

| `model` | Request sent | Result | Time | Billed |
|---|---|---|---|---|
| klein-4b | `/v1/flux-2-klein-4b` `{width 1024, height 768, output_format "jpeg", safety_tolerance 2, prompt}` | 1024×768 JPEG | 4.2 s | 1.4 credits ($0.014) |
| pro (all defaults) | `/v1/flux-2-pro`, the same body | 1024×768 JPEG | 9.3 s | 3.0 credits ($0.03) |

The balance went from 955.1387 to 950.7387 credits, 4.40 in all, which matches the price rows exactly. So BFL bills a 0.75 MP output at the flat first-megapixel price, as the pricing data says. The fal route hasn't been run live yet.

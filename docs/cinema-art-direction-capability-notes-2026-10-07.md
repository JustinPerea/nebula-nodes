# Cinema adapter capability check — 2026-10-07

This check reads the current registered adapters and fetches their exact provider schemas. It creates no provider jobs. The request tests mock HTTP transport while exercising the real registry and payload builders; they prove outgoing request translation, not generated image adherence.

## Reference routes and limits

| Cinema base / selected model | Actual route with references | Reference input | Enforced limit and evidence |
| --- | --- | --- | --- |
| `seedream-4-5` / `4.5` | `fal-ai/bytedance/seedream/v4.5/edit` | `image_urls` | 10, explicitly documented; provider otherwise keeps only the last ten |
| `seedream-4-5` / `5.0-lite` | `fal-ai/bytedance/seedream/v5/lite/edit` | `image_urls` | 10, explicitly documented; same last-ten behavior |
| `nano-banana` / Gemini 3.1 Flash, 3.1 Flash Lite, 3 Pro | Google `generateContent` for the selected model | ordered image content parts | 14 total reference images, documented by Google; role-specific fidelity guidance is not a numeric adherence parameter |
| `nano-banana` / Gemini 2.5 Flash | Google `generateContent` | ordered image content parts | Conservative adapter limit 3, based on Google's best-performance guidance, **not a documented hard API cap** |
| `nano-banana-fal-edit` / Nano Banana 2, Pro, Gemini 3 Pro alias | corresponding fixed FAL `/edit` route | `image_urls` | 14 from underlying Google model documentation; FAL schema does not declare `maxItems` |
| `nano-banana-fal-edit` / original Nano Banana or Gemini 2.5 alias | corresponding fixed FAL `/edit` route | `image_urls` | Conservative adapter limit 3 from underlying Google guidance |
| `flux-kontext` / base or max | `fal-ai/flux-pro/kontext` or `/max` | singular `image_url` | 1: the exact registered endpoint accepts one image, not a plural image list |

There is no standalone registered `nano-banana-pro` Cinema base. Pro is a selector of the Google or FAL Nano Banana nodes. Limits must follow that selected model, not only the wrapper node ID.

Before this correction the Seedream wrapper always dispatched to `text-to-image`, even when Cinema supplied references. Those text routes have no image input. The wrapper now selects the verified edit route when images are present and retains the original selected text route when absent. It rejects more than ten references before submission, normalizes a legacy singular reference into the declared plural field and leaves the persisted recipe untouched. Cinema supplies only the declared singular/plural port for each base.

Cinema now translates its scene aspect ratio to Seedream's declared `image_size`, rather than sending an unsupported `aspectRatio`. An explicit saved `image_size` remains authoritative. Common ratios use the named provider sizes; the cinematic `2.39:1` ratio uses validated dimensions `4096 × 1714`. Seedream 5 Lite declares no `seed` on either route, so the wrapper omits it from the provider request, including seeds supplied by Character expansion, and retains the saved seed metadata. Deterministic generation is not claimed for that selected model.

Switching a saved Seedream 5 Lite recipe to 4.5 can retain `auto_3K`, which only Lite supports. The 4.5 wrapper now rejects that retained size before submission on either text or edit routes, while preserving the saved value for an explicit correction. Lite's valid `auto_3K` request remains supported. The guard is based on both exact 4.5 schemas, not only the filtered UI option.

Primary references:

- [Seedream 4.5 edit schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/bytedance/seedream/v4.5/edit) and [API documentation](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit/api).
- [Seedream 5 Lite edit schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/bytedance/seedream/v5/lite/edit) and [API documentation](https://fal.ai/models/fal-ai/bytedance/seedream/v5/lite/edit/api).
- [Google image-generation model guidance](https://ai.google.dev/gemini-api/docs/image-generation).
- [Nano Banana 2 edit schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-2/edit), [Pro edit schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-pro/edit), [original edit schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana/edit), [2.5 alias schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gemini-25-flash-image/edit), [3 Pro alias schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gemini-3-pro-image-preview/edit).
- [Kontext schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux-pro/kontext) and [Kontext Max schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/flux-pro/kontext/max).

## Character strength

None of these exact reachable reference routes has a native identity-adherence parameter. Google's current `ImageConfig` declares aspect ratio and image size. FAL Nano Banana 2 edit does not declare `identity_strength` or `input_fidelity`. Kontext's `guidance_scale` controls prompt guidance and is not an identity-strength substitute. Scene/Character strength values remain saved metadata; the UI must not imply they control these requests.

Identity Edit previously translated its strength into an invented `input_fidelity`. The handler now omits both fields from the outbound request, including a legacy `input_fidelity` stored in a recipe, while preserving the original node params and Character bundle. Trait text, ordered references and seed behavior continue to work.

- [Google `ImageConfig` API reference](https://ai.google.dev/api/generate-content#ImageConfig).
- [Exact Identity Edit endpoint schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-2/edit).

Ideogram Character consumes trait text, references and seed but does not translate Character strength. The actual fixed wrapper already rejects more than one character reference before routing; both the direct V3 API and FAL Character endpoint currently document one. Style references have a separate input and must not be counted as additional character references.

- [Ideogram V3 direct generate API](https://developer.ideogram.ai/v1/api-reference/generate-images/generate-v3).
- [FAL Ideogram Character API](https://fal.ai/models/fal-ai/ideogram/character/api).

## Validation

`backend/tests/test_identity_edit.py` checks trait/reference/seed compatibility, absent native strength, rejection of legacy fidelity injection and source-recipe preservation. `backend/tests/test_cinema_base_requests.py` captures actual outgoing request URLs and JSON bodies for both Seedream variants, all fixed FAL Nano Banana selectors, both Kontext selectors and all four direct Google image selectors. It also checks unchanged empty-reference Seedream routes and pre-submission excess-reference rejection.

Both suites pass: **51 tests**, including selected-model size compatibility. The full Character → Cinema → Seedream 5 Lite adapter path is exercised with mocked HTTP and image loading, preserving references/trait text while omitting unsupported seed. Existing FAL handler/contract, Google contract and Character expansion tests are checked separately to guard existing routes.

The existing reference-role baseline test retains its historical fingerprints. It validates and normalizes only exact approved art-direction deltas on a deep copy, leaving all five modified definitions covered. Negative guards catch changed approved labels/notes/conditions and unrelated metadata mutations. Those **23 tests** pass; the combined focused gate is **74 tests**.

The exact Identity Edit endpoint also lacks a mask field. Its serialized Mask port and old graph connections are retained, but a nonempty Mask input now raises a clear unsupported-endpoint error before any provider submission. An empty legacy Mask value remains compatible with a standard edit. The request regressions check both cases rather than forwarding an invented `mask_url` or silently performing an unmasked generation.

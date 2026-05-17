---
id: nebula-openai-dalle-3
kind: project-model-integration
project: nebula_nodes
provider: openai
model: dall-e-3
status: active
verified: 2026-05-16
stale_after_days: 60
---

# DALL-E 3 in Nebula Nodes

Audit note for the `dalle-3-generate` node.
Sources: openai-python SDK type stubs at `openai/types/image_generate_params.py`,
fetched 2026-05-16 from
`https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/`.

## Node Matrix

| Node ID | Route | Key | Use |
|---|---|---|---|
| `dalle-3-generate` | OpenAI direct | `OPENAI_API_KEY` | Text to image (DALL-E 3 or DALL-E 2) |

Note: The node exposes both `dall-e-3` and `dall-e-2` as model options. The handler
branches on the model identifier: DALL-E models receive `response_format: b64_json`;
GPT-image models do not. The `style` param is forwarded only when `model == "dall-e-3"`.

## Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `model` | `dall-e-3`, `dall-e-2` | `dall-e-3` | |
| `size` | `1024x1024`, `1024x1792`, `1792x1024` | `1024x1024` | dall-e-3 sizes; dall-e-2 accepts 256x256/512x512/1024x1024 but the node does not expose those |
| `quality` | `standard`, `hd` | `standard` | dall-e-3 only; dall-e-2 ignores |
| `style` | `vivid`, `natural` | `vivid` | dall-e-3 only; handler omits for other models |
| `response_format` | — | — | Always `b64_json`; injected by handler, not a UI param |
| `n` | — | — | Not exposed; dall-e-3 only supports n=1 |

## Findings (2026-05-16 audit)

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | `style` in registry but handler never forwarded it to request body | Added `style` forwarding in `openai_image.py` for `model == "dall-e-3"` |
| 2 | PASS | `response_format: b64_json` correctly injected for dall-e models | No change needed |
| 3 | PASS | `output_format`, `background` correctly excluded for dall-e models | Handler guards on `model.startswith("dall-e")` |

## Not Supported

- `output_format`: GPT image models only
- `background`: GPT image models only
- `moderation`: gpt-image-2 only
- `stream`: GPT image models only

## Open Questions

- DALL-E 2 size options (`256x256`, `512x512`) are not exposed in the node UI. If users
  need smaller DALL-E 2 outputs, the size param would need expanding.
- DALL-E 3 is still listed as active in the openai-python SDK as of 2026-05-16. Confirm
  it has not entered deprecation when this note becomes stale.

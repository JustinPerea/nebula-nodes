# Krea in Nebula Nodes

You can also [connect your Krea account through MCP](../KREA-MCP.md) in Settings.
Gateway models save a choice between **Krea account · workspace compute** and
**API token · API balance**. Old graphs and the legacy style tools retain API
tokens. Connecting or checking the account never generates media.

Use Krea as a direct provider for image, video and audio models, including Krea 2, Nano Banana, GPT Image, Flux, Kling, Veo, Seedance, Hailuo, Runway, and ElevenLabs Music. Each model has its own node and model-specific controls. The catalog is generated from Krea's public OpenAPI document, checked **2026-10-09**: **34 image routes, 41 video routes and 5 audio routes**.

Choose a specific Krea model in the model picker. Canvas supports the full catalog and its advanced inputs. Create exposes models that work with its prompt, image attachments, and simple controls; use Canvas for Runway's tagged references, H3 camera trajectories, and Flux Video Edit's source video. Krea is the provider used for that run, even when the underlying model comes from another company. Nebula does not switch to another provider or use another provider's key automatically.

## Set up an API token

1. Enable API access on your Krea workspace and create a token at [Krea API tokens](https://www.krea.ai/settings/api-tokens). Workspace owners and admins can create tokens.
2. In Nebula **Settings** → **Providers**, choose **Add key** on the **Krea · API token** row, paste the token and choose **Save key**. The documented key is `KREA_API_TOKEN`; the backend also accepts the older `KREA_API_KEY` name.
3. Check your workspace's [API balance](https://www.krea.ai/app/api). Direct API calls use a separate USD balance from the compute units used by the Krea web app. A configured token alone does not establish that generation is funded or permitted.

No restart is required after saving settings. API-token recipes call `https://api.krea.ai` with bearer-token authentication. A depleted API balance returns HTTP 402; Nebula surfaces the provider error. See [Krea's authentication and billing reference](https://www.krea.ai/docs/developers/api-keys-and-billing).

## Choose and connect a model

The new nodes have stable IDs derived from the API route. For example:

| Model | Node ID | Typical input |
|---|---|---|
| Nano Banana 2 | `krea-image-google-nano-banana-2` | `prompt`; optional `image_urls` |
| GPT Image 2 (Krea labels it ChatGPT 2) | `krea-image-openai-gpt-image-2` | `prompt`; optional `image_urls` |
| Krea 2 Turbo | `krea-image-krea-krea-2-medium-turbo` | `prompt`; optional image/style inputs |
| Kling 3.0 | `krea-video-kling-kling-3-0` | `prompt`; optional `start_image` and `end_image` |
| Veo 3.1 | `krea-video-google-veo-3-1` | `prompt`; optional image inputs |
| Seedance 2.0 | `krea-video-bytedance-seedance-2` | `prompt`; optional image/video/audio references |
| ElevenLabs Music v2.5 | `krea-audio-elevenlabs-music-v2-5` | `prompt`; optional `music_length_ms`, `force_instrumental` |
| ElevenLabs TTS | `krea-audio-elevenlabs-tts` | `prompt` (the text to speak); optional `voice_id`, `model_id` |

Connect a text source to `prompt` or enter the prompt in the node's control. Supply supported media through connections or media URL fields, set the model's normal controls, then explicitly run the node. Required request fields can be filled by either connections or controls and are checked before submission. Reference inputs, aspect ratios, resolution, duration, audio, and other options differ by model; a control on one Krea node is not a promise that another model supports it.

Create attachments feed the model's first image input. Use Canvas to assign separate start/end frames or different reference roles.

**Nano Banana on your Google key.** The four Google Nano Banana copies (`krea-image-google-nano-banana-2`, `-pro`, `-flash-lite` and `krea-image-google-nano-banana`) also run on Google's Gemini API when a Google API key (`GOOGLE_API_KEY`) is saved. Which one runs: a node set to your Krea plan stays on the plan; otherwise your Google key wins and Google bills the run; with no Google key, your Krea API token runs it. The readiness line says which ("Runs on Google's own API with your Google key" or "Runs on Krea with your Krea API token"), the run estimate uses that route's price, and the Inspector hides Krea's `width`/`height` on the Google route, where they don't apply. A recipe that sets `width` or `height` stays on Krea, since Google can't render an exact size; clear them to run on Google. `krea-image-google-nano-banana` (Gemini 2.5 Flash Image) runs on Krea again from 2027-03-15, Google's listed shutdown date. On Google the node fills `image`, `images` and `artifacts`, with no Krea `job`.

**Nano Banana 2.1, Veo 3.1 and Gemini Omni Flash 1.1 on your Google keys** (2026-10-14). Same rule as above. `krea-image-google-nano-banana-2-1` and `krea-video-google-gemini-omni-flash-1-1` use your Google API key. The Veo 3.1 copies (`krea-video-google-veo-3-1`, `-fast`, `-lite`) use a Google Vertex AI key (`GOOGLE_VERTEX_CREDENTIALS`) only, since Google's Gemini API Veo previews end on 2026-10-22. Veo 3.1 Fast set to 4K stays on Krea, since Vertex renders Fast at up to 1080p; the readiness line says so. Vertex refuses some reference-image combinations that Krea may accept: references need an 8-second duration, can't be used at 4K, and can't be combined with start/end frames. Nebula stops those runs before any request; use the Krea plan or remove the Vertex key to run them on Krea. On Omni, a start image together with references is refused for the same reason. Veo and Omni on Google fill `video`, `videos` and `artifacts`, with no Krea `job`. The older Veo 2, Veo 3 and Veo 3 Fast copies and Gemini Omni Flash 1.0 have no Google route (Google retired them or retires them on 2026-10-22).

**GPT Image on your OpenAI key.** The three OpenAI copies (`krea-image-openai-gpt-image-2`, `krea-image-openai-gpt-image-2-5-flare` and `-2-5-sunburst`) also run on OpenAI's Images API when an OpenAI API key (`OPENAI_API_KEY`) is saved, with the same precedence: Krea plan, else your OpenAI key, else your Krea API token. Krea's aspect ratio and resolution become an exact-ratio OpenAI size (16:9 at 1K is 1280x720; 4K is OpenAI's largest, which it calls experimental). A GPT Image 2 recipe that sets Krea's `width` or `height` stays on Krea, since OpenAI only takes sizes within its own rules. Reference images go to OpenAI's edits endpoint and must be public https URLs or Nebula outputs. The OpenAI route has no list price in Nebula yet (OpenAI publishes per-image prices for GPT Image 2 at three sizes only, and none for 2.5). `krea-image-openai-gpt-image` (ChatGPT Image) stays Krea-only: Krea doesn't say which OpenAI model it calls.

**Grok Imagine on your xAI key.** `krea-image-xai-grok-imagine-2`, `krea-image-xai-grok-imagine-2-edit`, `krea-video-xai-grok-video` and `krea-video-xai-grok-video-1-5` also run on xAI's own API when an xAI API key (`XAI_API_KEY`) is saved, with the same precedence (Krea plan, else your xAI key, else your Krea API token). Grok 2.0's `style_images` and both Grok video copies' `start_video` are Krea-only: a recipe that sets or wires them stays on Krea. Details and xAI prices: [xai.md](xai.md).

**Ideogram and Runway on your own keys.** Six more Krea copies run on their maker's API with the maker's key, by the same rule (Krea plan, then the maker key, then your Krea API token): `krea-image-ideogram-ideogram-4-5-precise`, `-ideogram-3` and `-ideogram-2-turbo` on `IDEOGRAM_API_KEY`, and `krea-image-runway-gen-4-image`, `krea-video-runway-gen-4-5` and `krea-enhance-runway-ruby` on `RUNWAY_API_KEY`. Width/height snap to the maker's nearest shape; Ideogram 3 runs set with Krea style images stay on Krea. Details and prices: [ideogram.md](ideogram.md), [runway.md](runway.md). Ideogram 4.5 (generate) and Runway Gen-4 (video) stay Krea-only.

Image nodes emit `image`, an `images` array, and the raw `job`. Video nodes emit `video`, a `videos` array, and `job`. Audio nodes emit `audio`, an `audios` array, and `job`. All also emit `artifacts` (Array), containing typed local records, including previews when present. Connect the singular media output to a downstream node when you need one result, or use the array when the model returns multiple results.

Local uploads and upstream Nebula media are uploaded to Krea before submission. Krea also accepts public media URLs. A file path on your Mac is not a public URL: connect it through a media input instead of pasting the path into an advanced JSON field.

Simple parameters use ordinary controls. Optional complex parameters use JSON fields for the exact Krea request shape, such as Kling's multi-shot prompts:

```json
[
  {"prompt": "A wide shot of a ceramic bird", "duration": 3},
  {"prompt": "A close-up of the glaze", "duration": 2}
]
```

This JSON belongs in the chosen Kling model's `multi_prompt` field. It does not select a model. Leave optional advanced fields empty when you do not need them. Consult the [gateway reference](../model-providers/krea/krea-gateway.md) for route and schema details, and the generated [model reference](../MODEL_REFERENCE.md) for the full Nebula catalog.

## Keep using Krea 2 styles and moodboards

The six existing Krea nodes remain available:

| Node ID | Purpose |
|---|---|
| `krea-2-generate` | Krea 2 Medium/Large generation with Nebula's style and moodboard wiring |
| `krea-image-style-reference` | Wrap an image with its own reference strength |
| `krea-style` | Wrap an existing style/LoRA ID with strength |
| `krea-moodboard` | Reference an existing Krea moodboard ID |
| `krea-style-search` | Find styles available to the authenticated API identity |
| `krea-style-train` | Train a style from images and emit a reusable style ID/object |

For per-image style strength, connect an image to **Krea Image Style Reference**, then its `image_style_reference` output to `krea-2-generate.image_style_references`. For a trained style, connect `krea-style-train.style` to `krea-2-generate.styles`. Style Train also emits `style_id` and `job`; Style Search is synchronous.

A provider-neutral `nebula-moodboard` can also feed the legacy Krea 2 node: Nebula adapts its representative images and style brief. A Krea-owned moodboard requires an existing Krea ID; this integration does not create Krea moodboards. Styles created in the app and through the API have separate identities unless shared with the workspace.

Use these legacy wrapper nodes for their established graph wiring. The new Krea 2 model nodes expose the canonical API schema, including Turbo and image-to-image controls; do not assume legacy wrapper objects are interchangeable with raw API JSON.

## Runs, results, and errors

Image/video generation and style training are asynchronous. Nebula submits a job, polls it while queued or processing, and materializes completed media into the local run output. Stop requests cancel Nebula's pending work and request Krea cancellation after a job ID is known; Krea decides whether cancellation is still possible. Earlier results and run history remain available.

Each node bills either the API token's balance or, once you switch it, your signed-in Krea plan (`_kreaAuth`). Only you can switch it: agents have to propose the change, and their runs billed to the plan count against "Krea plan runs" in Settings > Agent spending (10 until you pick a number). Krea charges plan runs in compute units it doesn't publish per model, so Nebula counts them as runs, not dollars.

Common failures are missing/rejected credentials, HTTP 402 for API balance, invalid model-specific parameters, moderation, or provider job errors. A public catalog entry establishes the documented route and schema, not successful execution for every workspace. Catalog verification does not include a paid provider run.

This expansion covers Krea's image and video generation routes. Enhancement, 3D/audio generation, saved Krea node apps, asset management, and standalone style-management endpoints are outside this catalog expansion. Nebula uses asset upload and job polling/cancellation internally.

## References

- [Nebula Krea gateway contract](../model-providers/krea/krea-gateway.md)
- [Krea agent skill](../../.agents/skills/krea/SKILL.md)
- [Krea API reference](https://www.krea.ai/docs/api-reference/introduction)
- [Public OpenAPI document](https://api.krea.ai/openapi.json)
- [Job lifecycle](https://www.krea.ai/docs/developers/job-lifecycle)
- [Asset upload](https://www.krea.ai/docs/api-reference/assets/upload-an-asset)

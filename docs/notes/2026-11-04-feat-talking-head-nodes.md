# 2026-11-04 feat/talking-head-nodes

Three nodes that turn a still image plus an audio track into a talking video: `omnihuman-1-5`, `omnihuman-2`, `kling-ai-avatar-v2`. Ports on all three: inputs `image` (Image, required), `audio` (Audio, required), `prompt` (Text, optional); output `video` (Video). Category `video-gen`.

## Research (all fetched 2026-11-04 from the vendor's own pages)

fal (model pages, `llms.txt`, per-endpoint OpenAPI at `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`):

| Endpoint | Price | Fields | Limits |
|---|---|---|---|
| `fal-ai/bytedance/omnihuman` (v1) | $0.14/s | image_url, audio_url | audio under 30 s. Not built: superseded by 1.5 and 2. |
| `fal-ai/bytedance/omnihuman/v1.5` | $0.16/s | image_url, audio_url; prompt, mask_url, turbo_mode, resolution (720p/1080p) | audio under 30 s at 1080p, 60 s at 720p |
| `fal-ai/bytedance/omnihuman/v2` | $0.105/s | image_url, audio_url, prompt | image 30 MB, aspect 0.4 to 2.5, 300 to 6000 px; audio wav/mp3 up to 15 MB, 4 to 300 s |
| `fal-ai/kling-video/ai-avatar/v2/standard` | $0.0562/s | image_url, audio_url, prompt, enable_safety_checker | |
| `fal-ai/kling-video/ai-avatar/v2/pro` | $0.115/s | same | |

Output on all four: `{video: {url}, duration}`. fal's pricing API needs a key, so the model-page prices were not cross-checked against it.

Replicate (public model pages and `https://replicate.com/api/models/<m>/versions`):

- `bytedance/omni-human-1.5`: $0.16/s of output video. Input image, audio, prompt, fast_mode, seed. Page says audio under 35 s (fal says 30 s at 1080p).
- `bytedance/omni-human` (v1): $0.14/s. Not built. No OmniHuman 2.0 on Replicate.
- `kwaivgi/kling-avatar-v2`: std $0.056/s, pro $0.11/s. Input image, audio, prompt, mode. Audio up to 5 MB, image jpg/png up to 10 MB. The page text says "Pro version" but the schema default is `std`; priced per the mode variant.
- Output is a URI on all.

Not hosted: OpenRouter's video model list (`/api/v1/videos/models`) has neither family. Krea's API pricing page lists 45 video models, none of these; the pinned `krea_gateway_models.json` has none either.

Maker APIs, found but NOT built:

- BytePlus: OmniHuman 1.5 and 2.0 are on Vision AI (`cv.byteplusapi.com`, req_key `realman_avatar_picture_omni15_cv`), signed with an AccessKey/SecretKey HMAC-SHA256 scheme, not the ModelArk `BYTEPLUS_API_KEY` Nebula holds. Its page lists $0.07/s for OmniHuman 2.0.
- Kling's own API: `POST https://api-singapore.klingai.com/v1/videos/avatar/image2video`, Bearer `KLING_API_KEY`, body image, sound_file, prompt, mode std|pro. Nebula has no Kling key type.

Both need new credential fields and a new handler, and neither can be verified without a paid call, so the nodes have fal and Replicate routes only. Auto goes to the first keyed route. Adding a maker route later is a table edit plus a handler.

## Decisions

- OmniHuman v1 skipped as superseded.
- Settings: `fast_mode` is shared on OmniHuman 1.5 (fal renames it `turbo_mode`); `resolution` is fal-only, `seed` Replicate-only. Kling's `mode` is shared; on fal it picks the endpoint (`endpointWhen`) and is dropped from the body (`FAL_ENDPOINT_DROPS`).
- fal's `mask_url` has no port, and `enable_safety_checker` is left at fal's default.
- Moodboard census: all three are `excluded` (the portrait is the identity, the audio drives the motion).
- **Audio-length pricing.** The price is per second of the audio, so the estimate needs the audio's length. The input-size machinery measured only images and videos; I extended it to audio: `audio-input` joins `INPUT_NODES`, `_probe_audio` in `services/input_sizes.py` (ffprobe, same Nebula-folder-only and no-download rules as video; exactly one audio stream and no real video stream, so cover art is fine; length is the max of stream, format and packet span), `/api/pricing/input-sizes` accepts kind `Audio`, `agent_spend` has audio wording for the cannot-measure reasons, and `runScope.ts`/`inputSizeStore.ts` carry the kind. Unmeasured audio leaves the node unpriced ("awaitingInput"), never a rate shown as a total. This touches the input-size security surface (`test_input_size_security.py` still passes); worth an adversarial look.
- Audio upload uses the existing paths: a data URI on fal (`media_url`), the Files API on Replicate (`replicate_input`, new `REPLICATE_AUDIO_DRIVEN` branch).

## Needs a paid live check (not made)

fal (OmniHuman 1.5, 2.0, Kling std/pro) and Replicate (OmniHuman 1.5, Kling avatar): request shapes are checked against each vendor's schema, not against a live run. Real local audio as a fal data URI (size limits on a long clip) and Replicate's upload are the least certain parts. Replicate OmniHuman 1.5's 35 s audio limit versus fal's 30 s is as published.

## Round 2

Review findings, fixed:

- **Node count pins.** `test_round19_node_names.py` and `test_video_qc_nodes.py` pinned 308 nodes; both now say 311 with a comment naming the three talking heads. Neither can derive the count: each pins the whole catalog on purpose.
- **Price table test.** `pricing.test.ts` lists the five new runtime-priced route labels. The second expectation (`awaitsInput`) holds.
- **Spend refusal wording.** `_awaiting_reasons` kept one `upload` variable for the whole loop and keyed groups by reason alone, so the audio wording leaked onto later nodes. Groups are now keyed by (reason, port type) and each group computes its own wording. Two mixed-graph tests (audio and video in one refusal, in both orders; an image node after an audio node).
- **Size note parity.** The frontend `sizeNote` says "audio's length" like the backend. A shared `sizeNoteCases` list in `pricing_cases.json` is run by both sides.
- **fal missing inputs.** `fal_fields` refuses a missing image or audio for the four talking-head endpoints before any request, in the same words as the Replicate route.
- **Local media to fal.** A local image or audio over the cap is refused before it is read. OmniHuman 2.0 publishes its limits on fal's page (read 2026-11-04): image "Max size: 30 MB", audio "Max size: 15 MB". The other three endpoints publish none, so they get a fixed 20 MB cap.
- **OmniHuman 2.0's 4 s minimum.** fal's page says the audio is "Duration between 4 and 300 seconds" and the output field `duration` is "Duration of audio input/video output as used for billing". It says nothing about padding or billing a shorter clip. So audio under 4 s is refused before the request (when its length is known) and is not priced at 4 s. The 300 s upper limit is left to fal. Audio whose length can't be measured here goes to fal.
- **WAV header.** For a PCM WAV, the bytes after the header over the byte rate are compared with the measured length. Chunks that legitimately follow the data (LIST, id3) are walked and allowed; a file that holds more audio than its `data` chunk declares is left unmeasured (the unreadable path). Audio is listed in `input_sizes.py`'s known limits.
- **Security suite.** The symlink and `..` tests run for Image, Video and Audio.
- **Agent docs.** One sentence on audio-length pricing in `skills/nebula/SKILL.md` (the only mirror of it), `docs/MCP-SETUP.md` (both pricing paragraphs) and `docs/MODEL-PRICING.md`.

GM's r118 copy ruling, built verbatim: Resolution options without parentheses, the three descriptions, the price lines ("per second of audio, rounded up to a whole second. The video runs as long as the audio."), the size note for an Audio port ("Priced from your audio’s length when you run it", backend and frontend), the because-form missing-input refusals on both routes with the node's own name, the moodboard note, and audio-specific AWAITING and SIZE_UNREADABLE tooltip lines (`AWAITING_AUDIO`, `AUDIO_UNREADABLE`, chosen in `runScope.reasonSentences` by the sized port's data type). The spend refusals for agents are unchanged, pending GM.

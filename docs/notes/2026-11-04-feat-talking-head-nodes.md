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

## Round 3

Design review sign-offs, the check's LOW findings, and four items from a real-run report (another session, 2026-11-04).

- **"fal.ai" in every person-facing line.** The too-large refusal and the two node descriptions that said "on fal" now say "fal.ai", as the provider switcher does. Param option labels (`fal`) are the existing convention on every other node and stay.
- **Unpriced, never size-priced.** No code path priced a length-priced node from a size (`estimate_node` / `estimateNode` return None without the audio's length, and a test now pins every route), so the defect was the tooltip: "priced by its input size, because…". The unreadable-audio line is now "“X” isn't priced because Nebula couldn't read its audio's length." and the not-yet-made line "“X” isn't priced yet because its audio doesn't exist yet. Run the node that makes it, then run this one." (plural forms in `unpricedCopy.ts`). Tests: `test_audio_length_priced_node_with_unreadable_audio_has_no_price_at_all` (every node and route, size None or without a usable length) and `never prices a length-priced node from a size…` in `runScope.test.ts`. Mutation: with the fallback restored (the row priced at one second when the audio is unmeasured) 26 backend and 8+ frontend tests fail. A size with no usable length (not None) is unpriced but not "awaitingInput": it can't come from `run_input_sizes`, which gives an audio port only a measured length.
- **Audio wording.** The provider list says "by length" (`providerSwitch.ts`) and the run scope says "Priced when its audio’s length is known:" (colon kept; the later copy PR moves it). The scope's unreadable line for audio now says "Nebula can’t read the length of its audio (a file on another host is never downloaded to price it):" with a curly apostrophe (a straight one fails the apostrophe ratchet). The MCP `price: "by input size"` label (`main.py` `SIZED_PRICE`, agent-facing) is unchanged.
- **Red outline.** It is the `video-gen` category colour, `CATEGORY_COLORS['video-gen'] = '#B71C1C'` (`frontend/src/constants/ports.ts:5`), used for the Inspector dot (`Inspector.tsx:1186`) and the selected card's border (`ModelNode.tsx:433` sets `--node-category-color`; `slava-restraint.css:3341`). Every video-gen node has it; it marks nothing about a missing input. No change.
- **WAV.** After the `data` chunk, more than 64 KiB of trailing bytes, or more than the data chunk itself, leaves the file unmeasured (`WAV_MAX_TRAILING_BYTES`); the parser walks at most 1,024 chunks (`WAV_MAX_CHUNKS`). The BOM escape in `pricing_cases.json` is back to `﻿`.
- **Kling bills the output's length.** A real run on fal: 12.6 s of audio gave a 12.8 s video, billed $0.72 (12.8 × $0.0562); 4 s clips billed about 0.5 s over. Kling AI Avatar v2's price entries (fal and Replicate) now carry `sizing.addSeconds: 1` (the audio's length plus one second, then rounded up, read by `sized_quantities` and `sizedQuantities`), so 12.6 s is priced as 14 s, $0.7868. The `say` line for Kling is new: "… per second of audio plus one second, rounded up to a whole second. The video runs a little longer than the audio." OmniHuman was not observed to differ and is unchanged. Replicate's Kling gets the same pad (same output length; not observed there).
- **fal data: URLs (real-run defect).** OmniHuman on fal answers a `data:` URL with 422 "Failed to download the file". fal's page "fal CDN" (https://fal.ai/docs/documentation/model-apis/fal-cdn, read 2026-11-04) says a model's input is a URL and that data URIs are "not recommended"; it names only the SDK's `upload` and does not spell out the REST calls. The calls are from fal's own client, `fal-client` 1.0.3 (PyPI wheel, read not installed), `client.py` `_upload_via_storage`: `POST https://rest.fal.ai/storage/upload/initiate?storage_type=gcs` with `Authorization: Key <FAL_KEY>` and JSON `{file_name, content_type}`, answered with `{upload_url, file_url}`; then `PUT` the bytes to `upload_url` with the same `Content-Type` (no key); `file_url` is the model input. `route_clients.upload_local_media` does this for the three talking-head fal endpoints (both OmniHuman versions, Kling std and pro) after the existing size cap (the cap's refusal is unchanged and runs before any file is read). Not live-tested. The client's primary path (`v3.fal.media/files/upload`, a token from `/storage/auth/token`) is not used.
  - Follow-up: every other fal endpoint still sends local media as a base64 data URI (`_to_fal_url` in `handlers/fal_universal.py`, `media_url` in `route_clients.py`): all fal image/video/audio nodes with local inputs (FLUX, Seedream, Nano Banana, GPT Image, Kling/Luma video, LTX, ideogram, Hunyuan3D, SeedVR and the rest). They work today only because those endpoints accept data URIs; fal says URLs are the universal form.
  - Replicate: its page "Input files" (https://replicate.com/docs/topics/predictions/input-files, read 2026-11-04) says a data URI is "only recommended if the file is less than 1MB" and that a local file is uploaded by the client. Nebula already uploads local media for Replicate through the Files API (`replicate_model._resolve_media`, `upload_file`), including for both talking-head models, so nothing changes there.
- **Long jobs.** fal: `FAL_VIDEO_POLLS = (600, 3.0)`, 30 minutes (`route_clients.py`), used for every Video-output route including the four talking-head endpoints; running out cancels the job upstream and says "fal.ai took too long, so Nebula stopped waiting. …" (`fal_universal.py`). Replicate: the default was 300 × 3 s, 15 minutes, too short; the two talking-head models now pass 600 polls (`REPLICATE_AUDIO_DRIVEN_POLLS`, `route_clients.py`; `run_model(max_polls=)` in `replicate_model.py`), 30 minutes, and a timeout says "Replicate took too long, …" and cancels the prediction. Other Replicate models keep 15 minutes.

## Round 4 (copy from the design review)
- The not-made-yet tooltips say "hasn’t been made", not "doesn’t exist yet", so "yet" isn't repeated. The bad-key upload line names Settings. The unreachable line reads "fal.ai couldn’t be reached to upload its … file", so the subject isn't ambiguous.
- Kling AI Avatar v2's person line states the billing rule only: "… per second of video, which runs a little longer than the audio." The +1 s pad stays internal (`sizing.addSeconds`) and isn't shown. Sources: fal's model page (fetched 2026-11-04) says "Your request will cost $0.0562 per second" and "Output Duration | Matches audio length". The real bill (12.8 s of video for 12.6 s of audio, $0.72 = 12.8 × $0.0562) shows the seconds counted are the video's.
- Find_nodes and `nebula context` say "by audio length" for these nodes (`main.py` `LENGTH_PRICE`, `model_pricing.sizing_kind`). The fal upload refuses a non-https `upload_url`.
- For the copy PR: param option labels say "fal" while the switcher says "fal.ai"; unify app-wide.
- From the round 3 changed-lines check: a base64 data: URI (a pasted image, an upstream inline value) is uploaded to fal's storage too, never sent inline; one that isn't base64 is refused ("…because its audio file couldn’t be read. Reconnect the file, then run it again."), and the size cap reads a data: URI's decoded size from its length. Every input is checked before anything uploads. The storage PUT must answer 2xx (httpx doesn't follow redirects, so a 3xx stored nothing). Any httpx error becomes the unreachable line.
- Left as known limits (LOW): a fake trailing chunk under 64 KiB can still hide up to ~8 s of 8 kHz 8-bit audio from the WAV length check (a provider that stops at the declared data size wouldn't play it); a WAV whose trailing metadata is bigger than its audio is left unmeasured (unpriced, the safe side); upload_url's host isn't pinned to fal (only the bytes go there, never the key).

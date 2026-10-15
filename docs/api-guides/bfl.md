# Black Forest Labs in Nebula Nodes

> Black Forest Labs (BFL) makes FLUX. Its own API at `api.bfl.ai` runs FLUX 3 Image, FLUX 3 Image Klein, FLUX 3 Video, the FLUX 3 video tools and FLUX.2. With a BFL key saved, Nebula can send FLUX runs straight to BFL, and BFL bills you, instead of going through fal, Replicate, OpenRouter or Krea.

```mermaid
sequenceDiagram
  participant N as Nebula backend
  participant A as api.bfl.ai
  participant D as delivery.*.bfl.ai
  N->>A: POST /v1/<model> (x-key, JSON body)
  A-->>N: {id, polling_url, cost}
  loop until a final status
    N->>A: GET polling_url (x-key; https *.bfl.ai only)
    A-->>N: {status: Pending / Reasoning / Generating ...}
  end
  A-->>N: {status: Ready, result.sample, cost}
  N->>D: GET result.sample (no key)
  D-->>N: image or video bytes, saved to the run folder at once
```

**Status (2026-10-15):** the key and the client are in. No node uses BFL yet: the FLUX 3 nodes, with BFL as their maker route and a provider switcher, come in the next PRs of the routing series. Until then, a saved BFL key shows in Settings and its health check runs, but no run bills it.

## Setup

1. Sign in at https://dashboard.bfl.ai, open **API → Keys** and create a key. Keys are scoped to a project and shown only once (account_management/organizations_projects).
2. Add credits under **API → Credits**. Credits belong to the organization and every project draws on them (account_management/credits_billing).
3. In Nebula, open **Settings → Providers**, find **Black Forest Labs** (`BFL_API_KEY`), choose **Add key**, paste it and save.

Nebula checks the key with `GET https://api.bfl.ai/v1/credits` and the `x-key` header. That call is free and returns `{"credits": n}`. Live probes on 2026-10-15 (no paid calls):

| Key sent | BFL answers | Settings shows |
|---|---|---|
| a real key | 200 `{"credits": ...}` | Valid |
| none, or a well-formed made-up key | 403 `{"detail": "Not authenticated"}` | Invalid |
| a malformed key | 422 `{"detail": "Invalid API key format"}` | Invalid |

## Endpoints the client uses

From BFL's OpenAPI (https://api.bfl.ai/openapi.json, read 2026-10-15). The request bodies are strict (`additionalProperties: false`).

| Model | Endpoint | Output |
|---|---|---|
| FLUX 3 Image (generate and edit, up to 10 references) | `POST /v1/flux-3-image` | image |
| FLUX 3 Image Klein (5.6B, open weights) | `POST /v1/flux-3-image-klein` | image (jpeg or png) |
| FLUX 3 Video (`mode` t2v, i2v, v2v, draft_enhance) | `POST /v1/flux-3-video` | mp4 with audio |
| FLUX Video Edit [fast] | `POST /v1/flux-tools/video-edit-v1` | mp4 |
| FLUX Video Upscale | `POST /v1/flux-tools/video-upscale-v1` | mp4 |
| FLUX.2 [pro] / [max] / [flex] / [klein 9B] / [klein 4B] | `POST /v1/flux-2-pro`, `-max`, `-flex`, `-klein-9b`, `-klein-4b` | image |

The base is always `https://api.bfl.ai`, BFL's global endpoint. BFL also runs `api.eu.bfl.ai` and `api.us.bfl.ai`, and its global endpoint may hand back a polling URL on either.

## How a run works

- **Submit.** The answer is `{id, polling_url, cost, input_mp, output_mp}`; `cost` is in credits.
- **Poll.** BFL says the client "**must** use the `polling_url` returned in the initial request response" (integration_guidelines). Since the key goes with every poll, Nebula only polls an `https` URL on `api.bfl.ai` or another host ending in `.bfl.ai`. Anything else (`http://`, another site, `bfl.ai.evil.com`, a user name or an unusual port in the URL) stops the run before a request is made.
- **Statuses.** The status always comes from the body, even when the HTTP code is 503 or 404: "A failed task can come back as HTTP `503` with a normal JSON body" (flux3_image_generate).

| Status | What Nebula does |
|---|---|
| `Pending`, `Reasoning`, `Generating` | keeps polling and shows progress (BFL's `progress` field has no documented scale, so the bar creeps forward) |
| `Ready` | downloads `result.sample` at once and saves it in the run folder |
| `Request Moderated` | stops: the prompt or an input was blocked before the run, naming BFL's `Moderation Reasons` |
| `Content Moderated` | stops: the output was blocked, with the reasons |
| `No Card Generated` | stops: no result, with any reasons |
| `Error` | stops with BFL's details |
| `Task not found` | stops: the id is unknown or expired |

- **Download at once.** `result.sample` is a signed link that expires: 10 minutes in BFL's general guide, 1 hour for FLUX 3 Image, "about 2 hours" for FLUX 3 video. BFL says "don't send your `x-key` header to it", so the download carries no key.
- **Cost.** The settled `cost` from the final poll is kept with the result in credits and in dollars ("1 credit = $0.01 USD", quick_start/pricing). If BFL leaves it out, the submit's quoted cost is used and marked as quoted.
- **Stopping a run.** BFL documents no cancel endpoint. Stopping a run, or the 60-minute wait running out, only stops polling. The task still finishes on BFL and is billed.
- **Poll errors.** A poll that gets a 5xx with no status in the body, or loses the connection, is retried after 2, 4, 8 and 16 seconds (`backend/execution/poll_retry.py`). A rate-limited poll (429) waits and polls again.

## Errors and what to do

| BFL answer | Meaning | What Nebula says |
|---|---|---|
| 402 | out of credits | "Black Forest Labs credits ran out": add credits on the dashboard |
| 403 | key rejected | check `BFL_API_KEY` in Settings |
| 422 `Invalid API key format` | malformed key | copy the key again from the dashboard |
| 400 / 422 with `detail` | a value BFL won't take | names the field from BFL's `detail` |
| 429 on submit | too many active tasks (FLUX 3 video: "5 per org on the API"; most other endpoints: 24 concurrent requests) | retried after 5, 15 and 30 seconds; then says to wait for a running task |

A submit is never sent twice for any other reason, because a request that may have reached BFL could bill twice. A refused 429 isn't billed.

## Prices (checked 2026-10-15)

From BFL's pricing page (https://bfl.ai/pricing, the same data docs.bfl.ai/quick_start/pricing.md shows). 1 credit = $0.01.

**FLUX 3 Image and Klein, per image** (the same for generating and editing):

| Resolution | FLUX 3 Image | FLUX 3 Image Klein |
|---|---|---|
| 768sq | $0.041 | $0.008 |
| 1k | $0.048 | $0.009 |
| 1.5k | $0.07 | $0.011 |
| 2k | $0.10 | $0.014 |
| 4k | $0.607 | $0.036 |

**FLUX 3 Video, per second of output:**

| Resolution | text or image to video | video to video |
|---|---|---|
| hd | $0.15 | $0.21 |
| fhd | $0.24 | $0.27 |
| qhd | $0.28 | $0.31 |
| uhd | $0.41 | $0.45 |

Drafts (hd only) cost $0.06 per second. The September 10 release note listed older qhd/uhd prices; the pricing page supersedes them.

**Video tools:** Video Edit [fast] $0.03 per output second. Video Upscale $0.07 (precise) or $0.10 (creative) per output megapixel-second, at 24 fps.

**FLUX.2, per megapixel** (first output MP, then each additional output MP and each input MP): [pro] $0.03 then $0.015; [max] $0.07 then $0.03; [flex] $0.05 then $0.05; [klein] 9B $0.015 then $0.002; [klein] 4B $0.014 then $0.001.

These prices aren't in `backend/data/model_pricing.json` yet; they go in with the nodes that use them.

## Not confirmed yet

- The scale of the `progress` field on a poll (0-1 or 0-100).
- What `No Card Generated` means beyond "never becomes Ready"; BFL lists it as a final status without a description.
- `safety_tolerance` limits: BFL's errors page says 0-4 for FLUX 3, the OpenAPI says 0-7 with the approved maximum set per organization.
- Whether FLUX 3 Video takes a webhook: the cookbook shows `webhook_url`, the OpenAPI body doesn't. Nebula polls either way.
- Nothing here was tried against a paid endpoint: no generations were run while building it.

## Code

- Client: `backend/handlers/bfl.py` (`submit`, `get_result`, `run_task`, `polling_url_allowed`). Tests: `backend/tests/test_bfl.py`.
- Key check: `"Black Forest Labs"` in `backend/services/settings.py` `PROVIDER_CHECKS`.
- Key lists: `backend/services/credential_catalog.py`, `desktop/credentials.mjs`, `frontend/src/lib/providerCatalog.ts`, `settings.example.json`.
- Provider audit note: `docs/model-providers/bfl/_provider.md`.

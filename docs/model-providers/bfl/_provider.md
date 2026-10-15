---
id: nebula-bfl-provider
kind: project-provider-integration
project: nebula_nodes
provider: bfl
status: active
verified: 2026-10-15
stale_after_days: 14
---

# Black Forest Labs Provider — Audit Note

Org-level facts every BFL route rests on. The user-facing contract is in
`docs/api-guides/bfl.md`; this note records the sources and what to re-check.
Written in our own words from BFL's OpenAPI and docs (fetched 2026-10-15).

## Sources

- https://api.bfl.ai/openapi.json — endpoints, request bodies, AsyncResponse, ResultResponse / SettledCostResultResponse, the status enum, the `x-key` scheme
- https://docs.bfl.ai/api_integration/integration_guidelines.md — polling URL rule, regional endpoints, delivery URLs, concurrency
- https://docs.bfl.ai/api_integration/errors.md — HTTP codes, statuses, `Moderation Reasons`, `safety_tolerance` ranges
- https://docs.bfl.ai/flux_3/flux3_image_generate.md — 503 with a body, 1-hour result links, no key on the download
- https://docs.bfl.ai/flux_3/flux3_overview.md and cookbook/video_quickstart.md — 2-hour video links, 5 active videos per org, 429
- https://docs.bfl.ai/account_management/organizations_projects.md and credits_billing.md — project-scoped `bfl_` keys, org-level credits
- https://bfl.ai/pricing and https://docs.bfl.ai/quick_start/pricing.md — prices; 1 credit = $0.01

## Provider facts

| Field | Value |
|---|---|
| Submit | `POST https://api.bfl.ai/v1/<model>`, JSON body, answers `{id, polling_url, cost, input_mp, output_mp}` |
| Poll | `GET polling_url` (absolute; may be api.eu / api.us); `/v1/get_result?id=` is the documented form |
| Auth | `x-key: ${BFL_API_KEY}`; keys look like `bfl_<random>`, scoped to a project, shown once |
| Key check | `GET /v1/credits`, free: 200 `{credits}`; 403 `Not authenticated` (missing or made-up key); 422 `Invalid API key format` (live probes 2026-10-15) |
| Statuses | `Task not found`, `Pending`, `Reasoning`, `Generating`, `Request Moderated`, `Content Moderated`, `No Card Generated`, `Ready`, `Error` |
| Result | `result.sample` (signed link: 10 min general, 1 h FLUX 3 Image, ~2 h video), `result.prompt`, `result.duration`; settled `cost` |
| Errors | 400, 402 (credits), 403, 422 (`detail`), 429, 500, 503 |
| Limits | 24 concurrent requests for most endpoints; FLUX 3 video 5 active per org (429 "too many active tasks") |
| Cancel | none documented |
| Webhooks | not on FLUX 3 Image, Klein, Video or Video Edit bodies (OpenAPI); Video Upscale has `webhook_url` |

## Nodes

| Node | Handler | Status |
|---|---|---|
| none yet | `backend/handlers/bfl.py` (`run_task`) | client shipped 2026-10-15; FLUX 3 nodes wire it in a later PR of the routing series |

## Known gaps and re-checks

- `progress` on a poll has no documented scale; the client ignores it and creeps the bar.
- `No Card Generated` has no description beyond being final; treated like moderation.
- `safety_tolerance`: 0-4 for FLUX 3 on the errors page, 0-7 org-gated in the OpenAPI. Re-check before exposing more than 0-4.
- Result-link lifetimes differ between pages; the client downloads at once, so only a very slow download could hit them.
- The delivery host is not restricted (BFL says region hostnames change); the key is never sent to it.
- No paid call has been made against BFL. The first FLUX 3 node PR should run one live image (cheapest: Klein at 768sq, $0.008) with Justin's go-ahead.

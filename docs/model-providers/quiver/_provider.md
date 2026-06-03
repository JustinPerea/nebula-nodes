---
id: nebula-quiver-provider
kind: project-provider-integration
project: nebula_nodes
provider: quiver
status: active
verified: 2026-06-03
stale_after_days: 14
---

# QuiverAI Provider — Audit Note

Org-level facts shared by every Quiver node in Nebula. Per-node audit
notes (`arrow-generate.md`, `arrow-vectorize.md`) cover endpoint-specific
contracts.

## Sources

- `https://docs.quiver.ai` — fetched 2026-05-19 (landing + getting-started)
- `https://docs.quiver.ai/api-reference/introduction` — fetched 2026-05-19 + re-verified 2026-06-03
  (auth, rate limits, error codes)
- `https://docs.quiver.ai/api-reference/models/list-models` — fetched 2026-05-19 + re-verified 2026-06-03
- `https://docs.quiver.ai/api-reference/pricing` — fetched 2026-05-19 (returned 404 on 2026-06-03)
- `https://quiver.ai/pricing` — fetched 2026-06-03 (canonical pricing page; replaces /api-reference/pricing)
- `https://quiver.ai/blog/announcing-our-seed-round` — fetched 2026-05-19 (Arrow positioning)
- `https://api.quiver.ai/v1/openapi.json` — referenced; canonical machine spec

## Provider facts

| Field | Value |
|---|---|
| Base URL | `https://api.quiver.ai` |
| Auth | `Authorization: Bearer ${QUIVER_API_KEY}` |
| Rate limit | 20 req / 60 s (shared across both POST endpoints) |
| Rate-limit headers | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (ms) |
| Retry-After | Honored; client retries once on 429 |
| Stability | `public beta` per docs.quiver.ai branding (re-verify every 14 days) |

## Error codes

| Code | Meaning | Nebula mapping |
|---|---|---|
| 400 | Bad params | `QuiverError` (generic) |
| 401 | Invalid / missing API key | `QuiverAuthError` -> "QuiverAI auth failed — check QUIVER_API_KEY" |
| 402 | Insufficient credits | `QuiverInsufficientCreditsError` -> "Insufficient QuiverAI credits — top up or upgrade plan" |
| 403 | Account frozen | `QuiverAuthError` (same surface as 401) |
| 404 | Model not found | `QuiverError` |
| 429 | Rate limit (post-retry) | `QuiverRateLimitError` -> "QuiverAI rate limit exceeded — retry in a moment" |
| 500/502/503 | Server / upstream | `QuiverServerError` -> "QuiverAI server error: ..." |

## Models (catalog as of 2026-05-19)

Fetched from `GET /v1/models`. All three accept text + image inputs,
emit SVG outputs, and support both `svg_generate` and `svg_vectorize`
operations. Context + max output length = 131,072 tokens on all variants.

| Model ID | Credits (generate) | Credits (vectorize) | Notes |
|---|---|---|---|
| `arrow-1` | 30 | 30 | Legacy |
| `arrow-1.1` | 20 | 15 | Current default |
| `arrow-1.1-max` | 25 | 20 | Higher-quality variant |

`/v1/models` also surfaces two operations Quiver has not yet shipped
endpoints for: `svg_edit` and `svg_animate`. The client is structured
so adding them later is a single new method + new handler; no provider-
level refactor.

## Pricing tier reminder (2026)

⚠️ DRIFT (2026-06-03): The previous note described an SVG-count model
(20 / 100 / 250 SVGs per week). The canonical quiver.ai/pricing page
(fetched 2026-06-03) now describes a **credit-pool model** with weekly
refresh. No "SVG count" limits are mentioned. Updated below.

| Tier | Price | Credits / week | Models |
|---|---|---|---|
| Free | $0 | 200 | Arrow 1.0 + Arrow 1.1 only |
| Basic | $20/mo | 1,000 | Arrow 1.1 Max included |
| Pro | $40/mo | 3,000 | Arrow 1.1 Max included |
| Enterprise | Custom | Custom | SSO, on-premise, custom models |

Credit costs per operation are unchanged (see model catalog above).
Example: Arrow 1.1 generate costs 20 credits → a Free user gets ~10
generates per week (200 ÷ 20). The `credits` field on every Quiver
response carries the per-call cost, which we surface in the model
dropdown labels (e.g. "Arrow 1.1 max (25 credits)") so users see the
price before picking a variant.

**Code impact:** None — our credit-cost accounting was already correct
(costs are read from the API response, not hardcoded from tier limits).
The dropdown labels showing per-call credits remain accurate. No handler
or node-def change needed; the tier description was documentation-only.

## Backend implementation references

- `backend/services/quiver_client.py` — `QuiverClient` class
- `backend/routes/quiver_proxy.py` — `GET /api/quiver/models` (5-min cache)
- `backend/handlers/quiver.py` — `handle_quiver_arrow_generate` + `handle_quiver_arrow_vectorize`
- `backend/models/events.py` — `StreamPartialSvgEvent`

## Findings

Re-verified 2026-06-03. Auth, rate limit, rate-limit headers, error
codes, model IDs, and per-operation credit costs all match canonical
docs. One drift found:

- **Pricing tier description was stale** — old note described an SVG-count
  model; canonical quiver.ai/pricing now uses a credit-pool model.
  Updated in the "Pricing tier reminder" section above. No code change
  needed (credit accounting reads from API responses).

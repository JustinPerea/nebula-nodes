---
id: nebula-typesafe-provider
kind: project-provider-integration
project: nebula_nodes
provider: typesafe
status: active
verified: 2026-10-14
stale_after_days: 14
---

# TypeSafe Provider — Audit Note

Org-level facts shared by every Jev node. The user-facing contract is in
`docs/api-guides/typesafe.md`; this note records what the integration rests
on and what to re-check. Written in our own words from the vendor docs
(fetched 2026-10-14); see https://docs.typesafe.ai for the source.

## Sources

- https://docs.typesafe.ai/api — endpoint, request rules, question and answer types, status codes
- https://docs.typesafe.ai/images — assets, multipart, image limits, the images header
- https://docs.typesafe.ai/primitives/box — Box questions (1.14 only)
- https://docs.typesafe.ai/models — ids, aliases, price, context limits, long context
- https://docs.typesafe.ai/sdk/python/api/retries — the SDK's default retry policy (mirrored here)

## Provider facts

| Field | Value |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Auth | `Authorization: Bearer ${TYPESAFE_API_KEY}` |
| Key check | `GET https://api.typesafe.ai/v1/models` with the Bearer key: 401 for a bad key, 200 for a good one (live probe 2026-10-14); not billed |
| Models | `jev-1.14.0`, `jev-1.13.0` pinned; `jev-latest`, `jev-preview` aliases. `/v1/models` lists only the aliases, but `jev-1.14.0` requests are answered as `jev-1.14.0` |
| Price | input tokens only, $0.042 / Mtok; images billed as input tokens. Measured: ~305 tokens for a short text question, ~2,750 more per 1024 x 1024 image |
| Context | 64k per request / 32k per question; 262k with the long-context header |
| Headers | `TypeSafe-Danger-Zone-Images: true` with images or Box; `TypeSafe-Danger-Zone-Long-Context: true` for long context |
| Retries | 408, 429, 5xx (529 included) and connection failures (a mid-response TLS error included), max 2, Retry-After honoured |
| Request id | `x-typesafe-request-id` response header |

## Nodes

| Node | Handler | Status |
|---|---|---|
| `jev-decide` | `backend/handlers/jev_decide.py` | shipped 2026-10-14 |
| `jev-pick-best` | `backend/handlers/jev_pick_best.py` | shipped 2026-10-14 |
| `jev-box` | `backend/handlers/jev_box.py` | shipped 2026-10-14, experimental |
| QC nodes, `mode: jev` | `backend/services/qc_jev.py` + the four `backend/handlers/qc_*.py` | shipped 2026-10-14 |

## Known gaps and re-checks

- Score's request field is `criteria` (API reference and SDK types agree). The Score docs page shows `levels` only in its interactive demo data, not in a request.
- Error bodies seen live are `{"detail": {"error_type": ..., "message": ...}}` (400 `api_usage_error` when the images header is missing, 401 `authentication_error`). `typesafe_client._error_detail` reads that shape, and still reads `message`, string `detail`, `loc`/`msg` lists, `code` and `field`-like keys in case other errors differ.
- Image tokens measured only at 1024 px (about 2,750 each). Pick Best's cap of 10 fits at that size (~28k of 32k per question); bigger candidates can still go over, and the one retry at 768 px covers that. Re-measure smaller sizes before relying on them.
- Images and Box are marked not production-ready by the vendor; re-check the images page when Jev 1.15 ships.
- When Box confidence comes back `null` isn't documented. In the live probe it was always a number (0.92 present, 0.04 absent, the absent case with a near-full-frame box). Nebula keeps `null` handling and doesn't gate on box confidence.
- Score: sending `criteria` works live; answers carry `legend` (index → level text) and `probabilities` keyed by index strings. Choice answers come back on the neutral keys `a`/`b`/`c`.
- Whether failed requests (such as the probe's 400) are billed is still unchecked; compare the console usage with the summed input tokens.
- Deprecation: the vendor has said 1.13 gets 60 days' notice and 1.14 30 days; no policy page yet.

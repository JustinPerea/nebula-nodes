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
| Key check | none documented; Settings health is `configured_unverified` |
| Models | `jev-1.14.0`, `jev-1.13.0` pinned; `jev-latest`, `jev-preview` aliases |
| Price | input tokens only, $0.042 / Mtok; images billed as input tokens |
| Context | 64k per request / 32k per question; 262k with the long-context header |
| Headers | `TypeSafe-Danger-Zone-Images: true` with images or Box; `TypeSafe-Danger-Zone-Long-Context: true` for long context |
| Retries | 408, 429, 5xx (529 included), max 2, Retry-After honoured |
| Request id | `x-typesafe-request-id` response header |

## Nodes

| Node | Handler | Status |
|---|---|---|
| `jev-decide` | `backend/handlers/jev_decide.py` | shipped 2026-10-14 |
| `jev-pick-best` | `backend/handlers/jev_pick_best.py` | shipped 2026-10-14 |
| `jev-box` | `backend/handlers/jev_box.py` | shipped 2026-10-14, experimental |

## Known gaps and re-checks

- Score's request field is `criteria` (API reference and SDK types agree). The Score docs page shows `levels` only in its interactive demo data, not in a request.
- The error body shape isn't documented; `typesafe_client._error_detail` reads `message`, `detail` (string or `loc`/`msg` list), `code` and `field`-like keys defensively.
- Image token counts aren't published; pricing uses the context ceiling until they are. Pick Best caps candidates at 10 and retries once at 768 px on `max_tokens_exceeded`; raise or drop the cap once a probe measures image tokens.
- Images and Box are marked not production-ready by the vendor; re-check the images page when Jev 1.15 ships.
- When Box confidence comes back `null` isn't documented. Nebula keeps it `null`; it doesn't gate on box confidence.
- Deprecation: the vendor has said 1.13 gets 60 days' notice and 1.14 30 days; no policy page yet.

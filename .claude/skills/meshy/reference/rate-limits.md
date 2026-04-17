# Meshy — Rate Limits

Sourced from docs.meshy.ai/en/api/rate-limits (fetched 2026-04-17).

## Per-tier limits

| Tier | Requests/second | Queue (concurrent generation tasks) | Priority |
|---|---|---|---|
| Pro | 20 | 10 | Default |
| Studio | 20 | 20 | Higher than Pro |
| Enterprise | 100 | 50 default, customizable | Highest |

## Two separate limits

1. **Requests per second** — raw HTTP request limit. Includes polling, submitting, listing, everything.
2. **Queue tasks** — concurrent *generation* tasks in flight.

These are **enforced independently**. You can hit either.

## Which endpoints count against the queue?

Only these:

- Text-to-3D
- Image-to-3D
- Multi-Image-to-3D
- Text-to-Texture (Retexture)
- Remesh

**Do NOT count against queue:** Rigging, Animation, 3D Print, Text-to-Image, Image-to-Image, Upload, Balance.

That means you can rig + animate while 10 generation tasks are queued, no throttling.

## Scope

*"The limits are applied on a per-account basis. This means that the limits are shared across all of your API keys."*

If you have multiple API keys for the same Meshy account, they share the same bucket. Need higher throughput? Separate accounts or Enterprise.

## 429 error shapes

Two distinct error messages tell you which limit tripped:

| Message | Meaning |
|---|---|
| `"RateLimitExceeded"` | You exceeded requests per second |
| `"NoMoreConcurrentTasks"` | You hit the concurrent-task queue cap |

## Backoff guidance

The docs **do not specify** `Retry-After` headers or specific backoff values. Our recommended behavior:

- On `RateLimitExceeded`: exponential backoff starting at 1s, cap at 30s, retry up to 5 times
- On `NoMoreConcurrentTasks`: don't retry rapidly — wait until one of your other tasks completes. Poll your existing tasks and submit the new one only when `SUCCEEDED`/`FAILED`/`CANCELED` count equals or exceeds the queue limit

## Polling interval recommendations

Given 20 req/s on Pro, polling 10 in-flight tasks at 3-second intervals (~3.3 polls/s) is safe. Our backend's `_poll_meshy_task` uses 3.0s as default — keep that unless you move to Studio/Enterprise.

SSE streaming (`/stream` endpoints) is better for long-running tasks — one long-lived connection instead of repeated polling.

## Rate-limit failure modes to handle in nebula

1. **User submits 11 text-to-3d nodes at once on Pro** → 11th hits `NoMoreConcurrentTasks`. Queue them client-side, submit as slots free up.
2. **User has aggressive polling and many nodes** → hits `RateLimitExceeded` on the retrieve endpoints. Stagger polls or switch to SSE.
3. **Long polling session with multi-model batches** → can hit both. Consider Enterprise tier if this is a regular pattern.

## Upgrading

- **Pro → Studio** — 2× queue capacity, same req/s. Good for heavier concurrent workloads.
- **Studio → Enterprise** — 5× req/s, 2.5× queue, customizable. Enterprise-only contracts.

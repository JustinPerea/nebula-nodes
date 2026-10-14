---
title: Nebula Contracts — Node Schema (Volume 1)
status: draft
contract_version: 1
---

# Node schema (Volume 1)

Universal shape for every node in `backend/data/node_definitions.json`. Ports do **not** list all 142 nodes; use the registry and generated `docs/MODEL_REFERENCE.md` for instances.

**Canonical source:** `backend/data/node_definitions.json`
**Drift gate:** `node scripts/check-node-contracts.mjs`
**Frontend mirror:** `frontend/src/constants/nodeDefinitions.ts` (must match registry keys)

---

## 1. Registry entry

Each key in `node_definitions.json` is a **definition id** (stable API name). Graph nodes reference it via `definitionId`.

### Required fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Must equal registry key |
| `displayName` | string | UI label |
| `category` | enum | See §2 |
| `apiProvider` | enum | See §3 |
| `apiEndpoint` | string | Provider path or FAL endpoint id; may be `""` for local nodes |
| `envKeyName` | string \| string[] \| null | Settings / Keychain key(s); `null` for local nodes |
| `executionPattern` | enum | `sync` \| `async-poll` \| `stream` |
| `inputPorts` | Port[] | May be `[]` for source-only nodes |
| `outputPorts` | Port[] | May be `[]` for sink-only nodes |

### Optional param groups

| Group | When used |
|-------|-----------|
| `params` | Default UI params |
| `sharedParams` | Dual-route nodes (shared across FAL + direct) |
| `falParams` | Extra params when routed via FAL |
| `directParams` | Extra params when routed direct |

At least one group may be empty or omitted. Param keys must be unique within a group.

### Runtime graph node (Vol 4)

Execution uses `GraphNode` — definition + instance state:

```json
{
  "id": "n2",
  "definitionId": "gpt-image-2-generate",
  "params": { "quality": "low" },
  "outputs": {}
}
```

`params` on the graph node overrides registry defaults. Large studio payloads (cinema scene, remotion manifest) also live in `node.params` even when registry shows `params: []` — see Volume 7.

---

## 2. Categories

| `category` | Role |
|------------|------|
| `image-gen` | Text/image → image |
| `video-gen` | Text/image → video |
| `audio-gen` | Text/audio → audio |
| `text-gen` | Text → text (chat, completion) |
| `3d-gen` | Image/text → mesh |
| `transform` | Image/video/audio processing |
| `analyzer` | Describe, classify, extract |
| `utility` | Inputs, routers, iterators, embeddings |
| `universal` | FAL / OpenRouter / Replicate catch-alls |
| `cinematic` | Cinema studio bridge nodes |
| `character` | Character studio bridge |
| `moodboard` | Moodboard studio bridge |

Category tags media I/O rules; handler family comes from `apiProvider` (Volume 3).

---

## 3. Providers (`apiProvider`)

Validated set (from `check-node-contracts.mjs`):

`openai`, `anthropic`, `google`, `runway`, `kling`, `elevenlabs`, `replicate`, `fal`, `bytedance`, `minimax`, `luma`, `xai`, `recraft`, `ideogram`, `openrouter`, `bfl`, `higgsfield`, `meshy`, `quiver`, `krea`, `nous`, `utility`

`apiEndpoint` meaning depends on provider:

| Provider style | `apiEndpoint` example | Full URL built by |
|----------------|----------------------|-------------------|
| OpenAI direct | `/v1/images/generations` | Handler prepends `https://api.openai.com` |
| Google | `/v1beta/models/{model}:generateContent` | Handler substitutes model |
| FAL queue | `openai/gpt-image-2` or `fal-ai/flux-pro/...` | `https://queue.fal.run/{endpoint}` |
| FAL universal UI | `https://queue.fal.run` | Node `params.endpoint_id` |

---

## 4. Ports

```typescript
interface Port {
  id: string;
  label: string;
  dataType: PortType;
  required: boolean;
  multiple?: boolean;      // input: accept many connections → list value
  maxConnections?: number; // optional cap
  conditional?: true;      // output only: a gate port, see "Gate ports" below
}
```

### Port types (`dataType`)

`Text`, `Image`, `Video`, `Audio`, `Mask`, `Array`, `SVG`, `Mesh`, `Character`, `Moodboard`, `Any`

**Wiring rule:** source `dataType` must match target, except `Any` which accepts anything.

### Handler input shape

Resolved inputs map port id → `PortValueDict`:

```json
{ "type": "Image", "value": "/path/or/url" }
```

Multi ports (`multiple: true`) resolve to `value` as a **list** when multiple edges connect.

### Handler output shape

Return map port id → `PortValueDict`:

```json
{
  "image": { "type": "Image", "value": "/absolute/path.png" }
}
```

A port the handler leaves out is just missing downstream: the next node still runs, without that input.

### Gate ports (`conditional: true`)

A gate node lets a graph branch. Its conditional output ports carry a value on some runs and are *withheld* on others. Today the only gate is `jev-decide` (`on_pass` / `on_fail`).

- **Withholding.** The handler returns `execution.gating.withheld(reason)` for the port: `{"type": "Any", "value": null, "withheld": "Jev Decide failed (answered no, 0.12)"}`. Only conditional ports can be withheld; withholding any other port fails the node. A conditional port the handler leaves out counts as withheld, so a buggy gate fails closed.
- **The rule.** A node runs only if none of its inbound edges comes from a withheld port or a skipped node. Otherwise it is **skipped**: no `executing` event, no provider call, no cache entry, no charge. It gets a `skipped` event with the gate's reason, and its descendants follow the same rule.
- **Both branches into one node.** A node wired to both `on_pass` and `on_fail` of the same gate is always skipped, since one of them is always withheld. A "first available" merge node is a possible follow-up.
- **Iterators.** The rule applies per item. Below an iterator, a node runs for the items whose gate passed and is skipped for the rest; it is marked skipped only when every item was.
- **Cache.** The withheld entries stay in the cached outputs, so a cache hit skips the same nodes. They never reach port values, events, manifests or the canvas: the engine strips them (`gating.split_outputs`).
- **Events.** `executed` carries `withheld` (port → reason) so the canvas can draw those wires as inactive; `skipped` carries `reason` and `gate_node_id`.

---

## 5. Params

```typescript
interface Param {
  key: string;
  label: string;
  type: ParamType;
  required: boolean;
  default?: string | number | boolean;
  options?: { label: string; value: string | number }[];  // enum
  min?: number;
  max?: number;
  step?: number;
  showWhen?: { param: string; value: string | number };   // conditional UI
  models?: string[];       // show only for selected model values
}
```

### Param types

`string`, `integer`, `float`, `boolean`, `enum`, `textarea`, `file`, `palette`

Enum params must list `options` with `{ label, value }`; `default` must be one of the values.

---

## 6. Execution pattern (summary)

Full semantics: [02-handler-patterns.md](./02-handler-patterns.md).

| `executionPattern` | Typical use |
|--------------------|-------------|
| `sync` | Single HTTP round-trip, full response |
| `stream` | SSE token or image stream |
| `async-poll` | Submit job → poll status → fetch result |

**Local nodes** (no API key): `text-input`, `image-input`, `router`, etc. — executed in-engine, not via handler registry. Listed in `LOCAL_EXECUTION_NODE_IDS` in `engine.py` and `check-node-contracts.mjs`.

---

## 7. Dual-route and internal params

Some nodes share a definition shape but route differently at runtime:

| Pattern | Example |
|---------|---------|
| FAL wrapper injects `endpoint_id` | `gpt-image-2-fal-generate` → `openai/gpt-image-2` |
| Model param selects wire format | `gpt-image-1-generate` → `model` in body |
| Universal node | `fal-universal` + user-selected `endpoint_id` |

Internal keys (not forwarded to provider): `endpoint_id`, and any key the handler documents as registry-only.

---

## 8. Exemplars

Full vertical slices (registry + handler + events):

| Family | Exemplar |
|--------|----------|
| OpenAI image stream (direct) | [examples/gpt-image-2.md](./examples/gpt-image-2.md) |
| FAL image stream (passthrough) | [examples/gpt-image-2-fal.md](./examples/gpt-image-2-fal.md) |
| Google image sync | [examples/nano-banana.md](./examples/nano-banana.md) |
| Google chat stream | [examples/gemini-chat.md](./examples/gemini-chat.md) |
| Google audio (Lyria / TTS) | [examples/lyria-3.md](./examples/lyria-3.md), [examples/gemini-tts.md](./examples/gemini-tts.md) |
| Google embeddings | [examples/gemini-embeddings.md](./examples/gemini-embeddings.md) |
| Google video (Veo / Omni) | [examples/veo-3.md](./examples/veo-3.md), [examples/gemini-omni-flash.md](./examples/gemini-omni-flash.md) |
| Google utility (style ref) | [examples/style-reference.md](./examples/style-reference.md) |
| FAL Nano Banana | [examples/nano-banana-fal.md](./examples/nano-banana-fal.md) |

---

## Changelog

| Date | Change |
|------|--------|
| 2026-07-01 | Initial node schema |
| 2026-10-14 | Gate ports (`conditional: true`) and the skip rule |

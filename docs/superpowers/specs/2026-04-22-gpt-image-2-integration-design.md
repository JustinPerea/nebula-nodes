# GPT Image 2 Integration — Design Spec

- **Date:** 2026-04-22
- **Status:** Approved design — implementation plan pending
- **Source model:** `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`), released by OpenAI 2026-04-21, also live on FAL same day
- **Scope:** Add four new image-generation nodes, extend streaming infrastructure for image partials, ship a two-part prompting skill for the in-app Claude chat

---

## 1. Goals

1. Users can generate and edit images with `gpt-image-2` from the Nebula canvas via either OpenAI direct (BYOK `OPENAI_API_KEY`) or FAL proxy (BYOK `FAL_KEY`).
2. Partial images stream to the canvas as they arrive — no waiting for the final frame before seeing progress.
3. The in-app Claude chat node knows how to author strong gpt-image-2 prompts (text rendering, multi-image references, mask edits) and knows the Nebula-specific node IDs / param names.

## 2. Non-Goals

- No changes to existing `gpt-image-1-*` or `gpt-image-1-5*` nodes or handlers. V1 stays frozen.
- No dual-path single-node architecture (no `sharedParams/falParams/directParams` — the memory rule is obeyed by shipping **separate** direct and FAL nodes).
- No exposure of unsupported v2 params (`background=transparent`, `input_fidelity`) — node defs omit them entirely.
- No Responses API (`/v1/responses` image_generation tool) in this pass. Stays on `/v1/images/generations` + `/v1/images/edits`. Can be added later.
- No freeform "custom size" input field. Enum-only.

## 3. Canonical Facts (from vendor docs, fetched 2026-04-22)

**Model IDs:** `gpt-image-2`, snapshot `gpt-image-2-2026-04-21`.
**OpenAI endpoints:** `/v1/images/generations`, `/v1/images/edits`, `/v1/responses` (out of scope).
**FAL endpoints:** `openai/gpt-image-2` (generate), `openai/gpt-image-2/edit` (edit).

**Sizes (OpenAI direct):**
- Popular enum values: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, `auto`
- Arbitrary sizes allowed in principle: max edge ≤ 3840, both edges multiples of 16, long:short ratio ≤ 3:1, total pixels 655,360–8,294,400. We expose only the popular set.

**Quality:** `low | medium | high | auto` (default `auto`).

**Output format:** `png | jpeg | webp`. `output_compression` (0–100) applies to jpeg/webp only.

**Moderation:** `auto | low`.

**Streaming:** `stream: true` with `partial_images: 0–3`. Each partial adds ~100 output tokens. Event types:
- Images API: `image_generation.partial_image` with `b64_json` + `partial_image_index`
- Responses API: `response.image_generation_call.partial_image` with `partial_image_b64` + `partial_image_index`

**Input fidelity:** MUST be omitted for gpt-image-2 (model always processes inputs at high fidelity). Sending it will error.

**Transparent background:** NOT supported on gpt-image-2 (v1 supports it). Omit the param.

**Edit endpoint:** accepts up to 10 input images. Mask is prompt-guided (the mask is an alpha-channel PNG of the same size/format as the first input image). Prompt must describe the full resulting image, not just the masked region.

**Default response:** base64 in `data[0].b64_json`. No `response_format` needed.

**Org verification:** required on OpenAI.

**Pricing (OpenAI direct, token-based):**
- Text in $5/M, image in $8/M (cached $1.25/$2.00), output $30/M
- Rough per-image at 1024²: low $0.006, medium $0.053, high $0.211
- Batch API: 50% discount

**Pricing (FAL, per-image):** $0.01 (low, 1024×768) → $0.41 (high, 4K).

## 4. Architecture

### 4.1 Node Taxonomy

Four new nodes, `category: "image-gen"`, `executionPattern: "stream"`:

| Node ID | Provider | API endpoint | Env key | Display name |
|---|---|---|---|---|
| `gpt-image-2-generate` | `openai` | `/v1/images/generations` | `OPENAI_API_KEY` | GPT Image 2 |
| `gpt-image-2-edit` | `openai` | `/v1/images/edits` | `OPENAI_API_KEY` | GPT Image 2 Edit |
| `gpt-image-2-fal-generate` | `fal` | `openai/gpt-image-2` | `FAL_KEY` | GPT Image 2 (FAL) |
| `gpt-image-2-fal-edit` | `fal` | `openai/gpt-image-2/edit` | `FAL_KEY` | GPT Image 2 Edit (FAL) |

Four dedicated nodes sidestep the dual-param architecture rule. Mirrors how `gpt-image-1-5` coexists with `gpt-image-1-generate` today.

### 4.2 Backend File Layout

| File | Change type | Purpose |
|---|---|---|
| `backend/handlers/openai_image_v2.py` | **new** | `handle_gpt_image_2_generate`, `handle_gpt_image_2_edit` — streaming handlers for the OpenAI-direct path |
| `backend/execution/stream_runner.py` | extend | Add image-mode stream parsing + `streamPartialImage` emit |
| `backend/execution/sync_runner.py` | extend | Register 4 new node IDs (2 → direct handler, 2 → FAL handler with endpoint preset, same pattern as `gpt-image-1-5`) |
| `backend/data/node_definitions.json` | extend | Add 4 node defs |
| `backend/tests/test_openai_image_v2.py` | **new** | Unit tests for v2 handler |
| `backend/tests/test_stream_runner_image.py` | **new** | Image-mode stream runner coverage |
| `backend/handlers/openai_image.py`, `openai_image_edit.py` | **untouched** | V1 sync path stays frozen |

### 4.3 Frontend File Layout

| File | Change type | Purpose |
|---|---|---|
| `frontend/src/types/index.ts` | extend | Add `streamingPartials?: { index: number; src: string }[]` to `NodeData` |
| `frontend/src/lib/wsClient.ts` | extend | Add `streamPartialImage` message variant |
| `frontend/src/stores/graphStore.ts` (or equivalent) | extend | Handler pushes incoming partials into `streamingPartials` sorted by `index` |
| `frontend/src/components/nodes/DynamicNode.tsx` | extend | When `executionPattern === 'stream'` and output type is `Image`, render latest partial during execution; swap to final on completion |
| `frontend/src/constants/nodeDefinitions.ts` | extend | Mirror 4 new node defs (existing duplication pattern) |

No new frontend components. No new routes. No new state slices — `streamingPartials` lives next to the existing `streamingText` field.

### 4.4 Data Flow — Generate (OpenAI direct, streaming)

1. User executes a graph containing `gpt-image-2-generate` with `prompt="…"`, `partial_images=2`.
2. `sync_runner.py` dispatches to `handle_gpt_image_2_generate`.
3. Handler builds body: `model`, `prompt`, `size`, `quality`, `n`, `output_format`, optional `output_compression`, `moderation`, `stream: true`, `partial_images`. Omits `background` and `input_fidelity` unconditionally.
4. POSTs to `/v1/images/generations` via `stream_execute(mode="image", …)`.
5. For each `image_generation.partial_image` SSE event:
   - Decode `b64_json` → save to `run_dir/{node_id}_partial_{index}.png` via existing `save_base64_image`
   - `emit({type: "streamPartialImage", nodeId, partialIndex: index, src: file_path, isFinal: false})`
6. On final image event:
   - Save as `run_dir/{node_id}.png`
   - Return `{"image": {"type": "Image", "value": str(file_path)}}`
7. `sync_runner` emits completion; frontend swaps partial previews for the final image.

### 4.5 Data Flow — Generate (FAL, streaming)

FAL uses its own SSE event shape. `fal_universal.py` is extended to emit image partials via the same `streamPartialImage` WS message. The `stream_execute` image-mode parser supports two SSE dialects — OpenAI-direct (`image_generation.partial_image`) and FAL (FAL's partial shape) — selected via a `provider` argument. Frontend-side the event type is identical, so downstream code stays provider-agnostic.

Param names in the FAL node def follow FAL's convention (`image_size`, `num_images`) rather than OpenAI's (`size`, `n`). This matches the precedent set by `gpt-image-1-5`.

### 4.6 Data Flow — Edit

Same as generate, plus:
- Input ports: `image` (Image, `multiple: true`, required), `mask` (Mask, optional).
- Max 10 input images (enforced client-side and rejected server-side with clear error if exceeded).
- Mask: alpha-channel PNG matching first image's size and format. The handler does not synthesize masks.
- Prompt must describe the full desired output (docs requirement).

## 5. Node Definitions (detailed)

### 5.1 `gpt-image-2-generate` params

| Key | Type | Default | Allowed values |
|---|---|---|---|
| `size` | enum | `auto` | `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840` |
| `quality` | enum | `auto` | `auto`, `low`, `medium`, `high` |
| `n` | integer | `1` | 1–10 |
| `output_format` | enum | `png` | `png`, `jpeg`, `webp` |
| `output_compression` | integer | `90` | 0–100 (only sent when `output_format ≠ png`) |
| `moderation` | enum | `auto` | `auto`, `low` |
| `partial_images` | integer | `2` | 0–3 |

### 5.2 `gpt-image-2-edit` params

Same as generate, minus nothing added (`input_fidelity` deliberately NOT exposed).

Input ports:
- `image`: Image, required, `multiple: true` (up to 10)
- `prompt`: Text, required
- `mask`: Mask, optional

### 5.3 FAL node params

Mirror FAL's naming (`image_size`, `num_images`). Exact enum values match OpenAI's popular set where FAL supports them. FAL-specific fields documented inline in the node def.

## 6. Protocol Additions

### 6.1 WebSocket message

```ts
{ type: 'streamPartialImage';
  nodeId: string;
  partialIndex: number;  // 0..(partial_images-1)
  src: string;           // server-relative path to saved partial
  isFinal: boolean; }    // true on final-image event
```

Sits alongside existing `streamDelta`. Frontend router pushes into `streamingPartials[partialIndex]`.

### 6.2 Emit function signature

`stream_runner.stream_execute` grows a `mode: Literal["text","image"] = "text"` parameter. When `mode="image"`, it parses partial-image events and calls `emit({type: "streamPartialImage", …})` instead of `streamDelta`. Final image returned via function return value as today.

## 7. Error Handling

| Condition | Response |
|---|---|
| Missing `OPENAI_API_KEY` / `FAL_KEY` | `ValueError` with which key is needed (existing pattern) |
| OpenAI `organization_must_be_verified` | `RuntimeError("Your OpenAI org isn't verified for gpt-image-2. Visit https://platform.openai.com/settings/organization/general to verify.")` |
| Invalid size (not in enum) | Node-def level — UI prevents. Server-side `ValueError` as defense-in-depth. |
| `background` or `input_fidelity` in params | Silently dropped by handler with a log line |
| >10 input images on edit | `ValueError("gpt-image-2 edit accepts up to 10 input images; got N")` |
| Stream disconnect mid-generation | Partials already saved to disk are kept; node marked errored with message |
| SSE parse error | Logged, partial skipped, stream continues |

## 8. Testing

### 8.1 Automated

- `test_openai_image_v2.py`
  - Builds correct request body for common combinations
  - Omits `background` and `input_fidelity` even if present in params
  - Raises clean error on missing API key
  - Maps 403 org-verification error to the custom message
  - Fakes SSE transcript → handler calls `emit` with correct `streamPartialImage` payloads and returns a saved file path
  - Rejects >10 images on edit
- `test_stream_runner_image.py`
  - Image mode: feeds a recorded SSE fixture of 3 partials + final, verifies save paths and emit calls
  - Text mode: regression check that existing behavior is unchanged
- Node registry test: 4 new IDs resolve to the correct handler + endpoint preset

### 8.2 Manual (user-verified)

- [ ] Generate `gpt-image-2-generate` at `1024x1024` low — see ≥1 partial before final
- [ ] Generate at `3840x2160` high — final arrives, partials render at intermediate index
- [ ] Edit with 1 image + mask, prompt describes full scene
- [ ] Edit with 3 images (multi-ref), no mask
- [ ] Trigger unverified-org error — see friendly message
- [ ] FAL generate — same basic flow works with `FAL_KEY`
- [ ] Partial previews swap to final image on completion (no ghosting)

## 9. Skill Design

### 9.1 Project-local — `nebula_nodes/.claude/skills/gpt-image-2/SKILL.md`

**Trigger:** description activates when a graph contains any `gpt-image-2-*` node, or the user mentions gpt-image-2 in a Nebula context.

**Contents:**
- Node ID matrix (generate, edit, fal-generate, fal-edit) with one-line purpose each
- Exact param names and allowed values (mirrored from section 5)
- What's unsupported and why (transparent bg, input_fidelity)
- Default recommendations: `quality=auto` for typical work, `high` for hero assets, `low` for iteration
- Cost notes: link to OpenAI calculator and FAL per-image tiers
- How to write a prompt that the `claude-chat` node can rewrite into a gpt-image-2 prompt (references the global skill for craft)
- Cross-reference: "For prompting craft, see global `gpt-image-2` skill"

### 9.2 Global — `~/.claude/skills/gpt-image-2/SKILL.md`

**Trigger:** "gpt-image-2", "ChatGPT Image 2", "OpenAI Image 2" in any session.

**Contents — distilled from the vendor guides:**

1. **The five-slot prompt template** (Scene / Subject / Important details / Use case / Constraints)
2. **Anti-slop rules:**
   - Visual facts over vague praise ("overcast daylight, brushed aluminum" not "stunning, cinematic")
   - Style tags need visual targets
   - Say the real thing — name the object
   - In edits, separate Change from Preserve
   - Treat text like typography
   - One revision per turn
3. **Text rendering:** wrap literal text in quotes or ALL CAPS, specify font style/size/color/placement, spell hard words letter by letter. Include the "Headline (EXACT TEXT)" + "Render the text verbatim / No extra words / No duplicate text" constraint block pattern.
4. **Multi-image reference pattern:** label each input by role (`Image 1: base to preserve`, `Image 2: jacket reference`), then issue a single compositing instruction. Hard cap at 10.
5. **Mask editing pattern:** Change block / Preserve block / Constraints block. Prompt describes the **full** resulting image, not just the mask region.
6. **Consistency tricks:** restate the character/product spec on each turn, repeat the preserve list to reduce drift.
7. **Camera + lighting vocabulary cheatsheet** (framing, lens feel, light source phrases).
8. **3–4 verbatim example prompts** across: editorial photoreal, product shot, UI screenshot, readable signage.
9. **Known limits:** no transparent background, may still occasionally miss text placement, input_fidelity is always high.

**Sources** (cited in the skill):
- `https://developers.openai.com/api/docs/models/gpt-image-2`
- `https://developers.openai.com/api/docs/guides/image-generation`
- `https://developers.openai.com/cookbook/examples/generate_images_with_gpt_image`
- `https://fal.ai/learn/tools/prompting-gpt-image-2`

### 9.3 Cross-referencing

Project skill points to global for craft; global points to project for Nebula-specific node IDs and UX. Neither duplicates the other's content.

## 10. Rollout Order (to be detailed in the implementation plan)

Tentative phases. The plan skill will refine:

1. Research pass confirmed (this doc).
2. Node defs + sync v2 handler behind a feature flag (temporarily `executionPattern: sync`, no partials) — land quickly, verify base API works.
3. Stream runner image-mode extension + `streamPartialImage` WS event + handler upgrade to streaming.
4. Frontend partial-preview rendering.
5. FAL-routed nodes + FAL stream parsing.
6. Skills written (both locations).
7. Manual UAT pass per section 8.2.

## 11. Open Items Deferred

- Responses API `/v1/responses` `image_generation` tool integration (richer revised_prompt UX in claude-chat).
- Exposing `gpt-image-1-mini` as a separate node (user deferred).
- Upgrading v1.5 with an OpenAI-direct sibling (user deferred).
- Freeform custom-size input supporting the full constraint set (max edge 3840, multiples of 16, ratio ≤ 3:1).
- Batch API submission path for half-price rendering.

## 12. Changelog

- 2026-04-22: Initial design, approved in brainstorming session.

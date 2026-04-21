# Drag Image to Chat — Design Spec

> **Date:** 2026-04-21
> **Project:** Nebula Nodes — chat panel → canvas vision loop
> **Status:** Approved — ready for implementation planning
> **Supersedes:** backlog `.planning/backlog/chat-panel-followups.md#2` (v2 portion) and `#4` (file-upload-into-chat) — both fold into this design.

---

## Overview

Let the user drag images into the chat panel so Claude can reason about them visually. Two drop sources: (1) canvas-node images (input previews or model outputs) and (2) external files from the OS. Both result in the same outcome — the image is a canvas image-input node with a short ID, and Claude sees the pixels via its built-in Read tool pointed at the node's local file path.

This direct hit on v1 pillar #3 (Claude chat fluency) unlocks visual iteration loops: "what's wrong with this render", "compare @n3 and @n5", "make a warmer version of the one I just dropped from Finder." Today the chat carries only text; the `@nX` chip drop is resolved via the nebula CLI but Claude never sees the pixels. After this feature, every image the user drops is vision-visible to Claude without ever needing content-block plumbing in the chat protocol.

---

## Locked Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| v1 media scope | Images only | Biggest leverage on pillar #3. Video/audio/mesh deferred. |
| Drag sources | Any image on the canvas (inputs + outputs), plus OS files | Same plumbing for both; maximum coverage for minimum branching. |
| Composer UX | Thumbnail chip above textarea + `@nX` marker inserted at caret | Visual chip for human feedback + text marker so the Send payload is self-describing. |
| Multi-attach | Up to 4 images per message | Compare/contrast loops need multi-image; 4 is the practical ceiling before the UX gets cluttered. |
| Delivery mechanism | `@nX` refs in message text → Claude calls `nebula show nX --path` → Read | Uses documented tools on both transports. Sidesteps undocumented image-content-block paths in both `claude -p` stdin and the Agent SDK. |
| Chat transport | Stay on `claude -p` subprocess | Preserves subscription auth. Agent SDK migration is orthogonal and deferred. |
| External-file drop → node creation | Synchronous on drop, before Send | User sees their action land on the canvas immediately. |
| File storage | `backend/data/chat-uploads/<sha256>.<ext>`, served at `/api/uploads/` | Hash filenames give free dedup; separate mount keeps input/output semantics distinct. |
| File lifecycle | Persist indefinitely in v1 | "I lost my uploaded image when I deleted a node" is worse than disk bloat. GC deferred. |
| Thumbnail generation | None | Browser scales full-res; sizes involved don't justify a thumb pipeline. |
| WebSocket payload | Unchanged — `{ type, message, sessionId, model }` | All image refs go through `@nX` in the message text; no new field needed. |
| Message-log bubble | Thumbnails rendered above the text | Matches ChatGPT / Claude.ai history layout; visually anchors the text to the images it's about. |
| Chip × behavior | Removes chip AND the first matching `@nX` marker from the textarea | Chip and marker exist together; removing only one is a footgun. |

---

## Non-Goals

- **Moodboard replacement.** Chat-drop is ephemeral per-turn iteration. The planned moodboard owns persistent visual references. Dropped images become normal canvas nodes — no library, no tagging, no favorites surface inside chat.
- **Video / audio / mesh drops.** Only image preview blocks in `ModelNode` become drag sources. Other media stay non-draggable in v1.
- **Video-frame extraction as pseudo-image.**
- **Thumbnail generation endpoint.**
- **Disk GC for chat-uploaded files.**
- **`images` field in the WebSocket payload.** All refs go through the message text.
- **Agent SDK migration.** Orthogonal; this feature ships cleanly on `claude -p`.
- **"Drag from Claude's image reply" as a separate mechanism.** If Claude generates an image, it lands as a canvas node (via `nebula run`); dragging from that node image uses the same pipeline.
- **Frontend reconciliation of uploads orphaned by WebSocket disconnect mid-upload.** Accepted edge: the node still appears on canvas via `graphSync`; user re-drops for the chip.

---

## Architecture

**Core principle:** every image Claude sees is a canvas node. The chat protocol never carries image bytes. Claude reads images through its built-in Read tool, pointed at local file paths it looks up via the nebula CLI.

### Data flow — canvas-node image drop

1. User starts drag on a `<img>` preview inside a `ModelNode`. The `onDragStart` handler sets three `dataTransfer` entries:
   - `application/nebula-image-ref` → `JSON.stringify({ nodeId, url })`
   - `application/nebula-node-ref` → `@nX` (existing behavior preserved)
   - `text/plain` → `@nX` (fallback)
2. `ChatPanel` textarea drop handler detects `application/nebula-image-ref`, parses the JSON, appends to `pendingImages` state, and inserts `@<nodeId>` at the caret.
3. Chip row renders above the textarea with the thumbnail.
4. On Send, the existing WebSocket payload (`{ type, message, sessionId, model }`) carries the message text with `@nX` tokens already embedded. No bytes. No new fields.

### Data flow — external file drop

1. `ChatPanel` textarea drop handler detects `dataTransfer.files.length > 0` and an image MIME.
2. For each accepted file (up to `4 - pendingImages.length`), frontend POSTs `multipart/form-data` to `POST /api/chat/uploads`. Shows a transient "Uploading…" chip with spinner per file.
3. Backend validates (content-type, size), hashes to `sha256`, writes to `backend/data/chat-uploads/<sha256>.<ext>` if new, calls `CLIGraph.add_node("image-input", params={ file, _previewUrl }, position={ x: maxX+300, y: 100 })`, broadcasts `graphSync`, returns `{ nodeId, url, thumbUrl, filename }`.
4. Canvas receives `graphSync` and renders the new image-input node automatically (existing pipeline).
5. Composer chip swaps from "Uploading…" placeholder to real thumbnail + `@nX` label. Frontend inserts `@<nodeId>` at the caret.
6. On Send, behavior is identical to the canvas-node drop case.

### How Claude sees the image

The primer teaches Claude: when the user references `@nX` and asks a visual question, call `nebula show nX --path` to get the absolute local file path, then call Read on that path. Read returns vision content to Claude internally. No image plumbing on our side.

### Transport independence

This design does not depend on whether the chat bridge is `claude -p` subprocess or the Claude Code Agent SDK. Both support Read and the nebula CLI. If the chat bridge migrates to the SDK later (orthogonal work), this feature keeps working without changes.

---

## Frontend

### Drag sources

`frontend/src/components/nodes/ModelNode.tsx`:

- The `imageOutput` preview `<img>` and the `imageInputPreview` `<img>` become draggable. `onDragStart` sets the three `dataTransfer` types described above. The cursor changes to a grab cursor on hover of those images.
- Video / audio / mesh preview blocks are unchanged (non-draggable in v1).
- Node output image is only draggable once `imageOutput.value` is defined — no drag source before generation completes.

### Composer state

`frontend/src/components/panels/ChatPanel.tsx`:

```ts
type PendingImage =
  | {
      id: string;                    // local UUID for React keys
      status: 'uploading';
      thumbUrl: string;              // object-URL from the dropped File for preview
      label?: string;                // original filename
    }
  | {
      id: string;
      status: 'ready';
      nodeId: string;                // short node ID (e.g. 'n8'); exists once POST resolves
                                     // or is known immediately for canvas-node drops
      thumbUrl: string;
      label?: string;
    }
  | {
      id: string;
      status: 'error';
      error: string;                 // human-readable message
      thumbUrl?: string;
      label?: string;
    };

const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
```

Only `ready` chips carry a real `nodeId`; `uploading` chips render a spinner with a preview-only thumbnail (built from the dropped `File` via `URL.createObjectURL`) and no `@nX` marker in the textarea yet. The text marker is inserted at the moment a chip transitions to `ready`. Canvas-node drops skip the `uploading` state entirely.

**Rules:**
- Max 4 ready chips. Dropping additional files or node images over the limit shows a single inline notice.
- Dedup by `nodeId`: the same canvas-node image dropped twice is a silent no-op.
- Send is disabled while any chip is `uploading`.

### Drop handler branches (order matters)

1. `dataTransfer.types.includes('application/nebula-image-ref')` → canvas-node image drop. Parse JSON, add `ready` chip, insert text marker.
2. `dataTransfer.files.length > 0` → external file drop. Pre-check MIME (`image/*`). Reject non-image files with inline notice. POST each accepted file; track with `uploading` chip; swap to `ready` on success, `error` on failure.
3. `dataTransfer.types.includes('application/nebula-node-ref')` → existing `@nX` text-insert behavior. No chip.
4. `dataTransfer.types.includes('text/plain')` → existing fallback.

### Chip UI

- Row sits inside `.chat-panel__input`, above the `<textarea>`.
- Each chip: 48×48 thumbnail (`object-fit: cover`, rounded), `@nX` label overlay at bottom, `×` close button on hover (top-right).
- Clicking `×` removes the chip and deletes the first matching `@nX` occurrence from the textarea value.
- Row height collapses to 0 when no chips.

### Send behavior

- Pending images stay attached visually until Send completes (message reaches WebSocket).
- On Send: WebSocket payload unchanged; `pendingImages` clears immediately; user-message bubble in chat log persists a snapshot of the attached thumbnails so history renders correctly.
- If Send is blocked (disconnected / busy / all chips in `uploading`), the chip row stays visible.

### Message-log rendering

`ChatMessage` user variant extends to:

```ts
{ role: 'user'; text: string; id: string; images?: Array<{ nodeId: string; thumbUrl: string }> }
```

User bubbles render the thumbnail row above the text when `images?.length > 0`.

---

## Backend

### New endpoint: `POST /api/chat/uploads`

- Body: `multipart/form-data` with one `file` field.
- Validate content-type against `{ image/jpeg, image/png, image/webp, image/gif }`. Reject with 415 otherwise. Sniff first 512 bytes — don't trust the client-provided MIME.
- Validate size ≤ 20 MB. Reject with 413 otherwise.
- Compute `sha256` of bytes. Save to `backend/data/chat-uploads/<sha256>.<ext>`. Skip write if file already exists (dedup).
- Call `CLIGraph.add_node("image-input", params={ file: serving_url, _previewUrl: serving_url }, position={ x: max_x + 300, y: 100 })`. Auto-layout mirrors the frontend's existing heuristic.
- Broadcast `graphSync` via the existing mechanism.
- Return `200 { nodeId, url, thumbUrl, filename }`. `thumbUrl == url` in v1.

### Static file serving

Mount `backend/data/chat-uploads/` at `/api/uploads/` via FastAPI `StaticFiles`, parallel to the existing `/api/outputs/` mount. Separate mount = explicit input/output semantic boundary and divergent lifecycle policies later.

### New CLI flag: `nebula show <nodeId> --path`

- Without `--path`: unchanged human-readable dump.
- With `--path`: print absolute local filesystem path of the node's primary image file to stdout, exit 0.
- Primary image resolution order:
  1. Image-input node: `file` param (or `_previewUrl` if `file` is absent).
  2. Model node with image output: `_output_image` output value.
  3. Otherwise: exit 1 with `no image file for node <id>` on stderr.
- URL → path resolution: serving URLs under `/api/uploads/` or `/api/outputs/` map to their filesystem roots. External URLs (http/https not matching those prefixes) exit 1 with `image not local` on stderr.
- Safety: always assert the resolved path has the expected root prefix to prevent path traversal if the cli_graph state is ever tampered with.

### Chat session bridge — no changes

`backend/services/chat_session.py` unchanged. No new WebSocket fields, no image handling in the subprocess call. The primer text changes (see Primer section), but the primer-loading mechanism (`--append-system-prompt`) is unchanged.

### Files touched on the backend

- `backend/main.py` — add `POST /api/chat/uploads`, mount `/api/uploads/`.
- `backend/services/cli_graph.py` — verify `add_node` supports the image-input case (likely already works; validate during implementation).
- `backend/cli/__main__.py` — add `--path` flag to the `show` subcommand.
- `backend/services/chat_session.py` — update the primer text only.

---

## Primer Update

Add the following rule block to `NEBULA_SYSTEM_PRIMER` in `backend/services/chat_session.py`, immediately after the existing `VERIFY AFTER CREATE` section:

> **SEE THE IMAGE BEFORE ANSWERING VISUAL QUESTIONS.** When the user's message references an image node (`@nX` where nX is an image-input or a model node with an image output) and asks a question that depends on the visual content — "how does this look", "what's wrong with it", "make it warmer", "compare these", "why is it washed out", "does it match the reference", and similar — you MUST see the pixels before replying.
>
> To see an image: run `nebula show nX --path` to get the absolute local file path, then call the Read tool on that path. Read returns the image as vision content you can reason about directly. Do NOT describe the image back to the user ("I see a robot sitting on…") — they can see it too. Answer their question.
>
> Only Read what you need. If the user references three images and asks about one of them, only Read the relevant one. Don't Read the same file twice in one turn.
>
> If `nebula show nX --path` exits non-zero (the node isn't an image or its file isn't locally resolvable), surface that in plain language: "I can't see @nX — it isn't an image node." Don't guess.
>
> You do NOT need to Read images when the user's question is structural ("what node does this connect to", "what model generated this"). Use `nebula graph` or `nebula show nX` without `--path` for those.

**Expected effect on primer size:** +~250 tokens. Current primer is ~1200 tokens; post-change ~1450. Well within reasonable system-prompt sizes.

**Migration:** none. The primer is appended per-invocation via `--append-system-prompt`. Existing resumed sessions get the new primer on their next turn.

---

## Error Handling & Edge Cases

**Upload failures (frontend handles the UX):**

| Condition | Backend response | Frontend UX |
|-----------|------------------|-------------|
| File > 20 MB | `413` | Red chip with "Image > 20MB", no node, no marker. |
| Wrong MIME | `415` | Red chip with "Not an image". Frontend also pre-checks to prevent most cases. |
| Disk / cli_graph error | `500` | Red chip with Retry button. 3 retries, then auto-dismiss with toast. |
| Upload in-flight | — | Send button disabled until all chips resolve. |

**Drag edge cases:**

- Drop 5+ files: accept first `(4 - pendingImages.length)`, single inline notice for the rest.
- Drop non-image file: rejected in drop handler with "Only images for now."
- Drop same node twice: silent dedup.
- Drag model node before output exists: no drag source (guarded by `imageOutput.value` check in `ModelNode`).

**Send-time edge cases:**

- Referenced node deleted between drop and send: Claude's `nebula show nX --path` fails → primer rule surfaces "I can't see @nX" cleanly. No frontend reconciliation.
- User manually deletes the `@nX` marker from textarea but leaves the chip: message goes without the ref, Claude has no image to Read. Flag for follow-up if observed in dogfooding; don't engineer around it in v1.
- WebSocket disconnects mid-upload: file + node persist backend-side, `graphSync` adds node to canvas, but the composer chip is lost. User re-drops from the canvas. One manual step, no data loss.

**Claude-side failures (handled by primer):**

- `nebula show nX --path` exits non-zero → "I can't see @nX" reply.
- Read fails → same class, same primer handling.
- Claude doesn't Read when it should → soft failure; user notices and corrects; primer reinforces pattern over repeated exposure.

**Security / correctness:**

- Server-side MIME sniff (first 512 bytes) is authoritative. Don't trust client-provided `Content-Type`.
- `nebula show --path` asserts resolved path prefix is inside `/api/uploads/` or `/api/outputs/` filesystem roots; other origins exit 1. Prevents enumeration via tampered cli_graph state.
- Hash-based filenames eliminate path traversal via user-controlled filenames.
- Original filename is never written to disk or returned verbatim to Claude in path form — only shown in the chip UI label.

---

## Testing Strategy

### Backend unit tests

Create `backend/tests/test_chat_uploads.py` with:

- Valid PNG upload → 200, file at expected path, response has `nodeId`, CLIGraph contains new image-input node.
- Duplicate upload of same bytes → two different `nodeId`s, same file on disk (dedup succeeds at file level but not at node level).
- Upload > 20 MB → 413, no file, no node.
- Upload with `Content-Type: image/png` but text bytes → 415 (MIME sniff works), no file, no node.
- `nebula show n<image-input> --path` → prints absolute path, exit 0.
- `nebula show n<text-input> --path` → exit 1 with expected stderr.
- `nebula show n<image-input with external URL> --path` → exit 1 with `image not local`.

### Manual dogfood scenarios

Tracked as a checklist in the implementation plan:

1. Drop a generated Nano Banana output → chip appears → "what color palette is this using?" → Claude runs show --path + Read, answers from actual pixels.
2. Drop two outputs of parallel variants → "which is closer to photo-real?" → Claude Reads both, compares.
3. Drop a PNG from Finder → new image-input node lands on canvas + chip appears → "make a warmer version" → Claude creates a model node wired to the new image-input.
4. Drop 5 images at once → 4 attach, inline notice for the 5th.
5. Drop a 25 MB image → red size-error chip.
6. Drop a PDF → inline "Only images for now."
7. Drop image, delete underlying node on canvas, Send → Claude responds "I can't see @nX" cleanly.
8. Drop the same canvas-node image twice → second drop is silent no-op.
9. Disconnect WebSocket during an upload → node appears on canvas, chip is lost, drag again from canvas works.

### No frontend unit tests in v1

Drop-and-drop behavior is dominated by DOM events and visual feedback. Better verified by dogfooding than by jsdom mocks. Revisit if flakiness becomes a real problem.

---

## File Locations Summary

| File | Change |
|------|--------|
| `frontend/src/components/panels/ChatPanel.tsx` | Add `pendingImages` state, chip row, extended drop handler, message-log bubble thumbs. |
| `frontend/src/components/nodes/ModelNode.tsx` | Make `imageOutput` and `imageInputPreview` `<img>` elements draggable with new `dataTransfer` payload. |
| `frontend/src/styles/panels.css` (or equivalent) | Chip row styles, thumbnail sizing, upload/error states. |
| `backend/main.py` | Add `POST /api/chat/uploads`, mount `/api/uploads/` static. |
| `backend/services/cli_graph.py` | Verify image-input `add_node` path; extend if needed. |
| `backend/cli/__main__.py` | Add `--path` flag to the `show` subcommand with resolution + safety logic. |
| `backend/services/chat_session.py` | Primer text update (no mechanism changes). |
| `backend/tests/test_chat_uploads.py` | New unit test file. |
| `.planning/backlog/chat-panel-followups.md` | Update disposition log entries for #2 (v2 portion) and #4 after this ships. |

---

## Out-of-Scope Follow-ups Noted During Design

- **Thumbnail generation endpoint** — if the "full-res for 48px chip" bandwidth cost becomes visible.
- **Chat-upload file GC** — nightly cleanup of files whose backing image-input node no longer exists.
- **Frontend reconciliation on WS reconnect mid-upload** — pair the pending chip with the incoming `graphSync` node.
- **Video / audio / mesh drop support** — likely warrants its own small design spike given transcoding and non-vision-friendly formats.
- **Agent SDK migration of the chat bridge** — decoupled from this feature; valuable on its own merits (documented streaming, future Mac app portability). A separate design spike.
- **Moodboard** — persistent visual reference library; orthogonal surface that chat-drop must not duplicate.

---

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| Drag source scope | Any image on the canvas + OS files. |
| Attachment UX | Thumbnail chip + `@nX` text marker. |
| Multi-attach | Up to 4 per message. |
| Delivery mechanism | `@nX` refs + Read tool via primer, not content blocks. |
| External-file drop timing | Synchronous, creates node before Send. |
| Transport (SDK vs CLI) | Stay on `claude -p` for this feature. |
| File storage | Hash-named files under `backend/data/chat-uploads/`, served at `/api/uploads/`. |
| File lifecycle | Persist in v1; GC deferred. |
| Thumbnail generation | None in v1. |
| WebSocket payload shape | Unchanged. |
| Message-log thumb placement | Above the text. |
| Chip × behavior | Auto-removes first matching `@nX` marker from textarea. |

---

## Risk / Correctness Notes

- **Primer reliability.** Claude occasionally won't call the tool it's told to call. The primer language ("you MUST see the pixels before replying") is as strong as comparable existing rules (`PRESERVE EXISTING WORK`, `VERIFY AFTER CREATE`) which have proven reliable. If we observe systematic misses in dogfooding, reinforce with a worked example in the primer (concrete "CORRECT vs WRONG" pair).
- **Read tool on image files.** Documented behavior: Read on an image file returns vision content the model can reason about. No reverse-engineering required. If this ever breaks on a Claude Code release, it's a stop-ship bug at the Claude Code level, not at ours.
- **Subscription auth + subprocess.** No change — today's `claude -p` already inherits the user's logged-in session. This feature adds nothing that would complicate that.

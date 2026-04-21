# Drag Image to Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag images (canvas-node images or OS files) into the chat panel so Claude can see the pixels. Every dropped image becomes a canvas `image-input` node; Claude reads image content via its built-in Read tool, pointed at a local file path returned by a new `nebula path <node_id>` command.

**Architecture:** No image bytes ever flow through the chat WebSocket. Frontend inserts `@nX` text references into the message for each attached image and renders thumbnail chips above the textarea. The backend primer teaches Claude that `@nX` in a visual question means "run `nebula path nX`, then Read the returned path." External file drops are uploaded to a new `POST /api/chat/uploads` endpoint that writes the file under `OUTPUT_ROOT/chat-uploads/<sha256>.<ext>` and synchronously creates an `image-input` node via `CLIGraph.add_node`; `graphSync` makes the node appear on the canvas immediately.

**Tech Stack:** React 19 + Vite + Zustand (frontend); Python 3.12 + FastAPI (backend); pytest (backend tests); no frontend unit tests in v1.

---

## Deviations from Spec

The approved spec (`docs/superpowers/specs/2026-04-21-drag-image-to-chat-design.md`) locks most decisions. Two pragmatic adjustments were made while mapping onto the current codebase — neither changes user-visible behavior:

1. **CLI command name.** Spec proposed `nebula show <node_id> --path`. There is no `show` subcommand in the current CLI. This plan adds a single-purpose `nebula path <node_id>` command instead — focused, no additional default behavior to specify or test. The primer rule is updated to match.
2. **Static file mount.** Spec proposed a new `/api/uploads/` mount. The backend already mounts static outputs from `OUTPUT_ROOT` (via `services/output.py`); serving chat uploads under `OUTPUT_ROOT/chat-uploads/` through the existing mount path (`/api/outputs/chat-uploads/<hash>.<ext>`) avoids introducing a second `StaticFiles` mount and keeps lifecycle tooling unified. No behavior change from the user or Claude's perspective.

All other spec decisions carry forward unchanged.

---

## File Structure

**New files:**

- `backend/cli/commands/path.py` — dispatches `nebula path` to the backend endpoint.
- `backend/tests/test_chat_uploads.py` — pytest suite covering the upload endpoint + node-path resolution.

**Modified files:**

- `backend/main.py` — new `POST /api/chat/uploads` endpoint and new `GET /api/graph/node/{id}/path` endpoint.
- `backend/cli/__main__.py` — register the `path` subparser and dispatch.
- `backend/cli/client.py` — add a helper to call `/api/graph/node/{id}/path`.
- `backend/services/chat_session.py` — append the SEE-THE-IMAGE primer rule.
- `frontend/src/components/nodes/ModelNode.tsx` — make preview `<img>` elements draggable with new `dataTransfer` payload.
- `frontend/src/components/panels/ChatPanel.tsx` — add `pendingImages` state, chip row, extended drop handler, upload flow, message-log bubble thumbnails.
- `frontend/src/styles/panels.css` — chip row styles.

Each task below produces a self-contained change that can be committed independently.

---

## Task 1: Backend endpoint — `GET /api/graph/node/{id}/path`

Resolves a node's primary image file to an absolute local filesystem path, or returns 4xx with a descriptive message. The CLI command in Task 2 calls this; the primer instructs Claude to call the CLI.

**Files:**
- Modify: `backend/main.py` (add endpoint near the other `/api/graph/node/...` routes; the existing DELETE route is around the `remove_node` block — insert the new GET route in the same section)
- Test: `backend/tests/test_chat_uploads.py` (new file)

- [ ] **Step 1.1: Write the failing tests**

Create `backend/tests/test_chat_uploads.py`:

```python
from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main as main_module
from main import app
from services.cli_graph import CLIGraph
from services.output import OUTPUT_ROOT


@pytest.fixture(autouse=True)
def reset_graph_and_uploads(tmp_path, monkeypatch):
    """Reset cli_graph between tests and point chat-uploads at tmp_path so
    the real filesystem isn't touched. Each test starts with a clean graph
    and a clean chat-uploads dir."""
    main_module.cli_graph = CLIGraph()
    chat_uploads = tmp_path / "chat-uploads"
    chat_uploads.mkdir()
    monkeypatch.setattr("main.CHAT_UPLOADS_DIR", chat_uploads)
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _make_png_bytes() -> bytes:
    """A minimal valid 1x1 PNG."""
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000d49444154789c6300010000000500010d0a2db40000000049454e44"
        "ae426082"
    )


def test_node_path_for_image_input(client):
    # Seed a minimal image-input node pointing at a file under OUTPUT_ROOT.
    test_file = OUTPUT_ROOT / "chat-uploads" / "ff.png"
    main_module.cli_graph.add_node(
        "image-input",
        {"file": "/api/outputs/chat-uploads/ff.png",
         "_previewUrl": "/api/outputs/chat-uploads/ff.png"},
    )
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"].endswith("chat-uploads/ff.png")
    assert Path(body["path"]).is_absolute()


def test_node_path_for_unknown_node(client):
    resp = client.get("/api/graph/node/n99/path")
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


def test_node_path_for_text_input_rejects(client):
    main_module.cli_graph.add_node("text-input", {"value": "hello"})
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 400
    assert "no image file" in resp.json()["detail"].lower()


def test_node_path_for_external_url_rejects(client):
    main_module.cli_graph.add_node(
        "image-input",
        {"file": "https://example.com/foo.png",
         "_previewUrl": "https://example.com/foo.png"},
    )
    resp = client.get("/api/graph/node/n1/path")
    assert resp.status_code == 400
    assert "not local" in resp.json()["detail"].lower()
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_chat_uploads.py::test_node_path_for_image_input -v
```
Expected: FAIL with `404` (endpoint doesn't exist) or import errors on `CHAT_UPLOADS_DIR`.

- [ ] **Step 1.3: Add `CHAT_UPLOADS_DIR` constant and the endpoint to `backend/main.py`**

Add this near the top of `main.py` after the existing `OUTPUT_ROOT.mkdir(...)` line:

```python
CHAT_UPLOADS_DIR = OUTPUT_ROOT / "chat-uploads"
CHAT_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
```

Add the new endpoint in the `/api/graph/node/...` section (locate the existing `@app.delete("/api/graph/node/{node_id}")` route and add this above or below it):

```python
@app.get("/api/graph/node/{node_id}/path")
async def get_node_image_path(node_id: str) -> dict:
    """Resolve a node's primary image file to an absolute local path.

    Only works for image-input nodes (via their `file` or `_previewUrl`) or
    model nodes with an `_output_image` output. External URLs (anything not
    served from OUTPUT_ROOT) are rejected. Used by `nebula path` so Claude
    can Read node images as vision content.
    """
    node = cli_graph.nodes.get(node_id)
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")

    url = _resolve_primary_image_url(node)
    if url is None:
        raise HTTPException(
            status_code=400,
            detail=f"No image file for node '{node_id}'",
        )

    local_path = _url_to_output_path(url)
    if local_path is None:
        raise HTTPException(
            status_code=400,
            detail=f"Image for node '{node_id}' is not local (external URL)",
        )
    return {"path": str(local_path.resolve())}


def _resolve_primary_image_url(node: dict[str, Any]) -> str | None:
    """Return the best URL to read for this node, or None if it has no image."""
    params = node.get("params") or {}
    outputs = node.get("outputs") or {}
    definition_id = node.get("definitionId", "")

    if definition_id == "image-input":
        value = params.get("file") or params.get("_previewUrl")
        return str(value) if value else None

    out_image = outputs.get("_output_image")
    if isinstance(out_image, dict):
        value = out_image.get("value")
        if value:
            return str(value)
    elif isinstance(out_image, str):
        return out_image

    preview = params.get("_previewUrl")
    return str(preview) if preview else None


def _url_to_output_path(url: str) -> Path | None:
    """Map an /api/outputs/... URL to the local filesystem path under
    OUTPUT_ROOT. External URLs (http://, https://, non-outputs paths) return
    None so callers can reject them with a clear error."""
    if url.startswith(("http://", "https://")):
        return None
    prefix = "/api/outputs/"
    if not url.startswith(prefix):
        return None
    relative = url[len(prefix):]
    candidate = (OUTPUT_ROOT / relative).resolve()
    try:
        candidate.relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        return None
    return candidate
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_chat_uploads.py -k node_path -v
```
Expected: 4 tests PASS (image-input resolves, unknown 404s, text-input 400s, external URL 400s).

- [ ] **Step 1.5: Commit**

```bash
git add backend/main.py backend/tests/test_chat_uploads.py
git commit -m "feat(graph): GET /api/graph/node/{id}/path resolves local image path

Returns the absolute on-disk file path for a node's primary image
(image-input or model output). Used by the forthcoming `nebula path`
CLI command to let Claude Read canvas images as vision content.
Rejects non-image nodes (400) and external URLs (400) explicitly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `nebula path <node_id>` CLI command

Thin wrapper around the endpoint from Task 1. Prints the absolute path to stdout on success, exits 1 with a clear error on stderr otherwise.

**Files:**
- Create: `backend/cli/commands/path.py`
- Modify: `backend/cli/__main__.py` (subparser + dispatch)
- Modify: `backend/cli/client.py` (HTTP helper)

- [ ] **Step 2.1: Add client helper**

In `backend/cli/client.py`, find the class `NebulaClient` and add this method near the other graph-related methods (e.g. near `create_node`, `update_node`):

```python
    def get_node_image_path(self, node_id: str) -> dict:
        """Call GET /api/graph/node/{id}/path. Raises RuntimeError on HTTP error
        with a message suitable for stderr."""
        url = f"{self.base_url}/api/graph/node/{node_id}/path"
        resp = self.session.get(url, timeout=10)
        if resp.status_code == 200:
            return resp.json()
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise RuntimeError(detail or f"HTTP {resp.status_code}")
```

(If `NebulaClient` uses `httpx` or another client, adjust to match. The existing methods are your reference for style and signature.)

- [ ] **Step 2.2: Create the command module**

Create `backend/cli/commands/path.py`:

```python
from __future__ import annotations

import sys

from ..client import NebulaClient


def run(client: NebulaClient, node_id: str) -> None:
    """Print the absolute local filesystem path of a node's primary image.

    Exits 0 on success (path printed to stdout), exits 1 on error (message
    printed to stderr). Used by the chat primer to let Claude Read canvas
    images.
    """
    try:
        result = client.get_node_image_path(node_id)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    print(result["path"])
```

- [ ] **Step 2.3: Register the subparser**

In `backend/cli/__main__.py`, find the `-- Graph --` section (around line 30). Add the `path` subparser between `clear` and the `-- Execution --` section:

```python
    path_p = sub.add_parser("path", help="Print local file path of a node's primary image")
    path_p.add_argument("node_ref", help="Node reference (e.g. n1)")
```

In the `dispatch` dict inside `main()` (around line 116), add:

```python
        "path": lambda: path.run(client, args.node_ref),
```

And in the nearby import line that loads commands (around line 114):

```python
    from .commands import context, nodes, keys, graph, execute, quick, path
```

- [ ] **Step 2.4: Smoke-test the CLI manually**

Start the backend:
```bash
lsof -ti:8000 | xargs kill 2>/dev/null; cd backend && python -m uvicorn main:app --port 8000 &
sleep 2
```

Create a text-input node, then try to get its path (should fail):
```bash
cd backend && python -m cli create text-input --param value=hello
cd backend && python -m cli path n1
```
Expected: exits 1, stderr contains `No image file for node 'n1'`.

Create an image-input node pointing at a real file under OUTPUT_ROOT:
```bash
# Use an existing generated output file if you have one, or create a placeholder:
touch /path/under/OUTPUT_ROOT/chat-uploads/test.png  # adjust to your actual OUTPUT_ROOT
cd backend && python -m cli create image-input --param file=/api/outputs/chat-uploads/test.png --param _previewUrl=/api/outputs/chat-uploads/test.png
cd backend && python -m cli path n2
```
Expected: exits 0, stdout contains the absolute path ending in `chat-uploads/test.png`.

Kill the backend:
```bash
lsof -ti:8000 | xargs kill
```

- [ ] **Step 2.5: Commit**

```bash
git add backend/cli/__main__.py backend/cli/client.py backend/cli/commands/path.py
git commit -m "feat(cli): nebula path <node_id> prints local image file path

Thin CLI wrapper over GET /api/graph/node/{id}/path. Exits 0 with the
absolute path on stdout for image-input and model-output nodes; exits 1
with a clear error on stderr for text-input, unknown nodes, or external
URLs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `POST /api/chat/uploads` endpoint

Accept an uploaded image, save to `OUTPUT_ROOT/chat-uploads/<sha256>.<ext>`, create an `image-input` node, broadcast `graphSync`, and return `{ nodeId, url, thumbUrl, filename }`.

**Files:**
- Modify: `backend/main.py` (new endpoint)
- Test: `backend/tests/test_chat_uploads.py` (extend existing file from Task 1)

- [ ] **Step 3.1: Write the failing tests**

Append to `backend/tests/test_chat_uploads.py`:

```python
def test_upload_valid_png_creates_node_and_file(client, monkeypatch):
    png_bytes = _make_png_bytes()
    resp = client.post(
        "/api/chat/uploads",
        files={"file": ("example.png", png_bytes, "image/png")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["nodeId"].startswith("n")
    assert body["url"].startswith("/api/outputs/chat-uploads/")
    assert body["url"].endswith(".png")
    assert body["thumbUrl"] == body["url"]
    assert body["filename"] == "example.png"

    # File exists on disk under our patched chat-uploads dir.
    hash_name = body["url"].split("/")[-1]
    saved = main_module.CHAT_UPLOADS_DIR / hash_name
    assert saved.exists()
    assert saved.read_bytes() == png_bytes

    # Node exists in cli_graph with expected params.
    node = main_module.cli_graph.nodes[body["nodeId"]]
    assert node["definitionId"] == "image-input"
    assert node["params"]["file"] == body["url"]
    assert node["params"]["_previewUrl"] == body["url"]


def test_upload_dedup_by_content_hash(client):
    png_bytes = _make_png_bytes()
    resp1 = client.post(
        "/api/chat/uploads",
        files={"file": ("a.png", png_bytes, "image/png")},
    )
    resp2 = client.post(
        "/api/chat/uploads",
        files={"file": ("b.png", png_bytes, "image/png")},
    )
    assert resp1.status_code == 200
    assert resp2.status_code == 200

    # Two distinct nodes in the graph...
    assert resp1.json()["nodeId"] != resp2.json()["nodeId"]

    # ...but the same file on disk.
    assert resp1.json()["url"] == resp2.json()["url"]
    saved_files = list(main_module.CHAT_UPLOADS_DIR.iterdir())
    assert len(saved_files) == 1


def test_upload_rejects_oversize(client):
    big = b"\x00" * (21 * 1024 * 1024)  # 21 MB
    resp = client.post(
        "/api/chat/uploads",
        files={"file": ("big.png", big, "image/png")},
    )
    assert resp.status_code == 413
    assert len(list(main_module.CHAT_UPLOADS_DIR.iterdir())) == 0
    assert len(main_module.cli_graph.nodes) == 0


def test_upload_rejects_non_image(client):
    resp = client.post(
        "/api/chat/uploads",
        files={"file": ("note.txt", b"hello world", "text/plain")},
    )
    assert resp.status_code == 415
    assert len(list(main_module.CHAT_UPLOADS_DIR.iterdir())) == 0
    assert len(main_module.cli_graph.nodes) == 0


def test_upload_rejects_fake_png(client):
    """A file claiming Content-Type: image/png but whose bytes aren't a PNG.
    Server-side MIME sniff must catch this."""
    resp = client.post(
        "/api/chat/uploads",
        files={"file": ("fake.png", b"not really a png", "image/png")},
    )
    assert resp.status_code == 415
    assert len(list(main_module.CHAT_UPLOADS_DIR.iterdir())) == 0
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd backend && python -m pytest tests/test_chat_uploads.py -k upload -v
```
Expected: all 5 upload tests FAIL (endpoint doesn't exist → 405 or 404).

- [ ] **Step 3.3: Add the endpoint to `backend/main.py`**

Add these imports near the top of `main.py`:

```python
import hashlib
```

Add `_SUPPORTED_IMAGE_TYPES` and the sniffing helper near the other module-level constants (after `CHAT_UPLOADS_DIR`):

```python
_SUPPORTED_IMAGE_TYPES = {
    b"\x89PNG\r\n\x1a\n": ("image/png", ".png"),
    b"\xff\xd8\xff": ("image/jpeg", ".jpg"),
    b"GIF87a": ("image/gif", ".gif"),
    b"GIF89a": ("image/gif", ".gif"),
}

MAX_CHAT_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


def _sniff_image_type(data: bytes) -> tuple[str, str] | None:
    """Return (mime, ext) if *data* starts with a supported image signature.

    Also handles WebP (RIFF....WEBP). Returns None for anything else so the
    caller can reject with 415.
    """
    for sig, pair in _SUPPORTED_IMAGE_TYPES.items():
        if data.startswith(sig):
            return pair
    # WebP has a variable prefix: "RIFF" then 4 size bytes then "WEBP".
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ("image/webp", ".webp")
    return None
```

Add the endpoint. Put it near the existing `upload_file` endpoint (around line 51) for locality:

```python
@app.post("/api/chat/uploads")
async def chat_upload(file: UploadFile) -> dict:
    """Accept an image drop from the chat panel, save to disk keyed on its
    content hash, create an image-input node so it becomes a canvas asset,
    and return references the frontend can attach to the message."""
    content = await file.read()
    if len(content) > MAX_CHAT_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")

    sniffed = _sniff_image_type(content[:16])
    if sniffed is None:
        raise HTTPException(status_code=415, detail="Only image files are accepted")
    mime, ext = sniffed

    digest = hashlib.sha256(content).hexdigest()
    saved_path = CHAT_UPLOADS_DIR / f"{digest}{ext}"
    if not saved_path.exists():
        saved_path.write_bytes(content)

    url = f"/api/outputs/chat-uploads/{saved_path.name}"

    # Position: reuse the "maxX + 300" heuristic from existing node creation.
    positions = [
        n.get("position", {}) for n in cli_graph.nodes.values()
    ]
    max_x = max((p.get("x", 0) for p in positions), default=-300)
    new_position = {"x": float(max_x) + 300.0, "y": 100.0}

    node_id = cli_graph.add_node(
        "image-input",
        {"file": url, "_previewUrl": url},
        position=new_position,
    )
    await _broadcast_graph_sync()

    return {
        "nodeId": node_id,
        "url": url,
        "thumbUrl": url,
        "filename": file.filename or f"{digest}{ext}",
    }
```

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
cd backend && python -m pytest tests/test_chat_uploads.py -v
```
Expected: all 9 tests PASS (4 from Task 1 + 5 upload tests from Task 3).

- [ ] **Step 3.5: Commit**

```bash
git add backend/main.py backend/tests/test_chat_uploads.py
git commit -m "feat(chat): POST /api/chat/uploads saves image + creates image-input node

Accepts an image upload (PNG/JPEG/WebP/GIF, <=20 MB), hashes bytes to
dedup on disk, saves under OUTPUT_ROOT/chat-uploads/, creates an
image-input node, and broadcasts graphSync so the canvas updates
immediately. Returns { nodeId, url, thumbUrl, filename } for the
frontend chip. Server-side MIME sniff rejects fake content types.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Primer update

Append the SEE-THE-IMAGE rule to `NEBULA_SYSTEM_PRIMER`. No tests (primer is a string); Task 10 dogfood verifies behavior.

**Files:**
- Modify: `backend/services/chat_session.py`

- [ ] **Step 4.1: Add the rule block**

In `backend/services/chat_session.py`, locate the `NEBULA_SYSTEM_PRIMER = (` block and find the end of the `VERIFY AFTER CREATE` paragraph (it ends with `...otherwise you're lying to the user about what happened.`). Append this new rule block (note the leading two-space indent to keep the parentheses-concatenation style):

```python
    "\n\n"
    "SEE THE IMAGE BEFORE ANSWERING VISUAL QUESTIONS. When the user's "
    "message references an image node (@nX where nX is an image-input or "
    "a model node with an image output) and asks a question that depends "
    "on the visual content — 'how does this look', 'what's wrong with "
    "it', 'make it warmer', 'compare these', 'why is it washed out', "
    "'does it match the reference', and similar — you MUST see the pixels "
    "before replying.\n\n"
    "To see an image: run `nebula path nX` to get the absolute local file "
    "path, then call the Read tool on that path. Read returns the image as "
    "vision content you can reason about directly. Do NOT describe the "
    "image back to the user ('I see a robot sitting on…') — they can see "
    "it too. Answer their question.\n\n"
    "Only Read what you need. If the user references three images and asks "
    "about one of them, only Read the relevant one. Don't Read the same "
    "file twice in one turn.\n\n"
    "If `nebula path nX` exits non-zero (the node isn't an image or its "
    "file isn't locally resolvable), surface that in plain language: 'I "
    "can't see @nX — it isn't an image node.' Don't guess.\n\n"
    "You do NOT need to Read images when the user's question is structural "
    "('what node does this connect to', 'what model generated this'). Use "
    "`nebula graph` for those."
```

- [ ] **Step 4.2: Verify the primer string is well-formed**

```bash
cd backend && python -c "from services.chat_session import NEBULA_SYSTEM_PRIMER; print(len(NEBULA_SYSTEM_PRIMER), 'chars'); print(NEBULA_SYSTEM_PRIMER[-400:])"
```
Expected: prints a char count > 0 and the tail of the primer ending with `...Use \`nebula graph\` for those.`

- [ ] **Step 4.3: Commit**

```bash
git add backend/services/chat_session.py
git commit -m "feat(primer): teach Claude to Read image files referenced in chat

Adds SEE THE IMAGE BEFORE ANSWERING VISUAL QUESTIONS rule: when the
user references an @nX image node with a visual question, Claude
runs nebula path nX, then calls Read on the returned path to see
actual pixels. Targets visual-question triggers explicitly; Read-only-
what-you-need caps multi-image latency; structural questions stay on
nebula graph.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Make ModelNode preview images draggable

`ModelNode.tsx` already renders `<img>` elements for image-input previews and image outputs. This task adds `draggable` + `onDragStart` handlers that stash a new `application/nebula-image-ref` payload alongside the existing `@nX` text-ref.

**Files:**
- Modify: `frontend/src/components/nodes/ModelNode.tsx`

- [ ] **Step 5.1: Inspect the current drag handler for reference**

Read the existing `<img>` blocks to confirm the class names and surrounding context:

```bash
grep -n "draggable\|imageOutput.value\|imageInputPreview\|onDragStart" frontend/src/components/nodes/ModelNode.tsx
```

Note the line numbers of the image-input preview (around line 180) and the model-output image (around line 200). You will edit both.

- [ ] **Step 5.2: Add a shared drag-start helper**

Near the top of `ModelNode.tsx`, inside the component body but before the `return`, add:

```tsx
  const startImageDrag = useCallback(
    (url: string) => (e: React.DragEvent<HTMLImageElement>) => {
      const token = `@${id}`;
      e.dataTransfer.setData(
        'application/nebula-image-ref',
        JSON.stringify({ nodeId: id, url }),
      );
      e.dataTransfer.setData('application/nebula-node-ref', token);
      e.dataTransfer.setData('text/plain', token);
      e.dataTransfer.effectAllowed = 'copy';
    },
    [id],
  );
```

If `useCallback` and `React.DragEvent` aren't already imported, add them to the existing React imports at the top of the file.

- [ ] **Step 5.3: Wire the handler into the image-input preview**

Find the JSX around `{imageInputPreview && (`. Replace the `<img>` inside with:

```tsx
        <div className="model-node__preview">
          <img
            src={imageInputPreview}
            alt="Image input"
            className="model-node__preview-image"
            loading="lazy"
            draggable
            onDragStart={startImageDrag(imageInputPreview)}
          />
        </div>
```

- [ ] **Step 5.4: Wire the handler into the model-output image**

Find the JSX around the model output image (the block containing `src={imageOutput.value}` and the download button). Replace the `<img>` inside with:

```tsx
          <img
            src={imageOutput.value as string}
            alt="Generated output"
            className="model-node__preview-image"
            loading="lazy"
            draggable
            onDragStart={startImageDrag(imageOutput.value as string)}
          />
```

Leave the download button unchanged.

- [ ] **Step 5.5: Add `cursor: grab` styling for dragable previews**

In `frontend/src/components/nodes/ModelNode.tsx`'s associated CSS (or wherever `.model-node__preview-image` is defined — probably in a shared stylesheet near the component), add:

```css
.model-node__preview-image[draggable='true'] {
  cursor: grab;
}
.model-node__preview-image[draggable='true']:active {
  cursor: grabbing;
}
```

Search for the existing class definition to place this change correctly:
```bash
grep -rn "model-node__preview-image" frontend/src/styles
```

- [ ] **Step 5.6: Manual smoke test**

Start the frontend dev server, run a Nano Banana node until an output image appears. Drag the output image; the browser's drag preview should show the image thumb, and the cursor should turn into a grab cursor. Release the drag outside the panel — nothing should break (no listener receives it yet; that's the next task).

- [ ] **Step 5.7: Commit**

```bash
git add frontend/src/components/nodes/ModelNode.tsx frontend/src/styles
git commit -m "feat(node): make preview images draggable with image-ref payload

Image-input previews and model-output image elements in ModelNode now
set application/nebula-image-ref on dragstart (alongside the existing
node-ref + text/plain fallbacks). No consumer yet — ChatPanel wires
up in a follow-up commit. Cursor changes to grab/grabbing during hover
and drag so the new affordance is visible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: ChatPanel — pendingImages state and chip row UI

Add the typed state and the chip row above the textarea. No drop handling yet (Task 7/8 wire that in); this task lands the visual scaffold so Task 7/8 have somewhere to render into.

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`
- Modify: `frontend/src/styles/panels.css`

- [ ] **Step 6.1: Add the `PendingImage` type and state**

In `ChatPanel.tsx`, add this type definition near the other module-level types (after `ChatMessage`):

```tsx
type PendingImage =
  | {
      id: string;
      status: 'uploading';
      thumbUrl: string;
      label?: string;
    }
  | {
      id: string;
      status: 'ready';
      nodeId: string;
      thumbUrl: string;
      label?: string;
    }
  | {
      id: string;
      status: 'error';
      error: string;
      thumbUrl?: string;
      label?: string;
    };
```

Inside the `ChatPanel` component body, near the other `useState` declarations, add:

```tsx
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
```

- [ ] **Step 6.2: Add a removeChip helper**

Inside the `ChatPanel` component, add this helper near `setInput` calls:

```tsx
  // Remove a chip and strip the first matching `@nX` marker from the textarea.
  // If the chip never reached `ready` (no nodeId), just drops the chip — there's
  // no marker to strip.
  const removeChip = useCallback((id: string) => {
    setPendingImages((prev) => {
      const chip = prev.find((p) => p.id === id);
      if (chip && chip.status === 'ready') {
        const token = `@${chip.nodeId}`;
        setInput((curr) => {
          const idx = curr.indexOf(token);
          if (idx === -1) return curr;
          // Strip the token plus one trailing space if present, so we don't
          // leave a dangling double-space.
          const endIdx = idx + token.length + (curr[idx + token.length] === ' ' ? 1 : 0);
          return curr.slice(0, idx) + curr.slice(endIdx);
        });
      }
      return prev.filter((p) => p.id !== id);
    });
  }, []);
```

- [ ] **Step 6.3: Render the chip row**

Find the `<div className="chat-panel__input">` block near the bottom of the `return`. Insert this chip row just inside, before the `<textarea>`:

```tsx
        {pendingImages.length > 0 && (
          <div className="chat-panel__chips">
            {pendingImages.map((chip) => (
              <div
                key={chip.id}
                className={`chat-panel__chip chat-panel__chip--${chip.status}`}
                title={chip.label}
              >
                {chip.status === 'uploading' && (
                  <>
                    {chip.thumbUrl && (
                      <img src={chip.thumbUrl} alt="" className="chat-panel__chip-thumb" />
                    )}
                    <div className="chat-panel__chip-spinner" />
                  </>
                )}
                {chip.status === 'ready' && (
                  <>
                    <img src={chip.thumbUrl} alt="" className="chat-panel__chip-thumb" />
                    <div className="chat-panel__chip-label">@{chip.nodeId}</div>
                  </>
                )}
                {chip.status === 'error' && (
                  <div className="chat-panel__chip-error">{chip.error}</div>
                )}
                <button
                  type="button"
                  className="chat-panel__chip-close"
                  onClick={() => removeChip(chip.id)}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
```

- [ ] **Step 6.4: Add chip row styles**

In `frontend/src/styles/panels.css` (or wherever existing `.chat-panel__input` styles live), append:

```css
.chat-panel__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px 0;
}

.chat-panel__chip {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.chat-panel__chip--error {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border-color: rgba(255, 99, 99, 0.6);
}

.chat-panel__chip-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.chat-panel__chip-label {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  font-size: 10px;
  padding: 1px 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  text-align: center;
  pointer-events: none;
}

.chat-panel__chip-spinner {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.chat-panel__chip-spinner::after {
  content: '';
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: chat-chip-spin 0.8s linear infinite;
}
@keyframes chat-chip-spin {
  to { transform: rotate(360deg); }
}

.chat-panel__chip-error {
  font-size: 9px;
  color: #ffb3b3;
  text-align: center;
  line-height: 1.1;
  padding: 2px;
}

.chat-panel__chip-close {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font-size: 12px;
  line-height: 14px;
  padding: 0;
  cursor: pointer;
  opacity: 0;
  transition: opacity 80ms ease;
}
.chat-panel__chip:hover .chat-panel__chip-close {
  opacity: 1;
}
```

- [ ] **Step 6.5: Manual smoke test**

Start the frontend. Open the chat panel. The chip row should not be visible (empty state). In the browser console, run:

```js
// Temporary test — drop a fake chip in via React DevTools or by monkey-patching.
// This is just to verify CSS renders correctly; the next tasks plumb it in properly.
```

Skip this if you don't have React DevTools handy; Task 7 will produce a real drop that lights this up.

- [ ] **Step 6.6: Commit**

```bash
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/styles/panels.css
git commit -m "feat(chat): pendingImages state and chip row scaffold

Adds the ChatPanel state and UI scaffolding for image attachments: a
discriminated-union PendingImage type (uploading/ready/error), a chip
row rendered above the textarea, and a removeChip helper that strips
the first matching @nX from the textarea. Drop handlers wire in next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: ChatPanel — canvas-node image drop branch

Extend the existing textarea drop handler to recognize `application/nebula-image-ref` and produce a `ready` chip plus text marker. This is the simpler of the two drop paths — no upload, no async state.

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`

- [ ] **Step 7.1: Add the `newId` helper reuse**

The existing `newId()` helper at the top of the file can be reused for chip ids. No change needed — just use it in the new handler.

- [ ] **Step 7.2: Extend the `onDragOver` handler**

Find the `onDragOver` callback on the textarea. Update its types check to also accept the new image-ref type and image files:

```tsx
          onDragOver={(e) => {
            const types = e.dataTransfer.types;
            const accepts =
              types.includes('application/nebula-image-ref') ||
              types.includes('application/nebula-node-ref') ||
              (e.dataTransfer.files && e.dataTransfer.files.length > 0 &&
               Array.from(e.dataTransfer.items).some(
                 (it) => it.kind === 'file' && it.type.startsWith('image/'),
               ));
            if (accepts) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
```

- [ ] **Step 7.3: Extend the `onDrop` handler**

Find the existing `onDrop` callback on the textarea. Replace it entirely with the following. This preserves the existing text-insertion behavior as a fallback and adds the image-ref branch at the top. File-upload branch comes in Task 8 — this version still calls out the `files.length > 0` case and exits early without processing, so we can wire it up next task without revisiting the dispatch.

```tsx
          onDrop={(e) => {
            // Branch 1: canvas-node image (new feature — creates a chip).
            const imageRefRaw = e.dataTransfer.getData('application/nebula-image-ref');
            if (imageRefRaw) {
              e.preventDefault();
              try {
                const parsed = JSON.parse(imageRefRaw) as { nodeId: string; url: string };
                setPendingImages((prev) => {
                  if (prev.length >= 4) {
                    // TODO: surface inline notice; for now, silently reject.
                    return prev;
                  }
                  if (prev.some((p) => p.status === 'ready' && p.nodeId === parsed.nodeId)) {
                    return prev;
                  }
                  return [
                    ...prev,
                    {
                      id: newId(),
                      status: 'ready',
                      nodeId: parsed.nodeId,
                      thumbUrl: parsed.url,
                    },
                  ];
                });
                insertAtCaret(e.currentTarget, `@${parsed.nodeId}`);
              } catch {
                /* malformed payload; ignore */
              }
              return;
            }

            // Branch 2: OS file drop (Task 8 wires this fully). For now,
            // preventing default so the browser doesn't navigate to the file.
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              e.preventDefault();
              return;
            }

            // Branch 3: existing @nX text-ref drop (unchanged).
            const token =
              e.dataTransfer.getData('application/nebula-node-ref') ||
              e.dataTransfer.getData('text/plain');
            if (!token) return;
            e.preventDefault();
            insertAtCaret(e.currentTarget, token);
          }}
```

Now extract the caret-insertion logic into a helper (previously inline inside the drop handler). Add this helper at module scope, above `ChatPanel`:

```tsx
function insertAtCaret(target: HTMLTextAreaElement, token: string): void {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  const before = target.value.slice(0, start);
  const after = target.value.slice(end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const insert = `${needsLeadingSpace ? ' ' : ''}${token}${needsTrailingSpace ? ' ' : ''}`;
  const next = before + insert + after;
  // Fire the React onChange via a synthetic input event so state stays in sync.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  nativeSetter?.call(target, next);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  requestAnimationFrame(() => {
    const caret = before.length + insert.length;
    target.focus();
    target.setSelectionRange(caret, caret);
  });
}
```

- [ ] **Step 7.4: Manual smoke test**

Start the frontend + backend. Create a text-input + Nano Banana node, run it until an output image appears. Drag the output image into the chat textarea. Expected:
- A 48×48 chip appears above the textarea with the output thumbnail and an `@nX` label.
- `@nX` is inserted into the textarea at the caret.
- Click × on the chip: chip disappears, `@nX` is removed from the textarea.
- Drag the same output image twice: only one chip appears.
- Drag five different image outputs: 4 land, 5th is silently dropped (inline notice comes in Task 9; for now the behavior is "does nothing").

- [ ] **Step 7.5: Commit**

```bash
git add frontend/src/components/panels/ChatPanel.tsx
git commit -m "feat(chat): drop canvas-node images into chat as ready chips

Textarea drop handler recognizes application/nebula-image-ref and
produces a thumbnail chip above the input plus an @nX marker at the
caret. Dedup by nodeId; cap at 4 chips. Shared insertAtCaret helper
for consistent text insertion across drop branches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: ChatPanel — external file drop + upload flow

Extend the drop handler to accept OS files (images only, fast-fail on MIME), POST each to `/api/chat/uploads`, and transition `uploading` chips to `ready` on success or `error` on failure.

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`

- [ ] **Step 8.1: Add an upload helper inside `ChatPanel`**

Near the other `useCallback` declarations in `ChatPanel`, add:

```tsx
  const uploadFile = useCallback(
    async (file: File, chipId: string) => {
      const form = new FormData();
      form.append('file', file);
      try {
        const resp = await fetch(
          `http://${window.location.hostname}:8000/api/chat/uploads`,
          { method: 'POST', body: form },
        );
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          const errMsg =
            resp.status === 413
              ? 'Image > 20MB'
              : resp.status === 415
              ? 'Not an image'
              : (detail || `Upload failed (${resp.status})`);
          setPendingImages((prev) =>
            prev.map((p) =>
              p.id === chipId
                ? { id: chipId, status: 'error', error: errMsg, label: file.name }
                : p,
            ),
          );
          return;
        }
        const body = (await resp.json()) as {
          nodeId: string;
          url: string;
          thumbUrl: string;
          filename: string;
        };
        setPendingImages((prev) =>
          prev.map((p) =>
            p.id === chipId
              ? {
                  id: chipId,
                  status: 'ready',
                  nodeId: body.nodeId,
                  thumbUrl: body.thumbUrl,
                  label: body.filename,
                }
              : p,
          ),
        );
        // Insert @nX only after the server confirms the node exists.
        const textarea = document.querySelector<HTMLTextAreaElement>('.chat-panel__textarea');
        if (textarea) insertAtCaret(textarea, `@${body.nodeId}`);
      } catch (err) {
        setPendingImages((prev) =>
          prev.map((p) =>
            p.id === chipId
              ? { id: chipId, status: 'error', error: 'Network error', label: file.name }
              : p,
          ),
        );
      }
    },
    [],
  );
```

- [ ] **Step 8.2: Replace the "Branch 2" stub in `onDrop` with the real handler**

In the drop handler from Task 7, replace the `// Branch 2: OS file drop (Task 8...)` block with:

```tsx
            // Branch 2: OS file drop — upload, create node, attach chip.
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
              e.preventDefault();
              const files = Array.from(e.dataTransfer.files);
              const imageFiles = files.filter((f) => f.type.startsWith('image/'));
              if (imageFiles.length === 0) return;

              setPendingImages((prev) => {
                const roomLeft = 4 - prev.length;
                const accepted = imageFiles.slice(0, Math.max(0, roomLeft));
                const newChips: PendingImage[] = accepted.map((f) => ({
                  id: newId(),
                  status: 'uploading',
                  thumbUrl: URL.createObjectURL(f),
                  label: f.name,
                }));
                // Kick off uploads for each accepted file. We pair by index
                // against the pre-state chip ids we just generated.
                accepted.forEach((f, i) => {
                  void uploadFile(f, newChips[i].id);
                });
                return [...prev, ...newChips];
              });
              return;
            }
```

- [ ] **Step 8.3: Disable Send while any chip is uploading**

Find the Send button. Update its `disabled` expression to also check for in-flight uploads:

```tsx
          <button
            className="chat-panel__send"
            onClick={send}
            disabled={
              !connected ||
              !input.trim() ||
              pendingImages.some((p) => p.status === 'uploading')
            }
          >
            Send
          </button>
```

- [ ] **Step 8.4: Clear pending images on Send**

At the top of the existing `send` callback, after the `/clear` and `/model` command branches, add (before the `ws.send` call):

```tsx
    // Stash thumbs for the user-message bubble history rendering.
    const attachedImages = pendingImages
      .filter((p): p is Extract<PendingImage, { status: 'ready' }> => p.status === 'ready')
      .map((p) => ({ nodeId: p.nodeId, thumbUrl: p.thumbUrl }));
    setPendingImages([]);
```

Also extend the `setMessages` push of the user message to include `images: attachedImages` when non-empty (type update lands in Task 9):

```tsx
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: raw, id: newId(), images: attachedImages.length ? attachedImages : undefined },
      { role: 'assistant', id: newId(), streaming: true, parts: [], enhanceTargetId },
    ]);
```

- [ ] **Step 8.5: Manual smoke test**

Drop a PNG from Finder onto the chat textarea. Expected:
- "Uploading…" chip appears with a local preview thumb (from `createObjectURL`).
- After the POST resolves, chip swaps to `ready` with `@nX` label and the server URL.
- The new `image-input` node appears on the canvas at `maxX + 300, y = 100`.
- `@nX` is inserted into the textarea.
- Send is disabled while the chip is in `uploading`.

Drop a 25 MB image. Expected: chip flips to red error state `Image > 20MB`; no node appears.

Drop a PDF. Expected: nothing happens (no chip, no upload). This matches the "no chips for non-images" spec because the chip isn't created until MIME check passes.

- [ ] **Step 8.6: Commit**

```bash
git add frontend/src/components/panels/ChatPanel.tsx
git commit -m "feat(chat): drop OS files into chat - uploads and creates image-input

Handles external file drops: per-file POST to /api/chat/uploads,
uploading chip with local preview (URL.createObjectURL) while in
flight, transitions to ready with the server-returned @nX on success
or error chip on 413/415/other. Send disabled during upload. Up to 4
total images across drop sources. @nX text marker inserted only on
success to keep message text and backend state in sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: ChatPanel — render thumbs in user-message history + inline notices

Extend the `ChatMessage` user variant to carry attached thumbs, render them above the text bubble in the log, and surface inline notices when drops are silently rejected (over-limit, non-image).

**Files:**
- Modify: `frontend/src/components/panels/ChatPanel.tsx`

- [ ] **Step 9.1: Extend the `ChatMessage` user variant**

Near the top of `ChatPanel.tsx`, find the `ChatMessage` type. Update the user arm:

```tsx
type ChatMessage =
  | {
      role: 'user';
      text: string;
      id: string;
      images?: Array<{ nodeId: string; thumbUrl: string }>;
    }
  | { role: 'assistant'; /* ... unchanged ... */ };
```

- [ ] **Step 9.2: Render thumbs in the user bubble**

Find the user-bubble render (`m.role === 'user' ? (...)`). Replace with:

```tsx
          m.role === 'user' ? (
            <div key={m.id} className="chat__bubble chat__bubble--user">
              {m.images && m.images.length > 0 && (
                <div className="chat__bubble-thumbs">
                  {m.images.map((img) => (
                    <img
                      key={img.nodeId}
                      src={img.thumbUrl}
                      alt=""
                      className="chat__bubble-thumb"
                      loading="lazy"
                    />
                  ))}
                </div>
              )}
              <div className="chat__bubble-text">{m.text}</div>
            </div>
          ) : (
            <AssistantBubble key={m.id} message={m} />
          ),
```

- [ ] **Step 9.3: Add styles for bubble thumbs**

In `frontend/src/styles/panels.css`, append:

```css
.chat__bubble-thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}

.chat__bubble-thumb {
  width: 80px;
  height: 80px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.chat__bubble-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-panel__notice {
  color: #ffd27a;
  font-size: 11px;
  padding: 4px 8px;
  background: rgba(255, 210, 122, 0.08);
  border-top: 1px solid rgba(255, 210, 122, 0.15);
}
```

- [ ] **Step 9.4: Surface inline notice when drops are rejected**

Add a transient notice state in `ChatPanel`:

```tsx
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice]);
```

Find the Task 7 branch in the drop handler where a 5th image is silently rejected. Replace the comment/stub with:

```tsx
                  if (prev.length >= 4) {
                    setNotice('4 images max per message — remove one to add another.');
                    return prev;
                  }
```

And in the Task 8 file-drop branch, after determining `accepted`, add a rejection notice path:

```tsx
                const rejectedForLimit = imageFiles.length - accepted.length;
                const rejectedForNonImage = files.length - imageFiles.length;
                if (rejectedForLimit > 0 || rejectedForNonImage > 0) {
                  const parts: string[] = [];
                  if (rejectedForLimit > 0) {
                    parts.push(`${rejectedForLimit} over the 4-image limit`);
                  }
                  if (rejectedForNonImage > 0) {
                    parts.push(`${rejectedForNonImage} not an image`);
                  }
                  setNotice(`Skipped: ${parts.join(', ')}.`);
                }
```

Render the notice just above the chip row inside `chat-panel__input`:

```tsx
        {notice && <div className="chat-panel__notice">{notice}</div>}
```

- [ ] **Step 9.5: Manual smoke test**

- Drop 5 outputs in quick succession → 4 chips, notice reads `Skipped: 1 over the 4-image limit.`
- Drop a PDF alongside a PNG → only the PNG becomes a chip, notice reads `Skipped: 1 not an image.`
- Send a message with 2 chips attached → message bubble in history shows the two thumbs above the text.

- [ ] **Step 9.6: Commit**

```bash
git add frontend/src/components/panels/ChatPanel.tsx frontend/src/styles/panels.css
git commit -m "feat(chat): render attached thumbs in message history + inline notices

User-message bubbles now render the thumbnails that were attached when
sent, positioned above the text so the conversation reads naturally.
Over-limit or non-image drops surface a 3s toast-style notice inside
the composer so the user isn't confused when a drop is silently
dropped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Dogfood checklist + backlog disposition

Verify the full flow end-to-end against the spec's manual scenarios, then close out the two backlog entries that this feature subsumes.

**Files:**
- Modify: `.planning/backlog/chat-panel-followups.md` (disposition log)

- [ ] **Step 10.1: Run the full dogfood checklist**

Start backend + frontend fresh. Work through each scenario, noting any anomalies:

1. **Drop a Nano Banana output → "what color palette is this?"**
   Expected: chip appears; message sends; Claude runs `nebula path n<id>`, then `Read`, then answers from pixel content (not a guess). Verify the tool calls are visible in the chat log.

2. **Drop two outputs → "which is closer to photo-real?"**
   Expected: two chips; Claude Reads both; answer references visual differences specifically, not paraphrased params.

3. **Drop a PNG from Finder → "make a warmer version"**
   Expected: node appears on canvas; chip in composer is `ready` after upload; Claude creates a Nano Banana node wired to the new image-input and runs it.

4. **Drop 5 images at once** → 4 chips, inline notice for the 5th.

5. **Drop a 25 MB image** → red chip with `Image > 20MB`.

6. **Drop a PDF** → inline notice "Skipped: 1 not an image."

7. **Drop image, delete the underlying node on canvas, then Send** → Claude responds "I can't see @nX — it isn't an image node." (or the `nebula path` error propagates through).

8. **Drop the same canvas-node image twice** → only one chip.

9. **Disconnect WebSocket during an upload** (close + reopen the panel while the POST is in flight) → node appears on canvas via `graphSync`; chip is lost; drag from the canvas node to re-attach works.

If any scenario fails, triage: file a backlog follow-up for non-blocking issues, fix in place for blocking ones (add a new task here if the fix is substantial).

- [ ] **Step 10.2: Update backlog disposition log**

Edit `.planning/backlog/chat-panel-followups.md`. In the disposition log table at the bottom, add two new rows:

```markdown
| 2026-04-21 | Drag-to-chat v2 (UUID + vision) | Shipped via `2026-04-21-drag-image-to-chat-design.md`. Closed. |
| 2026-04-21 | File upload → chat → canvas (#4) | Shipped as part of drag-image-to-chat. Closed. |
```

Also mark items #2 and #4 themselves as closed by adding a `**Status: Shipped 2026-04-21.**` line at the top of each of those item sections.

- [ ] **Step 10.3: Log the milestone**

```bash
bash ~/.claude/scripts/activity-log.sh write '| nebula-nodes | BUILT: drag-image-to-chat shipped
  WHAT: Chat panel accepts image drops (canvas nodes + OS files). External drops upload to /api/chat/uploads, create image-input nodes, appear on canvas live. Claude reads images via new `nebula path` + Read tool.
  WHY: v1 pillar #3 (Claude chat fluency). Visual critique and iteration loops now work — Claude can literally see outputs, not just reference them by text id.
  HOW: No image bytes in the chat protocol. Everything routes through @nX refs in message text + primer-taught `nebula path` lookup + Read. Hash-named files under OUTPUT_ROOT/chat-uploads/. Subsumes backlog items #2v2 and #4.
  ENABLES: Visual conversation loops. Moodboard (future feature) can focus on persistent references without duplicating this ephemeral per-turn flow.'
```

- [ ] **Step 10.4: Commit**

```bash
git add .planning/backlog/chat-panel-followups.md
git commit -m "docs: close out chat-panel-followups #2v2 and #4 after drag-image-to-chat ships

Both backlog items fold into the 2026-04-21 drag-image-to-chat
feature. Disposition log updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage check:**

| Spec section | Covered by |
|--------------|-----------|
| Canvas-node image drop flow | Tasks 5 (drag source), 7 (drop handler) |
| External file drop flow | Tasks 3 (endpoint), 8 (upload flow) |
| Claude's Read-tool delivery path | Tasks 1 (endpoint), 2 (CLI command), 4 (primer) |
| Composer chip UX | Tasks 6 (state + UI), 7 & 8 (drop branches), 9 (notices) |
| Multi-attach cap of 4 | Tasks 7, 8, 9 (limit enforcement + notice) |
| Message-log thumbnail rendering | Task 9 |
| Error handling (413/415/500) | Tasks 3 (backend), 8 (frontend) |
| Backend unit tests | Tasks 1, 3 |
| Manual dogfood | Task 10 |

**Type consistency check:**

- `PendingImage` discriminated union defined in Task 6.1 is referenced consistently in Tasks 7 (`ready` construction), 8 (`uploading` + `error` + swap logic), 9 (render cases).
- `@nX` format as `@${nodeId}` used consistently: Task 5 `startImageDrag`, Task 7 canvas-drop branch, Task 8 upload success path, Task 2 CLI command's matching primer reference, removeChip helper in Task 6.
- `CHAT_UPLOADS_DIR` introduced in Task 1 and used in Task 3 for the save path.
- `/api/outputs/chat-uploads/` URL prefix introduced in Task 3 and matched by `_url_to_output_path` prefix check in Task 1.

**Placeholder scan:** no `TBD`, `TODO`, `FIXME`, or "fill in details later" anywhere in the plan.

**Scope check:** single coherent feature — chat composer attachments + server save + canvas node creation + primer update. Implementable in one session sequence.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-21-drag-image-to-chat.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

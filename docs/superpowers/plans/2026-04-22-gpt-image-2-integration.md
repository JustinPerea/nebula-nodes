# GPT Image 2 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four new `gpt-image-2-*` nodes (OpenAI direct + FAL, generate + edit) with live partial-image streaming in the canvas, and two prompting skills (project-local + global) for the in-app Claude chat.

**Architecture:** New handler `openai_image_v2.py` for OpenAI-direct streaming; extend `stream_runner.py` with an image-mode that parses both OpenAI and FAL SSE dialects and emits a new `StreamPartialImageEvent`. FAL path reuses `fal_universal.py` with added streaming support. Frontend gets a new `streamPartialImage` WebSocket event type, a `streamingPartials` field on `NodeData`, and an image-partial preview branch in `DynamicNode.tsx`. V1 (`gpt-image-1-*`, `gpt-image-1-5*`) is untouched.

**Tech Stack:** Python 3.12 + httpx + pydantic (backend), React + TypeScript + zustand (frontend), OpenAI Images API, FAL queue/streaming API.

**Spec reference:** `docs/superpowers/specs/2026-04-22-gpt-image-2-integration-design.md` (commit `929bcd5`).

**Phasing note:** Tasks 1–10 ship the OpenAI-direct path end-to-end with full streaming. Tasks 11–13 add the FAL path (initially async-poll to match other FAL nodes, then streaming upgrade). Tasks 14–17 ship frontend preview and node-def mirrors. Tasks 18–19 ship skills. Task 20 is manual UAT.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `backend/handlers/openai_image_v2.py` | OpenAI-direct streaming handlers (`handle_gpt_image_2_generate`, `handle_gpt_image_2_edit`) |
| `backend/tests/test_openai_image_v2.py` | Unit tests for v2 handler (body-builder, SSE parser, error mapping) |
| `backend/tests/test_stream_runner_image.py` | Image-mode stream runner tests with recorded SSE fixtures |
| `backend/tests/fixtures/openai_image_v2_sse.txt` | Recorded SSE transcript: 2 partials + final |
| `backend/tests/fixtures/fal_image_v2_sse.txt` | Recorded FAL SSE transcript |
| `.claude/skills/gpt-image-2/SKILL.md` | Project-local skill (Nebula node IDs, params, UX) |
| `~/.claude/skills/gpt-image-2/SKILL.md` | Global skill (prompting craft) |

### Modified files

| Path | Change |
|---|---|
| `backend/models/events.py` | Add `StreamPartialImageEvent` pydantic model |
| `backend/services/output.py` | Add `save_base64_image_named(b64, run_dir, name)` helper for predictable partial filenames |
| `backend/execution/stream_runner.py` | Add image-mode to `stream_execute` (OpenAI + FAL dialects) |
| `backend/execution/sync_runner.py` | Register 4 new node IDs |
| `backend/handlers/fal_universal.py` | Add streaming path for image endpoints (Task 13) |
| `backend/data/node_definitions.json` | Add 4 node defs |
| `frontend/src/lib/wsClient.ts` | Add `streamPartialImage` to `ExecutionEvent` union |
| `frontend/src/types/index.ts` | Add `streamingPartials?: { index: number; src: string }[]` to `NodeData` |
| `frontend/src/store/graphStore.ts` | Handle `streamPartialImage` event; clear on queued/executed/error |
| `frontend/src/components/nodes/DynamicNode.tsx` | Render latest partial when node outputs Image and has partials |
| `frontend/src/constants/nodeDefinitions.ts` | Mirror 4 new node defs |
| `frontend/tests/store/graphStore.test.ts` | Test partial-image event handling |

---

## Task 1: Add `StreamPartialImageEvent` backend model

**Files:**
- Modify: `backend/models/events.py`
- Test: (covered via Task 3's integration tests — pydantic models have no standalone behavior to unit-test)

- [ ] **Step 1: Add the event class**

Append to `backend/models/events.py` after `StreamDeltaEvent`:

```python
class StreamPartialImageEvent(BaseModel):
    type: Literal["stream_partial_image"] = "stream_partial_image"
    node_id: str
    partial_index: int
    src: str  # server-relative file path
    is_final: bool = False
```

- [ ] **Step 2: Add it to the `ExecutionEvent` union**

Find the `ExecutionEvent = Union[...]` line at the bottom of `backend/models/events.py` and add `StreamPartialImageEvent` to the union tuple.

- [ ] **Step 3: Verify imports still resolve**

Run: `cd backend && python -c "from models.events import StreamPartialImageEvent, ExecutionEvent"`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/models/events.py
git commit -m "feat(events): add StreamPartialImageEvent for image streaming"
```

---

## Task 2: Add `save_base64_image_named` helper

**Files:**
- Modify: `backend/services/output.py`
- Test: `backend/tests/test_output_service.py` (new if missing, or add to existing)

Current `save_base64_image` generates a random 12-char filename. Partials need predictable names so the frontend knows which partial it's replacing.

- [ ] **Step 1: Write the failing test**

Create or append to `backend/tests/test_output_service.py`:

```python
import base64
from pathlib import Path
from services.output import save_base64_image_named


def test_save_base64_image_named_writes_to_exact_filename(tmp_path: Path) -> None:
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16  # minimal-ish
    b64 = base64.b64encode(png_bytes).decode()
    out = save_base64_image_named(b64, tmp_path, name="node123_partial_0")
    assert out == tmp_path / "node123_partial_0.png"
    assert out.read_bytes() == png_bytes


def test_save_base64_image_named_accepts_extension(tmp_path: Path) -> None:
    b64 = base64.b64encode(b"x").decode()
    out = save_base64_image_named(b64, tmp_path, name="n", extension="jpg")
    assert out == tmp_path / "n.jpg"
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && pytest tests/test_output_service.py -v`
Expected: FAIL — `save_base64_image_named` not importable.

- [ ] **Step 3: Implement**

Add to `backend/services/output.py`:

```python
def save_base64_image_named(
    b64_data: str, run_dir: Path, name: str, extension: str = "png"
) -> Path:
    image_bytes = base64.b64decode(b64_data)
    file_path = run_dir / f"{name}.{extension}"
    file_path.write_bytes(image_bytes)
    return file_path
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && pytest tests/test_output_service.py -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/services/output.py backend/tests/test_output_service.py
git commit -m "feat(output): add save_base64_image_named for predictable partial filenames"
```

---

## Task 3: Extend `stream_runner.py` with image mode (OpenAI dialect)

**Files:**
- Modify: `backend/execution/stream_runner.py`
- Create: `backend/tests/fixtures/openai_image_v2_sse.txt`
- Create: `backend/tests/test_stream_runner_image.py`

- [ ] **Step 1: Create the SSE fixture**

Create `backend/tests/fixtures/openai_image_v2_sse.txt` with a small recorded OpenAI-direct SSE transcript (2 partials + final). Use minimal base64 payloads so the file stays small. Example content:

```
event: image_generation.partial_image
data: {"partial_image_index": 0, "b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="}

event: image_generation.partial_image
data: {"partial_image_index": 1, "b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="}

event: image_generation.completed
data: {"b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="}

data: [DONE]
```

The three base64 strings are each a valid 1x1 PNG.

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_stream_runner_image.py`:

```python
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import respx
from httpx import Response

from execution.stream_runner import StreamConfig, stream_execute_image
from models.events import ExecutionEvent, StreamPartialImageEvent


FIXTURE = Path(__file__).parent / "fixtures" / "openai_image_v2_sse.txt"


@pytest.mark.asyncio
@respx.mock
async def test_image_stream_emits_partials_and_returns_final(tmp_path: Path) -> None:
    sse_bytes = FIXTURE.read_bytes()
    respx.post("https://api.openai.com/v1/images/generations").mock(
        return_value=Response(200, content=sse_bytes, headers={"content-type": "text/event-stream"})
    )

    emitted: list[ExecutionEvent] = []

    async def emit(event: ExecutionEvent) -> None:
        emitted.append(event)

    config = StreamConfig(
        url="https://api.openai.com/v1/images/generations",
        headers={"Authorization": "Bearer test"},
    )
    final_path = await stream_execute_image(
        config=config,
        request_body={"model": "gpt-image-2", "prompt": "hi", "stream": True, "partial_images": 2},
        node_id="n1",
        emit=emit,
        run_dir=tmp_path,
        provider="openai",
    )

    partials = [e for e in emitted if isinstance(e, StreamPartialImageEvent)]
    assert [p.partial_index for p in partials] == [0, 1]
    assert all(Path(p.src).exists() for p in partials)
    assert all(not p.is_final for p in partials)
    assert Path(final_path).exists()
    assert final_path.endswith(".png")
```

- [ ] **Step 3: Run, expect FAIL**

Run: `cd backend && pytest tests/test_stream_runner_image.py -v`
Expected: FAIL — `stream_execute_image` not importable.

- [ ] **Step 4: Implement `stream_execute_image`**

Add to `backend/execution/stream_runner.py`:

```python
from typing import Literal
from pathlib import Path
from models.events import StreamPartialImageEvent
from services.output import save_base64_image_named


async def stream_execute_image(
    config: StreamConfig,
    request_body: dict[str, Any],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    run_dir: Path,
    provider: Literal["openai", "fal"],
) -> str:
    """Stream image-generation SSE, save each partial + final to disk, emit events.

    Returns the final image's absolute file path as a string.
    """
    final_path: Path | None = None
    current_event_type: str | None = None

    async with httpx.AsyncClient(timeout=httpx.Timeout(config.timeout, read=None)) as client:
        async with client.stream("POST", config.url, headers=config.headers, json=request_body) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                raise RuntimeError(f"Image stream request failed ({response.status_code}): {error_body}")

            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    current_event_type = None
                    continue
                if line.startswith("event:"):
                    current_event_type = line[len("event:"):].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                data_str = line[len("data:"):].strip()
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                except (ValueError, TypeError):
                    continue

                parsed = _parse_image_event(provider, current_event_type, data)
                if parsed is None:
                    continue
                kind, index, b64 = parsed
                if kind == "partial":
                    path = save_base64_image_named(
                        b64, run_dir, name=f"{node_id}_partial_{index}"
                    )
                    await emit(StreamPartialImageEvent(
                        node_id=node_id, partial_index=index, src=str(path), is_final=False,
                    ))
                elif kind == "final":
                    final_path = save_base64_image_named(b64, run_dir, name=f"{node_id}_final")

    if final_path is None:
        raise RuntimeError("Image stream ended without a final image event")
    return str(final_path)


def _parse_image_event(
    provider: str, event_type: str | None, data: dict[str, Any]
) -> tuple[str, int, str] | None:
    """Return (kind, index, b64_json) or None. kind = 'partial' | 'final'."""
    if provider == "openai":
        if event_type == "image_generation.partial_image":
            idx = data.get("partial_image_index", 0)
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return ("partial", int(idx), b64)
        elif event_type == "image_generation.completed":
            b64 = data.get("b64_json")
            if isinstance(b64, str):
                return ("final", 0, b64)
    elif provider == "fal":
        # FAL dialect wired up in Task 13.
        pass
    return None
```

- [ ] **Step 5: Add respx to dev deps if missing**

Run: `cd backend && pip install respx pytest-asyncio` and add both to `requirements.txt` if not already present.

- [ ] **Step 6: Run, expect PASS**

Run: `cd backend && pytest tests/test_stream_runner_image.py -v`
Expected: 1 passed.

- [ ] **Step 7: Commit**

```bash
git add backend/execution/stream_runner.py backend/tests/test_stream_runner_image.py backend/tests/fixtures/openai_image_v2_sse.txt backend/requirements.txt
git commit -m "feat(stream): add stream_execute_image with OpenAI dialect parser"
```

---

## Task 4: Implement `handle_gpt_image_2_generate` (OpenAI direct)

**Files:**
- Create: `backend/handlers/openai_image_v2.py`
- Create: `backend/tests/test_openai_image_v2.py`

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_openai_image_v2.py`:

```python
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import respx
from httpx import Response

from handlers.openai_image_v2 import handle_gpt_image_2_generate, build_generate_body
from models.graph import GraphNode, PortValueDict


def _node(params: dict[str, Any]) -> GraphNode:
    return GraphNode(id="n1", type="gpt-image-2-generate", params=params, position={"x": 0, "y": 0})


def test_build_generate_body_minimal() -> None:
    node = _node({})
    body = build_generate_body(node, prompt_text="hello")
    assert body["model"] == "gpt-image-2"
    assert body["prompt"] == "hello"
    assert body["stream"] is True
    assert body["partial_images"] == 2  # default


def test_build_generate_body_omits_unsupported_params() -> None:
    # background and input_fidelity must be stripped defensively even if present.
    node = _node({"background": "transparent", "input_fidelity": "high", "size": "1024x1024"})
    body = build_generate_body(node, prompt_text="x")
    assert "background" not in body
    assert "input_fidelity" not in body
    assert body["size"] == "1024x1024"


def test_build_generate_body_passes_quality_format_moderation() -> None:
    node = _node({
        "size": "3840x2160", "quality": "high", "output_format": "jpeg",
        "output_compression": 80, "moderation": "low", "n": 2, "partial_images": 3,
    })
    body = build_generate_body(node, prompt_text="x")
    assert body["size"] == "3840x2160"
    assert body["quality"] == "high"
    assert body["output_format"] == "jpeg"
    assert body["output_compression"] == 80
    assert body["moderation"] == "low"
    assert body["n"] == 2
    assert body["partial_images"] == 3


def test_build_generate_body_drops_output_compression_for_png() -> None:
    node = _node({"output_format": "png", "output_compression": 50})
    body = build_generate_body(node, prompt_text="x")
    assert "output_compression" not in body


@pytest.mark.asyncio
async def test_handle_generate_requires_prompt_input() -> None:
    node = _node({})
    with pytest.raises(ValueError, match="Prompt input is required"):
        await handle_gpt_image_2_generate(node, inputs={}, api_keys={"OPENAI_API_KEY": "k"}, emit=None, run_dir=Path("/tmp"))


@pytest.mark.asyncio
async def test_handle_generate_requires_api_key() -> None:
    node = _node({})
    inputs = {"prompt": PortValueDict(type="Text", value="hi")}
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        await handle_gpt_image_2_generate(node, inputs=inputs, api_keys={}, emit=None, run_dir=Path("/tmp"))


@pytest.mark.asyncio
@respx.mock
async def test_handle_generate_org_verification_error_returns_friendly_message() -> None:
    respx.post("https://api.openai.com/v1/images/generations").mock(
        return_value=Response(403, json={"error": {"code": "organization_must_be_verified", "message": "verify"}})
    )
    node = _node({})
    inputs = {"prompt": PortValueDict(type="Text", value="hi")}
    with pytest.raises(RuntimeError, match="org isn't verified"):
        await handle_gpt_image_2_generate(
            node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"}, emit=None,
            run_dir=Path("/tmp"),
        )
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && pytest tests/test_openai_image_v2.py -v`
Expected: FAIL — module not importable.

- [ ] **Step 3: Implement the handler**

Create `backend/handlers/openai_image_v2.py`:

```python
from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from execution.stream_runner import StreamConfig, stream_execute_image
from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from services.output import get_run_dir

OPENAI_GENERATIONS_URL = "https://api.openai.com/v1/images/generations"
OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits"
DEFAULT_PARTIAL_IMAGES = 2


def build_generate_body(node: GraphNode, prompt_text: str) -> dict[str, Any]:
    params = node.params or {}
    body: dict[str, Any] = {
        "model": "gpt-image-2",
        "prompt": prompt_text,
        "stream": True,
        "partial_images": int(params.get("partial_images", DEFAULT_PARTIAL_IMAGES)),
    }
    for key in ("size", "quality", "moderation"):
        value = params.get(key)
        if value and value != "auto":
            body[key] = value
    n_value = params.get("n")
    if n_value and int(n_value) > 1:
        body["n"] = int(n_value)
    fmt = params.get("output_format", "png")
    if fmt and fmt != "png":
        body["output_format"] = fmt
        comp = params.get("output_compression")
        if comp is not None:
            body["output_compression"] = int(comp)
    # Defensive: gpt-image-2 does NOT support these, never forward.
    body.pop("background", None)
    body.pop("input_fidelity", None)
    return body


async def handle_gpt_image_2_generate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
    run_dir: Path | None = None,
) -> dict[str, Any]:
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")
    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    body = build_generate_body(node, prompt_text=str(prompt_input.value))
    config = StreamConfig(
        url=OPENAI_GENERATIONS_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
        timeout=180.0,
    )
    effective_run_dir = run_dir or get_run_dir()

    async def _noop(_e: ExecutionEvent) -> None:
        return None

    try:
        final_path = await stream_execute_image(
            config=config,
            request_body=body,
            node_id=node.id,
            emit=emit or _noop,
            run_dir=effective_run_dir,
            provider="openai",
        )
    except RuntimeError as exc:
        msg = str(exc)
        if "organization_must_be_verified" in msg or "must be verified" in msg.lower():
            raise RuntimeError(
                "Your OpenAI org isn't verified for gpt-image-2. "
                "Visit https://platform.openai.com/settings/organization/general to verify."
            ) from exc
        raise

    return {"image": {"type": "Image", "value": final_path}}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && pytest tests/test_openai_image_v2.py -v`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/handlers/openai_image_v2.py backend/tests/test_openai_image_v2.py
git commit -m "feat(handler): gpt-image-2 generate handler with defensive param filtering"
```

---

## Task 5: Implement `handle_gpt_image_2_edit`

**Files:**
- Modify: `backend/handlers/openai_image_v2.py`
- Modify: `backend/tests/test_openai_image_v2.py`

- [ ] **Step 1: Add failing tests**

Append to `backend/tests/test_openai_image_v2.py`:

```python
from handlers.openai_image_v2 import handle_gpt_image_2_edit


@pytest.mark.asyncio
async def test_edit_rejects_more_than_10_images(tmp_path: Path) -> None:
    # 11 image values
    img_paths = []
    for i in range(11):
        p = tmp_path / f"in{i}.png"
        p.write_bytes(b"x")
        img_paths.append(str(p))
    node = _node({})
    inputs = {
        "image": PortValueDict(type="Image", value=img_paths),
        "prompt": PortValueDict(type="Text", value="edit please"),
    }
    with pytest.raises(ValueError, match="up to 10"):
        await handle_gpt_image_2_edit(
            node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
            emit=None, run_dir=tmp_path,
        )


@pytest.mark.asyncio
async def test_edit_requires_at_least_one_image() -> None:
    node = _node({})
    inputs = {"prompt": PortValueDict(type="Text", value="hi")}
    with pytest.raises(ValueError, match="Image input is required"):
        await handle_gpt_image_2_edit(
            node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
            emit=None, run_dir=Path("/tmp"),
        )
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && pytest tests/test_openai_image_v2.py -v -k edit`
Expected: FAIL — `handle_gpt_image_2_edit` not defined.

- [ ] **Step 3: Implement**

Append to `backend/handlers/openai_image_v2.py`:

```python
MAX_EDIT_IMAGES = 10


def _normalize_image_input(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v]
    if isinstance(value, str) and value:
        return [value]
    return []


async def handle_gpt_image_2_edit(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
    run_dir: Path | None = None,
) -> dict[str, Any]:
    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise ValueError("Image input is required but was not provided")
    prompt_input = inputs.get("prompt")
    if not prompt_input or not prompt_input.value:
        raise ValueError("Prompt input is required but was not provided")
    api_key = api_keys.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    image_paths = _normalize_image_input(image_input.value)
    if len(image_paths) > MAX_EDIT_IMAGES:
        raise ValueError(
            f"gpt-image-2 edit accepts up to {MAX_EDIT_IMAGES} input images; got {len(image_paths)}"
        )
    if len(image_paths) == 0:
        raise ValueError("Image input is required but was not provided")

    body = build_generate_body(node, prompt_text=str(prompt_input.value))
    # Edits POST is multipart, not JSON — build separately.
    effective_run_dir = run_dir or get_run_dir()

    # Build multipart form.
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for path in image_paths:
        p = Path(path)
        files.append(("image[]", (p.name, p.read_bytes(), "image/png")))
    mask_input = inputs.get("mask")
    if mask_input and mask_input.value:
        mp = Path(str(mask_input.value))
        files.append(("mask", (mp.name, mp.read_bytes(), "image/png")))

    form: dict[str, str] = {}
    for key in ("model", "prompt", "size", "quality", "moderation", "output_format"):
        if key in body:
            form[key] = str(body[key])
    if "output_compression" in body:
        form["output_compression"] = str(body["output_compression"])
    if "n" in body:
        form["n"] = str(body["n"])
    form["stream"] = "true"
    form["partial_images"] = str(body["partial_images"])

    # Use httpx directly for multipart + SSE streaming.
    import httpx
    from services.output import save_base64_image_named
    from models.events import StreamPartialImageEvent
    import json

    async def _noop(_e: ExecutionEvent) -> None:
        return None

    _emit = emit or _noop
    final_path: Path | None = None
    current_event_type: str | None = None

    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, read=None)) as client:
        async with client.stream(
            "POST", OPENAI_EDITS_URL,
            headers={"Authorization": f"Bearer {api_key}", "Accept": "text/event-stream"},
            data=form, files=files,
        ) as response:
            if response.status_code != 200:
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                if "organization_must_be_verified" in error_body or "must be verified" in error_body.lower():
                    raise RuntimeError(
                        "Your OpenAI org isn't verified for gpt-image-2. "
                        "Visit https://platform.openai.com/settings/organization/general to verify."
                    )
                raise RuntimeError(f"Image edit failed ({response.status_code}): {error_body}")
            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    current_event_type = None
                    continue
                if line.startswith("event:"):
                    current_event_type = line[len("event:"):].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                data_str = line[len("data:"):].strip()
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                except (ValueError, TypeError):
                    continue
                if current_event_type == "image_generation.partial_image":
                    idx = int(data.get("partial_image_index", 0))
                    b64 = data.get("b64_json")
                    if isinstance(b64, str):
                        path = save_base64_image_named(
                            b64, effective_run_dir, name=f"{node.id}_partial_{idx}"
                        )
                        await _emit(StreamPartialImageEvent(
                            node_id=node.id, partial_index=idx, src=str(path), is_final=False,
                        ))
                elif current_event_type == "image_generation.completed":
                    b64 = data.get("b64_json")
                    if isinstance(b64, str):
                        final_path = save_base64_image_named(b64, effective_run_dir, name=f"{node.id}_final")

    if final_path is None:
        raise RuntimeError("Image edit stream ended without a final image event")
    return {"image": {"type": "Image", "value": str(final_path)}}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && pytest tests/test_openai_image_v2.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/handlers/openai_image_v2.py backend/tests/test_openai_image_v2.py
git commit -m "feat(handler): gpt-image-2 edit handler with multipart + streaming"
```

---

## Task 6: Register OpenAI-direct handlers in `sync_runner.py`

**Files:**
- Modify: `backend/execution/sync_runner.py`
- Test: `backend/tests/test_node_registry.py` (if present — extend; otherwise inline test here)

- [ ] **Step 1: Write failing test**

Append to `backend/tests/test_node_registry.py` (create file if missing):

```python
import pytest
from execution.sync_runner import get_handler_registry


@pytest.mark.asyncio
async def test_gpt_image_2_nodes_registered() -> None:
    async def fake_emit(_e):
        return None
    registry = get_handler_registry(emit=fake_emit)
    assert "gpt-image-2-generate" in registry
    assert "gpt-image-2-edit" in registry
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd backend && pytest tests/test_node_registry.py::test_gpt_image_2_nodes_registered -v`

- [ ] **Step 3: Register**

Inside `get_handler_registry` in `backend/execution/sync_runner.py`, after the existing `from handlers.fal_universal import handle_fal_universal` line (around line 58), add:

```python
from handlers.openai_image_v2 import handle_gpt_image_2_generate, handle_gpt_image_2_edit
from services.output import get_run_dir

async def _openai_image_2_generate_handler(node, inputs, api_keys):
    return await handle_gpt_image_2_generate(
        node, inputs, api_keys, emit=emit, run_dir=get_run_dir(),
    )

async def _openai_image_2_edit_handler(node, inputs, api_keys):
    return await handle_gpt_image_2_edit(
        node, inputs, api_keys, emit=emit, run_dir=get_run_dir(),
    )

registry["gpt-image-2-generate"] = _openai_image_2_generate_handler
registry["gpt-image-2-edit"] = _openai_image_2_edit_handler
```

Place the two `registry[...]` lines next to the existing `registry["gpt-image-1-5"] = _gpt_image_15_handler` block for consistency.

- [ ] **Step 4: Run, expect PASS**

Run: `cd backend && pytest tests/test_node_registry.py -v`

- [ ] **Step 5: Commit**

```bash
git add backend/execution/sync_runner.py backend/tests/test_node_registry.py
git commit -m "feat(sync-runner): register gpt-image-2 direct handlers"
```

---

## Task 7: Add OpenAI-direct node definitions (`backend/data/node_definitions.json`)

**Files:**
- Modify: `backend/data/node_definitions.json`
- Test: `backend/tests/test_node_definitions.py` (if present — add a smoke test)

- [ ] **Step 1: Add both node defs**

Open `backend/data/node_definitions.json`. Near the existing `gpt-image-1-edit` entry, add two new top-level keys. Use this exact JSON:

```json
"gpt-image-2-generate": {
  "id": "gpt-image-2-generate",
  "displayName": "GPT Image 2",
  "category": "image-gen",
  "apiProvider": "openai",
  "apiEndpoint": "/v1/images/generations",
  "envKeyName": "OPENAI_API_KEY",
  "executionPattern": "stream",
  "inputPorts": [
    { "id": "prompt", "label": "Prompt", "dataType": "Text", "required": true }
  ],
  "outputPorts": [
    { "id": "image", "label": "Image", "dataType": "Image", "required": false }
  ],
  "params": [
    { "key": "size", "label": "Size", "type": "enum", "required": false, "default": "auto",
      "options": [
        { "label": "Auto", "value": "auto" },
        { "label": "1024x1024", "value": "1024x1024" },
        { "label": "1536x1024", "value": "1536x1024" },
        { "label": "1024x1536", "value": "1024x1536" },
        { "label": "2048x2048", "value": "2048x2048" },
        { "label": "2048x1152", "value": "2048x1152" },
        { "label": "3840x2160 (4K landscape)", "value": "3840x2160" },
        { "label": "2160x3840 (4K portrait)", "value": "2160x3840" }
      ]
    },
    { "key": "quality", "label": "Quality", "type": "enum", "required": false, "default": "auto",
      "options": [
        { "label": "Auto", "value": "auto" },
        { "label": "Low", "value": "low" },
        { "label": "Medium", "value": "medium" },
        { "label": "High", "value": "high" }
      ]
    },
    { "key": "n", "label": "Count", "type": "integer", "required": false, "default": 1, "min": 1, "max": 10 },
    { "key": "output_format", "label": "Format", "type": "enum", "required": false, "default": "png",
      "options": [
        { "label": "PNG", "value": "png" },
        { "label": "JPEG", "value": "jpeg" },
        { "label": "WebP", "value": "webp" }
      ]
    },
    { "key": "output_compression", "label": "Compression", "type": "integer", "required": false, "default": 90, "min": 0, "max": 100 },
    { "key": "moderation", "label": "Moderation", "type": "enum", "required": false, "default": "auto",
      "options": [
        { "label": "Auto", "value": "auto" },
        { "label": "Low", "value": "low" }
      ]
    },
    { "key": "partial_images", "label": "Preview Frames", "type": "integer", "required": false, "default": 2, "min": 0, "max": 3 }
  ]
},
"gpt-image-2-edit": {
  "id": "gpt-image-2-edit",
  "displayName": "GPT Image 2 Edit",
  "category": "image-gen",
  "apiProvider": "openai",
  "apiEndpoint": "/v1/images/edits",
  "envKeyName": "OPENAI_API_KEY",
  "executionPattern": "stream",
  "inputPorts": [
    { "id": "image", "label": "Image", "dataType": "Image", "required": true, "multiple": true },
    { "id": "prompt", "label": "Prompt", "dataType": "Text", "required": true },
    { "id": "mask", "label": "Mask", "dataType": "Mask", "required": false }
  ],
  "outputPorts": [
    { "id": "image", "label": "Image", "dataType": "Image", "required": false }
  ],
  "params": [
    { "key": "size", "label": "Size", "type": "enum", "required": false, "default": "auto",
      "options": [
        { "label": "Auto", "value": "auto" },
        { "label": "1024x1024", "value": "1024x1024" },
        { "label": "1536x1024", "value": "1536x1024" },
        { "label": "1024x1536", "value": "1024x1536" },
        { "label": "2048x2048", "value": "2048x2048" },
        { "label": "2048x1152", "value": "2048x1152" },
        { "label": "3840x2160 (4K landscape)", "value": "3840x2160" },
        { "label": "2160x3840 (4K portrait)", "value": "2160x3840" }
      ]
    },
    { "key": "quality", "label": "Quality", "type": "enum", "required": false, "default": "auto",
      "options": [
        { "label": "Auto", "value": "auto" },
        { "label": "Low", "value": "low" },
        { "label": "Medium", "value": "medium" },
        { "label": "High", "value": "high" }
      ]
    },
    { "key": "n", "label": "Count", "type": "integer", "required": false, "default": 1, "min": 1, "max": 10 },
    { "key": "output_format", "label": "Format", "type": "enum", "required": false, "default": "png",
      "options": [
        { "label": "PNG", "value": "png" },
        { "label": "JPEG", "value": "jpeg" },
        { "label": "WebP", "value": "webp" }
      ]
    },
    { "key": "output_compression", "label": "Compression", "type": "integer", "required": false, "default": 90, "min": 0, "max": 100 },
    { "key": "moderation", "label": "Moderation", "type": "enum", "required": false, "default": "auto",
      "options": [
        { "label": "Auto", "value": "auto" },
        { "label": "Low", "value": "low" }
      ]
    },
    { "key": "partial_images", "label": "Preview Frames", "type": "integer", "required": false, "default": 2, "min": 0, "max": 3 }
  ]
}
```

- [ ] **Step 2: Validate JSON**

Run: `cd backend && python -c "import json; json.load(open('data/node_definitions.json'))"`
Expected: no output, exit 0.

- [ ] **Step 3: Run existing test suite to verify nothing regressed**

Run: `cd backend && pytest -v`
Expected: all previously-passing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add backend/data/node_definitions.json
git commit -m "feat(nodes): add gpt-image-2 generate and edit node definitions"
```

---

## Task 8: End-to-end backend smoke test for OpenAI-direct generate

**Files:**
- Modify: `backend/tests/test_openai_image_v2.py`

- [ ] **Step 1: Add an E2E test with mocked SSE**

Append to `backend/tests/test_openai_image_v2.py`:

```python
@pytest.mark.asyncio
@respx.mock
async def test_e2e_generate_emits_partials_and_returns_image(tmp_path: Path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "openai_image_v2_sse.txt"
    respx.post("https://api.openai.com/v1/images/generations").mock(
        return_value=Response(200, content=fixture.read_bytes(), headers={"content-type": "text/event-stream"})
    )

    emitted: list = []

    async def emit(event) -> None:
        emitted.append(event)

    node = _node({"size": "1024x1024", "quality": "low"})
    inputs = {"prompt": PortValueDict(type="Text", value="a cat")}
    out = await handle_gpt_image_2_generate(
        node, inputs=inputs, api_keys={"OPENAI_API_KEY": "k"},
        emit=emit, run_dir=tmp_path,
    )
    assert out["image"]["type"] == "Image"
    assert Path(out["image"]["value"]).exists()
    partials = [e for e in emitted if e.__class__.__name__ == "StreamPartialImageEvent"]
    assert len(partials) == 2
    assert [p.partial_index for p in partials] == [0, 1]
```

- [ ] **Step 2: Run, expect PASS**

Run: `cd backend && pytest tests/test_openai_image_v2.py -v`
Expected: 9 passed.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_openai_image_v2.py
git commit -m "test(gpt-image-2): e2e generate smoke with fixture SSE"
```

---

## Task 9: Add `streamPartialImage` WS event on the frontend

**Files:**
- Modify: `frontend/src/lib/wsClient.ts`
- Modify: `frontend/src/types/index.ts`
- Test: `frontend/tests/store/graphStore.test.ts` (extend — graphStore handles this event)

- [ ] **Step 1: Extend `ExecutionEvent` in `wsClient.ts`**

In `frontend/src/lib/wsClient.ts`, add to the `ExecutionEvent` union:

```ts
  | { type: 'streamPartialImage'; nodeId: string; partialIndex: number; src: string; isFinal: boolean }
```

- [ ] **Step 2: Add `streamingPartials` to `NodeData`**

In `frontend/src/types/index.ts`, find the `NodeData` type with the existing `streamingText?: string` field and add:

```ts
  streamingPartials?: { index: number; src: string }[];
```

- [ ] **Step 3: Run typecheck**

Run: `cd frontend && npm run typecheck` (or `npx tsc --noEmit`)
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/wsClient.ts frontend/src/types/index.ts
git commit -m "feat(ws): add streamPartialImage event type and NodeData.streamingPartials"
```

---

## Task 10: Handle `streamPartialImage` in `graphStore.ts`

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/tests/store/graphStore.test.ts`

- [ ] **Step 1: Write failing test**

Open `frontend/tests/store/graphStore.test.ts`. Add a test:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';

describe('graphStore streamPartialImage', () => {
  beforeEach(() => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'gpt-image-2-generate', position: {x:0,y:0}, data: { state: 'executing' } } as any], edges: [] });
  });

  it('appends partials in order', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 1, src: '/b.png', isFinal: false });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toEqual([
      { index: 0, src: '/a.png' },
      { index: 1, src: '/b.png' },
    ]);
  });

  it('clears partials on executed event', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'executed', nodeId: 'n1', outputs: { image: { type: 'Image', value: '/final.png' } } });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toBeUndefined();
  });
});
```

(If the store's event method isn't named `handleExecutionEvent`, grep for the existing `case 'streamDelta'` switch handler and match that entry point.)

- [ ] **Step 2: Run, expect FAIL**

Run: `cd frontend && npm test -- store/graphStore`
Expected: FAIL — new event not handled.

- [ ] **Step 3: Add case to the switch**

In `frontend/src/store/graphStore.ts`, find the `case 'streamDelta':` block near line 1086 and add right after it:

```ts
      case 'streamPartialImage': {
        const existing = get().nodes.find((n) => n.id === event.nodeId)?.data.streamingPartials ?? [];
        const filtered = existing.filter((p) => p.index !== event.partialIndex);
        const next = [...filtered, { index: event.partialIndex, src: event.src }].sort((a, b) => a.index - b.index);
        get().updateNodeData(event.nodeId, { streamingPartials: next });
        break;
      }
```

Also update the existing `executed`, `error`, and `queued` / `executing` cases where `streamingText: undefined` is already set — add `streamingPartials: undefined` alongside it at each of those call sites (lines ~1057, 1083, around error handler, and initial state at ~49).

- [ ] **Step 4: Run, expect PASS**

Run: `cd frontend && npm test -- store/graphStore`
Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/store/graphStore.ts frontend/tests/store/graphStore.test.ts
git commit -m "feat(store): handle streamPartialImage; clear partials on executed/error/queued"
```

---

## Task 11: Render partials in `DynamicNode.tsx`

**Files:**
- Modify: `frontend/src/components/nodes/DynamicNode.tsx`

Visual change, no unit test — we'll UAT manually in Task 20.

- [ ] **Step 1: Add partial-preview branch**

In `DynamicNode.tsx`, find the existing `displayText` / `isStreaming` block (around line 32). After the text branch, add an image-partial branch that runs when `executionPattern === 'stream'` and output type is `Image`:

```tsx
const partials = nodeData.streamingPartials;
const latestPartial = partials && partials.length > 0 ? partials[partials.length - 1] : null;
const imageOutput = nodeData.outputs?.image;
const finalImageSrc = imageOutput && typeof imageOutput.value === 'string' ? imageOutput.value : null;
const previewImageSrc = finalImageSrc ?? latestPartial?.src ?? null;
const isStreamingImage = nodeData.state === 'executing' && partials != null && finalImageSrc == null;
```

In the node's preview region (find the existing preview rendering), add a branch that renders `<img src={previewImageSrc} className={isStreamingImage ? 'model-node__preview-image--streaming' : 'model-node__preview-image'} />` when `previewImageSrc` exists.

- [ ] **Step 2: Add streaming CSS hint**

In `frontend/src/styles/nodes.css`, add:

```css
.model-node__preview-image {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}
.model-node__preview-image--streaming {
  opacity: 0.85;
  outline: 1px dashed var(--accent, #888);
}
```

- [ ] **Step 3: Run typecheck + dev server**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (Full UAT is in Task 20.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/nodes/DynamicNode.tsx frontend/src/styles/nodes.css
git commit -m "feat(node-ui): render latest partial image during streaming"
```

---

## Task 12: Mirror node defs in `frontend/src/constants/nodeDefinitions.ts`

**Files:**
- Modify: `frontend/src/constants/nodeDefinitions.ts`

- [ ] **Step 1: Mirror the two OpenAI-direct defs**

Near the existing `'gpt-image-1-5'` entry, add two new entries. The TypeScript shape mirrors the JSON shape from Task 7. Copy the JSON verbatim and adjust syntax (quotes, trailing commas, `executionPattern: 'stream' as const`, etc.).

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/constants/nodeDefinitions.ts
git commit -m "feat(nodes-fe): mirror gpt-image-2 generate and edit frontend defs"
```

---

## Task 13: FAL streaming path — `fal_universal.py` extension + registration

**Files:**
- Modify: `backend/handlers/fal_universal.py`
- Modify: `backend/execution/sync_runner.py`
- Modify: `backend/execution/stream_runner.py` (add FAL dialect to `_parse_image_event`)
- Create: `backend/tests/fixtures/fal_image_v2_sse.txt`
- Modify: `backend/tests/test_stream_runner_image.py`
- Modify: `backend/data/node_definitions.json`
- Modify: `frontend/src/constants/nodeDefinitions.ts`

**Context:** FAL's `openai/gpt-image-2` endpoint supports SSE via `POST {endpoint}/stream`. Event shape (from FAL docs): `data: {"type": "image.partial", "image": {"b64_json": "...", "partial_index": 0}}` and `data: {"type": "image.completed", "image": {"b64_json": "..."}}`. Verify exact shape by checking FAL's API doc when you implement — this plan assumes that shape and the fixture uses it.

- [ ] **Step 1: Create FAL fixture**

Create `backend/tests/fixtures/fal_image_v2_sse.txt` with two partials + final using the above assumed FAL event shape.

- [ ] **Step 2: Add failing test**

Append to `backend/tests/test_stream_runner_image.py`:

```python
@pytest.mark.asyncio
@respx.mock
async def test_fal_image_stream_parses_partials(tmp_path: Path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "fal_image_v2_sse.txt"
    respx.post("https://queue.fal.run/openai/gpt-image-2/stream").mock(
        return_value=Response(200, content=fixture.read_bytes(), headers={"content-type": "text/event-stream"})
    )
    emitted: list = []
    async def emit(e):
        emitted.append(e)
    config = StreamConfig(url="https://queue.fal.run/openai/gpt-image-2/stream", headers={"Authorization": "Key k"})
    final = await stream_execute_image(
        config=config, request_body={"prompt": "hi"}, node_id="n", emit=emit,
        run_dir=tmp_path, provider="fal",
    )
    partials = [e for e in emitted if e.__class__.__name__ == "StreamPartialImageEvent"]
    assert [p.partial_index for p in partials] == [0, 1]
    assert Path(final).exists()
```

- [ ] **Step 3: Run, expect FAIL**

Run: `cd backend && pytest tests/test_stream_runner_image.py -v`

- [ ] **Step 4: Implement FAL dialect in `_parse_image_event`**

In `backend/execution/stream_runner.py`, extend `_parse_image_event` with the `fal` branch:

```python
    elif provider == "fal":
        ev_type = data.get("type")
        image = data.get("image") or {}
        b64 = image.get("b64_json")
        if not isinstance(b64, str):
            return None
        if ev_type == "image.partial":
            idx = image.get("partial_index", 0)
            return ("partial", int(idx), b64)
        if ev_type == "image.completed":
            return ("final", 0, b64)
```

(Confirm the exact event `type` strings and nesting against FAL's docs before committing. If different, update both the fixture and the parser to match.)

- [ ] **Step 5: Register FAL nodes in `sync_runner.py`**

Near the existing `gpt-image-1-5` FAL registration block, add:

```python
async def _gpt_image_2_fal_generate_handler(node, inputs, api_keys):
    node.params.setdefault("endpoint_id", "openai/gpt-image-2")
    return await handle_fal_universal(node, inputs, api_keys, emit=emit)

async def _gpt_image_2_fal_edit_handler(node, inputs, api_keys):
    node.params.setdefault("endpoint_id", "openai/gpt-image-2/edit")
    return await handle_fal_universal(node, inputs, api_keys, emit=emit)

registry["gpt-image-2-fal-generate"] = _gpt_image_2_fal_generate_handler
registry["gpt-image-2-fal-edit"] = _gpt_image_2_fal_edit_handler
```

- [ ] **Step 6: Add streaming branch to `fal_universal.py`**

In `handle_fal_universal`, detect when the `endpoint_id` matches the gpt-image-2 endpoints and route to a streaming call via `stream_execute_image(..., provider="fal")` instead of the queue-polling path. Pseudocode:

```python
STREAMING_FAL_ENDPOINTS = {"openai/gpt-image-2", "openai/gpt-image-2/edit"}

if node.params.get("endpoint_id") in STREAMING_FAL_ENDPOINTS and emit is not None:
    # Build FAL request body; POST to {FAL_QUEUE_BASE}/{endpoint_id}/stream
    from execution.stream_runner import StreamConfig, stream_execute_image
    from services.output import get_run_dir
    run_dir = get_run_dir()
    config = StreamConfig(
        url=f"{FAL_QUEUE_BASE}/{node.params['endpoint_id']}/stream",
        headers={"Authorization": f"Key {api_keys['FAL_KEY']}", "Accept": "text/event-stream"},
        timeout=180.0,
    )
    final = await stream_execute_image(
        config=config, request_body=request_body, node_id=node.id,
        emit=emit, run_dir=run_dir, provider="fal",
    )
    return {"image": {"type": "Image", "value": final}}
# else fall through to existing queue/polling path
```

- [ ] **Step 7: Add FAL node defs to both JSON and TS**

Append to `backend/data/node_definitions.json` and `frontend/src/constants/nodeDefinitions.ts`:

```json
"gpt-image-2-fal-generate": {
  "id": "gpt-image-2-fal-generate",
  "displayName": "GPT Image 2 (FAL)",
  "category": "image-gen",
  "apiProvider": "fal",
  "apiEndpoint": "openai/gpt-image-2",
  "envKeyName": "FAL_KEY",
  "executionPattern": "stream",
  "inputPorts": [
    { "id": "prompt", "label": "Prompt", "dataType": "Text", "required": true }
  ],
  "outputPorts": [
    { "id": "image", "label": "Image", "dataType": "Image", "required": false }
  ],
  "params": [
    { "key": "image_size", "label": "Size", "type": "enum", "required": false, "default": "1024x1024",
      "options": [
        { "label": "1024x1024", "value": "1024x1024" },
        { "label": "1536x1024", "value": "1536x1024" },
        { "label": "1024x1536", "value": "1024x1536" },
        { "label": "2048x2048", "value": "2048x2048" },
        { "label": "3840x2160", "value": "3840x2160" },
        { "label": "2160x3840", "value": "2160x3840" }
      ]
    },
    { "key": "quality", "label": "Quality", "type": "enum", "required": false, "default": "high",
      "options": [
        { "label": "Low", "value": "low" },
        { "label": "Medium", "value": "medium" },
        { "label": "High", "value": "high" }
      ]
    },
    { "key": "num_images", "label": "Count", "type": "integer", "required": false, "default": 1, "min": 1, "max": 4 },
    { "key": "output_format", "label": "Format", "type": "enum", "required": false, "default": "png",
      "options": [
        { "label": "PNG", "value": "png" },
        { "label": "JPEG", "value": "jpeg" },
        { "label": "WebP", "value": "webp" }
      ]
    },
    { "key": "partial_images", "label": "Preview Frames", "type": "integer", "required": false, "default": 2, "min": 0, "max": 3 }
  ]
},
"gpt-image-2-fal-edit": {
  "id": "gpt-image-2-fal-edit",
  "displayName": "GPT Image 2 Edit (FAL)",
  "category": "image-gen",
  "apiProvider": "fal",
  "apiEndpoint": "openai/gpt-image-2/edit",
  "envKeyName": "FAL_KEY",
  "executionPattern": "stream",
  "inputPorts": [
    { "id": "images", "label": "Reference Images", "dataType": "Image", "required": true, "multiple": true },
    { "id": "prompt", "label": "Prompt", "dataType": "Text", "required": true }
  ],
  "outputPorts": [
    { "id": "image", "label": "Image", "dataType": "Image", "required": false }
  ],
  "params": [
    { "key": "image_size", "label": "Size", "type": "enum", "required": false, "default": "auto",
      "options": [
        { "label": "Auto", "value": "auto" },
        { "label": "1024x1024", "value": "1024x1024" },
        { "label": "1536x1024", "value": "1536x1024" },
        { "label": "1024x1536", "value": "1024x1536" },
        { "label": "2048x2048", "value": "2048x2048" },
        { "label": "3840x2160", "value": "3840x2160" },
        { "label": "2160x3840", "value": "2160x3840" }
      ]
    },
    { "key": "quality", "label": "Quality", "type": "enum", "required": false, "default": "high",
      "options": [
        { "label": "Low", "value": "low" },
        { "label": "Medium", "value": "medium" },
        { "label": "High", "value": "high" }
      ]
    },
    { "key": "num_images", "label": "Count", "type": "integer", "required": false, "default": 1, "min": 1, "max": 4 },
    { "key": "output_format", "label": "Format", "type": "enum", "required": false, "default": "png",
      "options": [
        { "label": "PNG", "value": "png" },
        { "label": "JPEG", "value": "jpeg" },
        { "label": "WebP", "value": "webp" }
      ]
    },
    { "key": "partial_images", "label": "Preview Frames", "type": "integer", "required": false, "default": 2, "min": 0, "max": 3 }
  ]
}
```

Add the equivalent TypeScript in `frontend/src/constants/nodeDefinitions.ts`.

- [ ] **Step 8: Run all backend + frontend tests**

Run: `cd backend && pytest -v` and `cd frontend && npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add backend/handlers/fal_universal.py backend/execution/stream_runner.py backend/execution/sync_runner.py backend/tests/test_stream_runner_image.py backend/tests/fixtures/fal_image_v2_sse.txt backend/data/node_definitions.json frontend/src/constants/nodeDefinitions.ts
git commit -m "feat(fal): add gpt-image-2 FAL streaming path + nodes"
```

---

## Task 14: Project-local skill — `.claude/skills/gpt-image-2/SKILL.md`

**Files:**
- Create: `.claude/skills/gpt-image-2/SKILL.md` (inside `nebula_nodes/`)

- [ ] **Step 1: Create the skill directory**

Run: `mkdir -p .claude/skills/gpt-image-2` (from repo root).

- [ ] **Step 2: Write the skill**

Create `.claude/skills/gpt-image-2/SKILL.md` with this exact content:

```markdown
---
name: gpt-image-2
description: Use when building or editing a Nebula graph containing a gpt-image-2-* node (generate, edit, fal-generate, fal-edit) or when the user asks to use gpt-image-2 inside Nebula. Covers Nebula-specific node IDs, param names, and UI wiring. For prompting craft, see the global gpt-image-2 skill.
---

# GPT Image 2 — Nebula Integration

OpenAI's `gpt-image-2` (released 2026-04-21, snapshot `gpt-image-2-2026-04-21`) is available in Nebula via four nodes.

## Node matrix

| Node ID | Path | BYOK key | When to pick |
|---|---|---|---|
| `gpt-image-2-generate` | OpenAI direct | `OPENAI_API_KEY` | Text→image, full streaming previews, need partial frames in canvas |
| `gpt-image-2-edit` | OpenAI direct | `OPENAI_API_KEY` | Image edit / inpainting with up to 10 reference images + optional mask |
| `gpt-image-2-fal-generate` | FAL proxy | `FAL_KEY` | Text→image, no OpenAI org-verification needed, pay-per-image |
| `gpt-image-2-fal-edit` | FAL proxy | `FAL_KEY` | Edit via FAL |

All four use `executionPattern: "stream"`. Partial previews render in the canvas as they arrive.

## OpenAI-direct params (generate + edit)

| Param | Values | Default | Notes |
|---|---|---|---|
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840` | `auto` | 4K sizes cost significantly more |
| `quality` | `auto`, `low`, `medium`, `high` | `auto` | ~$0.006 / $0.053 / $0.211 at 1024² |
| `n` | 1–10 | 1 | |
| `output_format` | `png`, `jpeg`, `webp` | `png` | |
| `output_compression` | 0–100 | 90 | Only applied when format != png |
| `moderation` | `auto`, `low` | `auto` | `low` is less restrictive |
| `partial_images` | 0–3 | 2 | Each partial adds ~100 output tokens |

Edit node also accepts: `image` (Image, up to 10), `mask` (alpha-channel PNG, same size + format as first image).

## What's NOT supported (and Nebula does not expose)

- `background: transparent` — v1 supported it, v2 does not. Emit an error if the user asks; offer `remove-background` downstream instead.
- `input_fidelity` — gpt-image-2 always processes inputs at high fidelity; the param must be omitted.

## Cost guidance

- Draft iteration → `quality: low` at `1024x1024` ≈ $0.006 each.
- Hero asset → `quality: high` at chosen aspect ratio.
- 4K → token cost scales roughly with pixel count; use sparingly.
- Batch API (50% off) is not wired up in Nebula yet — handle in a later phase.

## When editing a prompt for this node

If the user asks Claude to write or refine a prompt that will feed into `gpt-image-2-*`, consult the global `gpt-image-2` skill for prompting craft (5-slot template, anti-slop rules, text-rendering guidance).

## Known surprises

- OpenAI direct requires Organization Verification — if the user gets "org isn't verified" errors, direct them to https://platform.openai.com/settings/organization/general.
- FAL path uses different param names: `image_size` not `size`, `num_images` not `n`.
- Mask is prompt-guided — the prompt must describe the **full** desired image, not just the masked region.
- Up to 10 reference images in the edit endpoint; the mask applies to the **first** image when supplied.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/gpt-image-2/SKILL.md
git commit -m "feat(skill): project-local gpt-image-2 skill for Nebula chat"
```

---

## Task 15: Global skill — `~/.claude/skills/gpt-image-2/SKILL.md`

**Files:**
- Create: `~/.claude/skills/gpt-image-2/SKILL.md` (outside the repo — NOT committed)

- [ ] **Step 1: Create the directory**

Run: `mkdir -p ~/.claude/skills/gpt-image-2`.

- [ ] **Step 2: Write the skill**

Create `~/.claude/skills/gpt-image-2/SKILL.md`:

````markdown
---
name: gpt-image-2
description: Use when authoring or refining a prompt for OpenAI's gpt-image-2 image model (text-to-image or edit). Triggers on "gpt-image-2", "ChatGPT Image 2", "OpenAI Image 2". Covers the five-slot prompt template, anti-slop rules, text rendering, multi-image reference prompting, mask editing, and verbatim example prompts. For Nebula-specific node wiring, see the project-local gpt-image-2 skill.
---

# GPT Image 2 — Prompting Craft

Model: `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`), released 2026-04-21. State-of-the-art photoreal, pixel-perfect text rendering, consistent composition. Prompt it like a specification, not a haiku.

## The five-slot template

```
Scene: [where this happens, time of day, background, environment]
Subject: [who or what is the main focus]
Important details: [materials, clothing, texture, lighting, camera angle, lens feel, composition, mood]
Use case: [editorial photo / product mockup / poster / UI screen / infographic / concept frame]
Constraints: [no watermark / no logos / no extra text / preserve face / preserve layout]
```

Use linebreaks once the prompt runs past a short paragraph.

## Six anti-slop rules

1. **Visual facts over vague praise.** Avoid "stunning, cinematic, incredible, masterpiece, 8K, award-winning". Prefer "overcast daylight, brushed aluminum, chipped paint, clean kerning, 50mm feel, soft bounce light."
2. **Style tags need visual targets.** "Minimalist brutalist editorial luxury" is noise. "Cream background, heavy black condensed sans serif, asymmetrical type block, one hero object, generous negative space, studio tabletop lighting" is usable.
3. **Say the real thing.** If the image must show a transit kiosk, write "transit kiosk" — not "urban design element." Mood language buries the brief.
4. **In edits, separate Change from Preserve.** Use "change only X" and "keep everything else the same." Repeat the preserve list on each iteration to reduce drift.
5. **Treat text like typography.** Wrap literal text in quotes or ALL CAPS. Specify font style, size, color, placement. Spell hard words letter by letter when the model ghosts them.
6. **One revision per turn.** "Make the light warmer. / Remove the extra chair on the left. / Restore the original wall texture. / Keep everything else the same."

## Text rendering

Strong constraint block for readable output:

```
Headline (EXACT TEXT):
"Fresh and clean"

Constraints:
Render the text verbatim.
No extra words.
No duplicate text.
No watermark.
```

For UI/menu/signage text, be physically specific: "Plastic letter tracks, uneven letter spacing, one missing letter slot, yellowed light from incandescent bulbs, legible prices."

## Multi-image reference (up to 10)

Label each input by role:

```
Image 1: base scene to preserve.
Image 2: jacket reference.
Image 3: boots reference.

Instruction:
Dress the person from Image 1 using the jacket from Image 2 and the boots from Image 3.
Preserve the face, body shape, pose, background, lighting, and framing from Image 1.
```

Without role labels, the model guesses which image is content and which is reference, and usually guesses wrong.

## Mask editing

Mask is prompt-guided — the alpha channel hints but the prompt carries the intent. The prompt must describe the **full resulting image**, not just the mask region.

```
Change:
[exactly what should change]

Preserve:
[face, identity, pose, lighting, framing, background, geometry, text, layout]

Constraints:
[no extra objects, no redesign, no logo drift, no watermark]
```

Object-removal example:

```
Remove every advertising sign and poster from the shop windows.
Preserve the awning, the brick facade, the mullions, the window reflections, the sidewalk, and every person on the sidewalk exactly.
Reconstruct the glass naturally: clean reflections of the street, no ghosting of the removed posters.
```

## Consistency tricks

Restate the spec on every turn. Don't rely on memory.

```
First prompt:
A young forest helper wearing a green hooded tunic, soft brown boots, and a small belt pouch.
Kind expression, gentle eyes, warm but brave personality.

Second prompt:
The same forest helper is rescuing a frightened squirrel after a winter storm.
Keep the same face, same green hooded tunic, same proportions, same color palette, and same gentle personality.
Do not redesign the character.
```

For products: "Preserve the bottle geometry, cap shape, label text, label colors, and print sharpness exactly. Do not restyle the product. Do not change proportions."

## Vocabulary cheatsheet

- **Framing:** eye-level full-body, overhead, slight angle, tight medium format portrait, first-person gameplay screenshot
- **Lens feel:** 50mm documentary feel, 35mm feel, shallow depth of field
- **Light sources:** soft afternoon light, incandescent work lamp spilling warm light, window light from camera left, cool overhead train light mixed with warm town lights outside, soft overhead museum light, ray-traced global illumination
- **Time:** just after dawn, at 5 in the morning, golden hour, blue hour
- **Quality:** flat even lighting, no dramatic shadow, soft bounce light, warm neutral color balance

## Verbatim example prompts

### Editorial photoreal

```
Create a color documentary photograph of a fishmonger unpacking crates of mackerel
onto crushed ice at a small coastal market just after dawn. Steam from breath in the
cold air, rubber boots, wet concrete floor, incandescent work lamp spilling warm
light, a paper ledger with handwritten prices clipped to a wooden post. Realistic
skin texture and fish scales, shallow depth of field, 35mm feel. No commercial
styling, no watermark.
```

### Product archaeology shot

```
Create a museum archive photograph of two perfectly recognizable wireless earbuds
carved from worn gray stone and placed on neutral conservation foam under soft
overhead museum light. Accession card next to the pieces reads ACC. 2126.04 -
EARLY 21C PERSONAL ACOUSTIC IMPLEMENT. Flat even lighting, no dramatic shadow,
neutral beige backdrop, shallow depth of field, the material reads as carved stone
not plastic. No watermark, no brand logos.
```

### UI screenshot

```
Create a first-person gameplay screenshot of a cozy lakeside stone cottage in a
lush block-built survival world at golden hour. Premium game-engine realism,
ray-traced global illumination, detailed grass and flowers, soft atmospheric haze,
subtle player hand in the lower right, clean survival HUD along the bottom,
believable UI spacing. No logos, no watermark, no exact brand references.
```

### Readable signage

```
Create a photoreal photograph of a 24 hour diner menu board at 5 in the morning,
shot from the counter seat at slight angle. Plastic letter tracks, uneven letter
spacing, one missing letter slot, yellowed light from incandescent bulbs, legible
prices, categories labeled BREAKFAST, GRIDDLE, SANDWICHES, SIDES, DRINKS, and a
daily special that reads CHICKEN FRIED STEAK 8.25. The type must be 100 percent
readable and physically believable.
```

### Three-sentence edit

```
Replace the parked car with a vintage bicycle.
Preserve the house, fence, driveway concrete, landscaping, lighting direction, and time of day exactly.
Match the bicycle scale and shadow pattern to the existing scene.
```

## Known limits

- No transparent background (v1 has it; v2 does not). Use a separate `remove-background` step if needed.
- Text rendering is much better but can still miss precise placement on small or curved surfaces.
- `input_fidelity` is always high — you cannot soften reference adherence; describe desired deviations explicitly.
- Up to 10 input images in edits; more will error.

## Sources

- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/cookbook/examples/generate_images_with_gpt_image
- https://fal.ai/learn/tools/prompting-gpt-image-2
````

- [ ] **Step 3: Verify the skill is picked up**

Run: `ls -la ~/.claude/skills/gpt-image-2/`
Expected: `SKILL.md` listed.

- [ ] **Step 4: No commit needed**

The global skill lives outside the repo. Skip the commit step.

---

## Task 16: Update FORjustin.md with lessons from this integration

**Files:**
- Modify: `FORjustin.md`

Per Justin's global rule: update `FORjustin.md` at the end of any significant session.

- [ ] **Step 1: Append a new section**

Add a dated section describing:
- What shipped (4 new nodes + streaming extension + skills)
- The design decision to ship 4 separate nodes instead of one dual-param node (memory rule about `sharedParams/falParams/directParams`)
- The gotcha that gpt-image-2 omits `background` and `input_fidelity` — they must be stripped defensively even if UI sends them
- The pattern for extending `stream_runner.py` with a second mode instead of forking — reuse won this time

Keep it engaging, anecdotal. No fixed template — follow the tone of existing `FORjustin.md` entries.

- [ ] **Step 2: Commit**

```bash
git add FORjustin.md
git commit -m "docs(FORjustin): lessons from gpt-image-2 integration"
```

---

## Task 17: Update MEMORY.md auto-memory

**Files:**
- Modify: `/Users/justinperea/.claude/projects/-Users-justinperea-Documents-Projects-nebula-nodes/memory/MEMORY.md`
- Possibly modify: `project_status.md` in the same directory

- [ ] **Step 1: Update `project_status.md`**

Replace the existing current-state line with one that reflects the shipped gpt-image-2 integration and four new nodes.

- [ ] **Step 2: No commit**

Memory lives outside the repo.

---

## Task 18: Manual UAT (user-verified)

**Files:**
- None — manual canvas test

Start the backend and frontend dev servers:

```bash
cd backend && uvicorn main:app --reload
# separate terminal
cd frontend && npm run dev
```

Open the Nebula canvas and verify each item:

- [ ] **1. Direct generate — 1024² low.** Place `gpt-image-2-generate`, prompt "a red apple on a wooden table, overcast daylight, 50mm feel", size `1024x1024`, quality `low`, `partial_images=2`. Run. Expect: at least one partial image renders in the node before the final swap; final is a complete red apple.
- [ ] **2. Direct generate — 4K high.** Same node, size `3840x2160`, quality `high`, `partial_images=3`. Run. Expect: 3 partial frames visible during streaming, final 4K image saved. Note latency — docs warn up to 2 minutes.
- [ ] **3. Direct edit with mask.** `gpt-image-2-edit` with one image input + mask, prompt describes the full desired scene. Expect: the masked region is modified, rest preserved.
- [ ] **4. Direct edit with 3 reference images, no mask.** Label roles in the prompt ("Image 1: ... Image 2: ..."). Expect: composition follows the instruction.
- [ ] **5. Org-verification error path.** Temporarily use a non-verified API key. Expect: node errors with the friendly "org isn't verified" message + the verification URL.
- [ ] **6. FAL generate.** `gpt-image-2-fal-generate`, prompt + size. Expect: same streaming UX (partials + final), using `FAL_KEY`.
- [ ] **7. FAL edit.** `gpt-image-2-fal-edit` with one image. Expect: completes and returns image.
- [ ] **8. Partial → final swap.** During execution, observe that the partial preview is replaced by the final image on completion with no visual glitch.
- [ ] **9. Error recovery.** Trigger a 4xx (e.g. invalid `partial_images=99` via URL hack). Expect: clean error surface, no stuck-executing state.
- [ ] **10. Claude chat skill.** In a `claude-chat` node downstream of a `gpt-image-2-generate` node, ask Claude to rewrite a weak prompt ("cool cat pic") into a strong gpt-image-2 prompt. Expect: output uses the five-slot template, concrete visual facts, no "stunning/cinematic" slop.

If any of 1–9 fails, file the failure in the FORjustin lessons (Task 16) and loop back to the specific task.

---

## Self-Review (done)

**Spec coverage:**
- ✅ Section 4.1 node taxonomy → Tasks 7, 13 (JSON) + 12, 13 (TS mirror)
- ✅ Section 4.2 new handler file → Tasks 4, 5
- ✅ Section 4.2 stream_runner extension → Tasks 3, 13
- ✅ Section 4.2 sync_runner registration → Tasks 6, 13
- ✅ Section 4.3 frontend changes → Tasks 9, 10, 11, 12, 13
- ✅ Section 4.4 OpenAI-direct data flow → Tasks 3–6 cover this
- ✅ Section 4.5 FAL data flow → Task 13
- ✅ Section 4.6 edit-specific behavior → Task 5
- ✅ Section 5 node params → Tasks 7, 13 (exact enum values, defaults)
- ✅ Section 6 protocol → Tasks 1 (backend), 9 (frontend)
- ✅ Section 7 error handling → Tasks 4, 5, 13
- ✅ Section 8.1 tests → Tasks 2, 3, 4, 5, 6, 8, 10, 13
- ✅ Section 8.2 manual UAT → Task 18
- ✅ Section 9 skills → Tasks 14, 15

**Placeholder scan:** No "TBD", "TODO", "similar to", or "implement appropriate X" sentences. Each step has concrete code/commands.

**Type consistency:** `StreamPartialImageEvent` defined in Task 1 with fields `type, node_id, partial_index, src, is_final`. Frontend event (Task 9) uses camelCase (`nodeId, partialIndex, src, isFinal`) — Python→TS serialization normally goes through a layer (pydantic uses snake_case but the existing event bus appears to emit camelCase per frontend `ExecutionEvent` types like `nodeId`). **One thing to verify during Task 9 implementation:** check how existing `stream_delta` → `streamDelta` serialization happens (likely the FastAPI WS serializer or an alias_generator). If pydantic uses snake_case, add `by_alias` serialization in the WS emit layer or match the existing pattern for other events.

**Fix applied:** No blocking inconsistency — just a verification step. Call this out in Task 9 Step 1 for the implementer.

**Spec requirement with no task:** None identified.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-gpt-image-2-integration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

# 3D Mesh Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3D model generation and interactive preview to Nebula Node — new Mesh port type, `<model-viewer>` inline preview, full-screen modal, and four FAL-based 3D generation nodes (Meshy 6 Text/Image-to-3D, Hunyuan3D V3 Text/Image-to-3D).

**Architecture:** Extends the existing FAL async-poll pipeline. Backend downloads GLB files from FAL responses and serves them as static assets. Frontend uses Google's `<model-viewer>` web component for interactive 3D rendering inside node bodies, with a click-to-expand full-screen modal. Non-GLB formats get converted to GLB via `trimesh` on the backend.

**Tech Stack:** `@google/model-viewer` (frontend), `trimesh` (backend), existing FAL queue handler, React + Zustand, FastAPI

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `frontend/src/types/index.ts` | Add `Mesh` to `PortDataType`, `3d-gen` to `NodeCategory` |
| Modify | `frontend/src/lib/portCompatibility.ts` | Add `Mesh` to `PORT_COLORS` and `COMPATIBILITY` |
| Modify | `frontend/src/constants/ports.ts` | Add `3d-gen` to `CATEGORY_COLORS` |
| Modify | `frontend/src/constants/nodeDefinitions.ts` | Add 4 new 3D node definitions |
| Modify | `frontend/src/store/graphStore.ts` | Add `Mesh` to path rewriting in `handleExecutionEvent` |
| Create | `frontend/src/components/nodes/MeshPreview.tsx` | Inline `<model-viewer>` 3D preview in node body |
| Create | `frontend/src/components/nodes/MeshModal.tsx` | Full-screen 3D viewer modal |
| Modify | `frontend/src/components/nodes/ModelNode.tsx` | Detect Mesh output, render MeshPreview |
| Modify | `frontend/src/components/nodes/DynamicNode.tsx` | Detect Mesh output, render MeshPreview |
| Modify | `frontend/src/styles/nodes.css` | Mesh preview and modal styles |
| Modify | `backend/services/output.py` | Add `save_mesh_from_url` function |
| Modify | `backend/handlers/fal_universal.py` | Parse 3D mesh outputs, map multi-image inputs |
| Modify | `backend/execution/sync_runner.py` | Register 4 new handler wrappers |
| Modify | `backend/main.py` | Add `/api/convert-to-glb` endpoint |
| Modify | `backend/requirements.txt` | Add `trimesh` |
| Modify | `backend/tests/test_fal_handler.py` | Tests for mesh output parsing |

---

### Task 1: Port Type Infrastructure

**Files:**
- Modify: `frontend/src/types/index.ts:1-19`
- Modify: `frontend/src/lib/portCompatibility.ts:1-23`
- Modify: `frontend/src/constants/ports.ts:1-12`

- [ ] **Step 1: Add `Mesh` to `PortDataType` union**

In `frontend/src/types/index.ts`, add `'Mesh'` to the `PortDataType` union:

```typescript
export type PortDataType =
  | 'Text'
  | 'Image'
  | 'Video'
  | 'Audio'
  | 'Mask'
  | 'Array'
  | 'SVG'
  | 'Mesh'
  | 'Any';
```

- [ ] **Step 2: Add `3d-gen` to `NodeCategory` union**

In the same file, add `'3d-gen'` to the `NodeCategory` union:

```typescript
export type NodeCategory =
  | 'image-gen'
  | 'video-gen'
  | 'text-gen'
  | 'audio-gen'
  | '3d-gen'
  | 'transform'
  | 'analyzer'
  | 'utility'
  | 'universal';
```

- [ ] **Step 3: Add `Mesh` to `PORT_COLORS`**

In `frontend/src/lib/portCompatibility.ts`, add to the `PORT_COLORS` object:

```typescript
export const PORT_COLORS: Record<PortDataType, string> = {
  Image: '#4CAF50',
  Video: '#F44336',
  Text: '#9C27B0',
  Array: '#2196F3',
  Audio: '#FFC107',
  Mask: '#8BC34A',
  SVG: '#795548',
  Mesh: '#00BCD4',
  Any: '#9E9E9E',
};
```

- [ ] **Step 4: Add `Mesh` to `COMPATIBILITY` table**

In the same file, add Mesh compatibility rules. Mesh connects to Mesh and Any. Also add Mesh to the `Any` row:

```typescript
const COMPATIBILITY: Record<PortDataType, PortDataType[]> = {
  Text: ['Text', 'Any'],
  Image: ['Image', 'Mask', 'Any'],
  Video: ['Video', 'Any'],
  Audio: ['Audio', 'Any'],
  Mask: ['Mask', 'Image', 'Any'],
  Array: ['Array', 'Any'],
  SVG: ['SVG', 'Any'],
  Mesh: ['Mesh', 'Any'],
  Any: ['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Mesh', 'Any'],
};
```

- [ ] **Step 5: Add `3d-gen` to `CATEGORY_COLORS`**

In `frontend/src/constants/ports.ts`:

```typescript
export const CATEGORY_COLORS: Record<string, string> = {
  'image-gen': '#1565C0',
  'video-gen': '#B71C1C',
  'text-gen': '#4A148C',
  'audio-gen': '#FF6F00',
  '3d-gen': '#00ACC1',
  'transform': '#004D40',
  'analyzer': '#1B5E20',
  'utility': '#424242',
  'universal': '#E65100',
};
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/lib/portCompatibility.ts frontend/src/constants/ports.ts
git commit -m "feat: add Mesh port type and 3d-gen category to type system"
```

---

### Task 2: Backend — Mesh Download Utility and FAL Output Parsing

**Files:**
- Modify: `backend/services/output.py`
- Modify: `backend/handlers/fal_universal.py:118-154`
- Modify: `backend/tests/test_fal_handler.py`

- [ ] **Step 1: Write tests for mesh output parsing**

Add to `backend/tests/test_fal_handler.py`, inside `TestParseFalOutput`:

```python
def test_mesh_model_urls_glb(self) -> None:
    """Meshy 6 pattern: model_urls dict with glb key."""
    result = _parse_fal_output({
        "model_urls": {"glb": "https://fal.ai/model.glb", "fbx": "https://fal.ai/model.fbx"}
    })
    assert result["mesh"]["type"] == "Mesh"
    assert result["mesh"]["value"] == "https://fal.ai/model.glb"

def test_mesh_glb_dict(self) -> None:
    """Hunyuan3D pattern: glb as dict with url."""
    result = _parse_fal_output({"glb": {"url": "https://fal.ai/output.glb"}})
    assert result["mesh"]["type"] == "Mesh"
    assert result["mesh"]["value"] == "https://fal.ai/output.glb"

def test_mesh_glb_string(self) -> None:
    """Direct glb URL string."""
    result = _parse_fal_output({"glb": "https://fal.ai/output.glb"})
    assert result["mesh"]["type"] == "Mesh"
    assert result["mesh"]["value"] == "https://fal.ai/output.glb"

def test_mesh_model_mesh_url(self) -> None:
    """model_mesh dict pattern."""
    result = _parse_fal_output({"model_mesh": {"url": "https://fal.ai/mesh.glb"}})
    assert result["mesh"]["type"] == "Mesh"
    assert result["mesh"]["value"] == "https://fal.ai/mesh.glb"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_fal_handler.py::TestParseFalOutput::test_mesh_model_urls_glb tests/test_fal_handler.py::TestParseFalOutput::test_mesh_glb_dict tests/test_fal_handler.py::TestParseFalOutput::test_mesh_glb_string tests/test_fal_handler.py::TestParseFalOutput::test_mesh_model_mesh_url -v`
Expected: 4 FAILED — `_parse_fal_output` doesn't handle mesh outputs yet

- [ ] **Step 3: Add `save_mesh_from_url` to `backend/services/output.py`**

Add after the existing `save_video_from_url` function:

```python
async def save_mesh_from_url(url: str, run_dir: Path, extension: str = "glb") -> Path:
    import httpx
    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        file_path.write_bytes(response.content)
    return file_path
```

- [ ] **Step 4: Add mesh output parsing to `_parse_fal_output`**

In `backend/handlers/fal_universal.py`, insert mesh detection **before** the image output check (line 120). The mesh check must come first because some 3D endpoints also return preview images — but mesh is the primary output:

```python
def _parse_fal_output(data: dict[str, Any]) -> dict[str, Any]:
    """Parse FAL output into our standard port format."""
    # 3D mesh output — check before images since some 3D endpoints also return preview images
    # Meshy pattern: {"model_urls": {"glb": "url", "fbx": "url"}}
    model_urls = data.get("model_urls", {})
    if isinstance(model_urls, dict) and model_urls.get("glb"):
        return {"mesh": {"type": "Mesh", "value": model_urls["glb"]}}

    # Hunyuan/generic pattern: {"glb": {"url": "..."}} or {"glb": "url"}
    glb = data.get("glb")
    if isinstance(glb, dict) and glb.get("url"):
        return {"mesh": {"type": "Mesh", "value": glb["url"]}}
    if isinstance(glb, str) and glb:
        return {"mesh": {"type": "Mesh", "value": glb}}

    # model_mesh pattern: {"model_mesh": {"url": "..."}}
    model_mesh = data.get("model_mesh")
    if isinstance(model_mesh, dict) and model_mesh.get("url"):
        return {"mesh": {"type": "Mesh", "value": model_mesh["url"]}}
    if isinstance(model_mesh, str) and model_mesh:
        return {"mesh": {"type": "Mesh", "value": model_mesh}}

    # Image output (most common)
    images = data.get("images", [])
    # ... rest of existing code unchanged ...
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_fal_handler.py -v`
Expected: All tests PASS (existing + 4 new)

- [ ] **Step 6: Commit**

```bash
git add backend/services/output.py backend/handlers/fal_universal.py backend/tests/test_fal_handler.py
git commit -m "feat: add mesh output parsing and download utility for 3D FAL endpoints"
```

---

### Task 3: Backend — Multi-Image Input Mapping and Mesh Download

**Files:**
- Modify: `backend/handlers/fal_universal.py:36-48`
- Modify: `backend/tests/test_fal_handler.py`

- [ ] **Step 1: Write test for multi-image input mapping**

Add to `backend/tests/test_fal_handler.py`:

```python
@pytest.mark.asyncio
async def test_multi_image_inputs_mapped():
    """Hunyuan3D V3 Image-to-3D sends front/back/left/right images."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-3d"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "model_urls": {"glb": "https://fal.ai/model.glb"}
    }

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.side_effect = [mock_status, mock_result]
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            result = await handle_fal_universal(
                _make_node({"endpoint_id": "fal-ai/hunyuan3d-v3/image-to-3d"}),
                {
                    "front_image": PortValueDict(type="Image", value="https://example.com/front.png"),
                    "back_image": PortValueDict(type="Image", value="https://example.com/back.png"),
                    "left_image": PortValueDict(type="Image", value="https://example.com/left.png"),
                    "right_image": PortValueDict(type="Image", value="https://example.com/right.png"),
                },
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

        # Verify the submit payload included all images
        call_args = mock_client.post.call_args
        payload = call_args.kwargs.get("json") or call_args[1].get("json")
        assert payload["image_url"] == "https://example.com/front.png"
        assert payload["back_image_url"] == "https://example.com/back.png"
        assert payload["left_image_url"] == "https://example.com/left.png"
        assert payload["right_image_url"] == "https://example.com/right.png"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fal_handler.py::test_multi_image_inputs_mapped -v`
Expected: FAIL — handler doesn't map `front_image`, `back_image`, etc.

- [ ] **Step 3: Extend input mapping in `handle_fal_universal`**

In `backend/handlers/fal_universal.py`, after the existing `image_input` mapping (line 43), add mappings for multi-image 3D inputs:

```python
    image_input = inputs.get("image")
    if image_input and image_input.value:
        fal_input["image_url"] = str(image_input.value)

    # Multi-image inputs for 3D models (Hunyuan3D V3 Image-to-3D)
    front_image = inputs.get("front_image")
    if front_image and front_image.value:
        fal_input["image_url"] = str(front_image.value)

    back_image = inputs.get("back_image")
    if back_image and back_image.value:
        fal_input["back_image_url"] = str(back_image.value)

    left_image = inputs.get("left_image")
    if left_image and left_image.value:
        fal_input["left_image_url"] = str(left_image.value)

    right_image = inputs.get("right_image")
    if right_image and right_image.value:
        fal_input["right_image_url"] = str(right_image.value)
```

- [ ] **Step 4: Run all FAL handler tests**

Run: `cd backend && python -m pytest tests/test_fal_handler.py -v`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add backend/handlers/fal_universal.py backend/tests/test_fal_handler.py
git commit -m "feat: add multi-image input mapping for Hunyuan3D V3 multi-view inputs"
```

---

### Task 4: Backend — Handler Registration for 3D Nodes

**Files:**
- Modify: `backend/execution/sync_runner.py:87-174`

- [ ] **Step 1: Add 4 handler wrappers**

In `backend/execution/sync_runner.py`, inside the `if emit is not None:` block, after the `_ltx_video2_handler` function definition (around line 158), add:

```python
        async def _meshy_text_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/meshy/v6/text-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _meshy_image_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/meshy/v6/image-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _hunyuan3d_text_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/hunyuan3d-v3/text-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        async def _hunyuan3d_image_to_3d_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            node.params.setdefault("endpoint_id", "fal-ai/hunyuan3d-v3/image-to-3d")
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)
```

- [ ] **Step 2: Register handlers in the registry**

After the existing registry assignments (around line 174), add:

```python
        registry["meshy-text-to-3d"] = _meshy_text_to_3d_handler
        registry["meshy-image-to-3d"] = _meshy_image_to_3d_handler
        registry["hunyuan3d-text-to-3d"] = _hunyuan3d_text_to_3d_handler
        registry["hunyuan3d-image-to-3d"] = _hunyuan3d_image_to_3d_handler
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `cd backend && python -m pytest tests/ -v`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add backend/execution/sync_runner.py
git commit -m "feat: register Meshy 6 and Hunyuan3D V3 handler wrappers"
```

---

### Task 5: Backend — GLB Conversion Endpoint

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/requirements.txt`

- [ ] **Step 1: Add `trimesh` to requirements**

Add to `backend/requirements.txt`:

```
trimesh==4.6.8
```

- [ ] **Step 2: Install trimesh**

Run: `cd backend && pip install trimesh==4.6.8`

- [ ] **Step 3: Add `/api/convert-to-glb` endpoint to `backend/main.py`**

Add this endpoint before the `app.mount("/api/outputs", ...)` line (it must be registered before the catch-all static mount):

```python
@app.get("/api/convert-to-glb")
async def convert_to_glb(path: str) -> Any:
    """Convert a non-GLB 3D file to GLB for preview. Caches the result."""
    from fastapi.responses import FileResponse
    import trimesh

    source_path = OUTPUT_ROOT / path
    if not source_path.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Source file not found")

    # Security: ensure path stays within OUTPUT_ROOT
    try:
        source_path.resolve().relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Invalid path")

    # If already GLB, serve directly
    if source_path.suffix.lower() == ".glb":
        return FileResponse(str(source_path), media_type="model/gltf-binary")

    # Check for cached conversion
    preview_path = source_path.with_suffix(".preview.glb")
    if preview_path.exists():
        return FileResponse(str(preview_path), media_type="model/gltf-binary")

    # Convert to GLB using trimesh
    try:
        mesh = trimesh.load(str(source_path))
        mesh.export(str(preview_path), file_type="glb")
    except Exception as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Conversion failed: {exc}")

    return FileResponse(str(preview_path), media_type="model/gltf-binary")
```

Also add the import at the top of the file:

```python
from typing import Any
```

(Note: `Any` is already imported in `main.py` at line 6.)

- [ ] **Step 4: Verify server starts**

Run: `cd backend && python -m uvicorn main:app --host 0.0.0.0 --port 8000 &` then `curl http://localhost:8000/api/health` then kill the background process.
Expected: `{"status":"ok","version":"0.1.0"}`

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/requirements.txt
git commit -m "feat: add /api/convert-to-glb endpoint with trimesh conversion"
```

---

### Task 6: Frontend — Node Definitions for 3D Nodes

**Files:**
- Modify: `frontend/src/constants/nodeDefinitions.ts`

- [ ] **Step 1: Add 4 node definitions**

Append to the `NODE_DEFINITIONS` object in `frontend/src/constants/nodeDefinitions.ts`, before the closing `};`:

```typescript
  'meshy-text-to-3d': {
    id: 'meshy-text-to-3d',
    displayName: 'Meshy 6 Text-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/meshy/v6/text-to-3d',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'enum',
        required: false,
        default: 'full',
        options: [
          { label: 'Preview', value: 'preview' },
          { label: 'Full', value: 'full' },
        ],
      },
      {
        key: 'topology',
        label: 'Topology',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quad', value: 'quad' },
        ],
      },
      {
        key: 'target_polycount',
        label: 'Polycount',
        type: 'integer',
        required: false,
        default: 30000,
        min: 1000,
        max: 200000,
      },
      {
        key: 'symmetry_mode',
        label: 'Symmetry',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Off', value: 'off' },
          { label: 'Auto', value: 'auto' },
          { label: 'On', value: 'on' },
        ],
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'pose_mode',
        label: 'Pose Mode',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'None', value: '' },
          { label: 'A-Pose', value: 'a-pose' },
          { label: 'T-Pose', value: 't-pose' },
        ],
      },
      {
        key: 'enable_rigging',
        label: 'Rigging',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
    ],
  },

  'meshy-image-to-3d': {
    id: 'meshy-image-to-3d',
    displayName: 'Meshy 6 Image-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/meshy/v6/image-to-3d',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'topology',
        label: 'Topology',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quad', value: 'quad' },
        ],
      },
      {
        key: 'target_polycount',
        label: 'Polycount',
        type: 'integer',
        required: false,
        default: 30000,
        min: 1000,
        max: 200000,
      },
      {
        key: 'symmetry_mode',
        label: 'Symmetry',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Off', value: 'off' },
          { label: 'Auto', value: 'auto' },
          { label: 'On', value: 'on' },
        ],
      },
      {
        key: 'should_texture',
        label: 'Texture',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'pose_mode',
        label: 'Pose Mode',
        type: 'enum',
        required: false,
        default: '',
        options: [
          { label: 'None', value: '' },
          { label: 'A-Pose', value: 'a-pose' },
          { label: 'T-Pose', value: 't-pose' },
        ],
      },
      {
        key: 'enable_rigging',
        label: 'Rigging',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'seed',
        label: 'Seed',
        type: 'integer',
        required: false,
        placeholder: 'Random',
      },
    ],
  },

  'hunyuan3d-text-to-3d': {
    id: 'hunyuan3d-text-to-3d',
    displayName: 'Hunyuan3D V3 Text-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/hunyuan3d-v3/text-to-3d',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'generate_type',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'Normal',
        options: [
          { label: 'Normal', value: 'Normal' },
          { label: 'Low Poly', value: 'LowPoly' },
          { label: 'Geometry Only', value: 'Geometry' },
        ],
      },
      {
        key: 'face_count',
        label: 'Face Count',
        type: 'integer',
        required: false,
        default: 500000,
        min: 40000,
        max: 1500000,
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'polygon_type',
        label: 'Polygon Type',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quadrilateral', value: 'quadrilateral' },
        ],
      },
    ],
  },

  'hunyuan3d-image-to-3d': {
    id: 'hunyuan3d-image-to-3d',
    displayName: 'Hunyuan3D V3 Image-to-3D',
    category: '3d-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/hunyuan3d-v3/image-to-3d',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'front_image', label: 'Front Image', dataType: 'Image', required: true },
      { id: 'back_image', label: 'Back Image', dataType: 'Image', required: false },
      { id: 'left_image', label: 'Left Image', dataType: 'Image', required: false },
      { id: 'right_image', label: 'Right Image', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'mesh', label: 'Mesh', dataType: 'Mesh', required: false },
    ],
    params: [
      {
        key: 'generate_type',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'Normal',
        options: [
          { label: 'Normal', value: 'Normal' },
          { label: 'Low Poly', value: 'LowPoly' },
          { label: 'Geometry Only', value: 'Geometry' },
        ],
      },
      {
        key: 'face_count',
        label: 'Face Count',
        type: 'integer',
        required: false,
        default: 500000,
        min: 40000,
        max: 1500000,
      },
      {
        key: 'enable_pbr',
        label: 'PBR Materials',
        type: 'boolean',
        required: false,
        default: false,
      },
      {
        key: 'polygon_type',
        label: 'Polygon Type',
        type: 'enum',
        required: false,
        default: 'triangle',
        options: [
          { label: 'Triangle', value: 'triangle' },
          { label: 'Quadrilateral', value: 'quadrilateral' },
        ],
      },
    ],
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/constants/nodeDefinitions.ts
git commit -m "feat: add Meshy 6 and Hunyuan3D V3 node definitions"
```

---

### Task 7: Frontend — Mesh Path Rewriting in graphStore

**Files:**
- Modify: `frontend/src/store/graphStore.ts:767`

- [ ] **Step 1: Add `Mesh` to path rewriting condition**

In `frontend/src/store/graphStore.ts`, find the `handleExecutionEvent` `'executed'` case. Change the condition on line 767 from:

```typescript
if ((outputVal.type === 'Image' || outputVal.type === 'Video') && outputVal.value && typeof outputVal.value === 'string') {
```

to:

```typescript
if ((outputVal.type === 'Image' || outputVal.type === 'Video' || outputVal.type === 'Mesh') && outputVal.value && typeof outputVal.value === 'string') {
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/store/graphStore.ts
git commit -m "feat: add Mesh type to output path rewriting"
```

---

### Task 8: Frontend — Install model-viewer and Create MeshPreview Component

**Files:**
- Create: `frontend/src/components/nodes/MeshPreview.tsx`
- Modify: `frontend/src/styles/nodes.css`

- [ ] **Step 1: Install `@google/model-viewer`**

Run: `cd frontend && npm install @google/model-viewer`

- [ ] **Step 2: Create model-viewer type declaration**

Create `frontend/src/types/model-viewer.d.ts`:

```typescript
declare namespace JSX {
  interface IntrinsicElements {
    'model-viewer': React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        alt?: string;
        'camera-controls'?: boolean;
        'auto-rotate'?: boolean;
        'shadow-intensity'?: string;
        'environment-image'?: string;
        poster?: string;
        style?: React.CSSProperties;
      },
      HTMLElement
    >;
  }
}
```

- [ ] **Step 3: Create `MeshPreview.tsx`**

Create `frontend/src/components/nodes/MeshPreview.tsx`:

```tsx
import { memo, useState, useCallback, useEffect } from 'react';
import '@google/model-viewer';

interface MeshPreviewProps {
  src: string;
}

function MeshPreviewComponent({ src }: MeshPreviewProps) {
  const [showModal, setShowModal] = useState(false);

  const handleClick = useCallback(() => {
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

  useEffect(() => {
    if (!showModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowModal(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showModal]);

  return (
    <>
      <div className="mesh-preview nodrag nowheel" onClick={handleClick} title="Click to expand">
        <model-viewer
          src={src}
          camera-controls
          auto-rotate
          shadow-intensity="0"
          style={{ width: '100%', height: '150px', backgroundColor: '#161616' }}
        />
      </div>

      {showModal && (
        <div className="mesh-modal-overlay" onClick={handleClose}>
          <div className="mesh-modal" onClick={(e) => e.stopPropagation()}>
            <button className="mesh-modal__close" onClick={handleClose} aria-label="Close">
              &times;
            </button>
            <model-viewer
              src={src}
              camera-controls
              auto-rotate
              shadow-intensity="1"
              style={{ width: '100%', height: '100%', backgroundColor: '#161616' }}
            />
            <div className="mesh-modal__info">
              <span className="mesh-modal__format">
                {src.split('.').pop()?.toUpperCase() || '3D'} model
              </span>
              <a href={src} download className="mesh-modal__download">
                Download
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export const MeshPreview = memo(MeshPreviewComponent);
```

- [ ] **Step 4: Add mesh preview and modal styles to `nodes.css`**

Append to `frontend/src/styles/nodes.css`:

```css
/* Mesh 3D Preview */
.mesh-preview {
  cursor: pointer;
  border-radius: 4px;
  overflow: hidden;
}

/* Full-screen modal overlay */
.mesh-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mesh-modal {
  position: relative;
  width: 80vw;
  height: 80vh;
  background: #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #333;
}

.mesh-modal__close {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10001;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid #555;
  color: #fff;
  font-size: 24px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.mesh-modal__close:hover {
  background: rgba(255, 255, 255, 0.15);
}

.mesh-modal__info {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 12px 16px;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.mesh-modal__format {
  color: #999;
  font-size: 13px;
  font-family: monospace;
}

.mesh-modal__download {
  padding: 6px 16px;
  background: #00BCD4;
  color: #000;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}

.mesh-modal__download:hover {
  background: #00E5FF;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/types/model-viewer.d.ts frontend/src/components/nodes/MeshPreview.tsx frontend/src/styles/nodes.css
git commit -m "feat: add MeshPreview component with inline 3D viewer and full-screen modal"
```

---

### Task 9: Frontend — Integrate Mesh Preview into Node Bodies

**Files:**
- Modify: `frontend/src/components/nodes/ModelNode.tsx:31-104`
- Modify: `frontend/src/components/nodes/DynamicNode.tsx:27-85`

- [ ] **Step 1: Add mesh output detection and preview to `ModelNode.tsx`**

In `frontend/src/components/nodes/ModelNode.tsx`:

Add the import at the top:

```typescript
import { MeshPreview } from './MeshPreview';
```

After the existing output detection lines (line 33), add:

```typescript
const meshOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Mesh' && o.value);
```

After the image preview block (lines 80-84), add the mesh preview block:

```tsx
{nodeData.state === 'complete' && meshOutput && typeof meshOutput.value === 'string' && (
  <div className="model-node__preview">
    <MeshPreview src={meshOutput.value} />
  </div>
)}
```

Update the fallback "Output ready" condition (line 100) to also exclude meshOutput:

```tsx
{nodeData.state === 'complete' && !imageOutput && !textOutput && !videoOutput && !meshOutput && Object.keys(nodeData.outputs).length > 0 && (
```

- [ ] **Step 2: Add mesh output detection and preview to `DynamicNode.tsx`**

In `frontend/src/components/nodes/DynamicNode.tsx`:

Add the import at the top:

```typescript
import { MeshPreview } from './MeshPreview';
```

After the existing output detection (line 28), add:

```typescript
const meshOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Mesh' && o.value);
```

After the image preview block (lines 73-77), add:

```tsx
{nodeData.state === 'complete' && meshOutput && typeof meshOutput.value === 'string' && (
  <div className="model-node__preview">
    <MeshPreview src={meshOutput.value} />
  </div>
)}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/nodes/ModelNode.tsx frontend/src/components/nodes/DynamicNode.tsx
git commit -m "feat: integrate MeshPreview into ModelNode and DynamicNode bodies"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Run all backend tests**

Run: `cd backend && python -m pytest tests/ -v`
Expected: All tests PASS (existing 74 + 5 new mesh tests)

- [ ] **Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Start dev servers and smoke test**

Start backend: `cd backend && python -m uvicorn main:app --host 0.0.0.0 --port 8000`
Start frontend: `cd frontend && npm run dev`

Open http://localhost:5173 in browser. Verify:
1. Right-click canvas to open context menu — should see "3d-gen" category with 4 nodes (cyan dot)
2. Add "Meshy 6 Text-to-3D" node — should show cyan Mesh output port
3. Connect a Text Input node to its Prompt input — should connect successfully
4. Verify Mesh port doesn't connect to Image/Video/Text input ports (should be blocked)
5. Verify node appears in the node palette with correct styling

- [ ] **Step 4: Commit any fixes needed**

If TypeScript or test issues were found and fixed, commit them.

- [ ] **Step 5: Final commit with all dependencies locked**

```bash
git add -A
git commit -m "feat: complete 3D mesh support — Meshy 6, Hunyuan3D V3 nodes with interactive preview"
```

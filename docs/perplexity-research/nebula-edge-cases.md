# Nebula Node — Edge Cases & Known Solutions

> Hand this file to Claude Code at the start of the build session alongside the Architecture Spec v2 and Model API Spec v2.
> These are pre-researched solutions to problems that **will** occur during development. Implement them proactively, not reactively.

---

## Project Name
**Nebula Node** — open source, runs locally, users bring their own API keys.

---

## 1. Graph & Execution Edge Cases

### 1.1 Cycle Detection (Circular Connections)
**Problem:** User drags an edge that creates a loop (A → B → A). This makes topological sort impossible and crashes the execution engine.

**Solution:** Use React Flow's built-in `isValidConnection` callback with `getOutgoers` to block cycles at drag-connect time — before the edge is ever created.

```typescript
import { useCallback } from 'react';
import { useReactFlow, getOutgoers } from '@xyflow/react';

export function useIsValidConnection() {
  const { getNodes, getEdges } = useReactFlow();

  return useCallback(
    (connection) => {
      const nodes = getNodes();
      const edges = getEdges();

      const target = nodes.find((node) => node.id === connection.target);
      const hasCycle = (node, visited = new Set()) => {
        if (visited.has(node.id)) return false;
        visited.add(node.id);
        for (const outgoer of getOutgoers(node, nodes, edges)) {
          if (outgoer.id === connection.source) return true;
          if (hasCycle(outgoer, visited)) return true;
        }
        return false;
      };

      if (target?.id === connection.source) return false;
      return !hasCycle(target);
    },
    [getNodes, getEdges]
  );
}

// Usage on ReactFlow component:
// <ReactFlow isValidConnection={useIsValidConnection()} ... />
```

**UI behavior:** Incompatible ports dim to 30% opacity during drag. If a cycle would form, the target port stays dimmed and the drop is rejected silently (no error toast needed — visual feedback is sufficient).

---

### 1.2 Orphaned Edges on Node Delete
**Problem:** If a node is deleted while edges are connected, the edge records remain in state with dangling `sourceNodeId`/`targetNodeId` references. This silently corrupts the graph JSON and causes crashes on re-load or execution.

**Solution:** In the `onNodesChange` handler, always filter edges when a node remove event fires.

```typescript
// In graphStore.ts
onNodesChange: (changes) => {
  const removedIds = changes
    .filter(c => c.type === 'remove')
    .map(c => c.id);

  if (removedIds.length > 0) {
    set(state => ({
      nodes: applyNodeChanges(changes, state.nodes),
      edges: state.edges.filter(
        e => !removedIds.includes(e.source) && !removedIds.includes(e.target)
      )
    }));
  } else {
    set(state => ({ nodes: applyNodeChanges(changes, state.nodes) }));
  }
},
```

**Never** rely on React Flow to clean up edges automatically on node delete — it does not.

---

### 1.3 Disconnected Subgraphs
**Problem:** User has two separate node islands on the canvas. Which one runs?

**Solution:**
- If any node has `isOutputNode: true` (set via right-click → "Set as Output Node"), only execute the subgraph connected to it.
- If no output node is designated, execute **all** subgraphs independently.
- Visually indicate which subgraph will run with a subtle highlight on `Ctrl+Enter`.

---

### 1.4 Empty Required Ports Before Execution
**Problem:** User hits Run with required input ports unconnected. The graph starts executing, fires API calls for nodes that have data, then crashes mid-run when it hits the node with missing input.

**Solution:** Run a **pre-execution validation pass** before any API call. Do not start execution if validation fails.

```python
def validate_graph(nodes, edges):
    errors = []
    for node in nodes:
        definition = get_node_definition(node['type'])
        for port in definition.inputPorts:
            if port.required:
                connected = any(
                    e['targetNodeId'] == node['id'] and 
                    e['targetPortId'] == port.id 
                    for e in edges
                )
                if not connected:
                    errors.append({
                        'nodeId': node['id'],
                        'portId': port.id,
                        'message': f'Required input "{port.label}" is not connected'
                    })
    return errors
```

Emit these as `validation_error` WebSocket events. The frontend marks each affected port with a red ring and shows a tooltip.

---

### 1.5 Iterator / Batch Size Cap
**Problem:** A user accidentally connects a 500-image array to an iterator node, triggering 500 parallel API calls and burning through credits instantly.

**Solution:**
- Default cap: **25 items** per iterator run.
- If array exceeds cap, show a modal: *"This will make N API calls. Estimated cost: ~$X. Continue?"*
- The "Run anyway" confirm bypasses the cap for that execution only.
- Setting in preferences: `execution.batchSizeCap: number` (default 25, set to 0 for unlimited).

---

## 2. Media & File Edge Cases

### 2.1 OpenAI Image URL Expiry
**Problem:** OpenAI image URLs expire after ~1 hour. In long or batch runs, early node outputs expire before downstream nodes consume them. The URL also becomes invalid if the user saves the graph and reopens it later.

**Solution:** Download the image to the output folder **immediately** when any node emits an `executed` event containing an OpenAI URL. Replace the in-memory URL with the local file path before passing it downstream.

```python
import httpx, os, hashlib
from datetime import datetime

async def download_and_cache(url: str, output_dir: str) -> str:
    """Download a temp URL and return the local file path."""
    if not url.startswith('http') or 'oaidalleapiprodscus' not in url:
        return url  # not an OpenAI temp URL, skip

    ext = 'png'  # OpenAI always returns PNG for gpt-image-1
    filename = hashlib.md5(url.encode()).hexdigest()[:12] + f'.{ext}'
    local_path = os.path.join(output_dir, filename)

    if not os.path.exists(local_path):
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            response.raise_for_status()
            with open(local_path, 'wb') as f:
                f.write(response.content)

    return local_path
```

Apply this same pattern to all video URL outputs (Runway, Kling, MiniMax, etc.) — their URLs are also temporary.

---

### 2.2 Output Directory
- **Default:** `./output/YYYY-MM-DD_HH-MM-SS/` relative to app launch directory
- **Override:** `settings.outputPath` — absolute path set by user in preferences
- **Per-run subfolder:** timestamp-based, so runs never overwrite each other
- Create the directory if it doesn't exist on first output write

```python
def get_output_dir(settings: dict) -> str:
    base = settings.get('outputPath') or os.path.join(os.getcwd(), 'output')
    run_dir = os.path.join(base, datetime.now().strftime('%Y-%m-%d_%H-%M-%S'))
    os.makedirs(run_dir, exist_ok=True)
    return run_dir
```

---

### 2.3 Video Format Compatibility
**Problem:** Kling, Runway, and most video-input models only accept MP4. If a user pipes a `.mov` or `.webm` from another node, the API will return a cryptic 400 error.

**Solution:** At the backend, before sending a video to any API, check the format. If not MP4, auto-transcode using ffmpeg.

```python
import subprocess, os

def ensure_mp4(video_path: str, output_dir: str) -> str:
    """Transcode to MP4 if not already. Returns path to MP4 file."""
    if video_path.endswith('.mp4'):
        return video_path
    
    output_path = os.path.join(output_dir, 
                               os.path.splitext(os.path.basename(video_path))[0] + '.mp4')
    subprocess.run([
        'ffmpeg', '-i', video_path,
        '-c:v', 'libx264', '-c:a', 'aac',
        '-movflags', '+faststart',  # web-optimized
        output_path, '-y'
    ], check=True, capture_output=True)
    return output_path
```

**Prerequisite:** `ffmpeg` must be available in the system PATH. On startup, check for ffmpeg and show a warning banner if not found: *"ffmpeg not found — video format conversion disabled. Install ffmpeg to enable."*

---

### 2.4 Base64 Size Limits
**Problem:** OpenAI edits and Gemini both cap base64 image inputs at ~20MB. Large images cause silent 400 errors.

**Solution:** Before encoding any image to base64, check file size. If > 18MB, auto-resize using Pillow (Python) or sharp (Node).

```python
from PIL import Image
import io, base64

def safe_image_to_base64(image_path: str, max_bytes: int = 18_000_000) -> str:
    with open(image_path, 'rb') as f:
        data = f.read()
    
    if len(data) <= max_bytes:
        return base64.b64encode(data).decode()
    
    # Resize until under limit
    img = Image.open(image_path)
    quality = 85
    while quality > 20:
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=quality)
        if buffer.tell() <= max_bytes:
            return base64.b64encode(buffer.getvalue()).decode()
        quality -= 10
    
    raise ValueError(f"Image cannot be compressed below {max_bytes} bytes")
```

---

### 2.5 SVG with Embedded Raster Images
**Problem:** Recraft V4 can output SVGs containing base64-embedded PNG data (`<image xlink:href="data:image/png;base64,..."/>`). These are valid SVGs but behave differently than pure vector SVGs.

**Solution:**
- The SVG port passes these through as-is (they are still valid SVG strings).
- The `svg-rasterize` utility node must use a headless browser renderer (e.g. `sharp` with SVG support, or `playwright` screenshot) rather than a simple SVG parser, to correctly render embedded images.
- In the node preview, render SVG content using an `<img src="data:image/svg+xml;base64,...">` tag, which handles both pure-vector and embedded-raster SVGs correctly.

---

### 2.6 Broken File Paths on Graph Reload
**Problem:** User saves a graph with local file references (e.g. an `image-input` node pointing to `/Users/justin/photo.jpg`), moves the file, and reopens the graph. The app crashes or silently produces wrong output.

**Solution:** On `loadGraph()`, run a validation pass on all input nodes before rendering:

```typescript
async function validateGraphOnLoad(nodes: Node[]): Promise<Node[]> {
  return Promise.all(nodes.map(async (node) => {
    if (['image-input', 'video-input', 'audio-input'].includes(node.type)) {
      const filePath = node.data.params.filePath;
      if (filePath && filePath.startsWith('/')) {
        const exists = await window.electronAPI.fileExists(filePath);
        if (!exists) {
          return {
            ...node,
            data: {
              ...node.data,
              state: 'error',
              error: `Source file not found: ${filePath} — reconnect or re-upload`
            }
          };
        }
      }
    }
    return node;
  }));
}
```

Mark broken nodes visually with a red border and an error badge. Do not block loading the rest of the graph.

---

## 3. API & Key Edge Cases

### 3.1 Missing API Key — Show at Drop Time, Not Run Time
**Problem:** User drops a Runway node, builds a complex graph around it, hits Run, and only then gets a "missing key" error.

**Solution:** When a node is added to the canvas, immediately check if its required env key exists in settings. If not, show a "⚠️ API Key Missing" badge on the node header. The badge links directly to the settings panel for that provider.

```typescript
function getNodeKeyStatus(nodeType: string, settings: Settings): 'ok' | 'missing' {
  const definition = NODE_DEFINITIONS[nodeType];
  const envKeys = Array.isArray(definition.envKeyName) 
    ? definition.envKeyName 
    : [definition.envKeyName];
  
  return envKeys.some(key => settings.apiKeys[key]) ? 'ok' : 'missing';
}
```

Block execution of any node with `keyStatus === 'missing'` and emit a clear `validation_error` event.

---

### 3.2 FAL vs Direct API Mode
- Store as `settings.routingMode: 'fal' | 'direct'` per provider, or a global toggle.
- Each model handler checks this at call time:

```python
def get_runway_endpoint(settings):
    if settings.routing_mode == 'fal':
        return 'https://fal.run/fal-ai/runway-gen4-turbo', settings.fal_key
    else:
        return 'https://api.runwayml.com/v1/tasks', settings.runway_api_key
```

- When switching modes mid-session: show a toast "Routing mode changed — re-run any pending nodes." Do not auto-re-execute.
- If a model is FAL-only (e.g. Veo 3, Wan 2.6) and the user switches to Direct mode, mark those nodes with a warning badge: "Direct API not available — FAL required for this model."

---

### 3.3 Rate Limit Handling (429 errors)
**Problem:** A 429 in the middle of a graph run fails the entire graph if not handled.

**Solution:** Per-node retry with exponential backoff. Isolate the failure to one node — do not cancel sibling nodes.

```python
import asyncio
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
import httpx

@retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=0.1, min=0.1, max=60),
    retry=retry_if_exception_type(httpx.HTTPStatusError)
)
async def call_with_retry(url, headers, payload):
    response = await httpx.AsyncClient().post(url, headers=headers, json=payload)
    if response.status_code == 429:
        retry_after = int(response.headers.get('Retry-After', 2))
        await asyncio.sleep(retry_after)
        response.raise_for_status()
    response.raise_for_status()
    return response
```

During retry, keep the node in `executing` state and show a "Rate limited — retrying in Xs" message in the node body.

---

### 3.4 MiniMax 3-Step Async Pattern
MiniMax is the **only** provider requiring 3 steps (not 2). Implement as a distinct handler:

```
Step 1: POST /v1/video_generation         → task_id
Step 2: GET  /v1/query/video_generation   → poll until status === 'Success'
Step 3: GET  /v1/files/retrieve/{file_id} → actual video URL/bytes
         ↑ Add 1-second delay before this call (file not immediately ready)
```

Terminal states to watch for: `Success`, `Fail`. Intermediate states: `Processing`, `Queueing`.

---

### 3.5 OpenRouter Image Generation (Non-Standard Endpoint)
**Problem:** OpenRouter routes image generation through `chat/completions` with `modalities: ["image"]`, NOT through `/v1/images/generations`. If you reuse the OpenAI image handler, it will fail silently or return text.

**Solution:** The OpenRouter universal node uses its own handler that always uses `chat/completions`. Image output is parsed from `delta.images[]` in the response, not from `data[].b64_json`.

```python
async def call_openrouter(model: str, messages: list, want_image: bool, api_key: str):
    payload = {
        "model": model,
        "messages": messages,
    }
    if want_image:
        payload["modalities"] = ["text", "image"]
    
    response = await httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=payload
    )
    data = response.json()
    
    # Image output location differs from OpenAI standard
    images = data.get('choices', [{}])[0].get('message', {}).get('images', [])
    text = data.get('choices', [{}])[0].get('message', {}).get('content', '')
    
    return {'text': text, 'images': images}
```

---

## 4. UX Edge Cases

### 4.1 Undo Should Not Undo API Calls
**Problem:** Standard undo/redo stacks restore state snapshots. If a user undoes a param change after a generation, they may expect the previous output to reappear — but it won't because no API call is re-fired on undo.

**Solution:**
- Undo/redo only affect **graph structure and params** (node positions, connections, settings).
- Generated outputs are **never** removed from the canvas by undo. They persist until the user explicitly deletes the node or clears outputs.
- Show a subtle indicator: "⟳ Params changed — re-run to update output" when params change after an output exists.

---

### 4.2 Duplicate Node IDs After Paste
**Problem:** Copy-pasting nodes that retain their original UUIDs causes two nodes with the same ID. Edge resolution breaks entirely.

**Solution:** Always regenerate UUIDs on paste. Never clone `node.id` directly.

```typescript
import { v4 as uuidv4 } from 'uuid';

function pasteNodes(copiedNodes: Node[], copiedEdges: Edge[]): { nodes: Node[], edges: Edge[] } {
  const idMap = new Map<string, string>();
  
  const newNodes = copiedNodes.map(node => {
    const newId = uuidv4();
    idMap.set(node.id, newId);
    return {
      ...node,
      id: newId,
      position: { x: node.position.x + 20, y: node.position.y + 20 },
      selected: true,
      data: { ...node.data, state: 'idle', outputs: {} }  // clear outputs on paste
    };
  });
  
  // Remap edge source/target to new IDs
  const newEdges = copiedEdges
    .filter(e => idMap.has(e.source) && idMap.has(e.target))
    .map(e => ({
      ...e,
      id: uuidv4(),
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!
    }));
  
  return { nodes: newNodes, edges: newEdges };
}
```

---

### 4.3 Port Hit Target at Extreme Zoom
**Problem:** At 10% zoom, port circles are 1px wide on screen — impossible to click accurately.

**Solution:** Maintain a minimum hit target radius in **screen space** regardless of zoom:

```typescript
const PORT_RADIUS_WORLD = 5;   // visual radius in world coords
const MIN_HIT_RADIUS_SCREEN = 10;  // minimum clickable radius in screen pixels

function getPortHitRadius(zoom: number): number {
  const worldRadius = MIN_HIT_RADIUS_SCREEN / zoom;
  return Math.max(PORT_RADIUS_WORLD, worldRadius);
}
```

Use `getPortHitRadius(viewport.zoom)` for mouse intersection tests, but always render the port at `PORT_RADIUS_WORLD` visually.

---

## 5. Startup Checks

Run these on app launch before the canvas loads:

```python
def run_startup_checks(settings) -> list[dict]:
    warnings = []
    
    # Check ffmpeg
    result = subprocess.run(['ffmpeg', '-version'], capture_output=True)
    if result.returncode != 0:
        warnings.append({
            'type': 'warning',
            'message': 'ffmpeg not found — video format auto-conversion disabled. Install ffmpeg to enable.'
        })
    
    # Check output directory is writable
    output_dir = settings.get('outputPath', './output')
    try:
        os.makedirs(output_dir, exist_ok=True)
        test_file = os.path.join(output_dir, '.write_test')
        with open(test_file, 'w') as f: f.write('test')
        os.remove(test_file)
    except Exception as e:
        warnings.append({
            'type': 'error', 
            'message': f'Output directory not writable: {output_dir}'
        })
    
    return warnings
```

Show warnings as a dismissable banner at the top of the canvas, not a blocking modal.

---

## 6. Key Pre-Build Decisions (Already Resolved)

| Decision | Resolution |
|---|---|
| API routing | Dual-mode: FAL (single key) or Direct (per-provider keys). Toggle per provider in settings. |
| Output storage | `./output/YYYY-MM-DD_HH-MM-SS/` default; overridable in settings. |
| OpenRouter image nodes | One universal OR node; output ports auto-show/hide based on selected model's `output_modalities`. |
| Frontend canvas library | `@xyflow/react` (React Flow v12) + Zustand |
| MiniMax async pattern | 3-step submit → poll → fetch-file (distinct from 2-step async-poll) |
| Batch size cap | Default 25 items; user-overridable with confirmation dialog |
| URL expiry | Download all temp URLs to local output dir immediately on node completion |
| Undo behavior | Undo graph structure/params only — never removes generated outputs |

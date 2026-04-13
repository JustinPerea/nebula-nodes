# AI Node Editor — Architecture & Interaction Spec v2

> **Version:** 2.0 — Updated April 2026  
> **Supersedes:** v1 (initial spec)  
> **Changes in v2:** Added SVG port type, async/polling execution pattern, Tier 2 dynamic node architecture, Video-as-input port rules, pre-build improvement recommendations.

***

## Executive Summary

This document is the complete technical specification for building a local AI node-based editor — equivalent to Figma Weave, Flora AI, or ComfyUI — using your own API keys. It covers the full data model, canvas interaction system, node catalog structure, port type system (including new SVG port), execution engine (sync and async), and the dynamic adapter node pattern for OpenRouter, Replicate, and FAL.

This document is intended to be handed directly to Claude Code or another coding agent as the primary build specification.

***

## Section 1 — Core Data Model

### 1.1 Node

```typescript
interface Node {
  id: string;                          // uuid v4
  type: string;                        // e.g. "gpt-image-1-generate"
  position: { x: number; y: number };  // canvas coordinates
  size: { width: number; height: number };
  data: {
    label: string;
    params: Record<string, unknown>;   // user-configured settings
    state: 'idle' | 'queued' | 'executing' | 'complete' | 'error';
    progress?: number;                 // 0–1 for streaming/polling
    outputs: Record<string, PortValue>;
    error?: string;
  };
  selected: boolean;
  collapsed: boolean;
}
```

### 1.2 Edge

```typescript
interface Edge {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  dataType: PortDataType;   // validated at connection time
  animated: boolean;        // true while data is flowing
}
```

### 1.3 Port

```typescript
interface Port {
  id: string;
  nodeId: string;
  side: 'input' | 'output';
  dataType: PortDataType;
  label: string;
  required: boolean;
  multiple: boolean;        // true = accepts multiple incoming edges
  position: { x: number; y: number }; // absolute canvas coords
}

type PortDataType = 
  | 'Text'    // string data: prompts, captions, transcripts
  | 'Image'   // pixel data: PNG, JPEG, WebP (as URL or base64)
  | 'Video'   // video data: MP4, MOV, WebM (as URL)
  | 'Audio'   // audio data: MP3, WAV, PCM (as URL or base64)
  | 'Mask'    // alpha-channel mask image (PNG with transparency)
  | 'Array'   // ordered list of any homogeneous type
  | 'SVG'     // editable vector file (SVG string or URL)
  | 'Any'     // used only by utility/router nodes
```

### 1.4 PortValue (runtime data carried on edges)

```typescript
interface PortValue {
  type: PortDataType;
  value:
    | string           // Text, Image URL, Video URL, Audio URL, SVG string
    | string[]         // Array
    | { url: string; mimeType: string }   // typed media
    | ArrayBuffer      // raw binary (audio PCM)
    | null;
}
```

### 1.5 Canvas Viewport

```typescript
interface Viewport {
  x: number;       // pan offset X (pixels)
  y: number;       // pan offset Y (pixels)
  zoom: number;    // scale factor (0.1–4.0)
}
```

***

## Section 2 — Port Color System

| Port Color | Hex | Data Type | Description |
|---|---|---|---|
| 🟢 **Green** | `#4CAF50` | `Image` | PNG, JPEG, WebP — pixel data |
| 🔴 **Red** | `#F44336` | `Video` | MP4, MOV, WebM — video |
| 🟣 **Purple** | `#9C27B0` | `Text` | Strings: prompts, captions, transcripts |
| 🔵 **Blue** | `#2196F3` | `Array` | Ordered lists of homogeneous values |
| 🟡 **Yellow** | `#FFC107` | `Audio` | MP3, WAV, PCM — audio |
| 🟢 **Lime** | `#8BC34A` | `Mask` | Alpha-channel mask PNG |
| 🟤 **Brown** | `#795548` | `SVG` | Editable vector — SVG text or URL |
| ⚪ **White** | `#9E9E9E` | `Any` | Wildcard — utility/router nodes only |

**Visual rendering rules:**
- Port circles are 10px diameter, filled with the data type color, with a 2px white stroke
- Connected ports show a 2px solid ring in the data type color
- Hoverable ports scale to 14px on hover
- Incompatible ports dim to 30% opacity during a drag-connect operation

***

## Section 3 — Port Connection Rules

### 3.1 Compatible Connections

| Output Port Type | Compatible Input Port Types |
|---|---|
| `Text` | `Text`, `Any` |
| `Image` | `Image`, `Mask` (lint warning), `Any` |
| `Video` | `Video`, `Any` |
| `Audio` | `Audio`, `Any` |
| `Mask` | `Mask`, `Image` (with warning), `Any` |
| `Array` | `Array`, `Any` |
| `SVG` | `SVG`, `Image` (rasterize node required — auto-suggest), `Any` |
| `Any` | Any type |

### 3.2 Video as Input Port (new in v2)

Several models accept **Video as an input**. These are Transform nodes where a prior video feeds the current generation:

| Node | Video Input Role |
|---|---|
| Kling Motion Control | Motion reference video |
| Kling Lip Sync A2V | Video to add audio to |
| Sora 2 Remix (V2V) | Video to restyle |
| Luma Ray 2 Modify | Video to modify |
| Wan 2.6 Reference-to-Video | Up to 3 reference videos (tagged @Video1–3 in prompt) |
| Runway Act-Two | Motion source for character animation |

When a `Video` output port is dragged to a `Video` input port, the edge is valid — use red `#F44336` for the edge color.

### 3.3 Strict Incompatibilities (blocked at the UI level)

- `Video` output → `Image` input: ❌ blocked (use a Frame Extractor utility node)
- `Audio` output → `Image` input: ❌ blocked
- `Text` output → `Image` input: ❌ blocked (must use a Prompt port, not an Image port)
- `SVG` output → `Image` input: ⚠️ soft-block (prompt to insert auto-Rasterize node)

***

## Section 4 — Canvas Interaction & Mouse State Machine

The canvas has a single interaction state machine. Only one mode is active at a time.

```typescript
type CanvasMode =
  | 'idle'
  | 'panning'
  | 'node-dragging'
  | 'port-connecting'
  | 'rubber-band-select'
  | 'node-resizing'
  | 'context-menu';
```

### 4.1 State Transitions

**`idle` → `panning`**
- Trigger: Middle-mouse-button down OR Space + left-mouse-button down
- On enter: `cursor: grab`
- On move: `viewport.x += dx; viewport.y += dy`
- On release: return to `idle`, `cursor: default`

**`idle` → `node-dragging`**
- Trigger: Left-mouse-button down on a node header (not a port)
- If node not already selected: clear selection, select this node
- If multiple nodes selected and drag starts on any of them: drag all
- On move: `node.position.x += dx / viewport.zoom; node.position.y += dy / viewport.zoom`
- On release: commit positions, emit `nodesChanged` event, return to `idle`
- Snap-to-grid: if enabled, snap to 8px grid on release

**`idle` → `port-connecting`**
- Trigger: Left-mouse-button down on any port circle
- On enter: render phantom bezier curve from source port to cursor
- Compatible target ports highlight (scale up + brighten); incompatible ports dim
- On move: update phantom curve endpoint to cursor position
- On hover over compatible port: snap curve endpoint to port center + show preview tooltip
- On release over compatible port: create `Edge`, return to `idle`
- On release over empty canvas: cancel, return to `idle`
- On release over incompatible port: show shake animation + error tooltip, return to `idle`

**`idle` → `rubber-band-select`**
- Trigger: Left-mouse-button down on empty canvas area
- On move: render semi-transparent selection rect
- On release: select all nodes whose bounding boxes intersect the rect

**`idle` → `node-resizing`**
- Trigger: Left-mouse-button down on resize handle (bottom-right corner of node)
- Minimum size: 200×100px
- On move: update `node.size`

### 4.2 Bezier Curve Formula for Edges

All edges are cubic bezier curves. Control points are computed based on port side:

```typescript
function getEdgePath(source: Port, target: Port): string {
  const dx = Math.abs(target.position.x - source.position.x);
  const handleDist = Math.max(dx * 0.5, 60);

  const cp1 = { x: source.position.x + handleDist, y: source.position.y };
  const cp2 = { x: target.position.x - handleDist, y: target.position.y };

  return `M ${source.position.x} ${source.position.y} 
          C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, 
          ${target.position.x} ${target.position.y}`;
}
```

- Edge stroke width: 2px, color = `PortDataType` color
- Animated edges (during execution): stroke-dasharray with CSS animation
- Selected edge: stroke width 3px + glow shadow

### 4.3 Zoom-to-Cursor

```typescript
function onWheel(event: WheelEvent, viewport: Viewport): Viewport {
  const zoomDelta = event.deltaY > 0 ? 0.9 : 1.1;
  const newZoom = clamp(viewport.zoom * zoomDelta, 0.1, 4.0);
  const scaleChange = newZoom / viewport.zoom;
  
  // Translate so the point under cursor stays fixed
  const newX = event.clientX - scaleChange * (event.clientX - viewport.x);
  const newY = event.clientY - scaleChange * (event.clientY - viewport.y);
  
  return { x: newX, y: newY, zoom: newZoom };
}
```

### 4.4 Canvas-to-World Coordinate Transform

```typescript
function canvasToWorld(canvasX: number, canvasY: number, viewport: Viewport) {
  return {
    x: (canvasX - viewport.x) / viewport.zoom,
    y: (canvasY - viewport.y) / viewport.zoom,
  };
}

function worldToCanvas(worldX: number, worldY: number, viewport: Viewport) {
  return {
    x: worldX * viewport.zoom + viewport.x,
    y: worldY * viewport.zoom + viewport.y,
  };
}
```

### 4.5 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Space` + drag | Pan canvas |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Ctrl/Cmd + A` | Select all nodes |
| `Ctrl/Cmd + C` | Copy selected nodes |
| `Ctrl/Cmd + V` | Paste nodes (offset by 20px) |
| `Delete` / `Backspace` | Delete selected nodes/edges |
| `Escape` | Cancel current operation / deselect all |
| `Ctrl/Cmd + +` | Zoom in |
| `Ctrl/Cmd + -` | Zoom out |
| `Ctrl/Cmd + 0` | Fit all nodes to screen |
| `Ctrl/Cmd + Enter` | Run graph (execute all dirty nodes) |
| `R` | Add reroute node at cursor |
| `S` | Add sticky note at cursor |
| `F` | Frame/focus selected nodes |
| `Ctrl/Cmd + G` | Group selected nodes |
| `Ctrl/Cmd + D` | Duplicate selected nodes |
| `1`–`9` | Jump to saved viewport positions |

### 4.6 Right-Click Context Menus

**Canvas (empty area):**
- Add Node → (submenu by category)
- Paste (if clipboard has nodes)
- Select All
- Fit to Screen

**Node:**
- Run This Node
- Duplicate
- Copy
- Collapse / Expand
- Delete
- Bypass (pass inputs directly to outputs)
- Set as Output Node

**Edge:**
- Delete Connection
- Insert Reroute Point
- Insert Convert Node (if types differ by one hop)

**Port:**
- Disconnect All
- View Current Value

***

## Section 5 — Node Anatomy

Every node consists of:

```
┌─────────────────────────────────────┐
│ [Category Icon] Node Name    [⚙] [×] │  ← Header (drag handle)
├─────────────────────────────────────┤
│ ● Input Port 1 (Text)               │  ← Input ports (left side)
│ ● Input Port 2 (Image)              │
├─────────────────────────────────────┤
│  [Param Field 1: dropdown]          │  ← Settings panel (collapsible)
│  [Param Field 2: slider]            │
│  [Param Field 3: text area]         │
├─────────────────────────────────────┤
│ [Preview thumbnail or text output]  │  ← Output preview (collapsible)
├─────────────────────────────────────┤
│               Output Port ●         │  ← Output ports (right side)
└─────────────────────────────────────┘
```

**Header colors by category:**
- `image-gen`: Blue `#1565C0`
- `video-gen`: Red `#B71C1C`
- `text-gen`: Purple `#4A148C`
- `audio-gen`: Amber `#FF6F00`
- `transform`: Teal `#004D40`
- `analyzer`: Green `#1B5E20`
- `utility`: Grey `#424242`

**State indicator** (left border of header):
- `idle`: transparent
- `queued`: grey pulse
- `executing`: blue animated shimmer
- `complete`: green flash → steady
- `error`: red solid

***

## Section 6 — Node Type Definitions

### 6.1 Node Definition Interface

```typescript
interface ModelNodeDefinition {
  id: string;                   // kebab-case unique ID
  displayName: string;
  category: NodeCategory;
  apiProvider: APIProvider;
  apiEndpoint: string;
  envKeyName: string | string[]; // one or more env var names
  executionPattern: 'sync' | 'async-poll' | 'async-webhook' | 'stream';
  inputPorts: PortDefinition[];
  outputPorts: PortDefinition[];
  params: ParamDefinition[];
  docUrl?: string;
}

type NodeCategory = 
  | 'image-gen' | 'video-gen' | 'text-gen' | 'audio-gen'
  | 'transform' | 'analyzer' | 'utility';

type APIProvider = 
  | 'openai' | 'anthropic' | 'google' | 'runway'
  | 'kling' | 'elevenlabs' | 'replicate' | 'fal'
  | 'bytedance' | 'minimax' | 'luma' | 'xai'
  | 'recraft' | 'ideogram' | 'openrouter' | 'bfl';

interface PortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
  multiple?: boolean;
  maxConnections?: number;
}

interface ParamDefinition {
  key: string;
  label: string;
  type: 'string' | 'integer' | 'float' | 'boolean' | 'enum' | 'textarea' | 'file';
  required: boolean;
  default?: unknown;
  options?: Array<{ label: string; value: string | number }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  condition?: string; // e.g. "model === 'gpt-image-1.5'" — show only when true
}
```

### 6.2 Built-in Utility Nodes (no API call)

| Node ID | Function | Input | Output |
|---|---|---|---|
| `text-input` | Static text/prompt source | — | 🟣 Text |
| `image-input` | Upload or URL image source | — | 🟢 Image |
| `video-input` | Upload or URL video source | — | 🔴 Video |
| `audio-input` | Upload or URL audio source | — | 🟡 Audio |
| `preview` | Display any media value | Any | — |
| `text-preview` | Display text output | 🟣 Text | — |
| `image-compare` | Side-by-side image diff | 🟢 Image × 2 | — |
| `router` | Fan-out one input to N outputs | Any | Any × N |
| `array-builder` | Collect N inputs into Array | Any × N | 🔵 Array |
| `array-selector` | Pick item from Array by index | 🔵 Array | Any |
| `iterator-image` | Run downstream per image in array | 🔵 Array(Image) | 🟢 Image |
| `iterator-text` | Run downstream per text in array | 🔵 Array(Text) | 🟣 Text |
| `reroute` | Invisible passthrough waypoint | Any | Any |
| `sticky-note` | Non-executing annotation | — | — |
| `frame-extractor` | Extract frame from video at timestamp | 🔴 Video | 🟢 Image |
| `svg-rasterize` | Convert SVG to raster Image | 🗂 SVG | 🟢 Image |
| `image-to-base64` | Convert image URL to base64 | 🟢 Image | 🟣 Text |
| `combine-text` | Merge multiple text inputs with template | 🟣 Text × N | 🟣 Text |

***

## Section 7 — Execution Engine

### 7.1 Execution Modes

There are three execution trigger modes:
- **Auto-run**: re-execute dirty subgraph whenever any param or input changes (debounced 500ms)
- **Manual-run**: execute only on `Ctrl+Enter` or clicking node's Run button
- **Batch-run**: iterate over an array input, running the downstream graph once per item

### 7.2 Graph Execution — Topological Sort

```python
import graphlib
import asyncio
from typing import Dict, List

def build_execution_order(nodes: List[dict], edges: List[dict]) -> List[str]:
    """Return node IDs in topological execution order."""
    graph = graphlib.TopologicalSorter()
    
    for node in nodes:
        deps = {e['sourceNodeId'] for e in edges if e['targetNodeId'] == node['id']}
        graph.add(node['id'], *deps)
    
    return list(graph.static_order())

async def execute_graph(nodes, edges, node_handlers):
    order = build_execution_order(nodes, edges)
    results: Dict[str, dict] = {}  # nodeId → output values
    
    for node_id in order:
        node = next(n for n in nodes if n['id'] == node_id)
        
        # Gather resolved inputs from upstream nodes
        inputs = {}
        for edge in [e for e in edges if e['targetNodeId'] == node_id]:
            upstream_output = results[edge['sourceNodeId']][edge['sourcePortId']]
            inputs[edge['targetPortId']] = upstream_output
        
        # Execute the node
        handler = node_handlers[node['type']]
        results[node_id] = await handler(node['data']['params'], inputs)
    
    return results
```

### 7.3 Sync Execution Pattern

Most FAL, Replicate, and OpenAI API calls are synchronous (respond within the HTTP request). The node runs, awaits the response, stores outputs, and marks itself complete.

```python
async def execute_sync_node(node, inputs, api_key):
    """Standard synchronous API call."""
    emit_event('executing', node_id=node['id'])
    
    try:
        payload = build_payload(node['params'], inputs)
        response = await httpx.post(
            node['definition'].apiEndpoint,
            headers={'Authorization': f'Bearer {api_key}'},
            json=payload,
            timeout=120.0
        )
        response.raise_for_status()
        outputs = parse_response(response.json(), node['definition'].outputPorts)
        emit_event('executed', node_id=node['id'], outputs=outputs)
        return outputs
    except Exception as e:
        emit_event('error', node_id=node['id'], error=str(e))
        raise
```

### 7.4 Async Poll Execution Pattern (NEW in v2)

Several models — notably **MiniMax**, **Replicate (community models)**, **Runway** — use a submit-then-poll pattern. The initial request returns a `task_id` or `prediction_id`, and results must be fetched separately.

```python
async def execute_async_poll_node(node, inputs, api_key, poll_interval=2.0):
    """Submit job, poll until complete, return results."""
    emit_event('executing', node_id=node['id'])
    
    # Step 1: Submit the job
    payload = build_payload(node['params'], inputs)
    submit_response = await httpx.post(
        node['definition'].apiEndpoint,
        headers={'Authorization': f'Bearer {api_key}'},
        json=payload
    )
    submit_response.raise_for_status()
    task_id = submit_response.json().get('task_id') or submit_response.json().get('id')
    
    # Step 2: Poll until terminal state
    poll_url = node['definition'].pollEndpoint.format(task_id=task_id)
    max_polls = 300  # 10 minutes at 2s interval
    
    for attempt in range(max_polls):
        await asyncio.sleep(poll_interval)
        
        status_response = await httpx.get(
            poll_url,
            headers={'Authorization': f'Bearer {api_key}'}
        )
        status_data = status_response.json()
        status = status_data.get('status') or status_data.get('task_status')
        
        # Emit progress for UI progress bar
        if 'progress' in status_data:
            emit_event('progress', node_id=node['id'], 
                      value=status_data['progress'])
        
        if status in ('Completed', 'succeeded', 'Success', 'success'):
            outputs = parse_response(status_data, node['definition'].outputPorts)
            emit_event('executed', node_id=node['id'], outputs=outputs)
            return outputs
        
        if status in ('Failed', 'failed', 'canceled', 'error'):
            error_msg = status_data.get('error', 'Unknown error')
            emit_event('error', node_id=node['id'], error=error_msg)
            raise RuntimeError(f"Async job failed: {error_msg}")
    
    raise TimeoutError(f"Node {node['id']} timed out after {max_polls * poll_interval}s")
```

**Models using async-poll pattern:**

| Provider | Submit Endpoint | Poll Endpoint | Terminal States |
|---|---|---|---|
| MiniMax | `POST /v1/video_generation` | `GET /v1/query/video_generation?task_id={id}` | `Success`, `Fail` |
| Replicate | `POST /v1/predictions` | `GET /v1/predictions/{id}` | `succeeded`, `failed`, `canceled` |
| Runway | `POST /v1/tasks` | `GET /v1/tasks/{id}` | `SUCCEEDED`, `FAILED` |
| Kling (direct) | `POST /kling/v1/videos/...` | `GET /kling/v1/videos/.../{id}` | `succeed`, `failed` |
| fal.ai (queue) | `POST /fal/queue/runs` | `GET /fal/queue/requests/{id}/status` | `COMPLETED`, `FAILED` |

### 7.5 Streaming Execution Pattern

For text-generation nodes (Claude, GPT-4o, Gemini), streaming allows progressive output:

```python
async def execute_stream_node(node, inputs, api_key):
    emit_event('executing', node_id=node['id'])
    accumulated = ''
    
    async with httpx.stream('POST', node['definition'].apiEndpoint,
        headers={'Authorization': f'Bearer {api_key}'},
        json={**build_payload(node['params'], inputs), 'stream': True}
    ) as response:
        async for line in response.aiter_lines():
            if line.startswith('data: '):
                chunk = parse_sse_chunk(line[6:])
                if chunk:
                    accumulated += chunk
                    emit_event('stream_delta', 
                              node_id=node['id'], 
                              delta=chunk, 
                              accumulated=accumulated)
    
    emit_event('executed', node_id=node['id'], 
               outputs={'text': accumulated})
    return {'text': accumulated}
```

### 7.6 WebSocket Progress Events

The backend emits these events to the frontend over WebSocket:

```typescript
type ExecutionEvent =
  | { type: 'queued';       nodeId: string }
  | { type: 'executing';    nodeId: string }
  | { type: 'progress';     nodeId: string; value: number }  // 0.0–1.0
  | { type: 'stream_delta'; nodeId: string; delta: string; accumulated: string }
  | { type: 'executed';     nodeId: string; outputs: Record<string, PortValue> }
  | { type: 'error';        nodeId: string; error: string; retryable: boolean }
  | { type: 'graph_complete'; duration: number; nodesExecuted: number }
```

### 7.7 Caching Strategy

Cache key: `sha256(nodeType + JSON.stringify(params) + JSON.stringify(inputValues))`

```python
import hashlib, json, time

class ExecutionCache:
    def __init__(self, ttl_seconds: int = 3600):
        self._store: dict = {}
        self._ttl = ttl_seconds
    
    def get_key(self, node_type, params, inputs) -> str:
        payload = json.dumps({'type': node_type, 'params': params, 
                              'inputs': inputs}, sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()
    
    def get(self, key: str):
        entry = self._store.get(key)
        if entry and time.time() - entry['timestamp'] < self._ttl:
            return entry['value']
        return None
    
    def set(self, key: str, value):
        self._store[key] = {'value': value, 'timestamp': time.time()}
```

**Cache invalidation:** Any change to node params or upstream output clears the cache entry for that node and all downstream dependents.

### 7.8 Interrupt / Cancel

```python
# Each running node gets a cancellation token
class CancellationToken:
    def __init__(self): self.cancelled = False
    def cancel(self): self.cancelled = True
    def check(self): 
        if self.cancelled: raise asyncio.CancelledError()

# Cancel a running node from frontend
def cancel_node(node_id: str):
    if node_id in running_tokens:
        running_tokens[node_id].cancel()
        emit_event('error', node_id=node_id, 
                  error='Cancelled by user', retryable=True)
```

***

## Section 8 — Tier 2 Dynamic Node Architecture (NEW in v2)

In addition to ~40 hardcoded first-class nodes, three generic adapter nodes let users run any model without rebuilding the app.

### 8.1 OpenRouter Universal Node

**Behavior:** On model selection change, fetches model metadata from `GET /api/v1/models/{id}` and updates visible params and output ports.

```typescript
// Auto-detect image output capability
async function onModelChange(modelId: string) {
  const meta = await fetch(`https://openrouter.ai/api/v1/models/${modelId}`, {
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
  }).then(r => r.json());
  
  const supportsImageOutput = 
    meta.output_modalities?.includes('image') ?? false;
  const supportsVision = 
    meta.input_modalities?.includes('image') ?? false;
  
  setOutputPorts(supportsImageOutput 
    ? [textPort, imagePort]   // show both
    : [textPort]);             // text only
  
  setInputPorts(supportsVision 
    ? [messagesPort, imagePort] 
    : [messagesPort]);
}
```

**API Call (image generation via OR):**
```python
# For OR image models, use chat completions + modalities param
payload = {
    "model": params["model"],
    "messages": inputs["messages"],
    "modalities": ["text", "image"]  # triggers image output
}
```

### 8.2 Replicate Universal Node

**Behavior:** User enters any `owner/name` model ID. Node auto-fetches schema and renders dynamic UI.

```python
async def fetch_replicate_schema(owner: str, name: str, api_token: str):
    """Fetch latest version schema for any Replicate model."""
    model_resp = await httpx.get(
        f"https://api.replicate.com/v1/models/{owner}/{name}",
        headers={"Authorization": f"Token {api_token}"}
    )
    model = model_resp.json()
    version_id = model["latest_version"]["id"]
    
    version_resp = await httpx.get(
        f"https://api.replicate.com/v1/models/{owner}/{name}/versions/{version_id}",
        headers={"Authorization": f"Token {api_token}"}
    )
    schema = version_resp.json()["openapi_schema"]
    return schema, version_id
```

**Dynamic port inference from schema:**
```typescript
function inferPortsFromSchema(schema: object): {
  inputs: PortDefinition[],
  outputs: PortDefinition[]
} {
  const inputProps = schema?.components?.schemas?.Input?.properties ?? {};
  const outputType = schema?.components?.schemas?.Output?.type;
  
  const inputs = Object.entries(inputProps).map(([key, prop]: [string, any]) => ({
    id: key,
    label: prop.title ?? key,
    dataType: inferPortDataType(prop),
    required: schema.components.schemas.Input.required?.includes(key) ?? false,
  }));
  
  // Output port based on output schema type
  const outputs = [{
    id: 'output',
    label: 'Output',
    dataType: inferOutputPortDataType(outputType),
    required: false,
  }];
  
  return { inputs, outputs };
}

function inferPortDataType(prop: any): PortDataType {
  if (prop.format === 'uri' && prop['x-uploadable']) return 'Image';
  if (prop.type === 'string' && prop.format === 'uri') return 'Image';
  if (prop.type === 'string') return 'Text';
  if (prop.type === 'integer' || prop.type === 'number') return 'Text'; // render as number param
  if (prop.type === 'array') return 'Array';
  return 'Any';
}
```

### 8.3 FAL Universal Node

```python
async def execute_fal_universal(endpoint: str, params: dict, inputs: dict, fal_key: str):
    """Execute any fal.ai endpoint with dynamic payload."""
    import fal_client
    
    payload = {**params, **inputs}
    
    # FAL uses a queue system for long-running models
    handle = await fal_client.submit_async(endpoint, arguments=payload)
    
    # Poll with progress
    async for event in handle.iter_events(with_logs=True):
        if isinstance(event, fal_client.InProgress):
            if event.logs:
                emit_event('progress', delta=event.logs[-1].message)
    
    result = await handle.get()
    return result
```

***

## Section 9 — Project File Structure

```
ai-node-editor/
├── frontend/
│   ├── src/
│   │   ├── canvas/
│   │   │   ├── Canvas.tsx           # main SVG/Canvas component
│   │   │   ├── useViewport.ts       # zoom/pan state
│   │   │   ├── useDragDrop.ts       # node drag & connect logic
│   │   │   └── useSelection.ts      # rubber-band select
│   │   ├── nodes/
│   │   │   ├── NodeRenderer.tsx     # renders any node from definition
│   │   │   ├── PortRenderer.tsx     # port circles + hover
│   │   │   ├── EdgeRenderer.tsx     # bezier curves + animation
│   │   │   └── definitions/         # one file per model
│   │   │       ├── openai.ts
│   │   │       ├── anthropic.ts
│   │   │       ├── google.ts
│   │   │       ├── runway.ts
│   │   │       ├── kling.ts
│   │   │       ├── fal.ts
│   │   │       └── ... (one per provider)
│   │   ├── store/
│   │   │   ├── graphStore.ts        # Zustand: nodes, edges, viewport
│   │   │   └── executionStore.ts    # Zustand: execution state, results
│   │   ├── execution/
│   │   │   ├── WebSocketClient.ts   # WS connection to backend
│   │   │   └── graphRunner.ts       # topological sort + dispatch
│   │   └── App.tsx
│   └── package.json
│
├── backend/
│   ├── main.py                      # FastAPI app
│   ├── execution/
│   │   ├── engine.py                # topological sort + orchestration
│   │   ├── sync_runner.py           # sync API call handler
│   │   ├── async_poll_runner.py     # async submit/poll handler
│   │   └── stream_runner.py         # SSE streaming handler
│   ├── handlers/
│   │   ├── openai.py                # OpenAI image + chat handlers
│   │   ├── anthropic.py             # Claude handlers
│   │   ├── google.py                # Gemini + Imagen + Veo handlers
│   │   ├── runway.py                # Runway handlers
│   │   ├── kling.py                 # Kling handlers (via fal)
│   │   ├── fal.py                   # Generic fal handler
│   │   ├── replicate.py             # Generic Replicate handler
│   │   ├── openrouter.py            # OpenRouter universal handler
│   │   ├── elevenlabs.py            # ElevenLabs TTS handler
│   │   └── minimax.py               # MiniMax async handler
│   ├── cache.py                     # SHA256 execution cache
│   ├── ws.py                        # WebSocket event emitter
│   └── .env                         # API keys (never committed)
│
├── .env.example
└── README.md
```

***

## Section 10 — Environment Variables

```bash
# .env.example — copy to .env and fill in your keys

# OpenAI
OPENAI_API_KEY=sk-...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Google (AI Studio key for Gemini/Imagen/Nano Banana)
GOOGLE_API_KEY=AIza...
# OR Vertex AI service account
GOOGLE_CLOUD_PROJECT=my-project
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# Runway
RUNWAY_API_KEY=key_...

# FAL (covers Kling, FLUX, Veo3, Wan, LTX, Pixverse, Seedance, Luma, etc.)
FAL_KEY=...

# Black Forest Labs (FLUX direct)
BFL_API_KEY=...

# ElevenLabs
ELEVENLABS_API_KEY=sk_...

# Replicate
REPLICATE_API_TOKEN=r8_...

# OpenRouter (universal LLM gateway)
OPENROUTER_API_KEY=sk-or-v1-...

# ByteDance (Seedream direct)
BYTEDANCE_API_KEY=...

# MiniMax
MINIMAX_API_KEY=...

# xAI (Grok)
XAI_API_KEY=xai-...

# Recraft (direct API)
RECRAFT_API_KEY=...

# Ideogram
IDEOGRAM_API_KEY=...

# Higgsfield
HIGGSFIELD_API_KEY=...
```

***

## Section 11 — Build Order (Prioritized)

Build in this order to get a working system as fast as possible, adding complexity incrementally:

1. **Canvas viewport** — pan, zoom, coordinate transforms (no nodes yet)
2. **Static node render** — hardcoded positions, ports visible
3. **Edge drawing** — bezier curves, port-to-port connections
4. **Node drag** — move nodes, edges follow
5. **Rubber-band select** — multi-select nodes and edges
6. **Topological sort** — DAG validation, cycle detection
7. **First API call** — one sync node (e.g. `gpt-image-1-generate`)
8. **WebSocket event bus** — executing/progress/complete events to frontend
9. **Node state indicators** — idle/queued/executing/complete/error header states
10. **Execution cache** — skip re-running identical inputs
11. **Output preview** — image thumbnail in node body
12. **Async-poll pattern** — add Runway or MiniMax node as first async node
13. **Streaming pattern** — add GPT-4o or Claude text node with streamed output
14. **Utility nodes** — text-input, image-input, preview, router, array-builder
15. **Settings panel** — all params for each node as form fields
16. **Dynamic Replicate node** — schema-fetch and auto-render params
17. **Dynamic OpenRouter node** — model list + capability detection
18. **FAL universal node** — generic endpoint runner
19. **Save/load** — export/import graph as JSON
20. **Keyboard shortcuts** — full shortcut table from Section 4.5

***

## Section 12 — Pre-Build Improvement Checklist

These are improvements and decisions to make **before** writing the first line of application code:

### 12.1 Architecture Decisions
- [ ] **Frontend framework:** React + Zustand recommended (matches ComfyUI web approach; good ecosystem for canvas libraries like `@xyflow/react` / React Flow which handles most of Section 4 out of the box)
- [ ] **Canvas library choice:** React Flow vs. custom SVG canvas vs. Canvas2D. React Flow handles ports, edges, and dragging — strongly recommended to avoid reimplementing Section 4 from scratch
- [ ] **Backend language:** FastAPI (Python) recommended — all AI SDKs have first-class Python support, and the async patterns in Section 7 translate directly
- [ ] **State persistence:** Zustand + localStorage for canvas state; SQLite (via `sqlite3` or `sqlmodel`) for execution history and cache

### 12.2 API Key Management
- [ ] Decide whether keys live in `.env` (single user, local) or in a settings UI with encrypted storage (multi-user)
- [ ] Build a "Key Status" panel on first launch that pings each provider's cheapest endpoint to verify key validity before the user starts building

### 12.3 Media Handling
- [ ] **Image storage:** Decide between URL references (just store the remote URL) vs. local file cache (download and store). URL-only is simpler but URLs expire (OpenAI URLs expire after 60 minutes)
- [ ] **Base64 vs URL:** Some nodes require base64 input; build a utility that auto-converts on connection if the upstream provides a URL and the downstream needs base64
- [ ] **Video storage:** All video URLs from FAL, Runway, and Kling are temporary. Build a "Download & Cache" step that saves mp4 to `/output/` on completion

### 12.4 Error Handling
- [ ] Define retry policy per provider: OpenAI/Anthropic → retry 3× with exponential backoff; Runway/Kling (async) → extend poll timeout before error
- [ ] Rate limit awareness: build a per-provider token bucket so rapid executions queue rather than 429-fail
- [ ] Differentiate retryable errors (rate limit, timeout) from fatal errors (invalid key, invalid param) at the UI level

### 12.5 Spec Gaps to Resolve Before Building
- [ ] **Kling direct API vs fal.ai:** Decide whether to use the fal.ai SDK as the single integration point for all Kling, Wan, Seedance, LTX, Pixverse, and Luma models (simpler, one auth key) vs. direct provider APIs (lower latency, lower cost, no FAL markup)
- [ ] **MiniMax file retrieval:** MiniMax video output requires a second API call to retrieve the file by `file_id` — implement the 3-step pattern (submit → poll status → fetch file) in `minimax.py` handler
- [ ] **OpenRouter image generation:** OR routes image gen through `chat/completions` with `modalities: ["image"]`, not through `/v1/images/generations`. The frontend must handle `delta.images[]` in the response stream, not the standard `data[].b64_json` format
- [ ] **SVG output handling:** The frontend needs an SVG preview renderer in the node body (not just an `<img>` tag) and an SVG-to-Raster conversion utility node
- [ ] **Recraft style IDs:** The `style_id` param points to user-created styles in Recraft's gallery — build a style picker that fetches the user's saved styles from `GET /v1/styles`
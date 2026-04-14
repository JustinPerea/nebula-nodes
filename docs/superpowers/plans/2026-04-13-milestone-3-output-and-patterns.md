# Milestone 3: Output & Patterns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three execution patterns (cache, async-poll, streaming) and two new model handlers (Runway Gen-4 Turbo, Claude chat) so the canvas supports video generation via polling and streamed text generation with live character-by-character preview — while skipping redundant API calls through an in-memory SHA256 execution cache.

**Architecture:** The execution cache sits between the engine's orchestration loop and the handler call. Before invoking a handler, the engine computes a SHA256 cache key from `nodeType + JSON(params) + JSON(inputs)` and checks the in-memory cache. On hit, it emits `executed` with cached outputs and skips the API call. On miss, it runs the handler and stores the result with a TTL. The async-poll runner is a generic loop: submit a job, poll a status endpoint every 2 seconds, emit progress events proportional to elapsed time, and return the result on terminal state. The stream runner opens an SSE HTTP connection, parses `data:` lines, emits `stream_delta` WebSocket events as text arrives, and accumulates the full response. Both new handlers (Runway, Claude) use these generic runners so future async/streaming nodes require only a thin adapter.

**Tech Stack:** Python 3.12+, FastAPI, uvicorn, httpx, Pydantic v2, hashlib (stdlib), Vite dev proxy, Zustand, TypeScript

**Reference docs:**
- Design spec: `docs/superpowers/specs/2026-04-13-nebula-node-design.md`
- Architecture spec: `docs/perplexity-research/AI Node Editor — Architecture & Interaction Spec v2.md`
- Edge cases: `docs/perplexity-research/nebula-edge-cases.md`
- Milestone 2 plan: `docs/superpowers/plans/2026-04-13-milestone-2-first-execution.md`

---

## File Structure (new and modified files)

```
nebula_nodes/
├── backend/
│   ├── main.py                            # MODIFY: add stream_delta to _event_to_camel, pass cache to engine
│   ├── models/
│   │   ├── __init__.py                    # MODIFY: export StreamDeltaEvent
│   │   └── events.py                      # MODIFY: add StreamDeltaEvent to ExecutionEvent union
│   ├── execution/
│   │   ├── engine.py                      # MODIFY: integrate execution cache into handler loop
│   │   ├── async_poll_runner.py           # NEW: generic async-poll execution pattern
│   │   └── stream_runner.py               # NEW: generic SSE streaming execution pattern
│   ├── handlers/
│   │   ├── openai_image.py                # (unchanged)
│   │   ├── runway.py                      # NEW: Runway Gen-4 Turbo handler
│   │   └── anthropic_chat.py              # NEW: Claude chat handler with streaming
│   ├── services/
│   │   ├── cache.py                       # NEW: in-memory execution cache with SHA256 keys
│   │   └── output.py                      # MODIFY: add save_video_from_url()
│   └── tests/
│       ├── test_cache.py                  # NEW: cache unit tests
│       ├── test_runway_handler.py         # NEW: Runway handler tests (mocked HTTP)
│       └── test_anthropic_handler.py      # NEW: Claude chat handler tests (mocked streaming)
│
├── frontend/
│   ├── src/
│   │   ├── lib/
│   │   │   └── wsClient.ts               # MODIFY: add streamDelta to ExecutionEvent type
│   │   ├── store/
│   │   │   └── graphStore.ts              # MODIFY: handle streamDelta, add streamingText to NodeData
│   │   ├── types/
│   │   │   └── index.ts                   # MODIFY: add streamingText field to NodeData
│   │   └── components/
│   │       ├── nodes/
│   │       │   └── ModelNode.tsx           # MODIFY: render text preview + streaming text
│   │       └── styles/
│   │           └── nodes.css              # MODIFY: add text preview styles
```

---

## Task 1: Execution Cache with Tests

**Files:**
- Create: `backend/services/cache.py`
- Create: `backend/tests/test_cache.py`

### Estimated time: 8 minutes

- [ ] **Step 1: Create services/cache.py**

Create `backend/services/cache.py`:

```python
from __future__ import annotations

import hashlib
import json
import time
from typing import Any


class ExecutionCache:
    """In-memory execution cache with SHA256 keys and TTL-based expiry.

    Cache key is computed from nodeType + params + resolved inputs, so any
    change to params or upstream output naturally produces a different key
    (no explicit invalidation needed for MVP).
    """

    def __init__(self, ttl: int = 3600) -> None:
        self._store: dict[str, tuple[dict[str, Any], float]] = {}
        self._ttl = ttl

    @staticmethod
    def get_key(
        node_type: str,
        params: dict[str, Any],
        inputs: dict[str, Any],
    ) -> str:
        """Compute a deterministic SHA256 cache key.

        The key is derived from the node definition ID, the full params dict,
        and the resolved input values dict. JSON serialization with sorted keys
        ensures determinism regardless of insertion order.
        """
        raw = json.dumps(
            {"nodeType": node_type, "params": params, "inputs": inputs},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(self, key: str) -> dict[str, Any] | None:
        """Return cached outputs if key exists and has not expired. Otherwise None."""
        entry = self._store.get(key)
        if entry is None:
            return None
        outputs, timestamp = entry
        if time.monotonic() - timestamp > self._ttl:
            del self._store[key]
            return None
        return outputs

    def set(self, key: str, outputs: dict[str, Any]) -> None:
        """Store outputs under the given key with current timestamp."""
        self._store[key] = (outputs, time.monotonic())

    def clear(self) -> None:
        """Remove all entries."""
        self._store.clear()

    @property
    def size(self) -> int:
        return len(self._store)
```

- [ ] **Step 2: Write cache tests (TDD — these should pass after Step 1)**

Create `backend/tests/test_cache.py`:

```python
from __future__ import annotations

import time
from unittest.mock import patch

from services.cache import ExecutionCache


class TestGetKey:
    def test_deterministic_for_same_inputs(self) -> None:
        key1 = ExecutionCache.get_key(
            "gpt-image-1-generate",
            {"model": "gpt-image-1", "size": "1024x1024"},
            {"prompt": {"type": "Text", "value": "a red pixel"}},
        )
        key2 = ExecutionCache.get_key(
            "gpt-image-1-generate",
            {"model": "gpt-image-1", "size": "1024x1024"},
            {"prompt": {"type": "Text", "value": "a red pixel"}},
        )
        assert key1 == key2
        assert len(key1) == 64  # SHA256 hex digest

    def test_different_params_produce_different_keys(self) -> None:
        base_params = {"model": "gpt-image-1", "size": "1024x1024"}
        changed_params = {"model": "gpt-image-1", "size": "1536x1024"}
        inputs = {"prompt": {"type": "Text", "value": "hello"}}

        key1 = ExecutionCache.get_key("gpt-image-1-generate", base_params, inputs)
        key2 = ExecutionCache.get_key("gpt-image-1-generate", changed_params, inputs)
        assert key1 != key2

    def test_different_inputs_produce_different_keys(self) -> None:
        params = {"model": "gpt-image-1"}
        inputs_a = {"prompt": {"type": "Text", "value": "cat"}}
        inputs_b = {"prompt": {"type": "Text", "value": "dog"}}

        key1 = ExecutionCache.get_key("gpt-image-1-generate", params, inputs_a)
        key2 = ExecutionCache.get_key("gpt-image-1-generate", params, inputs_b)
        assert key1 != key2

    def test_different_node_types_produce_different_keys(self) -> None:
        params = {"model": "x"}
        inputs = {"text": {"type": "Text", "value": "hello"}}

        key1 = ExecutionCache.get_key("claude-chat", params, inputs)
        key2 = ExecutionCache.get_key("gpt-image-1-generate", params, inputs)
        assert key1 != key2

    def test_dict_key_order_does_not_affect_key(self) -> None:
        params_a = {"size": "1024x1024", "model": "gpt-image-1"}
        params_b = {"model": "gpt-image-1", "size": "1024x1024"}
        inputs = {"prompt": {"type": "Text", "value": "test"}}

        key1 = ExecutionCache.get_key("gpt-image-1-generate", params_a, inputs)
        key2 = ExecutionCache.get_key("gpt-image-1-generate", params_b, inputs)
        assert key1 == key2


class TestCacheGetSet:
    def test_miss_returns_none(self) -> None:
        cache = ExecutionCache(ttl=3600)
        assert cache.get("nonexistent") is None

    def test_hit_returns_stored_outputs(self) -> None:
        cache = ExecutionCache(ttl=3600)
        outputs = {"image": {"type": "Image", "value": "/output/test.png"}}
        cache.set("abc123", outputs)
        assert cache.get("abc123") == outputs

    def test_expired_entry_returns_none(self) -> None:
        cache = ExecutionCache(ttl=1)  # 1-second TTL
        outputs = {"text": {"type": "Text", "value": "hello"}}
        cache.set("key1", outputs)

        # Patch time.monotonic to simulate expiry
        original_time = time.monotonic()
        with patch("services.cache.time.monotonic", return_value=original_time + 2):
            assert cache.get("key1") is None
        assert cache.size == 0  # Entry was evicted

    def test_not_expired_entry_returns_value(self) -> None:
        cache = ExecutionCache(ttl=3600)
        outputs = {"text": {"type": "Text", "value": "hello"}}
        cache.set("key1", outputs)

        original_time = time.monotonic()
        with patch("services.cache.time.monotonic", return_value=original_time + 100):
            assert cache.get("key1") == outputs

    def test_clear_removes_all_entries(self) -> None:
        cache = ExecutionCache(ttl=3600)
        cache.set("a", {"x": 1})
        cache.set("b", {"y": 2})
        assert cache.size == 2
        cache.clear()
        assert cache.size == 0
        assert cache.get("a") is None

    def test_overwrite_existing_key(self) -> None:
        cache = ExecutionCache(ttl=3600)
        cache.set("key1", {"v": 1})
        cache.set("key1", {"v": 2})
        assert cache.get("key1") == {"v": 2}
        assert cache.size == 1


class TestCacheIntegrationFlow:
    def test_full_round_trip_with_real_key(self) -> None:
        cache = ExecutionCache(ttl=3600)
        key = ExecutionCache.get_key(
            "gpt-image-1-generate",
            {"model": "gpt-image-1"},
            {"prompt": {"type": "Text", "value": "a red pixel"}},
        )
        assert cache.get(key) is None  # Miss

        outputs = {"image": {"type": "Image", "value": "/output/2026-04-13/abc.png"}}
        cache.set(key, outputs)
        assert cache.get(key) == outputs  # Hit
```

- [ ] **Step 3: Run cache tests**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_cache.py -v
```

Expected: All 10 tests pass.

- [ ] **Step 4: Commit**

```
feat(backend): add in-memory execution cache with SHA256 keys and TTL expiry
```

---

## Task 2: Integrate Cache into Execution Engine

**Files:**
- Modify: `backend/execution/engine.py`
- Modify: `backend/main.py`

### Estimated time: 6 minutes

- [ ] **Step 1: Add cache import and parameter to execute_graph**

In `backend/execution/engine.py`, add the cache import at the top:

```python
# Add this import at the top, after existing imports:
from services.cache import ExecutionCache
```

Then modify the `execute_graph` function signature to accept an optional cache:

Replace the current `execute_graph` function (lines 142-203) with:

```python
async def execute_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
    handler_registry: dict[str, NodeHandler],
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    cache: ExecutionCache | None = None,
) -> None:
    start_time = time.monotonic()
    nodes_executed = 0
    node_map: dict[str, GraphNode] = {n.id: n for n in nodes}
    outputs_cache: dict[str, dict[str, PortValueDict]] = {}
    order = topological_sort(nodes, edges)

    for nid in order:
        await emit(QueuedEvent(node_id=nid))

    for nid in order:
        node = node_map[nid]
        await emit(ExecutingEvent(node_id=nid))

        resolved_inputs: dict[str, PortValueDict] = {}
        for edge in edges:
            if edge.target == nid and edge.source_handle and edge.target_handle:
                upstream_outputs = outputs_cache.get(edge.source, {})
                if edge.source_handle in upstream_outputs:
                    resolved_inputs[edge.target_handle] = upstream_outputs[edge.source_handle]

        try:
            # --- Cache check ---
            cache_key: str | None = None
            if cache is not None:
                inputs_for_key = {
                    k: {"type": v.type, "value": v.value}
                    for k, v in resolved_inputs.items()
                }
                cache_key = ExecutionCache.get_key(
                    node.definition_id, dict(node.params), inputs_for_key
                )
                cached_outputs = cache.get(cache_key)
                if cached_outputs is not None:
                    outputs_cache[nid] = {
                        k: PortValueDict(type=v.get("type", "Any"), value=v.get("value"))
                        for k, v in cached_outputs.items()
                    }
                    await emit(ExecutedEvent(node_id=nid, outputs=cached_outputs))
                    nodes_executed += 1
                    continue

            # --- Execute handler ---
            handler = handler_registry.get(node.definition_id)
            if handler is None:
                if node.definition_id == "text-input":
                    text_value = node.params.get("value", "")
                    node_outputs = {"text": {"type": "Text", "value": str(text_value)}}
                elif node.definition_id == "image-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {"image": {"type": "Image", "value": str(file_path)}}
                elif node.definition_id == "preview":
                    node_outputs = {}
                    if "input" in resolved_inputs:
                        node_outputs["input"] = {
                            "type": resolved_inputs["input"].type,
                            "value": resolved_inputs["input"].value,
                        }
                else:
                    raise RuntimeError(f"No handler registered for '{node.definition_id}'")
            else:
                node_outputs = await handler(node, resolved_inputs, api_keys)

            outputs_cache[nid] = {
                k: PortValueDict(type=v.get("type", "Any"), value=v.get("value"))
                for k, v in node_outputs.items()
            }

            # --- Cache store (only on success, only for handler-executed nodes) ---
            if cache is not None and cache_key is not None and handler is not None:
                cache.set(cache_key, node_outputs)

            await emit(ExecutedEvent(node_id=nid, outputs=node_outputs))
            nodes_executed += 1

        except Exception as exc:
            await emit(ErrorEvent(node_id=nid, error=str(exc), retryable=False))
            break

    duration = time.monotonic() - start_time
    await emit(GraphCompleteEvent(duration=round(duration, 3), nodes_executed=nodes_executed))
```

Key decisions:
- Cache is only checked for nodes that have a registered handler (utility nodes like text-input are cheap, no point caching).
- Only successful handler results are cached (errors are never cached).
- The cache is optional (`None` = no caching) so existing tests don't break.

- [ ] **Step 2: Create a module-level cache singleton and pass it from main.py**

In `backend/main.py`, add the cache import and create a singleton:

After the existing imports, add:

```python
from services.cache import ExecutionCache
```

After the `manager = ConnectionManager()` line, add:

```python
execution_cache = ExecutionCache(ttl=3600)
```

Then in the `_run()` closure inside the `execute` endpoint, pass the cache:

Replace the `_run` function inside `execute()`:

```python
    async def _run() -> None:
        await execute_graph(
            nodes=request.nodes,
            edges=request.edges,
            api_keys=api_keys,
            handler_registry=handler_registry,
            emit=manager.broadcast,
            cache=execution_cache,
        )
```

- [ ] **Step 3: Verify existing tests still pass**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_engine.py tests/test_openai_handler.py -v
```

Expected: All 12 existing tests pass (the cache parameter defaults to `None`, so no behavior change).

- [ ] **Step 4: Commit**

```
feat(backend): integrate execution cache into engine — skip identical re-runs
```

---

## Task 3: StreamDelta Event Type (Backend + Frontend)

**Files:**
- Modify: `backend/models/events.py`
- Modify: `backend/models/__init__.py`
- Modify: `backend/main.py` (camelCase handler)
- Modify: `frontend/src/lib/wsClient.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/src/components/nodes/ModelNode.tsx`
- Modify: `frontend/src/styles/nodes.css`

### Estimated time: 12 minutes

- [ ] **Step 1: Add StreamDeltaEvent to backend events.py**

In `backend/models/events.py`, add a new class before the `ExecutionEvent` union:

```python
class StreamDeltaEvent(BaseModel):
    type: Literal["stream_delta"] = "stream_delta"
    node_id: str
    delta: str
    accumulated: str
```

Then update the `ExecutionEvent` union to include it:

```python
ExecutionEvent = Union[
    QueuedEvent,
    ExecutingEvent,
    ProgressEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorEvent,
    GraphCompleteEvent,
    StreamDeltaEvent,
]
```

- [ ] **Step 2: Export StreamDeltaEvent from models/__init__.py**

In `backend/models/__init__.py`, add `StreamDeltaEvent` to both the import and `__all__`:

Add to the import block:

```python
from .events import (
    ExecutionEvent,
    QueuedEvent,
    ExecutingEvent,
    ProgressEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorEvent,
    ValidationErrorDetail,
    GraphCompleteEvent,
    StreamDeltaEvent,
)
```

Add `"StreamDeltaEvent"` to the `__all__` list.

- [ ] **Step 3: Verify backend models import cleanly**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "
from models import StreamDeltaEvent
e = StreamDeltaEvent(node_id='n1', delta='Hello', accumulated='Hello')
print(e.model_dump())
# Expected: {'type': 'stream_delta', 'node_id': 'n1', 'delta': 'Hello', 'accumulated': 'Hello'}
"
```

- [ ] **Step 4: Add streamDelta to frontend ExecutionEvent type**

In `frontend/src/lib/wsClient.ts`, add the `streamDelta` variant to the `ExecutionEvent` union type:

```typescript
export type ExecutionEvent =
  | { type: 'queued'; nodeId: string }
  | { type: 'executing'; nodeId: string }
  | { type: 'progress'; nodeId: string; value: number }
  | { type: 'executed'; nodeId: string; outputs: Record<string, { type: string; value: string | null }> }
  | { type: 'error'; nodeId: string; error: string; retryable: boolean }
  | { type: 'validationError'; errors: Array<{ nodeId: string; portId: string; message: string }> }
  | { type: 'graphComplete'; duration: number; nodesExecuted: number }
  | { type: 'streamDelta'; nodeId: string; delta: string; accumulated: string };
```

- [ ] **Step 5: Add streamingText to NodeData in types/index.ts**

In `frontend/src/types/index.ts`, add the `streamingText` field to `NodeData`:

```typescript
export interface NodeData {
  label: string;
  definitionId: string;
  params: Record<string, unknown>;
  state: NodeState;
  progress?: number;
  outputs: Record<string, PortValue>;
  error?: string;
  keyStatus?: 'ok' | 'missing';
  streamingText?: string;
}
```

- [ ] **Step 6: Handle streamDelta in graphStore.ts**

In `frontend/src/store/graphStore.ts`, add a `streamDelta` case to the `handleExecutionEvent` switch:

After the `case 'executed'` block and before `case 'error'`, add:

```typescript
      case 'streamDelta':
        get().updateNodeData(event.nodeId, { streamingText: event.accumulated });
        break;
```

Also modify the `case 'executing'` handler to clear streamingText when execution starts:

```typescript
      case 'executing':
        get().updateNodeData(event.nodeId, { state: 'executing', progress: 0, streamingText: undefined });
        break;
```

And in `case 'executed'`, clear streamingText when execution completes:

```typescript
      case 'executed': {
        const outputs: Record<string, { type: string; value: string | null }> = {};
        for (const [key, val] of Object.entries(event.outputs)) {
          const outputVal = val as { type: string; value: string | null };
          if (outputVal.type === 'Image' && outputVal.value && typeof outputVal.value === 'string') {
            const outputIdx = outputVal.value.indexOf('/output/');
            if (outputIdx !== -1) {
              const relativePath = outputVal.value.substring(outputIdx + '/output/'.length);
              outputs[key] = { type: outputVal.type, value: `/api/outputs/${relativePath}` };
            } else {
              outputs[key] = outputVal;
            }
          } else {
            outputs[key] = outputVal;
          }
        }
        get().updateNodeData(event.nodeId, { state: 'complete', outputs, progress: undefined, streamingText: undefined });
        break;
      }
```

- [ ] **Step 7: Render text preview and streaming text in ModelNode.tsx**

Replace the entire `ModelNode.tsx` with:

```tsx
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import '../../styles/nodes.css';

function ModelNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const selectNode = useUIStore((s) => s.selectNode);

  if (!definition) return <div className="model-node model-node--error">Unknown node type</div>;

  const categoryColor = CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;
  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const videoOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Video' && o.value);

  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;

  return (
    <div className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`} onClick={() => selectNode(id)}>
      <div className="model-node__header">
        <span className="model-node__category-dot" style={{ backgroundColor: categoryColor }} />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && <span className="model-node__badge model-node__badge--warning" title="API Key Missing">&#9888;</span>}
      </div>

      {definition.inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {definition.inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle type="target" position={Position.Left} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
              <span className="model-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      )}

      {nodeData.state === 'executing' && nodeData.progress !== undefined && !isStreaming && (
        <div className="model-node__progress">
          <div className="model-node__progress-bar" style={{ width: `${Math.round(nodeData.progress * 100)}%` }} />
        </div>
      )}

      {nodeData.state === 'complete' && imageOutput && typeof imageOutput.value === 'string' && (
        <div className="model-node__preview">
          <img src={imageOutput.value} alt="Generated output" className="model-node__preview-image" loading="lazy" />
        </div>
      )}

      {displayText && (
        <div className="model-node__preview">
          <div className={`model-node__preview-text ${isStreaming ? 'model-node__preview-text--streaming' : ''}`}>
            {displayText.length > 300 ? `${displayText.slice(0, 300)}...` : displayText}
          </div>
        </div>
      )}

      {nodeData.state === 'complete' && videoOutput && typeof videoOutput.value === 'string' && (
        <div className="model-node__preview">
          <div className="model-node__preview-placeholder">Video ready</div>
        </div>
      )}

      {nodeData.state === 'complete' && !imageOutput && !textOutput && !videoOutput && Object.keys(nodeData.outputs).length > 0 && (
        <div className="model-node__preview">
          <div className="model-node__preview-placeholder">Output ready</div>
        </div>
      )}

      {nodeData.state === 'error' && nodeData.error && (
        <div className="model-node__error">{nodeData.error}</div>
      )}

      {definition.outputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--output">
          {definition.outputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row model-node__port-row--output">
              <span className="model-node__port-label">{port.label}</span>
              <Handle type="source" position={Position.Right} id={port.id} className="model-node__handle" style={{ backgroundColor: PORT_COLORS[port.dataType] }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const ModelNode = memo(ModelNodeComponent);
```

- [ ] **Step 8: Add text preview CSS styles**

In `frontend/src/styles/nodes.css`, add these styles at the end of the file:

```css
.model-node__preview-text {
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px;
  font-size: 11px;
  line-height: 1.5;
  color: #aaa;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: #333 transparent;
}

.model-node__preview-text--streaming {
  border-color: #2196F3;
  color: #ccc;
}

.model-node__preview-text--streaming::after {
  content: '\25AE';
  animation: blink-cursor 0.8s step-end infinite;
  color: #2196F3;
  margin-left: 1px;
}

@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

- [ ] **Step 9: Verify frontend compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npm run build
```

Expected: Build succeeds with no type errors.

- [ ] **Step 10: Commit**

```
feat: add StreamDelta event type with text preview and streaming cursor in ModelNode
```

---

## Task 4: Async-Poll Runner

**Files:**
- Create: `backend/execution/async_poll_runner.py`

### Estimated time: 6 minutes

- [ ] **Step 1: Create execution/async_poll_runner.py**

Create `backend/execution/async_poll_runner.py`:

```python
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from models.events import ExecutionEvent, ProgressEvent


@dataclass
class AsyncPollConfig:
    """Configuration for a generic async-poll execution pattern.

    submit_url: The URL to POST the initial job request to.
    poll_url_template: A format string with {task_id} placeholder, e.g.
        "https://api.dev.runwayml.com/v1/tasks/{task_id}"
    headers: HTTP headers for both submit and poll requests.
    terminal_success: Set of status strings that mean the job succeeded.
    terminal_failure: Set of status strings that mean the job failed.
    status_path: Dot-separated path to the status field in the poll response JSON.
        e.g. "status" means response["status"]. Defaults to "status".
    task_id_path: Dot-separated path to the task ID in the submit response JSON.
        e.g. "id" means response["id"]. Defaults to "id".
    poll_interval: Seconds between poll requests. Default 2.
    max_polls: Maximum number of polls before timeout. Default 300 (10 min at 2s).
    timeout: HTTP timeout per request in seconds. Default 30.
    """
    submit_url: str
    poll_url_template: str
    headers: dict[str, str]
    terminal_success: set[str]
    terminal_failure: set[str]
    status_path: str = "status"
    task_id_path: str = "id"
    poll_interval: float = 2.0
    max_polls: int = 300
    timeout: float = 30.0


def _get_nested(data: dict[str, Any], path: str) -> Any:
    """Get a value from a nested dict using a dot-separated path."""
    current = data
    for key in path.split("."):
        if isinstance(current, dict):
            current = current[key]
        else:
            raise KeyError(f"Cannot traverse path '{path}' — hit non-dict at '{key}'")
    return current


async def async_poll_execute(
    config: AsyncPollConfig,
    submit_body: dict[str, Any],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> dict[str, Any]:
    """Submit a job and poll until completion.

    Returns the final poll response JSON on success.
    Raises RuntimeError on failure or timeout.
    Emits ProgressEvent proportional to elapsed polls / max_polls.
    """
    async with httpx.AsyncClient(timeout=config.timeout) as client:
        # --- Submit ---
        submit_resp = await client.post(
            config.submit_url,
            headers=config.headers,
            json=submit_body,
        )
        if submit_resp.status_code not in (200, 201):
            raise RuntimeError(
                f"Async submit failed ({submit_resp.status_code}): {submit_resp.text}"
            )

        submit_data = submit_resp.json()
        task_id = str(_get_nested(submit_data, config.task_id_path))
        poll_url = config.poll_url_template.format(task_id=task_id)

        # --- Poll loop ---
        for poll_num in range(1, config.max_polls + 1):
            await asyncio.sleep(config.poll_interval)

            poll_resp = await client.get(poll_url, headers=config.headers)
            if poll_resp.status_code != 200:
                raise RuntimeError(
                    f"Poll request failed ({poll_resp.status_code}): {poll_resp.text}"
                )

            poll_data = poll_resp.json()
            status = str(_get_nested(poll_data, config.status_path))

            # Emit progress proportional to elapsed polls
            progress = min(poll_num / config.max_polls, 0.99)
            await emit(ProgressEvent(node_id=node_id, value=progress))

            if status in config.terminal_success:
                return poll_data

            if status in config.terminal_failure:
                error_msg = poll_data.get("error", poll_data.get("failure", f"Job failed with status: {status}"))
                raise RuntimeError(f"Async job failed: {error_msg}")

        raise RuntimeError(
            f"Async job timed out after {config.max_polls} polls "
            f"({config.max_polls * config.poll_interval:.0f}s)"
        )
```

- [ ] **Step 2: Verify import works**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
print('AsyncPollConfig fields:', [f.name for f in AsyncPollConfig.__dataclass_fields__.values()])
print('Import OK')
"
```

- [ ] **Step 3: Commit**

```
feat(backend): add generic async-poll runner for job submission and status polling
```

---

## Task 5: Runway Gen-4 Turbo Handler with Tests

**Files:**
- Modify: `backend/services/output.py` (add `save_video_from_url`)
- Create: `backend/handlers/runway.py`
- Create: `backend/tests/test_runway_handler.py`

### Estimated time: 15 minutes

- [ ] **Step 1: Add save_video_from_url to output service**

In `backend/services/output.py`, add this function at the end:

```python
async def save_video_from_url(url: str, run_dir: Path, extension: str = "mp4") -> Path:
    """Download a video from a URL and save to the run directory.

    Runway video URLs are temporary — they expire after a few hours.
    This downloads the video to local storage so it persists.
    """
    import httpx

    filename = f"{uuid4().hex[:12]}.{extension}"
    file_path = run_dir / filename

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        file_path.write_bytes(response.content)

    return file_path
```

- [ ] **Step 2: Add image_to_data_uri helper to output service**

In `backend/services/output.py`, add this function:

```python
def image_to_data_uri(file_path: Path) -> str:
    """Read a local image file and convert to a base64 data URI.

    Runway requires images as HTTPS URLs or data:image URIs — not file paths.
    Since our images are local files from upstream node outputs, we need this
    conversion before sending to Runway.
    """
    image_bytes = file_path.read_bytes()
    b64 = base64.b64encode(image_bytes).decode("ascii")
    suffix = file_path.suffix.lstrip(".").lower()
    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
    mime = mime_map.get(suffix, "image/png")
    return f"data:{mime};base64,{b64}"
```

- [ ] **Step 3: Create handlers/runway.py**

Create `backend/handlers/runway.py`:

```python
from __future__ import annotations

from pathlib import Path
from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
from services.output import get_run_dir, save_video_from_url, image_to_data_uri

RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1"


async def handle_runway_gen4_turbo(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Handle Runway Gen-4 Turbo video generation.

    Takes an image input (required) and optional text prompt. Submits the job
    to Runway's async API, polls for completion, downloads the video, and
    returns the local file path.

    CRITICAL: Runway expects the image as an HTTPS URL or a data:image URI.
    Since our upstream images are local files, we read the file and encode it
    as a base64 data URI before sending.
    """
    # --- Validate inputs ---
    image_input = inputs.get("image")
    if not image_input or not image_input.value:
        raise ValueError("Image input is required for Runway Gen-4 Turbo")

    image_value = str(image_input.value)

    # Convert local file path to data URI for Runway
    if not image_value.startswith(("http://", "https://", "data:")):
        image_path = Path(image_value)
        if not image_path.exists():
            raise ValueError(f"Image file not found: {image_value}")
        image_value = image_to_data_uri(image_path)

    api_key = api_keys.get("RUNWAY_API_KEY")
    if not api_key:
        raise ValueError("RUNWAY_API_KEY is required")

    # --- Build request body ---
    model = node.params.get("model", "gen4_turbo")
    duration = int(node.params.get("duration", 5))

    submit_body: dict[str, Any] = {
        "model": model,
        "promptImage": image_value,
        "duration": duration,
    }

    # Optional text prompt
    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        prompt_text = str(prompt_input.value)[:1000]  # Runway limit
        submit_body["promptText"] = prompt_text

    # Optional params
    ratio = node.params.get("ratio")
    if ratio:
        submit_body["ratio"] = ratio

    seed = node.params.get("seed")
    if seed is not None:
        submit_body["seed"] = int(seed)

    watermark = node.params.get("watermark")
    if watermark is not None:
        submit_body["watermark"] = bool(watermark)

    # --- Async-poll config ---
    config = AsyncPollConfig(
        submit_url=f"{RUNWAY_API_BASE}/tasks",
        poll_url_template=f"{RUNWAY_API_BASE}/tasks/{{task_id}}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Runway-Version": "2024-11-06",
        },
        terminal_success={"SUCCEEDED"},
        terminal_failure={"FAILED"},
        status_path="status",
        task_id_path="id",
        poll_interval=2.0,
        max_polls=300,
    )

    # Use a no-op emit if none provided (for testing)
    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    actual_emit = emit or noop_emit

    # --- Execute ---
    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=actual_emit,
    )

    # --- Download video ---
    # Runway returns output as a list of URLs in result["output"]
    output_urls = result.get("output", [])
    if not output_urls:
        raise RuntimeError("Runway returned no output URLs")

    video_url = output_urls[0] if isinstance(output_urls, list) else str(output_urls)

    run_dir = get_run_dir()
    video_path = await save_video_from_url(video_url, run_dir)

    return {
        "video": {
            "type": "Video",
            "value": str(video_path),
        }
    }
```

- [ ] **Step 4: Write Runway handler tests**

Create `backend/tests/test_runway_handler.py`:

```python
from __future__ import annotations

import base64
import shutil
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from handlers.runway import handle_runway_gen4_turbo
from models.graph import GraphNode, PortValueDict
from services.output import OUTPUT_ROOT

# 1x1 red pixel PNG for testing
RED_PIXEL_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
    "2mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
)

# Fake MP4 bytes (just needs to be non-empty for test)
FAKE_VIDEO_BYTES = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00"


def _make_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="test-runway-1",
        definitionId="runway-gen4-turbo",
        params=params or {"model": "gen4_turbo", "duration": 5},
    )


def _create_test_image(tmp_path: Path) -> Path:
    """Create a real PNG file on disk for the handler to read."""
    img_path = tmp_path / "test_input.png"
    img_path.write_bytes(base64.b64decode(RED_PIXEL_B64))
    return img_path


@pytest.fixture(autouse=True)
def cleanup_output():
    yield
    if OUTPUT_ROOT.exists():
        shutil.rmtree(OUTPUT_ROOT)


@pytest.mark.asyncio
async def test_submits_job_and_returns_video(tmp_path: Path) -> None:
    """Full happy path: submit -> poll (SUCCEEDED) -> download video."""
    img_path = _create_test_image(tmp_path)

    # Mock the async_poll_execute to return a successful result
    mock_result = {
        "id": "task-abc123",
        "status": "SUCCEEDED",
        "output": ["https://runway-cdn.example.com/video.mp4"],
    }

    mock_emit = AsyncMock()

    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = mock_result

        # Mock save_video_from_url to avoid real HTTP call
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            video_path = tmp_path / "output.mp4"
            video_path.write_bytes(FAKE_VIDEO_BYTES)
            mock_save.return_value = video_path

            node = _make_node()
            inputs = {"image": PortValueDict(type="Image", value=str(img_path))}
            api_keys = {"RUNWAY_API_KEY": "rw-test-key"}

            result = await handle_runway_gen4_turbo(node, inputs, api_keys, emit=mock_emit)

    assert "video" in result
    assert result["video"]["type"] == "Video"
    assert result["video"]["value"] == str(video_path)

    # Verify submit body was correct
    call_kwargs = mock_poll.call_args
    submit_body = call_kwargs.kwargs.get("submit_body") or call_kwargs[1].get("submit_body")
    assert submit_body["model"] == "gen4_turbo"
    assert submit_body["duration"] == 5
    assert submit_body["promptImage"].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_includes_text_prompt_when_provided(tmp_path: Path) -> None:
    img_path = _create_test_image(tmp_path)
    mock_result = {
        "id": "task-abc123",
        "status": "SUCCEEDED",
        "output": ["https://example.com/video.mp4"],
    }

    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = mock_result
        with patch("handlers.runway.save_video_from_url", new_callable=AsyncMock) as mock_save:
            mock_save.return_value = tmp_path / "video.mp4"
            (tmp_path / "video.mp4").write_bytes(FAKE_VIDEO_BYTES)

            node = _make_node()
            inputs = {
                "image": PortValueDict(type="Image", value=str(img_path)),
                "prompt": PortValueDict(type="Text", value="Camera slowly zooms in"),
            }
            api_keys = {"RUNWAY_API_KEY": "rw-test-key"}

            await handle_runway_gen4_turbo(node, inputs, api_keys)

    submit_body = mock_poll.call_args.kwargs.get("submit_body") or mock_poll.call_args[1].get("submit_body")
    assert submit_body["promptText"] == "Camera slowly zooms in"


@pytest.mark.asyncio
async def test_missing_image_raises() -> None:
    node = _make_node()
    inputs: dict[str, PortValueDict] = {}
    api_keys = {"RUNWAY_API_KEY": "rw-test-key"}

    with pytest.raises(ValueError, match="[Ii]mage.*required"):
        await handle_runway_gen4_turbo(node, inputs, api_keys)


@pytest.mark.asyncio
async def test_missing_api_key_raises(tmp_path: Path) -> None:
    img_path = _create_test_image(tmp_path)
    node = _make_node()
    inputs = {"image": PortValueDict(type="Image", value=str(img_path))}
    api_keys: dict[str, str] = {}

    with pytest.raises(ValueError, match="RUNWAY_API_KEY"):
        await handle_runway_gen4_turbo(node, inputs, api_keys)


@pytest.mark.asyncio
async def test_poll_failure_propagates(tmp_path: Path) -> None:
    img_path = _create_test_image(tmp_path)

    with patch("handlers.runway.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.side_effect = RuntimeError("Async job failed: Content moderation flagged")

        node = _make_node()
        inputs = {"image": PortValueDict(type="Image", value=str(img_path))}
        api_keys = {"RUNWAY_API_KEY": "rw-test-key"}

        with pytest.raises(RuntimeError, match="Content moderation"):
            await handle_runway_gen4_turbo(node, inputs, api_keys)
```

- [ ] **Step 5: Run Runway handler tests**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_runway_handler.py -v
```

Expected: All 5 tests pass.

- [ ] **Step 6: Commit**

```
feat(backend): add Runway Gen-4 Turbo handler with async-poll pattern and data URI conversion
```

---

## Task 6: Stream Runner

**Files:**
- Create: `backend/execution/stream_runner.py`

### Estimated time: 6 minutes

- [ ] **Step 1: Create execution/stream_runner.py**

Create `backend/execution/stream_runner.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from models.events import ExecutionEvent, StreamDeltaEvent


@dataclass
class StreamConfig:
    """Configuration for a generic SSE streaming execution pattern.

    url: The URL to POST the streaming request to.
    headers: HTTP headers for the request.
    event_type_filter: Only process SSE events with this event type.
        e.g. "content_block_delta" for Claude. If None, processes all data lines.
    delta_path: Dot-separated path to the text delta in the parsed JSON data line.
        e.g. "delta.text" for Claude's content_block_delta events.
    timeout: HTTP timeout in seconds (connection timeout, not read timeout).
        Stream read has no timeout — we read until the server closes.
    """
    url: str
    headers: dict[str, str]
    event_type_filter: str | None = None
    delta_path: str = "delta.text"
    timeout: float = 30.0
    extra_stop_events: set[str] = field(default_factory=lambda: {"message_stop"})


def _get_nested(data: dict[str, Any], path: str) -> Any:
    """Get a value from a nested dict using a dot-separated path."""
    current = data
    for key in path.split("."):
        if isinstance(current, dict):
            current = current.get(key)
            if current is None:
                return None
        else:
            return None
    return current


async def stream_execute(
    config: StreamConfig,
    request_body: dict[str, Any],
    node_id: str,
    emit: Callable[[ExecutionEvent], Awaitable[None]],
) -> str:
    """Open an SSE streaming HTTP connection and accumulate text.

    Emits StreamDeltaEvent for each text chunk received.
    Returns the full accumulated text on completion.

    SSE format:
        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

    Lines starting with "event:" set the current event type.
    Lines starting with "data:" contain JSON payload.
    Empty lines separate events.
    """
    accumulated = ""
    current_event_type: str | None = None

    async with httpx.AsyncClient(timeout=httpx.Timeout(config.timeout, read=None)) as client:
        async with client.stream(
            "POST",
            config.url,
            headers=config.headers,
            json=request_body,
        ) as response:
            if response.status_code != 200:
                # Read the error body
                error_body = ""
                async for chunk in response.aiter_text():
                    error_body += chunk
                raise RuntimeError(
                    f"Stream request failed ({response.status_code}): {error_body}"
                )

            async for line in response.aiter_lines():
                line = line.strip()

                if not line:
                    current_event_type = None
                    continue

                if line.startswith("event:"):
                    current_event_type = line[len("event:"):].strip()

                    # Check for stop events
                    if current_event_type in config.extra_stop_events:
                        continue
                    continue

                if line.startswith("data:"):
                    data_str = line[len("data:"):].strip()

                    # Skip [DONE] sentinel
                    if data_str == "[DONE]":
                        break

                    # Apply event type filter
                    if config.event_type_filter and current_event_type != config.event_type_filter:
                        continue

                    try:
                        import json
                        data = json.loads(data_str)
                    except (ValueError, TypeError):
                        continue

                    delta_text = _get_nested(data, config.delta_path)
                    if delta_text and isinstance(delta_text, str):
                        accumulated += delta_text
                        await emit(
                            StreamDeltaEvent(
                                node_id=node_id,
                                delta=delta_text,
                                accumulated=accumulated,
                            )
                        )

    return accumulated
```

- [ ] **Step 2: Verify import works**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "
from execution.stream_runner import StreamConfig, stream_execute
print('StreamConfig fields:', [f.name for f in StreamConfig.__dataclass_fields__.values()])
print('Import OK')
"
```

- [ ] **Step 3: Commit**

```
feat(backend): add generic SSE stream runner for streaming text execution
```

---

## Task 7: Claude Chat Handler with Tests

**Files:**
- Create: `backend/handlers/anthropic_chat.py`
- Create: `backend/tests/test_anthropic_handler.py`

### Estimated time: 15 minutes

- [ ] **Step 1: Create handlers/anthropic_chat.py**

Create `backend/handlers/anthropic_chat.py`:

```python
from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


async def handle_claude_chat(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """Handle Claude chat with streaming text output.

    Takes a messages input (required) and optional images. Sends to the
    Anthropic Messages API with stream:true, parses SSE content_block_delta
    events, accumulates text, and returns the full response.

    CRITICAL: Claude uses x-api-key header, NOT Bearer token.
    CRITICAL: Claude requires anthropic-version: 2023-06-01 header.
    CRITICAL: max_tokens is REQUIRED by the Anthropic API.
    """
    # --- Validate inputs ---
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required for Claude chat")

    messages_text = str(messages_input.value)

    api_key = api_keys.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY is required")

    # --- Build messages array ---
    # The input is a text string — wrap it as a single user message.
    # Future: support structured message arrays from upstream nodes.
    content: list[dict[str, Any]] = [{"type": "text", "text": messages_text}]

    # If images are connected, add them as image content blocks
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = (
            images_input.value
            if isinstance(images_input.value, list)
            else [images_input.value]
        )
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith("data:"):
                # Already a data URI — extract media type and base64 data
                # Format: data:image/png;base64,iVBOR...
                parts = img_str.split(",", 1)
                media_type = parts[0].split(":")[1].split(";")[0] if len(parts) > 1 else "image/png"
                b64_data = parts[1] if len(parts) > 1 else img_str
                content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64_data,
                    },
                })
            elif img_str.startswith(("http://", "https://")):
                content.append({
                    "type": "image",
                    "source": {"type": "url", "url": img_str},
                })
            else:
                # Local file path — read and encode
                from pathlib import Path
                import base64
                img_path = Path(img_str)
                if img_path.exists():
                    b64_data = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}
                    media_type = mime_map.get(suffix, "image/png")
                    content.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64_data,
                        },
                    })

    messages = [{"role": "user", "content": content}]

    # --- Build request body ---
    model = node.params.get("model", "claude-sonnet-4-6")
    max_tokens = int(node.params.get("max_tokens", 4096))
    temperature = node.params.get("temperature")

    request_body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": True,
    }

    if temperature is not None:
        request_body["temperature"] = float(temperature)

    system_prompt = node.params.get("system")
    if system_prompt:
        request_body["system"] = str(system_prompt)

    # --- Stream config ---
    config = StreamConfig(
        url=ANTHROPIC_API_URL,
        headers={
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        },
        event_type_filter="content_block_delta",
        delta_path="delta.text",
        timeout=30.0,
    )

    # Use a no-op emit if none provided (for testing without WS)
    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    actual_emit = emit or noop_emit

    # --- Execute stream ---
    full_text = await stream_execute(
        config=config,
        request_body=request_body,
        node_id=node.id,
        emit=actual_emit,
    )

    return {
        "text": {
            "type": "Text",
            "value": full_text,
        }
    }
```

- [ ] **Step 2: Write Claude handler tests**

Create `backend/tests/test_anthropic_handler.py`:

```python
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.anthropic_chat import handle_claude_chat, ANTHROPIC_API_URL, ANTHROPIC_VERSION
from models.graph import GraphNode, PortValueDict
from models.events import StreamDeltaEvent


def _make_node(params: dict | None = None) -> GraphNode:
    return GraphNode(
        id="test-claude-1",
        definitionId="claude-chat",
        params=params or {"model": "claude-sonnet-4-6", "max_tokens": 1024, "temperature": 0.7},
    )


class FakeStreamResponse:
    """Simulates an httpx streaming response with SSE content."""

    def __init__(self, sse_lines: list[str], status_code: int = 200) -> None:
        self.status_code = status_code
        self._lines = sse_lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_text(self):
        yield "error body"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def _make_sse_lines(text_chunks: list[str]) -> list[str]:
    """Build SSE lines that simulate Claude's streaming response."""
    lines: list[str] = []
    # message_start
    lines.append("event: message_start")
    lines.append('data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null}}')
    lines.append("")
    # content_block_start
    lines.append("event: content_block_start")
    lines.append('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}')
    lines.append("")
    # content_block_delta for each chunk
    for chunk in text_chunks:
        lines.append("event: content_block_delta")
        data = {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": chunk}}
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")
    # content_block_stop
    lines.append("event: content_block_stop")
    lines.append('data: {"type":"content_block_stop","index":0}')
    lines.append("")
    # message_stop
    lines.append("event: message_stop")
    lines.append('data: {"type":"message_stop"}')
    lines.append("")
    return lines


@pytest.mark.asyncio
async def test_streams_text_and_returns_accumulated() -> None:
    """Full happy path: stream three chunks, accumulate, return full text."""
    chunks = ["Hello", " world", "!"]
    sse_lines = _make_sse_lines(chunks)
    fake_response = FakeStreamResponse(sse_lines)

    collected_events: list[StreamDeltaEvent] = []

    async def capture_emit(event):
        if isinstance(event, StreamDeltaEvent):
            collected_events.append(event)

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream.return_value = fake_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        node = _make_node()
        inputs = {"messages": PortValueDict(type="Text", value="Tell me a joke")}
        api_keys = {"ANTHROPIC_API_KEY": "sk-ant-test-key"}

        result = await handle_claude_chat(node, inputs, api_keys, emit=capture_emit)

    assert result["text"]["type"] == "Text"
    assert result["text"]["value"] == "Hello world!"

    # Verify stream delta events were emitted
    assert len(collected_events) == 3
    assert collected_events[0].delta == "Hello"
    assert collected_events[0].accumulated == "Hello"
    assert collected_events[1].delta == " world"
    assert collected_events[1].accumulated == "Hello world"
    assert collected_events[2].delta == "!"
    assert collected_events[2].accumulated == "Hello world!"

    # Verify correct headers were used
    call_kwargs = mock_client.stream.call_args
    headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
    assert headers["x-api-key"] == "sk-ant-test-key"
    assert headers["anthropic-version"] == ANTHROPIC_VERSION
    assert "Authorization" not in headers  # NOT Bearer token

    # Verify request body
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["model"] == "claude-sonnet-4-6"
    assert body["max_tokens"] == 1024
    assert body["stream"] is True
    assert body["temperature"] == 0.7
    assert body["messages"][0]["role"] == "user"
    assert body["messages"][0]["content"][0]["text"] == "Tell me a joke"


@pytest.mark.asyncio
async def test_missing_messages_raises() -> None:
    node = _make_node()
    inputs: dict[str, PortValueDict] = {}
    api_keys = {"ANTHROPIC_API_KEY": "sk-ant-test-key"}

    with pytest.raises(ValueError, match="[Mm]essages.*required"):
        await handle_claude_chat(node, inputs, api_keys)


@pytest.mark.asyncio
async def test_missing_api_key_raises() -> None:
    node = _make_node()
    inputs = {"messages": PortValueDict(type="Text", value="hello")}
    api_keys: dict[str, str] = {}

    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        await handle_claude_chat(node, inputs, api_keys)


@pytest.mark.asyncio
async def test_api_error_propagates() -> None:
    """Non-200 response should raise with error body."""
    fake_response = FakeStreamResponse([], status_code=401)

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream.return_value = fake_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        node = _make_node()
        inputs = {"messages": PortValueDict(type="Text", value="hello")}
        api_keys = {"ANTHROPIC_API_KEY": "sk-ant-test-key"}

        with pytest.raises(RuntimeError, match="401"):
            await handle_claude_chat(node, inputs, api_keys)


@pytest.mark.asyncio
async def test_default_max_tokens_is_set() -> None:
    """If max_tokens not in params, default to 4096."""
    chunks = ["ok"]
    sse_lines = _make_sse_lines(chunks)
    fake_response = FakeStreamResponse(sse_lines)

    with patch("execution.stream_runner.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.stream.return_value = fake_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        node = GraphNode(
            id="test-claude-2",
            definitionId="claude-chat",
            params={"model": "claude-haiku-3-5-20241022"},  # No max_tokens
        )
        inputs = {"messages": PortValueDict(type="Text", value="hello")}
        api_keys = {"ANTHROPIC_API_KEY": "sk-ant-test-key"}

        await handle_claude_chat(node, inputs, api_keys)

    body = mock_client.stream.call_args.kwargs.get("json") or mock_client.stream.call_args[1].get("json")
    assert body["max_tokens"] == 4096
```

- [ ] **Step 3: Run Claude handler tests**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/test_anthropic_handler.py -v
```

Expected: All 5 tests pass.

- [ ] **Step 4: Commit**

```
feat(backend): add Claude chat handler with SSE streaming and x-api-key auth
```

---

## Task 8: Register New Handlers

**Files:**
- Modify: `backend/execution/sync_runner.py`
- Modify: `backend/execution/engine.py` (import StreamDeltaEvent for emit)

### Estimated time: 5 minutes

- [ ] **Step 1: Update sync_runner.py to include new handlers**

Replace the entire `backend/execution/sync_runner.py` with:

```python
from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from handlers.openai_image import handle_openai_image_generate


# Handlers that need an `emit` callback (async-poll and stream patterns)
# are wrapped in closures that capture the emit function at registration time.
# The engine passes emit to the handler registry builder, which injects it.

SYNC_HANDLERS: dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
] = {
    "gpt-image-1-generate": handle_openai_image_generate,
}


def get_handler_registry(
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[
    str,
    Callable[
        [GraphNode, dict[str, PortValueDict], dict[str, str]],
        Awaitable[dict[str, Any]],
    ],
]:
    """Build the complete handler registry, injecting emit for handlers that need it.

    Sync handlers (like OpenAI Image) don't need emit — they just return outputs.
    Async-poll handlers (like Runway) need emit to send ProgressEvent during polling.
    Stream handlers (like Claude) need emit to send StreamDeltaEvent during streaming.

    For backward compatibility, if emit is None, only sync handlers are registered.
    """
    registry = dict(SYNC_HANDLERS)

    if emit is not None:
        from handlers.runway import handle_runway_gen4_turbo
        from handlers.anthropic_chat import handle_claude_chat

        # Wrap handlers that need emit into the standard NodeHandler signature
        async def _runway_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_runway_gen4_turbo(node, inputs, api_keys, emit=emit)

        async def _claude_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_claude_chat(node, inputs, api_keys, emit=emit)

        registry["runway-gen4-turbo"] = _runway_handler
        registry["claude-chat"] = _claude_handler

    return registry
```

- [ ] **Step 2: Update main.py to pass emit to handler registry**

In `backend/main.py`, update the `execute` endpoint to pass `manager.broadcast` to `get_handler_registry`:

Replace this line in the `execute` function:

```python
    handler_registry = get_handler_registry()
```

With:

```python
    handler_registry = get_handler_registry(emit=manager.broadcast)
```

- [ ] **Step 3: Verify existing tests still pass**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/ -v
```

Expected: All tests pass. The `get_handler_registry()` call in test files (if any) still works because `emit` defaults to `None`, which just excludes the async/stream handlers.

- [ ] **Step 4: Verify the full handler registry includes all three handlers**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -c "
from execution.sync_runner import get_handler_registry

async def fake_emit(event): pass

# Without emit — only sync handlers
basic = get_handler_registry()
print(f'Sync-only handlers: {sorted(basic.keys())}')
assert 'gpt-image-1-generate' in basic
assert 'runway-gen4-turbo' not in basic

# With emit — all handlers
full = get_handler_registry(emit=fake_emit)
print(f'Full handlers: {sorted(full.keys())}')
assert 'gpt-image-1-generate' in full
assert 'runway-gen4-turbo' in full
assert 'claude-chat' in full
print('Handler registry OK')
"
```

- [ ] **Step 5: Commit**

```
feat(backend): register Runway and Claude handlers in handler registry with emit injection
```

---

## Task 9: Frontend Text Preview

This task was largely completed in Task 3 (Steps 7-8) when we built the `ModelNode.tsx` changes and CSS. This task covers any remaining frontend work and the video output path rewriting.

**Files:**
- Modify: `frontend/src/store/graphStore.ts` (video path rewriting)

### Estimated time: 4 minutes

- [ ] **Step 1: Add video output path rewriting in graphStore.ts**

In `frontend/src/store/graphStore.ts`, inside the `case 'executed'` handler, the existing code rewrites Image paths. Add the same rewriting for Video paths. Update the executed case to also handle Video:

In the for-loop inside `case 'executed'`, after the Image rewriting block, add Video handling:

```typescript
          if (outputVal.type === 'Image' && outputVal.value && typeof outputVal.value === 'string') {
            const outputIdx = outputVal.value.indexOf('/output/');
            if (outputIdx !== -1) {
              const relativePath = outputVal.value.substring(outputIdx + '/output/'.length);
              outputs[key] = { type: outputVal.type, value: `/api/outputs/${relativePath}` };
            } else {
              outputs[key] = outputVal;
            }
          } else if (outputVal.type === 'Video' && outputVal.value && typeof outputVal.value === 'string') {
            const outputIdx = outputVal.value.indexOf('/output/');
            if (outputIdx !== -1) {
              const relativePath = outputVal.value.substring(outputIdx + '/output/'.length);
              outputs[key] = { type: outputVal.type, value: `/api/outputs/${relativePath}` };
            } else {
              outputs[key] = outputVal;
            }
          } else {
            outputs[key] = outputVal;
          }
```

- [ ] **Step 2: Verify frontend compiles**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npm run build
```

Expected: Build succeeds with no type errors.

- [ ] **Step 3: Commit**

```
feat(frontend): add video output path rewriting and finalize text preview rendering
```

---

## Task 10: Integration Verification

**Files:** None (verification only)

### Estimated time: 8 minutes

- [ ] **Step 1: Run all backend tests**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
python -m pytest tests/ -v --tb=short
```

Expected output summary:
```
tests/test_engine.py::TestTopologicalSort::test_single_node PASSED
tests/test_engine.py::TestTopologicalSort::test_linear_chain PASSED
tests/test_engine.py::TestTopologicalSort::test_diamond_graph PASSED
tests/test_engine.py::TestTopologicalSort::test_disconnected_subgraphs PASSED
tests/test_engine.py::TestTopologicalSort::test_cycle_raises PASSED
tests/test_engine.py::TestValidateGraph::test_valid_graph_passes PASSED
tests/test_engine.py::TestValidateGraph::test_missing_required_port PASSED
tests/test_engine.py::TestValidateGraph::test_missing_api_key PASSED
tests/test_engine.py::TestValidateGraph::test_utility_node_no_key_needed PASSED
tests/test_openai_handler.py::test_generates_image_and_saves_file PASSED
tests/test_openai_handler.py::test_missing_prompt_raises PASSED
tests/test_openai_handler.py::test_api_error_propagates PASSED
tests/test_cache.py::TestGetKey::* (5 tests) PASSED
tests/test_cache.py::TestCacheGetSet::* (5 tests) PASSED
tests/test_cache.py::TestCacheIntegrationFlow::* (1 test) PASSED
tests/test_runway_handler.py::* (5 tests) PASSED
tests/test_anthropic_handler.py::* (5 tests) PASSED
```

Total: 33 tests, all passing.

- [ ] **Step 2: Run frontend type check and build**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx tsc --noEmit && npm run build
```

Expected: No type errors, build succeeds.

- [ ] **Step 3: Start both servers and verify health**

```bash
# Terminal 1: Start backend
cd /Users/justinperea/Documents/Projects/nebula_nodes/backend
source .venv/bin/activate
uvicorn main:app --port 8000 &
sleep 2
curl -s http://localhost:8000/api/health
# Expected: {"status":"ok","version":"0.1.0"}
kill %1
```

- [ ] **Step 4: Manual E2E cache verification**

With both servers running:

1. Drop a Text Input node + GPT Image 1 node on the canvas
2. Connect them, type a prompt, click Run
3. Note the execution time in the console log (`[execution] complete in Xs`)
4. Click Run again without changing anything
5. Second run should be near-instant (< 0.01s) — the cache hit skips the OpenAI API call
6. Change the prompt text and run again — should be slow again (cache miss because input changed)

- [ ] **Step 5: Manual streaming verification (requires ANTHROPIC_API_KEY)**

1. Add an `ANTHROPIC_API_KEY` in Settings
2. Drop a Text Input node + Claude node on the canvas
3. Connect them, type a prompt, click Run
4. Text should appear character-by-character in the Claude node's preview area with a blinking cursor
5. When complete, the cursor disappears and the full text remains

- [ ] **Step 6: Manual async-poll verification (requires RUNWAY_API_KEY)**

1. Add a `RUNWAY_API_KEY` in Settings
2. Drop an Image Input node (or GPT Image 1) + Runway Gen-4 Turbo node on the canvas
3. Connect image output to Runway's image input
4. Click Run
5. The Runway node should show a progress bar that slowly advances
6. After ~30-120 seconds (typical Runway gen time), the node should show "Video ready"
7. The video file should be saved in the `output/` directory

- [ ] **Step 7: Commit final verification**

If any fixes were needed during verification, commit them:

```
fix(backend): address integration issues found during M3 verification
```

---

## Summary of Changes

| Component | What Changed | Why |
|-----------|-------------|-----|
| `services/cache.py` | New: in-memory SHA256 execution cache | Skip identical API calls — same params + inputs = same output |
| `execution/engine.py` | Modified: cache check before handler call | Orchestrate cache hit/miss around existing handler loop |
| `execution/async_poll_runner.py` | New: generic submit-poll-complete loop | Runway (and future async nodes) need job submission + status polling |
| `execution/stream_runner.py` | New: generic SSE line parser with emit | Claude (and future streaming nodes) need incremental text output |
| `handlers/runway.py` | New: Runway Gen-4 Turbo handler | Image-to-video generation with local file to data URI conversion |
| `handlers/anthropic_chat.py` | New: Claude chat handler | Text generation with streaming, x-api-key auth, vision support |
| `execution/sync_runner.py` | Modified: emit-aware handler registry | Inject emit callback into handlers that need progress/streaming events |
| `models/events.py` | Modified: StreamDeltaEvent added | Frontend needs incremental text chunks for live preview |
| `frontend/wsClient.ts` | Modified: streamDelta event type | TypeScript type safety for new event |
| `frontend/types/index.ts` | Modified: streamingText in NodeData | Store live streaming text separately from final outputs |
| `frontend/graphStore.ts` | Modified: streamDelta handler + video paths | Drive UI updates during streaming + serve video files |
| `frontend/ModelNode.tsx` | Modified: text preview + streaming cursor | Show text as it arrives, with blinking cursor during stream |
| `frontend/nodes.css` | Modified: text preview styles | Scrollable text block, streaming border, cursor animation |
| `services/output.py` | Modified: save_video_from_url, image_to_data_uri | Download Runway videos, convert local images for Runway input |
| `tests/test_cache.py` | New: 11 cache tests | Key generation, hit/miss, TTL expiry, round-trip |
| `tests/test_runway_handler.py` | New: 5 Runway tests | Happy path, text prompt, missing inputs, API errors |
| `tests/test_anthropic_handler.py` | New: 5 Claude tests | Streaming accumulation, auth headers, error propagation |

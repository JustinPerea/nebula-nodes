# Milestone 4B: Dynamic Universal Nodes (OpenRouter, Replicate, FAL) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three "universal" adapter nodes that let users run ANY AI model without rebuilding the app. OpenRouter covers ~1000 LLMs and image generators via a single chat/completions endpoint. Replicate covers any open-source model by fetching its OpenAPI schema and auto-rendering inputs. FAL covers fast inference endpoints like FLUX, Whisper, and SDXL via a queue API. After this milestone, the app goes from "5 hardcoded models" to "any model on earth."

**Architecture:** Dynamic nodes are fundamentally different from static nodes. A static `ModelNode` reads its ports from `NODE_DEFINITIONS[definitionId]` — the ports are known at compile time and identical across all instances. A dynamic node's ports and params are stored in the node's own `data` because they vary per instance — an OpenRouter node running `openai/gpt-4o` has different ports than one running `openai/dall-e-3`. This means we need a new React Flow node type (`DynamicNode`) that reads ports from `node.data.dynamicPorts` instead of from a static definition, a new node data type (`DynamicNodeData`) that extends `NodeData` with the dynamic fields, and engine-level changes so validation doesn't reject nodes it can't find in `NODE_DEFS`. The three provider handlers each follow existing patterns (sync for OpenRouter text, stream for OpenRouter chat, async-poll for Replicate and FAL) but add model-list and schema-proxy API endpoints through the backend to avoid CORS issues.

**Tech Stack:** Python 3.12+, FastAPI, Pydantic v2, httpx, Vite dev proxy, React 19, @xyflow/react, Zustand, TypeScript

**Reference docs:**
- Design spec: `docs/superpowers/specs/2026-04-13-nebula-node-design.md`
- Architecture spec: `docs/perplexity-research/AI Node Editor — Architecture & Interaction Spec v2.md` (Sections 8.1-8.3)
- Model spec: `docs/perplexity-research/AI Node Editor — Complete Model & API Parameter Spec v2.md` (Sections 25-26)
- Milestone 4A plan: `docs/superpowers/plans/2026-04-13-milestone-4a-settings-ux-saveload.md`

---

## File Structure (new and modified files)

```
nebula_nodes/
├── backend/
│   ├── main.py                                      # MODIFY: mount proxy routes, add OpenRouter/Replicate/FAL key to settings
│   ├── execution/
│   │   ├── engine.py                                # MODIFY: skip static validation for dynamic nodes
│   │   └── sync_runner.py                           # MODIFY: register 3 new handlers
│   ├── handlers/
│   │   ├── openrouter.py                            # NEW: OpenRouter universal handler
│   │   ├── replicate_universal.py                   # NEW: Replicate universal handler
│   │   └── fal_universal.py                         # NEW: FAL universal handler
│   ├── services/
│   │   └── model_cache.py                           # NEW: TTL cache for model lists & schemas
│   ├── routes/
│   │   ├── __init__.py                              # NEW: empty
│   │   ├── openrouter_proxy.py                      # NEW: /api/openrouter/models proxy endpoint
│   │   ├── replicate_proxy.py                       # NEW: /api/replicate/schema/{owner}/{name} proxy endpoint
│   │   └── fal_proxy.py                             # NEW: /api/fal/schema/{endpoint_id} proxy endpoint (stretch)
│   └── tests/
│       ├── test_openrouter_handler.py               # NEW: OpenRouter handler tests
│       ├── test_replicate_handler.py                # NEW: Replicate handler tests
│       ├── test_fal_handler.py                      # NEW: FAL handler tests
│       └── test_engine.py                           # MODIFY: add dynamic node validation tests
│
├── frontend/
│   ├── src/
│   │   ├── types/
│   │   │   └── index.ts                             # MODIFY: add DynamicNodeData, DynamicPortDefinition
│   │   ├── constants/
│   │   │   ├── nodeDefinitions.ts                   # MODIFY: add 3 dynamic node base definitions
│   │   │   └── ports.ts                             # MODIFY: add 'universal' category color
│   │   ├── lib/
│   │   │   ├── api.ts                               # MODIFY: add fetchOpenRouterModels, fetchReplicateSchema, fetchFalSchema
│   │   │   └── portCompatibility.ts                 # NO CHANGE (dynamic nodes reuse existing port types)
│   │   ├── hooks/
│   │   │   └── useIsValidConnection.ts              # MODIFY: fall back to node.data.dynamicPorts for dynamic nodes
│   │   ├── store/
│   │   │   └── graphStore.ts                        # MODIFY: addDynamicNode method, handle dynamic ports in onConnect
│   │   ├── components/
│   │   │   ├── Canvas.tsx                           # MODIFY: register DynamicNode type
│   │   │   ├── nodes/
│   │   │   │   └── DynamicNode.tsx                  # NEW: renders ports/params from node.data, not from static def
│   │   │   └── panels/
│   │   │       ├── NodeLibrary.tsx                  # MODIFY: add universal node category
│   │   │       └── Inspector.tsx                    # MODIFY: render dynamic params for dynamic nodes
│   │   └── styles/
│   │       └── nodes.css                            # MODIFY: styles for dynamic node elements (model selector, schema fields)
```

---

## Task 1: Dynamic Node Infrastructure

**Why this is first:** Every subsequent task depends on the dynamic node type, the extended data model, and the engine's ability to run nodes that aren't in `NODE_DEFS`.

**Files:**
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/constants/nodeDefinitions.ts`
- Modify: `frontend/src/constants/ports.ts`
- Create: `frontend/src/components/nodes/DynamicNode.tsx`
- Modify: `frontend/src/components/Canvas.tsx`
- Modify: `frontend/src/hooks/useIsValidConnection.ts`
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/src/components/panels/NodeLibrary.tsx`
- Modify: `frontend/src/components/panels/Inspector.tsx`
- Modify: `backend/execution/engine.py`
- Modify: `backend/tests/test_engine.py`

### Estimated time: 60 minutes

- [ ] **Step 1: Extend the type system for dynamic nodes**

In `frontend/src/types/index.ts`, add the following types after the existing `NodeData` interface:

```typescript
// Add to NodeCategory union:
// | 'universal'

// Add to APIProvider union (already present, just confirm):
// | 'openrouter'
// | 'replicate'
// | 'fal'

export interface DynamicPortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
}

export interface DynamicParamDefinition {
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
}

export interface DynamicNodeData extends NodeData {
  isDynamic: true;
  providerType: 'openrouter' | 'replicate' | 'fal';
  modelId?: string;
  dynamicInputPorts: DynamicPortDefinition[];
  dynamicOutputPorts: DynamicPortDefinition[];
  dynamicParams: DynamicParamDefinition[];
  /** Provider-specific metadata (e.g. Replicate version_id, FAL endpoint_id) */
  providerMeta: Record<string, unknown>;
}
```

- [ ] **Step 2: Add universal category color and base definitions**

In `frontend/src/constants/ports.ts`, add the universal category color:

```typescript
export const CATEGORY_COLORS: Record<string, string> = {
  'image-gen': '#1565C0',
  'video-gen': '#B71C1C',
  'text-gen': '#4A148C',
  'audio-gen': '#FF6F00',
  'transform': '#004D40',
  'analyzer': '#1B5E20',
  'utility': '#424242',
  'universal': '#E65100',
};
```

In `frontend/src/constants/nodeDefinitions.ts`, add the three dynamic node base definitions. These are "shell" definitions — they tell the NodeLibrary what to show and the addNode function what defaults to use, but ports are empty because they get populated at runtime:

```typescript
  'openrouter-universal': {
    id: 'openrouter-universal',
    displayName: 'OpenRouter',
    category: 'universal',
    apiProvider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    envKeyName: 'OPENROUTER_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'Loading models...',
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 1.0,
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        key: 'max_tokens',
        label: 'Max Tokens',
        type: 'integer',
        required: false,
        default: 4096,
        min: 1,
        max: 200000,
      },
    ],
  },

  'replicate-universal': {
    id: 'replicate-universal',
    displayName: 'Replicate',
    category: 'universal',
    apiProvider: 'replicate',
    apiEndpoint: 'https://api.replicate.com/v1/predictions',
    envKeyName: 'REPLICATE_API_TOKEN',
    executionPattern: 'async-poll',
    inputPorts: [],
    outputPorts: [],
    params: [
      {
        key: 'model_id',
        label: 'Model ID',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'owner/name (e.g. stability-ai/sdxl)',
      },
    ],
  },

  'fal-universal': {
    id: 'fal-universal',
    displayName: 'FAL',
    category: 'universal',
    apiProvider: 'fal',
    apiEndpoint: 'https://queue.fal.run',
    envKeyName: 'FAL_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'endpoint_id',
        label: 'Endpoint',
        type: 'string',
        required: true,
        default: 'fal-ai/flux-pro/v1.1-ultra',
        placeholder: 'fal-ai/flux-pro/v1.1-ultra',
      },
    ],
  },
```

Also update the `CATEGORY_LABELS` in `frontend/src/components/panels/NodeLibrary.tsx`:

```typescript
const CATEGORY_LABELS: Record<string, string> = {
  'image-gen': 'Image Generation',
  'video-gen': 'Video Generation',
  'text-gen': 'Text Generation',
  'audio-gen': 'Audio Generation',
  'transform': 'Transform',
  'analyzer': 'Analyzer',
  'utility': 'Utility',
  'universal': 'Universal',
};
```

- [ ] **Step 3: Create DynamicNode.tsx component**

This is the core visual component. Unlike `ModelNode` which reads ports from `NODE_DEFINITIONS`, `DynamicNode` reads ports from the node's own data. It still falls back to the base definition for the initial shell.

Create `frontend/src/components/nodes/DynamicNode.tsx`:

```typescript
import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData, DynamicNodeData, PortDataType } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS } from '../../constants/ports';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/nodes.css';

function isDynamicData(data: NodeData): data is DynamicNodeData {
  return 'isDynamic' in data && (data as DynamicNodeData).isDynamic === true;
}

function DynamicNodeComponent({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as NodeData;
  const selectNode = useUIStore((s) => s.selectNode);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);

  const definition = NODE_DEFINITIONS[nodeData.definitionId];
  const categoryColor = CATEGORY_COLORS[definition?.category ?? 'universal'] ?? '#E65100';
  const stateClass = `model-node--${nodeData.state}`;

  // For dynamic nodes, read ports from data; for fallback, use definition
  const dynData = isDynamicData(nodeData) ? nodeData : null;
  const inputPorts = dynData?.dynamicInputPorts ?? definition?.inputPorts ?? [];
  const outputPorts = dynData?.dynamicOutputPorts ?? definition?.outputPorts ?? [];

  const imageOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Image' && o.value);
  const textOutput = Object.values(nodeData.outputs).find((o) => o.type === 'Text' && o.value);
  const displayText = nodeData.streamingText ?? (textOutput && typeof textOutput.value === 'string' ? textOutput.value : null);
  const isStreaming = nodeData.state === 'executing' && nodeData.streamingText != null;

  // Model badge: show selected model compactly
  const modelBadge = dynData?.modelId || (nodeData.params.model as string) || (nodeData.params.model_id as string) || (nodeData.params.endpoint_id as string) || null;

  return (
    <div className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`} onClick={() => selectNode(id)}>
      <div className="model-node__header">
        <span className="model-node__category-dot" style={{ backgroundColor: categoryColor }} />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && <span className="model-node__badge model-node__badge--warning" title="API Key Missing">&#x26A0;</span>}
      </div>

      {/* Model badge */}
      {modelBadge && (
        <div className="dynamic-node__model-badge">
          {modelBadge.length > 35 ? `...${modelBadge.slice(-32)}` : modelBadge}
        </div>
      )}

      {inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType as PortDataType] ?? PORT_COLORS.Any }}
              />
              <span className="model-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      )}

      {nodeData.state === 'executing' && nodeData.progress !== undefined && (
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

      {nodeData.state === 'error' && nodeData.error && (
        <div className="model-node__error">{nodeData.error}</div>
      )}

      {outputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--output">
          {outputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row model-node__port-row--output">
              <span className="model-node__port-label">{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType as PortDataType] ?? PORT_COLORS.Any }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const DynamicNode = memo(DynamicNodeComponent);
```

Add styles in `frontend/src/styles/nodes.css`:

```css
.dynamic-node__model-badge {
  padding: 2px 8px;
  margin: 0 8px 4px;
  font-size: 10px;
  color: #aaa;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Menlo', monospace;
}
```

- [ ] **Step 4: Register DynamicNode in Canvas.tsx**

In `frontend/src/components/Canvas.tsx`, import and register the new node type:

```typescript
import { DynamicNode } from './nodes/DynamicNode';

const nodeTypes: NodeTypes = {
  'model-node': ModelNode,
  'dynamic-node': DynamicNode,
};
```

- [ ] **Step 5: Add addDynamicNode to graphStore.ts**

The existing `addNode` method creates a `model-node` type and reads defaults from `NODE_DEFINITIONS`. We need a parallel method for dynamic nodes that creates a `dynamic-node` type and initializes the dynamic data fields.

In `frontend/src/store/graphStore.ts`, add `addDynamicNode` to the interface and implementation:

```typescript
// Add to GraphState interface:
addDynamicNode: (definitionId: string, position: { x: number; y: number }) => void;

// Add to the store implementation:
addDynamicNode: (definitionId, position) => {
  const definition = NODE_DEFINITIONS[definitionId];
  if (!definition) return;
  const defaults: Record<string, unknown> = {};
  for (const param of definition.params) {
    if (param.default !== undefined) defaults[param.key] = param.default;
  }

  const providerMap: Record<string, 'openrouter' | 'replicate' | 'fal'> = {
    'openrouter-universal': 'openrouter',
    'replicate-universal': 'replicate',
    'fal-universal': 'fal',
  };

  const newNode: Node<DynamicNodeData> = {
    id: uuidv4(),
    type: 'dynamic-node',
    position,
    data: {
      label: definition.displayName,
      definitionId,
      params: defaults,
      state: 'idle',
      outputs: {},
      isDynamic: true,
      providerType: providerMap[definitionId] ?? 'openrouter',
      dynamicInputPorts: definition.inputPorts.map((p) => ({
        id: p.id,
        label: p.label,
        dataType: p.dataType,
        required: p.required,
      })),
      dynamicOutputPorts: definition.outputPorts.map((p) => ({
        id: p.id,
        label: p.label,
        dataType: p.dataType,
        required: p.required,
      })),
      dynamicParams: [],
      providerMeta: {},
    },
  };
  set((state) => ({ nodes: [...state.nodes, newNode] }));
},
```

Also modify the existing `addNode` method to detect dynamic definitions and call `addDynamicNode` instead:

```typescript
addNode: (definitionId, position) => {
  const DYNAMIC_IDS = ['openrouter-universal', 'replicate-universal', 'fal-universal'];
  if (DYNAMIC_IDS.includes(definitionId)) {
    get().addDynamicNode(definitionId, position);
    return;
  }
  // ... existing static node logic unchanged
},
```

- [ ] **Step 6: Update onConnect to handle dynamic nodes**

In `graphStore.ts`, the `onConnect` handler reads port types from `NODE_DEFINITIONS`. For dynamic nodes, it needs to fall back to `node.data.dynamicOutputPorts`:

```typescript
onConnect: (connection) => {
  if (!connection.source || !connection.target) return;
  const sourceNode = get().nodes.find((n) => n.id === connection.source);
  const targetNode = get().nodes.find((n) => n.id === connection.target);
  if (!sourceNode || !targetNode) return;

  // Resolve source port data type — static or dynamic
  let dataType: PortDataType = 'Any';
  const sourceDynamic = sourceNode.data as DynamicNodeData | undefined;
  if (sourceDynamic?.isDynamic && sourceDynamic.dynamicOutputPorts) {
    const dynPort = sourceDynamic.dynamicOutputPorts.find((p) => p.id === connection.sourceHandle);
    if (dynPort) dataType = dynPort.dataType;
  } else {
    const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
    if (sourceDef) {
      const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
      if (sourcePort) dataType = sourcePort.dataType;
    }
  }

  const newEdge: Edge = {
    id: uuidv4(),
    source: connection.source,
    sourceHandle: connection.sourceHandle,
    target: connection.target,
    targetHandle: connection.targetHandle,
    type: 'typed-edge',
    data: { dataType },
  };
  set((state) => ({ edges: [...state.edges, newEdge] }));
},
```

- [ ] **Step 7: Update useIsValidConnection for dynamic nodes**

In `frontend/src/hooks/useIsValidConnection.ts`, the connection validator reads ports from `NODE_DEFINITIONS`. Add a fallback for dynamic nodes:

```typescript
import type { NodeData, DynamicNodeData, PortDataType } from '../types';

// Inside the useCallback, after finding sourceNode and targetNode:
const sourceData = sourceNode.data as NodeData;
const targetData = targetNode.data as NodeData;

let sourcePortType: PortDataType | undefined;
let targetPortType: PortDataType | undefined;

// Check static definitions first
const sourceDef = NODE_DEFINITIONS[sourceData.definitionId];
const targetDef = NODE_DEFINITIONS[targetData.definitionId];

if (sourceDef) {
  const p = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
  if (p) sourcePortType = p.dataType;
}
if (targetDef) {
  const p = targetDef.inputPorts.find((p) => p.id === connection.targetHandle);
  if (p) targetPortType = p.dataType;
}

// Fallback to dynamic ports
if (!sourcePortType && 'isDynamic' in sourceData) {
  const dyn = sourceData as DynamicNodeData;
  const p = dyn.dynamicOutputPorts?.find((p) => p.id === connection.sourceHandle);
  if (p) sourcePortType = p.dataType;
}
if (!targetPortType && 'isDynamic' in targetData) {
  const dyn = targetData as DynamicNodeData;
  const p = dyn.dynamicInputPorts?.find((p) => p.id === connection.targetHandle);
  if (p) targetPortType = p.dataType;
}

if (!sourcePortType || !targetPortType) return false;
return isPortCompatible(sourcePortType, targetPortType);
```

- [ ] **Step 8: Update Inspector.tsx to render dynamic params**

The Inspector currently reads params from `definition.params`. For dynamic nodes, it must also render params from `nodeData.dynamicParams` (if any) and show the model badge. Add a block after the static params loop:

```typescript
// Inside Inspector, after the definition.params.map() block:
// Render dynamic params if this is a dynamic node
const dynData = nodeData as unknown as DynamicNodeData;
const hasDynamicParams = dynData?.isDynamic && dynData.dynamicParams?.length > 0;

// Then render:
{hasDynamicParams && dynData.dynamicParams.map((param) => (
  <div key={param.key} className="inspector__section">
    <div className="inspector__label">{param.label}</div>
    {param.type === 'enum' && param.options ? (
      <select
        className="inspector__field"
        value={String(nodeData.params[param.key] ?? param.default ?? '')}
        onChange={(e) => onParamChange(param.key, e.target.value)}
      >
        {param.options.map((opt) => (
          <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
        ))}
      </select>
    ) : param.type === 'integer' || param.type === 'float' ? (
      <input
        className="inspector__field"
        type="number"
        value={String(nodeData.params[param.key] ?? param.default ?? '')}
        onChange={(e) => onParamChange(param.key, Number(e.target.value))}
        min={param.min}
        max={param.max}
        step={param.step ?? (param.type === 'float' ? 0.1 : 1)}
      />
    ) : param.type === 'boolean' ? (
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#aaa' }}>
        <input
          type="checkbox"
          checked={Boolean(nodeData.params[param.key] ?? param.default)}
          onChange={(e) => onParamChange(param.key, e.target.checked)}
        />
        {param.label}
      </label>
    ) : (
      <input
        className="inspector__field"
        type="text"
        value={String(nodeData.params[param.key] ?? param.default ?? '')}
        onChange={(e) => onParamChange(param.key, e.target.value)}
        placeholder={param.placeholder}
      />
    )}
  </div>
))}
```

Also update the null guard at the top of Inspector. Currently it bails if `!definition`. For dynamic nodes, `definition` may exist (as the base shell) but we should NOT bail. Replace:

```typescript
if (!visible || !selectedNode || !definition || !nodeData) return null;
```

with:

```typescript
if (!visible || !selectedNode || !nodeData) return null;
// For dynamic nodes, definition may be a shell — that's fine
if (!definition && !(nodeData as unknown as DynamicNodeData)?.isDynamic) return null;
```

- [ ] **Step 9: Backend engine — skip static validation for dynamic nodes**

In `backend/execution/engine.py`, the `validate_graph` function calls `NODE_DEFS.get(node.definition_id)` and skips if `None`. This is already the correct behavior — nodes not in `NODE_DEFS` get a `continue`, so no required-port or API-key errors are raised. However, we should still validate that the dynamic node has its provider API key. Add after the `if not node_def: continue` line:

```python
if not node_def:
    # Dynamic node — still validate API key if definition_id is recognized
    DYNAMIC_ENV_KEYS: dict[str, str] = {
        "openrouter-universal": "OPENROUTER_API_KEY",
        "replicate-universal": "REPLICATE_API_TOKEN",
        "fal-universal": "FAL_KEY",
    }
    env_key = DYNAMIC_ENV_KEYS.get(node.definition_id)
    if env_key and not api_keys.get(env_key):
        errors.append(
            ValidationErrorDetail(
                node_id=node.id,
                port_id="",
                message=f"Missing API key: {env_key}",
            )
        )
    continue
```

- [ ] **Step 10: Test dynamic node validation**

Add to `backend/tests/test_engine.py`:

```python
class TestDynamicNodeValidation:
    def test_dynamic_node_skips_port_validation(self) -> None:
        """Dynamic nodes not in NODE_DEFS should not fail port validation."""
        nodes = [_node("a", "openrouter-universal")]
        errors = validate_graph(nodes, [], {"OPENROUTER_API_KEY": "or-test"})
        port_errors = [e for e in errors if e.port_id]
        assert len(port_errors) == 0

    def test_dynamic_node_missing_key(self) -> None:
        """Dynamic nodes should still validate API keys."""
        nodes = [_node("a", "openrouter-universal")]
        errors = validate_graph(nodes, [], {})
        key_errors = [e for e in errors if "OPENROUTER_API_KEY" in e.message]
        assert len(key_errors) == 1

    def test_unknown_dynamic_node_passes(self) -> None:
        """Truly unknown nodes should be silently skipped."""
        nodes = [_node("a", "some-future-node-type")]
        errors = validate_graph(nodes, [], {})
        assert len(errors) == 0
```

Run: `cd backend && python -m pytest tests/test_engine.py -v`

---

## Task 2: Model Cache Service + API Proxy Routes

**Why this is second:** The handlers and frontend components in Tasks 3-5 depend on backend proxy endpoints to fetch model lists and schemas. Building the proxy layer now means everything downstream can use it.

**Files:**
- Create: `backend/services/model_cache.py`
- Create: `backend/routes/__init__.py`
- Create: `backend/routes/openrouter_proxy.py`
- Create: `backend/routes/replicate_proxy.py`
- Create: `backend/routes/fal_proxy.py`
- Modify: `backend/main.py`
- Modify: `frontend/src/lib/api.ts`

### Estimated time: 40 minutes

- [ ] **Step 1: Create model_cache.py**

A simple TTL cache for API responses. Avoids hammering external APIs and keeps the frontend fast.

Create `backend/services/model_cache.py`:

```python
from __future__ import annotations

import time
from typing import Any


class ModelCache:
    """Simple in-memory TTL cache for model lists and schemas."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float, float]] = {}  # key -> (value, timestamp, ttl)

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, timestamp, ttl = entry
        if time.monotonic() - timestamp > ttl:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any, ttl: float = 300.0) -> None:
        self._store[key] = (value, time.monotonic(), ttl)

    def clear(self) -> None:
        self._store.clear()


model_cache = ModelCache()
```

- [ ] **Step 2: Create OpenRouter proxy route**

Create `backend/routes/__init__.py` (empty file).

Create `backend/routes/openrouter_proxy.py`:

```python
from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from services.settings import load_settings
from services.model_cache import model_cache

router = APIRouter(prefix="/api/openrouter", tags=["openrouter"])

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
CACHE_KEY = "openrouter:models"
CACHE_TTL = 300.0  # 5 minutes


@router.get("/models")
async def get_models() -> dict[str, Any]:
    """Proxy the OpenRouter model list. Caches for 5 minutes."""
    cached = model_cache.get(CACHE_KEY)
    if cached is not None:
        return cached

    settings = load_settings()
    api_key = settings.get("apiKeys", {}).get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="OPENROUTER_API_KEY not configured")

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            OPENROUTER_MODELS_URL,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

    data = resp.json()

    # Slim down the payload — frontend only needs id, name, and modality info
    models_raw = data.get("data", [])
    models_slim: list[dict[str, Any]] = []
    for m in models_raw:
        arch = m.get("architecture", {})
        models_slim.append({
            "id": m.get("id", ""),
            "name": m.get("name", m.get("id", "")),
            "input_modalities": arch.get("input_modalities", ["text"]),
            "output_modalities": arch.get("output_modalities", ["text"]),
            "context_length": m.get("context_length", 0),
            "pricing": m.get("pricing", {}),
        })

    result = {"models": models_slim, "count": len(models_slim)}
    model_cache.set(CACHE_KEY, result, ttl=CACHE_TTL)
    return result
```

- [ ] **Step 3: Create Replicate proxy route**

Create `backend/routes/replicate_proxy.py`:

```python
from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

from services.settings import load_settings
from services.model_cache import model_cache

router = APIRouter(prefix="/api/replicate", tags=["replicate"])

REPLICATE_API_BASE = "https://api.replicate.com/v1"
CACHE_TTL = 3600.0  # 1 hour — schemas don't change often


@router.get("/schema/{owner}/{name}")
async def get_model_schema(owner: str, name: str) -> dict[str, Any]:
    """Fetch a Replicate model's latest version schema. Caches for 1 hour."""
    cache_key = f"replicate:schema:{owner}/{name}"
    cached = model_cache.get(cache_key)
    if cached is not None:
        return cached

    settings = load_settings()
    api_key = settings.get("apiKeys", {}).get("REPLICATE_API_TOKEN", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="REPLICATE_API_TOKEN not configured")

    headers = {"Authorization": f"Token {api_key}"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1: Get model info to find latest_version
        model_resp = await client.get(
            f"{REPLICATE_API_BASE}/models/{owner}/{name}",
            headers=headers,
        )
        if model_resp.status_code != 200:
            raise HTTPException(status_code=model_resp.status_code, detail=model_resp.text)

        model_data = model_resp.json()
        latest_version = model_data.get("latest_version", {})
        version_id = latest_version.get("id")

        if not version_id:
            raise HTTPException(status_code=404, detail=f"No version found for {owner}/{name}")

        # Step 2: Get version with full OpenAPI schema
        version_resp = await client.get(
            f"{REPLICATE_API_BASE}/models/{owner}/{name}/versions/{version_id}",
            headers=headers,
        )
        if version_resp.status_code != 200:
            raise HTTPException(status_code=version_resp.status_code, detail=version_resp.text)

        version_data = version_resp.json()
        openapi_schema = version_data.get("openapi_schema", {})

    # Extract input and output schemas from OpenAPI
    input_schema = (
        openapi_schema
        .get("components", {})
        .get("schemas", {})
        .get("Input", {})
    )
    output_schema = (
        openapi_schema
        .get("components", {})
        .get("schemas", {})
        .get("Output", {})
    )

    result = {
        "version_id": version_id,
        "model_id": f"{owner}/{name}",
        "input_schema": input_schema,
        "output_schema": output_schema,
        "description": model_data.get("description", ""),
    }

    model_cache.set(cache_key, result, ttl=CACHE_TTL)
    return result
```

- [ ] **Step 4: Create FAL proxy route (minimal)**

Create `backend/routes/fal_proxy.py`:

```python
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/fal", tags=["fal"])


@router.get("/health")
async def fal_health() -> dict[str, str]:
    """Simple health check. FAL doesn't have a public schema endpoint
    like Replicate — endpoint params are hardcoded per node config."""
    return {"status": "ok", "provider": "fal"}
```

Note: FAL doesn't expose a public schema API the way Replicate does. FAL nodes use a fixed set of params (prompt, image_size, etc.) that we configure in the handler. This route is a placeholder for future schema introspection.

- [ ] **Step 5: Register routes in main.py**

In `backend/main.py`, after the existing `app.mount` for static files, add:

```python
from routes.openrouter_proxy import router as openrouter_router
from routes.replicate_proxy import router as replicate_router
from routes.fal_proxy import router as fal_router

app.include_router(openrouter_router)
app.include_router(replicate_router)
app.include_router(fal_router)
```

- [ ] **Step 6: Add frontend API functions**

In `frontend/src/lib/api.ts`, add:

```typescript
export interface OpenRouterModel {
  id: string;
  name: string;
  input_modalities: string[];
  output_modalities: string[];
  context_length: number;
  pricing: Record<string, string>;
}

export async function fetchOpenRouterModels(): Promise<{ models: OpenRouterModel[]; count: number }> {
  const response = await fetch(`${API_BASE}/openrouter/models`);
  if (!response.ok) throw new Error(`Fetch OpenRouter models failed: ${response.status}`);
  return response.json();
}

export interface ReplicateSchema {
  version_id: string;
  model_id: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  description: string;
}

export async function fetchReplicateSchema(owner: string, name: string): Promise<ReplicateSchema> {
  const response = await fetch(`${API_BASE}/replicate/schema/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Fetch Replicate schema failed: ${response.status}`);
  return response.json();
}
```

- [ ] **Step 7: Add new API key fields to Settings.tsx**

In the `API_KEY_FIELDS` array in `frontend/src/components/panels/Settings.tsx`, add:

```typescript
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', placeholder: 'sk-or-...' },
  { key: 'REPLICATE_API_TOKEN', label: 'Replicate', placeholder: 'r8_...' },
```

(Note: `FAL_KEY` is already present from the FLUX node.)

Run the backend to smoke-test the routes: `cd backend && uvicorn main:app --reload`

Test with curl:
```bash
curl http://localhost:8000/api/openrouter/models | head -c 500
curl http://localhost:8000/api/replicate/schema/stability-ai/sdxl | head -c 500
```

---

## Task 3: OpenRouter Universal Handler

**Why this is third:** It's the highest-value handler — it instantly gives access to ~1000 models. The infrastructure from Tasks 1-2 is ready.

**Files:**
- Create: `backend/handlers/openrouter.py`
- Modify: `backend/execution/sync_runner.py`
- Create: `backend/tests/test_openrouter_handler.py`

### Estimated time: 45 minutes

- [ ] **Step 1: Create the OpenRouter handler**

The OpenRouter handler uses the chat/completions endpoint for everything. For text models it streams via SSE. For image-capable models it adds `"modalities": ["text", "image"]` and parses the non-standard image output location.

Create `backend/handlers/openrouter.py`:

```python
from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.stream_runner import StreamConfig, stream_execute
from services.output import get_run_dir, save_base64_image

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"


async def handle_openrouter_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY is required")

    model = node.params.get("model", "")
    if not model:
        raise ValueError("No model selected — choose a model from the Inspector panel")

    # Build messages from input
    messages_input = inputs.get("messages")
    if not messages_input or not messages_input.value:
        raise ValueError("Messages input is required")

    messages_text = str(messages_input.value)
    content: list[dict[str, Any]] = [{"type": "text", "text": messages_text}]

    # Handle image inputs for vision models
    images_input = inputs.get("images")
    if images_input and images_input.value:
        image_values = images_input.value if isinstance(images_input.value, list) else [images_input.value]
        for img_val in image_values:
            img_str = str(img_val)
            if img_str.startswith(("http://", "https://")):
                content.append({"type": "image_url", "image_url": {"url": img_str}})
            elif img_str.startswith("data:"):
                content.append({"type": "image_url", "image_url": {"url": img_str}})
            else:
                from pathlib import Path
                import base64
                img_path = Path(img_str)
                if img_path.exists():
                    b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    suffix = img_path.suffix.lstrip(".").lower()
                    mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
                    data_uri = f"data:{mime_map.get(suffix, 'image/png')};base64,{b64}"
                    content.append({"type": "image_url", "image_url": {"url": data_uri}})

    messages = [{"role": "user", "content": content}]

    # Check if this is an image generation model
    wants_image = node.params.get("_output_image", False)

    request_body: dict[str, Any] = {
        "model": str(model),
        "messages": messages,
    }

    max_tokens = node.params.get("max_tokens")
    if max_tokens:
        request_body["max_tokens"] = int(max_tokens)

    temperature = node.params.get("temperature")
    if temperature is not None:
        request_body["temperature"] = float(temperature)

    if wants_image:
        # Image generation via chat/completions
        request_body["modalities"] = ["text", "image"]
        # Non-streaming for image generation
        return await _handle_image_generation(request_body, api_key, node)
    else:
        # Text generation — stream
        request_body["stream"] = True
        return await _handle_text_streaming(request_body, api_key, node, emit)


async def _handle_text_streaming(
    request_body: dict[str, Any],
    api_key: str,
    node: GraphNode,
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None,
) -> dict[str, Any]:
    config = StreamConfig(
        url=OPENROUTER_API_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "Nebula Nodes",
        },
        event_type_filter=None,  # OpenRouter sends standard SSE without event types
        delta_path="choices.0.delta.content",
        timeout=30.0,
        extra_stop_events=set(),
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    full_text = await stream_execute(
        config=config,
        request_body=request_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    return {"text": {"type": "Text", "value": full_text}}


async def _handle_image_generation(
    request_body: dict[str, Any],
    api_key: str,
    node: GraphNode,
) -> dict[str, Any]:
    """Handle image generation models via OpenRouter chat/completions.

    Image output is in choices[0].message.images[] — NOT the standard
    data[].b64_json location. Each entry is a base64-encoded image.
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost:5173",
                "X-Title": "Nebula Nodes",
            },
            json=request_body,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"OpenRouter API error {resp.status_code}: {resp.text}")

    data = resp.json()

    # Check for images in the non-standard location
    message = data.get("choices", [{}])[0].get("message", {})
    images = message.get("images", [])

    if images:
        # Save first image
        b64_data = images[0]
        run_dir = get_run_dir()
        file_path = save_base64_image(b64_data, run_dir, extension="png")
        return {"image": {"type": "Image", "value": str(file_path)}}

    # Fallback: return text content
    text_content = message.get("content", "")
    return {"text": {"type": "Text", "value": text_content}}
```

- [ ] **Step 2: Update stream_runner.py for nested delta paths**

The current `_get_nested` in `stream_runner.py` handles dot-separated paths like `delta.text`. But OpenRouter's SSE uses `choices.0.delta.content` where `0` is an array index. Update `_get_nested`:

```python
def _get_nested(data: dict[str, Any], path: str) -> Any:
    current: Any = data
    for key in path.split("."):
        if isinstance(current, dict):
            current = current.get(key)
            if current is None:
                return None
        elif isinstance(current, list):
            try:
                current = current[int(key)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return current
```

Also update the same function in `async_poll_runner.py` for consistency:

```python
def _get_nested(data: dict[str, Any], path: str) -> Any:
    current: Any = data
    for key in path.split("."):
        if isinstance(current, dict):
            current = current[key]
        elif isinstance(current, list):
            try:
                current = current[int(key)]
            except (ValueError, IndexError):
                raise KeyError(f"Cannot index list at '{key}' in path '{path}'")
        else:
            raise KeyError(f"Cannot traverse path '{path}' — hit non-dict at '{key}'")
    return current
```

- [ ] **Step 3: Register the handler in sync_runner.py**

In `backend/execution/sync_runner.py`, add the OpenRouter handler to the `get_handler_registry` function, inside the `if emit is not None` block:

```python
from handlers.openrouter import handle_openrouter_universal

async def _openrouter_handler(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    return await handle_openrouter_universal(node, inputs, api_keys, emit=emit)

registry["openrouter-universal"] = _openrouter_handler
```

- [ ] **Step 4: Write OpenRouter handler tests**

Create `backend/tests/test_openrouter_handler.py`:

```python
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.openrouter import handle_openrouter_universal
from models.graph import GraphNode, PortValueDict


def _make_node(params=None):
    return GraphNode(
        id="test-or-1",
        definitionId="openrouter-universal",
        params=params or {"model": "openai/gpt-4o", "max_tokens": 100},
    )


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
        await handle_openrouter_universal(
            _make_node(),
            {"messages": PortValueDict(type="Text", value="Hello")},
            {},
        )


@pytest.mark.asyncio
async def test_missing_model_raises():
    with pytest.raises(ValueError, match="[Nn]o model"):
        await handle_openrouter_universal(
            _make_node({"model": ""}),
            {"messages": PortValueDict(type="Text", value="Hello")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
        )


@pytest.mark.asyncio
async def test_missing_messages_raises():
    with pytest.raises(ValueError, match="[Mm]essages"):
        await handle_openrouter_universal(
            _make_node(),
            {},
            {"OPENROUTER_API_KEY": "sk-or-test"},
        )


@pytest.mark.asyncio
async def test_text_streaming_calls_stream_execute():
    with patch("handlers.openrouter.stream_execute", new_callable=AsyncMock) as mock_stream:
        mock_stream.return_value = "Hello from GPT-4o!"
        result = await handle_openrouter_universal(
            _make_node(),
            {"messages": PortValueDict(type="Text", value="Hi there")},
            {"OPENROUTER_API_KEY": "sk-or-test"},
            emit=AsyncMock(),
        )

    assert result["text"]["type"] == "Text"
    assert result["text"]["value"] == "Hello from GPT-4o!"
    # Verify the request body
    call_kwargs = mock_stream.call_args.kwargs
    body = call_kwargs.get("request_body") or mock_stream.call_args[1].get("request_body")
    assert body["model"] == "openai/gpt-4o"
    assert body["stream"] is True


@pytest.mark.asyncio
async def test_image_generation_mode():
    """When _output_image is set, should use non-streaming and parse images."""
    node = _make_node({"model": "openai/dall-e-3", "_output_image": True})

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"images": ["aWFtYmFzZTY0ZGF0YQ=="], "content": ""}}]
    }

    with patch("handlers.openrouter.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.openrouter.save_base64_image") as mock_save:
            mock_save.return_value = "/tmp/output/test.png"
            with patch("handlers.openrouter.get_run_dir") as mock_dir:
                mock_dir.return_value = "/tmp/output"
                result = await handle_openrouter_universal(
                    node,
                    {"messages": PortValueDict(type="Text", value="A cat")},
                    {"OPENROUTER_API_KEY": "sk-or-test"},
                )

    assert result["image"]["type"] == "Image"
```

Run: `cd backend && python -m pytest tests/test_openrouter_handler.py -v`

---

## Task 4: Replicate Universal Handler

**Files:**
- Create: `backend/handlers/replicate_universal.py`
- Modify: `backend/execution/sync_runner.py`
- Create: `backend/tests/test_replicate_handler.py`

### Estimated time: 45 minutes

- [ ] **Step 1: Create the Replicate universal handler**

Replicate uses a submit-then-poll pattern. The handler fetches the model schema (via the cached proxy), builds the prediction request, and polls until completion.

Create `backend/handlers/replicate_universal.py`:

```python
from __future__ import annotations

from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from execution.async_poll_runner import AsyncPollConfig, async_poll_execute
from services.output import get_run_dir, save_base64_image

REPLICATE_API_BASE = "https://api.replicate.com/v1"


async def _resolve_version(owner: str, name: str, api_key: str) -> str:
    """Fetch the latest version ID for a model."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{REPLICATE_API_BASE}/models/{owner}/{name}",
            headers={"Authorization": f"Token {api_key}"},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to fetch Replicate model {owner}/{name}: {resp.status_code} {resp.text}")
        data = resp.json()
        version_id = data.get("latest_version", {}).get("id")
        if not version_id:
            raise RuntimeError(f"No version found for {owner}/{name}")
        return str(version_id)


def _infer_output_type(output: Any) -> dict[str, Any]:
    """Infer the output port type from a Replicate prediction result.

    Replicate outputs vary wildly:
    - Single URL string: usually an image or file
    - List of URL strings: multiple images
    - Plain string: text output
    - Dict: structured output
    """
    if isinstance(output, str):
        if output.startswith(("http://", "https://")):
            # URL — likely an image or file
            lower = output.lower()
            if any(ext in lower for ext in [".png", ".jpg", ".jpeg", ".webp", ".gif"]):
                return {"image": {"type": "Image", "value": output}}
            elif any(ext in lower for ext in [".mp4", ".mov", ".webm"]):
                return {"video": {"type": "Video", "value": output}}
            elif any(ext in lower for ext in [".mp3", ".wav", ".flac"]):
                return {"audio": {"type": "Audio", "value": output}}
            else:
                return {"image": {"type": "Image", "value": output}}
        return {"text": {"type": "Text", "value": output}}

    if isinstance(output, list):
        if output and isinstance(output[0], str) and output[0].startswith(("http://", "https://")):
            # List of URLs — return first as primary output
            return {"image": {"type": "Image", "value": output[0]}}
        return {"text": {"type": "Text", "value": str(output)}}

    return {"text": {"type": "Text", "value": str(output)}}


async def handle_replicate_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("REPLICATE_API_TOKEN")
    if not api_key:
        raise ValueError("REPLICATE_API_TOKEN is required")

    model_id = node.params.get("model_id", "")
    if not model_id or "/" not in str(model_id):
        raise ValueError("Model ID is required (format: owner/name, e.g. stability-ai/sdxl)")

    owner, name = str(model_id).split("/", 1)

    # Resolve version
    version_id = node.params.get("_version_id", "")
    if not version_id:
        version_id = await _resolve_version(owner, name, api_key)

    # Build input dict from node params and connected inputs
    prediction_input: dict[str, Any] = {}

    # Map connected inputs to prediction input
    for input_key, input_val in inputs.items():
        if input_val.value is not None:
            prediction_input[input_key] = input_val.value

    # Map node params (excluding our internal keys) to prediction input
    INTERNAL_KEYS = {"model_id", "_version_id", "_schema_fetched"}
    for param_key, param_val in node.params.items():
        if param_key not in INTERNAL_KEYS and param_val is not None and param_val != "":
            prediction_input[param_key] = param_val

    submit_body: dict[str, Any] = {
        "version": version_id,
        "input": prediction_input,
    }

    config = AsyncPollConfig(
        submit_url=f"{REPLICATE_API_BASE}/predictions",
        poll_url_template=f"{REPLICATE_API_BASE}/predictions/{{task_id}}",
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "application/json",
        },
        terminal_success={"succeeded"},
        terminal_failure={"failed", "canceled"},
        status_path="status",
        task_id_path="id",
        poll_interval=2.0,
        max_polls=300,
        timeout=30.0,
    )

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    result = await async_poll_execute(
        config=config,
        submit_body=submit_body,
        node_id=node.id,
        emit=emit or noop_emit,
    )

    output = result.get("output")
    if output is None:
        raise RuntimeError("Replicate returned no output")

    return _infer_output_type(output)
```

- [ ] **Step 2: Register the handler**

In `backend/execution/sync_runner.py`, inside the `if emit is not None` block, add:

```python
from handlers.replicate_universal import handle_replicate_universal

async def _replicate_handler(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    return await handle_replicate_universal(node, inputs, api_keys, emit=emit)

registry["replicate-universal"] = _replicate_handler
```

- [ ] **Step 3: Write Replicate handler tests**

Create `backend/tests/test_replicate_handler.py`:

```python
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from handlers.replicate_universal import handle_replicate_universal, _infer_output_type
from models.graph import GraphNode, PortValueDict


def _make_node(params=None):
    return GraphNode(
        id="test-rep-1",
        definitionId="replicate-universal",
        params=params or {"model_id": "stability-ai/sdxl", "_version_id": "v123"},
    )


class TestOutputTypeInference:
    def test_image_url(self) -> None:
        result = _infer_output_type("https://example.com/output.png")
        assert result["image"]["type"] == "Image"

    def test_video_url(self) -> None:
        result = _infer_output_type("https://example.com/output.mp4")
        assert result["video"]["type"] == "Video"

    def test_audio_url(self) -> None:
        result = _infer_output_type("https://example.com/output.wav")
        assert result["audio"]["type"] == "Audio"

    def test_plain_text(self) -> None:
        result = _infer_output_type("Hello world")
        assert result["text"]["type"] == "Text"

    def test_url_list(self) -> None:
        result = _infer_output_type(["https://example.com/a.png", "https://example.com/b.png"])
        assert result["image"]["type"] == "Image"

    def test_generic_url_defaults_to_image(self) -> None:
        result = _infer_output_type("https://example.com/some-output")
        assert result["image"]["type"] == "Image"


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="REPLICATE_API_TOKEN"):
        await handle_replicate_universal(_make_node(), {}, {})


@pytest.mark.asyncio
async def test_invalid_model_id_raises():
    with pytest.raises(ValueError, match="[Mm]odel ID"):
        await handle_replicate_universal(
            _make_node({"model_id": "no-slash"}),
            {},
            {"REPLICATE_API_TOKEN": "r8_test"},
        )


@pytest.mark.asyncio
async def test_submit_and_poll_returns_image():
    with patch("handlers.replicate_universal.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {
            "id": "pred-123",
            "status": "succeeded",
            "output": ["https://replicate.delivery/output.png"],
        }

        result = await handle_replicate_universal(
            _make_node(),
            {"prompt": PortValueDict(type="Text", value="A sunset")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )

    assert result["image"]["type"] == "Image"
    assert "output.png" in result["image"]["value"]


@pytest.mark.asyncio
async def test_text_model_returns_text():
    with patch("handlers.replicate_universal.async_poll_execute", new_callable=AsyncMock) as mock_poll:
        mock_poll.return_value = {
            "id": "pred-456",
            "status": "succeeded",
            "output": "Once upon a time...",
        }

        result = await handle_replicate_universal(
            _make_node({"model_id": "meta/llama-2-70b", "_version_id": "v789"}),
            {"prompt": PortValueDict(type="Text", value="Tell me a story")},
            {"REPLICATE_API_TOKEN": "r8_test"},
            emit=AsyncMock(),
        )

    assert result["text"]["type"] == "Text"
    assert "Once upon" in result["text"]["value"]


@pytest.mark.asyncio
async def test_resolves_version_when_not_cached():
    """When _version_id is empty, handler should fetch it from Replicate API."""
    import httpx

    mock_model_response = type("Resp", (), {
        "status_code": 200,
        "json": lambda self: {"latest_version": {"id": "resolved-v1"}},
    })()

    with patch("handlers.replicate_universal._resolve_version", new_callable=AsyncMock) as mock_resolve:
        mock_resolve.return_value = "resolved-v1"
        with patch("handlers.replicate_universal.async_poll_execute", new_callable=AsyncMock) as mock_poll:
            mock_poll.return_value = {"status": "succeeded", "output": "done"}

            result = await handle_replicate_universal(
                _make_node({"model_id": "owner/model", "_version_id": ""}),
                {"prompt": PortValueDict(type="Text", value="test")},
                {"REPLICATE_API_TOKEN": "r8_test"},
                emit=AsyncMock(),
            )

    mock_resolve.assert_called_once_with("owner", "model", "r8_test")
```

Run: `cd backend && python -m pytest tests/test_replicate_handler.py -v`

---

## Task 5: FAL Universal Handler

**Files:**
- Create: `backend/handlers/fal_universal.py`
- Modify: `backend/execution/sync_runner.py`
- Create: `backend/tests/test_fal_handler.py`

### Estimated time: 35 minutes

- [ ] **Step 1: Create the FAL universal handler**

FAL uses a queue-based API: submit to `POST queue.fal.run/{endpoint}`, poll `GET .../status`, then fetch result from `GET .../requests/{id}`. We use httpx directly (no fal_client package) for consistency with our other handlers.

Create `backend/handlers/fal_universal.py`:

```python
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import httpx

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent, ProgressEvent
from services.output import get_run_dir, save_base64_image

FAL_QUEUE_BASE = "https://queue.fal.run"


async def handle_fal_universal(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Callable[[ExecutionEvent], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    api_key = api_keys.get("FAL_KEY")
    if not api_key:
        raise ValueError("FAL_KEY is required")

    endpoint_id = node.params.get("endpoint_id", "")
    if not endpoint_id:
        raise ValueError("FAL endpoint ID is required (e.g. fal-ai/flux-pro/v1.1-ultra)")

    endpoint_id = str(endpoint_id).strip("/")

    # Build input payload
    fal_input: dict[str, Any] = {}

    # Map connected inputs
    prompt_input = inputs.get("prompt")
    if prompt_input and prompt_input.value:
        fal_input["prompt"] = str(prompt_input.value)

    image_input = inputs.get("image")
    if image_input and image_input.value:
        fal_input["image_url"] = str(image_input.value)

    # Map node params (excluding our internal keys)
    INTERNAL_KEYS = {"endpoint_id"}
    for param_key, param_val in node.params.items():
        if param_key not in INTERNAL_KEYS and param_val is not None and param_val != "":
            fal_input[param_key] = param_val

    headers = {
        "Authorization": f"Key {api_key}",
        "Content-Type": "application/json",
    }

    async def noop_emit(event: ExecutionEvent) -> None:
        pass

    _emit = emit or noop_emit

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Step 1: Submit to queue
        submit_resp = await client.post(
            f"{FAL_QUEUE_BASE}/{endpoint_id}",
            headers=headers,
            json=fal_input,
        )
        if submit_resp.status_code not in (200, 201):
            raise RuntimeError(f"FAL submit failed ({submit_resp.status_code}): {submit_resp.text}")

        submit_data = submit_resp.json()
        request_id = submit_data.get("request_id")
        if not request_id:
            raise RuntimeError(f"FAL did not return request_id: {submit_data}")

        # Step 2: Poll for status
        status_url = f"{FAL_QUEUE_BASE}/{endpoint_id}/requests/{request_id}/status"
        result_url = f"{FAL_QUEUE_BASE}/{endpoint_id}/requests/{request_id}"

        max_polls = 300
        poll_interval = 2.0

        for poll_num in range(1, max_polls + 1):
            await asyncio.sleep(poll_interval)

            status_resp = await client.get(status_url, headers=headers)
            if status_resp.status_code != 200:
                raise RuntimeError(f"FAL status poll failed ({status_resp.status_code}): {status_resp.text}")

            status_data = status_resp.json()
            status = status_data.get("status", "")

            progress = min(poll_num / max_polls, 0.99)
            await _emit(ProgressEvent(node_id=node.id, value=progress))

            if status == "COMPLETED":
                break
            elif status in ("FAILED", "CANCELLED"):
                error_msg = status_data.get("error", f"FAL job failed with status: {status}")
                raise RuntimeError(f"FAL job failed: {error_msg}")
            # IN_QUEUE or IN_PROGRESS — keep polling
        else:
            raise RuntimeError(f"FAL job timed out after {max_polls} polls")

        # Step 3: Fetch result
        result_resp = await client.get(result_url, headers=headers)
        if result_resp.status_code != 200:
            raise RuntimeError(f"FAL result fetch failed ({result_resp.status_code}): {result_resp.text}")

        result_data = result_resp.json()

    # Parse output — FAL endpoints vary, but common patterns:
    # Image endpoints: {"images": [{"url": "...", "content_type": "image/png"}]}
    # Audio endpoints: {"audio_url": "..."}
    # Text endpoints: {"text": "..."}
    return _parse_fal_output(result_data)


def _parse_fal_output(data: dict[str, Any]) -> dict[str, Any]:
    """Parse FAL output into our standard port format."""
    # Image output (most common)
    images = data.get("images", [])
    if images and isinstance(images, list) and len(images) > 0:
        first_image = images[0]
        if isinstance(first_image, dict):
            url = first_image.get("url", "")
        else:
            url = str(first_image)
        if url:
            return {"image": {"type": "Image", "value": url}}

    # Single image URL
    image_url = data.get("image", {})
    if isinstance(image_url, dict) and image_url.get("url"):
        return {"image": {"type": "Image", "value": image_url["url"]}}
    if isinstance(image_url, str) and image_url:
        return {"image": {"type": "Image", "value": image_url}}

    # Audio output
    audio_url = data.get("audio_url") or data.get("audio", {}).get("url", "")
    if audio_url:
        return {"audio": {"type": "Audio", "value": audio_url}}

    # Video output
    video_url = data.get("video", {}).get("url", "") or data.get("video_url", "")
    if video_url:
        return {"video": {"type": "Video", "value": video_url}}

    # Text fallback
    text = data.get("text", data.get("output", ""))
    if text:
        return {"text": {"type": "Text", "value": str(text)}}

    # Last resort — return the raw JSON as text
    import json
    return {"text": {"type": "Text", "value": json.dumps(data, indent=2)}}
```

- [ ] **Step 2: Register the handler**

In `backend/execution/sync_runner.py`, inside the `if emit is not None` block, add:

```python
from handlers.fal_universal import handle_fal_universal

async def _fal_handler(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
) -> dict[str, Any]:
    return await handle_fal_universal(node, inputs, api_keys, emit=emit)

registry["fal-universal"] = _fal_handler
```

- [ ] **Step 3: Write FAL handler tests**

Create `backend/tests/test_fal_handler.py`:

```python
from __future__ import annotations

from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from handlers.fal_universal import handle_fal_universal, _parse_fal_output
from models.graph import GraphNode, PortValueDict


def _make_node(params=None):
    return GraphNode(
        id="test-fal-1",
        definitionId="fal-universal",
        params=params or {"endpoint_id": "fal-ai/flux-pro/v1.1-ultra"},
    )


class TestParseFalOutput:
    def test_images_list(self) -> None:
        result = _parse_fal_output({"images": [{"url": "https://fal.ai/output.png", "content_type": "image/png"}]})
        assert result["image"]["type"] == "Image"
        assert "output.png" in result["image"]["value"]

    def test_single_image_dict(self) -> None:
        result = _parse_fal_output({"image": {"url": "https://fal.ai/img.jpg"}})
        assert result["image"]["type"] == "Image"

    def test_audio_url(self) -> None:
        result = _parse_fal_output({"audio_url": "https://fal.ai/audio.mp3"})
        assert result["audio"]["type"] == "Audio"

    def test_video_output(self) -> None:
        result = _parse_fal_output({"video": {"url": "https://fal.ai/vid.mp4"}})
        assert result["video"]["type"] == "Video"

    def test_text_fallback(self) -> None:
        result = _parse_fal_output({"text": "Hello from FAL"})
        assert result["text"]["type"] == "Text"

    def test_raw_json_last_resort(self) -> None:
        result = _parse_fal_output({"some_unknown_field": 42})
        assert result["text"]["type"] == "Text"
        assert "some_unknown_field" in result["text"]["value"]


@pytest.mark.asyncio
async def test_missing_api_key_raises():
    with pytest.raises(ValueError, match="FAL_KEY"):
        await handle_fal_universal(_make_node(), {}, {})


@pytest.mark.asyncio
async def test_missing_endpoint_raises():
    with pytest.raises(ValueError, match="endpoint"):
        await handle_fal_universal(
            _make_node({"endpoint_id": ""}),
            {},
            {"FAL_KEY": "fal_test"},
        )


@pytest.mark.asyncio
async def test_submit_poll_and_result():
    """Test the full submit -> poll -> fetch result flow."""
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-123"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "COMPLETED"}

    mock_result = MagicMock()
    mock_result.status_code = 200
    mock_result.json.return_value = {
        "images": [{"url": "https://fal.ai/output.png", "content_type": "image/png"}]
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
                _make_node(),
                {"prompt": PortValueDict(type="Text", value="A mountain landscape")},
                {"FAL_KEY": "fal_test"},
                emit=AsyncMock(),
            )

    assert result["image"]["type"] == "Image"
    assert "output.png" in result["image"]["value"]


@pytest.mark.asyncio
async def test_job_failure_propagates():
    mock_submit = MagicMock()
    mock_submit.status_code = 200
    mock_submit.json.return_value = {"request_id": "req-fail"}

    mock_status = MagicMock()
    mock_status.status_code = 200
    mock_status.json.return_value = {"status": "FAILED", "error": "Model crashed"}

    with patch("handlers.fal_universal.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_submit
        mock_client.get.return_value = mock_status
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        with patch("handlers.fal_universal.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="Model crashed"):
                await handle_fal_universal(
                    _make_node(),
                    {"prompt": PortValueDict(type="Text", value="test")},
                    {"FAL_KEY": "fal_test"},
                    emit=AsyncMock(),
                )
```

Run: `cd backend && python -m pytest tests/test_fal_handler.py -v`

---

## Task 6: Frontend OpenRouter Model Selector (Dynamic Port Configuration)

**Why this is after the handlers:** The backend proxy and handler are ready, so we can now build the interactive model selection UI that auto-configures ports based on the selected model's modalities.

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/src/components/panels/Inspector.tsx`
- Modify: `frontend/src/components/nodes/DynamicNode.tsx`

### Estimated time: 35 minutes

- [ ] **Step 1: Add model fetch + port reconfiguration logic to graphStore**

Add a new method `configureOpenRouterModel` that fetches the model list and reconfigures the node's dynamic ports based on the selected model's modalities:

```typescript
// Add to GraphState interface:
configureOpenRouterModel: (nodeId: string, modelId: string, model: OpenRouterModel) => void;

// Add to store implementation:
configureOpenRouterModel: (nodeId, modelId, model) => {
  const inputModalities = model.input_modalities || ['text'];
  const outputModalities = model.output_modalities || ['text'];

  // Build input ports based on model capabilities
  const inputPorts: DynamicPortDefinition[] = [
    { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
  ];
  if (inputModalities.includes('image')) {
    inputPorts.push({ id: 'images', label: 'Images', dataType: 'Image', required: false });
  }

  // Build output ports based on model capabilities
  const outputPorts: DynamicPortDefinition[] = [];
  if (outputModalities.includes('text')) {
    outputPorts.push({ id: 'text', label: 'Text', dataType: 'Text', required: false });
  }
  if (outputModalities.includes('image')) {
    outputPorts.push({ id: 'image', label: 'Image', dataType: 'Image', required: false });
  }

  // If model can output images, set internal flag so handler knows
  const wantsImage = outputModalities.includes('image');

  set((state) => ({
    nodes: state.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const data = n.data as DynamicNodeData;
      return {
        ...n,
        data: {
          ...data,
          modelId,
          params: { ...data.params, model: modelId, _output_image: wantsImage },
          dynamicInputPorts: inputPorts,
          dynamicOutputPorts: outputPorts,
        },
      };
    }),
    // Remove edges connected to ports that no longer exist
    edges: state.edges.filter((e) => {
      if (e.source === nodeId) {
        return outputPorts.some((p) => p.id === e.sourceHandle);
      }
      if (e.target === nodeId) {
        return inputPorts.some((p) => p.id === e.targetHandle);
      }
      return true;
    }),
  }));
},
```

- [ ] **Step 2: Add OpenRouter model selector in Inspector**

When an `openrouter-universal` node is selected, the Inspector should show a searchable model dropdown instead of a plain text field for the `model` param. Add this logic inside Inspector:

```typescript
// At the top of Inspector component, add state for model list:
const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
const [modelsLoading, setModelsLoading] = useState(false);
const [modelSearch, setModelSearch] = useState('');
const configureOpenRouterModel = useGraphStore((s) => s.configureOpenRouterModel);

// Fetch models when an OpenRouter node is selected
useEffect(() => {
  if (!nodeData || nodeData.definitionId !== 'openrouter-universal') return;
  setModelsLoading(true);
  fetchOpenRouterModels()
    .then((data) => setOpenRouterModels(data.models))
    .catch((err) => console.error('Failed to load OpenRouter models:', err))
    .finally(() => setModelsLoading(false));
}, [nodeData?.definitionId]);

// Filter models by search
const filteredModels = useMemo(() => {
  if (!modelSearch.trim()) return openRouterModels.slice(0, 50); // Show first 50
  const lower = modelSearch.toLowerCase();
  return openRouterModels
    .filter((m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower))
    .slice(0, 50);
}, [openRouterModels, modelSearch]);

// Then, in the params rendering, replace the `model` param for OpenRouter nodes
// with a custom searchable select:
{nodeData.definitionId === 'openrouter-universal' && param.key === 'model' ? (
  <div>
    <input
      className="inspector__field"
      type="text"
      placeholder={modelsLoading ? 'Loading models...' : 'Search models...'}
      value={modelSearch}
      onChange={(e) => setModelSearch(e.target.value)}
    />
    <select
      className="inspector__field"
      style={{ marginTop: 4 }}
      value={String(nodeData.params.model ?? '')}
      onChange={(e) => {
        const selected = openRouterModels.find((m) => m.id === e.target.value);
        if (selected && selectedNodeId) {
          configureOpenRouterModel(selectedNodeId, selected.id, selected);
        }
      }}
    >
      <option value="">-- Select a model --</option>
      {filteredModels.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} ({m.id})
        </option>
      ))}
    </select>
    {nodeData.params.model && (
      <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>
        Selected: {String(nodeData.params.model)}
      </div>
    )}
  </div>
) : /* ... existing param rendering ... */}
```

---

## Task 7: Frontend Replicate Schema Fetch + Dynamic Params

**Files:**
- Modify: `frontend/src/store/graphStore.ts`
- Modify: `frontend/src/components/panels/Inspector.tsx`

### Estimated time: 30 minutes

- [ ] **Step 1: Add Replicate schema fetch + port configuration to graphStore**

```typescript
// Add to GraphState interface:
fetchReplicateSchemaAndConfigure: (nodeId: string, owner: string, name: string) => Promise<void>;

// Add to store implementation:
fetchReplicateSchemaAndConfigure: async (nodeId, owner, name) => {
  try {
    const schema = await fetchReplicateSchema(owner, name);

    // Parse input schema properties into dynamic params and ports
    const inputProps = (schema.input_schema as any)?.properties ?? {};
    const requiredInputs: string[] = (schema.input_schema as any)?.required ?? [];
    const dynamicParams: DynamicParamDefinition[] = [];
    const inputPorts: DynamicPortDefinition[] = [];

    for (const [key, prop] of Object.entries(inputProps)) {
      const p = prop as Record<string, any>;
      const description = p.description ?? '';
      const isUploadable = p['x-uploadable'] === true;
      const format = p.format ?? '';

      // If it's an uploadable URI or looks like an image input, make it a port
      if (isUploadable || format === 'uri') {
        inputPorts.push({
          id: key,
          label: key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          dataType: 'Image',
          required: requiredInputs.includes(key),
        });
        continue;
      }

      // Otherwise, make it a param
      let paramType: DynamicParamDefinition['type'] = 'string';
      if (p.type === 'integer') paramType = 'integer';
      else if (p.type === 'number') paramType = 'float';
      else if (p.type === 'boolean') paramType = 'boolean';
      else if (p.enum) paramType = 'enum';

      const param: DynamicParamDefinition = {
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        type: paramType,
        required: requiredInputs.includes(key),
        default: p.default,
        placeholder: description.slice(0, 80),
      };

      if (p.enum) {
        param.options = p.enum.map((v: string | number) => ({ label: String(v), value: v }));
      }
      if (p.minimum !== undefined) param.min = p.minimum;
      if (p.maximum !== undefined) param.max = p.maximum;

      dynamicParams.push(param);
    }

    // Infer output ports from output schema
    const outputPorts: DynamicPortDefinition[] = [];
    const outputSchema = schema.output_schema as any;

    if (outputSchema?.type === 'string' && outputSchema?.format === 'uri') {
      outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
    } else if (outputSchema?.type === 'array') {
      outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
    } else {
      outputPorts.push({ id: 'text', label: 'Output', dataType: 'Text', required: false });
    }

    // Apply defaults to params
    const paramDefaults: Record<string, unknown> = {};
    for (const dp of dynamicParams) {
      if (dp.default !== undefined) paramDefaults[dp.key] = dp.default;
    }

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const data = n.data as DynamicNodeData;
        return {
          ...n,
          data: {
            ...data,
            params: { ...data.params, ...paramDefaults, _version_id: schema.version_id, _schema_fetched: true },
            dynamicInputPorts: inputPorts,
            dynamicOutputPorts: outputPorts,
            dynamicParams,
            providerMeta: { ...data.providerMeta, version_id: schema.version_id, description: schema.description },
          },
        };
      }),
    }));
  } catch (err) {
    console.error('Failed to fetch Replicate schema:', err);
  }
},
```

- [ ] **Step 2: Add "Fetch Schema" button in Inspector for Replicate nodes**

In the Inspector, when a `replicate-universal` node is selected and the `model_id` param is shown, add a "Fetch Schema" button below the text input:

```typescript
const fetchReplicateSchema = useGraphStore((s) => s.fetchReplicateSchemaAndConfigure);
const [schemaLoading, setSchemaLoading] = useState(false);

// In the params rendering, after the model_id field for replicate-universal:
{nodeData.definitionId === 'replicate-universal' && param.key === 'model_id' && (
  <button
    className="inspector__action-button"
    style={{ marginTop: 4, width: '100%' }}
    disabled={schemaLoading || !nodeData.params.model_id}
    onClick={async () => {
      const modelId = String(nodeData.params.model_id ?? '');
      if (!modelId.includes('/')) return;
      const [owner, name] = modelId.split('/', 2);
      setSchemaLoading(true);
      try {
        await fetchReplicateSchema(selectedNodeId!, owner, name);
      } finally {
        setSchemaLoading(false);
      }
    }}
  >
    {schemaLoading ? 'Fetching...' : (nodeData.params._schema_fetched ? 'Refresh Schema' : 'Fetch Schema')}
  </button>
)}
```

---

## Task 8: Integration Testing + Final Wiring

**Files:**
- Modify: `backend/execution/sync_runner.py` (verify all handlers are wired)
- All test files

### Estimated time: 20 minutes

- [ ] **Step 1: Verify the complete handler registry**

The final `get_handler_registry` in `backend/execution/sync_runner.py` should look like:

```python
from __future__ import annotations

from typing import Any, Awaitable, Callable

from models.graph import GraphNode, PortValueDict
from models.events import ExecutionEvent
from handlers.openai_image import handle_openai_image_generate


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
    registry = dict(SYNC_HANDLERS)

    if emit is not None:
        from handlers.runway import handle_runway_gen4_turbo
        from handlers.anthropic_chat import handle_claude_chat
        from handlers.openrouter import handle_openrouter_universal
        from handlers.replicate_universal import handle_replicate_universal
        from handlers.fal_universal import handle_fal_universal

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

        async def _openrouter_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_openrouter_universal(node, inputs, api_keys, emit=emit)

        async def _replicate_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_replicate_universal(node, inputs, api_keys, emit=emit)

        async def _fal_handler(
            node: GraphNode,
            inputs: dict[str, PortValueDict],
            api_keys: dict[str, str],
        ) -> dict[str, Any]:
            return await handle_fal_universal(node, inputs, api_keys, emit=emit)

        registry["runway-gen4-turbo"] = _runway_handler
        registry["claude-chat"] = _claude_handler
        registry["openrouter-universal"] = _openrouter_handler
        registry["replicate-universal"] = _replicate_handler
        registry["fal-universal"] = _fal_handler

    return registry
```

- [ ] **Step 2: Run the full test suite**

```bash
cd backend && python -m pytest tests/ -v --tb=short
```

Expected output: All existing tests pass, plus the new tests:
- `test_openrouter_handler.py` (5 tests)
- `test_replicate_handler.py` (7 tests)
- `test_fal_handler.py` (6 tests)
- `test_engine.py` updated (3 new tests for dynamic node validation)

- [ ] **Step 3: Manual smoke test**

Start the backend and frontend:
```bash
cd backend && uvicorn main:app --reload &
cd frontend && npm run dev &
```

Test sequence:
1. Open the app at `http://localhost:5173`
2. In Settings, add `OPENROUTER_API_KEY`
3. Drag "OpenRouter" node from the Universal category
4. In Inspector, search for "gpt-4o" and select it
5. Verify the node shows Text input + Text output ports
6. Connect a Text Input node to the Messages port
7. Run the node — verify streaming text output
8. Search for an image model (e.g. "dall-e-3"), select it
9. Verify the node reconfigures to show an Image output port
10. Add `REPLICATE_API_TOKEN` in Settings
11. Drag a Replicate node, enter "stability-ai/sdxl", click "Fetch Schema"
12. Verify dynamic params appear (prompt, width, height, etc.)
13. Add `FAL_KEY` in Settings
14. Drag a FAL node — default endpoint is `fal-ai/flux-pro/v1.1-ultra`
15. Connect a prompt, run it, verify image output

---

## Architecture Decisions & Rationale

### Why a separate `DynamicNode` component instead of extending `ModelNode`?

`ModelNode` has a clean contract: it reads everything from `NODE_DEFINITIONS[definitionId]`. Making it conditionally read from `node.data.dynamicPorts` would add branching to every port-rendering line. A separate component keeps both implementations clean and lets us add dynamic-only features (model badge, schema-fetch loading state) without cluttering the static node.

### Why store dynamic ports in node data instead of a separate store?

React Flow serializes `node.data` automatically for save/load. If dynamic ports lived in a separate Zustand slice, the `.nebula` save/load from Milestone 4A would miss them. Putting everything in `data` means save/load works with zero changes.

### Why proxy the model list through the backend?

Two reasons: (1) CORS — browser requests to `openrouter.ai` are blocked by same-origin policy. (2) Caching — the OpenRouter model list is ~1MB. Fetching it on every panel open would be slow. The backend caches it for 5 minutes.

### Why httpx for FAL instead of fal_client?

Consistency. Every other handler uses httpx. The `fal_client` package would add a dependency that does exactly what 30 lines of httpx code does. Also, the queue API is well-documented REST — no SDK magic needed.

### Why `_get_nested` needs array index support

OpenRouter's SSE format uses the standard OpenAI chat/completions streaming structure: `choices[0].delta.content`. The path is `choices.0.delta.content`. Without array index support in `_get_nested`, the stream runner can't extract deltas.

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| OpenRouter model list is huge (~1000 models) | Backend caches for 5 min; frontend caps visible list at 50 with search filter |
| Replicate schema fetch is slow (2 API calls) | Backend caches for 1 hour; schemas rarely change |
| FAL endpoint IDs are opaque (no schema API) | Use sensible defaults; user enters endpoint ID manually |
| Dynamic port changes break existing edges | `configureOpenRouterModel` prunes stale edges when ports change |
| `_get_nested` change could break existing handlers | Added array support alongside dict support; existing dot paths still work |
| Save/load of dynamic nodes | `DynamicNodeData` extends `NodeData` — existing save/load serializes all fields in `data` |

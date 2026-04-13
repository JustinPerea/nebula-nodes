# Milestone 1: Interactive Canvas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully interactive node editor canvas where users can add, drag, connect, and select AI model nodes with typed ports and validated edges.

**Architecture:** React + Vite frontend with @xyflow/react (React Flow v12) handling all canvas interactions (pan, zoom, drag, connect, select). Zustand stores manage graph state (nodes, edges) and UI state (panel positions, selection). Custom node components render compact cards with colored port dots. All type checking and cycle detection happens at connection time.

**Tech Stack:** React 19, Vite, TypeScript, @xyflow/react v12, Zustand, vitest, @testing-library/react, uuid

**Reference docs:**
- Design spec: `docs/superpowers/specs/2026-04-13-nebula-node-design.md`
- Architecture spec: `docs/perplexity-research/AI Node Editor — Architecture & Interaction Spec v2.md`
- Edge cases: `docs/perplexity-research/nebula-edge-cases.md`

---

## File Structure

```
nebula_nodes/
├── frontend/
│   ├── src/
│   │   ├── main.tsx                        # React entry point
│   │   ├── App.tsx                         # Root component, renders Canvas
│   │   ├── App.css                         # Global styles (minimal mono theme)
│   │   ├── types/
│   │   │   └── index.ts                    # All TypeScript interfaces: Node, Edge, Port, PortValue, etc.
│   │   ├── constants/
│   │   │   ├── ports.ts                    # Port colors, compatibility table
│   │   │   └── nodeDefinitions.ts          # Hardcoded node definitions for MVP (GPT Image 1, FLUX, Claude, etc.)
│   │   ├── store/
│   │   │   ├── graphStore.ts               # Zustand: nodes, edges, add/remove/update, onNodesChange with orphan cleanup
│   │   │   └── uiStore.ts                  # Zustand: selected node, panel visibility/positions, settings
│   │   ├── hooks/
│   │   │   └── useIsValidConnection.ts     # Cycle detection + port type validation
│   │   ├── lib/
│   │   │   └── portCompatibility.ts        # Pure functions: isCompatible, getCompatibleTypes
│   │   ├── components/
│   │   │   ├── Canvas.tsx                  # ReactFlow wrapper, dark theme, grid, event handlers
│   │   │   ├── nodes/
│   │   │   │   └── ModelNode.tsx           # Custom node: header + ports + preview area
│   │   │   ├── edges/
│   │   │   │   └── TypedEdge.tsx           # Custom edge: colored bezier by data type
│   │   │   └── panels/
│   │   │       ├── NodeLibrary.tsx         # Floating searchable node list
│   │   │       ├── Inspector.tsx           # Floating panel for selected node params (placeholder for M1)
│   │   │       └── Toolbar.tsx             # Bottom-center pill: Run, Fit, Settings buttons
│   │   └── styles/
│   │       ├── nodes.css                   # Node component styles
│   │       ├── panels.css                  # Panel styles
│   │       └── canvas.css                  # Canvas/edge overrides
│   ├── tests/
│   │   ├── lib/
│   │   │   └── portCompatibility.test.ts   # Port type compatibility tests
│   │   ├── store/
│   │   │   ├── graphStore.test.ts          # Graph store unit tests
│   │   │   └── uiStore.test.ts             # UI store unit tests
│   │   └── hooks/
│   │       └── useIsValidConnection.test.ts # Cycle detection tests
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── vite.config.ts
│   └── vitest.config.ts
├── backend/                                 # Created empty, populated in Milestone 2
├── output/                                  # Gitignored
├── docs/                                    # Already exists
├── .gitignore
├── .env.example
└── README.md
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `frontend/` (via Vite scaffold)
- Create: `.gitignore`
- Create: `.env.example`
- Create: `backend/` (empty placeholder)

- [ ] **Step 1: Initialize git repo**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git init
```

- [ ] **Step 2: Create .gitignore**

Create `.gitignore`:

```gitignore
# Dependencies
node_modules/
__pycache__/
*.pyc
.venv/

# Build output
frontend/dist/
*.egg-info/

# Environment & secrets
.env
settings.json

# Generated output
output/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Superpowers brainstorm sessions
.superpowers/

# SQLite (future)
*.db
```

- [ ] **Step 3: Create .env.example**

Create `.env.example`:

```bash
# Copy to .env and fill in your keys
# Only fill in the providers you use — leave the rest blank

# OpenAI (GPT Image 1, GPT-4o, DALL-E, Sora 2)
OPENAI_API_KEY=

# Anthropic (Claude)
ANTHROPIC_API_KEY=

# Google (Gemini, Imagen 4, Nano Banana)
GOOGLE_API_KEY=

# FAL (covers Kling, FLUX, Veo 3, Wan, LTX, Pixverse, Seedance, Luma, Sora, etc.)
FAL_KEY=

# Runway
RUNWAY_API_KEY=

# ElevenLabs
ELEVENLABS_API_KEY=

# Replicate
REPLICATE_API_TOKEN=

# OpenRouter
OPENROUTER_API_KEY=

# Black Forest Labs (FLUX direct)
BFL_API_KEY=

# ByteDance (Seedream)
BYTEDANCE_API_KEY=

# MiniMax
MINIMAX_API_KEY=

# xAI (Grok)
XAI_API_KEY=

# Recraft
RECRAFT_API_KEY=

# Ideogram
IDEOGRAM_API_KEY=

# Higgsfield
HIGGSFIELD_API_KEY=
```

- [ ] **Step 4: Scaffold Vite React TypeScript project**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
npm create vite@latest frontend -- --template react-ts
```

- [ ] **Step 5: Install dependencies**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npm install @xyflow/react zustand uuid
npm install -D @types/uuid vitest @testing-library/react @testing-library/jest-dom jsdom
```

- [ ] **Step 6: Create vitest config**

Create `frontend/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
});
```

- [ ] **Step 7: Create empty backend directory**

```bash
mkdir -p /Users/justinperea/Documents/Projects/nebula_nodes/backend
touch /Users/justinperea/Documents/Projects/nebula_nodes/backend/.gitkeep
```

- [ ] **Step 8: Delete mydatabase.db (artifact from empty project)**

```bash
rm /Users/justinperea/Documents/Projects/nebula_nodes/mydatabase.db
```

- [ ] **Step 9: Verify project runs**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npm run dev
```

Expected: Vite dev server starts on `localhost:5173` with default React template.

- [ ] **Step 10: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add .gitignore .env.example frontend/ backend/.gitkeep docs/
git commit -m "feat: scaffold Vite React TS project with dependencies"
```

---

## Task 2: TypeScript Types

**Files:**
- Create: `frontend/src/types/index.ts`

- [ ] **Step 1: Define all core interfaces**

Create `frontend/src/types/index.ts`:

```typescript
export type PortDataType =
  | 'Text'
  | 'Image'
  | 'Video'
  | 'Audio'
  | 'Mask'
  | 'Array'
  | 'SVG'
  | 'Any';

export type NodeCategory =
  | 'image-gen'
  | 'video-gen'
  | 'text-gen'
  | 'audio-gen'
  | 'transform'
  | 'analyzer'
  | 'utility';

export type NodeState = 'idle' | 'queued' | 'executing' | 'complete' | 'error';

export type ExecutionPattern = 'sync' | 'async-poll' | 'stream';

export type APIProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'runway'
  | 'kling'
  | 'elevenlabs'
  | 'replicate'
  | 'fal'
  | 'bytedance'
  | 'minimax'
  | 'luma'
  | 'xai'
  | 'recraft'
  | 'ideogram'
  | 'openrouter'
  | 'bfl';

export interface PortDefinition {
  id: string;
  label: string;
  dataType: PortDataType;
  required: boolean;
  multiple?: boolean;
  maxConnections?: number;
}

export interface ParamDefinition {
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
  condition?: string;
}

export interface ModelNodeDefinition {
  id: string;
  displayName: string;
  category: NodeCategory;
  apiProvider: APIProvider;
  apiEndpoint: string;
  envKeyName: string | string[];
  executionPattern: ExecutionPattern;
  inputPorts: PortDefinition[];
  outputPorts: PortDefinition[];
  params: ParamDefinition[];
  docUrl?: string;
}

export interface PortValue {
  type: PortDataType;
  value: string | string[] | { url: string; mimeType: string } | ArrayBuffer | null;
}

export interface NodeData {
  label: string;
  definitionId: string;
  params: Record<string, unknown>;
  state: NodeState;
  progress?: number;
  outputs: Record<string, PortValue>;
  error?: string;
  keyStatus?: 'ok' | 'missing';
}

export type CanvasMode =
  | 'idle'
  | 'panning'
  | 'node-dragging'
  | 'port-connecting'
  | 'rubber-band-select'
  | 'node-resizing'
  | 'context-menu';
```

- [ ] **Step 2: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/types/
git commit -m "feat: define core TypeScript interfaces for nodes, edges, ports"
```

---

## Task 3: Port Constants & Compatibility

**Files:**
- Create: `frontend/src/constants/ports.ts`
- Create: `frontend/src/lib/portCompatibility.ts`
- Create: `frontend/tests/lib/portCompatibility.test.ts`

- [ ] **Step 1: Write port compatibility tests**

Create `frontend/tests/lib/portCompatibility.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isPortCompatible, PORT_COLORS } from '../../src/lib/portCompatibility';

describe('isPortCompatible', () => {
  it('allows same-type connections', () => {
    expect(isPortCompatible('Text', 'Text')).toBe(true);
    expect(isPortCompatible('Image', 'Image')).toBe(true);
    expect(isPortCompatible('Video', 'Video')).toBe(true);
    expect(isPortCompatible('Audio', 'Audio')).toBe(true);
  });

  it('allows any type to connect to Any port', () => {
    expect(isPortCompatible('Text', 'Any')).toBe(true);
    expect(isPortCompatible('Image', 'Any')).toBe(true);
    expect(isPortCompatible('Video', 'Any')).toBe(true);
  });

  it('allows Any output to connect to any input', () => {
    expect(isPortCompatible('Any', 'Text')).toBe(true);
    expect(isPortCompatible('Any', 'Image')).toBe(true);
  });

  it('allows Image to Mask with warning', () => {
    expect(isPortCompatible('Image', 'Mask')).toBe(true);
  });

  it('allows Mask to Image with warning', () => {
    expect(isPortCompatible('Mask', 'Image')).toBe(true);
  });

  it('allows SVG to Any', () => {
    expect(isPortCompatible('SVG', 'Any')).toBe(true);
  });

  it('blocks Video to Image', () => {
    expect(isPortCompatible('Video', 'Image')).toBe(false);
  });

  it('blocks Audio to Image', () => {
    expect(isPortCompatible('Audio', 'Image')).toBe(false);
  });

  it('blocks Text to Image', () => {
    expect(isPortCompatible('Text', 'Image')).toBe(false);
  });

  it('blocks Image to Text', () => {
    expect(isPortCompatible('Image', 'Text')).toBe(false);
  });

  it('blocks Video to Audio', () => {
    expect(isPortCompatible('Video', 'Audio')).toBe(false);
  });
});

describe('PORT_COLORS', () => {
  it('has a color for every port type', () => {
    const types = ['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Any'];
    for (const type of types) {
      expect(PORT_COLORS[type as keyof typeof PORT_COLORS]).toBeDefined();
      expect(PORT_COLORS[type as keyof typeof PORT_COLORS]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx vitest run tests/lib/portCompatibility.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement port compatibility**

Create `frontend/src/lib/portCompatibility.ts`:

```typescript
import type { PortDataType } from '../types';

export const PORT_COLORS: Record<PortDataType, string> = {
  Image: '#4CAF50',
  Video: '#F44336',
  Text: '#9C27B0',
  Array: '#2196F3',
  Audio: '#FFC107',
  Mask: '#8BC34A',
  SVG: '#795548',
  Any: '#9E9E9E',
};

const COMPATIBILITY: Record<PortDataType, PortDataType[]> = {
  Text: ['Text', 'Any'],
  Image: ['Image', 'Mask', 'Any'],
  Video: ['Video', 'Any'],
  Audio: ['Audio', 'Any'],
  Mask: ['Mask', 'Image', 'Any'],
  Array: ['Array', 'Any'],
  SVG: ['SVG', 'Any'],
  Any: ['Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Any'],
};

export function isPortCompatible(
  sourceType: PortDataType,
  targetType: PortDataType
): boolean {
  return COMPATIBILITY[sourceType]?.includes(targetType) ?? false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx vitest run tests/lib/portCompatibility.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Create port constants file**

Create `frontend/src/constants/ports.ts`:

```typescript
import type { PortDataType } from '../types';

export const CATEGORY_COLORS: Record<string, string> = {
  'image-gen': '#1565C0',
  'video-gen': '#B71C1C',
  'text-gen': '#4A148C',
  'audio-gen': '#FF6F00',
  'transform': '#004D40',
  'analyzer': '#1B5E20',
  'utility': '#424242',
};

export const PORT_DATA_TYPES: PortDataType[] = [
  'Text', 'Image', 'Video', 'Audio', 'Mask', 'Array', 'SVG', 'Any',
];
```

- [ ] **Step 6: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/lib/ frontend/src/constants/ frontend/tests/
git commit -m "feat: port colors, compatibility table with tests"
```

---

## Task 4: Node Definitions (Hardcoded MVP Set)

**Files:**
- Create: `frontend/src/constants/nodeDefinitions.ts`

- [ ] **Step 1: Create node definitions for starter nodes**

We need enough definitions to test the canvas. Include one node per category: GPT Image 1 (image-gen), Claude (text-gen), Runway Gen-4 (video-gen), ElevenLabs TTS (audio-gen), text-input (utility), image-input (utility), preview (utility).

Create `frontend/src/constants/nodeDefinitions.ts`:

```typescript
import type { ModelNodeDefinition } from '../types';

export const NODE_DEFINITIONS: Record<string, ModelNodeDefinition> = {
  'gpt-image-1-generate': {
    id: 'gpt-image-1-generate',
    displayName: 'GPT Image 1',
    category: 'image-gen',
    apiProvider: 'openai',
    apiEndpoint: '/v1/images/generations',
    envKeyName: 'OPENAI_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: true,
        default: 'gpt-image-1',
        options: [
          { label: 'GPT Image 1', value: 'gpt-image-1' },
          { label: 'GPT Image 1.5', value: 'gpt-image-1.5' },
          { label: 'GPT Image 1 Mini', value: 'gpt-image-1-mini' },
        ],
      },
      {
        key: 'size',
        label: 'Size',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: '1024×1024', value: '1024x1024' },
          { label: '1536×1024', value: '1536x1024' },
          { label: '1024×1536', value: '1024x1536' },
        ],
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'enum',
        required: false,
        default: 'auto',
        options: [
          { label: 'Auto', value: 'auto' },
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
      },
      {
        key: 'n',
        label: 'Count',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 10,
      },
    ],
  },

  'claude-chat': {
    id: 'claude-chat',
    displayName: 'Claude',
    category: 'text-gen',
    apiProvider: 'anthropic',
    apiEndpoint: '/v1/messages',
    envKeyName: 'ANTHROPIC_API_KEY',
    executionPattern: 'stream',
    inputPorts: [
      { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
      { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
    ],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: true,
        default: 'claude-sonnet-4-6',
        options: [
          { label: 'Claude Opus 4', value: 'claude-opus-4-20250514' },
          { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
          { label: 'Claude Haiku 3.5', value: 'claude-haiku-3-5-20241022' },
        ],
      },
      {
        key: 'max_tokens',
        label: 'Max Tokens',
        type: 'integer',
        required: true,
        default: 4096,
        min: 1,
        max: 200000,
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'float',
        required: false,
        default: 1,
        min: 0,
        max: 1,
        step: 0.1,
      },
    ],
  },

  'runway-gen4-turbo': {
    id: 'runway-gen4-turbo',
    displayName: 'Runway Gen-4 Turbo',
    category: 'video-gen',
    apiProvider: 'runway',
    apiEndpoint: '/v1/tasks',
    envKeyName: 'RUNWAY_API_KEY',
    executionPattern: 'async-poll',
    inputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: true },
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: false },
    ],
    outputPorts: [
      { id: 'video', label: 'Video', dataType: 'Video', required: false },
    ],
    params: [
      {
        key: 'model',
        label: 'Model',
        type: 'enum',
        required: true,
        default: 'gen4_turbo',
        options: [
          { label: 'Gen-4 Turbo', value: 'gen4_turbo' },
          { label: 'Gen-4', value: 'gen4' },
          { label: 'Gen-4 Aleph', value: 'gen4_aleph' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'enum',
        required: false,
        default: 5,
        options: [
          { label: '5 seconds', value: 5 },
          { label: '10 seconds', value: 10 },
        ],
      },
    ],
  },

  'elevenlabs-tts': {
    id: 'elevenlabs-tts',
    displayName: 'ElevenLabs TTS',
    category: 'audio-gen',
    apiProvider: 'elevenlabs',
    apiEndpoint: '/v1/text-to-speech/{voice_id}',
    envKeyName: 'ELEVENLABS_API_KEY',
    executionPattern: 'sync',
    inputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: true },
    ],
    outputPorts: [
      { id: 'audio', label: 'Audio', dataType: 'Audio', required: false },
    ],
    params: [
      {
        key: 'model_id',
        label: 'Model',
        type: 'enum',
        required: false,
        default: 'eleven_multilingual_v2',
        options: [
          { label: 'v3 (Highest)', value: 'elevenlabs_v3' },
          { label: 'Multilingual v2', value: 'eleven_multilingual_v2' },
          { label: 'Flash v2.5', value: 'eleven_flash_v2_5' },
        ],
      },
      {
        key: 'stability',
        label: 'Stability',
        type: 'float',
        required: false,
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
      },
    ],
  },

  'flux-1-1-ultra': {
    id: 'flux-1-1-ultra',
    displayName: 'FLUX 1.1 Ultra',
    category: 'image-gen',
    apiProvider: 'fal',
    apiEndpoint: 'fal-ai/flux-pro/v1.1-ultra',
    envKeyName: ['FAL_KEY', 'BFL_API_KEY'],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'prompt', label: 'Prompt', dataType: 'Text', required: true },
      { id: 'image', label: 'Image Guide', dataType: 'Image', required: false },
    ],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'aspect_ratio',
        label: 'Aspect Ratio',
        type: 'enum',
        required: false,
        default: '16:9',
        options: [
          { label: '1:1', value: '1:1' },
          { label: '4:3', value: '4:3' },
          { label: '16:9', value: '16:9' },
          { label: '9:16', value: '9:16' },
        ],
      },
      {
        key: 'num_images',
        label: 'Count',
        type: 'integer',
        required: false,
        default: 1,
        min: 1,
        max: 4,
      },
    ],
  },

  'text-input': {
    id: 'text-input',
    displayName: 'Text Input',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'text', label: 'Text', dataType: 'Text', required: false },
    ],
    params: [
      {
        key: 'value',
        label: 'Text',
        type: 'textarea',
        required: true,
        default: '',
        placeholder: 'Enter text or prompt...',
      },
    ],
  },

  'image-input': {
    id: 'image-input',
    displayName: 'Image Input',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [],
    outputPorts: [
      { id: 'image', label: 'Image', dataType: 'Image', required: false },
    ],
    params: [
      {
        key: 'filePath',
        label: 'File',
        type: 'file',
        required: true,
        default: '',
      },
    ],
  },

  'preview': {
    id: 'preview',
    displayName: 'Preview',
    category: 'utility',
    apiProvider: 'openai',
    apiEndpoint: '',
    envKeyName: [],
    executionPattern: 'sync',
    inputPorts: [
      { id: 'input', label: 'Input', dataType: 'Any', required: true },
    ],
    outputPorts: [],
    params: [],
  },
};

export function getNodeDefinition(definitionId: string): ModelNodeDefinition | undefined {
  return NODE_DEFINITIONS[definitionId];
}

export function getNodesByCategory(): Record<string, ModelNodeDefinition[]> {
  const grouped: Record<string, ModelNodeDefinition[]> = {};
  for (const def of Object.values(NODE_DEFINITIONS)) {
    if (!grouped[def.category]) {
      grouped[def.category] = [];
    }
    grouped[def.category].push(def);
  }
  return grouped;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/constants/nodeDefinitions.ts
git commit -m "feat: hardcoded node definitions for MVP starter set"
```

---

## Task 5: Graph Store (Zustand)

**Files:**
- Create: `frontend/src/store/graphStore.ts`
- Create: `frontend/tests/store/graphStore.test.ts`

- [ ] **Step 1: Write graph store tests**

Create `frontend/tests/store/graphStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';

describe('graphStore', () => {
  beforeEach(() => {
    useGraphStore.setState({ nodes: [], edges: [] });
  });

  it('starts with empty nodes and edges', () => {
    const state = useGraphStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
  });

  it('adds a node', () => {
    const { addNode } = useGraphStore.getState();
    addNode('gpt-image-1-generate', { x: 100, y: 200 });

    const { nodes } = useGraphStore.getState();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('model-node');
    expect(nodes[0].position).toEqual({ x: 100, y: 200 });
    expect(nodes[0].data.definitionId).toBe('gpt-image-1-generate');
    expect(nodes[0].data.label).toBe('GPT Image 1');
    expect(nodes[0].data.state).toBe('idle');
  });

  it('removes a node and cleans up connected edges', () => {
    const { addNode } = useGraphStore.getState();
    addNode('text-input', { x: 0, y: 0 });
    addNode('gpt-image-1-generate', { x: 300, y: 0 });

    const { nodes } = useGraphStore.getState();
    const sourceId = nodes[0].id;
    const targetId = nodes[1].id;

    // Manually add an edge
    useGraphStore.setState((state) => ({
      edges: [
        ...state.edges,
        {
          id: 'test-edge',
          source: sourceId,
          sourceHandle: 'text',
          target: targetId,
          targetHandle: 'prompt',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
      ],
    }));

    expect(useGraphStore.getState().edges).toHaveLength(1);

    // Remove the source node via onNodesChange
    const { onNodesChange } = useGraphStore.getState();
    onNodesChange([{ type: 'remove', id: sourceId }]);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.edges).toHaveLength(0); // edge cleaned up
  });

  it('removes a node without affecting unrelated edges', () => {
    const { addNode } = useGraphStore.getState();
    addNode('text-input', { x: 0, y: 0 });
    addNode('gpt-image-1-generate', { x: 300, y: 0 });
    addNode('preview', { x: 600, y: 0 });

    const { nodes } = useGraphStore.getState();
    const [textNode, gptNode, previewNode] = nodes;

    useGraphStore.setState((state) => ({
      edges: [
        {
          id: 'edge-1',
          source: textNode.id,
          sourceHandle: 'text',
          target: gptNode.id,
          targetHandle: 'prompt',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
        {
          id: 'edge-2',
          source: gptNode.id,
          sourceHandle: 'image',
          target: previewNode.id,
          targetHandle: 'input',
          type: 'typed-edge',
          data: { dataType: 'Image' },
        },
      ],
    }));

    // Remove text-input node — should only remove edge-1
    const { onNodesChange } = useGraphStore.getState();
    onNodesChange([{ type: 'remove', id: textNode.id }]);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].id).toBe('edge-2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx vitest run tests/store/graphStore.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement graph store**

Create `frontend/src/store/graphStore.ts`:

```typescript
import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];

  addNode: (definitionId: string, position: { x: number; y: number }) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],

  addNode: (definitionId, position) => {
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return;

    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) {
        defaults[param.key] = param.default;
      }
    }

    const newNode: Node<NodeData> = {
      id: uuidv4(),
      type: 'model-node',
      position,
      data: {
        label: definition.displayName,
        definitionId,
        params: defaults,
        state: 'idle',
        outputs: {},
      },
    };

    set((state) => ({ nodes: [...state.nodes, newNode] }));
  },

  onNodesChange: (changes) => {
    const removedIds = changes
      .filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove')
      .map((c) => c.id);

    if (removedIds.length > 0) {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
        edges: state.edges.filter(
          (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target)
        ),
      }));
    } else {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
      }));
    }
  },

  onEdgesChange: (changes) => {
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
    }));
  },

  onConnect: (connection) => {
    if (!connection.source || !connection.target) return;

    const sourceNode = get().nodes.find((n) => n.id === connection.source);
    const targetNode = get().nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
    const targetDef = NODE_DEFINITIONS[targetNode.data.definitionId];
    if (!sourceDef || !targetDef) return;

    const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
    const dataType = sourcePort?.dataType ?? 'Any';

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

  updateNodeData: (nodeId, data) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } }
          : node
      ),
    }));
  },
}));
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx vitest run tests/store/graphStore.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/store/graphStore.ts frontend/tests/store/graphStore.test.ts
git commit -m "feat: Zustand graph store with orphaned edge cleanup on node delete"
```

---

## Task 6: UI Store (Zustand)

**Files:**
- Create: `frontend/src/store/uiStore.ts`

- [ ] **Step 1: Create UI store**

Create `frontend/src/store/uiStore.ts`:

```typescript
import { create } from 'zustand';

interface PanelState {
  visible: boolean;
  position: { x: number; y: number };
}

interface UIState {
  selectedNodeId: string | null;
  panels: {
    library: PanelState;
    inspector: PanelState;
  };
  librarySearch: string;

  selectNode: (nodeId: string | null) => void;
  togglePanel: (panel: 'library' | 'inspector') => void;
  setPanelPosition: (panel: 'library' | 'inspector', position: { x: number; y: number }) => void;
  setLibrarySearch: (search: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedNodeId: null,
  panels: {
    library: { visible: true, position: { x: 16, y: 16 } },
    inspector: { visible: false, position: { x: -280, y: 16 } }, // negative x = offset from right
  },
  librarySearch: '',

  selectNode: (nodeId) =>
    set((state) => ({
      selectedNodeId: nodeId,
      panels: {
        ...state.panels,
        inspector: { ...state.panels.inspector, visible: nodeId !== null },
      },
    })),

  togglePanel: (panel) =>
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: { ...state.panels[panel], visible: !state.panels[panel].visible },
      },
    })),

  setPanelPosition: (panel, position) =>
    set((state) => ({
      panels: {
        ...state.panels,
        [panel]: { ...state.panels[panel], position },
      },
    })),

  setLibrarySearch: (search) => set({ librarySearch: search }),
}));
```

- [ ] **Step 2: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/store/uiStore.ts
git commit -m "feat: Zustand UI store for panel state and node selection"
```

---

## Task 7: Cycle Detection Hook

**Files:**
- Create: `frontend/src/hooks/useIsValidConnection.ts`
- Create: `frontend/tests/hooks/useIsValidConnection.test.ts`

- [ ] **Step 1: Write cycle detection tests**

Create `frontend/tests/hooks/useIsValidConnection.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { wouldCreateCycle } from '../../src/hooks/useIsValidConnection';
import type { Node, Edge } from '@xyflow/react';

function makeNode(id: string): Node {
  return { id, position: { x: 0, y: 0 }, data: {} } as Node;
}

function makeEdge(source: string, target: string): Edge {
  return { id: `${source}-${target}`, source, target } as Edge;
}

describe('wouldCreateCycle', () => {
  it('returns false for a simple valid connection', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges: Edge[] = [];
    expect(wouldCreateCycle('a', 'b', nodes, edges)).toBe(false);
  });

  it('returns true for a direct self-loop', () => {
    const nodes = [makeNode('a')];
    const edges: Edge[] = [];
    expect(wouldCreateCycle('a', 'a', nodes, edges)).toBe(true);
  });

  it('returns true for a 2-node cycle', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b')];
    // Trying to connect b -> a would create a cycle
    expect(wouldCreateCycle('b', 'a', nodes, edges)).toBe(true);
  });

  it('returns true for a 3-node cycle', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    // Trying to connect c -> a would create a cycle
    expect(wouldCreateCycle('c', 'a', nodes, edges)).toBe(true);
  });

  it('returns false for a valid chain', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b')];
    // b -> c is fine, no cycle
    expect(wouldCreateCycle('b', 'c', nodes, edges)).toBe(false);
  });

  it('returns false for independent subgraphs', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
    const edges = [makeEdge('a', 'b'), makeEdge('c', 'd')];
    // a -> d is fine, different subgraphs
    expect(wouldCreateCycle('a', 'd', nodes, edges)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx vitest run tests/hooks/useIsValidConnection.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement cycle detection**

Create `frontend/src/hooks/useIsValidConnection.ts`:

```typescript
import { useCallback } from 'react';
import { useReactFlow, getOutgoers, type Node, type Edge, type Connection } from '@xyflow/react';
import { isPortCompatible } from '../lib/portCompatibility';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData, PortDataType } from '../types';

/**
 * Pure function for testing — checks if connecting source -> target would create a cycle.
 */
export function wouldCreateCycle(
  sourceId: string,
  targetId: string,
  nodes: Node[],
  edges: Edge[]
): boolean {
  if (sourceId === targetId) return true;

  const target = nodes.find((n) => n.id === targetId);
  if (!target) return false;

  const visited = new Set<string>();

  function hasCycle(node: Node): boolean {
    if (visited.has(node.id)) return false;
    visited.add(node.id);

    for (const outgoer of getOutgoers(node, nodes, edges)) {
      if (outgoer.id === sourceId) return true;
      if (hasCycle(outgoer)) return true;
    }
    return false;
  }

  return hasCycle(target);
}

/**
 * React hook for use in the ReactFlow isValidConnection prop.
 */
export function useIsValidConnection() {
  const { getNodes, getEdges } = useReactFlow();

  return useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return false;

      const nodes = getNodes();
      const edges = getEdges();

      // Check cycle
      if (wouldCreateCycle(connection.source, connection.target, nodes, edges)) {
        return false;
      }

      // Check port type compatibility
      const sourceNode = nodes.find((n) => n.id === connection.source) as Node<NodeData> | undefined;
      const targetNode = nodes.find((n) => n.id === connection.target) as Node<NodeData> | undefined;
      if (!sourceNode || !targetNode) return false;

      const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
      const targetDef = NODE_DEFINITIONS[targetNode.data.definitionId];
      if (!sourceDef || !targetDef) return false;

      const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
      const targetPort = targetDef.inputPorts.find((p) => p.id === connection.targetHandle);
      if (!sourcePort || !targetPort) return false;

      return isPortCompatible(sourcePort.dataType, targetPort.dataType);
    },
    [getNodes, getEdges]
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx vitest run tests/hooks/useIsValidConnection.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/hooks/ frontend/tests/hooks/
git commit -m "feat: cycle detection and port type validation for connections"
```

---

## Task 8: Custom Node Component

**Files:**
- Create: `frontend/src/components/nodes/ModelNode.tsx`
- Create: `frontend/src/styles/nodes.css`

- [ ] **Step 1: Create ModelNode component**

Create `frontend/src/components/nodes/ModelNode.tsx`:

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

  if (!definition) {
    return <div className="model-node model-node--error">Unknown node type</div>;
  }

  const categoryColor = CATEGORY_COLORS[definition.category] ?? '#424242';
  const stateClass = `model-node--${nodeData.state}`;

  return (
    <div
      className={`model-node ${stateClass} ${selected ? 'model-node--selected' : ''}`}
      onClick={() => selectNode(id)}
    >
      {/* Header */}
      <div className="model-node__header">
        <span
          className="model-node__category-dot"
          style={{ backgroundColor: categoryColor }}
        />
        <span className="model-node__label">{nodeData.label}</span>
        {nodeData.keyStatus === 'missing' && (
          <span className="model-node__badge model-node__badge--warning" title="API Key Missing">
            ⚠
          </span>
        )}
      </div>

      {/* Input Ports */}
      {definition.inputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--input">
          {definition.inputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row">
              <Handle
                type="target"
                position={Position.Left}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType] }}
              />
              <span className="model-node__port-label">{port.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Preview area */}
      {nodeData.state === 'complete' && Object.keys(nodeData.outputs).length > 0 && (
        <div className="model-node__preview">
          <PreviewContent outputs={nodeData.outputs} />
        </div>
      )}

      {/* Error message */}
      {nodeData.state === 'error' && nodeData.error && (
        <div className="model-node__error">{nodeData.error}</div>
      )}

      {/* Output Ports */}
      {definition.outputPorts.length > 0 && (
        <div className="model-node__ports model-node__ports--output">
          {definition.outputPorts.map((port) => (
            <div key={port.id} className="model-node__port-row model-node__port-row--output">
              <span className="model-node__port-label">{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                className="model-node__handle"
                style={{ backgroundColor: PORT_COLORS[port.dataType] }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewContent({ outputs }: { outputs: Record<string, unknown> }) {
  const firstOutput = Object.values(outputs)[0];
  if (!firstOutput) return null;

  // Placeholder — will be expanded in Milestone 3
  return <div className="model-node__preview-placeholder">Output ready</div>;
}

export const ModelNode = memo(ModelNodeComponent);
```

- [ ] **Step 2: Create node styles**

Create `frontend/src/styles/nodes.css`:

```css
.model-node {
  background: #1c1c1c;
  border: 1px solid #333;
  border-radius: 6px;
  min-width: 200px;
  max-width: 240px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
  color: #ccc;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  border-left: 3px solid transparent;
}

.model-node--selected {
  border-color: #555;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}

/* State indicators — left border */
.model-node--idle {
  border-left-color: transparent;
}
.model-node--queued {
  border-left-color: #666;
}
.model-node--executing {
  border-left-color: #2196F3;
  animation: shimmer 1.5s ease-in-out infinite;
}
.model-node--complete {
  border-left-color: #4CAF50;
}
.model-node--error {
  border-left-color: #F44336;
}

@keyframes shimmer {
  0%, 100% { border-left-color: #2196F3; }
  50% { border-left-color: #64B5F6; }
}

/* Header */
.model-node__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid #2a2a2a;
}

.model-node__category-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.model-node__label {
  flex: 1;
  font-weight: 500;
  color: #eee;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-node__badge {
  font-size: 11px;
  flex-shrink: 0;
}

.model-node__badge--warning {
  color: #FFC107;
}

/* Ports */
.model-node__ports {
  padding: 6px 0;
}

.model-node__port-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  position: relative;
}

.model-node__port-row--output {
  justify-content: flex-end;
}

.model-node__port-label {
  font-size: 11px;
  color: #888;
}

.model-node__handle {
  width: 10px !important;
  height: 10px !important;
  border: 2px solid rgba(255, 255, 255, 0.3) !important;
  border-radius: 50% !important;
  transition: transform 0.15s ease;
}

.model-node__handle:hover {
  transform: scale(1.4);
}

/* Preview */
.model-node__preview {
  padding: 6px 10px;
  border-top: 1px solid #2a2a2a;
}

.model-node__preview-placeholder {
  background: #161616;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px;
  text-align: center;
  color: #555;
  font-size: 11px;
}

/* Error */
.model-node__error {
  padding: 4px 10px;
  font-size: 10px;
  color: #F44336;
  background: rgba(244, 67, 54, 0.1);
  border-top: 1px solid #2a2a2a;
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/components/nodes/ frontend/src/styles/nodes.css
git commit -m "feat: ModelNode component with ports, state indicators, category dots"
```

---

## Task 9: Custom Typed Edge Component

**Files:**
- Create: `frontend/src/components/edges/TypedEdge.tsx`

- [ ] **Step 1: Create TypedEdge component**

Create `frontend/src/components/edges/TypedEdge.tsx`:

```tsx
import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { PORT_COLORS } from '../../lib/portCompatibility';
import type { PortDataType } from '../../types';

function TypedEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps) {
  const dataType = (data?.dataType as PortDataType) ?? 'Any';
  const color = PORT_COLORS[dataType] ?? PORT_COLORS.Any;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: color,
        strokeWidth: selected ? 3 : 2,
        filter: selected ? `drop-shadow(0 0 4px ${color}40)` : undefined,
      }}
    />
  );
}

export const TypedEdge = memo(TypedEdgeComponent);
```

- [ ] **Step 2: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/components/edges/
git commit -m "feat: TypedEdge component with data-type coloring"
```

---

## Task 10: Canvas Component

**Files:**
- Create: `frontend/src/components/Canvas.tsx`
- Create: `frontend/src/styles/canvas.css`

- [ ] **Step 1: Create Canvas component**

Create `frontend/src/components/Canvas.tsx`:

```tsx
import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../store/graphStore';
import { useIsValidConnection } from '../hooks/useIsValidConnection';
import { ModelNode } from './nodes/ModelNode';
import { TypedEdge } from './edges/TypedEdge';
import '../styles/canvas.css';

const nodeTypes: NodeTypes = {
  'model-node': ModelNode,
};

const edgeTypes: EdgeTypes = {
  'typed-edge': TypedEdge,
};

export function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const isValidConnection = useIsValidConnection();

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const definitionId = event.dataTransfer.getData('application/nebula-node');
      if (!definitionId) return;

      const reactFlowBounds = (event.target as HTMLElement)
        .closest('.react-flow')
        ?.getBoundingClientRect();
      if (!reactFlowBounds) return;

      // Position will be converted from screen to flow coordinates by React Flow
      const position = {
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      };

      useGraphStore.getState().addNode(definitionId, position);
    },
    []
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  return (
    <div className="canvas-wrapper">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onDrop={onDrop}
        onDragOver={onDragOver}
        fitView
        minZoom={0.1}
        maxZoom={4}
        defaultEdgeOptions={{ type: 'typed-edge' }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode="Shift"
        selectionKeyCode={null}
        selectionOnDrag
        panOnScroll={false}
        selectionMode={1}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={32}
          size={1}
          color="rgba(255, 255, 255, 0.04)"
        />
        <Controls
          showInteractive={false}
          position="bottom-right"
          style={{ background: '#1c1c1c', border: '1px solid #333', borderRadius: 6 }}
        />
        <MiniMap
          position="bottom-right"
          style={{
            background: '#111',
            border: '1px solid #333',
            borderRadius: 6,
            marginBottom: 50,
          }}
          maskColor="rgba(0, 0, 0, 0.6)"
          nodeColor="#333"
        />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 2: Create canvas styles**

Create `frontend/src/styles/canvas.css`:

```css
.canvas-wrapper {
  width: 100vw;
  height: 100vh;
  background: #111;
}

/* React Flow dark theme overrides */
.react-flow {
  --xy-background-color: #111;
  --xy-edge-stroke-default: #555;
  --xy-edge-stroke-width-default: 2;
  --xy-node-border-radius-default: 6px;
  --xy-handle-background-color-default: #4CAF50;
  --xy-handle-border-color-default: rgba(255, 255, 255, 0.3);
  --xy-minimap-mask-background-color-default: rgba(0, 0, 0, 0.6);
}

/* Selection box */
.react-flow__selection {
  background: rgba(255, 255, 255, 0.05) !important;
  border: 1px solid rgba(255, 255, 255, 0.15) !important;
}

/* Controls dark theme */
.react-flow__controls button {
  background: #1c1c1c !important;
  border-color: #333 !important;
  color: #999 !important;
  fill: #999 !important;
}

.react-flow__controls button:hover {
  background: #252525 !important;
  color: #ccc !important;
  fill: #ccc !important;
}

/* Edge animation for executing state */
.react-flow__edge.animated path {
  stroke-dasharray: 5;
  animation: edge-flow 0.5s linear infinite;
}

@keyframes edge-flow {
  to { stroke-dashoffset: -10; }
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/components/Canvas.tsx frontend/src/styles/canvas.css
git commit -m "feat: Canvas component with React Flow, dark theme, drag-drop, selection"
```

---

## Task 11: Node Library Panel

**Files:**
- Create: `frontend/src/components/panels/NodeLibrary.tsx`
- Create: `frontend/src/styles/panels.css`

- [ ] **Step 1: Create NodeLibrary panel**

Create `frontend/src/components/panels/NodeLibrary.tsx`:

```tsx
import { useMemo, useRef, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { getNodesByCategory } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import '../../styles/panels.css';

const CATEGORY_LABELS: Record<string, string> = {
  'image-gen': 'Image Generation',
  'video-gen': 'Video Generation',
  'text-gen': 'Text Generation',
  'audio-gen': 'Audio Generation',
  'transform': 'Transform',
  'analyzer': 'Analyzer',
  'utility': 'Utility',
};

export function NodeLibrary() {
  const visible = useUIStore((s) => s.panels.library.visible);
  const position = useUIStore((s) => s.panels.library.position);
  const search = useUIStore((s) => s.librarySearch);
  const setSearch = useUIStore((s) => s.setLibrarySearch);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const addNode = useGraphStore((s) => s.addNode);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);

  const grouped = useMemo(() => getNodesByCategory(), []);

  const filtered = useMemo(() => {
    if (!search.trim()) return grouped;
    const lower = search.toLowerCase();
    const result: typeof grouped = {};
    for (const [cat, defs] of Object.entries(grouped)) {
      const matches = defs.filter((d) => d.displayName.toLowerCase().includes(lower));
      if (matches.length > 0) result[cat] = matches;
    }
    return result;
  }, [grouped, search]);

  // Draggable panel
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('library', {
        x: dragRef.current.panelX + dx,
        y: dragRef.current.panelY + dy,
      });
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setPanelPosition]);

  if (!visible) return null;

  function onDragStart(e: React.DragEvent, definitionId: string) {
    e.dataTransfer.setData('application/nebula-node', definitionId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDoubleClick(definitionId: string) {
    // Add node at center of viewport
    addNode(definitionId, { x: 400, y: 300 });
  }

  return (
    <div
      ref={panelRef}
      className="panel"
      style={{ left: position.x, top: position.y, width: 220 }}
    >
      <div
        className="panel__header"
        onMouseDown={(e) => {
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            panelX: position.x,
            panelY: position.y,
          };
        }}
      >
        <span className="panel__title">Nodes</span>
        <button className="panel__close" onClick={() => togglePanel('library')}>
          ×
        </button>
      </div>

      <div className="panel__body">
        <input
          className="panel__search"
          type="text"
          placeholder="Search nodes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {Object.entries(filtered).map(([category, defs]) => (
          <div key={category} className="panel__group">
            <div className="panel__group-label">
              <span
                className="panel__group-dot"
                style={{ backgroundColor: CATEGORY_COLORS[category] }}
              />
              {CATEGORY_LABELS[category] ?? category}
            </div>
            {defs.map((def) => (
              <div
                key={def.id}
                className="panel__item"
                draggable
                onDragStart={(e) => onDragStart(e, def.id)}
                onDoubleClick={() => onDoubleClick(def.id)}
              >
                {def.displayName}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create panel styles**

Create `frontend/src/styles/panels.css`:

```css
.panel {
  position: fixed;
  z-index: 10;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 32px);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
  color: #ccc;
}

.panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #2a2a2a;
  cursor: grab;
  user-select: none;
}

.panel__header:active {
  cursor: grabbing;
}

.panel__title {
  font-size: 11px;
  text-transform: uppercase;
  color: #888;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.panel__close {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
  line-height: 1;
}

.panel__close:hover {
  color: #ccc;
}

.panel__body {
  padding: 8px;
  overflow-y: auto;
  flex: 1;
}

.panel__search {
  width: 100%;
  background: #252525;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 6px 8px;
  color: #ccc;
  font-size: 12px;
  outline: none;
  margin-bottom: 8px;
  box-sizing: border-box;
}

.panel__search:focus {
  border-color: #555;
}

.panel__search::placeholder {
  color: #555;
}

.panel__group {
  margin-bottom: 8px;
}

.panel__group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 4px 4px 2px;
}

.panel__group-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.panel__item {
  padding: 5px 8px;
  border-radius: 4px;
  cursor: grab;
  color: #bbb;
  transition: background 0.1s;
}

.panel__item:hover {
  background: #252525;
  color: #eee;
}

.panel__item:active {
  cursor: grabbing;
}

/* Inspector panel */
.inspector__section {
  margin-bottom: 12px;
}

.inspector__label {
  font-size: 10px;
  color: #666;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.inspector__field {
  width: 100%;
  background: #252525;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 6px 8px;
  color: #ccc;
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}

.inspector__field:focus {
  border-color: #555;
}

/* Toolbar */
.toolbar {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 20px;
  padding: 6px 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}

.toolbar__button {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: inherit;
  transition: background 0.1s, color 0.1s;
}

.toolbar__button:hover {
  background: #252525;
  color: #eee;
}

.toolbar__divider {
  width: 1px;
  height: 16px;
  background: #333;
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/components/panels/NodeLibrary.tsx frontend/src/styles/panels.css
git commit -m "feat: draggable Node Library panel with search and drag-to-canvas"
```

---

## Task 12: Inspector & Toolbar Panels

**Files:**
- Create: `frontend/src/components/panels/Inspector.tsx`
- Create: `frontend/src/components/panels/Toolbar.tsx`

- [ ] **Step 1: Create Inspector panel (placeholder for M1)**

In Milestone 1, the inspector shows selected node info and params but does not yet connect params to execution. Full param editing comes in Milestone 4.

Create `frontend/src/components/panels/Inspector.tsx`:

```tsx
import { useRef, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import type { NodeData } from '../../types';
import '../../styles/panels.css';

export function Inspector() {
  const visible = useUIStore((s) => s.panels.inspector.visible);
  const position = useUIStore((s) => s.panels.inspector.position);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);
  const nodes = useGraphStore((s) => s.nodes);
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const nodeData = selectedNode?.data as NodeData | undefined;
  const definition = nodeData ? NODE_DEFINITIONS[nodeData.definitionId] : undefined;

  // Draggable
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('inspector', {
        x: dragRef.current.panelX + dx,
        y: dragRef.current.panelY + dy,
      });
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setPanelPosition]);

  if (!visible || !selectedNode || !definition || !nodeData) return null;

  // Compute position: if x is negative, offset from right edge of viewport
  const resolvedX = position.x < 0 ? window.innerWidth + position.x : position.x;

  function onParamChange(key: string, value: unknown) {
    if (!selectedNodeId) return;
    updateNodeData(selectedNodeId, {
      params: { ...nodeData!.params, [key]: value },
    });
  }

  return (
    <div
      className="panel"
      style={{ left: resolvedX, top: position.y, width: 260 }}
    >
      <div
        className="panel__header"
        onMouseDown={(e) => {
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            panelX: resolvedX,
            panelY: position.y,
          };
        }}
      >
        <span className="panel__title">Inspector</span>
        <button className="panel__close" onClick={() => togglePanel('inspector')}>
          ×
        </button>
      </div>

      <div className="panel__body">
        {/* Node name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: CATEGORY_COLORS[definition.category],
              flexShrink: 0,
            }}
          />
          <span style={{ color: '#eee', fontWeight: 500, fontSize: 13 }}>
            {nodeData.label}
          </span>
        </div>

        {/* Params */}
        {definition.params.map((param) => (
          <div key={param.key} className="inspector__section">
            <div className="inspector__label">{param.label}</div>
            {param.type === 'enum' && param.options ? (
              <select
                className="inspector__field"
                value={String(nodeData.params[param.key] ?? param.default ?? '')}
                onChange={(e) => onParamChange(param.key, e.target.value)}
              >
                {param.options.map((opt) => (
                  <option key={String(opt.value)} value={String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : param.type === 'textarea' ? (
              <textarea
                className="inspector__field"
                rows={3}
                value={String(nodeData.params[param.key] ?? param.default ?? '')}
                onChange={(e) => onParamChange(param.key, e.target.value)}
                placeholder={param.placeholder}
              />
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

        {/* State info */}
        <div className="inspector__section" style={{ marginTop: 16, borderTop: '1px solid #2a2a2a', paddingTop: 8 }}>
          <div className="inspector__label">State</div>
          <div style={{ color: '#888', fontSize: 11 }}>{nodeData.state}</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create Toolbar**

Create `frontend/src/components/panels/Toolbar.tsx`:

```tsx
import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);

  return (
    <div className="toolbar">
      <button
        className="toolbar__button"
        onClick={() => {
          // Execution comes in Milestone 2 — placeholder for now
          alert('Execution not yet implemented — coming in Milestone 2');
        }}
        title="Run graph (Ctrl+Enter)"
      >
        ▶ Run
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => fitView({ padding: 0.2, duration: 300 })}
        title="Fit to screen"
      >
        Fit
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => togglePanel('library')}
        title="Toggle node library"
      >
        Nodes
      </button>
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={() => {
          // Settings panel comes in Milestone 4
          alert('Settings not yet implemented — coming in Milestone 4');
        }}
        title="Settings"
      >
        ⚙
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/components/panels/Inspector.tsx frontend/src/components/panels/Toolbar.tsx
git commit -m "feat: Inspector panel with param editing, Toolbar with Run/Fit/Settings"
```

---

## Task 13: Wire Up App.tsx

**Files:**
- Modify: `frontend/src/App.tsx` (replace entire contents)
- Modify: `frontend/src/App.css` (replace entire contents)
- Modify: `frontend/src/main.tsx` (minor cleanup)
- Delete: `frontend/src/assets/` (Vite default assets)

- [ ] **Step 1: Replace App.tsx**

Replace `frontend/src/App.tsx` with:

```tsx
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { NodeLibrary } from './components/panels/NodeLibrary';
import { Inspector } from './components/panels/Inspector';
import { Toolbar } from './components/panels/Toolbar';
import './App.css';

export default function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
      <NodeLibrary />
      <Inspector />
      <Toolbar />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 2: Replace App.css**

Replace `frontend/src/App.css` with:

```css
/* Global reset for Nebula Node */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #111;
  color: #ccc;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

/* Remove Vite default styles */
a {
  color: inherit;
  text-decoration: none;
}
```

- [ ] **Step 3: Clean up main.tsx**

Replace `frontend/src/main.tsx` with:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 4: Remove default Vite assets and index.css**

```bash
rm -rf /Users/justinperea/Documents/Projects/nebula_nodes/frontend/src/assets
rm -f /Users/justinperea/Documents/Projects/nebula_nodes/frontend/src/index.css
```

- [ ] **Step 5: Update index.html title**

In `frontend/index.html`, change `<title>Vite + React + TS</title>` to `<title>Nebula Node</title>`.

- [ ] **Step 6: Run dev server and verify**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npm run dev
```

Expected: Opens on `localhost:5173`. Dark canvas with grid lines. Node Library panel visible in top-left. Toolbar pill at bottom-center. Drag a node from the library onto the canvas. Click it — Inspector appears. Connect two nodes by dragging between ports. Incompatible types should be blocked. Deleting a node should remove connected edges.

- [ ] **Step 7: Commit**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add frontend/src/
git commit -m "feat: wire up App with Canvas, NodeLibrary, Inspector, Toolbar — M1 complete"
```

---

## Task 14: Run Full Test Suite & Fix Issues

- [ ] **Step 1: Run all tests**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes/frontend
npx vitest run
```

Expected: All tests pass (portCompatibility, graphStore, useIsValidConnection).

- [ ] **Step 2: Fix any failures**

If any test fails, read the error, identify the root cause, and fix. Do not skip tests.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
cd /Users/justinperea/Documents/Projects/nebula_nodes
git add -A
git commit -m "fix: resolve test failures from integration"
```

---

## Milestone 1 Completion Criteria

After all tasks are done, verify these behaviors work in the browser:

- [ ] Dark canvas with grid lines fills the viewport
- [ ] Node Library panel is visible, draggable, searchable
- [ ] Drag a node from library onto canvas — it appears
- [ ] Double-click a node in library — it appears at a default position
- [ ] Nodes show: header with category dot + name, input ports (left), output ports (right)
- [ ] Click a node — Inspector panel appears showing its params
- [ ] Change a param in Inspector — it updates
- [ ] Drag between compatible ports — edge connects with correct color
- [ ] Drag between incompatible ports — connection rejected
- [ ] Attempting to create a cycle — connection rejected
- [ ] Delete a node — connected edges are removed
- [ ] Rubber-band select multiple nodes — all highlight
- [ ] Delete/Backspace removes selected nodes
- [ ] Zoom with scroll wheel, pan with middle mouse button
- [ ] Toolbar: Fit button zooms to show all nodes
- [ ] Toolbar: Run button shows "not implemented" alert (expected for M1)

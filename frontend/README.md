# Nebula Nodes — Frontend

React 19 + TypeScript + Vite client for the Nebula Nodes studio. Renders the node
graph (React Flow / `@xyflow/react`), the seven workspaces, and talks to the FastAPI
backend over REST + WebSockets.

See the [repo root README](../README.md) for the full project overview and
[`docs/MODEL_REFERENCE.md`](../docs/MODEL_REFERENCE.md) for the node catalog.

## Commands

```bash
npm install
npm run dev          # Vite dev server (expects backend on :8000)
npm run build        # tsc -b && vite build
npm run lint         # inline-style check + slava CSS scope check + eslint
npm run test         # vitest run (347 tests)
npm run check:node-contracts   # frontend defs vs backend registry parity
```

## Architecture

```
src/
├── App.tsx              # view-mode router (canvas / editor / studios / create)
├── components/
│   ├── Canvas.tsx       # React Flow graph surface
│   ├── nodes/, edges/   # custom node + edge renderers
│   ├── panels/          # NodeLibrary, Inspector, Settings, ChatPanel, launchers
│   ├── create-studio/   # Create view (model picker, presets, gallery)
│   ├── cinema-studio/   # Soul Cinema storyboarding
│   ├── character-studio/
│   ├── moodboard-studio/
│   ├── video-editor/    # Remotion-based editor
│   └── editor/          # legacy ffmpeg timeline editor
├── constants/
│   └── nodeDefinitions.ts  # mirror of backend/data/node_definitions.json (124 nodes)
├── store/
│   ├── graphStore.ts    # Zustand: graph state, execution mirroring, undo
│   └── uiStore.ts       # Zustand: view modes, panels, skin
├── lib/
│   ├── api.ts           # REST client (graph CRUD, settings, models)
│   ├── wsClient.ts      # /ws execution event stream
│   └── createModels.ts  # Create-view featured models
└── types/               # shared TS contracts (ModelNodeDefinition, ports, params)
```

### Node definitions are mirrored, not fetched

`src/constants/nodeDefinitions.ts` is a hand-maintained mirror of
`backend/data/node_definitions.json`. Any node/param change must land in BOTH
files — `npm run check:node-contracts` (and the backend contract tests) gate the
drift. Longer term this should be generated from the backend JSON.

### Workspaces

`uiStore.viewMode` routes between: `canvas`, `editor` (Video Editor),
`remotion-editor`, `cinema-editor`, `character-editor`, `moodboard-editor`, and
`create`. All are reachable from the canvas tabs / panel launchers.

### Execution flow

`graphStore` posts graph mutations to the backend (the registry is the source of
truth), then `/ws` streams `queued → executing → progress → executed` events per
node, including `streamDelta` (text tokens) and `streamPartialImage`/`streamPartialSvg`
previews that render live in the node cards.

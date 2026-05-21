import { useEffect } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { CanvasTabs } from './components/CanvasTabs';
import { EditorView } from './components/editor/EditorView';
import { NodeLibrary } from './components/panels/NodeLibrary';
import { Settings } from './components/panels/Settings';
import { Toolbar } from './components/panels/Toolbar';
import { PanelLaunchers } from './components/panels/PanelLaunchers';
import { NodeInspectorPopover } from './components/panels/NodeInspectorPopover';
import { ChatPanel } from './components/panels/ChatPanel';
import { AgentLog } from './components/panels/AgentLog';
import { getSettings, fetchCLIGraph } from './lib/api';
import { useUIStore } from './store/uiStore';
import { useGraphStore } from './store/graphStore';
import { useZoomManifest } from './hooks/useZoomManifest';
import { NODE_DEFINITIONS } from './constants/nodeDefinitions';
import type { NodeData } from './types';
import './App.css';
import './styles/layouts.css';
// Skin stylesheets — each scoped under its own body class so multiple can
// coexist without leakage. Loaded once at the app root so the active skin's
// CSS is always available the moment uiStore.setSkin flips the body class.
import './styles/slava-restraint.css';

/** Pull the backend's in-memory cli_graph onto the canvas on first mount —
 * saves a CLI-button click every time the user refreshes during a Daedalus
 * session. Scoped to "only when the canvas is empty" so an in-progress local
 * edit isn't clobbered. Lives inside ReactFlowProvider so it can fit the
 * viewport after painting; in StrictMode the effect runs twice, but the
 * hasRunRef guard makes the second pass a no-op. */
function GraphHydrator() {
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (useGraphStore.getState().nodes.length > 0) return;

    let cancelled = false;
    (async () => {
      try {
        const data = await fetchCLIGraph();
        // Re-check after the await: in React StrictMode dev the effect runs
        // twice with a cleanup between, so the first run's cancelled flag is
        // always set before its fetch resolves. The store-state check lets a
        // mount-2 fetch successfully load, while mount-1's stale fetch sees
        // the populated store and bails.
        if (cancelled || useGraphStore.getState().nodes.length > 0) return;
        if (data.empty) {
          useUIStore.getState().resetPanelsForFreshCanvas();
          return;
        }
        useGraphStore.getState().loadGraph(
          data.nodes as Node<NodeData>[],
          data.edges as Edge[],
        );
        setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
      } catch {
        if (cancelled) return;
        // Backend down on first load: keep the blank canvas clean. The graph
        // store will clear stale cli_graph state before the first manual add.
        useUIStore.getState().resetPanelsForFreshCanvas();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fitView]);

  return null;
}

/** Headless component that wires the zoom-manifest recorder. Lives inside
 * ReactFlowProvider because the hook uses `useReactFlow` for node lookups. */
function ZoomManifestRecorder() {
  useZoomManifest();
  return null;
}

export default function App() {
  // Fetch settings on mount to populate the API key cache used for warning badges
  useEffect(() => {
    getSettings()
      .then((settings) => {
        const apiKeys = (settings.apiKeys ?? {}) as Record<string, string>;
        useUIStore.getState().setSettingsCache(apiKeys);
      })
      .catch((err) => console.warn('Failed to load settings for key check:', err));
  }, []);

  // Re-check all node key statuses whenever settings are saved
  useEffect(() => {
    function handleSettingsSaved() {
      getSettings()
        .then((settings) => {
          const apiKeys = (settings.apiKeys ?? {}) as Record<string, string>;
          useUIStore.getState().setSettingsCache(apiKeys);

          const { nodes } = useGraphStore.getState();
          const updatedNodes = nodes.map((node) => {
            const def = NODE_DEFINITIONS[node.data.definitionId];
            if (!def) return node;
            const keyNames = Array.isArray(def.envKeyName)
              ? def.envKeyName
              : [def.envKeyName];
            const hasKey = keyNames.length === 0 || keyNames.some((k) => Boolean(apiKeys[k]));
            return {
              ...node,
              data: {
                ...node.data,
                keyStatus: hasKey ? undefined : ('missing' as const),
              },
            };
          });
          useGraphStore.setState({ nodes: updatedNodes });
        })
        .catch(console.warn);
    }

    window.addEventListener('nebula:settings-saved', handleSettingsSaved);
    return () => window.removeEventListener('nebula:settings-saved', handleSettingsSaved);
  }, []);

  const viewMode = useUIStore((s) => s.viewMode);

  const isCanvas = viewMode === 'canvas';
  return (
    <ReactFlowProvider>
      <GraphHydrator />
      <ZoomManifestRecorder />
      <CanvasTabs />
      {isCanvas ? <Canvas /> : <EditorView />}
      {/* Canvas-only chrome: library, inspector, settings, launchers, toolbar, agent log.
          The editor view is a focused workspace — only the pill control and chat remain. */}
      {isCanvas && <NodeLibrary />}
      {isCanvas && <NodeInspectorPopover />}
      {isCanvas && <Settings />}
      <ChatPanel />
      {isCanvas && <PanelLaunchers />}
      {isCanvas && <Toolbar />}
      {isCanvas && <AgentLog />}
    </ReactFlowProvider>
  );
}

import { useEffect, useRef } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { NodeLibrary } from './components/panels/NodeLibrary';
import { Inspector } from './components/panels/Inspector';
import { Settings } from './components/panels/Settings';
import { Toolbar } from './components/panels/Toolbar';
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

/** Pull the backend's in-memory cli_graph onto the canvas on first mount —
 * saves a CLI-button click every time the user refreshes during a Daedalus
 * session. Scoped to "only when the canvas is empty" so an in-progress local
 * edit isn't clobbered. Lives inside ReactFlowProvider so it can fit the
 * viewport after painting; in StrictMode the effect runs twice, but the
 * hasRunRef guard makes the second pass a no-op. */
function GraphHydrator() {
  const { fitView } = useReactFlow();
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    if (useGraphStore.getState().nodes.length > 0) return;

    let cancelled = false;
    (async () => {
      try {
        const data = await fetchCLIGraph();
        if (cancelled || data.empty) return;
        if (useGraphStore.getState().nodes.length > 0) return;
        useGraphStore.getState().loadGraph(
          data.nodes as Node<NodeData>[],
          data.edges as Edge[],
        );
        setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
      } catch {
        // Backend down on first load — silent; user can still click CLI later.
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

  return (
    <ReactFlowProvider>
      <GraphHydrator />
      <ZoomManifestRecorder />
      <Canvas />
      <NodeLibrary />
      <Inspector />
      <Settings />
      <ChatPanel />
      <Toolbar />
      <AgentLog />
    </ReactFlowProvider>
  );
}

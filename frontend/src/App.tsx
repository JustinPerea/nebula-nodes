import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { NodeLibrary } from './components/panels/NodeLibrary';
import { Inspector } from './components/panels/Inspector';
import { Settings } from './components/panels/Settings';
import { Toolbar } from './components/panels/Toolbar';
import { ChatPanel } from './components/panels/ChatPanel';
import { getSettings } from './lib/api';
import { useUIStore } from './store/uiStore';
import { useGraphStore } from './store/graphStore';
import { NODE_DEFINITIONS } from './constants/nodeDefinitions';
import './App.css';

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
      <Canvas />
      <NodeLibrary />
      <Inspector />
      <Settings />
      <ChatPanel />
      <Toolbar />
    </ReactFlowProvider>
  );
}

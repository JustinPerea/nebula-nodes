import { useEffect, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { saveToFile, loadFromFile } from '../../lib/graphFile';
import { fetchCLIGraph } from '../../lib/api';
import type { NodeData } from '../../types';
import type { Node } from '@xyflow/react';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView, getViewport } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const resetExecution = useGraphStore((s) => s.resetExecution);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  const handleSave = useCallback(async () => {
    const { nodes, edges } = useGraphStore.getState();
    const viewport = getViewport();
    await saveToFile(nodes as Node<NodeData>[], edges, viewport);
  }, [getViewport]);

  const handleLoad = useCallback(async () => {
    const result = await loadFromFile();
    if (!result) return; // User cancelled

    if (result.warnings.length > 0) {
      console.warn('[nebula] Load warnings:', result.warnings);
    }

    // Push the loaded graph into cli_graph on the backend so Claude's
    // `nebula graph` can see it. The incoming graphSync will repopulate the
    // canvas with fresh short IDs at the positions we send. Clear local state
    // first so the merge starts from a blank slate.
    useGraphStore.getState().loadGraph([], []);
    try {
      const res = await fetch('http://localhost:8000/api/graph/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: result.nodes.map((n) => ({
            id: n.id,
            definitionId: (n.data as { definitionId: string }).definitionId,
            params: (n.data as { params?: Record<string, unknown> }).params ?? {},
            outputs: (n.data as { outputs?: Record<string, unknown> }).outputs ?? {},
            position: { x: n.position.x, y: n.position.y },
          })),
          edges: result.edges.map((e) => ({
            source: e.source,
            sourceHandle: e.sourceHandle ?? '',
            target: e.target,
            targetHandle: e.targetHandle ?? '',
          })),
        }),
      });
      if (!res.ok) throw new Error(`Import failed: ${res.status}`);
    } catch (err) {
      console.error('Graph import failed, falling back to frontend-only load:', err);
      useGraphStore.getState().loadGraph(
        result.nodes as Node<NodeData>[],
        result.edges,
      );
    }

    // Fit to loaded graph after a tick
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 120);
  }, [fitView]);

  const handleClear = useCallback(() => {
    const { nodes } = useGraphStore.getState();
    const msg =
      nodes.length > 0
        ? `Clear the canvas and wipe cli_graph? ${nodes.length} node${nodes.length === 1 ? '' : 's'} will be removed. This can't be undone from here (save first if you want a copy).`
        : `Wipe cli_graph? This removes any phantom nodes from prior sessions.`;
    if (!window.confirm(msg)) return;
    useGraphStore.getState().clearGraph();
    // Also wipe the backend's in-memory cli_graph so Claude starts fresh and
    // nothing from prior sessions comes back on the next graphSync.
    fetch('http://localhost:8000/api/graph', { method: 'DELETE' }).catch(() => {});
  }, []);

  const handleResetLayout = useCallback(() => {
    // 1. Reset chat: clear resize flag + persisted drag/height anchors so
    //    CSS clamp width takes over and the panel re-anchors to right-edge.
    useUIStore.setState((state) => ({
      chatResized: false,
      panels: {
        ...state.panels,
        chat: {
          ...state.panels.chat,
          height: undefined,
          left: null,
          top: null,
        },
      },
    }));
    // 2. Clear agent log persisted drag position. AgentLog listens to the
    //    custom event below to clear its in-memory state too.
    try {
      window.localStorage.removeItem('nebula:agentLog:pos');
    } catch {
      // ignore
    }
    window.dispatchEvent(new CustomEvent('nebula:layout-reset'));
    // 3. Clear browser-set inline width/height (from native CSS resize) so
    //    side panels + agent log fall back to their CSS defaults.
    document
      .querySelectorAll('.panel--library, .panel--inspector, .agent-log')
      .forEach((el) => {
        const node = el as HTMLElement;
        node.style.width = '';
        node.style.height = '';
      });
  }, []);

  const handleImportCLI = useCallback(async () => {
    try {
      const data = await fetchCLIGraph();
      if (data.empty) {
        alert('CLI graph is empty — build one with the nebula CLI first.');
        return;
      }
      useGraphStore.getState().loadGraph(
        data.nodes as Node<NodeData>[],
        data.edges,
      );
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
    } catch {
      alert('Could not fetch CLI graph — is the backend running?');
    }
  }, [fitView]);

  // Listen for custom events from keyboard shortcuts (Ctrl+S, Ctrl+O)
  useEffect(() => {
    function onSave() {
      handleSave();
    }
    function onLoad() {
      handleLoad();
    }
    window.addEventListener('nebula:save', onSave);
    window.addEventListener('nebula:load', onLoad);
    return () => {
      window.removeEventListener('nebula:save', onSave);
      window.removeEventListener('nebula:load', onLoad);
    };
  }, [handleSave, handleLoad]);

  return (
    <div className="toolbar">
      {isExecuting ? (
        <button
          className="toolbar__button"
          onClick={() => resetExecution()}
          title="Cancel execution"
        >
          <ToolbarIcon name="stop" />
          <span className="toolbar__label">Stop</span>
        </button>
      ) : (
        <button
          className="toolbar__button"
          onClick={() => executeGraph()}
          disabled={nodeCount === 0}
          title="Run graph (Ctrl+Enter)"
        >
          <ToolbarIcon name="run" />
          <span className="toolbar__label">Run</span>
        </button>
      )}
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={handleSave} title="Save graph (Ctrl+S)">
        <ToolbarIcon name="save" />
        <span className="toolbar__label">Save</span>
      </button>
      <button className="toolbar__button" onClick={handleLoad} title="Load graph (Ctrl+O)">
        <ToolbarIcon name="load" />
        <span className="toolbar__label">Load</span>
      </button>
      <button className="toolbar__button" onClick={handleImportCLI} title="Import graph built by nebula CLI">
        <ToolbarIcon name="cli" />
        <span className="toolbar__label">CLI</span>
      </button>
      <button className="toolbar__button" onClick={handleClear} title="Clear canvas and backend cli_graph">
        <ToolbarIcon name="clear" />
        <span className="toolbar__label">Clear</span>
      </button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => fitView({ padding: 0.2, duration: 300 })} title="Fit to screen">
        <ToolbarIcon name="fit" />
        <span className="toolbar__label">Fit</span>
      </button>
      <button className="toolbar__button" onClick={handleResetLayout} title="Reset panel positions and sizes">
        <ToolbarIcon name="reset" />
        <span className="toolbar__label">Reset</span>
      </button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('library')} title="Toggle node library">
        <ToolbarIcon name="nodes" />
        <span className="toolbar__label">Nodes</span>
      </button>
      <button className="toolbar__button" onClick={() => togglePanel('chat')} title="Toggle chat panel">
        <ToolbarIcon name="chat" />
        <span className="toolbar__label">Chat</span>
      </button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => togglePanel('settings')} title="Settings"><ToolbarIcon name="settings" />
          <span className="toolbar__label">{'\u2699'}</span></button>
    </div>
  );
}

type IconName =
  | 'run'
  | 'stop'
  | 'save'
  | 'load'
  | 'cli'
  | 'clear'
  | 'fit'
  | 'reset'
  | 'nodes'
  | 'chat'
  | 'settings';

function ToolbarIcon({ name }: { name: IconName }) {
  const stroke = {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
    className: 'toolbar__icon',
  };
  const filled = {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'currentColor',
    'aria-hidden': true,
    focusable: false,
    className: 'toolbar__icon',
  };
  switch (name) {
    case 'run':
      return (
        <svg {...filled}>
          <polygon points="3,2 12,7 3,12" />
        </svg>
      );
    case 'stop':
      return (
        <svg {...filled}>
          <rect x="3" y="3" width="8" height="8" rx="1" />
        </svg>
      );
    case 'save':
      return (
        <svg {...stroke}>
          <path d="M7 2 v6.5" />
          <path d="M4 5.5 l3 3 3 -3" />
          <path d="M2.5 11 v1 h9 v-1" />
        </svg>
      );
    case 'load':
      return (
        <svg {...stroke}>
          <path d="M7 11 v-6.5" />
          <path d="M4 8 l3 -3 3 3" />
          <path d="M2.5 11.5 v0.5 h9 v-0.5" />
        </svg>
      );
    case 'cli':
      return (
        <svg {...stroke}>
          <path d="M3 4 l3 3 -3 3" />
          <path d="M7.5 11 h4" />
        </svg>
      );
    case 'clear':
      return (
        <svg {...stroke}>
          <path d="M2.5 4 h9" />
          <path d="M5.5 4 v-1.2 h3 v1.2" />
          <path d="M3.8 4 v8 h6.4 v-8" />
          <path d="M6 6.2 v4 M8 6.2 v4" />
        </svg>
      );
    case 'fit':
      return (
        <svg {...stroke}>
          <path d="M2.5 5 v-2.5 h2.5" />
          <path d="M9 2.5 h2.5 v2.5" />
          <path d="M11.5 9 v2.5 h-2.5" />
          <path d="M5 11.5 h-2.5 v-2.5" />
        </svg>
      );
    case 'reset':
      return (
        <svg {...stroke}>
          <path d="M11 7 a4 4 0 1 1 -1.2 -2.85" />
          <path d="M11 2.5 v2.5 h-2.5" />
        </svg>
      );
    case 'nodes':
      return (
        <svg {...filled}>
          <rect x="2" y="2" width="3.5" height="3.5" rx="0.6" />
          <rect x="8.5" y="2" width="3.5" height="3.5" rx="0.6" />
          <rect x="2" y="8.5" width="3.5" height="3.5" rx="0.6" />
          <rect x="8.5" y="8.5" width="3.5" height="3.5" rx="0.6" />
        </svg>
      );
    case 'chat':
      return (
        <svg {...stroke}>
          <path d="M2.5 5 q0 -2.5 2.5 -2.5 h4 q2.5 0 2.5 2.5 v2 q0 2.5 -2.5 2.5 h-1.5 l-2.5 2 v-2 q-2.5 0 -2.5 -2.5 z" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...stroke}>
          <circle cx="7" cy="7" r="1.8" />
          <path d="M7 1.5 v1.6 M7 10.9 v1.6 M1.5 7 h1.6 M10.9 7 h1.6 M3 3 l1.1 1.1 M9.9 9.9 l1.1 1.1 M11 3 l-1.1 1.1 M4.1 9.9 l-1.1 1.1" />
        </svg>
      );
  }
}

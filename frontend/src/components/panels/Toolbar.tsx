import { useEffect, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  FolderOpen,
  Maximize2,
  Play,
  RotateCcw,
  Save,
  Settings,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { saveToFile, loadFromFile } from '../../lib/graphFile';
import { fetchCLIGraph } from '../../lib/api';
import { apiFetch } from '../../lib/backend';
import type { NodeData } from '../../types';
import type { Edge, Node } from '@xyflow/react';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView, getViewport } = useReactFlow();
  const togglePanel = useUIStore((s) => s.togglePanel);
  const panels = useUIStore((s) => s.panels);
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
      const res = await apiFetch('/api/graph/import', {
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
    apiFetch('/api/graph', { method: 'DELETE' }).catch(() => {});
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
        data.edges as Edge[],
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
          className="toolbar__button toolbar__button--executing"
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
      <button
        className={`toolbar__button${panels.settings.visible ? ' toolbar__button--active' : ''}`}
        onClick={() => togglePanel('settings')}
        title="Settings"
        aria-pressed={panels.settings.visible}
      >
        <ToolbarIcon name="settings" />
        <span className="toolbar__label">{'\u2699'}</span>
      </button>
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
  | 'settings';

const TOOLBAR_ICONS: Record<IconName, LucideIcon> = {
  run: Play,
  stop: Square,
  save: Save,
  load: FolderOpen,
  cli: Terminal,
  clear: Trash2,
  fit: Maximize2,
  reset: RotateCcw,
  settings: Settings,
};

function ToolbarIcon({ name }: { name: IconName }) {
  const Icon = TOOLBAR_ICONS[name];
  return (
    <Icon
      className="toolbar__icon"
      size={14}
      strokeWidth={1.4}
      aria-hidden="true"
      focusable="false"
    />
  );
}

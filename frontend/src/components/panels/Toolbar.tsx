import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  FolderOpen,
  Maximize2,
  Network,
  Play,
  RotateCcw,
  Save,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { canLoadGraph, canSaveGraph, requestGraphLoad, requestGraphSave } from '../../lib/graphFileActions';
import { fetchCLIGraph } from '../../lib/api';
import { apiFetch } from '../../lib/backend';
import { computeCanvasFitPadding } from '../../lib/canvasFit';
import type { NodeData } from '../../types';
import type { Edge, Node } from '@xyflow/react';
import '../../styles/panels.css';

export function Toolbar() {
  const { fitView } = useReactFlow();
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const cancelExecution = useGraphStore((s) => s.cancelExecution);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isImportingGraph = useGraphStore((s) => s.isImportingGraph);
  const isCancelling = useGraphStore((s) => s.isCancelling);
  const canSave = useGraphStore(canSaveGraph);
  const canLoad = useGraphStore(canLoadGraph);
  const isPreparing = useGraphStore((s) => s.createLaunchingIds.length > 0);
  const providerStartAmbiguities = useGraphStore((s) => s.providerStartAmbiguities);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const autoLayout = useGraphStore((s) => s.autoLayout);
  const resetPanelLayout = useUIStore((s) => s.resetPanelLayout);

  const handleClear = useCallback(async () => {
    if (!canLoadGraph(useGraphStore.getState())) return;
    const { nodes } = useGraphStore.getState();
    const msg =
      nodes.length > 0
        ? `Clear the canvas and wipe cli_graph? ${nodes.length} node${nodes.length === 1 ? '' : 's'} will be removed. This can't be undone from here (save first if you want a copy).`
        : `Wipe cli_graph? This removes any phantom nodes from prior sessions.`;
    if (!window.confirm(msg)) return;
    if (!canLoadGraph(useGraphStore.getState())) return;
    // Confirm the backend clear before replacing the local graph. The backend
    // rejects this while any tracked execution owns provider lifecycle state.
    try {
      const response = await apiFetch('/api/graph', { method: 'DELETE' });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).detail ?? ''; } catch {
          /* Status fallback below. */
        }
        throw new Error(detail || `Clear failed: HTTP ${response.status}.`);
      }
      // A successful backend clear proves no provider safety record remains;
      // unlike ordinary snapshot hydration, this is authoritative removal.
      useGraphStore.setState({ providerRecoveries: [], providerStartAmbiguities: [] });
      useGraphStore.getState().clearGraph();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not clear the graph.');
    }
  }, []);

  const handleResetLayout = useCallback(() => {
    // 1. Restore every draggable panel to a viewport-safe default. Visibility
    //    is preserved; only geometry and chat resize anchors are reset.
    resetPanelLayout();
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
      .querySelectorAll('.panel--library, .panel--inspector, .panel--assets, .panel--history, .agent-log')
      .forEach((el) => {
        const node = el as HTMLElement;
        node.style.width = '';
        node.style.height = '';
      });
  }, [resetPanelLayout]);

  const handleImportCLI = useCallback(async () => {
    if (!canLoadGraph(useGraphStore.getState())) return;
    try {
      const data = await fetchCLIGraph();
      if (!canLoadGraph(useGraphStore.getState())) return;
      if (data.empty) {
        alert('CLI graph is empty — build one with the nebula CLI first.');
        return;
      }
      useGraphStore.getState().loadGraph(
        data.nodes as Node<NodeData>[],
        data.edges as Edge[],
      );
      setTimeout(() => fitView({ padding: computeCanvasFitPadding(), duration: 300 }), 50);
    } catch {
      alert('Could not fetch CLI graph — is the backend running?');
    }
  }, [fitView]);

  return (
    <div className="toolbar">
      {isExecuting ? (
        <button
          className="toolbar__button toolbar__button--executing"
          onClick={() => void cancelExecution()}
          disabled={isCancelling}
          aria-busy={isCancelling}
          title={isCancelling ? 'Waiting for execution to stop safely' : 'Cancel execution'}
        >
          <ToolbarIcon name="stop" />
          <span className="toolbar__label">{isCancelling ? 'Stopping…' : 'Stop'}</span>
        </button>
      ) : (
        <button
          className="toolbar__button"
          onClick={() => executeGraph()}
          disabled={nodeCount === 0 || isImportingGraph}
          title={isImportingGraph ? 'Wait for the graph import to finish' : 'Run graph (Ctrl+Enter)'}
        >
          <ToolbarIcon name="run" />
          <span className="toolbar__label">Run</span>
        </button>
      )}
      <div className="toolbar__divider" />
      <button
        className="toolbar__button"
        onClick={requestGraphSave}
        disabled={!canSave}
        title={isPreparing
          ? 'Wait for generation preparation to finish before saving'
          : isExecuting
          ? 'Wait for the active run to finish before saving'
          : providerStartAmbiguities.length > 0
            ? 'Resolve the World Labs paid-start review before saving'
            : 'Save graph (Ctrl+S)'}
      >
        <ToolbarIcon name="save" />
        <span className="toolbar__label">Save</span>
      </button>
      <button
        className="toolbar__button"
        onClick={requestGraphLoad}
        disabled={!canLoad}
        title={isPreparing ? 'Wait for generation preparation to finish' : isExecuting ? 'Wait for the active run to finish' : 'Load graph (Ctrl+O)'}
      >
        <ToolbarIcon name="load" />
        <span className="toolbar__label">Load</span>
      </button>
      <button
        className="toolbar__button"
        onClick={handleImportCLI}
        disabled={!canLoad}
        title={isExecuting ? 'Wait for the active run to finish' : 'Import graph built by nebula CLI'}
      >
        <ToolbarIcon name="cli" />
        <span className="toolbar__label">CLI</span>
      </button>
      <button
        className="toolbar__button"
        onClick={() => void handleClear()}
        disabled={!canLoad}
        title={isExecuting ? 'Wait for the active run to finish' : 'Clear canvas and backend cli_graph'}
      >
        <ToolbarIcon name="clear" />
        <span className="toolbar__label">Clear</span>
      </button>
      <div className="toolbar__divider" />
      <button className="toolbar__button" onClick={() => fitView({ padding: computeCanvasFitPadding(), duration: 300 })} title="Fit to screen">
        <ToolbarIcon name="fit" />
        <span className="toolbar__label">Fit</span>
      </button>
      <button
        className="toolbar__button"
        onClick={autoLayout}
        title="Auto-layout — arrange nodes by dependency"
        disabled={nodeCount === 0}
      >
        <ToolbarIcon name="layout" />
        <span className="toolbar__label">Layout</span>
      </button>
      <button className="toolbar__button" onClick={handleResetLayout} title="Reset panel positions and sizes">
        <ToolbarIcon name="reset" />
        <span className="toolbar__label">Reset</span>
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
  | 'layout'
  | 'reset';

const TOOLBAR_ICONS: Record<IconName, LucideIcon> = {
  run: Play,
  stop: Square,
  save: Save,
  load: FolderOpen,
  cli: Terminal,
  clear: Trash2,
  fit: Maximize2,
  layout: Network,
  reset: RotateCcw,
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

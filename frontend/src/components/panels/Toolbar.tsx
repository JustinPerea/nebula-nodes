import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import {
  FolderOpen,
  ChevronUp,
  Maximize,
  Minus,
  MoreHorizontal,
  Network,
  Play,
  Plus,
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
import { CANVAS_FIT_DURATION, CANVAS_ZOOM_DURATION, computeCanvasFitPadding } from '../../lib/canvasFit';
import { describeRunScope, summarizeRunScope } from '../../lib/runScope';
import type { NodeData } from '../../types';
import type { Edge, Node } from '@xyflow/react';
import '../../styles/panels.css';
import '../../styles/canvas-toolbar.css';


export function Toolbar() {
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const minZoom = useStore((s) => s.minZoom);
  const maxZoom = useStore((s) => s.maxZoom);
  const zoomPercent = Math.round(zoom * 100);
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
  const graphNodes = useGraphStore((s) => s.nodes);
  const graphEdges = useGraphStore((s) => s.edges);
  const runScope = useMemo(
    () => summarizeRunScope(graphNodes ?? [], graphEdges ?? [], { kind: 'graph' }),
    [graphNodes, graphEdges],
  );
  const runScopeId = useId();
  const autoLayout = useGraphStore((s) => s.autoLayout);
  const resetPanelLayout = useUIStore((s) => s.resetPanelLayout);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRoot = useRef<HTMLDivElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const importFitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionsId = useId();
  const blockedId = useId();
  const loadBlockedReason = isPreparing
    ? 'Wait for generation preparation to finish.'
    : isImportingGraph
      ? 'Wait for the graph import to finish.'
      : 'Wait for the active run to finish.';
  const saveBlockedReason = !canLoad
    ? loadBlockedReason
    : 'Resolve the World Labs paid-start review before saving.';

  const closeActions = useCallback((restoreFocus = false) => {
    setActionsOpen(false);
    if (restoreFocus) actionsTrigger.current?.focus();
  }, []);

  useEffect(() => {
    mounted.current = true;
    const clearImportFit = () => {
      if (importFitTimer.current !== null) clearTimeout(importFitTimer.current);
      importFitTimer.current = null;
    };
    // A return to Canvas must not revive an import fit scheduled before leaving.
    const unsubscribe = useUIStore.subscribe((state, previous) => {
      if (state.viewMode !== previous.viewMode) clearImportFit();
    });
    return () => {
      mounted.current = false;
      clearImportFit();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!actionsOpen) return;
    const dismissOutside = (event: Event) => {
      if (event.target instanceof window.Node && !actionsRoot.current?.contains(event.target)) closeActions();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [actionsOpen, closeActions]);

  const onActionsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // These controls are inside the Canvas key-event boundary. Keep graph
    // execution and node-edit shortcuts out of a secondary action disclosure.
    event.stopPropagation();
    if (event.key === 'Escape' && actionsOpen) {
      event.preventDefault();
      closeActions(true);
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === 's' || key === 'o') {
        event.preventDefault();
        const permitted = key === 's' ? canSaveGraph(useGraphStore.getState()) : canLoadGraph(useGraphStore.getState());
        if (permitted) {
          closeActions(true);
          if (key === 's') requestGraphSave();
          else requestGraphLoad();
        }
      } else if (key === 'enter') {
        event.preventDefault();
      }
    }
  };

  const runSecondaryAction = (action: () => void) => {
    closeActions(true);
    action();
  };

  const handleClear = useCallback(async () => {
    if (!canLoadGraph(useGraphStore.getState())) return;
    const { nodes } = useGraphStore.getState();
    const msg =
      nodes.length > 0
        ? `Clear the canvas? ${nodes.length} node${nodes.length === 1 ? '' : 's'} will be removed, and the stored canvas used by connected tools will be reset. Save your graph first to keep a copy.`
        : 'Reset the stored canvas used by connected tools? The visible canvas is already empty.';
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
      if (!mounted.current || !canLoadGraph(useGraphStore.getState())) return;
      if (data.empty) {
        alert('CLI graph is empty — build one with the nebula CLI first.');
        return;
      }
      useGraphStore.getState().loadGraph(
        data.nodes as Node<NodeData>[],
        data.edges as Edge[],
      );
      if (importFitTimer.current !== null) clearTimeout(importFitTimer.current);
      const scheduled = useUIStore.getState();
      const focusRevision = scheduled.canvasFocusRevision;
      const viewportRevision = scheduled.canvasViewportRevision;
      importFitTimer.current = setTimeout(() => {
        importFitTimer.current = null;
        const current = useUIStore.getState();
        const canvasActive = current.viewMode === 'canvas' || (current.viewMode === 'commons' && !current.commonsEnabled);
        if (!mounted.current || !canvasActive || current.canvasFocusRequest) return;
        if (current.canvasFocusRevision !== focusRevision || current.canvasViewportRevision !== viewportRevision) return;
        void fitView({ padding: computeCanvasFitPadding(), duration: CANVAS_FIT_DURATION });
      }, 50);
    } catch {
      if (mounted.current) alert('Could not fetch CLI graph — is the backend running?');
    }
  }, [fitView]);

  return (
    <div className={`toolbar toolbar--grouped${actionsOpen ? ' toolbar--actions-open' : ''}`} role="group" aria-label="Canvas controls">
      {isExecuting ? (
        <button
          type="button"
          className="toolbar__button toolbar__button--primary toolbar__button--executing"
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
          type="button"
          className="toolbar__button toolbar__button--primary"
          onClick={() => executeGraph()}
          disabled={nodeCount === 0 || isImportingGraph}
          aria-describedby={nodeCount > 0 ? runScopeId : undefined}
          title={isImportingGraph ? 'Wait for the graph import to finish' : `Run graph. ${describeRunScope(runScope)} (Ctrl+Enter)`}
        >
          <ToolbarIcon name="run" />
          <span className="toolbar__label">Run</span>
          {runScope.paid.length > 0 && (
            <span className="toolbar__run-paid" aria-hidden="true">{runScope.paid.length} paid</span>
          )}
        </button>
      )}
      <span id={runScopeId} className="toolbar__sr-only">{describeRunScope(runScope)}</span>
      <div className="toolbar__divider" aria-hidden="true" />
      <div className="toolbar__actions" ref={actionsRoot} onKeyDown={onActionsKeyDown}>
        <button type="button" ref={actionsTrigger} className="toolbar__button toolbar__button--actions"
          aria-expanded={actionsOpen} aria-controls={actionsId}
          onClick={() => setActionsOpen((open) => !open)}>
          <MoreHorizontal className="toolbar__icon" size={16} aria-hidden="true" />
          <span className="toolbar__label">Canvas actions</span>
          <ChevronUp className="toolbar__actions-chevron" size={12} aria-hidden="true" />
        </button>
        {actionsOpen && (
          <section id={actionsId} className="toolbar__actions-panel" aria-label="Canvas actions">
            {!canLoad && <p className="toolbar__blocked" id={blockedId} role="status">{loadBlockedReason}</p>}
            {canLoad && !canSave && providerStartAmbiguities.length > 0 && (
              <p className="toolbar__blocked" id={blockedId} role="status">{saveBlockedReason}</p>
            )}
            <div className="toolbar__action-group" role="group" aria-label="Graph files">
              <h2 className="toolbar__action-heading">Graph</h2>
              <button type="button" className="toolbar__action" disabled={!canSave}
                aria-describedby={!canSave ? blockedId : undefined}
                title={!canSave ? saveBlockedReason : 'Save graph (Ctrl+S or ⌘S)'}
                aria-keyshortcuts="Control+s Meta+s" onClick={() => runSecondaryAction(requestGraphSave)}>
                <ToolbarIcon name="save" /><span>Save graph</span><kbd aria-hidden="true">Ctrl / ⌘ S</kbd>
              </button>
              <button type="button" className="toolbar__action" disabled={!canLoad}
                aria-describedby={!canLoad ? blockedId : undefined}
                title={!canLoad ? loadBlockedReason : 'Load graph (Ctrl+O or ⌘O)'}
                aria-keyshortcuts="Control+o Meta+o" onClick={() => runSecondaryAction(requestGraphLoad)}>
                <ToolbarIcon name="load" /><span>Load graph</span><kbd aria-hidden="true">Ctrl / ⌘ O</kbd>
              </button>
              <button type="button" className="toolbar__action" disabled={!canLoad}
                aria-describedby={!canLoad ? blockedId : undefined}
                title={!canLoad ? loadBlockedReason : 'Import graph built by Nebula CLI'}
                onClick={() => runSecondaryAction(() => void handleImportCLI())}>
                <ToolbarIcon name="cli" /><span>Import CLI graph</span>
              </button>
              <button type="button" className="toolbar__action toolbar__action--danger" disabled={!canLoad}
                aria-describedby={!canLoad ? blockedId : undefined}
                title={!canLoad ? loadBlockedReason : 'Clear canvas — asks for confirmation'}
                onClick={() => runSecondaryAction(() => void handleClear())}>
                <ToolbarIcon name="clear" /><span>Clear canvas…</span>
              </button>
            </div>
            <div className="toolbar__action-group" role="group" aria-label="Canvas layout">
              <h2 className="toolbar__action-heading">Layout</h2>
              <button type="button" className="toolbar__action" disabled={nodeCount === 0}
                title="Arrange nodes by dependency" onClick={() => runSecondaryAction(autoLayout)}>
                <ToolbarIcon name="layout" /><span>Arrange nodes</span>
              </button>
              <button type="button" className="toolbar__action" title="Reset panel positions and sizes"
                onClick={() => runSecondaryAction(handleResetLayout)}>
                <ToolbarIcon name="reset" /><span>Reset panels</span>
              </button>
            </div>
          </section>
        )}
      </div>
      <div className="toolbar__divider toolbar__divider--zoom" aria-hidden="true" />
      <div className="toolbar__zoom" role="group" aria-label="Zoom">
        <button type="button" className="toolbar__button toolbar__button--icon toolbar__zoom-step"
          aria-label="Zoom out" title="Zoom out (⌘−)" aria-keyshortcuts="Meta+- Control+-" disabled={zoom <= minZoom + 0.001}
          onClick={() => void zoomOut({ duration: CANVAS_ZOOM_DURATION })}>
          <Minus className="toolbar__icon" size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
        <button type="button" className="toolbar__button toolbar__zoom-level"
          aria-label={`Zoom ${zoomPercent}%, reset to 100%`} title="Reset zoom to 100% (⇧0)"
          aria-keyshortcuts="Shift+0"
          onClick={() => void zoomTo(1, { duration: CANVAS_ZOOM_DURATION })}>
          {zoomPercent}%
        </button>
        <button type="button" className="toolbar__button toolbar__button--icon toolbar__zoom-step"
          aria-label="Zoom in" title="Zoom in (⌘=)" aria-keyshortcuts="Meta+= Control+=" disabled={zoom >= maxZoom - 0.001}
          onClick={() => void zoomIn({ duration: CANVAS_ZOOM_DURATION })}>
          <Plus className="toolbar__icon" size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
        <button type="button" className="toolbar__button toolbar__button--icon"
          aria-label="Fit view" title="Fit view (⇧1)" aria-keyshortcuts="Shift+1"
          onClick={() => void fitView({ padding: computeCanvasFitPadding(), duration: CANVAS_FIT_DURATION })}>
          <Maximize className="toolbar__icon" size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
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
  | 'layout'
  | 'reset';

const TOOLBAR_ICONS: Record<IconName, LucideIcon> = {
  run: Play,
  stop: Square,
  save: Save,
  load: FolderOpen,
  cli: Terminal,
  clear: Trash2,
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

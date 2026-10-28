import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Download,
  Files,
  LayoutGrid,
  MessageCircle,
  Play,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { sceneDeleteDisabledTitle, useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { useCanvasPinsStore } from '../store/canvasPinsStore';
import { isBackendNodeId } from '../lib/canvasPins';
import { describeRunScope, runChipLabel, runChipTitle, summarizeRunScope } from '../lib/runScope';
import { usePricingStore } from '../store/pricingStore';
import { useInputSizeStore } from '../store/inputSizeStore';
import { setSelectionActionSlot } from '../lib/selectionActionSlot';
import {
  collectDownloadableOutputs,
  downloadSelectedOutputs,
  selectedNodeIds,
} from '../lib/canvasSelection';
import { failureMessage } from '../lib/errorCopy';
import { RUN_LOCK_REASON } from '../lib/cinemaScene';
import { useCanvasLock } from '../lib/canvasLock';


export function SelectionToolbar() {
  const nodes = useGraphStore((state) => state.nodes);
  const edges = useGraphStore((state) => state.edges);
  const isExecuting = useGraphStore((state) => state.isExecuting);
  // A run waiting for its inputs counts as starting (review 15, M-B).
  const runStarting = useGraphStore((state) => state.runStarting);
  // Offline is read-only (GM, round 15 of PR #114), and so is following an
  // agent's switch (GM round 22, A: one state, lib/canvasLock): Run, Ask,
  // Note, Duplicate, Arrange and Delete are disabled and look it, with "Wait
  // for “<project>” to open." while following; Copy, Download and the
  // node's Settings stay.
  const lock = useCanvasLock();
  // A control this tab's own run also locks (#198's run lock): while that run
  // goes, its reason wins over following's or offline's (GM, #198 r8 merge
  // check), so each control says one reason and the two never collide.
  const runLocked = (running: boolean, own: { disabled?: boolean; title?: string }) => (running
    ? { ...lock.act(own), disabled: true, title: RUN_LOCK_REASON }
    : lock.act(own));
  const executeNode = useGraphStore((state) => state.executeNode);
  const executeCluster = useGraphStore((state) => state.executeCluster);
  const copySelected = useGraphStore((state) => state.copySelected);
  const duplicateSelected = useGraphStore((state) => state.duplicateSelected);
  const autoLayoutSelected = useGraphStore((state) => state.autoLayoutSelected);
  const deleteSelected = useGraphStore((state) => state.deleteSelected);
  const chatVisible = useUIStore((state) => state.panels.chat.visible);
  const togglePanel = useUIStore((state) => state.togglePanel);
  const composeNote = useCanvasPinsStore((state) => state.compose);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const selectedNodes = useMemo(() => nodes.filter((node) => node.selected), [nodes]);
  const ids = useMemo(() => selectedNodeIds(nodes), [nodes]);
  // Every selected node a scene with a shot rendering: nothing to delete yet
  // (GM, PR #198 r3 item 1). With others selected, Delete takes the rest.
  const sceneHeld = useGraphStore((state) => sceneDeleteDisabledTitle(state, ids));
  const outputCount = useMemo(
    () => collectDownloadableOutputs(selectedNodes).length,
    [selectedNodes],
  );
  // Same scopes as runSelection: one node runs with everything feeding it;
  // several run as an explicit cluster.
  const pricing = usePricingStore((s) => s.table);
  const apiKeys = useUIStore((s) => s.settingsCache.apiKeys);
  const sizes = useInputSizeStore((s) => s.sizes);
  const requestSizes = useInputSizeStore((s) => s.request);
  const runScope = useMemo(() => summarizeRunScope(nodes, edges ?? [],
    ids.length === 1 ? { kind: 'node', nodeId: ids[0] } : { kind: 'cluster', nodeIds: ids },
    { pricing, apiKeys, sizes }), [nodes, edges, ids, pricing, apiKeys, sizes]);
  const sizeRefs = runScope.cost?.sizeRefs;
  useEffect(() => { if (sizeRefs?.length) requestSizes(sizeRefs); }, [sizeRefs, requestSizes]);
  const runChip = runChipLabel(runScope);
  const runScopeId = useId();
  // "Ask agent" focuses the chat box once the panel has opened. A toolbar
  // that unmounts first (the selection cleared) cancels that focus.
  const focusTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
  }, []);
  if (ids.length === 0) return null;

  function openAgent() {
    if (!chatVisible) togglePanel('chat');
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      focusTimer.current = null;
      document.querySelector<HTMLTextAreaElement>('.chat-panel__textarea')?.focus();
    }, chatVisible ? 0 : 180);
  }

  async function downloadOutputs() {
    if (downloading || outputCount === 0) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadSelectedOutputs(selectedNodes);
    } catch (error) {
      setDownloadError(failureMessage(error, "Couldn't download the outputs."));
    } finally {
      setDownloading(false);
    }
  }

  function removeSelection() {
    // A World Labs hold refuses, with its notice; otherwise it deletes at
    // once and says "Deleted {n} nodes." with Undo (GM, 2026-10-23).
    if (useGraphStore.getState().allowCanvasDelete(ids)) deleteSelected();
  }

  function runSelection() {
    if (ids.length === 1) {
      // Use the established target-node path so the backend derives the
      // authoritative target-plus-ancestors closure from the full graph.
      // Sending a one-node "cluster" drops visible inputs such as the Text
      // Input feeding a World Labs Environment and fails preflight instead.
      void executeNode(ids[0]);
      return;
    }
    void executeCluster(ids);
  }

  return (
    <div
      className="selection-toolbar nodrag nopan"
      role="toolbar"
      aria-label={`Actions for ${ids.length} selected ${ids.length === 1 ? 'node' : 'nodes'}`}
      data-selected-count={ids.length}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="selection-toolbar__count">
        {ids.length} selected
      </span>
      <span className="selection-toolbar__divider" aria-hidden="true" />
      <button type="button" className="selection-toolbar__button" onClick={openAgent}
        {...lock.act({ title: 'Ask agent about selection' })}>
        <MessageCircle size={17} aria-hidden="true" />
        <span>Ask</span>
      </button>
      {ids.length === 1 && isBackendNodeId(ids[0]) && (
        <button
          type="button"
          className="selection-toolbar__button"
          onClick={() => composeNote({ nodeId: ids[0] })}
          {...lock.act({ title: 'Note for agents' })}
          aria-label="Note for agents"
        >
          <StickyNote size={17} aria-hidden="true" />
          <span className="selection-toolbar__label--compact">Note</span>
        </button>
      )}
      <button
        type="button"
        className="selection-toolbar__button selection-toolbar__button--primary"
        onClick={runSelection}
        {...runLocked(isExecuting || runStarting, { title: `Run selected nodes. ${describeRunScope(runScope)}` })}
        aria-label="Run selected nodes"
        aria-describedby={runScopeId}
      >
        <Play size={17} fill="currentColor" aria-hidden="true" />
        <span>Run</span>
        {runChip && (
          <span className="selection-toolbar__paid" aria-hidden="true" title={runChipTitle(runScope)}>{runChip}</span>
        )}
      </button>
      <span id={runScopeId} className="toolbar__sr-only">{describeRunScope(runScope)}</span>
      {/* One node selected: it portals its own actions (Next step, Edit video,
          Settings) here. Keyed by node so a new selection gets a fresh slot. */}
      {ids.length === 1 && (
        <span key={ids[0]} ref={setSelectionActionSlot} className="selection-toolbar__node-actions" data-node-id={ids[0]} />
      )}
      <button type="button" className="selection-toolbar__button" onClick={copySelected} title="Copy selected nodes">
        <Copy size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Copy</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button"
        onClick={duplicateSelected}
        {...runLocked(isExecuting, { title: 'Duplicate selected nodes' })}
      >
        <Files size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Duplicate</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button"
        onClick={autoLayoutSelected}
        {...runLocked(isExecuting, { disabled: ids.length < 2, title: 'Arrange selected nodes' })}
      >
        <LayoutGrid size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Arrange</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button"
        onClick={() => void downloadOutputs()}
        disabled={downloading || outputCount === 0}
        title={
          downloadError
            ? downloadError
            : outputCount === 0
              ? 'No downloadable outputs in selection'
              : `Download ${outputCount} selected ${outputCount === 1 ? 'output' : 'outputs'}`
        }
        aria-label={downloading ? 'Downloading selected outputs' : 'Download selected outputs'}
      >
        <Download size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Download</span>
      </button>
      <span className="selection-toolbar__divider" aria-hidden="true" />
      <button
        type="button"
        className="selection-toolbar__button selection-toolbar__button--danger"
        onClick={removeSelection}
        {...runLocked(isExecuting, { disabled: sceneHeld !== null, title: sceneHeld ?? 'Delete selected nodes' })}
        aria-label="Delete selected nodes"
      >
        <Trash2 size={17} aria-hidden="true" />
      </button>
    </div>
  );
}

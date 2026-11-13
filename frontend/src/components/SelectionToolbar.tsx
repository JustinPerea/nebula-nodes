import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { isTabLocalNode, sceneDeleteDisabledTitle, useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { useCanvasPinsStore } from '../store/canvasPinsStore';
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
import { useCanvasLock, type LockOwn } from '../lib/canvasLock';
import { runKeyLockLine, withKeyLock } from '../lib/runKeyLock';
import { TOP_STACK_EVENT, applySelectionToolbarPlace } from '../lib/bottomBar';
import { useBackendOffline } from '../lib/useBackendOffline';
import { itOrThem, RUN_LOCK_VERBS, runFinishesLine, type RunLockVerb } from '../lib/runLock';


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
  // node's Settings stay. While the canvas is kept after a restore (GM r16
  // to r18 on PR #199) what writes to Nebula or spends is disabled, each
  // with its own "You can … after you save it as a project."; Copy,
  // Download, Settings, Duplicate, Arrange and Delete stay (they change only
  // this tab, as typing does, and Undo takes them back: graphStore KeptStep).
  const lock = useCanvasLock();
  // A control this tab's own run also locks (#198's run lock): its reason
  // wins over following's and offline's, in lib/canvasLock (GM r9 answer 3:
  // run, follow, offline; the Next step its node portals here reads the same).
  // Its line names the control's verb (GM r39 item 2, lib/runLock): "it" for
  // one selected node, "them" for several.
  const runLocked = (running: boolean, verb: RunLockVerb, own: LockOwn) =>
    lock.act(own, { run: running, runTitle: runFinishesLine(verb) });
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
  const settingsLoaded = useUIStore((s) => s.settingsCache.loaded);
  // A node that can't run without its key (a keyed route's missing key), the
  // selection's or one feeding it: Run is locked with its line as the reason
  // (GM, PR #203 r4), aria-disabled so it keeps its focus and tooltip, and the
  // scope line it reads out is that line (r6 item 3).
  const keyLock = useMemo(() => runKeyLockLine(nodes, edges ?? [],
    ids.length === 1 ? { kind: 'node', nodeId: ids[0] } : { kind: 'cluster', nodeIds: ids },
    { loaded: settingsLoaded, apiKeys }), [nodes, edges, ids, settingsLoaded, apiKeys]);
  const sizes = useInputSizeStore((s) => s.sizes);
  const requestSizes = useInputSizeStore((s) => s.request);
  const runScope = useMemo(() => summarizeRunScope(nodes, edges ?? [],
    ids.length === 1 ? { kind: 'node', nodeId: ids[0] } : { kind: 'cluster', nodeIds: ids },
    { pricing, apiKeys, sizes }), [nodes, edges, ids, pricing, apiKeys, sizes]);
  const sizeRefs = runScope.cost?.sizeRefs;
  useEffect(() => { if (sizeRefs?.length) requestSizes(sizeRefs); }, [sizeRefs, requestSizes]);
  const runChip = runChipLabel(runScope);
  // GM r25 (3) on PR #199: while kept, Ask and Note say one line on any
  // node (saving unlocks both). GM r26 (4): on a normal tab a duplicated or
  // pasted node keeps a tab-local id until the project is next opened, so a
  // selection holding one locks both with their own lines (lib/canvasLock
  // TAB_LOCAL_LINES). STOPGAP: the bulk-create PR deletes `tabLocal`. Note
  // always shows for one node, locked or not, so the bar never shifts when
  // the node gets its id.
  const tabLocal = ids.some(isTabLocalNode);
  const showNote = ids.length === 1;
  const runScopeId = useId();
  // The missing key first, then the run lock's line (run, following,
  // offline): withKeyLock, one order for every Run (GM, PR #203 r11 item 3).
  const runProps = withKeyLock(runLocked(isExecuting || runStarting,
    itOrThem(ids.length, RUN_LOCK_VERBS.runIt, RUN_LOCK_VERBS.runThem),
    { title: `Run selected nodes. ${describeRunScope(runScope)}`, kept: 'run-nodes' }), keyLock, runScopeId);
  const runKeyLocked = runProps['data-key-locked'] !== undefined;
  // "Ask agent" focuses the chat box once the panel has opened. A toolbar
  // that unmounts first (the selection cleared) cancels that focus.
  const focusTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
  }, []);
  // GM r35 on PR #199: the toolbar never covers the selection (below the top
  // stack, else flipped below the selection, else pinned; the camera never
  // moves: lib/bottomBar placeSelectionToolbar). Placed again whenever the
  // selection, the camera, the window or the top stack changes.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const offline = useBackendOffline();
  const hasSelection = ids.length > 0;
  useLayoutEffect(() => {
    if (toolbarRef.current) applySelectionToolbarPlace(toolbarRef.current);
  }, [nodes, offline, hasSelection]);
  useEffect(() => {
    if (!hasSelection) return;
    let frame: number | null = null;
    const again = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (toolbarRef.current) applySelectionToolbarPlace(toolbarRef.current);
      });
    };
    window.addEventListener('resize', again);
    window.addEventListener(TOP_STACK_EVENT, again);
    // A node's size settles after it renders (an image loading, the text growing).
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    const flow = toolbarRef.current?.closest('.react-flow');
    for (const node of flow?.querySelectorAll('.react-flow__node.selected') ?? []) sizes?.observe(node);
    // The camera: a pan or zoom rewrites the viewport's transform.
    const camera = typeof MutationObserver === 'function' ? new MutationObserver(again) : null;
    const viewport = flow?.querySelector('.react-flow__viewport');
    if (viewport) camera?.observe(viewport, { attributes: true, attributeFilter: ['style', 'transform'] });
    // React Flow marks a node `selected` a render after the store says so, so the first
    // placement from no selection can run before any node is marked (the toolbar then
    // stays over a node near the top until something else moves it). A node gaining or
    // losing the mark places it again, and watches the node's size.
    const marks = typeof MutationObserver === 'function' ? new MutationObserver(() => {
      for (const node of flow?.querySelectorAll('.react-flow__node.selected') ?? []) sizes?.observe(node);
      again();
    }) : null;
    const nodesLayer = flow?.querySelector('.react-flow__nodes');
    if (nodesLayer) marks?.observe(nodesLayer, { attributes: true, attributeFilter: ['class'], subtree: true });
    return () => {
      window.removeEventListener('resize', again);
      window.removeEventListener(TOP_STACK_EVENT, again);
      sizes?.disconnect();
      camera?.disconnect();
      marks?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [hasSelection, nodes]);
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
      ref={toolbarRef}
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
        {...lock.act({ title: 'Ask agent about selection', kept: 'ask', tabLocal: tabLocal ? 'ask' : undefined })}>
        <MessageCircle size={17} aria-hidden="true" />
        <span>Ask</span>
      </button>
      {showNote && (
        <button
          type="button"
          className="selection-toolbar__button"
          onClick={() => composeNote({ nodeId: ids[0] })}
          {...lock.act({ title: 'Note for agents', kept: 'note', tabLocal: tabLocal ? 'note' : undefined })}
          aria-label="Note for agents"
        >
          <StickyNote size={17} aria-hidden="true" />
          <span className="selection-toolbar__label--compact">Note</span>
        </button>
      )}
      <button
        type="button"
        className="selection-toolbar__button selection-toolbar__button--primary"
        onClick={() => { if (runKeyLocked) return; runSelection(); }}
        {...runProps}
        aria-label="Run selected nodes"
        aria-describedby={runScopeId}
      >
        <Play size={17} fill="currentColor" aria-hidden="true" />
        <span>Run</span>
        {runChip && (
          <span className="selection-toolbar__paid" aria-hidden="true" title={runChipTitle(runScope)}>{runChip}</span>
        )}
      </button>
      <span id={runScopeId} className="toolbar__sr-only">{runKeyLocked ? keyLock : describeRunScope(runScope)}</span>
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
        {...runLocked(isExecuting, itOrThem(ids.length, RUN_LOCK_VERBS.duplicateIt, RUN_LOCK_VERBS.duplicateThem), { title: 'Duplicate selected nodes', kept: 'live' })}
      >
        <Files size={17} aria-hidden="true" />
        <span className="selection-toolbar__label--compact">Duplicate</span>
      </button>
      <button
        type="button"
        className="selection-toolbar__button"
        onClick={autoLayoutSelected}
        {...runLocked(isExecuting, RUN_LOCK_VERBS.arrangeThem, { disabled: ids.length < 2, title: 'Arrange selected nodes', kept: 'live' })}
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
        {...runLocked(isExecuting, itOrThem(ids.length, RUN_LOCK_VERBS.deleteIt, RUN_LOCK_VERBS.deleteThem),
          { disabled: sceneHeld !== null, title: sceneHeld ?? 'Delete selected nodes', kept: 'live' })}
        aria-label="Delete selected nodes"
      >
        <Trash2 size={17} aria-hidden="true" />
      </button>
    </div>
  );
}

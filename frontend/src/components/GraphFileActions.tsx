import { useCallback, useEffect, useRef } from 'react';
import { refuseEditWhileFollowing } from '../lib/canvasFollow';
import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { saveUndoWalk, useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
// Save and open load lib/graphFile.ts at the moment of use (preloaded on idle).
import { graphFileModule } from '../lib/deferredChunks';
import { canLoadGraph, canSaveGraph, fileKeyLockLine, GRAPH_LOAD_EVENT, GRAPH_SAVE_EVENT } from '../lib/graphFileActions';
import { apiRequest } from '../lib/apiRequest';
import { rewriteBackendAssetUrls } from '../lib/backend';
import { adoptCanvasRevision } from '../lib/projectContext';
import type { CutOffSave } from '../lib/savingCutOff';
import { failureMessage, FailureNotice, RequestFailedError } from '../lib/errorCopy';
import { showNotice } from '../lib/canvasNotice';
import { isModalDialogOpen } from '../lib/canvasShortcutScope';
import { computeCanvasFitPadding } from '../lib/canvasFit';
import { providerKeyWarnings } from '../lib/providerSwitch';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { projectNameForFile } from '../lib/projectSize';
import type { LoadedGraph } from '../lib/graphFile';
import type { NodeData } from '../types';
import { refuseEditWhileOffline } from '../lib/backendConnection';

/** The Toolbar's "Load graph" (GM's heading pattern, error-copy round 2). */
const LOAD_GRAPH = "Nebula couldn’t load the canvas.";

/** Until Projects finishes what it is doing (a rename, a save's answer), so
 * a create for Load graph isn't turned away for being busy. */
function projectsIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (!useProjectStore.getState().busy) { resolve(); return; }
    const stop = useProjectStore.subscribe((state) => { if (!state.busy) { stop(); resolve(); } });
  });
}

/** Mount once inside the app's ReactFlowProvider, independently of Canvas. */
export function GraphFileActions() {
  const { fitView, getViewport } = useReactFlow();
  const actionInFlight = useRef(false);
  const fitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(async () => {
    const state = useGraphStore.getState();
    // Never serialize a pre-checkpoint paid node while its start is unsettled.
    if (actionInFlight.current || !canSaveGraph(state)) return;
    actionInFlight.current = true;
    try {
      const ui = useUIStore.getState();
      const canvasActive = ui.viewMode === 'canvas' || (ui.viewMode === 'commons' && !ui.commonsEnabled);
      const viewport = canvasActive ? getViewport() : ui.canvasViewport ?? getViewport();
      const { saveToFile, saveStepToFit } = await graphFileModule.load();
      const projects = useProjectStore.getState();
      const name = projects.initialized ? projects.activeProject?.name : undefined;
      // The Undo that brings the canvas back within Save's limits, worked out
      // only if Save refuses it (GM PR #205 r16 item 1).
      const walk = saveUndoWalk(state.undoStack);
      await saveToFile(state.nodes, state.edges, viewport, name,
        () => saveStepToFit(walk, state.nodes, state.edges, viewport, name));
    } catch (error) {
      console.error('Graph save failed:', error);
      showNotice(failureMessage(error, "Nebula couldn’t save the canvas."));
    } finally {
      actionInFlight.current = false;
    }
  }, [getViewport]);

  /** The file's graph into the open project's canvas, replacing it. With
   * `refuseOverLimit`, 'over' when the backend refused it, before anything
   * changed, for being over the save limit as a project of its own (Q120).
   * `asNewProject`: the project was just made for it, which its line says. */
  const importGraph = useCallback(async (result: LoadedGraph, refuseOverLimit = false,
    asNewProject = false): Promise<'over' | void> => {
    // Offline is read-only (GM, round 14 of PR #114): nothing is sent.
    if (refuseEditWhileFollowing() || refuseEditWhileOffline() || !canLoadGraph(useGraphStore.getState())) return;
    let importReserved = false;
    // Round 19 (GM): new graph writes wait from here; those on their way go
    // first (15 s at most, "Saving…" on the project bar), so none can land
    // on the imported nodes. One that failed or didn't land in time doesn't
    // hold the import: the new canvas says it.
    const leaving = useProjectStore.getState().activeProject?.name ?? null;
    const statusBefore = useProjectStore.getState().saveStatus;
    const showSaving = leaving !== null && (statusBefore === 'saved' || statusBefore === 'unsaved');
    if (showSaving) useProjectStore.setState({ saveStatus: 'saving' });
    let replaced = false;
    let cutOff: CutOffSave[] = [];
    try {
      cutOff = await useGraphStore.getState().drainGraphWrites('import');
    } finally {
      if (showSaving && useProjectStore.getState().saveStatus === 'saving') useProjectStore.setState({ saveStatus: statusBefore });
    }
    try {
      if (!canLoadGraph(useGraphStore.getState())) return;
      // graphSync can publish the imported graph before this HTTP response.
      // Fence every local generation admission through that entire interval.
      importReserved = useGraphStore.getState().reserveGraphImport();
      if (!importReserved) return;
      // Preserve the current graph until the entire backend import succeeds.
      const response = await apiRequest(LOAD_GRAPH, '/api/graph/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodes: result.nodes.map((node) => ({
            id: node.id, definitionId: node.data.definitionId, label: node.data.label,
            params: node.data.params ?? {}, outputs: node.data.outputs ?? {},
            position: { x: node.position.x, y: node.position.y },
          })),
          edges: result.edges.map((edge) => ({
            source: edge.source, sourceHandle: edge.sourceHandle ?? '',
            target: edge.target, targetHandle: edge.targetHandle ?? '',
          })),
          // 0 for a file saved before the marker: the backend upgrades it once.
          paramsVersion: result.paramsVersion,
          ...(refuseOverLimit ? { refuseOverSaveLimit: true } : {}),
        }),
      });
      const imported = await response.json() as { nodes: Node<NodeData>[]; edges: Edge[]; warnings?: string[];
        canvasRevision?: string };
      // The canvas Nebula holds now: the tab's writes to it carry it.
      adoptCanvasRevision(undefined, imported.canvasRevision);
      // Read from what the backend loaded: a node folded into another
      // (services/retired_nodes.py MERGED) arrives as its new node.
      // Nodes set to a provider with no key here keep their choice and values
      // (the chip shows the stop); the import summary names them.
      const keys = useUIStore.getState().settingsCache;
      const providerWarnings = keys.loaded ? providerKeyWarnings(imported.nodes, NODE_DEFINITIONS, keys.apiKeys) : [];
      const loadWarnings = imported.warnings ?? [];
      if (providerWarnings.length > 0 || loadWarnings.length > 0) {
        console.warn('[nebula] Import warnings:', [...loadWarnings, ...providerWarnings]);
      }
      // Local starts are fenced; an external backend run can still acquire
      // ownership through WebSocket reconciliation. Preserve its workspace.
      const state = useGraphStore.getState();
      if (state.isExecuting || state.createLaunchingIds.length > 0) return;
      // Shown like every other read of the graph (applyProject, fetchCLIGraph):
      // this backend's links resolved, so a file:// desktop tab can draw them.
      // A World keeps its relative links; saves canonicalize the rest again.
      useGraphStore.getState().loadGraph(rewriteBackendAssetUrls(imported.nodes), rewriteBackendAssetUrls(imported.edges));
      replaced = true;
      useGraphStore.getState().finishCanvasReplacement({ kind: 'import', project: leaving ?? '', cutOff,
        show: leaving !== null });
      // A file over the save limit opens (Q118): the project store says so
      // with GM's Load graph line and pauses saving until it is trimmed.
      useProjectStore.getState().noteLoadedGraph(result.fileName ?? 'the canvas', asNewProject);
      // The old focused target may no longer exist after replacement. Clear
      // its UI state without running exit cleanup against the newly loaded IDs.
      useUIStore.setState({
        // A pinned Inspector stays pinned, with its empty state (GM PR #205 r10 item 3).
        viewMode: 'canvas', selectedNodeId: null,
        editorTargetNodeId: null, remotionEditorTargetNodeId: null, cinemaEditorNodeId: null,
        characterEditorId: null, moodboardEditorId: null, selectedClipId: null,
        selectedTrackItemId: null, selectedTrackItemIds: [], isKeyframeRecording: false,
        isPlaying: false, renderedPreviewUrl: null, pendingPreset: null,
      });
      if (fitTimer.current !== null) clearTimeout(fitTimer.current);
      const focusRevision = useUIStore.getState().canvasFocusRevision;
      const viewportRevision = useUIStore.getState().canvasViewportRevision;
      fitTimer.current = setTimeout(() => {
        fitTimer.current = null;
        const ui = useUIStore.getState();
        if (ui.viewMode !== 'canvas' || ui.canvasFocusRequest || ui.canvasFocusRevision !== focusRevision) return;
        if (ui.canvasViewportRevision !== viewportRevision) return;
        void fitView({ padding: computeCanvasFitPadding(), duration: 300 });
      }, 120);
      const notes: string[] = [];
      if (loadWarnings.length > 0) notes.push(loadWarnings.map((line) => `• ${line}`).join('\n'));
      if (providerWarnings.length > 0) {
        notes.push(`Set to a provider you have no key for:\n${providerWarnings.map((line) => `• ${line}`).join('\n')}`
          + '\nAdd the key in Settings > Providers, or pick another provider on the node.');
      }
      if (notes.length > 0) showNotice(`Imported.\n${notes.join('\n')}`, 'info');
    } catch (error) {
      if (refuseOverLimit && error instanceof RequestFailedError && error.overSaveLimit) return 'over';
      console.error('Graph import failed; existing graph preserved:', error);
      // The import's own checks read GM's lines by the answer's code, never
      // the backend's words (GM PR #205 r16 item 3; review 7 limits LOW-1).
      if (error instanceof RequestFailedError && error.code) {
        const { bundleRefusalLine } = await graphFileModule.load();
        const line = bundleRefusalLine({ code: error.code });
        if (line) {
          showNotice(failureMessage(new FailureNotice('', line), LOAD_GRAPH));
          return;
        }
      }
      showNotice(failureMessage(error, LOAD_GRAPH));
    } finally {
      if (importReserved) useGraphStore.getState().releaseGraphImport();
      // Not replaced: the writes that waited go to the canvas still there.
      if (!replaced) useGraphStore.getState().finishCanvasReplacement(null);
    }
  }, [fitView]);

  const load = useCallback(async () => {
    // Round 20 (M1): not while the tab follows an agent's switch. Offline is
    // read-only (GM, round 14 of PR #114): nothing is sent.
    if (refuseEditWhileFollowing() || refuseEditWhileOffline()) return;
    if (actionInFlight.current || !canLoadGraph(useGraphStore.getState())) return;
    actionInFlight.current = true;
    try {
      const { loadFromFile } = await graphFileModule.load();
      const result = await loadFromFile();
      if (!result || !canLoadGraph(useGraphStore.getState())) return;
      if (result.warnings.length > 0) console.warn('[nebula] Load warnings:', result.warnings);
      // Q120 (Justin): "Files over the limit open as a new project named
      // after the file. The open project is left as it was. Files under the
      // limit still replace the canvas, as today." The backend's save check
      // decides, exactly: the import into the open project asks to be
      // refused, before anything changes, when the file is over the limit as
      // a project of its own. (This tab's measure can't: the import adds
      // fields and changes ids.) The load runs once the new project is open,
      // after #178's screen when saving is paused with unsaved edits.
      const projects = useProjectStore.getState();
      if (!projects.initialized || !projects.activeProject) {
        await importGraph(result);
        return;
      }
      if (await importGraph(result, true) !== 'over') return;
      await projectsIdle();
      let loading = false;
      await useProjectStore.getState().createProject(projectNameForFile(result.fileName), async () => {
        loading = true;
        await importGraph(result, false, true);
      });
      // Neither opened, nor waiting behind #178's screen, nor turned away with
      // its own line on Projects: say the file didn't open.
      const after = useProjectStore.getState();
      if (!loading && !after.unsavedEdits && !after.error) showNotice(failureMessage(null, LOAD_GRAPH));
    } catch (error) {
      console.error('Graph load failed:', error);
      showNotice(failureMessage(error, LOAD_GRAPH));
    } finally {
      actionInFlight.current = false;
    }
  }, [importGraph]);

  useEffect(() => {
    const onSave = () => { void save(); };
    const onLoad = () => { void load(); };
    const onKeyDown = (event: KeyboardEvent) => {
      // Canvas handles these through its React key event before document
      // bubbling. Yield to that handler so one key opens only one dialog.
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)
        || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== 's' && key !== 'o') return;
      event.preventDefault();
      // Never behind an open dialog: opening a file swaps the canvas under it (review 7, M-1).
      if (isModalDialogOpen()) return;
      const graph = useGraphStore.getState();
      const line = fileKeyLockLine(key, graph);
      if (line) { graph.sayRunLocked(line); return; }
      if (key === 's') void save();
      else void load();
    };
    window.addEventListener(GRAPH_SAVE_EVENT, onSave);
    window.addEventListener(GRAPH_LOAD_EVENT, onLoad);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(GRAPH_SAVE_EVENT, onSave);
      window.removeEventListener(GRAPH_LOAD_EVENT, onLoad);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [save, load]);

  useEffect(() => {
    const cancelFit = () => {
      if (fitTimer.current !== null) clearTimeout(fitTimer.current);
      fitTimer.current = null;
    };
    const unsubscribe = useUIStore.subscribe((state, previous) => {
      // Returning before the timer expires does not restore its ownership.
      if (state.viewMode !== previous.viewMode) cancelFit();
    });
    return () => { unsubscribe(); cancelFit(); };
  }, []);

  return null;
}

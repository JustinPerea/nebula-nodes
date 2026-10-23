import { useCallback, useEffect, useRef } from 'react';
import { useReactFlow, type Edge, type Node } from '@xyflow/react';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
// Save and open load lib/graphFile.ts at the moment of use (preloaded on idle).
import { graphFileModule } from '../lib/deferredChunks';
import { canLoadGraph, canSaveGraph, GRAPH_LOAD_EVENT, GRAPH_SAVE_EVENT } from '../lib/graphFileActions';
import { apiRequest } from '../lib/apiRequest';
import { failureMessage } from '../lib/errorCopy';
import { showNotice } from '../lib/canvasNotice';
import { computeCanvasFitPadding } from '../lib/canvasFit';
import { providerKeyWarnings } from '../lib/providerSwitch';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';

/** The Toolbar's "Load graph" (GM's heading pattern, error-copy round 2). */
const LOAD_GRAPH = "Couldn't load the graph.";

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
      const { saveToFile } = await graphFileModule.load();
      await saveToFile(state.nodes, state.edges, viewport);
    } catch (error) {
      console.error('Graph save failed:', error);
      showNotice(failureMessage(error, "Couldn't save the graph."));
    } finally {
      actionInFlight.current = false;
    }
  }, [getViewport]);

  const load = useCallback(async () => {
    if (actionInFlight.current || !canLoadGraph(useGraphStore.getState())) return;
    actionInFlight.current = true;
    let importReserved = false;
    try {
      const { loadFromFile } = await graphFileModule.load();
      const result = await loadFromFile();
      if (!result || !canLoadGraph(useGraphStore.getState())) return;
      if (result.warnings.length > 0) console.warn('[nebula] Load warnings:', result.warnings);

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
        }),
      });
      const imported = await response.json() as { nodes: Node<NodeData>[]; edges: Edge[]; warnings?: string[] };
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
      useGraphStore.getState().loadGraph(imported.nodes, imported.edges);
      // The old focused target may no longer exist after replacement. Clear
      // its UI state without running exit cleanup against the newly loaded IDs.
      useUIStore.setState({
        viewMode: 'canvas', selectedNodeId: null, inspectorPinned: false,
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
      console.error('Graph import failed; existing graph preserved:', error);
      showNotice(failureMessage(error, LOAD_GRAPH));
    } finally {
      if (importReserved) useGraphStore.getState().releaseGraphImport();
      actionInFlight.current = false;
    }
  }, [fitView]);

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

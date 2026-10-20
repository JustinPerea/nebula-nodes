import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Panel,
  useReactFlow,
  useInternalNode,
  useStore,
  type Connection,
  type OnConnectEnd,
  type OnConnectStart,
  type Viewport,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { useIsValidConnection } from '../hooks/useIsValidConnection';
import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES } from './canvasTypes';
import { ContextMenu } from './ContextMenu';
import { ConnectionPopup } from './DeferredPanels';
import { SelectionToolbar } from './SelectionToolbar';
import { CanvasNavigation } from './CanvasNavigation';
import { AgentCursorLayer } from './canvas/AgentCursorLayer';
import { PinLayer } from './canvas/PinLayer';
import { PinComposer } from './canvas/PinComposer';
import { ProposalLayer } from './canvas/ProposalLayer';
import { ProposalBar } from './canvas/ProposalBar';
import { CanvasViewReporter } from './canvas/CanvasViewReporter';
import { ArrangeController } from './canvas/ArrangeController';
import { selectMeasuring, useArrangeStore } from '../store/arrangeStore';
import { CrabMarkAnimated } from './brand/CrabMarkAnimated';
import { CHARACTER_DRAG_MIME, MOODBOARD_DRAG_MIME } from '../lib/dragMime';
import { apiFetch } from '../lib/backend';
import { CANVAS_INTERACTION_PROPS } from '../lib/canvasNavigation';
import { CANVAS_FIT_DURATION, CANVAS_ZOOM_DURATION, computeCanvasFitPadding } from '../lib/canvasFit';
import { useFitCanvasView } from '../hooks/useFitCanvasView';
import { CANVAS_LOD_ZOOM } from '../lib/canvasOverview';
import { isCanvasShortcutTarget } from '../lib/canvasShortcutScope';
import { boundingRect, UNMEASURED_NODE_SIZE, type NodeRect } from '../lib/nodePlacement';
import type { NodeData } from '../types';
import { NODE_RENAME_EVENT } from '../lib/keyboardShortcuts';
import { publishCanvasSelection, selectedNodeIds } from '../lib/canvasSelection';
import '../styles/canvas.css';

const nodeTypes = CANVAS_NODE_TYPES;
const edgeTypes = CANVAS_EDGE_TYPES;

const DEFAULT_FIT_MAX_ZOOM = 0.85;
const FIRST_NODE_FIT_MAX_ZOOM = 0.62;

function getEventClientPoint(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event) {
    return { x: event.clientX, y: event.clientY };
  }
  const touch = event.changedTouches[0] ?? event.touches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function useSlavaHandleMagnetism() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const MAX_PULL = 3;
    const PULL_FACTOR = 0.28;
    let activeHandle: HTMLElement | null = null;
    let raf = 0;
    let magnetX = 0;
    let magnetY = 0;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduceMotion = motionQuery.matches;

    const isSlavaSkin = () => document.body.classList.contains('app-slava-restraint');

    const resetHandle = (handle: HTMLElement | null) => {
      if (!handle) return;
      handle.style.setProperty('--sr-handle-magnet-x', '0px');
      handle.style.setProperty('--sr-handle-magnet-y', '0px');
    };

    const commitMagnet = () => {
      if (activeHandle) {
        activeHandle.style.setProperty('--sr-handle-magnet-x', `${magnetX.toFixed(2)}px`);
        activeHandle.style.setProperty('--sr-handle-magnet-y', `${magnetY.toFixed(2)}px`);
      }
      raf = 0;
    };

    const scheduleMagnet = (handle: HTMLElement, x: number, y: number) => {
      activeHandle = handle;
      magnetX = x;
      magnetY = y;
      if (!raf) raf = window.requestAnimationFrame(commitMagnet);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isSlavaSkin() || reduceMotion) {
        resetHandle(activeHandle);
        activeHandle = null;
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const handle = target?.closest('.react-flow__handle') as HTMLElement | null;
      if (!handle) {
        resetHandle(activeHandle);
        activeHandle = null;
        return;
      }

      if (activeHandle && activeHandle !== handle) resetHandle(activeHandle);

      const rect = handle.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      if (distance === 0) {
        scheduleMagnet(handle, 0, 0);
        return;
      }

      const pull = Math.min(MAX_PULL, distance * PULL_FACTOR);
      scheduleMagnet(handle, (dx / distance) * pull, (dy / distance) * pull);
    };

    const onPointerOut = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const handle = target?.closest('.react-flow__handle') as HTMLElement | null;
      if (!handle) return;

      const related = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (related && handle.contains(related)) return;

      resetHandle(handle);
      if (activeHandle === handle) activeHandle = null;
    };

    const onBlur = () => {
      resetHandle(activeHandle);
      activeHandle = null;
    };

    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      reduceMotion = event.matches;
      if (!reduceMotion) return;
      resetHandle(activeHandle);
      activeHandle = null;
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerout', onPointerOut, { passive: true });
    window.addEventListener('blur', onBlur);
    motionQuery.addEventListener('change', onMotionPreferenceChange);

    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('blur', onBlur);
      motionQuery.removeEventListener('change', onMotionPreferenceChange);
      if (raf) window.cancelAnimationFrame(raf);
      resetHandle(activeHandle);
    };
  }, []);
}

/**
 * Reads live zoom from the React Flow store and writes a `data-lod` attribute on
 * the canvas wrapper when zoomed out past `threshold`. Selecting only the zoom
 * scalar (`transform[2]`) means this re-renders on zoom change but NOT on pan,
 * and it returns null so there is no DOM diff. It also sets the UI store's
 * `canvasZoomedOut`, which changes only when the cutoff is crossed: nodes read
 * it to swap their images for thumbnails (lib/canvasOverview.ts), so they
 * re-render once per crossing, never per zoom step.
 * Must live inside the React Flow provider context (rendered as a <ReactFlow> child).
 */
function ZoomLodController({
  wrapperRef,
  threshold,
  enabled,
}: {
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  threshold: number;
  enabled: boolean;
}) {
  const zoom = useStore((s) => s.transform[2]);
  useEffect(() => {
    const zoomedOut = enabled && zoom < threshold;
    useUIStore.getState().setCanvasZoomedOut(zoomedOut);
    const el = wrapperRef.current;
    if (!el) return;
    if (!enabled) {
      delete el.dataset.lod;
      return;
    }
    el.dataset.lod = zoomedOut ? 'low' : 'high';
  }, [zoom, threshold, enabled, wrapperRef]);
  useEffect(() => () => useUIStore.getState().setCanvasZoomedOut(false), []);
  return null;
}

/** Complete cross-workspace focus only after React Flow has measured the target. */
export function CanvasFocusController() {
  const request = useUIStore((state) => state.canvasFocusRequest);
  const viewMode = useUIStore((state) => state.viewMode);
  const targetExists = useGraphStore((state) => (
    !!request && state.nodes.some((node) => node.id === request.nodeId)
  ));
  const internalNode = useInternalNode(request?.nodeId ?? '');
  const { fitView, viewportInitialized } = useReactFlow();
  const startedRequestId = useRef<string | null>(null);
  const clearRequest = useUIStore((state) => state.clearCanvasNodeFocus);

  useEffect(() => {
    if (!request || viewMode !== 'canvas') return;
    const ui = useUIStore.getState();
    if (ui.canvasFocusRequest?.requestId !== request.requestId || ui.viewMode !== 'canvas') return;
    const graph = useGraphStore.getState();
    if (!graph.nodes.some((node) => node.id === request.nodeId)) {
      clearRequest(request.requestId);
      if (ui.selectedNodeId === request.nodeId) ui.selectNode(null);
      return;
    }
    if (!viewportInitialized || !internalNode?.measured.width || !internalNode.measured.height) return;
    if (startedRequestId.current === request.requestId) return;
    startedRequestId.current = request.requestId;
    // Hydration/graphSync may have replaced selection while measurements were
    // pending. Apply it to the current controlled graph before focusing.
    graph.onNodesChange(graph.nodes.filter((node) => !!node.selected !== (node.id === request.nodeId)).map((node) => ({
      id: node.id, type: 'select' as const, selected: node.id === request.nodeId,
    })));
    graph.onEdgesChange(graph.edges.filter((edge) => edge.selected).map((edge) => ({
      id: edge.id, type: 'select' as const, selected: false,
    })));
    if (ui.selectedNodeId !== request.nodeId) ui.selectNode(request.nodeId);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    void fitView({
      nodes: [{ id: request.nodeId }],
      padding: computeCanvasFitPadding(),
      maxZoom: 1,
      duration: reduceMotion ? 0 : 300,
    }).then(
      () => clearRequest(request.requestId),
      () => clearRequest(request.requestId),
    );
  }, [request, viewMode, targetExists, viewportInitialized, internalNode, fitView, clearRequest]);

  return null;
}

export function Canvas() {
  useSlavaHandleMagnetism();

  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const storeOnConnect = useGraphStore((s) => s.onConnect);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isValidConnection = useIsValidConnection();
  const skin = useUIStore((s) => s.skin);
  const canvasPerfMode = useUIStore((s) => s.canvasPerfMode);
  // While an agent's arrange waits to measure its new nodes, render them all:
  // a node culled off screen has no size to lay out by (ArrangeController).
  const arrangeMeasuring = useArrangeStore(selectMeasuring);
  const canvasLowDetail = useUIStore((s) => s.canvasLowDetail);
  const onboardingActive = useUIStore((s) => s.onboardingActive);
  const leftDock = useUIStore((s) => s.leftDock);
  // React Flow resets its camera when it unmounts. Restore only this mount's
  // initial camera; later pan and explicit node-focus requests own the viewport.
  // Consuming a handoff must not queue a second fit of the complete graph.
  const initialCanvasState = useRef({
    viewport: useUIStore.getState().canvasViewport,
    viewportRevision: useUIStore.getState().canvasViewportRevision,
    fitEnabled: useUIStore.getState().canvasFocusRequest === null
      && useUIStore.getState().canvasViewport === null,
  }).current;
  const canvasMounted = useRef(false);
  useEffect(() => {
    canvasMounted.current = true;
    return () => { canvasMounted.current = false; };
  }, []);
  // The camera this mount places itself (onInit's start, or the first fit of
  // a graph with no saved view) isn't the person's move, so opening a
  // project doesn't read as an unsaved change (projectStore adoptCanvasCamera).
  // The fitView prop's fit waits for nodes: on a canvas that mounted empty it
  // runs when a followed project's graph arrives, and is still the canvas's own.
  const initialFit = useRef(initialCanvasState.fitEnabled);
  const rememberViewport = useCallback((viewport: Viewport, initial?: boolean) => {
    const ui = useUIStore.getState();
    const canvasActive = ui.viewMode === 'canvas' || (ui.viewMode === 'commons' && !ui.commonsEnabled);
    if (canvasMounted.current && canvasActive) ui.setCanvasViewport(viewport, { initial });
  }, []);
  const onViewportInitialized = useCallback((instance: { getViewport: () => Viewport }) => {
    // React Flow schedules onInit. An import can replace the graph before that
    // callback runs, so it must not reintroduce the previous graph's camera.
    if (useUIStore.getState().canvasViewportRevision !== initialCanvasState.viewportRevision) return;
    // onInit only means the pan/zoom controller exists; the first graph fit can
    // still be waiting for node measurements. A quick studio visit must not
    // turn that temporary origin camera into a restored, never-fitted viewport.
    if (initialCanvasState.fitEnabled && useGraphStore.getState().nodes.length > 0) return;
    rememberViewport(instance.getViewport(), true);
  }, [initialCanvasState.fitEnabled, initialCanvasState.viewportRevision, rememberViewport]);
  const onViewportMove = useCallback((event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    // The first fit has no input event; the person's pan or zoom ends it.
    rememberViewport(viewport, !event && initialFit.current);
    initialFit.current = false;
  }, [rememberViewport]);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);
  const showConnectionPopup = useUIStore((s) => s.showConnectionPopup);
  const isSlavaSkin = skin === 'slava-restraint';
  const renderedEdges = useMemo(() => {
    if (!isSlavaSkin || !isExecuting) return edges;
    return edges.map((edge) => ({
      ...edge,
      animated: true,
      className: edge.className?.includes('typed-edge--running')
        ? edge.className
        : [edge.className, 'typed-edge--running'].filter(Boolean).join(' '),
    }));
  }, [edges, isExecuting, isSlavaSkin]);
  const liveSelectedNodeIds = useMemo(() => selectedNodeIds(nodes), [nodes]);
  const liveSelectionKey = liveSelectedNodeIds.join('\u0000');

  // Publish only IDs. The backend resolves authoritative node data on read,
  // keeping transient selection out of saved graph files and stale handles out
  // of CLI/MCP context. Debounce marquee churn while preserving the final set.
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      publishCanvasSelection(liveSelectedNodeIds, controller.signal).catch((error) => {
        if (controller.signal.aborted) return;
        console.warn('[nebula] selection context sync failed:', error);
      });
    }, 80);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [liveSelectionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const reactFlow = useReactFlow();
  const { fitView, screenToFlowPosition, zoomIn, zoomOut, zoomTo } = reactFlow;
  // Fit view includes an open proposal's ghosts.
  const fitCanvasView = useFitCanvasView();

  // Dev-only window bridge for scripted UI capture (the nebula-nodes-visuals
  // skill's capture template). Exposes React Flow viewport controls
  // (setViewport / getViewport) so capture runs can frame the canvas in-app.
  // Also exposes setNodePosition for choreographed node
  // moves between recording beats.
  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env?.DEV) return;
    (window as unknown as { __nebulaCanvas?: unknown }).__nebulaCanvas = {
      getViewport: () => reactFlow.getViewport(),
      setViewport: (v: { x: number; y: number; zoom: number }, duration = 0) =>
        reactFlow.setViewport(v, duration > 0 ? { duration } : undefined),
      zoomTo: (zoom: number, duration = 0) =>
        reactFlow.zoomTo(zoom, duration > 0 ? { duration } : undefined),
      // Center a flow-coord point at the React Flow container's screen
      // center (or any container-relative anchor). Driver uses this to
      // place demo nodes at predictable composed positions without doing
      // viewport math by hand.
      centerOn: (
        cx: number,
        cy: number,
        zoom = 0.85,
        duration = 700,
        anchor?: { x: number; y: number },
      ) => {
        const containerEl = document.querySelector('.react-flow') as HTMLElement | null;
        if (!containerEl) return;
        const r = containerEl.getBoundingClientRect();
        const ax = anchor?.x ?? r.width / 2;
        const ay = anchor?.y ?? r.height / 2;
        reactFlow.setViewport(
          { x: ax - cx * zoom, y: ay - cy * zoom, zoom },
          duration > 0 ? { duration } : undefined,
        );
      },
      setNodePosition: (nodeId: string, position: { x: number; y: number }) => {
        reactFlow.setNodes((nodes) =>
          nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
        );
      },
      getNode: (nodeId: string) => reactFlow.getNode(nodeId),
    };
  }, [reactFlow]);

  // Auto-fit the viewport when Claude (or any CLI) adds nodes via graphSync.
  // Padding is asymmetric and chat-panel-aware: the chat panel floats above
  // the canvas, so nodes laid out without right-padding render behind it.
  // We measure the panel's actual position at fit-time so users who moved or
  // resized it still get a clean fit. Falls back to symmetric padding when
  // the panel is hidden.
  useEffect(() => {
    const pendingFits = new Set<number>();
    function onNodesAdded(event: Event) {
      // Driver-side flag (DEV demo runs only) to suppress the auto-fit
      // when subsequent nodes arrive. Lets the driver own the post-first-
      // node layout instead of getting clobbered by every fitView call.
      const suppressed =
        typeof window !== 'undefined' &&
        (window as unknown as { __nebulaSuppressFitView?: boolean }).__nebulaSuppressFitView;
      if (suppressed) return;
      const focusState = useUIStore.getState();
      if (focusState.canvasFocusRequest) return;
      const scheduledRevision = focusState.canvasFocusRevision;
      const viewportRevision = focusState.canvasViewportRevision;
      const timer = window.setTimeout(() => {
        pendingFits.delete(timer);
        const currentFocus = useUIStore.getState();
        if (currentFocus.canvasFocusRequest || currentFocus.canvasFocusRevision !== scheduledRevision) return;
        if (currentFocus.canvasViewportRevision !== viewportRevision) return;
        if (currentFocus.viewMode !== 'canvas'
          && !(currentFocus.viewMode === 'commons' && !currentFocus.commonsEnabled)) return;
        const padding = computeCanvasFitPadding();
        const totalCount =
          event instanceof CustomEvent && typeof event.detail?.totalCount === 'number'
            ? event.detail.totalCount
            : useGraphStore.getState().nodes.length;
        fitView({
          padding,
          duration: 400,
          maxZoom: totalCount <= 1 ? FIRST_NODE_FIT_MAX_ZOOM : DEFAULT_FIT_MAX_ZOOM,
        });
      }, 80);
      pendingFits.add(timer);
    }
    window.addEventListener('nebula:graph-nodes-added', onNodesAdded);
    return () => {
      window.removeEventListener('nebula:graph-nodes-added', onNodesAdded);
      pendingFits.forEach((timer) => window.clearTimeout(timer));
    };
  }, [fitView]);

  // Track the connection being dragged so onConnectEnd knows what port it came from
  const connectStartRef = useRef<{ nodeId: string; handleId: string; handleType: 'source' | 'target' } | null>(null);
  const connectionSucceededRef = useRef(false);

  const onConnectStart: OnConnectStart = useCallback((_event, params) => {
    connectionSucceededRef.current = false;
    connectStartRef.current = {
      nodeId: params.nodeId ?? '',
      handleId: params.handleId ?? '',
      handleType: (params.handleType ?? 'source') as 'source' | 'target',
    };
  }, []);

  const handleConnect = useCallback((connection: Connection) => {
    connectionSucceededRef.current = true;
    storeOnConnect(connection);
  }, [storeOnConnect]);

  const onConnectEnd: OnConnectEnd = useCallback((event, connectionState) => {
    const info = connectStartRef.current;
    connectStartRef.current = null;
    const connectionSucceeded = connectionSucceededRef.current;
    connectionSucceededRef.current = false;
    if (!info || !info.nodeId || !info.handleId) return;
    if (connectionSucceeded) return;
    if (connectionState.toHandle || connectionState.toNode || connectionState.isValid !== null) return;

    const point = getEventClientPoint(event);
    if (!point) return;

    // Only show popup if the drag ended on empty space (not on a handle/node)
    const target = event.target as HTMLElement;
    if (target.closest('.react-flow__handle') || target.closest('.react-flow__node')) return;
    const elementsAtDrop = document.elementsFromPoint(point.x, point.y);
    if (elementsAtDrop.some((el) => el.closest('.react-flow__handle') || el.closest('.react-flow__node'))) return;

    showConnectionPopup({
      position: point,
      nodeId: info.nodeId,
      handleId: info.handleId,
      handleType: info.handleType,
    });
  }, [showConnectionPopup]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      // Check for image or video file drops first
      const files = event.dataTransfer.files;
      if (files.length > 0) {
        const mediaFiles = Array.from(files).filter(
          (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
        );
        if (mediaFiles.length > 0) {
          const reactFlowBounds = (event.target as HTMLElement)
            .closest('.react-flow')
            ?.getBoundingClientRect();
          if (!reactFlowBounds) return;

          mediaFiles.forEach((file) => {
            // Upload then register the node in cli_graph so Claude's `nebula graph`
            // sees it with a short ID. graphSync will push it back to the canvas.
            // Position from the drop event is discarded — cli_graph export auto-lays-out.
            // Backend routes image → image-input node, video → video-input node.
            const formData = new FormData();
            formData.append('file', file);
            formData.append('create_node', 'true');
            // One undo step per dropped file, taken before its graphSync lands.
            const undoStep = useGraphStore.getState().beginUndoStep();
            apiFetch('/api/uploads', { method: 'POST', body: formData })
              .then((r) => {
                if (!r.ok) useGraphStore.getState().cancelUndoStep(undoStep);
                return r.json();
              })
              .catch((err) => {
                useGraphStore.getState().cancelUndoStep(undoStep);
                console.error('Upload/create failed:', err);
              });
          });
          return;
        }
      }

      // Character palette drag → drop a `character` node referencing that asset.
      // The payload carries { id, name, thumbnail } (set by CharacterLibrary's
      // onDragStart) so the dropped node renders with denormalized name/thumb,
      // mirroring click-to-add's addCharacterNode(id, pos, meta) path.
      const characterPayload = event.dataTransfer.getData(CHARACTER_DRAG_MIME);
      if (characterPayload) {
        try {
          const { id, name, thumbnail } = JSON.parse(characterPayload) as {
            id: string;
            name?: string;
            thumbnail?: string;
          };
          if (!id) return;
          const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          void useGraphStore.getState().addCharacterNode(id, position, { name, thumbnail });
        } catch (err) {
          console.error('[nebula] character drop failed to parse payload:', err);
        }
        return;
      }

      const moodboardPayload = event.dataTransfer.getData(MOODBOARD_DRAG_MIME);
      if (moodboardPayload) {
        try {
          const { id, name, thumbnail, imageCount, setAsideCount, mode } = JSON.parse(moodboardPayload) as {
            id: string;
            name?: string;
            thumbnail?: string;
            imageCount?: number;
            setAsideCount?: number;
            mode?: string;
          };
          if (!id) return;
          const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          void useGraphStore.getState().addMoodboardNode(id, position, { name, thumbnail, imageCount, setAsideCount, mode });
        } catch (err) {
          console.error('[nebula] moodboard drop failed to parse payload:', err);
        }
        return;
      }

      const definitionId = event.dataTransfer.getData('application/nebula-node');
      if (!definitionId) return;

      // screenToFlowPosition maps the cursor into React Flow's coordinate space
      // so the node appears under the cursor at any zoom/pan. Using raw clientX/Y
      // minus bounds only works at zoom=1 and pan=(0,0).
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      useGraphStore.getState().addNode(definitionId, position);
    },
    [screenToFlowPosition]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    // Match dropEffect to the drag source's effectAllowed, otherwise browser
    // refuses the drop. Library-node drags use 'move'; OS file drags use 'copy'.
    const types = event.dataTransfer.types;
    event.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
  }, []);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: { id: string }) => {
      event.preventDefault();
      showContextMenu({ x: event.clientX, y: event.clientY }, node.id);
    },
    [showContextMenu]
  );

  const onPaneClick = useCallback(() => {
    hideContextMenu();
  }, [hideContextMenu]);

  // Right-click on empty canvas offers "Leave a note for agents here…".
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      const client = { x: event.clientX, y: event.clientY };
      showContextMenu(client, null, screenToFlowPosition(client));
    },
    [showContextMenu, screenToFlowPosition]
  );

  // Keyboard shortcuts: Ctrl+Enter, Ctrl+A, Ctrl+D, Ctrl+Z, Ctrl+Shift+Z, Ctrl+C, Ctrl+V,
  // and zoom: Ctrl/⌘ = and −, Shift+1 to fit, Shift+0 for 100%. Ctrl+S and
  // Ctrl+O belong to GraphFileActions, which listens app-wide.
  // On the document, not the wrapper, so they still work after a click on the
  // bottom bar, rail or header; isCanvasShortcutTarget keeps them out of text
  // fields, dialogs and other panels.
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isCanvasShortcutTarget(event.target)) return;
      const ui = useUIStore.getState();
      if (ui.viewMode !== 'canvas' && !(ui.viewMode === 'commons' && !ui.commonsEnabled)) return;
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;
      // Shift turns letters uppercase on some platforms (Ctrl+Shift+Z → 'Z').
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      // Ctrl/⌘ = and Ctrl/⌘ − zoom the canvas instead of the page.
      if (isCtrlOrCmd && !event.altKey && (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '_')) {
        event.preventDefault();
        if (event.key === '=' || event.key === '+') void zoomIn({ duration: CANVAS_ZOOM_DURATION });
        else void zoomOut({ duration: CANVAS_ZOOM_DURATION });
        return;
      }

      // Shift+1 fits the graph, Shift+0 resets to 100%. Matched by physical key,
      // because Shift turns 1 and 0 into ! and ) on most layouts.
      if (event.shiftKey && !isCtrlOrCmd && !event.altKey && (event.code === 'Digit1' || event.code === 'Digit0')) {
        event.preventDefault();
        if (event.code === 'Digit1') fitCanvasView();
        else void zoomTo(1, { duration: CANVAS_ZOOM_DURATION });
        return;
      }

      // Ctrl+Enter — Run graph
      if (isCtrlOrCmd && event.key === 'Enter' && !isExecuting) {
        event.preventDefault();
        executeGraph();
        return;
      }

      // F2 — Rename the one selected node (double-clicking its title does too)
      if (event.key === 'F2' && !isCtrlOrCmd) {
        const selected = useGraphStore.getState().nodes.filter((node) => node.selected);
        if (selected.length === 1) {
          event.preventDefault();
          window.dispatchEvent(new CustomEvent(NODE_RENAME_EVENT, { detail: { nodeId: selected[0].id } }));
        }
        return;
      }

      // Ctrl+A — Select all nodes
      if (isCtrlOrCmd && key === 'a') {
        event.preventDefault();
        useGraphStore.getState().selectAll();
        return;
      }

      // Ctrl+D — Duplicate selected nodes
      if (isCtrlOrCmd && key === 'd') {
        event.preventDefault();
        useGraphStore.getState().duplicateSelected();
        return;
      }

      // Ctrl+Z — Undo (must check before Ctrl+Shift+Z to avoid conflict)
      if (isCtrlOrCmd && !event.shiftKey && key === 'z') {
        event.preventDefault();
        useGraphStore.getState().undo();
        return;
      }

      // Ctrl+Shift+Z — Redo
      if (isCtrlOrCmd && event.shiftKey && key === 'z') {
        event.preventDefault();
        useGraphStore.getState().redo();
        return;
      }

      // Ctrl+C — Copy selected nodes, unless text is selected (copy that instead)
      if (isCtrlOrCmd && key === 'c' && !window.getSelection()?.toString()) {
        event.preventDefault();
        useGraphStore.getState().copySelected();
        return;
      }

      // Ctrl+V — Paste. The store doesn't know the viewport, so pass the
      // visible canvas: a paste from another project lands in it, clear of
      // the nodes there, and the view moves to it when no clear spot fits.
      if (isCtrlOrCmd && key === 'v') {
        event.preventDefault();
        const view = visibleFlowRect(wrapperRef.current, screenToFlowPosition);
        const pasted = useGraphStore.getState().pasteClipboard({ view });
        if (pasted.length > 0 && view) {
          const nodes = useGraphStore.getState().nodes.filter((node) => pasted.includes(node.id));
          const box = pastedRect(nodes);
          if (box && !(box.x >= view.x && box.y >= view.y
            && box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height)) {
            void fitView({ nodes: pasted.map((id) => ({ id })), padding: 0.2, duration: CANVAS_FIT_DURATION,
              maxZoom: reactFlow.getZoom() });
          }
        }
        return;
      }
    },
    [executeGraph, fitCanvasView, fitView, isExecuting, reactFlow, screenToFlowPosition, zoomIn, zoomOut, zoomTo]
  );

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <div
      ref={wrapperRef}
      className={`canvas-wrapper${isSlavaSkin ? ' canvas-wrapper--slava' : ''}${isSlavaSkin && nodes.length === 0 ? ' canvas-wrapper--slava-empty' : ''}`}
      data-dock-open={leftDock !== null}
      tabIndex={0}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={renderedEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        fitView={initialCanvasState.fitEnabled}
        defaultViewport={initialCanvasState.viewport ?? undefined}
        onInit={onViewportInitialized}
        onMove={onViewportMove}
        fitViewOptions={{ padding: computeCanvasFitPadding() }}
        minZoom={0.1}
        maxZoom={4}
        defaultEdgeOptions={{ type: 'typed-edge' }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={isExecuting ? null : ['Backspace', 'Delete']}
        {...CANVAS_INTERACTION_PROPS}
        onlyRenderVisibleElements={canvasPerfMode && !arrangeMeasuring}
      >
        <Background
          variant={isSlavaSkin ? BackgroundVariant.Dots : BackgroundVariant.Lines}
          gap={isSlavaSkin ? 16 : 32}
          size={isSlavaSkin ? 1.2 : 1}
          color={isSlavaSkin ? 'var(--sr-canvas-dot-color)' : 'rgba(255, 255, 255, 0.04)'}
          className={isSlavaSkin ? 'slava-canvas-background' : undefined}
          patternClassName={isSlavaSkin ? 'slava-canvas-background__dot' : undefined}
        />
        <ZoomLodController wrapperRef={wrapperRef} threshold={CANVAS_LOD_ZOOM} enabled={canvasLowDetail} />
        <CanvasFocusController />
        <Panel position="top-center" className="selection-toolbar-panel">
          <SelectionToolbar />
        </Panel>
        <CanvasNavigation />
        <CanvasViewReporter />
        <ArrangeController />
        <AgentCursorLayer />
        <PinLayer />
        <ProposalLayer />
        <ProposalBar />
      </ReactFlow>
      {isSlavaSkin && nodes.length === 0 && !onboardingActive ? (
        <div className="nn-splash" aria-hidden="true">
          <CrabMarkAnimated
            mode="breathe"
            size={200}
            className="nn-splash__mark"
          />
          <div className="nn-splash__wordmark">
            <span className="nn-splash__wordmark-line">NEBULA</span>
            <span className="nn-splash__wordmark-line nn-splash__wordmark-line--warm">
              NODES
            </span>
          </div>
          <div className="nn-splash__caption">empty canvas</div>
          <div className="nn-splash__hint">
            drag a node from the library to begin
          </div>
        </div>
      ) : null}
      <ContextMenu />
      <ConnectionPopup />
      <PinComposer />
    </div>
  );
}

/** The canvas the person can see, in flow coordinates, or undefined before it has a size. */
function visibleFlowRect(
  wrapper: HTMLDivElement | null,
  screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number },
): NodeRect | undefined {
  const box = wrapper?.getBoundingClientRect();
  if (!box || box.width <= 0 || box.height <= 0) return undefined;
  const topLeft = screenToFlowPosition({ x: box.left, y: box.top });
  const bottomRight = screenToFlowPosition({ x: box.right, y: box.bottom });
  return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
}

/** The pasted nodes' bounding box, with measured sizes when known. */
function pastedRect(nodes: Node<NodeData>[]): NodeRect | null {
  if (nodes.length === 0) return null;
  return boundingRect(nodes.map((node) => ({
    x: node.position.x, y: node.position.y,
    width: node.measured?.width ?? node.width ?? UNMEASURED_NODE_SIZE.width,
    height: node.measured?.height ?? node.height ?? UNMEASURED_NODE_SIZE.height,
  })));
}

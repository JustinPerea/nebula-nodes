import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useReactFlow,
  type NodeTypes,
  type EdgeTypes,
  type OnConnectStart,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { useIsValidConnection } from '../hooks/useIsValidConnection';
import { ModelNode } from './nodes/ModelNode';
import { DynamicNode } from './nodes/DynamicNode';
import { RerouteNode } from './nodes/RerouteNode';
import { TypedEdge } from './edges/TypedEdge';
import { ContextMenu } from './ContextMenu';
import { ConnectionPopup } from './ConnectionPopup';
import '../styles/canvas.css';

const nodeTypes: NodeTypes = {
  'model-node': ModelNode,
  'dynamic-node': DynamicNode,
  'reroute-node': RerouteNode,
};

// fitView padding that reserves space for every floating panel that overlaps
// the canvas. Returns explicit px values (React Flow's `Padding` accepts
// `${number}px` strings per side). Numeric padding takes a different formula
// in React Flow that does NOT correspond to "fraction of viewport", so px is
// the only way to guarantee content lands clear of the panels.
function computeChatAwarePadding(): { top: string; right: string; bottom: string; left: string } {
  const base = { top: '40px', right: '40px', bottom: '40px', left: '40px' };
  if (typeof window === 'undefined') return base;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Track furthest panel intrusion on each side, in pixels.
  const intrusion = { top: 0, right: 0, bottom: 0, left: 0 };
  const SAFETY = 24; // breathing room beyond the panel edge

  const PANEL_SELECTORS = ['.chat-panel', '.panel--library', '.panel--inspector', '.panel--settings'];
  for (const sel of PANEL_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Decide which viewport edge this panel hugs by min-distance.
    const dLeft = rect.left;
    const dRight = vw - rect.right;
    const dTop = rect.top;
    const dBottom = vh - rect.bottom;
    const minD = Math.min(dLeft, dRight, dTop, dBottom);
    if (minD === dLeft) intrusion.left = Math.max(intrusion.left, rect.right);
    else if (minD === dRight) intrusion.right = Math.max(intrusion.right, vw - rect.left);
    else if (minD === dTop) intrusion.top = Math.max(intrusion.top, rect.bottom);
    else intrusion.bottom = Math.max(intrusion.bottom, vh - rect.top);
  }

  return {
    top: `${Math.max(40, intrusion.top + SAFETY)}px`,
    right: `${Math.max(40, intrusion.right + SAFETY)}px`,
    bottom: `${Math.max(40, intrusion.bottom + SAFETY)}px`,
    left: `${Math.max(40, intrusion.left + SAFETY)}px`,
  };
}

const edgeTypes: EdgeTypes = {
  'typed-edge': TypedEdge,
};

export function Canvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const executeGraph = useGraphStore((s) => s.executeGraph);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isValidConnection = useIsValidConnection();
  const showContextMenu = useUIStore((s) => s.showContextMenu);
  const hideContextMenu = useUIStore((s) => s.hideContextMenu);
  const showConnectionPopup = useUIStore((s) => s.showConnectionPopup);
  const hideConnectionPopup = useUIStore((s) => s.hideConnectionPopup);

  const reactFlow = useReactFlow();
  const { fitView, screenToFlowPosition } = reactFlow;

  // Dev-only window bridge for the Puppeteer driver. Exposes React Flow
  // viewport controls (setViewport / getViewport) so demo runs can zoom out
  // the canvas in-app, separate from the post-process camera zoom in
  // apply-zoom.mjs. Also exposes setNodePosition for choreographed node
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
    function onNodesAdded() {
      // Driver-side flag (DEV demo runs only) to suppress the auto-fit
      // when subsequent nodes arrive. Lets the driver own the post-first-
      // node layout instead of getting clobbered by every fitView call.
      const suppressed =
        typeof window !== 'undefined' &&
        (window as unknown as { __nebulaSuppressFitView?: boolean }).__nebulaSuppressFitView;
      if (suppressed) return;
      setTimeout(() => {
        const padding = computeChatAwarePadding();
        fitView({ padding, duration: 400 });
      }, 80);
    }
    window.addEventListener('nebula:graph-nodes-added', onNodesAdded);
    return () => window.removeEventListener('nebula:graph-nodes-added', onNodesAdded);
  }, [fitView]);

  // Track the connection being dragged so onConnectEnd knows what port it came from
  const connectStartRef = useRef<{ nodeId: string; handleId: string; handleType: 'source' | 'target' } | null>(null);

  const onConnectStart: OnConnectStart = useCallback((_event, params) => {
    connectStartRef.current = {
      nodeId: params.nodeId ?? '',
      handleId: params.handleId ?? '',
      handleType: (params.handleType ?? 'source') as 'source' | 'target',
    };
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const info = connectStartRef.current;
    connectStartRef.current = null;
    if (!info || !info.nodeId || !info.handleId) return;

    // Only show popup if the drag ended on empty space (not on a handle/node)
    const target = event.target as HTMLElement;
    if (target.closest('.react-flow__handle') || target.closest('.react-flow__node')) return;

    const clientX = 'clientX' in event ? event.clientX : event.touches[0].clientX;
    const clientY = 'clientY' in event ? event.clientY : event.touches[0].clientY;

    showConnectionPopup({
      position: { x: clientX, y: clientY },
      nodeId: info.nodeId,
      handleId: info.handleId,
      handleType: info.handleType,
    });
  }, [showConnectionPopup]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      // Check for image file drops first
      const files = event.dataTransfer.files;
      if (files.length > 0) {
        const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          const reactFlowBounds = (event.target as HTMLElement)
            .closest('.react-flow')
            ?.getBoundingClientRect();
          if (!reactFlowBounds) return;

          imageFiles.forEach((file) => {
            // Upload then register the node in cli_graph so Claude's `nebula graph`
            // sees it with a short ID. graphSync will push it back to the canvas.
            // Position from the drop event is discarded — cli_graph export auto-lays-out.
            const formData = new FormData();
            formData.append('file', file);
            formData.append('create_node', 'true');
            fetch('http://localhost:8000/api/uploads', { method: 'POST', body: formData })
              .then((r) => r.json())
              .catch((err) => console.error('Upload/create failed:', err));
          });
          return;
        }
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

  // Keyboard shortcuts: Ctrl+Enter, Ctrl+S, Ctrl+O, Ctrl+A, Ctrl+D, Ctrl+Z, Ctrl+Shift+Z, Ctrl+C, Ctrl+V
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;

      // Don't capture shortcuts when user is typing in an input/textarea/select
      const tag = (event.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Ctrl+Enter — Run graph
      if (isCtrlOrCmd && event.key === 'Enter' && !isExecuting) {
        event.preventDefault();
        executeGraph();
        return;
      }

      // Ctrl+S — Save graph
      if (isCtrlOrCmd && event.key === 's') {
        event.preventDefault();
        // Dispatched as custom event — picked up by the save handler registered in Toolbar
        window.dispatchEvent(new CustomEvent('nebula:save'));
        return;
      }

      // Ctrl+O — Load graph
      if (isCtrlOrCmd && event.key === 'o') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('nebula:load'));
        return;
      }

      // Ctrl+A — Select all nodes
      if (isCtrlOrCmd && event.key === 'a') {
        event.preventDefault();
        useGraphStore.getState().selectAll();
        return;
      }

      // Ctrl+D — Duplicate selected nodes
      if (isCtrlOrCmd && event.key === 'd') {
        event.preventDefault();
        useGraphStore.getState().duplicateSelected();
        return;
      }

      // Ctrl+Z — Undo (must check before Ctrl+Shift+Z to avoid conflict)
      if (isCtrlOrCmd && !event.shiftKey && event.key === 'z') {
        event.preventDefault();
        useGraphStore.getState().undo();
        return;
      }

      // Ctrl+Shift+Z — Redo
      if (isCtrlOrCmd && event.shiftKey && event.key === 'z') {
        event.preventDefault();
        useGraphStore.getState().redo();
        return;
      }

      // Ctrl+C — Copy selected nodes
      if (isCtrlOrCmd && event.key === 'c') {
        event.preventDefault();
        useGraphStore.getState().copySelected();
        return;
      }

      // Ctrl+V — Paste
      if (isCtrlOrCmd && event.key === 'v') {
        event.preventDefault();
        useGraphStore.getState().pasteClipboard();
        return;
      }
    },
    [executeGraph, isExecuting]
  );

  return (
    <div
      className="canvas-wrapper"
      onKeyDown={onKeyDown}
      tabIndex={0}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        fitView
        minZoom={0.1}
        maxZoom={4}
        defaultEdgeOptions={{ type: 'typed-edge' }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode="Shift"
        selectionKeyCode={null}
        selectionOnDrag
        panOnScroll={false}
        selectionMode={1}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={32}
          size={1}
          color="rgba(255, 255, 255, 0.04)"
        />
      </ReactFlow>
      <ContextMenu />
      <ConnectionPopup />
    </div>
  );
}

import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';
import { useIsValidConnection } from '../hooks/useIsValidConnection';
import { ModelNode } from './nodes/ModelNode';
import { TypedEdge } from './edges/TypedEdge';
import { ContextMenu } from './ContextMenu';
import '../styles/canvas.css';

const nodeTypes: NodeTypes = {
  'model-node': ModelNode,
};

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

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const definitionId = event.dataTransfer.getData('application/nebula-node');
      if (!definitionId) return;

      const reactFlowBounds = (event.target as HTMLElement)
        .closest('.react-flow')
        ?.getBoundingClientRect();
      if (!reactFlowBounds) return;

      const position = {
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      };

      useGraphStore.getState().addNode(definitionId, position);
    },
    []
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
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

  // Keyboard shortcuts: Ctrl+Enter to run, Ctrl+S to save, Ctrl+O to load
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;

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
    },
    [executeGraph, isExecuting]
  );

  return (
    <div className="canvas-wrapper" onKeyDown={onKeyDown} tabIndex={0}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onDrop={onDrop}
        onDragOver={onDragOver}
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
    </div>
  );
}

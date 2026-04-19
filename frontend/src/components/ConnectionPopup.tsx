import { useState, useEffect, useRef, useMemo } from 'react';
import { useUIStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { isPortCompatible, PORT_COLORS } from '../lib/portCompatibility';
import { CATEGORY_COLORS } from '../constants/ports';
import type { PortDataType, ModelNodeDefinition } from '../types';

const CATEGORY_LABELS: Record<string, string> = {
  'image-gen': 'Image Generation',
  'video-gen': 'Video Generation',
  'text-gen': 'Text Generation',
  'audio-gen': 'Audio Generation',
  '3d-gen': '3D Generation',
  'transform': 'Transform',
  'analyzer': 'Analyzer',
  'utility': 'Utility',
  'universal': 'Universal',
};

interface CompatibleNode {
  definition: ModelNodeDefinition;
  matchingPortId: string;
  matchingPortLabel: string;
}

export function ConnectionPopup() {
  const { visible, position, nodeId, handleId, handleType } = useUIStore((s) => s.connectionPopup);
  const hideConnectionPopup = useUIStore((s) => s.hideConnectionPopup);
  const addNode = useGraphStore((s) => s.addNode);
  const onConnect = useGraphStore((s) => s.onConnect);
  const nodes = useGraphStore((s) => s.nodes);

  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Reset search and collapse everything each time the popup opens — otherwise
  // the user sees a wall of nodes from the last session and has to scroll.
  useEffect(() => {
    if (visible) {
      setSearch('');
      setExpanded({});
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [visible]);

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!visible) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideConnectionPopup();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        hideConnectionPopup();
      }
    }

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, hideConnectionPopup]);

  // Find the dragged port's data type
  const draggedPortType = useMemo((): PortDataType | null => {
    if (!visible || !nodeId || !handleId) return null;

    const sourceDef = Object.values(NODE_DEFINITIONS).find((def) => {
      const sourceNode = nodes.find((n) => n.id === nodeId);
      return sourceNode && (sourceNode.data as { definitionId: string }).definitionId === def.id;
    });

    if (!sourceDef) return null;

    if (handleType === 'source') {
      const port = sourceDef.outputPorts.find((p) => p.id === handleId);
      return port?.dataType ?? null;
    } else {
      const port = sourceDef.inputPorts.find((p) => p.id === handleId);
      return port?.dataType ?? null;
    }
  }, [visible, nodeId, handleId, handleType, nodes]);

  // Find all compatible nodes
  const compatibleNodes = useMemo((): CompatibleNode[] => {
    if (!draggedPortType) return [];

    const results: CompatibleNode[] = [];

    for (const def of Object.values(NODE_DEFINITIONS)) {
      // When dragging from an output, find nodes with compatible inputs
      if (handleType === 'source') {
        for (const port of def.inputPorts) {
          if (isPortCompatible(draggedPortType, port.dataType)) {
            results.push({ definition: def, matchingPortId: port.id, matchingPortLabel: port.label });
            break; // One match per node is enough
          }
        }
      } else {
        // When dragging from an input, find nodes with compatible outputs
        for (const port of def.outputPorts) {
          if (isPortCompatible(port.dataType, draggedPortType)) {
            results.push({ definition: def, matchingPortId: port.id, matchingPortLabel: port.label });
            break;
          }
        }
      }
    }

    return results;
  }, [draggedPortType, handleType]);

  // Filter by search and group by category
  const grouped = useMemo(() => {
    const lower = search.toLowerCase();
    const filtered = search.trim()
      ? compatibleNodes.filter((n) => n.definition.displayName.toLowerCase().includes(lower))
      : compatibleNodes;

    const groups: Record<string, CompatibleNode[]> = {};
    for (const node of filtered) {
      const cat = node.definition.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(node);
    }
    return groups;
  }, [compatibleNodes, search]);

  const handleSelect = (node: CompatibleNode) => {
    // Create the node at the popup position, offset to account for viewport
    const reactFlowBounds = document.querySelector('.react-flow')?.getBoundingClientRect();
    if (!reactFlowBounds) return;

    const nodePosition = {
      x: position.x - reactFlowBounds.left,
      y: position.y - reactFlowBounds.top,
    };

    addNode(node.definition.id, nodePosition);

    // Find the newly added node (last node in the list)
    const allNodes = useGraphStore.getState().nodes;
    const newNode = allNodes[allNodes.length - 1];

    if (newNode) {
      // Auto-connect: figure out which is source and which is target
      if (handleType === 'source') {
        onConnect({
          source: nodeId,
          sourceHandle: handleId,
          target: newNode.id,
          targetHandle: node.matchingPortId,
        });
      } else {
        onConnect({
          source: newNode.id,
          sourceHandle: node.matchingPortId,
          target: nodeId,
          targetHandle: handleId,
        });
      }
    }

    hideConnectionPopup();
  };

  if (!visible || !draggedPortType) return null;

  const totalCount = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div
      ref={menuRef}
      className="connection-popup"
      style={{ left: position.x, top: position.y }}
    >
      <div className="connection-popup__header">
        <span
          className="connection-popup__type-dot"
          style={{ backgroundColor: PORT_COLORS[draggedPortType] }}
        />
        <input
          ref={inputRef}
          className="connection-popup__search"
          type="text"
          placeholder={`Search ${compatibleNodes.length} compatible nodes...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          className="connection-popup__close"
          onClick={hideConnectionPopup}
          title="Close (Esc)"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="connection-popup__list">
        {totalCount === 0 && (
          <div className="connection-popup__empty">No compatible nodes found</div>
        )}
        {Object.entries(grouped).map(([category, nodes]) => {
          const isSearching = search.trim().length > 0;
          // While searching, always show matches. Otherwise start collapsed so
          // users see a scannable list of category headers, not a scroll wall.
          const isOpen = isSearching || (expanded[category] ?? false);
          return (
            <div key={category} className="connection-popup__category">
              <button
                type="button"
                className="connection-popup__category-label connection-popup__category-label--button"
                onClick={() =>
                  setExpanded((s) => ({ ...s, [category]: !(s[category] ?? false) }))
                }
              >
                <span className="connection-popup__category-chevron">{isOpen ? '\u25BE' : '\u25B8'}</span>
                <span className="connection-popup__category-text">
                  {CATEGORY_LABELS[category] ?? category}
                </span>
                <span className="connection-popup__category-count">{nodes.length}</span>
              </button>
              {isOpen && nodes.map((node) => (
                <button
                  key={node.definition.id}
                  className="connection-popup__item"
                  onClick={() => handleSelect(node)}
                >
                  <span
                    className="connection-popup__item-dot"
                    style={{ backgroundColor: CATEGORY_COLORS[node.definition.category] ?? '#424242' }}
                  />
                  <span className="connection-popup__item-name">{node.definition.displayName}</span>
                  <span className="connection-popup__item-port">{node.matchingPortLabel}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

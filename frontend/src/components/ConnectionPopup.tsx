import { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { PORT_COLORS } from '../lib/portCompatibility';
import { CATEGORY_COLORS } from '../constants/ports';
import type { PortDataType, ModelNodeDefinition } from '../types';
import { compatibleSteps, type NextStepIntent } from '../lib/canvasNextSteps';
import { getSettings } from '../lib/api';
import { readSettingsDraft } from '../store/settingsDraftStore';
import { getKreaConnection } from '../lib/kreaConnection';
import { matchesModelSearch } from '../lib/modelDiscovery';
import { ProviderReadinessBadge } from './ProviderReadinessBadge';
import { ScrollFade } from './ScrollFade';
import '../styles/canvas-next-steps.css';

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
  'moodboard': 'Moodboard',
};

interface CompatibleNode {
  definition: ModelNodeDefinition;
  matchingPortId: string;
  matchingPortLabel: string;
}

export function ConnectionPopup() {
  const popup = useUIStore((s) => s.connectionPopup);
  const { visible, position, nodeId, handleId, handleType, nextStep } = popup;
  const hideConnectionPopup = useUIStore((s) => s.hideConnectionPopup);
  const addNode = useGraphStore((s) => s.addNode);
  const addNodeAndConnect = useGraphStore((s) => s.addNodeAndConnect);
  const onConnect = useGraphStore((s) => s.onConnect);
  const nodes = useGraphStore((s) => s.nodes);
  const { screenToFlowPosition } = useReactFlow();

  const [search, setSearch] = useState('');
  const [intent, setIntent] = useState<NextStepIntent>('all');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [anchor, setAnchor] = useState(position);
  const busy = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const dismiss = () => {
    hideConnectionPopup();
    if (opener.current?.isConnected) opener.current.focus();
  };
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Reset search and collapse everything each time the popup opens — otherwise
  // the user sees a wall of nodes from the last session and has to scroll.
  useEffect(() => {
    if (!visible) return undefined;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timeoutId = window.setTimeout(() => {
      setSearch(''); setIntent('all'); setError('');
      setExpanded({});
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [visible, nodeId, handleId, nextStep]);

  // Read saved connection state, never run a credential check or generation.
  useEffect(() => {
    if (!visible || useUIStore.getState().settingsCache.loaded) return;
    let cancelled = false;
    void getSettings().then(async (settings) => {
      if (cancelled || useUIStore.getState().settingsCache.loaded) return;
      const saved = readSettingsDraft(settings);
      useUIStore.getState().setSettingsCache(saved.apiKeys, saved.kreaConnectionMode);
      if (saved.kreaConnectionMode === 'mcp') {
        const owningCache = useUIStore.getState().settingsCache;
        const connection = await getKreaConnection();
        if (!cancelled && useUIStore.getState().settingsCache === owningCache) {
          useUIStore.getState().setKreaConnection(connection);
        }
      }
    }).catch(() => { /* Unknown readiness remains visible with its setup action. */ });
    return () => { cancelled = true; };
  }, [visible]);

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!visible) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideConnectionPopup();
        if (opener.current?.isConnected) opener.current.focus();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        hideConnectionPopup();
        if (opener.current?.isConnected) opener.current.focus();
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

    return compatibleSteps(Object.values(NODE_DEFINITIONS), draggedPortType, handleType, intent);
  }, [draggedPortType, handleType, intent]);

  // Filter by search and group by category
  const grouped = useMemo(() => {
    const filtered = search.trim()
      ? compatibleNodes.filter((n) => matchesModelSearch(n.definition, search))
      : compatibleNodes;

    const groups: Record<string, CompatibleNode[]> = {};
    for (const node of filtered) {
      const cat = node.definition.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(node);
    }
    return groups;
  }, [compatibleNodes, search]);

  useLayoutEffect(() => {
    if (!visible) return;
    const measure = () => {
      const bounds = menuRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setAnchor({ x: Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8)),
        y: Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [visible, position]);

  const handleSelect = async (node: CompatibleNode) => {
    if (busy.current || useGraphStore.getState().isExecuting || useGraphStore.getState().isImportingGraph) return;
    const graph = useGraphStore.getState();
    const source = graph.nodes.find((item) => item.id === nodeId);
    if (!source || (nextStep && ((nextStep.sourceDefinitionId && source.data.definitionId !== nextStep.sourceDefinitionId)
      || source.data.state !== 'complete'
      || source.data.outputs[handleId]?.value !== nextStep.sourceValue))) {
      setError('This result changed. Close the picker and select the current result.'); return;
    }
    busy.current = true; setPending(true); setError('');
    let nodePosition = screenToFlowPosition(position);
    if (nextStep) {
      nodePosition = { x: source.position.x + (source.measured?.width ?? source.width ?? 300) + 100,
        y: source.position.y };
      while (graph.nodes.some((item) => Math.abs(item.position.x - nodePosition.x) < 320
        && Math.abs(item.position.y - nodePosition.y) < 320)) nodePosition.y += 340;
    }
    let newId: string | null = null;
    try {
      if (/^n\d+$/.test(nodeId)) {
        newId = await addNodeAndConnect(node.definition.id, nodePosition, {
          source: handleType === 'source' ? nodeId : '',
          sourceHandle: handleType === 'source' ? handleId : node.matchingPortId,
          target: handleType === 'source' ? '' : nodeId,
          targetHandle: handleType === 'source' ? node.matchingPortId : handleId,
          newNodeIs: handleType === 'source' ? 'target' : 'source',
        });
      } else {
        newId = await addNode(node.definition.id, nodePosition);
        if (newId) onConnect(handleType === 'source'
          ? { source: nodeId, sourceHandle: handleId, target: newId, targetHandle: node.matchingPortId }
          : { source: newId, sourceHandle: node.matchingPortId, target: nodeId, targetHandle: handleId });
        if (!useGraphStore.getState().edges.some((edge) => handleType === 'source'
          ? edge.source === nodeId && edge.target === newId && edge.targetHandle === node.matchingPortId
          : edge.source === newId && edge.target === nodeId && edge.sourceHandle === node.matchingPortId)) newId = null;
      }
      if (useUIStore.getState().connectionPopup !== popup) return;
      if (!newId) { setError('Could not confirm the connected step. Check the canvas before trying again.'); return; }
      hideConnectionPopup();
      if (nextStep) {
        const ui = useUIStore.getState();
        ui.requestCanvasNodeFocus(newId); ui.setLeftDock(null); ui.setInspectorVisible(true);
      }
    } catch {
      if (useUIStore.getState().connectionPopup === popup) setError('Could not add the step. Check the canvas before trying again.');
    } finally { busy.current = false; setPending(false); }
  };

  if (!visible || !draggedPortType) return null;

  const totalCount = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div
      ref={menuRef}
      className="connection-popup" role="dialog" aria-label={nextStep ? 'Add next step' : 'Compatible nodes'} aria-busy={pending}
      style={{ left: anchor.x, top: anchor.y }}
    >
      {nextStep && <div className="next-step-context"><strong>Add next step</strong>
        <span>From {nextStep.sourceLabel} · {draggedPortType}</span>
        <span>Prepare a connected node. Run when ready.</span></div>}
      <div className="connection-popup__header">
        <span
          className="connection-popup__type-dot"
          style={{ backgroundColor: PORT_COLORS[draggedPortType] }}
        />
        <input
          ref={inputRef}
          className="connection-popup__search"
          type="text" aria-label="Search compatible nodes"
          placeholder={`Search ${compatibleNodes.length} compatible nodes...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') dismiss();
            e.stopPropagation();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          className="panel__header-action connection-popup__close"
          onClick={dismiss}
          title="Close (Esc)"
          aria-label="Close"
        >
          <X
            className="connection-popup__close-icon"
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>
      {nextStep && draggedPortType === 'Image' && <div className="next-step-intents" aria-label="Next step type">
        {([['all', 'All compatible'], ['edit-image', 'Edit image'], ['image-to-video', 'Use in video']] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={intent === value} disabled={pending}
            onClick={() => { setIntent(value); setExpanded({}); }}>{label}</button>)}
      </div>}
      {pending && <div className="next-step-status" role="status">Adding connected step…</div>}
      {error && <div className="next-step-error" role="alert">{error}</div>}
      <ScrollFade className="connection-popup__list">
        {totalCount === 0 && (
          <div className="connection-popup__empty">No compatible nodes found</div>
        )}
        {Object.entries(grouped).map(([category, nodes]) => {
          const isSearching = search.trim().length > 0;
          // While searching, always show matches. Otherwise start collapsed so
          // users see a scannable list of category headers, not a scroll wall.
          const isOpen = isSearching || (expanded[category] ?? (intent !== 'all'));
          return (
            <div key={category} className="connection-popup__category">
              <button
                type="button"
                className="connection-popup__category-label connection-popup__category-label--button"
                onClick={() =>
                  setExpanded((s) => ({ ...s, [category]: !(s[category] ?? (intent !== 'all')) }))
                }
              >
                {isOpen ? (
                  <ChevronDown
                    className="connection-popup__category-chevron"
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    focusable="false"
                  />
                ) : (
                  <ChevronRight
                    className="connection-popup__category-chevron"
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden="true"
                    focusable="false"
                  />
                )}
                <span className="connection-popup__category-text">
                  {CATEGORY_LABELS[category] ?? category}
                </span>
                <span className="connection-popup__category-count">{nodes.length}</span>
              </button>
              {isOpen && nodes.map((node) => (
                <div key={node.definition.id} className="next-step-choice">
                <button type="button" disabled={pending}
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
                <ProviderReadinessBadge definition={node.definition} onSetup={hideConnectionPopup} />
                </div>
              ))}
            </div>
          );
        })}
      </ScrollFade>
    </div>
  );
}

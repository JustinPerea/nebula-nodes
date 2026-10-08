import { useMemo, useRef, useEffect, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow } from '@xyflow/react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { getNodesByCategory } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import { findAvailableNodePosition, type NodePosition } from '../../lib/nodePlacement';
import { CATEGORY_LABELS, matchesModelProvider, matchesModelSearch, modelInputSummary, providerLabel, supportedModelProviders } from '../../lib/modelDiscovery';
import { ProviderReadinessBadge } from '../ProviderReadinessBadge';
import '../../styles/panels.css';

// Initial collapsed state — all categories start collapsed on first render so
// the user sees a scannable list of category headers, not a long node wall.
const INITIAL_COLLAPSE_KEY = '__nebulaLibraryInit';
const SLAVA_DRAG_PREVIEW_OFFSET = 14;

export function NodeLibrary() {
  const visible = useUIStore((s) => s.panels.library.visible);
  const search = useUIStore((s) => s.librarySearch);
  const setSearch = useUIStore((s) => s.setLibrarySearch);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const skin = useUIStore((s) => s.skin);
  const addNode = useGraphStore((s) => s.addNode);
  const canvasNodes = useGraphStore((s) => s.nodes);
  const { screenToFlowPosition } = useReactFlow();
  const collapsed = useUIStore((s) => s.libraryCollapsed);
  const toggleCategory = useUIStore((s) => s.toggleLibraryCategory);
  const setAllLibraryCategories = useUIStore((s) => s.setAllLibraryCategories);
  const emptyDragImageRef = useRef<HTMLCanvasElement | null>(null);
  const reservedClickPositionsRef = useRef<NodePosition[]>([]);
  const [provider, setProvider] = useState('');
  const [dragPreview, setDragPreview] = useState<{
    label: string;
    category: string;
    x: number;
    y: number;
  } | null>(null);

  const grouped = useMemo(() => getNodesByCategory(), []);
  const providers = useMemo(() => [...new Set(Object.values(grouped).flat()
    .flatMap(supportedModelProviders))].sort((left, right) => providerLabel(left).localeCompare(providerLabel(right))), [grouped]);

  // Once graph-sync materializes a rapidly-added node, its real position
  // replaces the temporary reservation. Until then the reservation prevents
  // the next click/keyboard activation from stacking in the same slot.
  useEffect(() => {
    reservedClickPositionsRef.current = reservedClickPositionsRef.current.filter(
      (reserved) => !canvasNodes.some((node) => (
        Math.abs(node.position.x - reserved.x) < 1
        && Math.abs(node.position.y - reserved.y) < 1
      )),
    );
  }, [canvasNodes]);

  // Collapse all categories on first mount if we haven't initialized yet.
  useEffect(() => {
    if (!collapsed[INITIAL_COLLAPSE_KEY]) {
      const all = Object.keys(grouped);
      setAllLibraryCategories(true, [...all, INITIAL_COLLAPSE_KEY]);
    }
  }, [collapsed, grouped, setAllLibraryCategories]);

  const filtered = useMemo(() => {
    const result: typeof grouped = {};
    for (const [cat, defs] of Object.entries(grouped)) {
      const matches = defs.filter((definition) => matchesModelProvider(definition, provider)
        && matchesModelSearch(definition, search));
      if (matches.length > 0) result[cat] = matches;
    }
    return result;
  }, [grouped, search, provider]);
  const resultCount = Object.values(filtered).reduce((count, definitions) => count + definitions.length, 0);

  useEffect(() => {
    if (skin !== 'slava-restraint') {
      const timeoutId = window.setTimeout(() => setDragPreview(null), 0);
      return () => window.clearTimeout(timeoutId);
    }

    function clearDragPreview() {
      setDragPreview(null);
    }

    function onWindowDragOver(e: globalThis.DragEvent) {
      if (e.clientX === 0 && e.clientY === 0) return;
      setDragPreview((current) => (
        current ? { ...current, x: e.clientX, y: e.clientY } : current
      ));
    }

    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('dragend', clearDragPreview);
    window.addEventListener('drop', clearDragPreview);
    return () => {
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('dragend', clearDragPreview);
      window.removeEventListener('drop', clearDragPreview);
    };
  }, [skin]);

  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);
  if (!shouldRender) return null;

  function getEmptyDragImage() {
    if (!emptyDragImageRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      emptyDragImageRef.current = canvas;
    }
    return emptyDragImageRef.current;
  }

  function onDragStart(
    e: ReactDragEvent<HTMLButtonElement>,
    definitionId: string,
    label: string,
    category: string,
  ) {
    e.dataTransfer.setData('application/nebula-node', definitionId);
    e.dataTransfer.effectAllowed = 'move';
    if (skin !== 'slava-restraint') return;

    e.dataTransfer.setDragImage(getEmptyDragImage(), 0, 0);
    setDragPreview({ label, category, x: e.clientX, y: e.clientY });
  }

  function onDrag(e: ReactDragEvent<HTMLButtonElement>) {
    if (skin !== 'slava-restraint' || (e.clientX === 0 && e.clientY === 0)) return;
    setDragPreview((current) => (
      current ? { ...current, x: e.clientX, y: e.clientY } : current
    ));
  }

  function onDragEnd() {
    setDragPreview(null);
  }

  function addNodeAtViewportCenter(definitionId: string) {
    const preferred = screenToFlowPosition({
      x: typeof window !== 'undefined' ? window.innerWidth / 2 : 640,
      y: typeof window !== 'undefined' ? window.innerHeight / 2 : 360,
    });
    const position = findAvailableNodePosition(
      preferred,
      [
        ...useGraphStore.getState().nodes.map((node) => node.position),
        ...reservedClickPositionsRef.current,
      ],
    );
    reservedClickPositionsRef.current.push(position);
    void addNode(definitionId, position);
  }

  const dragPreviewStyle = dragPreview ? ({
    '--category-color': CATEGORY_COLORS[dragPreview.category] ?? 'var(--sr-accent)',
    '--drag-x': `${dragPreview.x + SLAVA_DRAG_PREVIEW_OFFSET}px`,
    '--drag-y': `${dragPreview.y + SLAVA_DRAG_PREVIEW_OFFSET}px`,
  } as CSSProperties) : undefined;

  return (
    <div
      className={`panel panel--library workspace-dock-panel${exiting ? ' panel--exiting' : ''}`}
    >
      <div className="panel__header">
        <span className="panel__title">Nodes</span>
        <button
          type="button"
          className="panel__header-action panel__close"
          onClick={() => togglePanel('library')}
          aria-label="Close nodes panel"
          title="Close"
        >
          <X
            className="panel__close-icon"
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>

      <div className="panel__body panel__body--library">
        <div className="node-library__filters">
          <input
            className="panel__search"
            type="text"
            placeholder="Search names, providers or tasks…"
            aria-label="Search nodes"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="node-library__provider">Provider
            <select aria-label="Node provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">All providers</option>
              {providers.map((item) => <option key={item} value={item}>{providerLabel(item)}</option>)}
            </select>
          </label>
          <p className="node-library__count">{resultCount} node{resultCount === 1 ? '' : 's'} · Browse before connecting</p>
        </div>
        <div className="node-library__browser">
          {resultCount === 0 && <div className="node-library__empty">
            <p role="status">No nodes match{search.trim() ? ` “${search.trim()}”` : ''}{provider ? ` from ${providerLabel(provider)}` : ''}.</p>
            <button type="button" onClick={() => { setSearch(''); setProvider(''); }}>Clear filters</button>
            <span>Try a task or media type:</span>
            <div className="node-library__suggestions">
              {['Animate a logo', 'Image', 'Audio', '3D'].map((suggestion) => <button key={suggestion} type="button"
                onClick={() => { setSearch(suggestion); setProvider(''); }}>{suggestion}</button>)}
            </div>
          </div>}

          {Object.entries(filtered).map(([category, defs]) => {
            // Active filters expand matching categories so results are visible.
            const isSearching = search.trim().length > 0 || provider.length > 0;
            const isCollapsed = !isSearching && (collapsed[category] ?? true);
            const items = defs.map((def) => (
              <div key={def.id} className="node-library__entry">
                <button
                  type="button"
                  className="panel__item"
                  draggable
                  tabIndex={isCollapsed ? -1 : 0}
                  onDragStart={(e) => onDragStart(e, def.id, def.displayName, category)}
                  onDrag={onDrag}
                  onDragEnd={onDragEnd}
                  onClick={(event) => {
                    // A double-click dispatches two click events. The first one adds the
                    // node; ignore the follow-up so a legacy double-click gesture does
                    // not create an accidental duplicate.
                    if (event.detail > 1) return;
                    addNodeAtViewportCenter(def.id);
                  }}
                  title={`Add ${def.displayName} to the center of the canvas`}
                  aria-label={def.displayName}
                  aria-describedby={`node-library-${def.id}-summary`}
                >
                  <span className="node-library__name">{def.displayName}</span>
                  <span className="node-library__metadata">{providerLabel(def.apiProvider)}</span>
                  <span className="node-library__inputs" id={`node-library-${def.id}-summary`}>{modelInputSummary(def)}</span>
                </button>
                {!isCollapsed && <ProviderReadinessBadge definition={def} />}
              </div>
            ));
            return (
              <div
                key={category}
                className="panel__group"
                style={{ ['--category-color' as string]: CATEGORY_COLORS[category] }}
              >
                <button
                  className="panel__group-label panel__group-label--button"
                  onClick={() => toggleCategory(category)}
                  type="button"
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? (
                    <ChevronRight
                      className="panel__group-chevron"
                      size={12}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      focusable="false"
                    />
                  ) : (
                    <ChevronDown
                      className="panel__group-chevron"
                      size={12}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      focusable="false"
                    />
                  )}
                  <span
                    className="panel__group-dot"
                    style={{ backgroundColor: CATEGORY_COLORS[category] }}
                  />
                  <span className="panel__group-text">{CATEGORY_LABELS[defs[0].category]}</span>
                  <span className="panel__group-count">{defs.length}</span>
                </button>
                {skin === 'slava-restraint' ? (
                  <div
                    className={`panel__items ${isCollapsed ? 'panel__items--collapsed' : 'panel__items--expanded'}`}
                    aria-hidden={isCollapsed}
                  >
                    <div className="panel__items-inner">
                      {items}
                    </div>
                  </div>
                ) : (
                  !isCollapsed && items
                )}
              </div>
            );
          })}
        </div>
      </div>
      {skin === 'slava-restraint' && dragPreview && dragPreviewStyle && createPortal(
        <div className="slava-library-drag-preview" style={dragPreviewStyle}>
          <span className="slava-library-drag-preview__dot" />
          <span className="slava-library-drag-preview__label">{dragPreview.label}</span>
        </div>,
        document.body,
      )}
    </div>
  );
}

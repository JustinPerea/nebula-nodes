import { useMemo, useRef, useEffect, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { getNodesByCategory } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import '../../styles/panels.css';

// Initial collapsed state — all categories start collapsed on first render so
// the user sees a scannable list of category headers, not a long node wall.
const INITIAL_COLLAPSE_KEY = '__nebulaLibraryInit';
const SLAVA_DRAG_PREVIEW_OFFSET = 14;

const CATEGORY_LABELS: Record<string, string> = {
  'image-gen': 'Image Generation',
  'video-gen': 'Video Generation',
  'text-gen': 'Text Generation',
  'audio-gen': 'Audio Generation',
  'transform': 'Transform',
  'analyzer': 'Analyzer',
  'utility': 'Utility',
  'universal': 'Universal',
  'cinematic': 'Cinematic',
  'character': 'Character',
};

export function NodeLibrary() {
  const visible = useUIStore((s) => s.panels.library.visible);
  const position = useUIStore((s) => s.panels.library.position);
  const search = useUIStore((s) => s.librarySearch);
  const setSearch = useUIStore((s) => s.setLibrarySearch);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const skin = useUIStore((s) => s.skin);
  const addNode = useGraphStore((s) => s.addNode);
  const collapsed = useUIStore((s) => s.libraryCollapsed);
  const toggleCategory = useUIStore((s) => s.toggleLibraryCategory);
  const setAllLibraryCategories = useUIStore((s) => s.setAllLibraryCategories);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const emptyDragImageRef = useRef<HTMLCanvasElement | null>(null);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);
  const [dragPreview, setDragPreview] = useState<{
    label: string;
    category: string;
    x: number;
    y: number;
  } | null>(null);

  const grouped = useMemo(() => getNodesByCategory(), []);

  // Collapse all categories on first mount if we haven't initialized yet.
  useEffect(() => {
    if (!collapsed[INITIAL_COLLAPSE_KEY]) {
      const all = Object.keys(grouped);
      setAllLibraryCategories(true, [...all, INITIAL_COLLAPSE_KEY]);
    }
  }, [collapsed, grouped, setAllLibraryCategories]);

  const filtered = useMemo(() => {
    if (!search.trim()) return grouped;
    const lower = search.toLowerCase();
    const result: typeof grouped = {};
    for (const [cat, defs] of Object.entries(grouped)) {
      const matches = defs.filter((d) => d.displayName.toLowerCase().includes(lower));
      if (matches.length > 0) result[cat] = matches;
    }
    return result;
  }, [grouped, search]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPanelPosition('library', {
        x: dragRef.current.panelX + dx,
        y: dragRef.current.panelY + dy,
      });
    }
    function onMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setPanelPosition]);

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
    e: ReactDragEvent<HTMLDivElement>,
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

  function onDrag(e: ReactDragEvent<HTMLDivElement>) {
    if (skin !== 'slava-restraint' || (e.clientX === 0 && e.clientY === 0)) return;
    setDragPreview((current) => (
      current ? { ...current, x: e.clientX, y: e.clientY } : current
    ));
  }

  function onDragEnd() {
    setDragPreview(null);
  }

  function onDoubleClick(definitionId: string) {
    addNode(definitionId, { x: 400, y: 300 });
  }

  const dragPreviewStyle = dragPreview ? ({
    '--category-color': CATEGORY_COLORS[dragPreview.category] ?? 'var(--sr-accent)',
    '--drag-x': `${dragPreview.x + SLAVA_DRAG_PREVIEW_OFFSET}px`,
    '--drag-y': `${dragPreview.y + SLAVA_DRAG_PREVIEW_OFFSET}px`,
  } as CSSProperties) : undefined;

  return (
    <div
      className={`panel panel--library${exiting ? ' panel--exiting' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="panel__header"
        onMouseDown={(e) => {
          dragRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            panelX: position.x,
            panelY: position.y,
          };
        }}
      >
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
        <div className="node-library__browser">
          <input
            className="panel__search"
            type="text"
            placeholder="Search nodes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {Object.entries(filtered).map(([category, defs]) => {
            // When searching, always expand matching categories so results are visible.
            const isSearching = search.trim().length > 0;
            const isCollapsed = !isSearching && (collapsed[category] ?? true);
            const items = defs.map((def) => (
              <div
                key={def.id}
                className="panel__item"
                draggable
                onDragStart={(e) => onDragStart(e, def.id, def.displayName, category)}
                onDrag={onDrag}
                onDragEnd={onDragEnd}
                onDoubleClick={() => onDoubleClick(def.id)}
              >
                {def.displayName}
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
                  <span className="panel__group-text">{CATEGORY_LABELS[category] ?? category}</span>
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

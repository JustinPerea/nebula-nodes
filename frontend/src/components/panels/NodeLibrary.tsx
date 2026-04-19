import { useMemo, useRef, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { getNodesByCategory } from '../../constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../../constants/ports';
import '../../styles/panels.css';

// Initial collapsed state — all categories start collapsed on first render so
// the user sees a scannable list of category headers, not a long node wall.
const INITIAL_COLLAPSE_KEY = '__nebulaLibraryInit';

const CATEGORY_LABELS: Record<string, string> = {
  'image-gen': 'Image Generation',
  'video-gen': 'Video Generation',
  'text-gen': 'Text Generation',
  'audio-gen': 'Audio Generation',
  'transform': 'Transform',
  'analyzer': 'Analyzer',
  'utility': 'Utility',
  'universal': 'Universal',
};

export function NodeLibrary() {
  const visible = useUIStore((s) => s.panels.library.visible);
  const position = useUIStore((s) => s.panels.library.position);
  const search = useUIStore((s) => s.librarySearch);
  const setSearch = useUIStore((s) => s.setLibrarySearch);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const addNode = useGraphStore((s) => s.addNode);
  const collapsed = useUIStore((s) => s.libraryCollapsed);
  const toggleCategory = useUIStore((s) => s.toggleLibraryCategory);
  const setAllLibraryCategories = useUIStore((s) => s.setAllLibraryCategories);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const setPanelPosition = useUIStore((s) => s.setPanelPosition);

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

  if (!visible) return null;

  function onDragStart(e: React.DragEvent, definitionId: string) {
    e.dataTransfer.setData('application/nebula-node', definitionId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDoubleClick(definitionId: string) {
    addNode(definitionId, { x: 400, y: 300 });
  }

  return (
    <div
      className="panel"
      style={{ left: position.x, top: position.y, width: 220 }}
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
        <button className="panel__close" onClick={() => togglePanel('library')}>
          ×
        </button>
      </div>

      <div className="panel__body">
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
          return (
            <div key={category} className="panel__group">
              <button
                className="panel__group-label panel__group-label--button"
                onClick={() => toggleCategory(category)}
                type="button"
              >
                <span className="panel__group-chevron">{isCollapsed ? '\u25B8' : '\u25BE'}</span>
                <span
                  className="panel__group-dot"
                  style={{ backgroundColor: CATEGORY_COLORS[category] }}
                />
                <span className="panel__group-text">{CATEGORY_LABELS[category] ?? category}</span>
                <span className="panel__group-count">{defs.length}</span>
              </button>
              {!isCollapsed && defs.map((def) => (
                <div
                  key={def.id}
                  className="panel__item"
                  draggable
                  onDragStart={(e) => onDragStart(e, def.id)}
                  onDoubleClick={() => onDoubleClick(def.id)}
                >
                  {def.displayName}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { captureProjectSnapshot, useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { floatingBottomLimit, floatingTopLimit } from '../../lib/bottomBar';
import { listedRowCount, projectSizeBreakdown, rowSize, type ProjectSizeRow } from '../../lib/projectSize';
import {
  DOWNLOAD_A_COPY, LARGEST_FIRST, PART_LABELS, ROW_NAMES, SAVING_PAUSED, panelLine, smallerLine,
} from '../../lib/savePausedCopy';
import './ProjectSizePanel.css';

/** The Inspector's gutter (NodeInspectorPopover VIEWPORT_GUTTER). */
const GUTTER = 16;
const WIDTH = 340;

/** One row as the panel shows it: no ids (GM), the name the canvas shows. */
interface ShownRow {
  key: string;
  name: string;
  /** A dimmer type, for a node whose name another node shares. */
  type: string | null;
  part: string;
  size: string;
  nodeId: string | null;
  opensHistory: boolean;
}

const typeName = (definitionId: string | null) =>
  (definitionId && NODE_DEFINITIONS[definitionId]?.displayName) || definitionId || 'Node';

function shownRows(rows: ProjectSizeRow[]): ShownRow[] {
  const names = new Map<string, number>();
  const nameOf = (row: Extract<ProjectSizeRow, { kind: 'node' }>) => (row.label?.trim() ? row.label : typeName(row.definitionId));
  for (const row of rows) if (row.kind === 'node') names.set(nameOf(row), (names.get(nameOf(row)) ?? 0) + 1);
  return rows.map((row, index) => {
    if (row.kind === 'node') {
      const name = nameOf(row);
      return { key: `node:${row.nodeId}`, name, type: (names.get(name) ?? 0) > 1 ? typeName(row.definitionId) : null,
        part: PART_LABELS[row.part], size: rowSize(row.bytes), nodeId: row.nodeId, opensHistory: false };
    }
    const part = row.kind === 'runHistory' ? `${row.count} ${row.count === 1 ? 'run' : 'runs'}`
      : row.kind === 'wires' ? `${row.count} ${row.count === 1 ? 'wire' : 'wires'}` : '';
    return { key: `${row.kind}:${index}`, name: ROW_NAMES[row.kind], type: null, part, size: rowSize(row.bytes),
      nodeId: null, opensHistory: row.kind === 'runHistory' };
  });
}

function frameStyle(): CSSProperties {
  const top = floatingTopLimit(GUTTER);
  const width = Math.min(WIDTH, window.innerWidth - GUTTER * 2);
  const left = window.innerWidth - GUTTER - width;
  const bottom = floatingBottomLimit(GUTTER, window.innerHeight, { left, right: left + width });
  return { top, left, width, maxHeight: Math.max(160, bottom - top) };
}

/**
 * The "what's large" panel for a project over the save limit (Q118, GM -
 * Design's layout): a floating panel within the Inspector's top and bottom
 * lines, opened from the header's "Saving paused · {size} MB" or the notice's
 * "See what's large". The heading, the live line, "Download a copy", then
 * "Largest first" and the largest rows (0.1 MB and up, at most ten): a node's name as the canvas shows
 * it (its title, else its type), a dimmer part, its size right-aligned. A
 * node row selects the node and pans to it; Run history opens its panel.
 * The rows come from this tab's own snapshot (a paused tab's edits aren't on
 * the backend), measured as the backend measures (lib/projectSize). Esc
 * closes it, and focus goes back where it came from.
 */
export function ProjectSizePanel() {
  const open = useProjectStore((state) => state.sizePanelOpen && state.screen === 'workspace');
  const bytes = useProjectStore((state) => state.savePaused?.bytes ?? null);
  if (!open || bytes === null) return null;
  return <SizePanel bytes={bytes} />;
}

function SizePanel({ bytes }: { bytes: number }) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>(() => frameStyle());
  // Measured again whenever the size changes (each change is measured as
  // autosave would, debounced), so the rows follow what is removed.
  const { top, restCount, restBytes } = useMemo(() => {
    void bytes;
    const { rows } = projectSizeBreakdown(captureProjectSnapshot());
    const listed = listedRowCount(rows);
    const rest = rows.slice(listed);
    return { top: shownRows(rows).slice(0, listed), restCount: rest.length,
      restBytes: rest.reduce((sum, row) => sum + row.bytes, 0) };
  }, [bytes]);

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      const back = opener?.isConnected ? opener : document.querySelector<HTMLElement>('[data-size-status]');
      back?.focus();
    };
  }, []);
  useEffect(() => {
    const place = () => setStyle(frameStyle());
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);

  const close = () => useProjectStore.getState().closeSizePanel();
  const choose = (row: ShownRow) => {
    if (row.nodeId) useUIStore.getState().requestCanvasNodeFocus(row.nodeId);
    else if (row.opensHistory) useUIStore.getState().setLeftDock('history');
  };

  return createPortal(
    <div ref={panel} className="project-size-panel" role="dialog" aria-labelledby="project-size-panel-heading"
      tabIndex={-1} style={style}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}>
      <div className="project-size-panel__header">
        <h2 id="project-size-panel-heading" className="project-size-panel__heading">{SAVING_PAUSED}</h2>
        <button type="button" className="project-size-panel__close" aria-label="Close" onClick={close}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="project-size-panel__line" aria-live="polite">{panelLine(bytes)}</p>
      <button type="button" className="project-size-panel__download"
        onClick={() => void useProjectStore.getState().downloadProjectCopy()}>{DOWNLOAD_A_COPY}</button>
      <p className="project-size-panel__label">{LARGEST_FIRST}</p>
      <ul className="project-size-panel__rows">
        {top.map((row) => {
          const body = (
            <>
              <span className="project-size-panel__name">{row.name}</span>
              {row.type && <span className="project-size-panel__dim" data-size-type="">{row.type}</span>}
              {row.part && <span className="project-size-panel__dim project-size-panel__part">{row.part}</span>}
              <span className="project-size-panel__size">{row.size} MB</span>
            </>
          );
          return (
            <li key={row.key} data-size-row="">
              {row.nodeId || row.opensHistory
                ? <button type="button" className="project-size-panel__row" onClick={() => choose(row)}>{body}</button>
                : <div className="project-size-panel__row project-size-panel__row--static">{body}</div>}
            </li>
          );
        })}
      </ul>
      {restCount > 0 && <p className="project-size-panel__rest">{smallerLine(restCount, rowSize(restBytes))}</p>}
    </div>,
    document.body,
  );
}

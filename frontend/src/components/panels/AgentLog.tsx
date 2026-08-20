import { useEffect, useRef, useState } from 'react';
import { Activity, ChevronUp } from 'lucide-react';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import {
  normalizeAgentEventSource,
  type AgentEventSource,
} from '../../lib/agentEvents';

interface LogEntry {
  id: string;
  ts: number;
  source: AgentEventSource;
  message: string;
}

interface Position {
  left: number;
  top: number;
  anchorX?: 'left' | 'right';
  anchorY?: 'top' | 'bottom';
  offsetX?: number;
  offsetY?: number;
}

const POS_STORAGE_KEY = 'nebula:agentLog:pos';
// User has to drag this many px before we treat the gesture as a drag and
// suppress the toggle click. Keeps single-click-to-collapse intact.
const DRAG_THRESHOLD = 4;
const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 40;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function positionFromGeometry(
  left: number,
  top: number,
  width: number,
  height: number,
  preferredAnchorX?: Position['anchorX'],
  preferredAnchorY?: Position['anchorY'],
): Position {
  const right = window.innerWidth - left - width;
  const bottom = window.innerHeight - top - height;
  const anchorX = preferredAnchorX ?? (left <= right ? 'left' : 'right');
  const anchorY = preferredAnchorY ?? (top <= bottom ? 'top' : 'bottom');

  return {
    left,
    top,
    anchorX,
    anchorY,
    offsetX: anchorX === 'left' ? left : right,
    offsetY: anchorY === 'top' ? top : bottom,
  };
}

function resolvePositionForViewport(position: Position, width: number, height: number): Position {
  const anchorX = position.anchorX ?? (position.left <= window.innerWidth - position.left - width ? 'left' : 'right');
  const anchorY = position.anchorY ?? (position.top <= window.innerHeight - position.top - height ? 'top' : 'bottom');
  const offsetX = position.offsetX ?? (anchorX === 'left' ? position.left : window.innerWidth - position.left - width);
  const offsetY = position.offsetY ?? (anchorY === 'top' ? position.top : window.innerHeight - position.top - height);
  const rawLeft = anchorX === 'left' ? offsetX : window.innerWidth - width - offsetX;
  const rawTop = anchorY === 'top' ? offsetY : window.innerHeight - height - offsetY;
  const left = clamp(rawLeft, 0, Math.max(0, window.innerWidth - width));
  const top = clamp(rawTop, 0, Math.max(0, window.innerHeight - height));

  return positionFromGeometry(left, top, width, height, anchorX, anchorY);
}

function samePosition(a: Position, b: Position) {
  return a.left === b.left
    && a.top === b.top
    && a.anchorX === b.anchorX
    && a.anchorY === b.anchorY
    && a.offsetX === b.offsetX
    && a.offsetY === b.offsetY;
}

function readInitialPosition(): Position | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(POS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Position;
    if (typeof parsed.left === 'number' && typeof parsed.top === 'number') {
      return {
        left: parsed.left,
        top: parsed.top,
        anchorX: parsed.anchorX === 'left' || parsed.anchorX === 'right' ? parsed.anchorX : undefined,
        anchorY: parsed.anchorY === 'top' || parsed.anchorY === 'bottom' ? parsed.anchorY : undefined,
        offsetX: typeof parsed.offsetX === 'number' ? parsed.offsetX : undefined,
        offsetY: typeof parsed.offsetY === 'number' ? parsed.offsetY : undefined,
      };
    }
  } catch {
    // bad JSON — fall through
  }
  return null;
}

function persistPosition(p: Position) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

function clearPersistedPosition() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(POS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function AgentLog() {
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);
  const enabled = useUIStore((s) => s.agentLogEnabled);
  const chatVisible = useUIStore((s) => s.panels.chat.visible);
  const visible = enabled && chatVisible;

  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [position, setPosition] = useState<Position | null>(readInitialPosition);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Drag bookkeeping refs (so we don't re-render mid-drag)
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    width: number;
    height: number;
    moved: boolean;
  } | null>(null);
  // Set true on mouseup if a drag actually happened, so the click event that
  // fires immediately after on the inner toggle button can be swallowed
  // before reverting to false.
  const justDraggedRef = useRef(false);

  // Toolbar Reset button broadcasts this event so we drop our drag position
  // and the panel snaps back to the CSS-driven default anchor.
  useEffect(() => {
    function handleReset() {
      clearPersistedPosition();
      setPosition(null);
    }
    window.addEventListener('nebula:layout-reset', handleReset);
    return () => window.removeEventListener('nebula:layout-reset', handleReset);
  }, []);

  // Older stored positions only have left/top. Once the element is mounted,
  // infer the nearest viewport edges so future window resizes preserve the
  // user's intended anchor instead of freezing absolute pixels.
  useEffect(() => {
    if (!enabled || !position || (position.anchorX && position.anchorY)) return;
    const frameId = window.requestAnimationFrame(() => {
      const rect = logRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = positionFromGeometry(rect.left, rect.top, rect.width, rect.height);
      setPosition((current) => {
        if (!current || (current.anchorX && current.anchorY)) return current;
        persistPosition(next);
        return next;
      });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [enabled, position]);

  useEffect(() => {
    function handleResize() {
      setPosition((current) => {
        if (!current) return current;
        const rect = logRef.current?.getBoundingClientRect();
        const width = rect?.width ?? MIN_VISIBLE_WIDTH;
        const height = rect?.height ?? MIN_VISIBLE_HEIGHT;
        const next = resolvePositionForViewport(current, width, height);
        if (samePosition(current, next)) return current;
        persistPosition(next);
        return next;
      });
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Mirror visibility/open-state onto <body> so layouts.css only reserves
  // space while the chat dock is actually open.
  useEffect(() => {
    document.body.classList.toggle('agent-log-enabled', visible);
    document.body.classList.toggle('agent-log-open', visible && open);
    document.body.classList.toggle('agent-log-empty', visible && open && entries.length === 0);
    return () => {
      document.body.classList.remove('agent-log-enabled', 'agent-log-open', 'agent-log-empty');
    };
  }, [visible, open, entries.length]);

  // Sample graph executions as a placeholder feed.
  useEffect(() => {
    if (!isExecuting) return;
    const timeoutId = window.setTimeout(() => {
      setEntries((prev) => [
        ...prev.slice(-49),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          ts: Date.now(),
          source: 'graph',
          message: `Running graph (${nodeCount} node${nodeCount === 1 ? '' : 's'})…`,
        },
      ]);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [isExecuting, nodeCount]);

  // Subscribe to nebula:agent-log-entry events so any component can stream
  // entries into this log without coupling. ChatPanel dispatches these
  // for Daedalus thinking lines so they live here instead of in chat.
  useEffect(() => {
    function handleEntry(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { source?: unknown; message?: string }
        | undefined;
      if (!detail) return;
      const msg = String(detail.message ?? '').trim();
      if (!msg) return;
      setEntries((prev) => [
        ...prev.slice(-49),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          ts: Date.now(),
          source: normalizeAgentEventSource(detail.source),
          message: msg,
        },
      ]);
    }
    window.addEventListener('nebula:agent-log-entry', handleEntry);
    return () => window.removeEventListener('nebula:agent-log-entry', handleEntry);
  }, []);

  function handleHeaderMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    // Ignore right-click. Allow drag to start anywhere on the row — the
    // click handler later checks justDraggedRef to decide whether to fire.
    if (e.button !== 0) return;

    const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    };

    function onMove(ev: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      const left = clamp(d.originLeft + dx, 0, Math.max(0, window.innerWidth - d.width));
      const top = clamp(d.originTop + dy, 0, Math.max(0, window.innerHeight - d.height));
      const next = positionFromGeometry(left, top, d.width, d.height);
      setPosition(next);
      persistPosition(next);
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const d = dragRef.current;
      if (d?.moved) {
        // Tell the click handler that fires next to bail out.
        justDraggedRef.current = true;
      }
      dragRef.current = null;
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handleToggleClick() {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    setOpen((current) => !current);
  }

  // Persist position on the latest setPosition that happened during the drag —
  // we attach to the up-handler via closure so this effect handles late writes.
  useEffect(() => {
    if (!position) return;
    persistPosition(position);
  }, [position]);

  const containerStyle: React.CSSProperties = position
    ? { left: position.left, top: position.top, bottom: 'auto' }
    : {};
  const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const statusLabel = isExecuting ? 'streaming' : latestEntry ? latestEntry.source : 'standby';
  const countLabel = `${entries.length} event${entries.length === 1 ? '' : 's'}`;

  if (!visible) return null;

  return (
    <div
      ref={logRef}
      className={
        'agent-log'
        + (open ? ' agent-log--open' : '')
        + (entries.length === 0 ? ' agent-log--empty' : '')
        + (isExecuting ? ' agent-log--executing' : '')
      }
      style={containerStyle}
      data-status={statusLabel}
    >
      <div
        className="agent-log__drag-row"
        onMouseDown={handleHeaderMouseDown}
        title="Drag to move"
      >
        <button
          type="button"
          className="agent-log__header"
          onClick={handleToggleClick}
          title={open ? 'Collapse agent log' : 'Expand agent log'}
          aria-expanded={open}
        >
          <span className="agent-log__title">
            <Activity
              className="agent-log__icon"
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
              focusable="false"
            />
            Agent log
          </span>
          <span className="agent-log__telemetry" aria-hidden="true">
            <span className="agent-log__signal">
              <span className="agent-log__signal-cell" />
              <span className="agent-log__signal-cell" />
              <span className="agent-log__signal-cell" />
              <span className="agent-log__signal-cell" />
            </span>
            <span className="agent-log__count">{countLabel}</span>
            <span className="agent-log__status">{statusLabel}</span>
          </span>
          <ChevronUp
            className={'agent-log__chevron' + (open ? ' agent-log__chevron--open' : '')}
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>
      {open && (
        <div className="agent-log__body">
          {entries.length === 0 ? (
            <div className="agent-log__empty">
              <span className="agent-log__empty-grid" aria-hidden="true" />
              <span className="agent-log__empty-title">No events yet</span>
              <span className="agent-log__empty-status">standby</span>
            </div>
          ) : (
            <ul className="agent-log__list" aria-live="polite">
              {entries.slice().reverse().map((e) => (
                <li key={e.id} className={`agent-log__entry agent-log__entry--${e.source}`} data-source={e.source}>
                  <span className="agent-log__entry-marker" aria-hidden="true" />
                  <span className="agent-log__time">
                    {new Date(e.ts).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span className="agent-log__source">{e.source}</span>
                  <span className="agent-log__msg">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

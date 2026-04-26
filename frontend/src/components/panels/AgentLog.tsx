import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '../../store/graphStore';

interface LogEntry {
  id: string;
  ts: number;
  source: 'graph' | 'hermes' | 'system';
  message: string;
}

interface Position {
  left: number;
  top: number;
}

const OPEN_STORAGE_KEY = 'nebula:agentLog:open';
const POS_STORAGE_KEY = 'nebula:agentLog:pos';
// User has to drag this many px before we treat the gesture as a drag and
// suppress the toggle click. Keeps single-click-to-collapse intact.
const DRAG_THRESHOLD = 4;

function readInitialOpen(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(OPEN_STORAGE_KEY) === '1';
}

function readInitialPosition(): Position | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(POS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Position;
    if (typeof parsed.left === 'number' && typeof parsed.top === 'number') {
      return parsed;
    }
  } catch {
    // bad JSON — fall through
  }
  return null;
}

export function AgentLog() {
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const nodeCount = useGraphStore((s) => s.nodes.length);

  const [open, setOpen] = useState<boolean>(readInitialOpen);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [position, setPosition] = useState<Position | null>(readInitialPosition);

  // Drag bookkeeping refs (so we don't re-render mid-drag)
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
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
      setPosition(null);
    }
    window.addEventListener('nebula:layout-reset', handleReset);
    return () => window.removeEventListener('nebula:layout-reset', handleReset);
  }, []);

  // Mirror open-state onto <body> so layouts.css can shrink the chat
  // panel's bottom reservation when the agent log is collapsed.
  useEffect(() => {
    document.body.classList.toggle('agent-log-open', open);
    return () => {
      document.body.classList.remove('agent-log-open');
    };
  }, [open]);

  // Sample graph executions as a placeholder feed.
  useEffect(() => {
    if (!isExecuting) return;
    setEntries((prev) => [
      ...prev.slice(-49),
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ts: Date.now(),
        source: 'graph',
        message: `Running graph (${nodeCount} node${nodeCount === 1 ? '' : 's'})…`,
      },
    ]);
  }, [isExecuting, nodeCount]);

  // Subscribe to nebula:agent-log-entry events so any component can stream
  // entries into this log without coupling. ChatPanel dispatches these
  // for Daedalus thinking lines so they live here instead of in chat.
  useEffect(() => {
    function handleEntry(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { source?: 'graph' | 'hermes' | 'system'; message?: string }
        | undefined;
      if (!detail) return;
      const msg = String(detail.message ?? '').trim();
      if (!msg) return;
      setEntries((prev) => [
        ...prev.slice(-49),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          ts: Date.now(),
          source: detail.source ?? 'system',
          message: msg,
        },
      ]);
    }
    window.addEventListener('nebula:agent-log-entry', handleEntry);
    return () => window.removeEventListener('nebula:agent-log-entry', handleEntry);
  }, []);

  function persistOpen(next: boolean) {
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // ignore
    }
  }

  function persistPosition(p: Position) {
    try {
      window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(p));
    } catch {
      // ignore
    }
  }

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
      moved: false,
    };

    function onMove(ev: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      const next: Position = {
        left: Math.max(0, Math.min(window.innerWidth - 80, d.originLeft + dx)),
        top: Math.max(0, Math.min(window.innerHeight - 40, d.originTop + dy)),
      };
      setPosition(next);
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
    const next = !open;
    setOpen(next);
    persistOpen(next);
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

  return (
    <div
      className={'agent-log' + (open ? ' agent-log--open' : '')}
      style={containerStyle}
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
        >
          <span className="agent-log__title">
            <span className="agent-log__icon" aria-hidden>
              ⌁
            </span>
            Agent log
          </span>
          <span className={'agent-log__chevron' + (open ? ' agent-log__chevron--open' : '')}>
            ⌃
          </span>
        </button>
      </div>
      {open && (
        <div className="agent-log__body">
          {entries.length === 0 ? (
            <div className="agent-log__empty">
              No activity yet. Run the graph or talk to Daedalus to populate.
            </div>
          ) : (
            <ul className="agent-log__list">
              {entries.slice().reverse().map((e) => (
                <li key={e.id} className={`agent-log__entry agent-log__entry--${e.source}`}>
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

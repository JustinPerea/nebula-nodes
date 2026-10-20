import { useEffect, useRef, useState } from 'react';
import { Activity, ChevronUp, EyeOff } from 'lucide-react';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { ScrollFade } from '../ScrollFade';
import {
  AGENT_LOG_HIDDEN_NOTICE_MS,
  clamp,
  edgeStyle,
  keepClearOfRect,
  positionFromGeometry,
  resolvePositionForViewport,
  samePosition,
  type Position,
  type Rect,
} from './agentLogLayout';

const POS_STORAGE_KEY = 'nebula:agentLog:pos';
// User has to drag this many px before we treat the gesture as a drag and
// suppress the toggle click. Keeps single-click-to-collapse intact.
const DRAG_THRESHOLD = 4;
const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 40;

function chatLauncherRect(): Rect | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('.panel-launcher--chat');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** The log's layout size, ignoring the transform its entry spring applies. */
function layoutSize(el: HTMLElement | null): { width: number; height: number } | null {
  if (!el) return null;
  return { width: el.offsetWidth, height: el.offsetHeight };
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
  const enabled = useUIStore((s) => s.agentLogEnabled);
  const setEnabled = useUIStore((s) => s.setAgentLogEnabled);
  // Shown by default whether or not the chat is open (Q38, Justin 2026-10-20:
  // "it can be toggled off to get out of the way"). It docks in the
  // bottom-right column above the chat launcher, and the docked chat sits
  // above it (layouts.css).
  const visible = enabled;
  // "Agent log hidden · Show again", only after the log's own hide control.
  const [hiddenNotice, setHiddenNotice] = useState(false);
  // Hover or keyboard focus inside the notice holds its timer.
  const noticeHoldRef = useRef(false);
  const focusNoticeRef = useRef(false);
  const showAgainRef = useRef<HTMLButtonElement | null>(null);
  const headerRef = useRef<HTMLButtonElement | null>(null);
  const focusHeaderRef = useRef(false);
  // Turned back on from anywhere (Settings too): the notice has done its job.
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
    if (enabled && hiddenNotice) setHiddenNotice(false);
  }

  // Expanded or not lives in uiStore, so the Updates list's "See all
  // actions →" can open it (PR9a). It starts collapsed, and collapses again
  // when the log unmounts (leaving the canvas), as its local state did.
  const open = useUIStore((s) => s.agentLogOpen);
  const setOpen = useUIStore((s) => s.setAgentLogOpen);
  useEffect(() => () => useUIStore.getState().setAgentLogOpen(false), []);
  // Every agent's actions and the chat's thinking lines, collected while
  // this panel is unmounted too (store/agentLogStore.ts).
  const entries = useAgentLogStore((s) => s.entries);
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
      const size = layoutSize(logRef.current);
      if (!size) return;
      setPosition((current) => {
        if (!current || (current.anchorX && current.anchorY)) return current;
        const next = positionFromGeometry(current.left, current.top, size.width, size.height);
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
        const size = layoutSize(logRef.current);
        const width = size?.width ?? MIN_VISIBLE_WIDTH;
        const height = size?.height ?? MIN_VISIBLE_HEIGHT;
        const next = keepClearOfRect(
          resolvePositionForViewport(current, width, height),
          width,
          height,
          chatLauncherRect(),
        );
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
    // The docked chat keeps room above the log's spot while the log shows
    // (dragged too: a log moved a little would otherwise sit on the chat),
    // and while the "hidden" notice holds that spot.
    document.body.classList.toggle('agent-log-reserved', visible || hiddenNotice);
    document.body.classList.toggle('agent-log-open', visible && open);
    document.body.classList.toggle('agent-log-empty', visible && open && entries.length === 0);
    return () => {
      document.body.classList.remove('agent-log-enabled', 'agent-log-reserved', 'agent-log-open', 'agent-log-empty');
    };
  }, [visible, open, entries.length, hiddenNotice]);

  // A position saved before the log showed with the chat closed (or in a
  // bigger window) can sit on the launcher or past the edge; once the log
  // has a size, pull it on screen and lift it clear.
  useEffect(() => {
    if (!visible || !position) return;
    const frameId = window.requestAnimationFrame(() => {
      const size = layoutSize(logRef.current);
      if (!size) return;
      setPosition((current) => {
        if (!current) return current;
        const next = keepClearOfRect(
          resolvePositionForViewport(current, size.width, size.height),
          size.width,
          size.height,
          chatLauncherRect(),
        );
        if (samePosition(current, next)) return current;
        persistPosition(next);
        return next;
      });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [visible, position]);

  // The notice leaves after a few seconds unless it is hovered or focused;
  // Settings > Preferences stays the way back after that.
  useEffect(() => {
    if (!hiddenNotice) return;
    let remaining = AGENT_LOG_HIDDEN_NOTICE_MS;
    const timer = window.setInterval(() => {
      if (noticeHoldRef.current) return;
      remaining -= 250;
      if (remaining <= 0) setHiddenNotice(false);
    }, 250);
    return () => window.clearInterval(timer);
  }, [hiddenNotice]);

  // Hidden from the keyboard: the focused control is gone, so focus moves
  // to "Show again" instead of dropping to <body>. A mouse click leaves
  // focus alone so the notice can time out.
  useEffect(() => {
    if (hiddenNotice && focusNoticeRef.current) {
      focusNoticeRef.current = false;
      showAgainRef.current?.focus();
    }
  }, [hiddenNotice]);

  useEffect(() => {
    if (visible && focusHeaderRef.current) {
      focusHeaderRef.current = false;
      headerRef.current?.focus();
    }
  }, [visible]);

  function handleHide(e: React.MouseEvent<HTMLButtonElement>) {
    // detail is 0 when Enter or Space activated the button.
    focusNoticeRef.current = e.detail === 0;
    noticeHoldRef.current = false;
    setHiddenNotice(true);
    setEnabled(false);
  }

  function handleShowAgain() {
    focusHeaderRef.current = true;
    setHiddenNotice(false);
    setEnabled(true);
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
      const next = keepClearOfRect(
        positionFromGeometry(left, top, d.width, d.height),
        d.width,
        d.height,
        chatLauncherRect(),
      );
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
    setOpen(!open);
  }

  // Persist position on the latest setPosition that happened during the drag —
  // we attach to the up-handler via closure so this effect handles late writes.
  useEffect(() => {
    if (!position) return;
    persistPosition(position);
  }, [position]);

  // A dragged log keeps its left edge, and the bottom edge when it is
  // anchored there, so expanding it grows upward and stays on screen.
  const containerStyle: React.CSSProperties = position
    ? { ...edgeStyle(position), left: position.left, right: 'auto' }
    : {};
  // "Agent log hidden" shows where the dragged log was.
  const noticeStyle: React.CSSProperties = position ? { ...edgeStyle(position) } : {};
  const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const statusLabel = isExecuting ? 'streaming' : latestEntry ? latestEntry.agent?.name ?? latestEntry.source : 'standby';
  const countLabel = `${entries.length} event${entries.length === 1 ? '' : 's'}`;

  if (!visible) {
    if (!hiddenNotice) return null;
    return (
      <div
        className="agent-log-hidden-notice"
        style={noticeStyle}
        role="status"
        aria-live="polite"
        onMouseEnter={() => { noticeHoldRef.current = true; }}
        onMouseLeave={() => { noticeHoldRef.current = false; }}
        onFocus={() => { noticeHoldRef.current = true; }}
        onBlur={() => { noticeHoldRef.current = false; }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            // The notice is about to go with the focused control in it: keep
            // keyboard focus in this corner, on the chat launcher, instead of
            // dropping it to <body>.
            if (e.currentTarget.contains(document.activeElement)) {
              document.querySelector<HTMLElement>('.panel-launcher--chat')?.focus();
            }
            setHiddenNotice(false);
          }
        }}
      >
        <EyeOff
          className="agent-log-hidden-notice__icon"
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          focusable="false"
        />
        <span className="agent-log-hidden-notice__text">Agent log hidden</span>
        <span className="agent-log-hidden-notice__sep" aria-hidden="true">·</span>
        <button
          ref={showAgainRef}
          type="button"
          className="agent-log-hidden-notice__action"
          onClick={handleShowAgain}
          title="Also in Settings > Preferences > Agent log"
        >
          Show again
        </button>
      </div>
    );
  }

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
          ref={headerRef}
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
        <button
          type="button"
          className="agent-log__hide"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleHide}
          aria-label="Hide agent log"
          title="Hide agent log (Settings > Preferences brings it back)"
        >
          <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        </button>
      </div>
      {open && (
        <ScrollFade className="agent-log__body">
          {entries.length === 0 ? (
            <div className="agent-log__empty">
              <span className="agent-log__empty-grid" aria-hidden="true" />
              <span className="agent-log__empty-title">No events yet</span>
              <span className="agent-log__empty-status">standby</span>
            </div>
          ) : (
            <ul className="agent-log__list" aria-live="polite">
              {entries.slice().reverse().map((e) => (
                <li
                  key={e.id}
                  className={`agent-log__entry agent-log__entry--${e.source}`}
                  data-source={e.source}
                  data-agent={e.agent?.id}
                  style={e.agent ? { ['--agent-log-source-color' as string]: e.agent.color } : undefined}
                >
                  <span className="agent-log__entry-marker" aria-hidden="true" />
                  <span className="agent-log__time">
                    {new Date(e.ts).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span className="agent-log__source" title={e.agent?.name}>{e.agent?.name ?? e.source}</span>
                  <span className="agent-log__msg">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </ScrollFade>
      )}
    </div>
  );
}

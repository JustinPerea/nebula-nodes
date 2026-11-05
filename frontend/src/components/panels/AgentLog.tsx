import { useEffect, useRef, useState } from 'react';
import { Activity, ChevronUp, EyeOff } from 'lucide-react';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import { useAgentLogStore } from '../../store/agentLogStore';
import { ScrollFade } from '../ScrollFade';
import { usePersonThreadStore } from '../../store/personThreadStore';
import { AgentLogEntryRow } from './AgentLogEntryRow';
import { MessageComposer, MessagePreview, MessageThread } from './MessageBox';
import { CHROME_CLEARANCE, chromeTopLimit } from '../../lib/bottomBar';
import { LOG_CARD_FOLD_DESCRIPTION, LOG_COLLAPSE_VAR, LOG_HELD_ATTR, LOG_HOLD_ATTR } from '../../lib/noticeStackPlace';
import {
  AGENT_LOG_HIDDEN_NOTICE_MS,
  HEIGHT_STORAGE_KEY,
  RESIZE_HANDLE_LABEL,
  RESIZE_HANDLE_TITLE,
  RESIZE_KEY_STEP,
  clamp,
  clampLogHeight,
  edgeStyle,
  keepClearOfRect,
  positionFromGeometry,
  readStoredHeight,
  resizeEdge,
  resizedHeight,
  resolvePositionForViewport,
  samePosition,
  type HeightBounds,
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

/** A length token's px, read off a probe since it may be a clamp(). */
const heightProbes = new Map<string, HTMLDivElement>();
function probeHeight(token: string): number {
  let probe = heightProbes.get(token);
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = `position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:var(${token})`;
    heightProbes.set(token, probe);
  }
  if (!probe.isConnected) document.body.appendChild(probe);
  return probe.offsetHeight;
}

/** The open log's height with no give: the person's resize (inline), else
 * the state's --agent-log-h. */
function naturalLogHeight(log: HTMLElement): number {
  const inline = Number.parseFloat(log.style.height);
  if (Number.isFinite(inline) && inline > 0) return inline;
  return Math.min(probeHeight('--agent-log-h'), window.innerHeight * 0.8);
}

/** The Message box's open log has no state height: it follows its content
 * (up to 50vh) or the person's height (GM r61 answer 1, inline). With no
 * give in force that is its own height; while a give is in force (the
 * registered --agent-log-give, its spring back included) its height is the
 * given one, so the last height it had with none is kept. */
function messagingNaturalHeight(log: HTMLElement, previous: number | null): number {
  const inline = Number.parseFloat(log.style.height);
  if (Number.isFinite(inline) && inline > 0) return inline;
  const give = Number.parseFloat(getComputedStyle(log).getPropertyValue('--agent-log-give')) || 0;
  if (give > 0 && previous) return previous;
  return log.offsetHeight;
}

/** A body line's px: its line-height, or 1.4 of its font size. */
function bodyLine(log: HTMLElement, body: HTMLElement): number {
  const row = log.querySelector<HTMLElement>('.agent-log__msg, .message-box__text') ?? body;
  const rowStyle = getComputedStyle(row);
  return Number.parseFloat(rowStyle.lineHeight) || (Number.parseFloat(rowStyle.fontSize) || 12) * 1.4;
}

function verticalPadding(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
}

/** The floor it gives way to (GM r6): its header and 2 rows of the body,
 * with the body's padding and the log's borders; and the Message box's
 * composer, which stays whole at its foot. */
function logFloor(log: HTMLElement): number {
  const head = log.querySelector<HTMLElement>('.agent-log__drag-row');
  const body = log.querySelector<HTMLElement>('.agent-log__body');
  if (!head || !body) return log.offsetHeight;
  const composer = log.querySelector<HTMLElement>('.message-box__composer');
  const borders = log.offsetHeight - log.clientHeight;
  return head.offsetHeight + verticalPadding(body) + 2 * bodyLine(log, body) + (composer?.offsetHeight ?? 0) + Math.max(0, borders);
}

/** GM r61 answer 1: the person's height stays at least the header, one row
 * and the composer, and at most the viewport less the top chrome, from the
 * edge the log is pinned by. GM r70: the top chrome's line is the selection
 * toolbar slot's bottom + 12 px when the log's span overlaps the slot,
 * shown or not (selecting a node never moves the log); otherwise the top
 * bar's + 12 px (the Updates chip's row, --agent-log-top-chrome). */
function resizeBounds(log: HTMLElement, edge: 'top' | 'bottom'): HeightBounds {
  const head = log.querySelector<HTMLElement>('.agent-log__drag-row');
  const body = log.querySelector<HTMLElement>('.agent-log__body');
  const composer = log.querySelector<HTMLElement>('.message-box__composer');
  const item = log.querySelector<HTMLElement>('.message-box__item, .agent-log__entry');
  const row = item?.offsetHeight || (body ? 2 * bodyLine(log, body) : 0);
  const borders = Math.max(0, log.offsetHeight - log.clientHeight);
  const min = (head?.offsetHeight ?? 0) + (body ? verticalPadding(body) : 0) + row + (composer?.offsetHeight ?? 0) + borders;
  const rect = log.getBoundingClientRect();
  const chrome = chromeTopLimit({ left: rect.left, right: rect.right }, CHROME_CLEARANCE, probeHeight('--agent-log-top-chrome'));
  const max = edge === 'top'
    ? rect.bottom - chrome
    : window.innerHeight - Math.max(rect.top, chrome) - probeHeight('--page-gutter');
  return { min: Math.ceil(min), max: Math.floor(max) };
}

/** GM r70: the handle is a focusable separator; it reads the log's height
 * in px between its bounds (written on each measure: the height follows
 * the content until the person sets it). */
function describeHandle(log: HTMLElement, edge: 'top' | 'bottom'): void {
  const handle = log.querySelector<HTMLElement>(':scope > .agent-log__resize');
  if (!handle) return;
  const bounds = resizeBounds(log, edge);
  const values: [string, number][] = [
    ['aria-valuenow', Math.round(log.offsetHeight)],
    ['aria-valuemin', bounds.min],
    ['aria-valuemax', Math.max(bounds.min, bounds.max)],
  ];
  for (const [name, value] of values) {
    if (handle.getAttribute(name) !== String(value)) handle.setAttribute(name, String(value));
  }
}

function readPersonHeight(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    return readStoredHeight(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistPersonHeight(height: number | null) {
  if (typeof window === 'undefined') return;
  try {
    if (height === null) window.localStorage.removeItem(HEIGHT_STORAGE_KEY);
    else window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(height));
  } catch {
    // ignore
  }
}

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

/** The log counts as docked on the right within this of the edge, and low
 * enough for a notice to reach within this of the bottom (L7). */
const AGENT_LOG_EDGE_PX = 64;
const AGENT_LOG_LOW_PX = 360;
/** The gap a notice keeps from the log (--sr-space-2). */
const AGENT_LOG_GAP_PX = 8;

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
  // Collapsed for the proposal card (GM r7 step 4), or reopened over that by
  // the person: the region's measure stays the open log's while the card
  // holds it, and its collapse is offered only while it may collapse.
  const cardHold = useUIStore((s) => s.agentLogCardHold);
  const cardFolded = cardHold === 'card' && !open;
  const openSize = useRef<{ natural: number; floor: number } | null>(null);
  // The drag in progress ends here (its listeners and the hold), from any
  // of its ends (round 3l, GM r69 b).
  const endDragRef = useRef<(() => void) | null>(null);
  // The pointer that pressed the header, captured once a drag starts.
  const pointerRef = useRef<number | null>(null);
  useEffect(() => () => {
    useUIStore.getState().setAgentLogOpen(false);
    // Unmounted mid-drag: the drag and its hold go with it.
    endDragRef.current?.();
    document.documentElement.removeAttribute(LOG_HELD_ATTR);
  }, []);
  // Every agent's actions and the chat's thinking lines, collected while
  // this panel is unmounted too (store/agentLogStore.ts).
  const entries = useAgentLogStore((s) => s.entries);
  // The Message box (GM - Design r50): the thread with the terminal Claude
  // lives in the log, its composer at the foot, expanded or not.
  const threadCount = usePersonThreadStore((s) => s.rows.length);
  const [position, setPosition] = useState<Position | null>(readInitialPosition);
  const logRef = useRef<HTMLDivElement | null>(null);
  // GM r61 answer 1: the height follows the content (up to 50vh) until the
  // person drags the handle; from then on theirs wins, until a double-click.
  const [personHeight, setPersonHeight] = useState<number | null>(readPersonHeight);
  const resizeRef = useRef<{ startY: number; start: number; edge: 'top' | 'bottom'; bounds: HeightBounds } | null>(null);

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
      persistPersonHeight(null);
      setPersonHeight(null);
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

  // PR #198 review 6, L7 (GM r9 answer 5): the notice region keeps clear of
  // the log while it sits on the right edge, low enough for a toast to reach
  // it: --agent-log-clearance is the room it takes from the right
  // (noticeRegion.css), 0 otherwise. Measured, since the log can be dragged
  // and resized. --agent-log-top is how far its top edge (plus the gap)
  // sits above the window's bottom: a proposal card too narrow beside the
  // log sits above it instead (GM - Design, PR #216 r1; canvasProposals.css).
  // The log never moves for the card; at short heights its body gives way
  // (GM r6, below).
  // Dragged off the dock, its box goes on the root as --agent-log-float-*
  // (window px): the proposal card clears it when it sits in the card's
  // column (GM - Design, PR #216 r4 6; lib/noticeStackPlace.ts).
  // GM - Design, PR #216 r6: at short heights the docked, open log's body
  // gives way to a proposal card, down to a floor of its header and 2 rows
  // (the notice region writes --agent-log-squeeze; layouts.css). So that
  // giving way never moves the line the region measures, --agent-log-top is
  // the top the log has with no give (its own height, --agent-log-natural-h),
  // and --agent-log-floor is how short it may get.
  useEffect(() => {
    const root = document.documentElement;
    const log = logRef.current;
    const clear = (names: string[]) => names.forEach((name) => root.style.removeProperty(name));
    const set = (name: string, value: string) => {
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    };
    const DOCK = ['--agent-log-clearance', '--agent-log-top'];
    const GIVE = ['--agent-log-natural-h', '--agent-log-floor', LOG_COLLAPSE_VAR];
    const FLOAT = ['--agent-log-float-top', '--agent-log-float-bottom', '--agent-log-float-left', '--agent-log-float-right'];
    if (!visible || !log) {
      clear([...DOCK, ...GIVE, ...FLOAT]);
      return undefined;
    }
    const measure = () => {
      const rect = log.getBoundingClientRect();
      const docked = rect.width > 0 && window.innerWidth - rect.right <= AGENT_LOG_EDGE_PX
        && rect.bottom >= window.innerHeight - AGENT_LOG_LOW_PX;
      // The height it has with no give, and its floor of header and 2 rows:
      // the open log's own, kept while the card holds it collapsed (GM r7);
      // a log the person collapsed is its header and gives nothing.
      const held = !open && cardHold === 'card' && openSize.current;
      if (open) {
        const natural = (log.classList.contains('agent-log--messaging')
          ? messagingNaturalHeight(log, openSize.current?.natural ?? null)
          : naturalLogHeight(log)) || rect.height;
        openSize.current = { natural, floor: Math.min(natural, logFloor(log)) };
      }
      const { natural, floor } = open || held ? openSize.current! : { natural: rect.height, floor: rect.height };
      // Its collapse to the header frees the rest, while it may collapse.
      // (At its floor it is the floor's whole px tall, as layouts.css draws it.)
      const collapse = (open && cardHold !== 'refused') || held ? Math.max(0, Math.ceil(floor) - Math.ceil(probeHeight('--agent-h-closed'))) : 0;
      set('--agent-log-natural-h', `${Math.ceil(natural)}px`);
      set('--agent-log-floor', `${Math.ceil(floor)}px`);
      set(LOG_COLLAPSE_VAR, `${collapse}px`);
      // The docked chat and the canvas controls above it keep clear of the
      // height it has with no give (the Message box's log follows its
      // content, so its state token isn't its height; layouts.css reads this).
      if (log.classList.contains('agent-log--messaging')) {
        const body = document.body.style;
        const height = `${Math.ceil(natural)}px`;
        if (body.getPropertyValue('--agent-log-h') !== height) body.setProperty('--agent-log-h', height);
      }
      // Its box is read again once those and its marks are written: a re-run
      // of this effect clears them first, and a top-pinned log's shift and
      // its height are drawn from them, so a box read before is off by that
      // (round 3f: read at -16 px, the card collapsed and reopened the log in
      // a loop).
      if (docked) {
        clear(FLOAT);
        log.dataset.docked = 'true';
        delete log.dataset.floating;
        const box = log.getBoundingClientRect();
        set('--agent-log-clearance', `${Math.ceil(window.innerWidth - rect.left + AGENT_LOG_GAP_PX)}px`);
        set('--agent-log-top', `${Math.ceil(window.innerHeight - (box.bottom - natural) + AGENT_LOG_GAP_PX)}px`);
      } else {
        delete log.dataset.docked;
        clear(DOCK);
        // A floating log gives way held at the edge away from the card (GM
        // r7, r11; the region writes which on the root): layouts.css moves a
        // log pinned by the other edge by exactly what it gives.
        log.dataset.floating = position?.anchorY === 'bottom' && typeof position.offsetY === 'number' ? 'bottom' : 'top';
        const box = log.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          // Its box with no give: the held edge stays where it is.
          const heldTop = root.getAttribute(LOG_HOLD_ATTR) === 'top';
          const top = heldTop ? box.top : box.bottom - natural;
          root.style.setProperty('--agent-log-float-top', `${Math.floor(top)}px`);
          root.style.setProperty('--agent-log-float-bottom', `${Math.ceil(top + natural)}px`);
          root.style.setProperty('--agent-log-float-left', `${Math.floor(box.left)}px`);
          root.style.setProperty('--agent-log-float-right', `${Math.ceil(box.right)}px`);
        } else {
          clear(FLOAT);
        }
      }
      if (open) describeHandle(log, resizeEdge(position));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(log);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      clear([...DOCK, ...GIVE, ...FLOAT]);
      document.body.style.removeProperty('--agent-log-h');
    };
  }, [visible, open, position, cardHold, personHeight]);

  // A smaller window keeps the person's height within it (r61: at most the
  // viewport less the top chrome), and so does opening it: a height kept from
  // before the r70 ceiling, or from a taller window, comes down to it.
  useEffect(() => {
    if (!visible || personHeight === null) return undefined;
    function handleResize() {
      const log = logRef.current;
      if (!log) return;
      const next = clampLogHeight(personHeight!, resizeBounds(log, resizeEdge(position)));
      if (next !== personHeight) {
        setPersonHeight(next);
        persistPersonHeight(next);
      }
    }
    if (open) handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [visible, open, personHeight, position]);

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
    endDragRef.current?.();

    const row = e.currentTarget;
    const rect = (row.parentElement as HTMLElement).getBoundingClientRect();
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
      // The button came up where no mouseup reached the page (released over
      // another app, or a system sheet took the press): this move is the drop.
      if ((ev.buttons & 1) === 0) { onUp(); return; }
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      // GM r57 Q1: the person's hand wins. While held, the log rises above
      // the proposal card and the card holds still; it places once at the
      // drop (NoticeRegion).
      if (!d.moved) {
        document.documentElement.setAttribute(LOG_HELD_ATTR, '');
        // Captured from here, so a lost capture ends the hold too; only from
        // here, so a plain click still lands on the header's toggle.
        const id = pointerRef.current;
        if (id !== null && typeof row.setPointerCapture === 'function') {
          try { row.setPointerCapture(id); } catch { /* the pointer is already up */ }
        }
      }
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

    // Round 3l (GM r69 b): the hold ends on the drop and on every way a
    // drop can be lost: the window losing focus (Cmd-Tab, a system dialog),
    // the pointer cancelled or its capture lost, and the page hidden. A lost
    // hold would stop the card and the notices placing until the next click.
    function onHidden() {
      if (document.visibilityState === 'hidden') onUp();
    }

    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      window.removeEventListener('pointercancel', onUp);
      row.removeEventListener('lostpointercapture', onUp);
      document.removeEventListener('visibilitychange', onHidden);
      if (endDragRef.current === onUp) endDragRef.current = null;
      document.documentElement.removeAttribute(LOG_HELD_ATTR);
      const d = dragRef.current;
      if (d?.moved) {
        // Tell the click handler that fires next to bail out. A drop that
        // brings no click (its release landed off the header) lets go after
        // this task, so the person's next click on the header still toggles.
        justDraggedRef.current = true;
        window.setTimeout(() => { justDraggedRef.current = false; }, 0);
        const id = pointerRef.current;
        if (id !== null && typeof row.hasPointerCapture === 'function') {
          try { if (row.hasPointerCapture(id)) row.releasePointerCapture(id); } catch { /* gone */ }
        }
      }
      dragRef.current = null;
    }

    endDragRef.current = onUp;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    window.addEventListener('pointercancel', onUp);
    row.addEventListener('lostpointercapture', onUp);
    document.addEventListener('visibilitychange', onHidden);
  }

  function handleToggleClick() {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    // The person's own toggle: a collapse they make is never undone for the
    // card, and their reopening over the card's collapse holds (uiStore).
    setOpen(!open);
  }

  // GM r61 answer 1: the handle. A drag sets the person's height, within
  // its bounds; a double-click gives the height back to the content.
  const edge = resizeEdge(position);

  function applyHeight(height: number) {
    setPersonHeight(height);
    persistPersonHeight(height);
  }

  function handleResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const log = logRef.current;
    if (!log) return;
    e.preventDefault();
    e.stopPropagation();
    const start = log.offsetHeight;
    const bounds = resizeBounds(log, edge);
    resizeRef.current = { startY: e.clientY, start, edge, bounds };
    // GM r112.4: the press alone never changes the height. Resizing lifts
    // the content cap, so the rendered height is written first (a drag
    // starts from it), and the ceiling (154 at the top) holds while the
    // hand moves: the lifted cap is the drag's own bound, never the CSS's.
    log.style.height = `${start}px`;
    log.style.maxHeight = `${Math.max(bounds.max, start)}px`;
    log.dataset.resizing = '';
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = resizeRef.current;
    const log = logRef.current;
    if (!drag || !log) return;
    // Written straight to the box while the hand moves; kept at the drop.
    log.style.height = `${clampLogHeight(resizedHeight(drag.start, drag.startY, e.clientY, drag.edge), drag.bounds)}px`;
  }

  function handleResizeUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = resizeRef.current;
    const log = logRef.current;
    resizeRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!drag || !log) return;
    delete log.dataset.resizing;
    log.style.maxHeight = '';
    // A press with no move (the first half of a double-click) changes nothing.
    if (e.clientY === drag.startY) {
      log.style.height = personHeight === null ? '' : `${personHeight}px`;
      return;
    }
    applyHeight(clampLogHeight(resizedHeight(drag.start, drag.startY, e.clientY, drag.edge), drag.bounds));
  }

  function handleResizeReset() {
    persistPersonHeight(null);
    setPersonHeight(null);
  }

  function handleResizeKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const log = logRef.current;
    if (!log) return;
    // GM r70: Enter does what a double-click does.
    if (e.key === 'Enter') {
      e.preventDefault();
      handleResizeReset();
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const up = e.key === 'ArrowUp';
    // The handle moves with the arrow: up on the top edge is taller.
    const grow = (edge === 'top') === up ? RESIZE_KEY_STEP : -RESIZE_KEY_STEP;
    applyHeight(clampLogHeight(log.offsetHeight + grow, resizeBounds(log, edge)));
  }

  // Persist position on the latest setPosition that happened during the drag —
  // we attach to the up-handler via closure so this effect handles late writes.
  useEffect(() => {
    if (!position) return;
    persistPosition(position);
  }, [position]);

  // A dragged log keeps its left edge, and the bottom edge when it is
  // anchored there, so expanding it grows upward and stays on screen.
  const containerStyle: React.CSSProperties = {
    ...(position ? { ...edgeStyle(position), left: position.left, right: 'auto' } : {}),
    // The person's height (r61 answer 1); collapsed, layouts.css and
    // messageBox.css decide the height whatever it is.
    ...(personHeight !== null ? { height: personHeight } : {}),
  };
  // "Agent log hidden" shows where the dragged log was.
  const noticeStyle: React.CSSProperties = position ? { ...edgeStyle(position) } : {};
  const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const statusLabel = isExecuting ? 'streaming' : latestEntry ? latestEntry.agent?.name ?? latestEntry.source : 'standby';
  // GM r70: an agent's name is its cursor label ("Claude", "Claude · 2"), in
  // its own case; the state words stay the telemetry's lowercase.
  const statusIsName = !isExecuting && Boolean(latestEntry?.agent?.name);
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
        'agent-log agent-log--messaging'
        + (open ? ' agent-log--open' : '')
        + (entries.length === 0 ? ' agent-log--empty' : '')
        + (isExecuting ? ' agent-log--executing' : '')
      }
      style={containerStyle}
      data-status={statusLabel}
      {...(cardFolded ? { 'data-card-collapsed': '' } : {})}
      {...(personHeight !== null ? { 'data-sized': '' } : {})}
    >
      {open && (
        <div
          className="agent-log__resize"
          data-edge={edge}
          role="separator"
          aria-orientation="horizontal"
          aria-label={RESIZE_HANDLE_LABEL}
          // aria-valuenow, -valuemin and -valuemax: describeHandle, on each measure.
          tabIndex={0}
          title={RESIZE_HANDLE_TITLE}
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          onPointerCancel={handleResizeUp}
          onDoubleClick={handleResizeReset}
          onKeyDown={handleResizeKey}
        >
          <span className="agent-log__resize-grip" aria-hidden="true" />
        </div>
      )}
      <div
        className="agent-log__drag-row"
        onPointerDown={(event) => { pointerRef.current = event.pointerId; }}
        onMouseDown={handleHeaderMouseDown}
        title="Drag to move"
      >
        <button
          ref={headerRef}
          type="button"
          className="agent-log__header"
          onClick={handleToggleClick}
          // GM r57 Q5: folded for the card, a sighted person reads why too;
          // after their own collapse it is "Expand agent log" again.
          title={open ? 'Collapse agent log' : cardFolded ? LOG_CARD_FOLD_DESCRIPTION : 'Expand agent log'}
          aria-expanded={open}
          // GM r11: folded for the proposal card is not the person's collapse,
          // and doesn't read as one to a screen reader or an agent reading
          // the accessibility tree.
          {...(cardFolded ? { 'aria-description': LOG_CARD_FOLD_DESCRIPTION } : {})}
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
            <span className={'agent-log__status' + (statusIsName ? ' agent-log__status--name' : '')}>{statusLabel}</span>
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
      {open ? (threadCount > 0 ? <MessageThread entries={entries} /> : (
        <ScrollFade className="agent-log__body">
          {entries.length === 0 ? (
            <div className="agent-log__empty">
              <span className="agent-log__empty-grid" aria-hidden="true" />
              <span className="agent-log__empty-title">No events yet</span>
              <span className="agent-log__empty-status">standby</span>
            </div>
          ) : (
            <ul className="agent-log__list" aria-live="polite">
              {entries.slice().reverse().map((e) => <AgentLogEntryRow key={e.id} entry={e} />)}
            </ul>
          )}
        </ScrollFade>
      )) : <MessagePreview />}
      <MessageComposer expanded={open} />
    </div>
  );
}

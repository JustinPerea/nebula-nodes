import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useReactFlow, useStoreApi, type Node, type ReactFlowState } from '@xyflow/react';
import type { NodeData } from '../../types';
import {
  DEFAULT_AGENT_COLOR,
  isUnread,
  READER_COLOR,
  surfaceKey,
  type AgentNote,
  type AgentNoteAction,
  type AgentNoteAuthor,
  type AgentNotesSurface,
} from '../../lib/agentNotes';
import { cornerRight, roomBelow, showLabel, type Box } from '../../lib/agentNotesView';
import { springCssVars, springLinear, SPRING_SOFT } from '../../lib/springs';
import { viewportRevealing } from '../../lib/canvasFit';
import { springViewport } from '../../lib/viewportSpring';
import { selectCanvasList, useAgentNotesStore, type SurfaceList } from '../../store/agentNotesStore';
import { hydrateBoard, selectBoardList, setBoardInView } from '../../lib/agentNotesBoard';
import { wsClient } from '../../lib/wsClient';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';
import { useCanvasProposalsStore, type ProposalEntry } from '../../store/canvasProposalsStore';
import { reviewAssetProposal } from '../../lib/assetProposalReview';
import { reviewCanvasProposal } from '../../lib/canvasProposalReview';
import { ghostBoxes } from '../../lib/canvasProposals';
import { goToCanvas, onCanvas, whenReady } from '../../lib/goToCanvas';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { AgentNoteCard, AgentNotesSummaryCard } from './AgentNoteCard';
import { AgentNotesList, type AgentNotesListSection } from './AgentNotesList';
import { AuthorDot, type AgentNotesAdapter } from './AgentNoteParts';
import { UPDATES_SLOT_EVENT } from './UpdatesSlot';
import { LeaveBusyContext } from './leaveBusy';
import { askBeforeLeavingCommons } from '../../lib/commonsUnsaved';
import { unreadRingColor } from '../../lib/unreadRing';
import './agentNotes.css';
import { failureMessage, writtenLine } from '../../lib/errorCopy';

/** A card stays about 4 s (GM's v5.2 holds 2.6 to 3.8 s), longer while hovered or focused. */
const CARD_HOLD_MS = 4000;
const HOLD_TICK_MS = 250;
/**
 * Updates arriving this close together count as "at once": an agent posting
 * several in a row (each post a separate call) still reads as one burst. The
 * first card waits at most MAX_GATHER_MS for the burst to end.
 */
const GATHER_MS = 450;
const MAX_GATHER_MS = 1200;
/** Four or more at once become one "4 new updates" card. */
const SUMMARY_AT = 4;
/** Outlines follow the card in: 0.8 s after it, 0.25 s apart (mockup v5.2). */
const CARD_OUTLINE_DELAY_MS = 800;
const CARD_OUTLINE_STAGGER_MS = 250;
/** How long Show keeps its outlines up. */
const SHOW_OUTLINE_MS = 2400;

const CANVAS_SURFACE: AgentNotesSurface = { kind: 'canvas' };

type Card = { kind: 'note'; id: string } | { kind: 'summary'; ids: string[] };

/** What the card and the list stop above (never overlap) when they share its columns. */
const BELOW = [
  '.proposal-bar-panel',
  '.agent-log',
  '.agent-log-hidden-notice',
  '.panel-launcher--chat',
  '.toolbar',
  '.project-switch-toast',
  '.canvas-navigation',
].join(', ');
/** Never squeeze the list shorter than this; it scrolls inside. */
const MIN_ROOM = 160;

function obstacles(): Box[] {
  return [...document.querySelectorAll(BELOW)]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
}

/** The chat panel's rect right now, or null while it is closed. */
function chatBox(): Box | null {
  const r = document.querySelector('.chat-panel')?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;
}

/**
 * Re-render when the chat panel's rendered rect changes, docked or dragged
 * (never its stored width): a ResizeObserver and an attribute observer on
 * the panel, window resize, and the end of its own entrance or exit.
 */
function useChatRect(): Box | null {
  const [rect, setRect] = useState<Box | null>(null);
  const chatVisible = useUIStore((s) => s.panels.chat.visible);
  useEffect(() => {
    let frame = 0;
    let observed: Element | null = null;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
    const attributes = typeof MutationObserver === 'function' ? new MutationObserver(() => schedule()) : null;
    function measure() {
      frame = 0;
      const el = document.querySelector('.chat-panel');
      if (el !== observed) {
        if (observed) resize?.unobserve(observed);
        attributes?.disconnect();
        observed = el;
        if (el) {
          resize?.observe(el);
          attributes?.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
      const next = chatBox();
      setRect((current) => (sameBox(current, next) ? current : next));
    }
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(measure);
    }
    schedule();
    // Again once the chat's own entrance (or exit) has played.
    const later = window.setTimeout(schedule, 560);
    window.addEventListener('resize', schedule);
    document.addEventListener('animationend', schedule, true);
    document.addEventListener('transitionend', schedule, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(later);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('animationend', schedule, true);
      document.removeEventListener('transitionend', schedule, true);
      resize?.disconnect();
      attributes?.disconnect();
    };
  }, [chatVisible]);
  return rect;
}

/** The header slot a screen keeps for the chip (WorkspaceHeader, ProjectHome), if one shows. */
function headerSlot(): { slot: DOMRect; header: DOMRect | null } | null {
  for (const el of document.querySelectorAll('.agent-notes-slot')) {
    const slot = el.getBoundingClientRect();
    if (slot.width > 0 && slot.height > 0) {
      return { slot, header: el.closest('header')?.getBoundingClientRect() ?? null };
    }
  }
  return null;
}

/**
 * The chip's width, as the slots reserve it (layouts.css `--agent-notes-chip-w`,
 * whose stylesheet values, full and compact, stand in until the chip is
 * measured). A wider count ("12") widens the chip and the slot with it.
 */
function reserveChipWidth(width: number) {
  if (width <= 0) return;
  const root = document.documentElement;
  const value = `${Math.ceil(width)}px`;
  if (root.style.getPropertyValue('--agent-notes-chip-w') !== value) root.style.setProperty('--agent-notes-chip-w', value);
}

/**
 * The line the corner drops its card and list from off the canvas
 * (`--agent-notes-drop-top`, read by layouts.css to start a studio's docked
 * chat below it), or null to clear it (the canvas keeps its own rule).
 */
function setDropLine(top: number | null) {
  const root = document.documentElement;
  if (top === null) {
    if (root.style.getPropertyValue('--agent-notes-drop-top')) root.style.removeProperty('--agent-notes-drop-top');
    return;
  }
  const value = `${top}px`;
  if (root.style.getPropertyValue('--agent-notes-drop-top') !== value) root.style.setProperty('--agent-notes-drop-top', value);
}

/**
 * Keep the chip, the card and the list just left of the chat panel when its
 * rect would meet them (a chat dragged up to this corner; the docked chat
 * starts below the chip, layouts.css). A chip pushed onto the header pill
 * drops below the pill's row, and the card and list follow it. The card and
 * the list stop above what sits below them in the same columns.
 */
function placeCorner(chip: HTMLElement | null, card: HTMLElement | null, list: HTMLElement | null) {
  if (!chip) return;
  const chat = chatBox();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const rootStyle = getComputedStyle(document.documentElement);
  const gutter = parseFloat(rootStyle.getPropertyValue('--page-gutter')) || 16;
  const gap = parseFloat(rootStyle.getPropertyValue('--stack-gap-sm')) || 8;
  const homeTop = parseFloat(rootStyle.getPropertyValue('--agent-notes-chip-top')) || 24;
  const tokenHeight = parseFloat(rootStyle.getPropertyValue('--agent-notes-chip-h')) || 40;
  const size = { height: chip.offsetHeight || tokenHeight, width: chip.offsetWidth };
  reserveChipWidth(size.width);
  // Off the canvas (Q107 a) a screen's header keeps a slot for the chip, so it
  // never sits over that screen's own controls: the chip centres on it, and
  // the card and the list drop below the header.
  const reserved = headerSlot();
  if (reserved) {
    const { slot, header } = reserved;
    // Where the page scrolls its header away (Projects), the chip keeps the
    // top right at the gutter instead of leaving with it.
    const top = Math.round(slot.top >= 0 ? slot.top + (slot.height - size.height) / 2 : gutter);
    const right = Math.round(viewport.width - slot.right);
    chip.style.setProperty('--an-right', `${right}px`);
    chip.style.setProperty('--an-chip-top', `${top}px`);
    const dropTop = Math.round(Math.max(top + size.height, header?.bottom ?? 0) + gap);
    // A chat left open on the canvas stays up in the studios: docked, it
    // starts below this line (layouts.css), so it never sits under the chip.
    setDropLine(dropTop);
    const below = obstacles();
    for (const el of [card, list]) {
      if (!el) continue;
      el.style.setProperty('--an-drop-top', `${dropTop}px`);
      const box = { top: dropTop, height: el.offsetHeight, width: el.offsetWidth };
      // A card or the list that would meet the chat (docked or dragged
      // free) sits just left of it; the chip keeps its slot, since moving
      // it would put it over the screen's own controls.
      const elRight = Math.max(right, cornerRight(chat, viewport, box, right, gap));
      el.style.setProperty('--an-right', `${elRight}px`);
      const left = viewport.width - elRight - box.width;
      const room = roomBelow({ left, right: left + box.width, top: dropTop }, below, viewport.height, gap);
      el.style.setProperty('--an-max-h', `${Math.max(MIN_ROOM, room)}px`);
    }
    return;
  }
  setDropLine(null);
  let chipTop = homeTop;
  let chipRight = cornerRight(chat, viewport, { top: chipTop, ...size }, gutter);
  if (chipRight !== gutter) {
    const pill = document.querySelector('.canvas-tabs-wrap')?.getBoundingClientRect();
    const left = viewport.width - chipRight - size.width;
    if (pill && pill.width > 0 && left < pill.right + gap && viewport.width - chipRight > pill.left) {
      chipTop = pill.bottom + gap;
      chipRight = cornerRight(chat, viewport, { top: chipTop, ...size }, gutter);
    }
  }
  chip.style.setProperty('--an-right', `${chipRight}px`);
  if (chipTop === homeTop) chip.style.removeProperty('--an-chip-top');
  else chip.style.setProperty('--an-chip-top', `${chipTop}px`);
  const dropTop = chipTop + size.height + gap;
  const below = obstacles();
  for (const el of [card, list]) {
    if (!el) continue;
    if (chipTop === homeTop) el.style.removeProperty('--an-drop-top');
    else el.style.setProperty('--an-drop-top', `${dropTop}px`);
    const box = { top: dropTop, height: el.offsetHeight, width: el.offsetWidth };
    const right = cornerRight(chat, viewport, box, gutter);
    el.style.setProperty('--an-right', `${right}px`);
    // Stop above the proposal bar, the Agent log, the launcher and the toolbar.
    const left = viewport.width - right - box.width;
    const room = roomBelow({ left, right: left + box.width, top: dropTop }, below, viewport.height, gap);
    el.style.setProperty('--an-max-h', `${Math.max(MIN_ROOM, room)}px`);
  }
}

function agentLogHeader(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.agent-log__header');
}

/** The latest "See all actions →"; an older one that is still waiting gives way. */
let seeAllRequest = 0;

/**
 * "See all actions →": the Agent log, expanded, with focus on its header.
 * App mounts the log only on the canvas, so from any other screen this goes
 * to the canvas first (the way Show does) and opens the log once it has
 * mounted there. Until then agentLogOpen stays as it was: it is never left
 * set with no log on screen (which would pop the log open on a later visit).
 * If the person moves on before the log mounts, nothing opens. Resolves once
 * the log is open (or the person moved on); rejects with the reason when it
 * can't get there (the project didn't open, the Commons holds unsaved
 * labels, the log never showed), for the list to show.
 */
function seeAllActions(): Promise<void> {
  const request = ++seeAllRequest;
  if (onCanvas()) {
    useUIStore.getState().openAgentLog();
    window.requestAnimationFrame(() => agentLogHeader()?.focus({ preventScroll: true }));
    return Promise.resolve();
  }
  return goToCanvas()
    .then(() => whenReady(() => onCanvas() && agentLogHeader() !== null))
    .then((ready) => {
      if (request !== seeAllRequest || !onCanvas()) return;
      if (!ready) throw writtenLine("The Agent log didn't open. Try again.");
      useUIStore.getState().openAgentLog();
      window.requestAnimationFrame(() => {
        if (onCanvas()) agentLogHeader()?.focus({ preventScroll: true });
      });
    });
}

/** The newest author of each kind, for the chip's two dots. */
function chipAuthors(notes: AgentNote[]): { agent: AgentNoteAuthor; reader: AgentNoteAuthor } {
  const agent = notes.find((n) => n.author.kind === 'agent')?.author
    ?? { kind: 'agent', id: 'agent', name: 'Agent', color: DEFAULT_AGENT_COLOR };
  const reader = notes.find((n) => n.author.kind === 'reader')?.author
    ?? { kind: 'reader', id: 'argon', name: 'Gemini 4 Argon', color: READER_COLOR };
  return { agent, reader };
}

/** One list the corner shows: the open project's, and in Moodboard Studio the open board's (Q113 c). */
export interface AgentNotesCornerSection extends AgentNotesListSection {
  surface: AgentNotesSurface;
  /** The store key (`canvas:<projectId>`, `board:<boardId>`). */
  listKey: string;
  list: SurfaceList;
}

/** The section holding update `id`, read from the store now (a socket message may be newer than props). */
function sectionHolding(sections: AgentNotesCornerSection[], id: string): AgentNotesCornerSection | null {
  const { lists } = useAgentNotesStore.getState();
  return sections.find((section) => (lists[section.listKey] ?? section.list).notes.some((n) => n.id === id)) ?? null;
}

function liveNote(sections: AgentNotesCornerSection[], id: string): AgentNote | null {
  const { lists } = useAgentNotesStore.getState();
  for (const section of sections) {
    const found = (lists[section.listKey] ?? section.list).notes.find((n) => n.id === id);
    if (found) return found;
  }
  return null;
}

/** Lists that are each newest first, merged newest first by time; each list keeps its own order. */
function mergeNewestFirst(lists: AgentNote[][]): AgentNote[] {
  const filled = lists.filter((notes) => notes.length > 0);
  if (filled.length <= 1) return filled[0] ?? [];
  const at = filled.map(() => 0);
  const merged: AgentNote[] = [];
  for (;;) {
    let pick = -1;
    filled.forEach((notes, index) => {
      const next = notes[at[index]];
      if (next && (pick < 0 || next.at > filled[pick][at[pick]].at)) pick = index;
    });
    if (pick < 0) return merged;
    merged.push(filled[pick][at[pick]]);
    at[pick] += 1;
  }
}

/**
 * The Updates corner: the chip, the card that drops for each new update, and
 * the list it opens. One component for every surface; each list it shows is
 * a section with its own adapter (`AgentNotesAdapter`). The main canvas
 * mounts it in its own top-right spot (`AppAgentNotes`, which also mounts it
 * on every other screen, over that screen's header slot); it keeps left of
 * the chat panel when the chat's rect reaches it. In Moodboard Studio it
 * shows the open board's Updates above the project's (Q113 c): one chip,
 * one count, and opening the list reads both.
 */
export function AgentNotesCorner({ sections }: { sections: AgentNotesCornerSection[] }) {
  const markRead = useAgentNotesStore((s) => s.markRead);
  const markReadIds = useAgentNotesStore((s) => s.markReadIds);
  const dismiss = useAgentNotesStore((s) => s.dismiss);
  const setOutline = useAgentNotesStore((s) => s.setOutline);
  const error = useAgentNotesStore((s) => s.error);
  const agentLogEnabled = useUIStore((s) => s.agentLogEnabled);
  // Re-renders the corner when the chat moves; the placement below reads the
  // panel's rect again at that moment, so a card that mounts later never
  // uses a stale one.
  useChatRect();

  const [open, setOpen] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [queue, setQueue] = useState<string[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** The control waiting on the Commons' save in progress (commons-leave). */
  const [leaveBusy, setLeaveBusy] = useState<HTMLElement | null>(null);
  const [pop, setPop] = useState(0);

  const openRef = useRef(open);
  const holdRef = useRef(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The lists as last rendered, for the socket's and the timers' callbacks.
  const sectionsRef = useRef(sections);
  useLayoutEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);
  const listKeys = sections.map((section) => section.listKey).join('|');

  useEffect(() => {
    openRef.current = open;
  }, [open]);
  // For a step that fails after the render it started in (see `fail`).
  const openListRef = useRef<() => void>(() => {});

  // New updates: into the open list (read as they arrive), or queued to drop.
  useEffect(() => {
    const handle = () => {
      const store = useAgentNotesStore.getState();
      const arrived: string[] = [];
      for (const section of sectionsRef.current) {
        const ids = store.takeArrivals(section.listKey);
        if (ids.length === 0) continue;
        arrived.push(...ids);
        if (openRef.current) void store.markRead(section.surface, ids[ids.length - 1]);
      }
      if (arrived.length === 0) return;
      setPop((value) => value + 1);
      if (openRef.current) {
        setNewCount((value) => value + arrived.length);
        return;
      }
      // Nobody is looking: no drop. The count still rises.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setQueue((current) => [...current, ...arrived]);
    };
    const unsubscribe = useAgentNotesStore.subscribe(handle);
    const first = window.setTimeout(handle, 0);
    return () => {
      unsubscribe();
      window.clearTimeout(first);
    };
  }, [listKeys]);

  // One card at a time; four or more waiting become one summary card.
  const gatherFrom = useRef<number | null>(null);
  useEffect(() => {
    if (queue.length === 0) gatherFrom.current = null;
    const unread = (id: string) => {
      const found = liveNote(sectionsRef.current, id);
      return Boolean(found && isUnread(found));
    };
    // A slower burst (an MCP agent's posts land 1 to 3 s apart): the card up
    // and those waiting behind it fold into one summary card once they reach
    // four, unless the pointer or focus is on the card.
    if (card?.kind === 'note' && !leaving && !holdRef.current && queue.length > 0) {
      const live = queue.filter(unread);
      if (!unread(card.id) || live.length + 1 < SUMMARY_AT) return;
      const fold = window.setTimeout(() => {
        setCard({ kind: 'summary', ids: [card.id, ...live] });
        setQueue([]);
      }, 0);
      return () => window.clearTimeout(fold);
    }
    if (card || queue.length === 0) return;
    const now = Date.now();
    if (gatherFrom.current === null) gatherFrom.current = now;
    const wait = Math.min(GATHER_MS, Math.max(0, gatherFrom.current + MAX_GATHER_MS - now));
    const timer = window.setTimeout(() => {
      gatherFrom.current = null;
      const live = queue.filter(unread);
      holdRef.current = false;
      setLeaving(false);
      if (live.length >= SUMMARY_AT) {
        setCard({ kind: 'summary', ids: live });
        setQueue([]);
      } else if (live.length > 0) {
        setCard({ kind: 'note', id: live[0] });
        setQueue(live.slice(1));
      } else {
        setQueue([]);
      }
    }, wait);
    return () => window.clearTimeout(timer);
  }, [card, leaving, queue]);

  // The card leaves by itself after its hold, unless hovered or focused.
  useEffect(() => {
    if (!card || leaving) return;
    let remaining = CARD_HOLD_MS;
    const timer = window.setInterval(() => {
      // Its list left the corner (the Studio closed), or the update left its list.
      if (card.kind === 'note' && !liveNote(sectionsRef.current, card.id)) {
        setCard(null);
        return;
      }
      if (holdRef.current) return;
      remaining -= HOLD_TICK_MS;
      if (remaining <= 0) setLeaving(true);
    }, HOLD_TICK_MS);
    return () => window.clearInterval(timer);
  }, [card, leaving]);

  useEffect(() => {
    if (!card || !leaving) return;
    const timer = window.setTimeout(() => {
      setCard(null);
      setLeaving(false);
    }, springLinear(SPRING_SOFT).durationMs + 60);
    return () => window.clearTimeout(timer);
  }, [card, leaving]);

  const cardSection = card?.kind === 'note'
    ? sections.find((section) => section.list.notes.some((n) => n.id === card.id)) ?? null
    : null;
  const cardNote = card?.kind === 'note' && cardSection
    ? cardSection.list.notes.find((n) => n.id === card.id) ?? null
    : null;
  const cardOutlines = cardSection?.adapter.outlines !== false;

  // Outline what the card names while it is up; they fade out with it.
  useEffect(() => {
    if (!cardNote || !cardOutlines || leaving || open) return;
    setOutline('card', {
      refs: cardNote.refs,
      color: cardNote.author.color,
      delayMs: CARD_OUTLINE_DELAY_MS,
      staggerMs: CARD_OUTLINE_STAGGER_MS,
    });
    return () => setOutline('card', null);
  }, [cardNote, cardOutlines, leaving, open, setOutline]);

  // The open list takes focus, so Escape and Tab start there.
  useEffect(() => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);

  function closeList(returnFocus: boolean) {
    setOpen(false);
    setNewCount(0);
    setOutline('hover', null);
    if (returnFocus) chipRef.current?.focus();
  }

  function openList() {
    setOpen(true);
    setNow(Date.now());
    setNewCount(0);
    setQueue([]);
    if (card) setLeaving(true);
    // Opening reads every list it shows (the board's and the project's).
    for (const section of sections) {
      const newest = section.list.notes[0];
      if (newest && section.list.unread > 0) void markRead(section.surface, newest.id);
    }
  }
  useEffect(() => {
    openListRef.current = openList;
  });

  // A click outside closes the list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null;
      if (target && (listRef.current?.contains(target) || chipRef.current?.contains(target))) return;
      // The Commons' leave popover asks about a step from this list: it stays.
      if (target instanceof Element && target.closest('[data-leave-popover]')) return;
      setOpen(false);
      setNewCount(0);
      setOutline('hover', null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, setOutline]);

  useLayoutEffect(() => {
    placeCorner(chipRef.current, cardRef.current, listRef.current);
  });
  // Gone (no project open): the chat docks as before. A layout cleanup, so on
  // a project switch (which remounts the corner) it runs before the new
  // corner places itself, never after.
  useLayoutEffect(() => () => setDropLine(null), []);

  // Over a header slot the chip follows the header when the page scrolls
  // (Projects), and moves onto a slot that mounts later (a studio's chunk).
  // A window resize can cross the compact chip's breakpoint (agentNotes.css)
  // with no re-render: measure it again then, so the slot and the header
  // padding reserve its new width. Place it again then, once a frame.
  useEffect(() => {
    let frame = 0;
    const replace = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        placeCorner(chipRef.current, cardRef.current, listRef.current);
      });
    };
    document.addEventListener('scroll', replace, { capture: true, passive: true });
    window.addEventListener(UPDATES_SLOT_EVENT, replace);
    window.addEventListener('resize', replace);
    return () => {
      document.removeEventListener('scroll', replace, { capture: true });
      window.removeEventListener(UPDATES_SLOT_EVENT, replace);
      window.removeEventListener('resize', replace);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // What sits below can change while the list or a card is up (a proposal
  // arrives, the Agent log opens): place them again a few times a second.
  useEffect(() => {
    if (!open && !card) return;
    const timer = window.setInterval(() => placeCorner(chipRef.current, cardRef.current, listRef.current), 400);
    return () => window.clearInterval(timer);
  }, [open, card]);

  /**
   * A step that didn't go through: its reason in the list, where the person
   * looks (p157 review). The list opens for it when the step came from a
   * card, or when the list closed meanwhile.
   */
  function fail(failure: unknown) {
    useAgentNotesStore.setState({ error: failureMessage(failure, "Couldn't update the note.") });
    if (!openRef.current) openListRef.current();
  }

  /**
   * A step that leaves the Commons while it holds unsaved labels: the Commons
   * asks first, anchored to the clicked control (commons-leave), and the step
   * runs again once the person chose to leave. True when it asked.
   */
  function askingFirst(anchor: HTMLElement | undefined, step: () => void): boolean {
    const at = anchor ?? null;
    return askBeforeLeavingCommons(at, step, (on) => setLeaveBusy((busy) => (on ? at : busy === at ? null : busy)));
  }

  function runAction(note: AgentNote, action: AgentNoteAction, anchor?: HTMLElement) {
    const section = sectionHolding(sectionsRef.current, note.id);
    if (!section) return;
    // Review leaves for where the proposal is decided; a Commons ask opens
    // in the Commons, another of its sections, which isn't leaving.
    if (action.op.kind === 'proposal.review' && action.op.target !== 'commons'
      && askingFirst(anchor, () => runAction(note, action, anchor))) return;
    useAgentNotesStore.getState().clearError();
    void Promise.resolve()
      .then(() => section.adapter.runAction(note, action))
      .then(() => {
        // Review took the person to the strip: the list steps aside. (A
        // Review that fails keeps the list open, with its reason.)
        if (action.op.kind === 'proposal.review' && openRef.current) closeList(false);
      })
      .catch(fail);
  }

  function show(note: AgentNote, anchor?: HTMLElement) {
    if (note.refs.length === 0) return;
    const section = sectionHolding(sectionsRef.current, note.id);
    if (!section) return;
    if (!onCanvas() && askingFirst(anchor, () => show(note, anchor))) return;
    // From another screen Show opens the canvas: the list steps aside once
    // it is there. One that can't go keeps the list open, with its reason.
    // On its own screen (the canvas, or the board in the Studio) it stays open.
    if (!onCanvas()) useAgentNotesStore.getState().clearError();
    const going = section.adapter.show(note);
    if (going) void going.then(() => { if (openRef.current) closeList(false); }, fail);
  }

  function hover(note: AgentNote | null) {
    const outlines = note ? sectionHolding(sectionsRef.current, note.id)?.adapter.outlines !== false : false;
    setOutline('hover', note && outlines && note.refs.length > 0
      ? { refs: note.refs, color: note.author.color, delayMs: 0, staggerMs: 0 }
      : null);
  }

  function seeAll(anchor?: HTMLElement) {
    if (!onCanvas() && askingFirst(anchor, () => seeAll(anchor))) return;
    useAgentNotesStore.getState().clearError();
    // On the canvas the list steps aside for the log at once, as before.
    if (onCanvas()) closeList(false);
    // From another screen it steps aside once the log is open; a See all
    // that can't get there keeps it open, with its reason.
    void seeAllActions().then(() => { if (openRef.current) closeList(false); }, fail);
  }

  const hold = {
    onMouseEnter: () => { holdRef.current = true; },
    onMouseLeave: () => { holdRef.current = false; },
    onFocus: () => { holdRef.current = true; },
    onBlur: () => { holdRef.current = false; },
  };

  // Every list's updates, newest first, for the chip's colour and dots.
  const notes = useMemo(() => mergeNewestFirst(sections.map((section) => section.list.notes)), [sections]);
  const unread = sections.reduce((sum, section) => sum + section.list.unread, 0);
  const newest = notes[0]?.author.color ?? DEFAULT_AGENT_COLOR;
  const count = open ? 0 : unread;
  const authors = chipAuthors(notes);
  const unreadKinds = new Set(notes.filter(isUnread).map((n) => n.author.kind));
  // The ring is the unread signal itself: on at any unread count, 1 included,
  // while the list is closed (GM review of PR #157, round 2: it used to show
  // only while a card was up, so a lone unread was left to a white figure).
  const ringed = count > 0;
  const rootStyle = springCssVars() as CSSProperties;

  return (
    <LeaveBusyContext.Provider value={leaveBusy}>
    <div className="agent-notes-root" style={rootStyle}>
      <button
        ref={chipRef}
        type="button"
        className={`agent-notes-chip${ringed ? ' agent-notes-chip--ringed' : ''}`}
        aria-label={count > 0 ? `Updates, ${count} unread` : 'Updates'}
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{ '--an-newest': newest, '--an-ring': unreadRingColor(newest) } as CSSProperties}
        onClick={() => (open ? closeList(false) : openList())}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            closeList(true);
          }
        }}
      >
        <span className="agent-notes-chip__dots">
          <AuthorDot author={authors.agent} lit={unreadKinds.has('agent') && !open} />
          <AuthorDot author={authors.reader} lit={unreadKinds.has('reader') && !open} />
        </span>
        <span className="agent-notes-chip__label">Updates</span>
        <span
          key={pop}
          className="agent-notes-chip__count"
          data-muted={count === 0 ? 'true' : 'false'}
          data-pop={pop > 0 && count > 0 ? 'true' : undefined}
        >
          {count}
        </span>
      </button>

      {card && !open && cardNote && cardSection && (
        <AgentNoteCard
          key={cardNote.id}
          note={cardNote}
          adapter={cardSection.adapter}
          leaving={leaving}
          cardRef={cardRef}
          hold={hold}
          onRead={() => { if (isUnread(cardNote)) void markReadIds(cardSection.surface, [cardNote.id]); }}
          onDismiss={() => {
            void dismiss(cardSection.surface, cardNote.id);
            setLeaving(true);
          }}
          onAction={(action, anchor) => runAction(cardNote, action, anchor)}
          onShow={(anchor) => show(cardNote, anchor)}
        />
      )}
      {card && !open && card.kind === 'summary' && (
        <AgentNotesSummaryCard
          count={card.ids.length}
          color={newest}
          leaving={leaving}
          cardRef={cardRef}
          hold={hold}
          onOpen={openList}
          onClose={() => setLeaving(true)}
        />
      )}

      {open && (
        <AgentNotesList
          listRef={listRef}
          sections={sections}
          newCount={newCount}
          now={now}
          error={error}
          onClose={closeList}
          onSeeAll={agentLogEnabled ? seeAll : null}
          onAction={runAction}
          onShow={show}
          onHover={hover}
        />
      )}
    </div>
    </LeaveBusyContext.Provider>
  );
}

interface FlowBoxRect { left: number; top: number; right: number; bottom: number }

function nodeRect(lookup: ReactFlowState['nodeLookup'], id: string): FlowBoxRect | null {
  const internal = lookup.get(id);
  const position = internal?.internals?.positionAbsolute;
  const width = internal?.measured?.width ?? internal?.width;
  const height = internal?.measured?.height ?? internal?.height;
  if (!position || !width || !height) return null;
  return { left: position.x, top: position.y, right: position.x + width, bottom: position.y + height };
}

/**
 * The adapter for every screen (Q107 a): Show moves the canvas's view on a
 * spring and outlines the nodes; from another screen it goes to the canvas
 * first and shows once the canvas has mounted and placed its camera.
 */
function useAppAdapter(keptWith: string): AgentNotesAdapter {
  const store = useStoreApi<Node<NodeData>>();
  const { setViewport } = useReactFlow();
  const stopReveal = useRef<() => void>(() => {});
  const showTimer = useRef<number | null>(null);
  const showRequest = useRef(0);

  useEffect(() => () => {
    stopReveal.current();
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
  }, []);

  return useMemo<AgentNotesAdapter>(() => {
    function outline(note: AgentNote) {
      const { setOutline } = useAgentNotesStore.getState();
      setOutline('show', { refs: note.refs, color: note.author.color, delayMs: 0, staggerMs: 0 });
      if (showTimer.current !== null) window.clearTimeout(showTimer.current);
      showTimer.current = window.setTimeout(() => {
        showTimer.current = null;
        useAgentNotesStore.getState().setOutline('show', null);
      }, SHOW_OUTLINE_MS);
    }

    function frame(note: AgentNote) {
      // Show writes nothing: it frames and outlines, and leaves the selection
      // (which agents read, and the journal records) as it is.
      const state = store.getState();
      reveal(note.refs.map((id) => nodeRect(state.nodeLookup, id)).filter((r): r is FlowBoxRect => r !== null));
    }

    /** A canvas proposal's Review (Q112 a): its ghosts and the nodes it touches, in view. */
    function frameProposal(entry: ProposalEntry) {
      const state = store.getState();
      const rects: FlowBoxRect[] = ghostBoxes(entry.view, useCanvasProposalsStore.getState().drag[entry.view.id])
        .map((b) => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }));
      for (const id of entry.view.references) {
        const rect = nodeRect(state.nodeLookup, id);
        if (rect) rects.push(rect);
      }
      reveal(rects);
    }

    function reveal(rects: FlowBoxRect[]) {
      const state = store.getState();
      if (state.nodes.some((node) => node.dragging) || state.userSelectionActive) return;
      if (rects.length === 0) return;
      const block = {
        left: Math.min(...rects.map((r) => r.left)),
        top: Math.min(...rects.map((r) => r.top)),
        right: Math.max(...rects.map((r) => r.right)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      };
      const viewport = { x: state.transform[0], y: state.transform[1], zoom: state.transform[2] };
      const target = viewportRevealing(block, viewport, { width: state.width, height: state.height }, state.minZoom);
      if (!target) return;
      stopReveal.current();
      stopReveal.current = springViewport(viewport, target, (next) => { void setViewport(next); });
    }

    /** The canvas is on screen with what the note names measured. */
    function canvasReady(note: AgentNote): boolean {
      if (!onCanvas() || !document.querySelector('.react-flow__renderer')) return false;
      const state = store.getState();
      return note.refs.some((id) => nodeRect(state.nodeLookup, id) !== null);
    }

    return {
      keptWith,
      showLabel: () => 'Show on canvas',
      show: (note) => {
        const request = ++showRequest.current;
        if (onCanvas()) {
          outline(note);
          frame(note);
          return;
        }
        // Resolves once on the canvas (the corner's list steps aside then);
        // the framing follows when what the note names has measured.
        return goToCanvas().then(() => {
          void whenReady(() => canvasReady(note)).then((ready) => {
            if (request !== showRequest.current || !onCanvas()) return;
            outline(note);
            if (ready) frame(note);
          });
        });
      },
      runAction: async (_note, action) => {
        // A canvas proposal's Update (Q112 a): the canvas, with it in the bar.
        if (action.op.kind === 'proposal.review' && action.op.target === 'canvas') {
          return reviewCanvasProposal(action.op, frameProposal);
        }
        // An asset proposal's Update (Q92 a): go where the person decides it.
        if (action.op.kind === 'proposal.review') return reviewAssetProposal(action.op);
        const proposals = useCanvasProposalsStore.getState();
        const id = typeof action.op.proposalId === 'string' ? action.op.proposalId : '';
        if (action.op.kind === 'proposal.accept' && proposals.proposals[id]) return proposals.accept(id);
        if (action.op.kind === 'proposal.reject' && proposals.proposals[id]) return proposals.reject(id);
        throw writtenLine(`"${action.label}" can't run from here.`);
      },
      actionState: (action) => {
        // Review's proposal lives off the canvas; the backend resolves its Update when it closes.
        if (action.op.kind !== 'proposal.accept' && action.op.kind !== 'proposal.reject') return null;
        const id = typeof action.op.proposalId === 'string' ? action.op.proposalId : '';
        return useCanvasProposalsStore.getState().proposals[id] ? null : 'Expired';
      },
    };
  }, [store, setViewport, keptWith]);
}

/**
 * The board open in Moodboard Studio (Q113 c): its updates name images, drawn
 * with their numbers now; Show selects and frames their cards in the Board
 * view (the Studio answers `requestShow`). The board's edit actions (a run's
 * undo, Restore, a suggestion's Make frame / Not now, a board proposal's
 * Accept / Reject) have no route on main yet, so they say so and run nothing.
 */
function useBoardAdapter(boardId: string | null, imageIds: readonly string[]): AgentNotesAdapter {
  const order = imageIds.join('\n');
  return useMemo<AgentNotesAdapter>(() => {
    const numbers = new Map((order ? order.split('\n') : []).map((id, index) => [id, index + 1] as const));
    const numberFor = (ref: string) => numbers.get(ref) ?? null;
    return {
      keptWith: 'kept with this board',
      numberFor,
      // The canvas's outline layer draws nodes; a board's refs are images.
      outlines: false,
      showLabel: (note) => showLabel(note, { surface: 'board', numberFor }),
      show: (note) => {
        const onBoard = note.refs.filter((ref) => numbers.has(ref));
        if (!boardId) return;
        if (onBoard.length === 0) {
          useAgentNotesStore.setState({ error: 'What this update names is no longer on the board.' });
          return;
        }
        useBoardCanvasStore.getState().requestShow(boardId, onBoard);
      },
      runAction: async (_note, action) => {
        throw writtenLine(`"${action.label}" can't run here yet.`);
      },
    };
  }, [boardId, order]);
}

const NO_IMAGES: string[] = [];

/**
 * The Updates corner on every screen (Justin's Q107 a, 2026-10-21: "Show it
 * on every screen, with the open project's Updates"). App mounts one for
 * all screens, so the open list, the card and the count carry across a
 * screen switch. The list is the open project's (the canvas surface, kept
 * with the project). Hidden while no project is open: a first start on
 * Projects with no project yet has no list to show. On the canvas it holds
 * its own top-right corner (PR9a); elsewhere it sits over the slot that
 * screen's header keeps for it.
 *
 * In Moodboard Studio on a saved board (Justin's Q113 c, 2026-10-21: "Two
 * sections in one list: "This board" first, then the project. One chip with
 * one count (both added), opening it reads both, and an empty board section
 * is hidden.") the board's own Updates come first. Only there: every other
 * screen keeps the project's list alone. A board with Updates shows its list
 * even with no project open; with neither, there is no corner.
 */
export function AppAgentNotes() {
  const list = useAgentNotesStore(selectCanvasList);
  const projectId = useAgentNotesStore((s) => s.canvasProjectId);
  const inWorkspace = useProjectStore((s) => s.screen === 'workspace');
  const canvas = useUIStore((s) => s.viewMode === 'canvas' || (s.viewMode === 'commons' && !s.commonsEnabled));
  const inStudio = useUIStore((s) => s.viewMode === 'moodboard-editor');
  // Off the canvas "this project" is unclear (Projects lists them all): name it.
  const projectName = useProjectStore((s) => (s.activeProject?.id === projectId ? s.activeProject?.name : null));
  const adapter = useAppAdapter(inWorkspace && canvas || !projectName ? 'kept with this project' : `kept with ${projectName}`);
  const studioBoard = useBoardCanvasStore((s) => s.studioBoard);
  const boardId = inStudio && studioBoard ? studioBoard.boardId : null;
  const boardList = useAgentNotesStore((s) => selectBoardList(s, boardId));
  const boardAdapter = useBoardAdapter(boardId, boardId ? studioBoard!.imageIds : NO_IMAGES);
  const projectShown = inWorkspace || projectId !== null;
  const boardShown = boardId !== null && boardList.notes.length > 0;
  const shown = projectShown || boardShown;
  const reserved = shown && inWorkspace && canvas;

  // Off the canvas nothing else asks for the list: load it here.
  useEffect(() => {
    if (!list.loaded) void useAgentNotesStore.getState().hydrateCanvas();
  }, [list.loaded]);

  // The board the Studio has open: its list, and its cards from now on.
  useEffect(() => {
    setBoardInView(boardId);
    if (boardId) void hydrateBoard(boardId);
  }, [boardId]);
  useEffect(() => () => setBoardInView(null), []);
  // The backend replays no board Updates on (re)connect, only the canvas's
  // sync; and a read or dismiss the server refused leaves the list unsure.
  // Either way, read the open board's list again.
  const error = useAgentNotesStore((s) => s.error);
  useEffect(() => {
    if (!boardId) return;
    if (error) void hydrateBoard(boardId);
    return wsClient.subscribe((event) => {
      if (event.type === 'socketReconnected') void hydrateBoard(boardId);
    });
  }, [boardId, error]);

  // Screens keep a header slot for the chip while it shows (layouts.css).
  useEffect(() => {
    if (!shown) return;
    document.body.classList.add('agent-notes-shown');
    return () => document.body.classList.remove('agent-notes-shown');
  }, [shown]);

  // The chip holds the canvas's top-right corner: the docked chat starts below it.
  useEffect(() => {
    if (!reserved) return;
    document.body.classList.add('agent-notes-reserved');
    return () => document.body.classList.remove('agent-notes-reserved');
  }, [reserved]);

  const sections = useMemo(() => {
    const result: AgentNotesCornerSection[] = [];
    if (boardShown && boardId) {
      result.push({ id: 'board', title: 'This board', surface: { kind: 'board', boardId },
        listKey: surfaceKey({ kind: 'board', boardId }), list: boardList, notes: boardList.notes, adapter: boardAdapter });
    }
    if (projectShown) {
      result.push({ id: 'project', title: 'This project', surface: CANVAS_SURFACE,
        listKey: `canvas:${projectId ?? ''}`, list, notes: list.notes, adapter });
    }
    return result;
  }, [boardShown, boardId, boardList, boardAdapter, projectShown, projectId, list, adapter]);

  if (!shown) return null;
  return <AgentNotesCorner key={projectId ?? ''} sections={sections} />;
}

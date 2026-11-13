import type { AgentCursor } from '../store/agentPresenceStore';
import type { AgentCursorAnchor } from './wsClient';
import type { Box, Point } from './agentAnchorResolve';
import { AGENT_CURSOR_IDLE_MS } from '../store/agentPresenceStore';
import { AGENT_CURSOR_DOT } from './agentCursorTuning';
import { AGENT_CURSOR_IDLE_OPACITY } from './agentCursorPlanner';
import { springLinear, SPRING_SOFT } from './springs';

/**
 * The launcher's activity dot (PR #233 slice 8, GM - Design 2): while a cursor
 * is parked at a launcher because its surface isn't open, the launcher shows a
 * 6 px dot in the agent colour. Two agents give two dots side by side; from
 * three, the earliest two keep one and "+N" counts the agents without a dot. The dot dims with its
 * cursor at the 20 s idle (to the idle opacity), and goes when the cursor
 * leaves, is sent elsewhere, or is pruned (a cursor that is exiting doesn't
 * count). The screen layer draws them (components/agent-cursor/AgentScreenLayer.tsx),
 * never the rail. In the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */

export interface DotEntry {
  key: string;
  color: string;
  /** The backend's arrival: earliest first (ties by key, the same in every tab). */
  arrivedAt: number;
  idle: boolean;
  /** Which launcher element (any stable id). */
  launcher: string;
  box: Box;
  /** The launcher's own surface colour (its host's `--agent-launcher-surface`), '' when the host sets none. */
  surface: string;
}

export interface DotSlot { key: string; color: string; idle: boolean; at: Point }

export interface DotGroup {
  launcher: string;
  dots: DotSlot[];
  /** Agents beyond the dots drawn ("+N"), and where the label's right edge goes. */
  more: number;
  moreAt: Point | null;
  /** The "+N" pill's colour: the earliest agent's. */
  moreColor: string;
  /** The ring's colour: the launcher's own surface ('' = the stylesheet's default). */
  ring: string;
}

/** The dots of every launcher: where each is (its middle), and the "+N". */
export function launcherDots(entries: readonly DotEntry[]): DotGroup[] {
  const byLauncher = new Map<string, DotEntry[]>();
  for (const entry of entries) byLauncher.set(entry.launcher, [...(byLauncher.get(entry.launcher) ?? []), entry]);
  const { px, gapPx, maxDots, insetPx } = AGENT_CURSOR_DOT;
  const groups: DotGroup[] = [];
  for (const [launcher, group] of byLauncher) {
    group.sort((a, b) => a.arrivedAt - b.arrivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const { box } = group[0];
    const shown = group.slice(0, maxDots);
    const y = box.top + insetPx;
    const dots = shown.map((entry, index) => ({
      key: entry.key,
      color: entry.color,
      idle: entry.idle,
      // The first dot's middle is `insetPx` in from the corner; the next ones go left.
      at: { x: box.left + box.width - insetPx - index * (px + gapPx), y },
    }));
    const more = group.length - shown.length;
    const last = dots[dots.length - 1].at;
    groups.push({ launcher, dots, more, moreAt: more > 0 ? { x: last.x - px / 2 - gapPx, y } : null, moreColor: dots[0].color, ring: group[0].surface });
  }
  return groups;
}

/** A dot that has left and is fading where it was. */
export interface DotGhost { id: string; color: string; at: Point; /** The "+N" label of a pill that left. */ more: number; ring: string }

export interface DotSnapshot { groups: readonly DotGroup[]; ghosts: readonly DotGhost[] }

/** What the book reads of the screen layer. */
export interface DotSources {
  /** Which cursors have landed on their target (`since` is Infinity until they have). */
  landings: { readonly targets: ReadonlyMap<string, { since: number }>; readonly landedListeners: Set<(key: string) => void> };
  space: {
    /** The launcher `anchor` resolves to now, if it parks at one. */
    launcherOf(anchor: AgentCursorAnchor): { element: Element; box: Box } | null;
    subscribe(listener: () => void): () => void;
  };
  now?: () => number;
  reducedMotion?: () => boolean;
}

/** How long a leaving dot fades: the soft spring the dot's opacity runs on. */
export const DOT_FADE_MS = springLinear(SPRING_SOFT).durationMs;
export { AGENT_CURSOR_IDLE_OPACITY as DOT_IDLE_OPACITY };

/** The CSS variable each launcher host sets to its own background (the rail, a dock row). */
export const LAUNCHER_SURFACE_VAR = '--agent-launcher-surface';
const surfaceOf = (element: Element): string => {
  try { return window.getComputedStyle(element).getPropertyValue(LAUNCHER_SURFACE_VAR).trim(); } catch { return ''; }
};

const shared = (a: DotSnapshot, b: DotSnapshot) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Which dots are up and where: the screen layer's external store (for
 * `useSyncExternalStore`). A dot belongs to a cursor that is in the store (an
 * exiting cursor is not: it is gone from `agents` the moment it leaves, while
 * its drawing fades), has landed, and still resolves to a launcher. Measured
 * when cursors change, one lands, the page moves, and at each idle.
 */
export class DotBook {
  private agents: Record<string, AgentCursor> = {};
  private snapshot: DotSnapshot = { groups: [], ghosts: [] };
  private seen = new Map<string, { seq: number; idleAt: number }>();
  private elements = new WeakMap<Element, string>();
  private nextId = 0;
  private readonly listeners = new Set<() => void>();
  private release: (() => void) | null = null;
  private idleTimer: number | null = null;
  private readonly ghostTimers = new Map<string, number>();
  private ghosts = new Map<string, DotGhost>();
  private previous = new Map<string, { color: string; at: Point; more: number; ring: string }>();
  private readonly sources: DotSources;

  constructor(sources: DotSources) {
    this.sources = sources;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const redraw = () => this.update();
      this.sources.landings.landedListeners.add(redraw);
      const unsubscribe = this.sources.space.subscribe(redraw);
      this.release = () => {
        this.sources.landings.landedListeners.delete(redraw);
        unsubscribe();
      };
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.release?.();
        this.release = null;
        if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
        this.idleTimer = null;
        for (const timer of this.ghostTimers.values()) window.clearTimeout(timer);
        this.ghostTimers.clear();
        this.ghosts.clear();
      }
    };
  };

  readonly getSnapshot = (): DotSnapshot => this.snapshot;

  setAgents(agents: Record<string, AgentCursor>): void {
    this.agents = agents;
    this.update();
  }

  private launcherId(element: Element): string {
    let id = this.elements.get(element);
    if (id === undefined) {
      this.nextId += 1;
      id = `l${this.nextId}`;
      this.elements.set(element, id);
    }
    return id;
  }

  private update(): void {
    const wall = Date.now();
    const entries: DotEntry[] = [];
    let nextIdle = Infinity;
    for (const cursor of Object.values(this.agents)) {
      const kept = this.seen.get(cursor.key);
      const idleAt = kept && kept.seq === cursor.seq
        ? kept.idleAt
        : wall + AGENT_CURSOR_IDLE_MS - (cursor.replayed ? Math.max(0, wall - cursor.receivedAt) : 0);
      this.seen.set(cursor.key, { seq: cursor.seq, idleAt });
      const landed = this.sources.landings.targets.get(cursor.key)?.since;
      if (landed === undefined || landed === Infinity) continue;
      const found = this.sources.space.launcherOf(cursor.target);
      if (!found) continue;
      const idle = wall >= idleAt;
      if (!idle) nextIdle = Math.min(nextIdle, idleAt);
      entries.push({ key: cursor.key, color: cursor.color, arrivedAt: cursor.arrivedAt, idle,
        launcher: this.launcherId(found.element), box: found.box, surface: surfaceOf(found.element) });
    }
    for (const key of [...this.seen.keys()]) if (!(key in this.agents)) this.seen.delete(key);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = nextIdle === Infinity ? null : window.setTimeout(() => { this.idleTimer = null; this.update(); }, nextIdle - wall + 10);

    const groups = launcherDots(entries);
    // A dot that left fades where it was (instantly under reduced motion).
    const now = new Map<string, { color: string; at: Point; more: number; ring: string }>();
    for (const group of groups) {
      for (const dot of group.dots) now.set(`${group.launcher}|${dot.key}`, { color: dot.color, at: dot.at, more: 0, ring: group.ring });
      if (group.moreAt) now.set(`${group.launcher}|more`, { color: group.moreColor, at: group.moreAt, more: group.more, ring: group.ring });
    }
    const reduced = (this.sources.reducedMotion ?? (() => false))();
    for (const [id, was] of this.previous) {
      if (now.has(id) || reduced || this.ghosts.has(id)) continue;
      this.ghosts.set(id, { id, ...was });
      this.ghostTimers.set(id, window.setTimeout(() => {
        this.ghosts.delete(id);
        this.ghostTimers.delete(id);
        this.publish({ groups: this.snapshot.groups, ghosts: [...this.ghosts.values()] });
      }, DOT_FADE_MS));
    }
    for (const id of now.keys()) {
      // It came back: no ghost.
      if (this.ghosts.delete(id)) window.clearTimeout(this.ghostTimers.get(id));
    }
    this.previous = now;
    this.publish({ groups, ghosts: [...this.ghosts.values()] });
  }

  private publish(next: DotSnapshot): void {
    if (shared(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

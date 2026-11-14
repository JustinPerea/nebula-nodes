import type { AgentCursor } from '../store/agentPresenceStore';
import type { AgentCursorAnchor } from './wsClient';
import type { Box } from './agentAnchorResolve';
import { AGENT_CURSOR_OUTLINE } from './agentCursorTuning';

/**
 * The outlines on the items agents are changing (design section 5; GM - Design
 * PR #233 r3): a 1.5 px agent-colour rect on the item while a resting cursor's
 * action is `type` (solid) or `propose` (dashed). Pure: which cursors outline,
 * and how the rings of several agents on one item nest. The layer
 * (components/agent-cursor/AgentScreenLayer.tsx) draws them.
 *
 * In the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */

export type OutlineKind = 'solid' | 'dashed';

/** The outline an action draws, or null for none: `type` solid, `propose` dashed. */
export function outlineKind(action: AgentCursor['action']): OutlineKind | null {
  if (action === 'type') return 'solid';
  if (action === 'propose') return 'dashed';
  return null;
}

export interface OutlineEntry {
  key: string;
  /** The item: cursors with the same one nest. */
  item: string;
  kind: OutlineKind;
  color: string;
  /** When it came to the item (the backend's arrival): earliest is innermost. */
  arrivedAt: number;
  box: Box;
  /** The host's surface colour (the "+N" pill's fill); '' or absent when none. */
  surface?: string;
}

export interface OutlineRing {
  key: string;
  item: string;
  kind: OutlineKind;
  color: string;
  /** The rect to draw: the item's box grown by `grow` px each side. */
  box: Box;
  /** 0 for the innermost ring; each next one sits `stepPx` further out. */
  index: number;
  grow: number;
  /** On the outermost ring of an item with more agents than rings drawn: how many more ("+N"). */
  more: number;
  /** The host's surface colour, for the "+N" pill's fill; absent when the host sets none. */
  surface?: string;
}

/**
 * Rings for every item: the agents on one item nest `stepPx` apart, the
 * earliest arrival innermost (ties by key, the same in every tab); at most
 * `maxRings` are drawn and the outermost carries how many more there are.
 */
export function outlineRings(entries: readonly OutlineEntry[]): OutlineRing[] {
  const byItem = new Map<string, OutlineEntry[]>();
  for (const entry of entries) byItem.set(entry.item, [...(byItem.get(entry.item) ?? []), entry]);
  const rings: OutlineRing[] = [];
  const { stepPx, maxRings } = AGENT_CURSOR_OUTLINE;
  for (const group of byItem.values()) {
    group.sort((a, b) => a.arrivedAt - b.arrivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const drawn = group.slice(0, maxRings);
    drawn.forEach((entry, index) => {
      const grow = index * stepPx;
      rings.push({
        key: entry.key,
        item: entry.item,
        kind: entry.kind,
        color: entry.color,
        box: {
          left: entry.box.left - grow,
          top: entry.box.top - grow,
          width: entry.box.width + 2 * grow,
          height: entry.box.height + 2 * grow,
        },
        index,
        grow,
        more: index === drawn.length - 1 ? group.length - drawn.length : 0,
        ...(entry.surface ? { surface: entry.surface } : {}),
      });
    });
  }
  return rings;
}

/** What the book reads of the screen layer: the cursors' landings, and the visible box of an item. */
export interface OutlineSources {
  /** Which cursors have landed on their target (`since` is Infinity until they have), and a heard landing. */
  landings: { readonly targets: ReadonlyMap<string, { since: number }>; readonly landedListeners: Set<(key: string) => void> };
  space: {
    outlineOf(anchor: AgentCursorAnchor): Box | null;
    surfaceOf?(anchor: AgentCursorAnchor): string;
    subscribe(listener: () => void): () => void;
  };
  now?: () => number;
  /** For a timer a test drives. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Held {
  since: number;
  anchor: AgentCursorAnchor;
  kind: OutlineKind;
  entry: Omit<OutlineEntry, 'box'>;
}

const sameRings = (a: readonly OutlineRing[], b: readonly OutlineRing[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Which outlines are up, and where: the screen layer's external store (for
 * `useSyncExternalStore`), so nothing here is read or measured in a render.
 * An outline starts when its cursor has landed (the action fires at the tip,
 * design section 2), is held at least `minHoldMs` after its action changes,
 * and is measured when a cursor lands, the cursors change (`setAgents`), or
 * the page moves (`space.subscribe`): never per frame.
 */
export class OutlineBook {
  private agents: Record<string, AgentCursor> = {};
  private held = new Map<string, Held>();
  private rings: readonly OutlineRing[] = [];
  private readonly listeners = new Set<() => void>();
  private release: (() => void) | null = null;
  private timer: unknown = null;
  private readonly sources: OutlineSources;

  constructor(sources: OutlineSources) {
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
        this.clear();
      }
    };
  };

  readonly getSnapshot = (): readonly OutlineRing[] => this.rings;

  setAgents(agents: Record<string, AgentCursor>): void {
    this.agents = agents;
    this.update();
  }

  private clear(): void {
    if (this.timer !== null) (this.sources.clearTimer ?? ((h) => window.clearTimeout(h as number)))(this.timer);
    this.timer = null;
  }

  private update(): void {
    const now = (this.sources.now ?? (() => performance.now()))();
    const live = new Map<string, Held>();
    for (const cursor of Object.values(this.agents)) {
      const kind = outlineKind(cursor.action);
      const landed = this.sources.landings.targets.get(cursor.key)?.since;
      if (!kind || landed === undefined || landed === Infinity || !('surface' in cursor.target)) continue;
      const kept = this.held.get(cursor.key);
      const same = kept !== undefined && kept.kind === kind && JSON.stringify(kept.anchor) === JSON.stringify(cursor.target);
      live.set(cursor.key, {
        since: same ? kept.since : now,
        anchor: cursor.target,
        kind,
        entry: { key: cursor.key, item: JSON.stringify(cursor.target), kind, color: cursor.color, arrivedAt: cursor.arrivedAt },
      });
    }
    // A held state shows for at least minHoldMs, so a short tool call registers (design section 2).
    let wait = 0;
    for (const [key, was] of this.held) {
      if (live.has(key) || this.agents[key] === undefined) continue;
      const left = AGENT_CURSOR_OUTLINE.minHoldMs - (now - was.since);
      if (left > 0) {
        live.set(key, was);
        wait = Math.max(wait, left);
      }
    }
    this.held = live;
    const entries: OutlineEntry[] = [];
    for (const held of live.values()) {
      const box = this.sources.space.outlineOf(held.anchor);
      if (box) entries.push({ ...held.entry, box, surface: this.sources.space.surfaceOf?.(held.anchor) ?? '' });
    }
    const next = outlineRings(entries);
    this.clear();
    if (wait > 0) {
      this.timer = (this.sources.setTimer ?? ((cb, ms) => window.setTimeout(cb, ms)))(() => {
        this.timer = null;
        this.update();
      }, wait + 10);
    }
    if (!sameRings(this.rings, next)) {
      this.rings = next;
      for (const listener of [...this.listeners]) listener();
    }
  }
}

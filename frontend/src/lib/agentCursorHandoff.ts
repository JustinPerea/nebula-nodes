import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import type { CursorLayer } from './agentCursorLayerOf';
import type { Point } from './agentCursorMotion';

/**
 * The hand-off between the canvas layer and the screen layer (Phase 3,
 * "Anywhere", slice 6; plan section 3). A cursor lives in one layer at a
 * time (lib/agentCursorLayerOf.ts). When a new event moves it to the other,
 * the person must see one cursor travel: no jump, no fade. So each layer
 * writes, every frame it draws a cursor, where that cursor is on screen and
 * how fast it moves; the layer that receives it starts its flight from
 * there, at that speed, at that opacity and lean.
 *
 * Positions are client px (the one space both layers can convert to and
 * from, at the viewport as it is that frame, so a zoom in progress is safe)
 * and velocities client px per second.
 *
 * `screenEpoch` counts the times the person switched screens (canvas to a
 * Studio and so on). A cursor handed off across a switch would fly a canvas
 * point across a screen the person just replaced, so an entry from an older
 * epoch is not taken: the cursor makes its normal entrance instead.
 *
 * In the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */

/** An entry older than this is not a hand-off: the cursor wasn't just there. */
export const HANDOFF_FRESH_MS = 100;

export interface HandoffEntry {
  /** The layer that drew it. */
  layer: CursorLayer;
  /** Where it was drawn, client px. */
  at: Point;
  /** Client px per second. */
  velocity: Point;
  opacity: number;
  /** Degrees. */
  lean: number;
  /** performance.now() when written. */
  t: number;
  epoch: number;
}

export class CursorHandoff {
  /** Bumped when the person switches screens. */
  epoch = 0;

  private entries = new Map<string, HandoffEntry>();
  /** Which layer last drew each cursor (it set its view's first spot): the
   *  layer that had it holds it until the other has claimed it. */
  private claims = new Map<string, CursorLayer>();
  /** The screen epoch each claim was made under. */
  private claimEpochs = new Map<string, number>();
  /** The flights back to the canvas the screen layer has finished: the event
   *  (`seq`) it flew for, and the wall time it landed. */
  private landings = new Map<string, { seq: number; at: number }>();
  private claimListeners = new Set<() => void>();
  /** Bumped whenever a claim or a landing changes: what a layer's filter reads. */
  version = 0;
  private watching: (() => void) | null = null;
  /** The clock the entries are dated by (a test's own). */
  now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** The person switched screens: nothing written before it crosses it. */
  bump(): void {
    this.epoch += 1;
  }

  /**
   * What a layer writes each frame it draws `key`, and as its view goes. The
   * entry is dated now, and stamped with the epoch of the frame it describes
   * (`epoch`, default the current one): a view that goes because the screen
   * under it did writes the epoch it last drew under, so what it saw before
   * the switch never crosses it.
   */
  write(key: string, entry: Omit<HandoffEntry, 't' | 'epoch'>, epoch = this.epoch): void {
    this.watch();
    this.entries.set(key, { ...entry, t: this.now(), epoch });
  }

  /**
   * The hand-off `layer` starts `key`'s flight from, or null: the entry is
   * from the other layer, from this screen epoch, and either no older than
   * `HANDOFF_FRESH_MS` or from the layer that still holds the cursor. Taking it consumes it.
   */
  take(key: string, layer: CursorLayer): HandoffEntry | null {
    const entry = this.entries.get(key);
    if (!entry || entry.layer === layer) return null;
    this.entries.delete(key);
    // A cursor that rested in its layer wrote its last frame long ago; it is
    // still exactly there while that layer holds it (its claim), so the
    // entry is as good as a fresh one. Once the other layer has drawn it, or
    // the screen changed, it is not.
    const holds = this.claims.get(key) === entry.layer;
    if (entry.epoch !== this.epoch || (!holds && this.now() - entry.t > HANDOFF_FRESH_MS)) return null;
    return entry;
  }

  /** `layer` has `key`'s cursor on screen now: it resolved and drew it. */
  claim(key: string, layer: CursorLayer): void {
    if (this.claims.get(key) === layer) return;
    this.claims.set(key, layer);
    this.claimEpochs.set(key, this.epoch);
    this.version += 1;
    for (const listener of [...this.claimListeners]) listener();
  }

  /**
   * The cursor is on its way back to the canvas (GM r137): the screen layer
   * drew it last, under this screen, and has not yet landed it for event `seq`.
   * The screen layer then flies it the whole way and the canvas layer takes
   * it at the landing, so a dock never covers a cursor that left it (the
   * canvas layer sits under the docks). The forward flight, reversed.
   */
  transits(key: string, seq: number): boolean {
    return this.claims.get(key) === 'screen'
      && this.claimEpochs.get(key) === this.epoch
      && this.landings.get(key)?.seq !== seq;
  }

  /** The screen layer's flight back to the canvas for event `seq` is over (it landed, or can't go on): the canvas layer takes it now. */
  land(key: string, seq: number): void {
    if (this.landings.get(key)?.seq === seq) return;
    this.landings.set(key, { seq, at: Date.now() });
    this.version += 1;
    for (const listener of [...this.claimListeners]) listener();
  }

  /** When the screen layer landed event `seq`'s flight, if it did: the canvas layer's arrival is dated by it, not by the event. */
  landedAt(key: string, seq: number): number | null {
    const landed = this.landings.get(key);
    return landed?.seq === seq ? landed.at : null;
  }

  /** The layer that drew `key` last, if any. */
  claimedBy(key: string): CursorLayer | undefined {
    return this.claims.get(key);
  }

  /** Called whenever a layer claims a cursor. Returns its unsubscribe. */
  onClaim(listener: () => void): () => void {
    this.claimListeners.add(listener);
    return () => { this.claimListeners.delete(listener); };
  }

  /** `key`'s cursor is gone for good. */
  forget(key: string): void {
    this.entries.delete(key);
    this.claims.delete(key);
    this.claimEpochs.delete(key);
    this.landings.delete(key);
  }

  /** Forget the cursors that are no longer in the presence store: a claim
   *  left from a cursor that went (a prune, a clear) must not make a new one
   *  of that key start as a flight back from the screen layer. */
  retain(live: readonly string[]): void {
    const keep = new Set(live);
    for (const key of [...this.claims.keys()]) if (!keep.has(key)) this.forget(key);
  }

  /** Tests: forget everything and stop watching. */
  reset(): void {
    this.entries.clear();
    this.claims.clear();
    this.claimEpochs.clear();
    this.landings.clear();
    this.epoch = 0;
    this.version = 0;
    this.watching?.();
    this.watching = null;
  }

  /** Bump the epoch when the screen the person is on changes (the view
   *  mode, or Home and a project): zustand notifies before React renders, so
   *  the bump is in before either layer reads. Once; idempotent. */
  private watch(): void {
    if (this.watching) return;
    const stops = [
      useUIStore.subscribe((state, previous) => {
        if (state.viewMode !== previous.viewMode) this.bump();
      }),
      useProjectStore.subscribe((state, previous) => {
        if (state.screen !== previous.screen) this.bump();
      }),
    ];
    this.watching = () => stops.forEach((stop) => stop());
  }
}

/** This tab's registry. */
export const cursorHandoff = new CursorHandoff();

/** This tab's subscription for `useSyncExternalStore`: a claim or a landing changed. */
export const subscribeHandoff = (listener: () => void): (() => void) => cursorHandoff.onClaim(listener);
export const handoffVersion = (): number => cursorHandoff.version;

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Is this cursor's flight to a canvas node the screen layer's? Only while the
 * canvas is on screen and motion is on (a reduced-motion hand-off is a snap,
 * the canvas layer's). Both layers filter by it, so one of them draws the
 * cursor at a time.
 */
export function flyingBack(cursor: { key: string; seq: number; target: object }, canvasMounted: boolean): boolean {
  return canvasMounted && !('surface' in cursor.target) && !reducedMotion() && cursorHandoff.transits(cursor.key, cursor.seq);
}

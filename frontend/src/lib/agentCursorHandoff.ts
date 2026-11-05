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
   * from the other layer, no older than `HANDOFF_FRESH_MS`, and from this
   * screen epoch. Taking it consumes it.
   */
  take(key: string, layer: CursorLayer): HandoffEntry | null {
    const entry = this.entries.get(key);
    if (!entry || entry.layer === layer) return null;
    this.entries.delete(key);
    if (entry.epoch !== this.epoch || this.now() - entry.t > HANDOFF_FRESH_MS) return null;
    return entry;
  }

  /** `key`'s cursor is gone for good. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /** Tests: forget everything and stop watching. */
  reset(): void {
    this.entries.clear();
    this.epoch = 0;
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

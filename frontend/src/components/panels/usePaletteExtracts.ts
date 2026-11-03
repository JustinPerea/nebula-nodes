import { useEffect, useReducer, useRef, useState } from 'react';

/** GM r16 on #208 (#204's one loading look): "Extracting colors…" shows
 *  only once an extract has run this long; a quick one changes nothing. */
export const PALETTE_PENDING_DELAY_MS = 300;
/** GM r18 3 on #208: once shown, the line stays at least this long, and a
 *  palette ready sooner waits, so the new swatches and the Add / Extract row
 *  come back in one change and the line never just flashes. */
export const PALETTE_LINE_MIN_MS = 400;
export const PALETTE_PENDING_TEXT = 'Extracting colors…';

type Entry = {
  ticket: number;
  shownAt: number | null;
  showTimer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** A result waiting out the line's minimum, landed at once on unmount. */
  landNow: (() => void) | null;
};

export type PaletteExtractView = {
  /** An extract runs for this control. */
  working: boolean;
  /** "Extracting colors…" shows: the Add / Extract row is replaced by it,
   *  and the old swatches are read-only. */
  shown: boolean;
  /** What the always-mounted status region reads. */
  status: string;
};

/**
 * Extract from reference's state, per palette control on one node (the key
 * is ``nodeId:paramKey``; review 7 L1: the Inspector is one long-lived
 * instance, so a param key alone showed one node's extract on another).
 *
 * ``start(key, run, land)``: ``run`` works the palette out (it must not
 * reject; null means a later Extract for the key took over). ``land`` writes
 * the result and returns the status line; it is called once, after the
 * line's minimum when the line showed, and also when the Inspector closes
 * first, so a palette is never lost to a closed panel.
 */
export function usePaletteExtracts() {
  const entries = useRef(new Map<string, Entry>());
  const mounted = useRef(true);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    mounted.current = true;
    const live = entries.current;
    return () => {
      mounted.current = false;
      for (const entry of live.values()) {
        if (entry.showTimer) clearTimeout(entry.showTimer);
        entry.showTimer = null;
        entry.landNow?.();
      }
    };
  }, []);

  const say = (key: string, text: string) => {
    if (mounted.current) setStatuses((prev) => (prev[key] === text ? prev : { ...prev, [key]: text }));
  };

  function start<T>(key: string, run: () => Promise<T | null>, land: (value: T) => string): void {
    let entry = entries.current.get(key);
    if (!entry) {
      const fresh: Entry = { ticket: 0, shownAt: null, showTimer: null, holdTimer: null, landNow: null };
      fresh.showTimer = setTimeout(() => {
        fresh.showTimer = null;
        fresh.shownAt = Date.now();
        say(key, PALETTE_PENDING_TEXT);
        if (mounted.current) rerender();
      }, PALETTE_PENDING_DELAY_MS);
      entries.current.set(key, fresh);
      entry = fresh;
      // The last extract's "Extracted N colors." goes; nothing visible changes.
      say(key, '');
    }
    const owner = entry;
    const ticket = ++owner.ticket;
    if (mounted.current) rerender();
    void run().then((value) => {
      if (value === null || entries.current.get(key) !== owner || owner.ticket !== ticket) return;
      const finish = () => {
        if (entries.current.get(key) !== owner) return;
        entries.current.delete(key);
        if (owner.showTimer) clearTimeout(owner.showTimer);
        if (owner.holdTimer) clearTimeout(owner.holdTimer);
        owner.landNow = null;
        const text = land(value);
        say(key, text);
        if (mounted.current) rerender();
      };
      const wait = owner.shownAt === null ? 0 : owner.shownAt + PALETTE_LINE_MIN_MS - Date.now();
      if (wait > 0 && mounted.current) {
        owner.landNow = finish;
        owner.holdTimer = setTimeout(finish, wait);
      } else {
        finish();
      }
    });
  }

  function view(key: string): PaletteExtractView {
    const entry = entries.current.get(key);
    return { working: Boolean(entry), shown: entry?.shownAt != null, status: statuses[key] ?? '' };
  }

  return { start, view };
}

import { useSyncExternalStore } from 'react';

/** GM r16 on #208 (#204's one loading look): "Extracting colors…" shows
 *  only once an extract has run this long; a quick one changes nothing. */
export const PALETTE_PENDING_DELAY_MS = 300;
/** GM r18 3 on #208: once shown, the line stays at least this long, and a
 *  palette ready sooner waits, so the new swatches and the Add / Extract row
 *  come back in one change and the line never just flashes. A retry from
 *  the can't-run line holds this long from its start (GM r22 Q4). */
export const PALETTE_LINE_MIN_MS = 400;
export const PALETTE_PENDING_TEXT = 'Extracting colors…';

type Entry = {
  ticket: number;
  startedAt: number;
  shownAt: number | null;
  showTimer: ReturnType<typeof setTimeout> | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
};

export type PaletteExtractView = {
  /** An extract runs for this control. */
  working: boolean;
  /** "Extracting colors…" shows: the Add / Extract row is replaced by it,
   *  and the old swatches are read-only. */
  shown: boolean;
  /** What the always-mounted status region reads. */
  status: string;
  /** Extract can't run at all (its code didn't load): the file Try again
   *  sends again (GM r20 on #208). */
  cantRun: File | null;
};

/** A palette that came back to a node it could no longer be written to
 *  (GM r22 Q1): said on that node when the person is back on it. */
export type PaletteDropNote = {
  text: string;
  definitionId: string;
  /** A file param's dropped upload (GM r48 bug 2 on #222): the param and
   *  the value it held at the pick. Any change to that value clears the
   *  line (fileDropNotes.ts). */
  file?: { project: string | null; nodeId: string; key: string; value: unknown };
};

/**
 * Review 8 LOW-1 / GM r22 Q2 on #208: one source of truth per palette
 * control, outside any Inspector. A running extract is keyed on the project,
 * the graph generation (graphStore's canvasGeneration) and the node and
 * param (``paletteRunKey``), so an Inspector closed and opened again, or the
 * docked one and the popover, read the same "Extracting colors…", and an
 * extract can't show on the same node id in another project or a replaced
 * graph. Tab memory only: nothing is persisted.
 */
const entries = new Map<string, Entry>();
const statuses = new Map<string, string>();
const cantRuns = new Map<string, File>();
const notes = new Map<string, PaletteDropNote>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function say(key: string, text: string): void {
  if ((statuses.get(key) ?? '') === text) return;
  if (text) statuses.set(key, text);
  else statuses.delete(key);
  changed();
}

/** The key a running extract has (GM r22 Q2). */
export function paletteRunKey(project: string | null, generation: number, nodeId: string, paramKey: string): string {
  return `${project ?? ''}|${generation}|${nodeId}:${paramKey}`;
}

/** The key a dropped palette's line has: the project and the node, not the
 *  generation (coming back to a project loads its graph afresh). */
export function paletteNoteKey(project: string | null, nodeId: string, paramKey: string): string {
  return `${project ?? ''}|${nodeId}:${paramKey}`;
}

export type StartOptions = {
  /** A retry from the can't-run line (GM r22 Q4): no "Extracting colors…"
   *  (the line stays), and the result waits out PALETTE_LINE_MIN_MS from
   *  the start, so Try again holds its disabled look at least that long. */
  retry?: boolean;
};

/**
 * ``startPaletteExtract(key, run, land)``: ``run`` works the palette out (it
 * must not reject; null means a later Extract for the key took over).
 * ``land`` writes the result and returns the status line ('' says nothing);
 * it is called once, after the line's minimum when the line showed.
 */
export function startPaletteExtract<T>(key: string, run: () => Promise<T | null>, land: (value: T) => string,
  options: StartOptions = {}): void {
  let entry = entries.get(key);
  if (!entry) {
    const fresh: Entry = { ticket: 0, startedAt: Date.now(), shownAt: null, showTimer: null, holdTimer: null };
    if (!options.retry) {
      fresh.showTimer = setTimeout(() => {
        fresh.showTimer = null;
        fresh.shownAt = Date.now();
        say(key, PALETTE_PENDING_TEXT);
        changed();
      }, PALETTE_PENDING_DELAY_MS);
    }
    entries.set(key, fresh);
    entry = fresh;
  }
  // The last extract's "Extracted N colors." (or a failure's line) goes;
  // nothing visible changes. Said again when it lands, so a second
  // failure is announced again (GM r22 Q4).
  say(key, '');
  const owner = entry;
  const ticket = ++owner.ticket;
  // The older run's held landing is void once a newer one starts.
  if (owner.holdTimer) { clearTimeout(owner.holdTimer); owner.holdTimer = null; }
  changed();
  void run().then((value) => {
    if (value === null || entries.get(key) !== owner || owner.ticket !== ticket) return;
    const finish = () => {
      // A newer pick took the key while this one's line was held: it answers.
      if (entries.get(key) !== owner || owner.ticket !== ticket) return;
      entries.delete(key);
      if (owner.showTimer) clearTimeout(owner.showTimer);
      if (owner.holdTimer) clearTimeout(owner.holdTimer);
      const text = land(value);
      say(key, text);
      changed();
    };
    const from = options.retry ? owner.startedAt : owner.shownAt;
    const wait = from === null ? 0 : from + PALETTE_LINE_MIN_MS - Date.now();
    if (wait > 0) owner.holdTimer = setTimeout(finish, wait);
    else finish();
  });
}

export function paletteExtractView(key: string): PaletteExtractView {
  const entry = entries.get(key);
  return {
    working: Boolean(entry), shown: entry?.shownAt != null, status: statuses.get(key) ?? '',
    cantRun: cantRuns.get(key) ?? null,
  };
}

export function setPaletteCantRun(key: string, file: File | null): void {
  if (file) cantRuns.set(key, file);
  else if (!cantRuns.delete(key)) return;
  changed();
}

export function paletteDropNote(key: string): PaletteDropNote | null {
  return notes.get(key) ?? null;
}

/** Every dropped line waiting, by its key. */
export function paletteDropNotes(): [string, PaletteDropNote][] {
  return [...notes];
}

export function setPaletteDropNote(key: string, note: PaletteDropNote | null): void {
  if (note) notes.set(key, note);
  else if (!notes.delete(key)) return;
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-renders on any change to the extracts, the lines and the notes. */
export function usePaletteExtracts(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export function resetPaletteExtractsForTests(): void {
  for (const entry of entries.values()) {
    if (entry.showTimer) clearTimeout(entry.showTimer);
    if (entry.holdTimer) clearTimeout(entry.holdTimer);
  }
  entries.clear();
  statuses.clear();
  cantRuns.clear();
  notes.clear();
  changed();
}

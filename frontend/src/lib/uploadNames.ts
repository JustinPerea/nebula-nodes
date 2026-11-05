import { useSyncExternalStore } from 'react';
import { apiFetch } from './backend';

/**
 * The names files were uploaded with, by their stored (content-hash) name
 * (GM r48 Q1 on #222). Nebula records each upload's name beside the
 * content-hash store (backend services/upload_names.py) and serves it at
 * GET /api/uploads/names. lib/fileName.ts fileParamName reads it here.
 *
 * Tab memory: a stored name asked once is asked again only after a reload.
 * Asking is batched (one request per tick) and quiet: a name Nebula can't
 * give falls to the path's base name rule ("Uploaded file" for a hash).
 */
const names = new Map<string, string | null>();
const queued = new Set<string>();
const asking = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

async function ask(): Promise<void> {
  timer = null;
  const files = [...queued].slice(0, 200);
  for (const file of files) { queued.delete(file); asking.add(file); }
  if (queued.size) timer = setTimeout(() => { void ask(); }, 0);
  if (!files.length) return;
  const query = files.map((file) => `file=${encodeURIComponent(file)}`).join('&');
  let found: Record<string, unknown> = {};
  try {
    const response = await apiFetch(`/api/uploads/names?${query}`);
    if (response.ok) {
      const body = await response.json() as { names?: Record<string, unknown> } | null;
      if (body && typeof body.names === 'object' && body.names) found = body.names;
    }
  } catch {
    // Quiet: the base name rule names it meanwhile.
  }
  let any = false;
  for (const file of files) {
    asking.delete(file);
    const name = typeof found[file] === 'string' && found[file] ? found[file] as string : null;
    if (names.get(file) === undefined || (name && names.get(file) !== name)) {
      names.set(file, name);
      if (name) any = true;
    }
  }
  if (any) changed();
}

/** The name the stored file `stored` was uploaded with: a string when
 * known, null when Nebula has none, undefined while it is being asked. */
export function recordedUploadName(stored: string): string | null | undefined {
  if (names.has(stored)) return names.get(stored);
  if (!queued.has(stored) && !asking.has(stored)) {
    queued.add(stored);
    if (!timer) timer = setTimeout(() => { void ask(); }, 0);
  }
  return undefined;
}

/** An upload this tab just made: its name is known without asking. */
export function rememberUploadName(stored: string, name: string): void {
  if (!stored || !name || names.get(stored) === name) return;
  names.set(stored, name);
  queued.delete(stored);
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-renders when a recorded name arrives. */
export function useUploadNames(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export function resetUploadNamesForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  names.clear();
  queued.clear();
  asking.clear();
  changed();
}

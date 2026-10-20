import { useEffect } from 'react';
import { create } from 'zustand';
import { lookupStoredAsset } from '../lib/api';
import { setAsideCount } from '../lib/moodboardCount';
import type { TrashedItem } from '../lib/trash';
import { wsClient, type StoredAssetChangedEvent } from '../lib/wsClient';
import type { Character, Moodboard } from '../types';

/**
 * Saved moodboards and characters as the canvas cards show them.
 *
 * A Moodboard or Character node stores only the asset's id, in its public
 * `moodboard` / `character` param (backend services/agent_params.py), so an
 * agent can point one at a board. The card looks the asset up here, which
 * keeps its name, thumbnail and count current: the backend broadcasts
 * `storedAssetChanged` whenever one is saved, analysed, deleted or restored.
 * A deleted one is usually in Recently deleted (`trashed`), so the card can
 * offer Restore instead of saying it's gone.
 */

export type StoredAssetKind = 'moodboard' | 'character';

/** What a card shows for a saved asset. */
export interface StoredAssetSummary {
  id: string;
  name: string;
  thumbnail: string;
  /** Moodboards only: images on the board, as the Assets panel counts them. */
  imageCount?: number;
  /** Moodboards only: how many of them are set aside (lib/moodboardCount). */
  setAsideCount?: number;
  mode?: Moodboard['mode'];
}

export interface StoredAssetEntry {
  status: 'loading' | 'ready' | 'trashed' | 'missing' | 'error';
  /** Kept while a refetch runs, so the card doesn't flash empty. */
  summary: StoredAssetSummary | null;
  /** When it's in Recently deleted: who deleted it and when. */
  trashed?: TrashedItem;
}

export function moodboardSummary(moodboard: Moodboard): StoredAssetSummary {
  return {
    id: moodboard.id,
    name: moodboard.name,
    thumbnail: moodboard.thumbnail,
    imageCount: moodboard.images.length,
    setAsideCount: setAsideCount(moodboard.images),
    mode: moodboard.mode,
  };
}

export function characterSummary(character: Character): StoredAssetSummary {
  return { id: character.id, name: character.name, thumbnail: character.thumbnail };
}

// Nodes saved before 2026-10-18 kept the id here. The backend moves it to the
// public param on every load and write (retired_nodes.migrate_params); this
// covers a node the canvas holds that hasn't round-tripped yet.
const LEGACY_ID_KEYS: Record<StoredAssetKind, string> = {
  moodboard: '_moodboardId',
  character: '_characterId',
};

/** The asset id a Moodboard or Character node points at ('' when none). */
export function storedAssetId(kind: StoredAssetKind, params: Record<string, unknown> | undefined): string {
  const value = params?.[kind];
  if (typeof value === 'string' && value.trim()) return value.trim();
  const legacy = params?.[LEGACY_ID_KEYS[kind]];
  return typeof legacy === 'string' ? legacy.trim() : '';
}

const keyOf = (kind: StoredAssetKind, id: string) => `${kind}:${id}`;

// The latest request per asset wins; an older reply that lands late is dropped.
const latestRequest = new Map<string, number>();
let requestCounter = 0;

// Listen for changes from the first time a card asks for an asset, not on
// import: nothing needs refreshing until then, and importing the store (graphStore
// does) shouldn't register a socket handler.
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  wsClient.subscribe((event) => {
    const store = useStoredAssetsStore.getState();
    if (event.type === 'storedAssetChanged') store.applyChange(event);
    // Another project (or an import) arrived; anything may have changed meanwhile.
    else if (event.type === 'graphSync' && event.graphReplaced) void store.refreshAll();
  });
}

interface StoredAssetsState {
  entries: Record<string, StoredAssetEntry>;
  /** Fetch unless it's already known or on its way. */
  ensure: (kind: StoredAssetKind, id: string) => Promise<void>;
  /** Fetch again (it changed). */
  refresh: (kind: StoredAssetKind, id: string) => Promise<void>;
  /** Show what the caller already has (a panel's list) until the fetch lands. */
  prime: (kind: StoredAssetKind, summary: StoredAssetSummary) => void;
  applyChange: (event: Pick<StoredAssetChangedEvent, 'kind' | 'id' | 'deleted'>) => void;
  refreshAll: () => Promise<void>;
}

export const useStoredAssetsStore = create<StoredAssetsState>((set, get) => {
  const put = (key: string, entry: StoredAssetEntry) =>
    set((state) => ({ entries: { ...state.entries, [key]: entry } }));

  const load = async (kind: StoredAssetKind, id: string) => {
    listen();
    const key = keyOf(kind, id);
    const request = ++requestCounter;
    latestRequest.set(key, request);
    const previous = get().entries[key]?.summary ?? null;
    if (get().entries[key]?.status !== 'ready') put(key, { status: 'loading', summary: previous });
    try {
      const found = await lookupStoredAsset(kind, id);
      if (latestRequest.get(key) !== request) return;
      if (found.status === 'ready') {
        const summary = kind === 'moodboard'
          ? moodboardSummary(found.asset as Moodboard) : characterSummary(found.asset as Character);
        put(key, { status: 'ready', summary });
      } else if (found.status === 'trashed') {
        put(key, { status: 'trashed', trashed: found.trashed,
          summary: { id, name: found.trashed.name, thumbnail: found.trashed.thumbnail ?? '' } });
      } else {
        put(key, { status: 'missing', summary: null });
      }
    } catch {
      if (latestRequest.get(key) !== request) return;
      put(key, { status: 'error', summary: previous });
    }
  };

  return {
    entries: {},
    ensure: async (kind, id) => {
      if (!id || get().entries[keyOf(kind, id)]) return;
      await load(kind, id);
    },
    refresh: async (kind, id) => {
      if (id) await load(kind, id);
    },
    prime: (kind, summary) => {
      const key = keyOf(kind, summary.id);
      if (get().entries[key]?.status === 'ready') return;
      put(key, { status: 'loading', summary });
      void load(kind, summary.id);
    },
    applyChange: ({ kind, id }) => {
      const key = keyOf(kind, id);
      if (!get().entries[key]) return; // no card shows it
      // Deleted or not, fetch it again: a delete usually lands in Recently
      // deleted, and the card offers Restore.
      void load(kind, id);
    },
    refreshAll: async () => {
      await Promise.all(Object.keys(get().entries).map((key) => {
        const [kind, ...rest] = key.split(':');
        return load(kind as StoredAssetKind, rest.join(':'));
      }));
    },
  };
});

/** The saved asset a card shows, fetched on first use and kept current. */
export function useStoredAsset(kind: StoredAssetKind, id: string): StoredAssetEntry | null {
  const entry = useStoredAssetsStore((state) => (id ? state.entries[keyOf(kind, id)] ?? null : null));
  useEffect(() => {
    if (id) void useStoredAssetsStore.getState().ensure(kind, id);
  }, [kind, id]);
  return entry;
}

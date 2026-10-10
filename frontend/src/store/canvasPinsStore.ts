import { create } from 'zustand';
import { wsClient, type CanvasPinsEvent, type Pin } from '../lib/wsClient';
import { createPin, deletePin, fetchPins, MAX_PIN_TEXT } from '../lib/canvasPins';

/** Where the person is about to leave a note: on a node, or at a flow-space spot. */
export type PinComposerTarget = { nodeId: string } | { position: { x: number; y: number } };

interface CanvasPinsState {
  projectId: string | null;
  pins: Pin[];
  composer: PinComposerTarget | null;
  /** Deletes sent but not yet confirmed: hidden even if a stale update still lists them. */
  removing: Record<string, true>;
  error: string | null;
  hydrate: () => Promise<void>;
  apply: (event: Pick<CanvasPinsEvent, 'projectId' | 'pins'>) => void;
  compose: (target: PinComposerTarget) => void;
  cancelCompose: () => void;
  submit: (text: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  clearError: () => void;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Keep only well-formed pins; text stays plain text and is rendered escaped. */
function sanitize(raw: unknown): Pin | null {
  if (!raw || typeof raw !== 'object') return null;
  const pin = raw as Record<string, unknown>;
  if (typeof pin.id !== 'string' || typeof pin.text !== 'string') return null;
  const anchor = pin.anchor as Record<string, unknown> | undefined;
  let safeAnchor: Pin['anchor'];
  if (anchor && typeof anchor.nodeId === 'string') safeAnchor = { nodeId: anchor.nodeId };
  else if (anchor && finite(anchor.x) && finite(anchor.y)) safeAnchor = { x: anchor.x, y: anchor.y };
  else return null;
  const position = pin.position as Record<string, unknown> | null | undefined;
  const reply = pin.reply as Record<string, unknown> | null | undefined;
  const agent = reply?.agent as Record<string, unknown> | undefined;
  return {
    id: pin.id,
    text: pin.text.slice(0, MAX_PIN_TEXT),
    anchor: safeAnchor,
    position: position && finite(position.x) && finite(position.y) ? { x: position.x, y: position.y } : null,
    status: pin.status === 'resolved' ? 'resolved' : 'open',
    createdAt: typeof pin.createdAt === 'string' ? pin.createdAt : '',
    detached: pin.detached === true,
    detachedFrom: typeof pin.detachedFrom === 'string' ? pin.detachedFrom : undefined,
    reply: reply && typeof reply.text === 'string' && agent && typeof agent.name === 'string'
      ? {
          agent: {
            id: typeof agent.id === 'string' ? agent.id : agent.name,
            name: agent.name,
            color: typeof agent.color === 'string' && SAFE_COLOR.test(agent.color) ? agent.color : '#E8825A',
            verified: agent.verified === true,
          },
          text: reply.text,
          at: typeof reply.at === 'string' ? reply.at : '',
        }
      : null,
  };
}

function sanitizeAll(raw: unknown): Pin[] {
  return Array.isArray(raw) ? raw.map(sanitize).filter((pin): pin is Pin => pin !== null) : [];
}

export const useCanvasPinsStore = create<CanvasPinsState>((set, get) => ({
  projectId: null,
  pins: [],
  composer: null,
  removing: {},
  error: null,
  hydrate: async () => {
    try {
      const listing = await fetchPins();
      get().apply(listing);
    } catch {
      // The canvasPins push after graphSync heals this on the next connect.
    }
  },
  apply: (event) => set((state) => ({
    projectId: typeof event.projectId === 'string' ? event.projectId : null,
    pins: sanitizeAll(event.pins).filter((pin) => !state.removing[pin.id]),
  })),
  compose: (target) => set({ composer: target, error: null }),
  cancelCompose: () => set({ composer: null }),
  submit: async (text) => {
    const target = get().composer;
    const trimmed = text.trim();
    if (!target || !trimmed) {
      set({ composer: null });
      return false;
    }
    try {
      const pin = sanitize(await createPin(trimmed.slice(0, MAX_PIN_TEXT), target));
      set((state) => ({
        composer: null,
        error: null,
        pins: pin && !state.pins.some((p) => p.id === pin.id) ? [pin, ...state.pins] : state.pins,
      }));
      return true;
    } catch (error) {
      set({ composer: null, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
  remove: async (id) => {
    const previous = get().pins;
    set((state) => ({
      pins: state.pins.filter((pin) => pin.id !== id),
      removing: { ...state.removing, [id]: true },
    }));
    try {
      await deletePin(id);
    } catch (error) {
      // Put it back: the backend still has it.
      const restored = previous.find((pin) => pin.id === id);
      set((state) => ({
        pins: restored && !state.pins.some((p) => p.id === id) ? [...state.pins, restored] : state.pins,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      set((state) => {
        const removing = { ...state.removing };
        delete removing[id];
        return { removing };
      });
    }
  },
  clearError: () => set({ error: null }),
}));

wsClient.subscribe((event) => {
  if (event.type === 'canvasPins') useCanvasPinsStore.getState().apply(event);
  else if (event.type === 'graphSync' && event.graphReplaced) {
    // Another project (or an import) arrived: its pins come from the backend.
    void useCanvasPinsStore.getState().hydrate();
  }
});

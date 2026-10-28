import { create } from 'zustand';
import { wsClient, type CanvasPinsEvent, type Pin } from '../lib/wsClient';
import { createPin, deletePin, fetchPins, MAX_PIN_TEXT, noteKeptLine } from '../lib/canvasPins';
import { failureMessage, RequestFailedError } from '../lib/errorCopy';
import { refuseCanvasEdit } from '../lib/canvasLock';
import { subscribeFollowingSwitch, followingSwitch } from '../lib/canvasFollow';
import { subscribeCanvasReplaced } from '../lib/canvasReplaced';
import { getProjectContext, STALE_CANVAS_DETAIL, type ProjectContext } from '../lib/projectContext';

/** Where the person is about to leave a note: on a node, or at a flow-space spot. */
export type PinComposerTarget = { nodeId: string } | { position: { x: number; y: number } };

interface CanvasPinsState {
  projectId: string | null;
  pins: Pin[];
  composer: PinComposerTarget | null;
  /** Round 23 (review 22, M-1): the project and canvas the open dialog's
   * target belongs to (its node id names a node of that canvas only). The
   * note is sent for it, so Nebula refuses it once that canvas has gone. */
  composerCanvas: ProjectContext | null;
  /** What the person has typed in the open dialog (the dialog starts with it). */
  draft: string;
  /** Drafts the person closed with × or Esc, by the project they were
   * written in (fix round 2 of PR #200, GM 2026-10-28 answer 1: a note
   * written for project A never shows in project B's dialog). The next
   * dialog on that project starts with its draft; only sending drops it, or
   * clearing the field and closing. A closed draft is the person's own: it
   * gets no line when the canvas changes, and waits for its project. A
   * whitespace-only draft is no draft. */
  drafts: Record<string, string>;
  /** A note that couldn't be added because its canvas went before it was
   * sent (a follow, a replacement, Nebula's out-of-date refusal): its text,
   * kept for the person, never anchored anywhere, GM's line saying why
   * (lib/canvasPins noteKeptLine) and the project it was written in. The
   * next dialog on that project starts with it, and the notice closes; on
   * another project the dialog starts empty and the notice (with Copy note)
   * stays until its own × drops it. */
  kept: { text: string; line: string; project: string } | null;
  /** Deletes sent but not yet confirmed: hidden even if a stale update still lists them. */
  removing: Record<string, true>;
  error: string | null;
  hydrate: () => Promise<void>;
  apply: (event: Pick<CanvasPinsEvent, 'projectId' | 'pins'>) => void;
  compose: (target: PinComposerTarget) => void;
  cancelCompose: () => void;
  setDraft: (text: string) => void;
  submit: (text: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  clearError: () => void;
  dismissKept: () => void;
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
  composerCanvas: null,
  draft: '',
  drafts: {},
  kept: null,
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
  // Round 23 (review 22, M-1): the dialog is part of the canvas's read-only
  // state (lib/canvasLock, the one source every surface reads): opening it,
  // sending it and deleting a note are refused while following an agent's
  // switch and while offline, and nothing is sent.
  compose: (target) => {
    if (refuseCanvasEdit()) return;
    // GM (2026-10-28 answer 1): the kept note, else the draft × or Esc left,
    // starts the dialog, on the project it was written in only. Elsewhere the
    // dialog starts empty, and the kept note's notice stays.
    const canvas = getProjectContext();
    const here = projectKey(canvas);
    const { kept, drafts } = get();
    const keptHere = kept && kept.project === here ? kept : null;
    const { [here]: draftHere = '', ...otherDrafts } = drafts;
    set({ composer: target, composerCanvas: canvas, draft: keptHere?.text ?? draftHere, drafts: otherDrafts, error: null,
      kept: keptHere ? null : kept });
  },
  // × or Esc: the text stays as its project's draft for the next open there
  // (an emptied or whitespace-only field leaves none).
  cancelCompose: () => set((state) => ({ composer: null, composerCanvas: null, draft: '',
    drafts: keepDraft(state.drafts, projectKey(state.composerCanvas), state.draft) })),
  setDraft: (text) => set({ draft: text }),
  submit: async (text) => {
    const target = get().composer;
    const canvas = get().composerCanvas;
    const trimmed = text.trim();
    if (!target || !trimmed) {
      set({ composer: null, composerCanvas: null, draft: '' });
      return false;
    }
    const project = projectKey(canvas);
    // Offline is read-only (round 15 of PR #114): nothing is sent; the note
    // stays open and the banner pulses. Following the same (round 23).
    if (refuseCanvasEdit()) return false;
    try {
      // For the canvas it was written on (round 23): never the one open now.
      const pin = sanitize(await createPin(trimmed.slice(0, MAX_PIN_TEXT), target, canvas));
      set((state) => ({
        composer: null,
        composerCanvas: null,
        draft: '',
        error: null,
        pins: pin && !state.pins.some((p) => p.id === pin.id) ? [pin, ...state.pins] : state.pins,
      }));
      return true;
    } catch (error) {
      if (canvasWentFor(error)) {
        // That canvas has gone: the text is kept, not anchored elsewhere.
        set({ composer: null, composerCanvas: null, draft: '', kept: { text: trimmed, line: noteKeptLine(followingSwitch()), project } });
        return false;
      }
      // Not sent: the text stays as its project's draft for the next open
      // there (GM: only sending drops it), and the toast says why.
      set((state) => ({ composer: null, composerCanvas: null, draft: '', drafts: keepDraft(state.drafts, project, text),
        error: failureMessage(error, "Couldn't add the pin.") }));
      return false;
    }
  },
  remove: async (id) => {
    if (refuseCanvasEdit()) return;
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
        error: failureMessage(error, "Couldn't remove the pin."),
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
  dismissKept: () => set({ kept: null }),
}));

/** Nebula refused a pin write as made for a canvas that has gone. */
function canvasWentFor(error: unknown): boolean {
  return error instanceof RequestFailedError && error.status === 409
    && [error.message, error.reason, error.detail].some((text) => typeof text === 'string' && text.includes(STALE_CANVAS_DETAIL));
}

/** Which project a note was written in: a note never starts another
 * project's dialog (GM 2026-10-28 answer 1). A clear or an import of the same
 * project keeps it: the person sees it in the dialog and chooses again. */
function projectKey(canvas: ProjectContext | null): string {
  return canvas?.id ?? '';
}

/** `drafts` with `text` kept as `project`'s draft; a whitespace-only text drops it (review 2 N-4). */
function keepDraft(drafts: Record<string, string>, project: string, text: string): Record<string, string> {
  const { [project]: _gone, ...rest } = drafts;
  void _gone;
  return text.trim() ? { ...rest, [project]: text } : rest;
}

/** The open dialog's target was a node or a spot of the canvas that is
 * going (a follow started) or went (a replacement): the dialog closes, and
 * what the person typed is kept, with GM's line saying why (round 23,
 * review 22 M-1). Its target is never re-anchored: the canvas that replaces
 * it reuses the same ids. Fix round 2 of PR #200 (GM 2026-10-28 answer 1):
 * only an open dialog's note is cut off. A draft the person closed on
 * purpose gets no line; it stays their project's draft. A send that had
 * already failed keeps its own failure line. */
function closeComposerForGoneCanvas(following: ReturnType<typeof followingSwitch>): void {
  const { composer, composerCanvas, draft } = useCanvasPinsStore.getState();
  if (!composer) return;
  const text = draft.trim();
  useCanvasPinsStore.setState({ composer: null, composerCanvas: null, draft: '',
    ...(text ? { kept: { text, line: noteKeptLine(following), project: projectKey(composerCanvas) } } : {}) });
}

subscribeFollowingSwitch(() => {
  const following = followingSwitch();
  if (following) closeComposerForGoneCanvas(following);
});
// A replacement with no follow (a clear, an import, a reconnect) says the
// canvas changed; one that ends a follow finds the dialog already closed.
subscribeCanvasReplaced(() => closeComposerForGoneCanvas(followingSwitch()));

wsClient.subscribe((event) => {
  if (event.type === 'canvasPins') useCanvasPinsStore.getState().apply(event);
  else if (event.type === 'graphSync' && event.graphReplaced) {
    // Another project (or an import) arrived: its pins come from the backend.
    void useCanvasPinsStore.getState().hydrate();
  }
});

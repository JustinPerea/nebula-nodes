// PR #199 fix round 23 (GM r36 item 6, refining review 21 reopen-tabs NIT-2;
// NIT-3's G4): after a refused delete, the person's own focus change counts
// as moving on (the node comes back unselected, and focus stays where they
// put it); focus Nebula moved itself doesn't (the node comes back selected
// and inspected as at the press). restoreFocusMark never takes focus from
// whatever holds it at the restore (G4); with focus on <body>, it puts it
// back where it was at the press.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeNebula, canvasNode, textFakeNode, type FakeNode } from './helpers/undoFakeBackend';

const fake = vi.hoisted(() => ({
  backend: null as unknown as FakeNebula,
  override: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => (fake.override ? fake.override(path, init) : fake.backend.apiFetch(path, init)),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { setProjectContext } from '../src/lib/projectContext';
import { useUIStore } from '../src/store/uiStore';

fake.backend = new FakeNebula();
const nebula = () => fake.backend;
const initialGraph = useGraphStore.getState();
const store = () => useGraphStore.getState();
const nodeOf = (id: string) => store().nodes.find((node) => node.id === id);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(5); };
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, ...event } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full);
};
let clock = Date.now();

let frameQueue: FrameRequestCallback[] = [];
const runFrames = () => { const due = frameQueue; frameQueue = []; for (const callback of due) callback(0); };

describe('GM r36 item 6: focus the person moved counts as moving on; focus Nebula moved doesn\u2019t', () => {
  let card: HTMLElement;
  let chat: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    clock += 600_000;
    vi.setSystemTime(clock);
    nebula().tab = TAB_ID;
    nebula().emit = emit;
    fake.override = null;
    frameQueue = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frameQueue.push(callback); return frameQueue.length; });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // n2's card (React Flow isn't drawn here) and a chat box elsewhere.
    card = document.createElement('div');
    card.className = 'react-flow__node';
    card.setAttribute('data-id', 'n2');
    card.tabIndex = 0;
    chat = document.createElement('textarea');
    document.body.append(card, chat);
  });
  afterEach(async () => {
    fake.override = null;
    nebula().holdEchoes = false;
    nebula().holdAnswers = false;
    nebula().deliverEchoes();
    while (nebula().releaseAnswer());
    await settle();
    await tick(20_000);
    store().finishCanvasReplacement?.(null);
    setProjectContext(null);
    useUIStore.setState({ selectedNodeId: null });
    card.remove();
    chat.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });

  const start = (nodes: FakeNode[], selected: string[]) => {
    nebula().reset(nodes, []);
    useGraphStore.setState({ nodes: nodes.map((node) => canvasNode(node, selected.includes(node.id) ? { selected: true } : {})),
      edges: [], isExecuting: false, backendFreshStartPending: false,
      undoStack: [], redoStack: [], undoNotice: null, lateNotice: null, messageNotice: null,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
  };
  /** n2 selected, inspected and its card focused; the person presses Delete
   * on it (a key press, as the person does); Nebula refuses it later. */
  const deleteRefusedLater = async () => {
    setProjectContext({ id: 'p1', revision: 'r1', canvas: '0' });
    start([textFakeNode('n1'), textFakeNode('n2')], ['n2']);
    useUIStore.getState().selectNode('n2');
    card.focus();
    await tick(1); // the focus's own task is over
    nebula().holdAnswers = true;
    let left = 1;
    fake.override = (path, init) => {
      if (left > 0 && path === '/api/graph/node/n2' && init?.method === 'DELETE') {
        left -= 1;
        nebula().calls.push({ path, method: 'DELETE' });
        return nebula().later(`refused ${path}`, () => new Response(JSON.stringify({ detail: 'Refused.' }), { status: 409 }));
      }
      return nebula().apiFetch(path, init);
    };
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    store().onNodesChange([{ id: 'n2', type: 'remove' }]);
    // The press's own task moves focus (a deleted card's focus falls on):
    // not moving on.
    chat.focus();
    card.focus();
    await settle();
    expect(nodeOf('n2')).toBeUndefined();
  };
  const answer = async () => {
    while (nebula().releaseAnswer());
    await settle();
    await tick(2000);
    runFrames();
  };

  it('the person clicked into the chat: n2 comes back unselected and focus stays in the chat', async () => {
    await deleteRefusedLater();
    chat.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    chat.focus();
    await tick(1);
    await answer();
    expect(nodeOf('n2')).toBeTruthy();
    expect(nodeOf('n2')?.selected ?? false).toBe(false);
    expect(useUIStore.getState().selectedNodeId).toBeNull();
    expect(document.activeElement).toBe(chat);
  });

  it('the person tabbed away (a key press, then focus moves): moving on too', async () => {
    await deleteRefusedLater();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    chat.focus();
    await tick(1);
    await answer();
    expect(nodeOf('n2')?.selected ?? false).toBe(false);
  });

  it('Nebula moved focus itself (to a line, after a timer): n2 comes back selected and inspected, focus not stolen (G4)', async () => {
    await deleteRefusedLater();
    await tick(50);
    chat.focus(); // no input from the person: Nebula's own move
    await answer();
    expect(nodeOf('n2')?.selected).toBe(true);
    expect(useUIStore.getState().selectedNodeId).toBe('n2');
    expect(document.activeElement).toBe(chat);
  });

  it('control: focus fell to the page: n2 comes back selected and its card focused again', async () => {
    await deleteRefusedLater();
    card.blur();
    expect(document.activeElement).toBe(document.body);
    await answer();
    expect(nodeOf('n2')?.selected).toBe(true);
    expect(document.activeElement).toBe(card);
  });
});

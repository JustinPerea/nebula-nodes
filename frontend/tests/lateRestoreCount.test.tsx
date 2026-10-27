/**
 * A late restore count is never lost (GM - Design, 2026-10-23, answer 2):
 * "Yes, show it as a plain notice with no button, using the standard
 * timeout ... Losing that count silently is the one thing to avoid."
 *
 * Round 4 (GM - Design, replying to #180's "For GM"): "LATE LINES: drop the
 * node word, which fixes the mismatch for good. "After the restore, 1
 * proposal couldn't be reopened." / "…{n} proposals couldn't be reopened."
 * "After the restore, 1 pin couldn't be re-attached." / "…{n} pins couldn't
 * be re-attached." "After the restore, {p} pin(s) and {q} proposal(s)
 * couldn't be restored." (each noun by its own count). Keep the × Dismiss.
 * With two notices showing, put the late line above the newer one, so the
 * notice with a button stays nearest the bar."
 *
 * Before round 3: when the person moved on (a new step, a quick delete)
 * before a restore's answer arrived, the "Restored the node. 1 proposal
 * couldn't be reopened." line no longer applied (its Redo would do nothing),
 * so it stayed away and the count went with it. Now the count shows on its
 * own line, in its own slot right above the canvas notice, with no Undo or
 * Redo of its own, so the store's rule for offers never touches it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));
const net = vi.hoisted(() => ({
  restoreAnswers: [] as Array<Record<string, unknown>>,
  seq: 0,
  holdRestores: false,
  heldRestores: [] as Array<() => void>,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      net.seq += 1;
      const id = `rm_${String(net.seq).padStart(16, '0')}`;
      return new Response(JSON.stringify({ status: 'deleted', id: deleted[1],
        removal: { id, nodeId: deleted[1], pins: [], proposals: ['p_shared'] } }), { status: 200 });
    }
    if (path === '/api/graph/restore') {
      const answer = net.restoreAnswers.shift() ?? {};
      const response = new Response(JSON.stringify({ status: 'restored', reattached: [], reopened: [], notReopened: [],
        pinsLeft: [], removals: [], ...answer }), { status: 200 });
      if (!net.holdRestores) return response;
      return new Promise<Response>((resolve) => { net.heldRestores.push(() => resolve(response)); });
    }
    return new Response('{}', { status: 200 });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { NOTICE_SLOTS } from '../src/lib/noticeSlots';
import { noticeHoldMs } from '../src/lib/canvasNoticeHold';
import * as deleteNotice from '../src/lib/deleteNotice';
import { NoticeRegion } from '../src/components/NoticeRegion';

const LAZY = { timeout: 10_000 };
const SLOW = 20_000;
const CLAUDE = { kind: 'agent', id: 'claude-code', name: 'Claude Code', color: '#d97757' };
const initialGraph = { ...useGraphStore.getState() };
const ONE_LATE = "After the restore, 1 proposal couldn't be reopened.";

function textNode(id: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, outputs: {}, state: 'idle' } };
}
function sync(nodes: Node<NodeData>[], edges: Edge[], extra: Record<string, unknown> = {}) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes),
    edges: structuredClone(edges), empty: nodes.length === 0, ...extra } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const notice = () => useGraphStore.getState().undoNotice;
/** The plain line a late count shows on (null while none shows). */
const late = () => (useGraphStore.getState() as unknown as { lateNotice?: { text: string } | null }).lateNotice ?? null;
const top = (stack: 'undoStack' | 'redoStack') => useGraphStore.getState()[stack].at(-1);
const release = async () => {
  for (const done of net.heldRestores.splice(0)) done();
  await settle();
};

/** Delete n1, then Cmd+Z with the restore's answer held: "1 proposal couldn't be reopened" is on its way. */
async function restoreWithAnswerHeld(answer: Record<string, unknown> = { notReopened: [{ id: 'p_shared', reason: 'it expired' }] }) {
  useGraphStore.getState().deleteNode('n1');
  await settle();
  net.holdRestores = true;
  net.restoreAnswers.push(answer);
  useGraphStore.getState().undo();
  await settle();
  expect(net.heldRestores).toHaveLength(1);
}

beforeEach(() => {
  net.restoreAnswers.length = 0;
  net.seq = 0;
  net.holdRestores = false;
  net.heldRestores.length = 0;
  useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2')], edges: [], undoStack: [], redoStack: [],
    undoNotice: null, lateNotice: null, isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] } as never);
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  net.holdRestores = false;
  for (const done of net.heldRestores.splice(0)) done();
  await settle();
  useGraphStore.setState(initialGraph, true);
});

describe("GM's lines for a late count", () => {
  const lateText = (deleteNotice as unknown as {
    lateRestoreText?: (notReopened: number, notReattached: number) => string;
  }).lateRestoreText;

  it('proposals, verbatim (no node word), singular and plural by the proposal count', () => {
    expect(lateText?.(1, 0)).toBe(ONE_LATE);
    expect(lateText?.(2, 0)).toBe("After the restore, 2 proposals couldn't be reopened.");
    expect(lateText?.(7, 0)).toBe("After the restore, 7 proposals couldn't be reopened.");
  });

  it("pins on another model, GM's round 4 lines verbatim", () => {
    expect(lateText?.(0, 1)).toBe("After the restore, 1 pin couldn't be re-attached.");
    expect(lateText?.(0, 3)).toBe("After the restore, 3 pins couldn't be re-attached.");
  });

  it("both counts on GM's one line when both apply, each noun following its count", () => {
    expect(lateText?.(2, 1)).toBe("After the restore, 1 pin and 2 proposals couldn't be restored.");
    expect(lateText?.(1, 2)).toBe("After the restore, 2 pins and 1 proposal couldn't be restored.");
    expect(lateText?.(1, 1)).toBe("After the restore, 1 pin and 1 proposal couldn't be restored.");
  });

  it('nothing missed, no line', () => {
    expect(lateText?.(0, 0)).toBe('');
  });
});

describe('a late restore count', () => {
  it('restore, then a quick delete: the count shows as a plain line beside "Deleted the node."', async () => {
    await restoreWithAnswerHeld();
    useGraphStore.getState().deleteNode('n2');
    await settle();
    // Round 17: the delete reaches Nebula after the restore (the order the
    // person made them), so its line comes once the restore has answered.
    expect(useGraphStore.getState().nodes.map((node) => node.id)).toContain('n2');
    await release();
    // The newer notice keeps its Undo, and the count is not lost.
    expect(notice()).toMatchObject({ text: 'Deleted the node.', offer: 'undo' });
    expect(notice()?.entry).toBe(top('undoStack'));
    expect(late()).toMatchObject({ text: ONE_LATE });
  });

  it('a new step without a notice of its own: the count still shows', async () => {
    await restoreWithAnswerHeld();
    useGraphStore.getState().beginUndoStep();
    await release();
    expect(notice()).toBeNull();
    expect(late()).toMatchObject({ text: ONE_LATE });
  });

  it("pins on another model count too (#175's another-model code)", async () => {
    await restoreWithAnswerHeld({ pinsLeft: [{ id: 'pin_1', code: 'another-model', reason: 'The node is another model now.' }] });
    useGraphStore.getState().beginUndoStep();
    await release();
    expect(late()).toMatchObject({ text: "After the restore, 1 pin couldn't be re-attached." });
  });

  it('nothing missed: no line', async () => {
    await restoreWithAnswerHeld({});
    useGraphStore.getState().beginUndoStep();
    await release();
    expect(late()).toBeNull();
  });

  it('is not an offer: a new step never clears it, and it never clears the newer Undo', async () => {
    await restoreWithAnswerHeld();
    useGraphStore.getState().deleteNode('n2');
    await settle();
    await release();
    const shown = late();
    expect(shown).not.toBeNull();
    expect(shown).not.toHaveProperty('offer', 'undo');
    expect(shown).not.toHaveProperty('offer', 'redo');
    expect(shown).not.toHaveProperty('entry');
    useGraphStore.getState().beginUndoStep();
    expect(late()).toBe(shown);
  });

  it('two late counts in a row add up, never replace each other', async () => {
    useGraphStore.getState().deleteNode('n1');
    await settle();
    useGraphStore.getState().deleteNode('n2');
    await settle();
    net.holdRestores = true;
    net.restoreAnswers.push({ notReopened: [{ id: 'p_a', reason: 'it expired' }] },
      { notReopened: [{ id: 'p_b', reason: 'it expired' }] });
    useGraphStore.getState().undo();
    await settle();
    useGraphStore.getState().undo();
    await settle();
    useGraphStore.getState().beginUndoStep();
    await release();
    await release();
    expect(late()).toMatchObject({ text: "After the restore, 2 proposals couldn't be reopened." });
  });

  it("an agent's undo: the count shows on its own line once its notice is gone", async () => {
    sync([textNode('n2')], [], { edit: { actor: CLAUDE, id: 'ed_00000000000000b1',
      removals: [{ id: 'rm_00000000000000b1', nodeId: 'n1', pins: [], proposals: ['p_1'] }] } });
    net.holdRestores = true;
    net.restoreAnswers.push({ notReopened: [{ id: 'p_1', reason: 'it expired' }] });
    useGraphStore.getState().undo();
    await settle();
    useGraphStore.getState().beginUndoStep();
    expect(notice()).toBeNull();
    await release();
    expect(notice()).toBeNull();
    expect(late()).toMatchObject({ text: ONE_LATE });
  });

  it('with no newer step, nothing changes: "Restored the node. 1 proposal couldn\'t be reopened." with Redo, and no late line', async () => {
    await restoreWithAnswerHeld();
    await release();
    expect(notice()).toMatchObject({ text: "Restored the node. 1 proposal couldn't be reopened.", offer: 'redo' });
    expect(notice()?.entry).toBe(top('redoStack'));
    expect(late()).toBeNull();
  });

  it('opening another project clears it with the old notice', async () => {
    await restoreWithAnswerHeld();
    useGraphStore.getState().beginUndoStep();
    await release();
    expect(late()).not.toBeNull();
    expect(useGraphStore.getState().loadProjectGraph([], [], [])).toBe(true);
    expect(late()).toBeNull();
  }, SLOW);
});

describe('in the region', () => {
  it('has its own slot right above the canvas notice, which stays nearest the bar', () => {
    const slots = NOTICE_SLOTS as readonly string[];
    expect(slots).toContain('late');
    expect(slots.indexOf('late')).toBe(slots.indexOf('notice') - 1);
    expect(slots[slots.length - 1]).toBe('notice');
  });

  it('nothing else in the stack order moves (top to bottom)', () => {
    expect([...NOTICE_SLOTS]).toEqual([
      'proposal', 'run-later', 'person-required', 'project-switch', 'save-paused', 'project-home',
      // Review 7, L3: a line beside an Undo has its own slot above the late count.
      'pin', 'board', 'asset-trash', 'message', 'late', 'notice',
    ]);
  });

  it('shows above the newer notice, as a plain line: no Undo or Redo, only the Dismiss', async () => {
    await restoreWithAnswerHeld();
    useGraphStore.getState().deleteNode('n2');
    await settle();
    await release();
    render(<NoticeRegion screen="canvas" />);
    const line = await screen.findByText(ONE_LATE, {}, LAZY);
    const newer = await screen.findByText('Deleted the node.', {}, LAZY);
    const lateItem = line.closest<HTMLElement>('[data-notice-slot] > *')!;
    const newerItem = newer.closest<HTMLElement>('[data-notice-slot] > *')!;
    expect(lateItem.parentElement).toHaveAttribute('data-notice-slot', 'late');
    expect(newerItem.parentElement).toHaveAttribute('data-notice-slot', 'notice');
    // Above it in the column (the stack draws top to bottom), so the notice
    // with a button stays nearest the bar.
    expect(newerItem.compareDocumentPosition(lateItem) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(lateItem).toHaveAttribute('role', 'status');
    expect(within(lateItem).queryByRole('button', { name: /undo|redo/i })).toBeNull();
    // GM: "Keep the × Dismiss."
    expect(within(lateItem).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Dismiss']);
    // The newer notice keeps its Undo.
    expect(within(newerItem).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  }, SLOW);

  it('goes after the standard hold for its text', async () => {
    await restoreWithAnswerHeld();
    useGraphStore.getState().beginUndoStep();
    await release();
    render(<NoticeRegion screen="canvas" />);
    // The region's own notices are a deferred chunk: let it load, then start a fresh hold on fake time.
    await screen.findByText(ONE_LATE, {}, LAZY);
    vi.useFakeTimers();
    act(() => { useGraphStore.setState({ lateNotice: { ...late()!, id: 9_999 } } as never); });
    expect(screen.getByText(ONE_LATE)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(noticeHoldMs(ONE_LATE, null) - 50); });
    expect(screen.getByText(ONE_LATE)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByText(ONE_LATE)).toBeNull();
    expect(late()).toBeNull();
  }, SLOW);
});

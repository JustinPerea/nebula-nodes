/**
 * PR #204 round 11 (the control-level sweep ratchet's two finds): a control that reaches a
 * person-only route only on one path locks on that path.
 *
 * - The held run's Run, with every one of its nodes deleted since Accept, only releases the
 *   approval (DELETE /api/canvas/approvals/{id}): it locks with Dismiss and points at its line.
 *   With nodes left it runs and stays live. Any release a held tab reaches waits for the promote.
 * - Projects' Try again after a failed "Delete forever" or "Empty" (DELETE
 *   /api/projects/trash/{id}, POST /api/projects/trash/empty) locks as those buttons do; after
 *   any other failure it stays live.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: () => new Promise<Response>(() => {}),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
const approvals = vi.hoisted(() => ({ releaseApproval: vi.fn() }));
vi.mock('../src/lib/canvasProposals', async (original) => ({
  ...await original<typeof import('../src/lib/canvasProposals')>(),
  releaseApproval: (...args: unknown[]) => approvals.releaseApproval(...args),
}));

const session = await import('../src/lib/personSession');
const { HELD_LOOK_DELAY_MS } = await import('../src/hooks/useHeldLook');
const { DeferredRunNotice } = await import('../src/components/canvas/DeferredRunNotice');
const { ProjectHome } = await import('../src/components/projects/ProjectHome');
const { useCanvasProposalsStore, forgetHeldReleasesForTests } = await import('../src/store/canvasProposalsStore');
const { useGraphStore } = await import('../src/store/graphStore');
const { projectRetryPersonOnly } = await import('../src/store/projectStore');

const initialGraph = useGraphStore.getState();
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const pastFirstMoment = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, HELD_LOOK_DELAY_MS + 200); }));
const hold = async () => { act(() => session.reportPersonRequired()); await pastFirstMoment(); };
const promote = () => act(() => session.notePersonPromoted());

function lockLinesOf(element: Element): HTMLElement[] {
  return (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    .map((id) => document.getElementById(id))
    .filter((node): node is HTMLElement => !!node && node.classList.contains('person-lock-line'));
}

beforeEach(() => {
  session.resetPersonSessionForTests();
  forgetHeldReleasesForTests();
  approvals.releaseApproval.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  useCanvasProposalsStore.setState({ deferredRun: null, deferredQueue: [] });
  useGraphStore.setState(initialGraph, true);
});

const node = (id: string) => ({ id, type: 'text', position: { x: 0, y: 0 }, data: { label: id, params: {} } }) as unknown as Node<NodeData>;

describe('the held run: Run with nothing left to run', () => {
  const show = (nodesLeft: string[]) => {
    useGraphStore.setState({ nodes: nodesLeft.map(node), isExecuting: false, runStarting: false });
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Ada', nodeIds: ['n1'], approvalId: 'ap1' }, deferredQueue: [] });
    render(<DeferredRunNotice />);
    return screen.getByRole('button', { name: /Run/ });
  };

  it('locks with Dismiss, points at its one line, and releases nothing until the promote', async () => {
    await hold();
    const run = show([]);
    await pastFirstMoment();
    expect(run.getAttribute('aria-disabled')).toBe('true');
    expect(run.hasAttribute('data-person-lock')).toBe(true);
    const lines = lockLinesOf(run);
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe('You can dismiss this when this tab is connected as you.');
    expect(lockLinesOf(screen.getByRole('button', { name: 'Dismiss' }))).toEqual(lines);
    expect(document.querySelectorAll('.person-lock-line')).toHaveLength(1);
    fireEvent.click(run);
    await flush();
    expect(approvals.releaseApproval).not.toHaveBeenCalled();
    expect(useCanvasProposalsStore.getState().deferredRun).not.toBeNull();

    promote();
    await flush();
    expect(run.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(run);
    await flush();
    expect(approvals.releaseApproval).toHaveBeenCalledWith('ap1');
  });

  it('with its nodes on the canvas it stays live on a held tab', async () => {
    await hold();
    const run = show(['n1']);
    await pastFirstMoment();
    expect(run.hasAttribute('aria-disabled')).toBe(false);
    expect(run.hasAttribute('data-person-lock')).toBe(false);
  });

  it('a release a held tab reaches waits for the promote, then goes once', async () => {
    await hold();
    useGraphStore.setState({ nodes: [], isExecuting: false, runStarting: false });
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Ada', nodeIds: ['n1'], approvalId: 'ap2' }, deferredQueue: [] });
    await act(() => useCanvasProposalsStore.getState().runDeferred());
    expect(approvals.releaseApproval).not.toHaveBeenCalled();
    promote();
    await flush();
    expect(approvals.releaseApproval).toHaveBeenCalledTimes(1);
    expect(approvals.releaseApproval).toHaveBeenCalledWith('ap2');
  });
});

describe('Projects: Try again', () => {
  const renderHome = (retryPersonOnly: boolean) => {
    const onRetry = vi.fn();
    render(<ProjectHome projects={[]} loading={false} busy={false} error="Nebula couldn’t delete “Old” for good." onCreate={() => {}}
      onOpen={() => {}} onRename={() => {}} onDelete={() => {}} onRetry={onRetry} retry="redo" retryPersonOnly={retryPersonOnly} />);
    return { onRetry, button: screen.getByRole('button', { name: 'Try again' }) };
  };

  it('after a failed Delete forever or Empty it locks on a held tab and redoes after the promote', async () => {
    await hold();
    const { onRetry, button } = renderHome(true);
    await pastFirstMoment();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const lines = lockLinesOf(button);
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe('You can delete projects for good when this tab is connected as you.');
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    promote();
    await flush();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(document.querySelectorAll('.person-lock-line')).toHaveLength(0);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('after any other failure it stays live on a held tab', async () => {
    await hold();
    const { onRetry, button } = renderHome(false);
    await pastFirstMoment();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('which Try again is person-only', () => {
  it('only a redo of Delete forever or Empty', () => {
    expect(projectRetryPersonOnly({ errorRetry: { action: 'purge', id: 'p1' } })).toBe(true);
    expect(projectRetryPersonOnly({ errorRetry: { action: 'emptyTrash', ids: ['p1'] } })).toBe(true);
    for (const errorRetry of [null, { action: 'load' as const }, { action: 'list' as const }, { action: 'save' as const },
      { action: 'open' as const, id: 'p1' }, { action: 'create' as const }, { action: 'rename' as const, id: 'p1', name: 'x' },
      { action: 'delete' as const, id: 'p1' }, { action: 'restore' as const, id: 'p1' }, { action: 'cover' as const, id: 'p1', url: null },
      { action: 'reloadForUpdate' as const, version: null }]) {
      expect(projectRetryPersonOnly({ errorRetry }), JSON.stringify(errorRetry)).toBe(false);
    }
  });
});

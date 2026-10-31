/**
 * PR #204 round 7, GM r8 (4): the header's left group doesn't change width when nothing visible
 * changed. "Saved" folds away 2.6 s after a save (its 41 px, gap included). A header mounted
 * long after the save replayed that fold, so the group was 41 px wider for 2.6 s and then
 * narrowed. Round 8 (review 6 LOW-2): what mounts a new header is a screen change (Canvas to
 * Creator Studio); a demote and a promote re-render it in place. These tests pin the fold
 * resuming on a remount, and (round 8) that a demote and a promote change nothing in the group.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { resetSettleForTests, settleDelay } from '../src/lib/saveSettle';
import { useProjectStore } from '../src/store/projectStore';
import { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } from '../src/lib/personSession';

const status = () => document.querySelector<HTMLElement>('.project-workspace-controls__status');

beforeEach(() => {
  resetSettleForTests();
  resetPersonSessionForTests();
  useProjectStore.setState({ screen: 'workspace', saveStatus: 'saved', busy: false, error: null,
    activeProject: { id: 'glass', name: 'Glass campaign', createdAt: '', updatedAt: '', lastOpenedAt: null,
      nodeCount: 0, edgeCount: 0, thumbnail: null } } as never);
});
afterEach(() => { cleanup(); vi.useRealTimers(); notePersonPromoted(); });

describe('GM r8 (4): "Saved" keeps its place in its fold across a remount (a screen change)', () => {
  it('the delay that puts the fold where it was: none at the save, the time since after it, none once unsettled', () => {
    expect(settleDelay(true, 1_000)).toBeUndefined();
    expect(settleDelay(true, 4_200)).toBe('-3200ms');
    expect(settleDelay(false, 5_000)).toBeUndefined();
    expect(settleDelay(true, 9_000)).toBeUndefined();
  });

  it('each remount (a screen change) shows the fold as far along as it was, never again from the start', () => {
    vi.useFakeTimers({ now: 10_000 });
    const first = render(<ProjectWorkspaceControls />);
    expect(status()?.classList.contains('project-workspace-controls__status--settled')).toBe(true);
    expect(status()?.style.animationDelay).toBe('');
    first.unmount();
    // 30 s later, another screen mounts a new header.
    vi.setSystemTime(40_000);
    act(() => reportPersonRequired());
    const demoted = render(<ProjectWorkspaceControls />);
    expect(status()?.style.animationDelay).toBe('-30000ms');
    demoted.unmount();
    // 5 s after that, another.
    vi.setSystemTime(45_000);
    act(() => notePersonPromoted());
    render(<ProjectWorkspaceControls />);
    expect(status()?.style.animationDelay).toBe('-35000ms');
  });

  it('a new save starts its fold from the start', () => {
    vi.useFakeTimers({ now: 10_000 });
    const view = render(<ProjectWorkspaceControls />);
    act(() => useProjectStore.setState({ saveStatus: 'saving' }));
    vi.setSystemTime(20_000);
    act(() => useProjectStore.setState({ saveStatus: 'saved' }));
    expect(status()?.style.animationDelay).toBe('');
    view.unmount();
  });
});

describe('round 8, review 6 LOW-1: a re-render during the fold leaves it running', () => {
  it('the delay is taken once per settle, not on every render', () => {
    vi.useFakeTimers({ now: 10_000 });
    const view = render(<ProjectWorkspaceControls />);
    expect(status()?.style.animationDelay).toBe('');
    // 1.2 s into the fold, the header re-renders (a parent's state, a node count).
    vi.setSystemTime(11_200);
    act(() => useProjectStore.setState({ busy: true }));
    act(() => useProjectStore.setState({ busy: false }));
    view.rerender(<ProjectWorkspaceControls />);
    expect(status()?.style.animationDelay).toBe('');
    // A new save, then settled again: taken again, from the start.
    act(() => useProjectStore.setState({ saveStatus: 'saving' }));
    vi.setSystemTime(12_000);
    act(() => useProjectStore.setState({ saveStatus: 'saved' }));
    vi.setSystemTime(13_000);
    view.rerender(<ProjectWorkspaceControls />);
    expect(status()?.style.animationDelay).toBe('');
  });
});

describe('round 8, review 6 LOW-2: a demote and a promote change nothing in the group', () => {
  it('the same elements, the same markup and nothing hidden taking room, before, during and after', () => {
    vi.useFakeTimers({ now: 10_000 });
    render(<ProjectWorkspaceControls />);
    vi.setSystemTime(20_000);
    const group = document.querySelector<HTMLElement>('.project-workspace-controls')!;
    const parts = [...group.querySelectorAll('*')];
    const markup = group.outerHTML;
    act(() => reportPersonRequired());
    expect(document.querySelector('.project-workspace-controls')).toBe(group);
    expect([...group.querySelectorAll('*')]).toEqual(parts);
    expect(group.outerHTML).toBe(markup);
    act(() => notePersonPromoted());
    expect(document.querySelector('.project-workspace-controls')).toBe(group);
    expect([...group.querySelectorAll('*')]).toEqual(parts);
    expect(group.outerHTML).toBe(markup);
  });
});

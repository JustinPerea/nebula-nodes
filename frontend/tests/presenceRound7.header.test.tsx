/**
 * PR #204 round 7, GM r8 (4): the header's left group doesn't change width when nothing visible
 * changed. A demote and a promote remount the header; "Saved" had already folded away (its
 * 41 px, gap included), and the remount replayed its fold, so the group was 41 px wider for 2.6 s
 * and then narrowed. Its fold now carries on from where it was: a remount long after the save
 * shows it folded at once, the width the person was looking at.
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

describe('GM r8 (4): "Saved" keeps its place in its fold across a remount', () => {
  it('the delay that puts the fold where it was: none at the save, the time since after it, none once unsettled', () => {
    expect(settleDelay(true, 1_000)).toBeUndefined();
    expect(settleDelay(true, 4_200)).toBe('-3200ms');
    expect(settleDelay(false, 5_000)).toBeUndefined();
    expect(settleDelay(true, 9_000)).toBeUndefined();
  });

  it('across a demote and a promote, each remount shows the fold as far along as it was, never again from the start', () => {
    vi.useFakeTimers({ now: 10_000 });
    const first = render(<ProjectWorkspaceControls />);
    expect(status()?.classList.contains('project-workspace-controls__status--settled')).toBe(true);
    expect(status()?.style.animationDelay).toBe('');
    first.unmount();
    // Demoted 30 s later: the header comes back.
    vi.setSystemTime(40_000);
    act(() => reportPersonRequired());
    const demoted = render(<ProjectWorkspaceControls />);
    expect(status()?.style.animationDelay).toBe('-30000ms');
    demoted.unmount();
    // Promoted 5 s after that: the same.
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

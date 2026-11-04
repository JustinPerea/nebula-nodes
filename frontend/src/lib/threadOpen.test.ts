import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ goToCanvas: vi.fn(async () => {}), onCanvas: vi.fn(() => true) }));
vi.mock('./goToCanvas', () => ({
  goToCanvas: nav.goToCanvas,
  onCanvas: nav.onCanvas,
  whenReady: async (ready: () => boolean) => ready(),
}));

import { openThreadIn } from './threadOpen';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';

/** GM r100.3: the reply's Update ("Claude Code replied in “Coast”.") opens
 * the thread of the message it answered, in that message's project. */

let header: HTMLElement | null = null;

function project(id: string) {
  return { id, name: id } as never;
}

beforeEach(() => {
  header = document.createElement('div');
  header.className = 'agent-log__header';
  header.tabIndex = -1;
  document.body.appendChild(header);
  useUIStore.setState({ agentLogOpen: false });
  nav.goToCanvas.mockClear();
});

afterEach(() => {
  header?.remove();
  vi.restoreAllMocks();
});

describe('openThreadIn', () => {
  it('opens the other project, goes to its canvas and opens the Agent log', async () => {
    const open = vi.fn(async (id: string) => { useProjectStore.setState({ activeProject: project(id) }); });
    useProjectStore.setState({ activeProject: project('p1'), open } as never);
    await openThreadIn('p2');
    expect(open).toHaveBeenCalledWith('p2');
    expect(nav.goToCanvas).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().agentLogOpen).toBe(true);
  });

  it('the open project: no reopening, the log still opens', async () => {
    const open = vi.fn();
    useProjectStore.setState({ activeProject: project('p1'), open } as never);
    await openThreadIn('p1');
    expect(open).not.toHaveBeenCalled();
    expect(useUIStore.getState().agentLogOpen).toBe(true);
  });

  it('says why when it can’t', async () => {
    useProjectStore.setState({ activeProject: project('p1'), open: vi.fn(async () => {}) } as never);
    await expect(openThreadIn(undefined)).rejects.toThrow("This update's thread can't be opened from here.");
    await expect(openThreadIn('p2')).rejects.toThrow("The project didn't open. Try again.");
    header?.remove();
    header = null;
    await expect(openThreadIn('p1')).rejects.toThrow("The Agent log didn't open. Try again.");
    expect(useUIStore.getState().agentLogOpen).toBe(false);
  });
});

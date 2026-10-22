import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An agent's open_project while the Commons holds unsaved labels opens the
 * project behind the Commons (#163); the person stays to save or discard.
 * The toast that says who switched it must not time out meanwhile
 * (commons-leave, GM - Design): no timer while they're still in the Commons
 * after the held switch, then its usual 15 s once they reach the canvas.
 */

const { ProjectSwitchToast } = await import('../src/components/projects/ProjectSwitchToast');
const { useProjectStore } = await import('../src/store/projectStore');
const { useUIStore } = await import('../src/store/uiStore');

const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const NOTICE = {
  actorName: 'Claude Code', created: false, projectName: 'Beta',
  previousProjectId: 'alpha', previousProjectName: 'Alpha', keptCopy: false,
};
const toast = () => screen.queryByText('Claude Code opened “Beta”.');

beforeEach(() => {
  vi.useFakeTimers();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
});

describe('the project-switch toast', () => {
  it('keeps no timer while the switch is held behind the Commons, then starts its 15 s on the canvas', () => {
    useUIStore.setState({ viewMode: 'commons', commonsEnabled: true });
    useProjectStore.setState({ screen: 'workspace' });
    render(<ProjectSwitchToast />);
    act(() => { useProjectStore.setState({ switchNotice: NOTICE }); });
    expect(toast()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(toast()).toBeTruthy();

    act(() => { useUIStore.setState({ viewMode: 'canvas' }); });
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(toast()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(toast()).toBeNull();
    expect(useProjectStore.getState().switchNotice).toBeNull();
  });

  // Review: Projects keeps viewMode 'commons' and #commons (#163), and App
  // shows Projects over the Commons (isHome wins), so leaving by Projects is
  // reaching Projects, not staying in the Commons.
  it('starts its 15 s once the person leaves the Commons by Projects', () => {
    useUIStore.setState({ viewMode: 'commons', commonsEnabled: true });
    useProjectStore.setState({ screen: 'workspace' });
    render(<ProjectSwitchToast />);
    act(() => { useProjectStore.setState({ switchNotice: NOTICE }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(toast()).toBeTruthy();

    act(() => { useProjectStore.setState({ screen: 'home' }); });
    expect(useUIStore.getState().viewMode).toBe('commons');
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(toast()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(useProjectStore.getState().switchNotice).toBeNull();
  });

  it('times out after 15 s from Projects even with the Commons behind it', () => {
    useUIStore.setState({ viewMode: 'commons', commonsEnabled: true });
    useProjectStore.setState({ screen: 'home' });
    render(<ProjectSwitchToast />);
    act(() => { useProjectStore.setState({ switchNotice: NOTICE }); });
    act(() => { vi.advanceTimersByTime(15_500); });
    expect(useProjectStore.getState().switchNotice).toBeNull();
  });

  it('times out after 15 s as before when the switch reached the canvas', () => {
    useUIStore.setState({ viewMode: 'canvas', commonsEnabled: true });
    render(<ProjectSwitchToast />);
    act(() => { useProjectStore.setState({ switchNotice: NOTICE }); });
    act(() => { vi.advanceTimersByTime(15_500); });
    expect(toast()).toBeNull();
  });
});

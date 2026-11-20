// Design: until the first load lands, "New project" waits, and says why when the server is what it
// waits on; the line that says Nebula is trying again has "Try now"; leaving the screen stops the tries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import { ProjectCoordinator } from './ProjectCoordinator';
import { FIRST_LOAD_RETRYING_COPY, NEW_PROJECT_WAITING_TITLE } from '../../lib/errorCopy';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const initialize = vi.fn(async () => {});
const stop = vi.fn();
vi.mock('../../store/projectStore', () => ({
  subscribeProjectAutosave: () => () => {},
  useProjectStore: { getState: () => ({ initialize }) },
  stopFirstLoadRetry: () => stop(),
  wakeFirstLoad: vi.fn(),
}));

const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});

beforeEach(() => { initialize.mockClear(); stop.mockClear(); });
afterEach(() => cleanup());

describe('New project before the first load lands', () => {
  it('is off with the lock reason in its title, and a press does nothing', () => {
    const onCreate = vi.fn();
    render(<ProjectHome {...props({ onCreate, workLoaded: false, serverWaiting: true, error: FIRST_LOAD_RETRYING_COPY, retry: 'retrying' })} />);
    const button = screen.getByRole('button', { name: 'New project' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('You can make a project when Nebula reaches its server.');
    expect(button.getAttribute('title')).toBe(NEW_PROJECT_WAITING_TITLE);
    fireEvent.click(button);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('is off without the server reason when something else stopped the load', () => {
    render(<ProjectHome {...props({ workLoaded: false, serverWaiting: false, error: 'Something else.', retry: 'reload' })} />);
    const button = screen.getByRole('button', { name: 'New project' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBeNull();
  });

  it('works once the load landed', () => {
    const onCreate = vi.fn();
    render(<ProjectHome {...props({ onCreate })} />);
    const button = screen.getByRole('button', { name: 'New project' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('title')).toBeNull();
    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('shows no empty state with a dead button while nothing is loaded', () => {
    render(<ProjectHome {...props({ workLoaded: false })} />);
    expect(screen.queryByText('Your first project starts here.')).toBeNull();
  });
});

describe('the line while Nebula tries again', () => {
  it('reads as written, with Try now', () => {
    const onRetry = vi.fn();
    render(<ProjectHome {...props({ onRetry, workLoaded: false, serverWaiting: true, error: FIRST_LOAD_RETRYING_COPY, retry: 'retrying' })} />);
    expect(screen.getByRole('alert').textContent).toContain('Nebula can’t reach its server yet. Trying again…');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('the coordinator', () => {
  it('starts the load on mount and stops the tries on unmount', () => {
    const { unmount } = render(<ProjectCoordinator />);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

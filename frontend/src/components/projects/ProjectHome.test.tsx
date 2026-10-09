import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary } from './ProjectHome';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const project = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'glass', name: 'Glass campaign', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-09T12:00:00Z',
  lastOpenedAt: '2026-10-09T14:00:00Z', nodeCount: 4, edgeCount: 2, thumbnail: null, ...overrides,
});

const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [project()], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onRetry: vi.fn(), ...overrides,
});

describe('ProjectHome', () => {
  it('shows saved project metadata and opens only the explicitly selected project', () => {
    const actions = props();
    render(<ProjectHome {...actions} />);
    expect(screen.getByRole('heading', { name: 'Recent projects' })).toBeTruthy();
    expect(screen.getByText('4 nodes')).toBeTruthy();
    expect(screen.getByText(/Edited/)).toBeTruthy();
    expect(actions.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Glass campaign' }));
    expect(actions.onOpen).toHaveBeenCalledWith('glass');
  });

  it('sorts recent projects without mutating the supplied list, searches names, and clears an empty result', () => {
    const saved = [project({ id: 'older', name: 'Logo explorations', lastOpenedAt: null, updatedAt: '2026-10-01T12:00:00Z' }), project()];
    render(<ProjectHome {...props({ projects: saved })} />);
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual(['Glass campaign', 'Logo explorations']);
    expect(saved[0].id).toBe('older');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: '  LOGO ' } });
    expect(screen.queryByRole('button', { name: 'Open Glass campaign' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Logo explorations' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
    expect(screen.getByRole('heading', { name: 'No projects match “no match”' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('creates a first blank project without rendering invented examples', () => {
    const actions = props({ projects: [] });
    render(<ProjectHome {...actions} />);
    expect(screen.getByRole('heading', { name: 'Your first project starts here.' })).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create your first project' }));
    expect(actions.onCreate).toHaveBeenCalledWith();
  });

  it('renames inline with trimmed names, rejects blank submissions, and can cancel with Escape', () => {
    const actions = props();
    render(<ProjectHome {...actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Glass campaign' }));
    expect(screen.getByRole('button', { name: 'Open Glass campaign' }).hasAttribute('disabled')).toBe(true);
    const input = screen.getByRole('textbox', { name: 'Project name' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save project name' }).hasAttribute('disabled')).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Rename Glass campaign' }));
    expect(actions.onRename).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  Glass launch  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project name' }));
    expect(actions.onRename).toHaveBeenCalledWith('glass', 'Glass launch');
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Glass campaign' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Project name' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(actions.onRename).toHaveBeenCalledTimes(1);
  });

  it('loads actual backend thumbnails and replaces a broken image with a graph placeholder', () => {
    render(<ProjectHome {...props({ projects: [project({ thumbnail: '/api/outputs/project/image.png' })] })} />);
    const card = screen.getByRole('article');
    const image = card.querySelector('img');
    expect(image?.getAttribute('src')).toBe('http://127.0.0.1:8060/api/outputs/project/image.png');
    expect(image?.getAttribute('alt')).toBe('');
    fireEvent.error(image!);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.project-home__graph')).toBeTruthy();
  });

  it('displays a load failure with a retry action rather than the first-install empty state', () => {
    const actions = props({ projects: [], error: 'Projects could not be loaded.' });
    render(<ProjectHome {...actions} />);
    expect(within(screen.getByRole('alert')).getByText('Projects could not be loaded.')).toBeTruthy();
    expect(screen.queryByText('Your first project starts here.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(actions.onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables mutating actions while busy and exposes loading before a project list arrives', () => {
    const { rerender } = render(<ProjectHome {...props({ busy: true, error: 'Please retry.' })} />);
    for (const name of ['New project', 'Open Glass campaign', 'Rename Glass campaign', 'Try again']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
    rerender(<ProjectHome {...props({ projects: [], loading: true })} />);
    expect(screen.getByRole('status').textContent).toContain('Loading your projects');
    expect(screen.queryByText('Your first project starts here.')).toBeNull();
  });

  it('handles invalid saved timestamps and very long names without throwing', () => {
    const name = 'A'.repeat(120);
    render(<ProjectHome {...props({ projects: [project({ name, updatedAt: 'invalid', lastOpenedAt: 'invalid', nodeCount: 1, edgeCount: 1 })] })} />);
    expect(screen.getByRole('button', { name: `Open ${name}` })).toBeTruthy();
    expect(screen.getByText('Saved project')).toBeTruthy();
    expect(screen.getByText('1 node')).toBeTruthy();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary } from './ProjectHome';
import { useAssetProposalsStore } from '../../store/assetProposalsStore';
import { coverProposal } from '../../test/assetProposalFixtures';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const project = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'glass', name: 'Glass campaign', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-09T12:00:00Z',
  lastOpenedAt: '2026-10-09T14:00:00Z', nodeCount: 4, edgeCount: 2, thumbnail: null, ...overrides,
});

const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [project()], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(),
  onRestore: vi.fn(), onPurge: vi.fn(), onEmptyTrash: vi.fn(), onDismissUndo: vi.fn(), ...overrides,
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

  it('moves a project to Recently deleted in one click and offers Undo', () => {
    vi.useFakeTimers();
    const actions = props();
    const { rerender } = render(<ProjectHome {...actions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Glass campaign' }));
    expect(actions.onDelete).toHaveBeenCalledWith('glass');
    rerender(<ProjectHome {...props({ ...actions, projects: [], lastDeleted: { id: 'glass', name: 'Glass campaign' } })} />);
    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('Moved “Glass campaign” to Recently deleted');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(actions.onRestore).toHaveBeenCalledWith('glass');
    // Hovering holds the toast; leaving lets it time out.
    fireEvent.mouseEnter(toast);
    vi.advanceTimersByTime(20_000);
    expect(actions.onDismissUndo).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    vi.advanceTimersByTime(8000);
    expect(actions.onDismissUndo).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('lists recently deleted projects with restore and a two-step permanent delete', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const trashed = { ...project({ id: 'old', name: 'Old sketch' }), deletedAt: '2026-10-10T11:00:00Z', purgeAt: '2026-11-09T11:00:00Z' };
    const actions = props({ trash: [trashed] });
    render(<ProjectHome {...actions} />);
    const toggle = screen.getByRole('button', { name: 'Recently deleted, 1 project' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Restore Old sketch' })).toBeNull();
    fireEvent.click(toggle);
    const row = screen.getByRole('listitem', { name: 'Old sketch' });
    expect(row.textContent).toContain('Removed for good in 30 days');
    fireEvent.click(within(row).getByRole('button', { name: 'Restore Old sketch' }));
    expect(actions.onRestore).toHaveBeenCalledWith('old');
    fireEvent.click(within(row).getByRole('button', { name: 'Delete forever' }));
    const confirm = within(row).getByRole('group', { name: 'This can’t be undone.' });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(confirm, { key: 'Escape' });
    expect(actions.onPurge).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Delete forever' }));
    fireEvent.click(within(row).getAllByRole('button', { name: 'Delete forever' })[0]);
    expect(actions.onPurge).toHaveBeenCalledWith('old');
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    expect(actions.onEmptyTrash).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('says an agent deleted a project from its kind, even when it calls itself "You"', () => {
    const base = { deletedAt: '2026-10-10T11:00:00Z', purgeAt: '2026-11-09T11:00:00Z' };
    render(<ProjectHome {...props({ trash: [
      { ...project({ id: 'a', name: 'By agent' }), ...base, deletedBy: { kind: 'agent', name: 'Y\u043eu' } },
      { ...project({ id: 'p', name: 'By person' }), ...base, deletedBy: { kind: 'person', name: 'You' } },
    ] })} />);
    fireEvent.click(screen.getByRole('button', { name: /Recently deleted/ }));
    expect(screen.getByRole('listitem', { name: 'By agent' }).textContent).toContain('by Y\u043eu (agent)');
    expect(screen.getByRole('listitem', { name: 'By person' }).textContent).not.toContain(' by ');
  });

  it('hides Recently deleted when the trash is empty', () => {
    render(<ProjectHome {...props({ trash: [] })} />);
    expect(screen.queryByRole('button', { name: /Recently deleted/ })).toBeNull();
  });

  it('shows only one of rename or delete at a time', () => {
    render(<ProjectHome {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Glass campaign' }));
    expect(screen.getByRole('button', { name: 'Delete Glass campaign' }).hasAttribute('disabled')).toBe(true);
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

  it('shows the project’s cover image, and a 2x2 mosaic when it has only references', () => {
    render(<ProjectHome {...props({ projects: [
      project({ id: 'made', name: 'Made', thumbnail: '/api/outputs/old.png', cover: { source: 'output', images: ['/api/outputs/new.png'] } }),
      project({ id: 'refs', name: 'Refs', cover: { source: 'references', images: ['/api/outputs/a.png', '/api/outputs/b.png', '/api/outputs/c.png', '/api/outputs/d.png'] } }),
    ] })} />);
    const made = screen.getByRole('article', { name: 'Made' });
    expect([...made.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['http://127.0.0.1:8060/api/outputs/new.png']);
    const refs = screen.getByRole('article', { name: 'Refs' });
    const mosaic = within(refs).getByTestId('project-cover-mosaic');
    expect(mosaic.className).toContain('project-home__mosaic--4');
    expect(mosaic.querySelectorAll('img')).toHaveLength(4);
    // A broken tile drops out; the rest stay.
    fireEvent.error(mosaic.querySelector('img')!);
    expect(refs.querySelectorAll('img')).toHaveLength(3);
  });

  it('lets the person pin a cover from the project’s images, or go back to automatic', async () => {
    const onPinCover = vi.fn();
    const loadCoverChoices = vi.fn(async () => ({
      images: [{ url: '/api/outputs/new.png', kind: 'output' as const }, { url: '/api/outputs/ref.png', kind: 'reference' as const }],
      pinned: '/api/outputs/ref.png', cover: { source: 'pinned' as const, images: ['/api/outputs/ref.png'] },
    }));
    render(<ProjectHome {...props({ loadCoverChoices, onPinCover })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a cover for Glass campaign' }));
    expect(loadCoverChoices).toHaveBeenCalledWith('glass');
    const pinned = await screen.findByRole('button', { name: 'Use this reference as the cover' });
    expect(pinned.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Use this image as the cover' }));
    expect(onPinCover).toHaveBeenCalledWith('glass', '/api/outputs/new.png');
    expect(screen.queryByRole('group', { name: 'Cover for Glass campaign' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a cover for Glass campaign' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Automatic' }));
    expect(onPinCover).toHaveBeenLastCalledWith('glass', null);
  });

  it('names the agent that made a project', () => {
    render(<ProjectHome {...props({ projects: [project({ createdBy: { kind: 'agent', name: 'Claude Code' } })] })} />);
    expect(screen.getByText(/Made by Claude Code/)).toBeTruthy();
  });

  it('displays a load failure with a retry action rather than the first-install empty state', () => {
    const actions = props({ projects: [], error: 'Projects could not be loaded.' });
    render(<ProjectHome {...actions} />);
    expect(within(screen.getByRole('alert')).getByText('Projects could not be loaded.')).toBeTruthy();
    expect(screen.queryByText('Your first project starts here.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(actions.onRetry).toHaveBeenCalledTimes(1);
  });

  it('error-copy round 2 (GM\'s WRAP rule): beside "Try again" the reason drops its own "try again"', () => {
    render(<ProjectHome {...props({ projects: [], error: "Couldn't load your projects. Nebula didn't respond. Try again." })} />);
    expect(screen.getByRole('alert').querySelector('span')?.textContent)
      .toBe("Couldn't load your projects. Nebula didn't respond.");
  });

  it('error-copy round 3b: Try again shows only where it redoes the failure, and keeps the full line where it only reloads', () => {
    const line = "Couldn't open the project. Nebula didn't respond. Try again.";
    const { rerender } = render(<ProjectHome {...props({ error: line, retry: 'redo' })} />);
    expect(screen.getByRole('alert').querySelector('span')?.textContent).toBe("Couldn't open the project. Nebula didn't respond.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // A refusal the same request would get again: no Try again, the whole line.
    const refusal = "Couldn't open the project. A World Labs start needs checking. Open Run History and choose “Check Marble”.";
    rerender(<ProjectHome {...props({ error: refusal, retry: 'none' })} />);
    expect(screen.getByRole('alert').textContent).toBe(refusal);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // Try again only reloads the saved projects: the button stays, the line stays whole.
    rerender(<ProjectHome {...props({ error: "Couldn't load the project. Nebula didn't respond. Try again.", retry: 'reload' })} />);
    expect(screen.getByRole('alert').querySelector('span')?.textContent).toBe("Couldn't load the project. Nebula didn't respond. Try again.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('disables mutating actions while busy and exposes loading before a project list arrives', () => {
    const { rerender } = render(<ProjectHome {...props({ busy: true, error: 'Please retry.' })} />);
    for (const name of ['New project', 'Open Glass campaign', 'Rename Glass campaign', 'Delete Glass campaign', 'Try again']) {
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
  it('opens Settings from the header and reflects whether it is open', () => {
    const onToggleSettings = vi.fn();
    const { rerender } = render(<ProjectHome {...props({ onToggleSettings })} />);
    const button = screen.getByRole('button', { name: 'Settings' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(onToggleSettings).toHaveBeenCalledTimes(1);
    rerender(<ProjectHome {...props({ onToggleSettings, settingsOpen: true })} />);
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('hides the Settings button when nothing handles it', () => {
    render(<ProjectHome {...props()} />);
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('shows an agent’s cover proposal on its project’s card only', async () => {
    useAssetProposalsStore.getState().clear();
    useAssetProposalsStore.getState().open(coverProposal({ target: { kind: 'project', id: 'glass', name: 'Glass campaign' } }), 'k1');
    render(<ProjectHome {...props({ projects: [project(), project({ id: 'logo', name: 'Logo explorations' })] })} />);
    const glass = screen.getByRole('article', { name: 'Glass campaign' });
    expect(await within(glass).findByRole('group', { name: 'Claude Code proposes a new cover' })).toBeTruthy();
    const logo = screen.getByRole('article', { name: 'Logo explorations' });
    expect(within(logo).queryByRole('group')).toBeNull();
    useAssetProposalsStore.getState().clear();
  });

  it('says when an agent set the cover', async () => {
    const choices = { images: [{ url: '/api/outputs/a.png', kind: 'output' as const }], pinned: '/api/outputs/a.png',
      cover: { source: 'pinned' as const, images: ['/api/outputs/a.png'] }, pinnedBy: { kind: 'agent', name: 'Codex' } };
    render(<ProjectHome {...props({
      projects: [project({ cover: choices.cover, coverBy: { kind: 'agent', name: 'Codex' } })],
      loadCoverChoices: vi.fn().mockResolvedValue(choices), onPinCover: vi.fn() })} />);
    const button = screen.getByRole('button', { name: 'Choose a cover for Glass campaign' });
    expect(button.getAttribute('title')).toBe('Cover: set by Codex (agent)');
    fireEvent.click(button);
    expect(await screen.findByText('Cover · set by Codex (agent)')).toBeTruthy();
  });
  it('says the cover went automatic when the pinned image left the project (Q90 a)', async () => {
    const choices = { images: [{ url: '/api/outputs/b.png', kind: 'output' as const }], pinned: null,
      cover: { source: 'output' as const, images: ['/api/outputs/b.png'] }, pinnedBy: null,
      lostPin: { url: '/api/outputs/a.png', by: { kind: 'person', name: 'You' } } };
    render(<ProjectHome {...props({
      projects: [project({ cover: choices.cover, coverLostPin: choices.lostPin })],
      loadCoverChoices: vi.fn().mockResolvedValue(choices), onPinCover: vi.fn() })} />);
    const button = screen.getByRole('button', { name: 'Choose a cover for Glass campaign' });
    expect(button.getAttribute('title')).toBe('Choose cover');
    fireEvent.click(button);
    expect(await screen.findByText('The image you pinned is no longer in this project, so the cover is automatic.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe('true');
  });
});

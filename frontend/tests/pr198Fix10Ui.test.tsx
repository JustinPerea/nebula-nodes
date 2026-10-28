import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 10 (review 9; GM r14, r15), rendered:
 * - GM r14 item 1: the recovered copy's notice is not a toast. It is the
 *   inline notice at the top of Projects home, first in a real stack of
 *   notices (then the held edits or where they went, then the error).
 * - GM r15 answer 2: closing a notice moves focus to the next notice in the
 *   stack, onto its first control; if it was the last, to the one before;
 *   with the stack empty, to the "Recent projects" heading (tabindex -1, no
 *   ring). Never to the body.
 * - GM r15 answer 3: a click on the "Unsaved" mark opens the popover and does
 *   nothing else: no selection, no drag start.
 * - Review 9 M-3 (GM r14: the bar follows the card): the project bar says
 *   "Unsaved changes" while a scene card is unsaved, though the project saved.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/backend')>()),
  backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}`,
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SceneUnsavedMark } from '../src/components/nodes/SceneUnsavedMark';
import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { copyDeletedAfterUpdateLine } from '../src/store/projectStore';

afterEach(cleanup);

const IN_TRASH = copyDeletedAfterUpdateLine('Alpha (recovered)', false);
const GONE = copyDeletedAfterUpdateLine('Alpha (recovered)', true);
const TOO_LARGE = 'These edits are too large for Nebula to save. Download them so nothing is lost, or continue without them.';
type HomeProps = ProjectHomeProps & { retry?: 'redo' | 'reloadNebula' | 'none' };
const props = (overrides: Partial<HomeProps> = {}): HomeProps => ({
  projects: [], loading: false, busy: false, error: null, retry: 'redo',
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});
const Home = ProjectHome as unknown as (props: HomeProps) => ReturnType<typeof ProjectHome>;
const copyNotice = (restore = true) => ({ line: restore ? IN_TRASH : GONE,
  restore: restore ? { id: 'r', name: 'Alpha (recovered)' } : null });
const stackOrder = (container: HTMLElement) => Array.from(container.querySelectorAll('.project-home__notices > [data-notice]'))
  .map((element) => element.getAttribute('data-notice'));

describe('GM r14 item 1: the recovered copy’s notice, inline and first in the stack', () => {
  it('under the header in the notice slot, neutral, with [Restore] and ×; never a toast', () => {
    const { container } = render(<Home {...props({ copyNotice: copyNotice() })} />);
    const notice = container.querySelector('[data-copy-notice]') as HTMLElement;
    expect(notice.closest('main')).toBeTruthy();
    expect(notice.closest('.project-home__notices')).toBeTruthy();
    expect(notice.classList.contains('project-home__notice')).toBe(true);
    expect(container.querySelector('.project-home__toast')).toBeNull();
    expect(within(notice).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent))
      .toEqual(['Restore', 'Dismiss']);
    // It sits above the projects, after the welcome.
    const projects = container.querySelector('.project-home__projects') as HTMLElement;
    expect(notice.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with the held edits: both show, stacked, the copy’s notice first', () => {
    const { container } = render(<Home {...props({ copyNotice: copyNotice(), unsavedEdits: { reason: TOO_LARGE } })} />);
    expect(stackOrder(container)).toEqual(['copy', 'held']);
    expect(screen.getByText(IN_TRASH)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download your edits' })).toBeTruthy();
  });

  it('with an error: both show, the copy’s notice first', () => {
    const { container } = render(<Home {...props({ copyNotice: copyNotice(), error: 'Couldn’t open “Alpha (recovered)”.' })} />);
    expect(stackOrder(container)).toEqual(['copy', 'error']);
  });

  it('with the line that says where the edits went: copy first, then the line', () => {
    const { container } = render(<Home {...props({ copyNotice: copyNotice(), editsSavedAs: { name: 'Alpha.nebula', reopens: true } })} />);
    expect(stackOrder(container)).toEqual(['copy', 'saved']);
  });

  it('no notice: no stack', () => {
    const { container } = render(<Home {...props()} />);
    expect(container.querySelector('.project-home__notices')).toBeNull();
  });
});

describe('GM r15 answer 2: where focus goes when a notice closes', () => {
  it('the next notice: closing the copy’s notice moves focus to the error’s first control', async () => {
    const view = render(<Home {...props({ copyNotice: copyNotice(), error: 'Couldn’t load your projects.' })} />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    view.rerender(<Home {...props({ copyNotice: null, error: 'Couldn’t load your projects.' })} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' })));
  });

  it('the next notice with no control of its own: the line that says where the edits went', async () => {
    const saved = { name: 'Alpha.nebula', reopens: true };
    const view = render(<Home {...props({ copyNotice: copyNotice(), editsSavedAs: saved })} />);
    screen.getByRole('button', { name: 'Restore' }).focus();
    view.rerender(<Home {...props({ copyNotice: null, editsSavedAs: saved })} />);
    await waitFor(() => expect(document.activeElement?.classList.contains('project-home__notice')).toBe(true));
    expect(document.activeElement?.textContent).toContain('Alpha.nebula');
  });

  it('the next notice with no control (an error with no Try again): the error box itself, never the body', async () => {
    const view = render(<Home {...props({ copyNotice: copyNotice(), retry: 'none', error: 'Couldn’t load your projects.' })} />);
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    view.rerender(<Home {...props({ copyNotice: null, retry: 'none', error: 'Couldn’t load your projects.' })} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });

  it('the last one: focus goes to the one before, onto [Restore]', async () => {
    const view = render(<Home {...props({ copyNotice: copyNotice(), unsavedEdits: { reason: TOO_LARGE } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continue without them' }));
    view.rerender(<Home {...props({ copyNotice: copyNotice() })} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restore' })));
  });

  it('the last one, before it a notice with no [Restore]: onto its ×', async () => {
    const view = render(<Home {...props({ copyNotice: copyNotice(false), unsavedEdits: { reason: TOO_LARGE } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Continue without them' }));
    view.rerender(<Home {...props({ copyNotice: copyNotice(false) })} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' })));
  });

  it('the stack empty: the "Recent projects" heading, a focus target with tabindex -1; never the body', async () => {
    const view = render(<Home {...props({ copyNotice: copyNotice() })} />);
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    view.rerender(<Home {...props({ copyNotice: null })} />);
    const heading = screen.getByRole('heading', { name: 'Recent projects' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('[Restore] closes it the same way', async () => {
    const view = render(<Home {...props({ copyNotice: copyNotice() })} />);
    screen.getByRole('button', { name: 'Restore' }).focus();
    view.rerender(<Home {...props({ copyNotice: null })} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Recent projects' })));
  });

  it('never takes focus from something the person moved to', async () => {
    const view = render(<><Home {...props({ copyNotice: copyNotice(), error: 'Couldn’t load your projects.' })} /><input aria-label="Elsewhere" /></>);
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' });
    elsewhere.focus();
    view.rerender(<><Home {...props({ copyNotice: null, error: 'Couldn’t load your projects.' })} /><input aria-label="Elsewhere" /></>);
    await new Promise((done) => setTimeout(done, 20));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('the heading never shows a ring; the saved line and the notice’s buttons ring from the keyboard only', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/project-home.css'), 'utf8');
    expect(css).toMatch(/#recent-projects-title:focus \{ outline: none; \}/);
    expect(css).toMatch(/\.project-home__notice-restore:focus-visible,\s*body\.app-slava-restraint \.project-home__notice-close:focus-visible \{ outline: var\(--sr-focus-outline\)/);
    expect(css).not.toMatch(/project-home__notice-(restore|close):focus \{/);
  });
});

const STOPPED = 'Couldn’t save your changes to “Opening”. They’re kept and Nebula will try again with your next change.';

describe('GM r15 answer 3: a click on the "Unsaved" mark does nothing else', () => {
  it('the press and the click never reach the card (no selection, no drag start); the popover opens', () => {
    const card = { pointerDown: vi.fn(), mouseDown: vi.fn(), click: vi.fn(), doubleClick: vi.fn() };
    render(
      <div onPointerDown={card.pointerDown} onMouseDown={card.mouseDown} onClick={card.click} onDoubleClick={card.doubleClick}>
        <SceneUnsavedMark nodeId="n1" line={STOPPED} stopped />
      </div>,
    );
    const mark = screen.getByRole('button', { name: 'Unsaved' });
    expect(mark.classList.contains('nodrag')).toBe(true);
    fireEvent.pointerDown(mark);
    fireEvent.mouseDown(mark);
    fireEvent.click(mark);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.doubleClick(mark);
    expect(card.pointerDown).not.toHaveBeenCalled();
    expect(card.mouseDown).not.toHaveBeenCalled();
    expect(card.click).not.toHaveBeenCalled();
    expect(card.doubleClick).not.toHaveBeenCalled();
  });

  it('nor do presses inside the popover (a portal, still inside the card in React’s tree)', () => {
    const card = { pointerDown: vi.fn(), click: vi.fn() };
    useGraphStore.setState({ retrySceneSave: vi.fn() } as never);
    render(<div onPointerDown={card.pointerDown} onClick={card.click}><SceneUnsavedMark nodeId="n1" line={STOPPED} stopped /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Unsaved' }));
    const popover = screen.getByRole('dialog');
    fireEvent.pointerDown(within(popover).getByText(STOPPED));
    fireEvent.click(within(popover).getByText(STOPPED));
    fireEvent.click(within(popover).getByRole('button', { name: 'Try again' }));
    expect(card.pointerDown).not.toHaveBeenCalled();
    expect(card.click).not.toHaveBeenCalled();
  });

  it('Enter and Space on the mark stay with it too (React Flow’s node selects on them)', () => {
    const keyDown = vi.fn();
    render(<div onKeyDown={keyDown}><SceneUnsavedMark nodeId="n1" line={STOPPED} stopped /></div>);
    const mark = screen.getByRole('button', { name: 'Unsaved' });
    fireEvent.keyDown(mark, { key: 'Enter' });
    fireEvent.keyDown(mark, { key: ' ' });
    expect(keyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(mark, { key: 'Tab' });
    expect(keyDown).toHaveBeenCalledTimes(1);
  });

  it('the popover’s [Try again] rings from :focus-visible only, never a forced ring (GM r14 FOCUS)', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/canvasProposals.css'), 'utf8');
    expect(css).toMatch(/\.scene-unsaved-popover \.canvas-undo-notice__action:focus-visible \{/);
    expect(css).toMatch(/\.scene-unsaved-popover \.canvas-undo-notice__action:focus:not\(:focus-visible\) \{\s*outline: none;/);
  });
});

describe('review 9, M-3: the project bar follows the card', () => {
  const initialProject = useProjectStore.getState();
  const project = { id: 'alpha', name: 'Glass campaign', createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 1,
    edgeCount: 0, thumbnail: null };
  beforeEach(() => {
    useProjectStore.setState({ activeProject: project as never, screen: 'workspace', saveStatus: 'saved' });
    useGraphStore.setState({ nodes: [], edges: [], unsavedScenes: {}, stoppedScenes: {} } as never);
  });
  afterEach(() => useProjectStore.setState(initialProject, true));

  it('"Saved" with no unsaved scene; "Unsaved changes" while a card is unsaved, though the project saved', () => {
    render(<ProjectWorkspaceControls />);
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => useGraphStore.setState({ unsavedScenes: { n1: STOPPED }, stoppedScenes: { n1: true } } as never));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.queryByText('Saved')).toBeNull();
    // The project's own autosave cycling doesn't read as safe either.
    act(() => useProjectStore.setState({ saveStatus: 'saving' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    act(() => useGraphStore.setState({ unsavedScenes: {}, stoppedScenes: {} } as never));
    act(() => useProjectStore.setState({ saveStatus: 'saved' }));
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('a failed project save still says so first', () => {
    useProjectStore.setState({ saveStatus: 'error' });
    useGraphStore.setState({ unsavedScenes: { n1: STOPPED } } as never);
    render(<ProjectWorkspaceControls />);
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });
});

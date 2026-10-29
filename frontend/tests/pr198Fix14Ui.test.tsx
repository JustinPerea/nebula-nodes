import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 14 (GM r22), rendered:
 * - Q2: after Try again saved the tab's edits as a recovered project, the
 *   banner's place holds a neutral notice with [Open] and ×: "Your latest
 *   edits were saved as their own project, “<name>”." Focus goes to its ×,
 *   never [Open]; [Open] opens that project.
 * - Q1: the "Unsaved" mark's popover, opened, takes the toast with the same
 *   line and [Try again] off the canvas; closed, it brings none back.
 * - GM r23 answer 2: the clash prompt asked again in place of the delete
 *   toast has no ×, so focus goes to the prompt itself, never [Keep mine].
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));

import { SceneUnsavedMark } from '../src/components/nodes/SceneUnsavedMark';
import { SceneClashNotices } from '../src/components/canvas/SceneClashNotice';
import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { useGraphStore } from '../src/store/graphStore';
import { editsSavedAsProjectLine } from '../src/store/projectStore';

afterEach(cleanup);

const BANNER = 'The active project changed in another window. Try again to save your unsaved edits as a recovered project.';
const LINE = 'Your latest edits were saved as their own project, “Recovered canvas (recovered)”.';
const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});
const savedAs = { line: editsSavedAsProjectLine('Recovered canvas (recovered)'), restore: null,
  open: { id: 'p9', name: 'Recovered canvas (recovered)' } };

describe('GM r22 Q2: the saved-as notice takes the banner’s place', () => {
  it('GM’s line with the real name, [Open] and ×; focus on its ×, never [Open]', () => {
    expect(savedAs.line).toBe(LINE);
    const onOpenCopy = vi.fn();
    const { container, rerender } = render(<ProjectHome {...props({ error: BANNER, retry: 'reload' })} />);
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    tryAgain.focus();
    // Try again: the banner goes while the projects load, then the notice comes.
    rerender(<ProjectHome {...props({ loading: true })} />);
    rerender(<ProjectHome {...props({ copyNotice: savedAs, onOpenCopy })} />);
    const notices = Array.from(container.querySelectorAll('.project-home__notices > [data-notice]'));
    expect(notices.map((element) => element.getAttribute('data-notice'))).toEqual(['copy']);
    const notice = notices[0] as HTMLElement;
    expect(notice.textContent).toContain(LINE);
    expect(notice.querySelector('.project-home__error')).toBeNull();
    const buttons = Array.from(notice.querySelectorAll('button')).map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual(['Open', 'Dismiss']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss');
    expect(notice.contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenCopy).toHaveBeenCalledTimes(1);
  });

  it('leaves focus alone when the person has moved on outside the notices', () => {
    const { rerender } = render(<ProjectHome {...props()} />);
    const search = screen.getByRole('button', { name: 'New project' });
    search.focus();
    rerender(<ProjectHome {...props({ copyNotice: savedAs })} />);
    expect(document.activeElement).toBe(search);
  });

  it('an update’s copy notice (no [Open]) is unchanged', () => {
    render(<ProjectHome {...props({ copyNotice: { line: 'x', restore: { id: 'r', name: 'R' } } })} />);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  });
});

describe('GM r22 Q1: the popover open, the matching toast steps aside', () => {
  it('opening the mark’s popover clears the toast with its [Try again]; closing brings none back; other toasts stay', () => {
    const LINE_STOPPED = 'Couldn’t save your changes to “Opening”. They’re kept and Nebula will try again with your next change.';
    useGraphStore.setState({ undoNotice: { id: 1, text: 'Codex changed the canvas.', offer: 'undo' },
      messageNotice: { id: 2, text: LINE_STOPPED, tone: 'info', retryScene: { nodeId: 'n1' } } } as never);
    render(<SceneUnsavedMark nodeId="n1" line={LINE_STOPPED} stopped />);
    fireEvent.click(screen.getByRole('button', { name: 'Unsaved' }));
    expect(document.querySelector('[data-scene-unsaved-popover="n1"]')).toBeTruthy();
    expect(useGraphStore.getState().messageNotice).toBeNull();
    expect(useGraphStore.getState().undoNotice?.text).toBe('Codex changed the canvas.');
    act(() => { fireEvent.keyDown(document.querySelector('[data-scene-unsaved-popover="n1"]')!, { key: 'Escape' }); });
    expect(document.querySelector('[data-scene-unsaved-popover="n1"]')).toBeNull();
    expect(useGraphStore.getState().messageNotice).toBeNull();
  });
});

describe('GM r23 answer 2: the clash asked again takes focus itself, never Keep mine', () => {
  const CLASH = 'Codex changed “Opening” while you were editing it.';
  it('focus lost with the toast it replaced: on the prompt (tabindex -1), not a button; Enter there chooses nothing', () => {
    const resolve = vi.fn();
    useGraphStore.setState({ sceneClashes: { n1: { id: 41, line: CLASH, agent: 'Codex', focus: true } }, resolveSceneClash: resolve } as never);
    render(<SceneClashNotices />);
    const prompt = document.querySelector('[data-scene-clash="n1"]') as HTMLElement;
    expect(document.activeElement).toBe(prompt);
    expect(prompt.getAttribute('tabindex')).toBe('-1');
    expect(prompt.querySelector('.canvas-undo-notice__close')).toBeNull();
    fireEvent.keyDown(prompt, { key: 'Enter' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('focus the person moved elsewhere stays there; a prompt asked the ordinary way takes none', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    useGraphStore.setState({ sceneClashes: { n1: { id: 42, line: CLASH, agent: 'Codex', focus: true } } } as never);
    const { unmount } = render(<SceneClashNotices />);
    expect(document.activeElement).toBe(outside);
    unmount();
    outside.blur();
    useGraphStore.setState({ sceneClashes: { n1: { id: 43, line: CLASH, agent: 'Codex' } } } as never);
    render(<SceneClashNotices />);
    expect(document.activeElement).toBe(document.body);
    outside.remove();
  });
});

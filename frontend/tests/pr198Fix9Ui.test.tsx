import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 9 (GM r12, r13), rendered and in copy:
 * - GM r12 item 1 / r13 answer 3: a stopped save's "Unsaved" mark opens a
 *   popover with its line and [Try again]; the tooltip stays.
 * - GM r12 item 2: "Use Codex’s", curly.
 * - GM r12 item 3: plurals in active voice, one name-list helper (up to
 *   three names, a count from four).
 * - GM r12 item 5: the recovered copy's notices are neutral toasts with ×;
 *   the Recently deleted one keeps [Restore].
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/backend')>()),
  backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}`,
}));

import { SceneUnsavedMark } from '../src/components/nodes/SceneUnsavedMark';
import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { useGraphStore } from '../src/store/graphStore';
import { quotedNames } from '../src/lib/errorCopy';
import { sceneClashLine, shotBackWithoutLine, shotsRemovedLine, theirsLabel } from '../src/lib/sceneSaveCopy';
import { copyDeletedAfterUpdateLine } from '../src/store/projectStore';

afterEach(cleanup);

const STOPPED = "Couldn't save your changes to “Opening”. They're kept and Nebula will try again with your next change.";

describe('GM r12 item 1: the stopped save\'s popover on the "Unsaved" mark', () => {
  it('before it stops: the mark is text with its tooltip, no button', () => {
    render(<SceneUnsavedMark nodeId="n1" line={STOPPED} stopped={false} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Unsaved').getAttribute('title')).toBe(STOPPED);
  });

  it('stopped: a click opens the line with [Try again], which sends again and closes it; the tooltip stays', () => {
    const retry = vi.fn();
    useGraphStore.setState({ retrySceneSave: retry } as never);
    render(<SceneUnsavedMark nodeId="n1" line={STOPPED} stopped />);
    const mark = screen.getByRole('button', { name: 'Unsaved' });
    expect(mark.getAttribute('title')).toBe(STOPPED);
    expect(mark.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(mark);
    const popover = screen.getByRole('dialog');
    expect(within(popover).getByText(STOPPED)).toBeTruthy();
    expect(mark.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(popover).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledWith('n1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape and a press outside close it', () => {
    render(<SceneUnsavedMark nodeId="n1" line={STOPPED} stopped />);
    fireEvent.click(screen.getByRole('button', { name: 'Unsaved' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unsaved' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('GM r12 items 2 and 3: the button and the plurals', () => {
  it('"Use Codex’s" with a curly apostrophe; every clash line one sentence', () => {
    expect(theirsLabel('Codex')).toBe('Use Codex’s');
    expect(sceneClashLine('Shot 2', 'Codex')).toBe('Codex changed “Shot 2” while you were editing it.');
  });

  it('GM\'s three lines, verbatim', () => {
    expect(shotsRemovedLine(['Shot 2', 'Shot 3'], 'Codex')).toBe('Codex removed “Shot 2” and “Shot 3” while you were editing them.');
    expect(shotBackWithoutLine(['Shot 2'], ['Edit A', 'Edit B'])).toBe('“Shot 2” is back without its connections to “Edit A” and “Edit B”.');
    expect(shotBackWithoutLine(['Shot 2', 'Shot 3'], ['Edit A'])).toBe('“Shot 2” and “Shot 3” are back without their connections to “Edit A”.');
    expect(shotBackWithoutLine(['Shot 2'], ['Edit A'])).toBe('“Shot 2” is back without its connection to “Edit A”.');
  });

  it('the shared helper: up to three names, a count from four', () => {
    expect(quotedNames(['A'], 'shots')).toBe('“A”');
    expect(quotedNames(['A', 'B', 'C'], 'shots')).toBe('“A”, “B” and “C”');
    expect(quotedNames(['A', 'B', 'C', 'D'], 'shots')).toBe('4 shots');
    expect(shotsRemovedLine(['Shot 1', 'Shot 2', 'Shot 3', 'Shot 4'], 'Codex')).toBe('Codex removed 4 shots while you were editing them.');
  });
});

const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});

describe('GM r12 item 5: the recovered copy\'s notices', () => {
  it('in Recently deleted: GM\'s line, [Restore] and ×, never the error box', () => {
    const line = copyDeletedAfterUpdateLine('Alpha (recovered)', false);
    expect(line).toBe("Nebula couldn't save some changes before it updated. They were kept in “Alpha (recovered)”, which is in Recently deleted.");
    const onRestoreCopy = vi.fn();
    const onDismissCopy = vi.fn();
    const { container } = render(<ProjectHome {...props({ copyNotice: { line, restore: { id: 'r', name: 'Alpha (recovered)' } },
      onRestoreCopy, onDismissCopy })} />);
    expect(container.querySelector('.project-home__error')).toBeNull();
    const notice = container.querySelector('[data-copy-notice]') as HTMLElement;
    expect(notice.classList.contains('project-home__toast')).toBe(true);
    expect(within(notice).getByText(line)).toBeTruthy();
    expect(within(notice).queryByRole('button', { name: 'Dismiss' })).toBeTruthy();
    fireEvent.click(within(notice).getByRole('button', { name: 'Restore' }));
    expect(onRestoreCopy).toHaveBeenCalledTimes(1);
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(onDismissCopy).toHaveBeenCalledTimes(1);
  });

  it('deleted for good: GM\'s line and × only', () => {
    const line = copyDeletedAfterUpdateLine('Alpha (recovered 2)', true);
    expect(line).toBe("Nebula couldn't save some changes before it updated. They were kept in “Alpha (recovered 2)”, which was permanently deleted, so they can't be brought back.");
    const { container } = render(<ProjectHome {...props({ copyNotice: { line, restore: null } })} />);
    const notice = container.querySelector('[data-copy-notice]') as HTMLElement;
    expect(within(notice).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Dismiss']);
    expect(container.querySelector('.project-home__error')).toBeNull();
  });
});

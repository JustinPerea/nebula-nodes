import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 15 (GM r24), rendered: the saved-as notice's × rings by
 * the input that pressed Try again. A mouse click moves focus to × with no
 * ring; Enter or Space rings it. That is the mechanism every other notice
 * uses (GM r17): a plain `focus()` left to the browser's :focus-visible
 * heuristic, never forced either way (no `focusVisible` option), and a ring
 * drawn from :focus-visible only. jsdom has no :focus-visible heuristic, so
 * the ring itself is checked live (fix15_live.mjs, both ways).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));

import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { editsSavedAsProjectLine } from '../src/store/projectStore';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const BANNER = 'The active project changed in another window. Try again to save your unsaved edits as a recovered project.';
const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});
const savedAs = { line: editsSavedAsProjectLine('Recovered canvas (recovered)'), restore: null,
  open: { id: 'p9', name: 'Recovered canvas (recovered)' } };

describe('GM r24: the saved-as notice’s × rings by the input, through the shared :focus-visible mechanism', () => {
  it.each([
    ['a mouse click', (button: HTMLElement) => { fireEvent.mouseDown(button); button.focus(); fireEvent.mouseUp(button); fireEvent.click(button); }],
    ['Enter', (button: HTMLElement) => { button.focus(); fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.click(button); }],
    ['Space', (button: HTMLElement) => { button.focus(); fireEvent.keyDown(button, { key: ' ' }); fireEvent.keyUp(button, { key: ' ' }); fireEvent.click(button); }],
  ])('Try again by %s: focus moves to × with a plain focus(), never a forced ring either way', (_how, press) => {
    const onRetry = vi.fn();
    const { rerender } = render(<ProjectHome {...props({ error: BANNER, retry: 'reload', onRetry })} />);
    press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    rerender(<ProjectHome {...props({ loading: true })} />);
    rerender(<ProjectHome {...props({ copyNotice: savedAs })} />);
    const close = document.querySelector('[data-notice="copy"] button.project-home__notice-close');
    expect(document.activeElement).toBe(close);
    const onClose = focus.mock.contexts.map((element, index) => [element, focus.mock.calls[index]] as const)
      .filter(([element]) => element === close);
    expect(onClose.length).toBe(1);
    // No options at all: nothing asks the browser for a ring, or for none.
    expect(onClose[0][1]).toEqual([]);
  });

  it('the × draws its ring from :focus-visible only: no plain :focus rule, no outline: none on it', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/project-home.css'), 'utf8');
    expect(css).toMatch(/\.project-home__notice-close:focus-visible \{ outline: var\(--sr-focus-outline\)/);
    expect(css).not.toMatch(/project-home__notice-close(:not\([^)]*\))?:focus(?!-visible)/);
    expect(css).not.toMatch(/project-home__notice-close[^{]*\{[^}]*outline:\s*(none|0)/);
  });
});

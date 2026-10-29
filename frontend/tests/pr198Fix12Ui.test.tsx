import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR #198 fix round 12 (review 11), rendered:
 * - L-3: Escape on the focused "Unsaved" mark never reaches the card (React
 *   Flow's node selects on it). With the popover open, Escape closes it and
 *   focus stays on the mark.
 * - Nit N-5 (GM r17): the keyboard-versus-click ring difference, pinned. jsdom
 *   has no :focus-visible heuristic, so the browser's is simulated (a key
 *   press makes the next focus keyboard focus, a pointer press makes it not;
 *   the input-modality polyfill's rule), with project-home.css's
 *   :focus-visible read as that attribute.
 * - GM pr200 r16 #2 (the coordinator, for this round): a notice closed with ×
 *   moves focus to the next notice's ×, never onto a primary or destructive
 *   action; a notice with no × takes focus itself; an empty stack, the
 *   "Recent projects" heading. In #200 a second Enter ran the next notice's
 *   Run: here two Enters never act.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { SceneUnsavedMark } from '../src/components/nodes/SceneUnsavedMark';
import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { copyDeletedAfterUpdateLine } from '../src/store/projectStore';

afterEach(cleanup);

const STOPPED = 'Nebula couldn’t save your changes to “Opening”. They’re kept, and Nebula will try again with your next change.';

describe('review 11, L-3: Escape on the "Unsaved" mark', () => {
  it('with no popover open: Escape stays with the mark (the card isn’t selected)', () => {
    const keyDown = vi.fn();
    render(<div onKeyDown={keyDown}><SceneUnsavedMark nodeId="n1" line={STOPPED} stopped /></div>);
    const mark = screen.getByRole('button', { name: 'Unsaved' });
    mark.focus();
    fireEvent.keyDown(mark, { key: 'Escape' });
    expect(keyDown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(mark);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with the popover open and focus on the mark: Escape closes it, focus stays on the mark, the card never sees it', () => {
    const keyDown = vi.fn();
    render(<div onKeyDown={keyDown}><SceneUnsavedMark nodeId="n1" line={STOPPED} stopped /></div>);
    const mark = screen.getByRole('button', { name: 'Unsaved' });
    fireEvent.click(mark);
    expect(screen.getByRole('dialog')).toBeTruthy();
    mark.focus();
    fireEvent.keyDown(mark, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(mark);
    expect(keyDown).not.toHaveBeenCalled();
  });

  it('Escape in the popover closes it and gives focus back to the mark; the next Escape still stays with the mark', () => {
    const keyDown = vi.fn();
    render(<div onKeyDown={keyDown}><SceneUnsavedMark nodeId="n1" line={STOPPED} stopped /></div>);
    const mark = screen.getByRole('button', { name: 'Unsaved' });
    fireEvent.click(mark);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(mark);
    fireEvent.keyDown(mark, { key: 'Escape' });
    expect(keyDown).not.toHaveBeenCalled();
  });
});

describe('GM r17 (review 11, N-5): a keyboard close rings the next target, a click close doesn’t', () => {
  let style: HTMLStyleElement;
  let modality: 'keyboard' | 'pointer' = 'pointer';
  const onKey = () => { modality = 'keyboard'; };
  const onPointer = () => { modality = 'pointer'; };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement && modality === 'keyboard') event.target.setAttribute('data-focus-visible', '');
  };
  const onFocusOut = (event: FocusEvent) => { if (event.target instanceof HTMLElement) event.target.removeAttribute('data-focus-visible'); };

  beforeEach(() => {
    // project-home.css as written, its :focus-visible read as the simulated
    // heuristic's attribute (jsdom resolves no var(), so the ring is the
    // declared value).
    const css = readFileSync(resolve(__dirname, '../src/styles/project-home.css'), 'utf8').replaceAll(':focus-visible', '[data-focus-visible]');
    style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.classList.add('app-slava-restraint');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
  });
  afterEach(() => {
    style.remove();
    document.body.classList.remove('app-slava-restraint');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
  });

  const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
    projects: [], loading: false, busy: false, error: null,
    onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
  } as ProjectHomeProps);
  const copyNotice = { line: copyDeletedAfterUpdateLine('Alpha (recovered)', false), restore: { id: 'r', name: 'Alpha (recovered)' } };
  const ring = (element: Element) => getComputedStyle(element).outline;

  it('closed from the keyboard: focus lands on the "Recent projects" heading, ringed', async () => {
    const view = render(<ProjectHome {...props({ copyNotice } as Partial<ProjectHomeProps>)} />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    fireEvent.keyDown(dismiss, { key: 'Enter' });
    view.rerender(<ProjectHome {...props({ copyNotice: null } as Partial<ProjectHomeProps>)} />);
    const heading = screen.getByRole('heading', { name: 'Recent projects' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(ring(heading)).toBe('var(--sr-focus-outline)');
  });

  it('closed with a click: focus lands on the same heading, not ringed', async () => {
    const view = render(<ProjectHome {...props({ copyNotice } as Partial<ProjectHomeProps>)} />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.pointerDown(dismiss);
    dismiss.focus();
    fireEvent.click(dismiss);
    view.rerender(<ProjectHome {...props({ copyNotice: null } as Partial<ProjectHomeProps>)} />);
    const heading = screen.getByRole('heading', { name: 'Recent projects' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(ring(heading)).toBe('');
  });

  it('the same for the error box: rings after a keyboard close, not after a click', async () => {
    const error = 'Couldn’t load your projects.';
    for (const how of ['keyboard', 'click'] as const) {
      const view = render(<ProjectHome {...props({ copyNotice, error, retry: 'none' } as Partial<ProjectHomeProps>)} />);
      const dismiss = screen.getByRole('button', { name: 'Dismiss' });
      if (how === 'keyboard') { dismiss.focus(); fireEvent.keyDown(dismiss, { key: 'Enter' }); } else { fireEvent.pointerDown(dismiss); dismiss.focus(); }
      view.rerender(<ProjectHome {...props({ copyNotice: null, error, retry: 'none' } as Partial<ProjectHomeProps>)} />);
      const box = screen.getByRole('alert');
      await waitFor(() => expect(document.activeElement).toBe(box));
      expect(ring(box)).toBe(how === 'keyboard' ? 'var(--sr-focus-outline)' : '');
      view.unmount();
    }
  });
});

describe('GM pr200 r16 #2: two Enters on × never trigger an action', () => {
  // Enter on a focused button activates it (the browser's default, which
  // jsdom lacks): keydown, then a click unless the keydown was prevented. On
  // anything else Enter does only what a keydown handler does with it.
  const pressEnter = () => {
    const target = document.activeElement as HTMLElement | null;
    if (!target) return;
    const go = fireEvent.keyDown(target, { key: 'Enter' });
    if (go && (target instanceof HTMLButtonElement ? !target.disabled : target.matches('a[href], summary'))) fireEvent.click(target);
    fireEvent.keyUp(target, { key: 'Enter' });
  };
  const handlers = () => ({ dismiss: vi.fn(), restore: vi.fn(), retry: vi.fn(), download: vi.fn(), cont: vi.fn(),
    create: vi.fn(), open: vi.fn(), rename: vi.fn(), del: vi.fn() });
  const copyNotice = { line: copyDeletedAfterUpdateLine('Alpha (recovered)', false), restore: { id: 'r', name: 'Alpha (recovered)' } };
  function Stack({ h, rest }: { h: ReturnType<typeof handlers>; rest: Partial<ProjectHomeProps> }) {
    const [copy, setCopy] = useState<typeof copyNotice | null>(copyNotice);
    return <ProjectHome {...({ projects: [{ id: 'p1', name: 'Alpha', createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:00Z',
      lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null }], loading: false, busy: false, error: null,
      onCreate: h.create, onOpen: h.open, onRename: h.rename, onDelete: h.del, onRetry: h.retry,
      onRestoreCopy: h.restore, onDownloadEdits: h.download, onContinueWithoutEdits: h.cont,
      onDismissCopy: () => { h.dismiss(); setCopy(null); }, copyNotice: copy, ...rest } as ProjectHomeProps)} />;
  }

  it.each([
    ['the error with [Try again]', { error: 'Couldn’t load your projects.' }, () => screen.getByRole('alert')],
    ['the held edits ([Download your edits], [Continue without them])', { unsavedEdits: { reason: 'These edits are too large for Nebula to save.' } },
      () => document.querySelector('.project-home__edits')],
    ['the line that says where the edits went', { editsSavedAs: { name: 'Alpha.nebula', reopens: true } }, () => document.querySelector('[data-notice="saved"] .project-home__notice')],
    ['nothing (the stack empties)', {}, () => screen.getByRole('heading', { name: 'Recent projects' })],
  ] as const)('the next notice is %s: Enter closes, the second Enter does nothing', async (_what, rest, landing) => {
    const h = handlers();
    render(<Stack h={h} rest={rest as Partial<ProjectHomeProps>} />);
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    pressEnter();
    await waitFor(() => expect(document.activeElement).toBe(landing()));
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    pressEnter();
    await new Promise((done) => setTimeout(done, 20));
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    for (const action of [h.restore, h.retry, h.download, h.cont, h.create, h.open, h.rename, h.del]) expect(action).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(landing());
  });

  it('after the held edits go, focus lands on the copy notice’s ×, never [Restore]; two Enters from there act on nothing', async () => {
    const h = handlers();
    function Held() {
      const [held, setHeld] = useState(true);
      return <Stack h={{ ...h, cont: (() => { h.cont(); setHeld(false); }) as unknown as typeof h.cont }}
        rest={held ? { unsavedEdits: { reason: 'These edits are too large for Nebula to save.' } } : {}} />;
    }
    render(<Held />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }));
    const confirm = screen.getByRole('alertdialog');
    confirm.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { if (button.textContent === 'Continue without them') button.focus(); });
    expect(document.activeElement?.textContent).toBe('Continue without them');
    pressEnter();
    expect(h.cont).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' })));
    pressEnter();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Recent projects' })));
    pressEnter();
    await new Promise((done) => setTimeout(done, 20));
    expect(h.restore).not.toHaveBeenCalled();
    for (const action of [h.retry, h.download, h.create, h.open, h.rename, h.del]) expect(action).not.toHaveBeenCalled();
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });
});

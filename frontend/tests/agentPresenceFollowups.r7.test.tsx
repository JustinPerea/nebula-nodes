import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix round 7 of PR #200 (review 7, GM r10 and r11), the component and
 * style side:
 * - GM r11 answer 2 (LOW-1): the leave mirrors the enter for every surface,
 *   toasts included. lib/noticeLeave.ts is the one place an item leaves: it
 *   stays mounted, inert and marked data-leaving="surface" or "row" until
 *   its -out animation ends; noticeRegion.css draws each leave (surfaces
 *   scale out on a faster, critically damped spring, rows collapse, reduced
 *   motion fades). Focus moves at the start. The open list re-sizes after a
 *   collapse ends.
 * - GM r11 answer 1 (LOW-2): in the open list a newly kept note fades in
 *   place, and the list is re-placed in the same layout pass.
 * - GM r11 answer 3 (LOW-3 and N-4): the destructive colours (the ratchet
 *   holds the rule; these pin the three named controls).
 * - N-2: the Inspector's pickers refuse in their own onChange.
 * N-1 is the ratchet's; N-3 is the backend's (test_agent_presence_followups).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));
const calls = vi.hoisted(() => ({ upload: 0, extract: 0 }));
vi.mock('../src/lib/apiRequest', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/apiRequest')>(),
  apiRequest: vi.fn(async () => { calls.upload += 1; throw new Error('no backend'); }),
}));
vi.mock('../src/lib/paletteExtract', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/paletteExtract')>(),
  extractPaletteFromImage: vi.fn(async () => { calls.extract += 1; return { ok: true, colors: ['#123456'] }; }),
}));

import { PinComposer } from '../src/components/canvas/PinComposer';
import { PersonRequiredBanner } from '../src/components/PersonRequiredBanner';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';
import { Inspector } from '../src/components/panels/Inspector';
import { NoticeLeave, useLeave } from '../src/lib/noticeLeave';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { noteKeptLine, type KeptNote } from '../src/lib/canvasPins';
import { publishOpenProject } from '../src/lib/currentProject';
import { setProjectContext } from '../src/lib/projectContext';
import { reportPersonRequired } from '../src/lib/personSession';
import { resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';

const SRC = join(__dirname, '../src');
const css = (file: string) => readFileSync(join(SRC, file), 'utf8');
const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const reason = { agent: 'Codex', projectName: 'Second canvas' };
const note = (project: string, text: string): KeptNote =>
  ({ text, project, projectName: `Project ${project}`, following: reason, line: noteKeptLine(reason) });

// jsdom runs no CSS: stand in for noticeRegion.css, where a marked item runs its -out animation.
let animate = true;
const realGetAnimations = Element.prototype.getAnimations;
beforeEach(() => {
  animate = true;
  Element.prototype.getAnimations = function getAnimations(this: Element) {
    const kind = this.getAttribute('data-leaving');
    return (animate && kind ? [{ animationName: kind === 'row' ? 'notice-row-out' : 'notice-surface-out' }] : []) as unknown as Animation[];
  };
  resetCanvasFollowForTests();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'home', revision: 'rev-home' });
  publishOpenProject({ id: 'home', name: 'Home' });
  calls.upload = 0; calls.extract = 0;
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  Element.prototype.getAnimations = realGetAnimations;
  act(() => { resetCanvasFollowForTests(); resetBackendConnectionForTests(); });
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useCanvasPinsStore.setState({ composer: null, composerCanvas: null, draft: '', drafts: {}, kept: [], error: null, errorProject: null } as never);
  publishOpenProject(null);
  setProjectContext(null);
  vi.restoreAllMocks();
});

/** The leave animation ending on the element (React listens for either name in jsdom). */
const endLeave = (el: Element, name = el.getAttribute('data-leaving') === 'row' ? 'notice-row-out' : 'notice-surface-out') => act(() => {
  for (const type of ['animationend', 'webkitAnimationEnd']) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: name });
    el.dispatchEvent(event);
  }
});

describe('the one place an item leaves (lib/noticeLeave)', () => {
  function Probe({ value }: { value: string | null }) {
    const leave = useLeave(value);
    return leave.shown ? <div data-testid="item" {...leave.props}>{leave.shown}</div> : null;
  }

  it('stays, inert and marked, until its own -out animation ends; then goes', () => {
    const { rerender } = render(<Probe value="Saved." />);
    expect(screen.getByTestId('item')).not.toHaveAttribute('data-leaving');
    rerender(<Probe value={null} />);
    const item = screen.getByTestId('item');
    expect(item).toHaveTextContent('Saved.');
    expect(item).toHaveAttribute('data-leaving', 'surface');
    expect(item).toHaveAttribute('inert');
    // Another animation ending (an entrance) doesn't count.
    endLeave(item, 'notice-surface-in');
    expect(screen.getByTestId('item')).toBeInTheDocument();
    endLeave(item);
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('goes at once when no leave runs, and comes back at once with a new value mid-leave', () => {
    const { rerender } = render(<Probe value="One" />);
    rerender(<Probe value={null} />);
    rerender(<Probe value="Two" />);
    expect(screen.getByTestId('item')).toHaveTextContent('Two');
    expect(screen.getByTestId('item')).not.toHaveAttribute('data-leaving');
    expect(screen.getByTestId('item')).not.toHaveAttribute('inert');
    animate = false;
    rerender(<Probe value={null} />);
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('NoticeLeave keeps a toast its parent stopped drawing', () => {
    const draw = (toast: { id: number; text: string } | null) => (
      <NoticeLeave value={toast}>{(last, leave) => <div data-testid="toast" key={last.id} {...leave}>{last.text}</div>}</NoticeLeave>
    );
    const { rerender } = render(draw({ id: 1, text: 'Moved “A” to Recently deleted' }));
    rerender(draw(null));
    expect(screen.getByTestId('toast')).toHaveAttribute('data-leaving', 'surface');
    endLeave(screen.getByTestId('toast'));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('every notice-region surface leaves through it, toasts included (GM r11 answer 2)', () => {
    const users: Array<[string, RegExp]> = [
      // GM r8 (1), #204 round 7: it steps out (through the same leave) while a specific line says it.
      ['components/PersonRequiredBanner.tsx', /useLeave\(specific \? null : message\)/],
      ['components/canvas/ProposalBar.tsx', /useLeave\(live \?\? null\)/],
      ['components/canvas/ProposalBar.tsx', /useLeave\([^)]*errors\[[^\n]*'row'\)/],
      ['components/canvas/DeferredRunNotice.tsx', /useLeave\(deferredRun\)/],
      ['components/canvas/CanvasUndoNotice.tsx', /useLeave\(notice\)/],
      ['components/canvas/CanvasLateNotice.tsx', /useLeave\(notice\)/],
      ['components/canvas/CanvasMessageNotice.tsx', /useLeave\(notice\)/],
      ['components/projects/SavePausedNotice.tsx', /useLeave\(notice\)/],
      ['components/projects/ProjectSwitchToast.tsx', /useLeave\(notice\)/],
      ['components/canvas/PinComposer.tsx', /useLeave\(kept\.length > 0/],
      ['components/canvas/PinComposer.tsx', /useLeavingRows\(shown/],
      ['components/canvas/PinComposer.tsx', /const errorLeave = useLeave\(/],
      ['components/projects/ProjectHome.tsx', /<NoticeLeave value=\{lastDeleted\}>/],
      ['components/moodboard-studio/MoodboardStudioView.tsx', /<NoticeLeave value=\{shownToast\}>/],
      ['components/moodboard-studio/MoodboardStudioView.tsx', /<NoticeLeave value=\{deleting\.lastDeleted\}>/],
      ['components/panels/AssetsPanel.tsx', /<NoticeLeave value=\{deleting\.lastDeleted\}>/],
      ['components/character-studio/CharacterStudioView.tsx', /<NoticeLeave value=\{deleting\.lastDeleted\}>/],
      ['components/moodboard-studio/BoardUndoToast.tsx', /\{\.\.\.leave\}/],
      ['components/asset-trash/AssetTrash.tsx', /\{\.\.\.leave\}/],
    ];
    for (const [file, pattern] of users) expect(css(file), file).toMatch(pattern);
    // No toast is drawn by a bare `{x && <Toast />}` any more.
    for (const file of ['components/projects/ProjectHome.tsx', 'components/moodboard-studio/MoodboardStudioView.tsx', 'components/panels/AssetsPanel.tsx', 'components/character-studio/CharacterStudioView.tsx']) {
      expect(css(file), file).not.toMatch(/&& \(?\s*<(UndoToast|UndoDeleteToast|BoardUndoToast)\b/);
    }
  });

  it('the person-required notice and the canvas notice stay through their leave', () => {
    render(<><PersonRequiredBanner /><CanvasUndoNotice /></>);
    act(() => reportPersonRequired());
    act(() => useGraphStore.getState().notify('Couldn’t save.', 'error'));
    const banner = document.querySelector('.person-required')!;
    const notice = document.querySelector('.canvas-undo-notice')!;
    fireEvent.click(banner.querySelector('button[aria-label="Dismiss"]')!);
    fireEvent.click(notice.querySelector('button[aria-label="Dismiss"]')!);
    expect(banner).toHaveAttribute('data-leaving', 'surface');
    expect(notice).toHaveAttribute('data-leaving', 'surface');
    endLeave(banner); endLeave(notice);
    expect(document.querySelector('.person-required')).toBeNull();
    expect(document.querySelector('.canvas-undo-notice')).toBeNull();
  });
});

describe('GM r10 and r11: a kept note collapses, the stack scales out, focus moves at the start', () => {
  const row = (container: HTMLElement, project: string) => container.querySelector<HTMLElement>(`.canvas-pin-toast--kept[data-project="${project}"]`);

  it('× on the older of two: it collapses in place as a row, inert, while focus is already on the next note\'s ×', () => {
    useCanvasPinsStore.setState({ kept: [note('a', 'First'), note('b', 'Second')] } as never);
    const { container } = render(<PinComposer />);
    const close = row(container, 'a')!.querySelector<HTMLElement>('button[aria-label="Dismiss"]')!;
    close.focus();
    fireEvent.click(close);
    const leaving = row(container, 'a')!;
    expect(leaving).toHaveAttribute('data-leaving', 'row');
    expect(leaving).toHaveAttribute('inert');
    expect(leaving.nextElementSibling).toBe(row(container, 'b'));
    expect(document.activeElement).toBe(row(container, 'b')!.querySelector('button[aria-label="Dismiss"]'));
    endLeave(leaving);
    expect(row(container, 'a')).toBeNull();
    expect(row(container, 'b')).not.toHaveAttribute('data-leaving');
  });

  it('the last note: the stack scales out with the note still in it, unmarked; then both go', () => {
    useCanvasPinsStore.setState({ kept: [note('a', 'Only')] } as never);
    const { container } = render(<PinComposer />);
    act(() => useCanvasPinsStore.setState({ kept: [] } as never));
    const stack = container.querySelector<HTMLElement>('.canvas-pin-kept-stack')!;
    expect(stack).toHaveAttribute('data-leaving', 'surface');
    expect(stack).toHaveAttribute('inert');
    expect(row(container, 'a')).not.toHaveAttribute('data-leaving');
    endLeave(stack);
    expect(container.querySelector('.canvas-pin-kept-stack')).toBeNull();
    // A note kept later starts a fresh stack (no stale row comes back).
    act(() => useCanvasPinsStore.setState({ kept: [note('c', 'Next')] } as never));
    expect([...container.querySelectorAll('.canvas-pin-toast--kept')].map((el) => el.getAttribute('data-project'))).toEqual(['c']);
  });

  it('the pin error leaves as a surface', () => {
    useCanvasPinsStore.setState({ error: 'Couldn’t save the note.', errorProject: null } as never);
    const { container } = render(<PinComposer />);
    act(() => useCanvasPinsStore.setState({ error: null } as never));
    const error = container.querySelector<HTMLElement>('.canvas-pin-toast--notice')!;
    expect(error).toHaveAttribute('data-leaving', 'surface');
    endLeave(error);
    expect(container.querySelector('.canvas-pin-toast--notice')).toBeNull();
  });

  describe('the open list', () => {
    const ROW = 50;
    let restore: Array<() => void> = [];
    beforeEach(() => {
      const scrolled = new WeakMap<Element, number>();
      const define = (name: string, descriptor: PropertyDescriptor) => {
        const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name);
        Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
        restore.push(() => { if (before) Object.defineProperty(HTMLElement.prototype, name, before); else delete (HTMLElement.prototype as never)[name]; });
      };
      define('offsetHeight', { get() { return (this as HTMLElement).classList.contains('canvas-pin-toast--kept') ? ROW : 0; } });
      define('offsetTop', { get() {
        const el = this as HTMLElement;
        return el.classList.contains('canvas-pin-toast--kept') && el.parentElement ? [...el.parentElement.children].indexOf(el) * ROW : 0;
      } });
      define('scrollTop', { get() { return scrolled.get(this as Element) ?? 0; }, set(value: number) { scrolled.set(this as Element, value); } });
    });
    afterEach(() => { for (const undo of restore.reverse()) undo(); restore = []; });

    it('a note kept while it is open is placed in the same pass: whole rows, resting on the newest, its fade the only motion', () => {
      useCanvasPinsStore.setState({ kept: Array.from({ length: 9 }, (_, i) => note(`p${i}`, `Note ${i}`)) } as never);
      const { container } = render(<PinComposer />);
      fireEvent.click(screen.getByRole('button', { name: 'Show 7 more' }));
      const list = container.querySelector<HTMLElement>('.canvas-pin-kept-list')!;
      expect(list.scrollTop).toBe(3 * ROW);
      act(() => useCanvasPinsStore.setState({ kept: [...useCanvasPinsStore.getState().kept, note('p9', 'Note 9')] } as never));
      // Re-placed before any paint: one more row scrolled, still a row's top.
      expect(list.style.getPropertyValue('--kept-list-h')).toBe('300px');
      expect(list.scrollTop).toBe(4 * ROW);
      expect(row(container, 'p9')).toHaveAttribute('data-entering');
      const rule = /\.canvas-pin-kept-stack\[data-open\] \.canvas-pin-kept-list > \.canvas-pin-toast--kept\[data-entering\]:not\(\[data-leaving\]\) \{([^}]*)\}/.exec(css('styles/canvasPins.css'))?.[1] ?? '';
      expect(rule).toMatch(/animation:\s*notice-fade-in /);
      expect(rule).not.toMatch(/row-in|height/);
      // Its leave mirrors it: a fade in place, then re-placed as it goes.
      const leave = /\.notice-region \.canvas-pin-kept-stack\[data-open\] \.canvas-pin-kept-list > \[data-leaving='row'\] \{([^}]*)\}/.exec(css('styles/canvasPins.css'))?.[1] ?? '';
      expect(leave).toMatch(/animation:\s*notice-fade-out /);
    });

    it('a note that goes is re-placed after its collapse ends, never at its start', () => {
      useCanvasPinsStore.setState({ kept: Array.from({ length: 9 }, (_, i) => note(`p${i}`, `Note ${i}`)) } as never);
      const { container } = render(<PinComposer />);
      fireEvent.click(screen.getByRole('button', { name: 'Show 7 more' }));
      const list = container.querySelector<HTMLElement>('.canvas-pin-kept-list')!;
      list.scrollTop = 2 * ROW; // the person scrolled up a row
      fireEvent.click(row(container, 'p4')!.querySelector('button[aria-label="Dismiss"]')!);
      expect(row(container, 'p4')).toHaveAttribute('data-leaving', 'row');
      expect(list.scrollTop).toBe(2 * ROW);
      endLeave(row(container, 'p4')!);
      expect(row(container, 'p4')).toBeNull();
      // Re-placed on the eight left: the newest six, resting on a row's top.
      expect(list.scrollTop).toBe(2 * ROW);
      expect(list.scrollTop % ROW).toBe(0);
    });
  });
});

describe('the leave CSS (noticeRegion.css)', () => {
  const region = css('styles/noticeRegion.css');
  const keyframes = (name: string) => new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(region)?.[1] ?? '';

  it('surfaces scale out on a critically damped spring, about 70% of the entry, never past their end', () => {
    expect(region).toMatch(/--notice-exit-ms:\s*294ms/);
    const points = (/--notice-exit:\s*linear\(([^)]*)\)/.exec(region)?.[1] ?? '').split(',').map(Number);
    expect(points[0]).toBe(0);
    expect(points.at(-1)).toBe(1);
    points.slice(1).forEach((value, index) => expect(value).toBeGreaterThanOrEqual(points[index]));
    expect(Math.max(...points)).toBe(1);
    expect(keyframes('notice-surface-out')).toMatch(/to \{ opacity: 0; transform: scale\(0\.96\); \}/);
    expect(keyframes('notice-row-out')).toMatch(/height:\s*0/);
    expect(keyframes('notice-row-out')).not.toMatch(/scale|transform/);
    expect(keyframes('notice-fade-out')).toMatch(/^\s*to \{ opacity: 0; \}\s*$/);
  });

  it('a marked surface and row each run their leave, and reduced motion fades both', () => {
    const block = (selector: string, reduced: boolean) => {
      const text = reduced ? /@media \(prefers-reduced-motion: reduce\) \{\s*\.notice-region \.notice-region__slot \[data-leaving='surface'\],[\s\S]*?\n\}/.exec(region)?.[0] ?? '' : region;
      return new RegExp(`${selector.replace(/[.[\]']/g, '\\$&')}[^{]*\\{([^}]*)\\}`).exec(text)?.[1] ?? '';
    };
    expect(block(".notice-region .notice-region__slot [data-leaving='surface']", false)).toMatch(/animation: notice-surface-out var\(--notice-exit-ms\) var\(--notice-exit\) both/);
    expect(block(".notice-region .notice-region__slot [data-leaving='row']", false)).toMatch(/animation: notice-row-out var\(--notice-exit-ms\) var\(--notice-exit\) both/);
    expect(block(".notice-region .notice-region__slot [data-leaving='row']", true)).toMatch(/animation: notice-fade-out 140ms ease-out both/);
  });
});

describe('LOW-3 and N-4: the three named destructive controls take the Delete red', () => {
  it('"Clear canvas…", Commons "Delete and purge" and a result card\'s Delete hover #ff887d (pressed #ff9a91)', () => {
    const hovers: Array<[string, RegExp]> = [
      ['styles/canvas-toolbar.css', /\.toolbar__action--danger:hover:not\(:disabled\) \{([^}]*)\}/],
      ['styles/commons.css', /\.commons-button--danger:hover:not\(:disabled\) \{([^}]*)\}/],
      ['styles/create-gallery.css', /\.result-card__btn--danger:hover:not\(:disabled\) \{([^}]*)\}/],
    ];
    for (const [file, pattern] of hovers) {
      const body = pattern.exec(css(file))?.[1];
      expect(body, file).toMatch(/color:\s*var\(--sr-danger-ink, #ff887d\)/);
      expect(body, file).not.toMatch(/--sr-(error|accent)|--sr-danger\)|rgba\(220/);
    }
    expect(css('styles/create-gallery.css')).toMatch(/\.result-card__btn--danger:active:not\(:disabled\) \{[^}]*--sr-danger-ink-hover, #ff9a91/);
    expect(css('styles/canvas-toolbar.css')).not.toMatch(/\.toolbar__action--danger \{[^}]*--sr-error/);
  });
});

describe('N-2: a locked picker uploads nothing from its own onChange', () => {
  const select = (definitionId: string, params: Record<string, unknown>) => {
    useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 },
      data: { label: 'Node', definitionId, params, state: 'idle', outputs: {} } }], edges: [], undoNotice: null } as never);
    useUIStore.getState().selectNode('n1');
    render(<Inspector embedded />);
  };
  const pick = (input: HTMLInputElement) => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'sky.png', { type: 'image/png' })] });
    fireEvent.change(input);
  };

  it('Choose File and Extract from reference, a file set on the input while following: no upload, no extract', async () => {
    select('image-input', { filePath: '' });
    await act(async () => { await Promise.resolve(); });
    calls.upload = 0;
    act(() => setFollowingSwitch(reason));
    pick(screen.getByText('Choose File').closest('label')!.querySelector('input')!);
    await act(async () => { await Promise.resolve(); });
    expect(calls.upload, 'Choose File').toBe(0);
    cleanup();
    select('cinema-color', { palette: ['#ff0000'] });
    await act(async () => { await Promise.resolve(); });
    const before = calls.upload; // what the panel loads as it opens
    act(() => setFollowingSwitch(reason));
    pick(screen.getByText('Extract from reference').closest('label')!.querySelector('input')!);
    await act(async () => { await Promise.resolve(); });
    expect(calls).toEqual({ upload: before, extract: 0 });
    // Unlocked, the same pick goes through.
    act(() => setFollowingSwitch(null));
    pick(screen.getByText('Extract from reference').closest('label')!.querySelector('input')!);
    await act(async () => { await Promise.resolve(); });
    expect(calls.extract).toBe(1);
  });
});

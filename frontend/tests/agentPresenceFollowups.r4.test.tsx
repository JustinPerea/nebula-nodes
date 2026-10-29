import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix round 4 of PR #200 (review 4 and GM's round 5 answers), the component
 * side:
 * - LOW-1 (GM round 5 answer 2): kept notes show the newest two, with
 *   "Show 7 more" (the real count) opening the whole list, each note keeping
 *   its own Copy note and ×.
 * - GM round 5 answer 5 (and review 4 N-3): a kept notice shows the note's
 *   line breaks, blank-line runs collapsed; Copy note copies it whole.
 * - N-5: a kept note names its project as it is called now.
 * - N-6: a failed send's error goes once the person leaves its project.
 * - LOW-2: a mask stroke under way ends the moment the lock starts.
 * LOW-3 and LOW-4 are the ratchet's (agentPresenceFollowups.ratchet).
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
  getCachedBackendBaseUrl: () => null,
}));

import { PinComposer } from '../src/components/canvas/PinComposer';
import { MaskPainterModal } from '../src/components/panels/MaskPainterModal';
import { useCanvasPinsStore } from '../src/store/canvasPinsStore';
import { useProjectStore } from '../src/store/projectStore';
import { keptNoteDisplay, noteKeptLine, type KeptNote } from '../src/lib/canvasPins';
import { publishOpenProject } from '../src/lib/currentProject';
import { setProjectContext } from '../src/lib/projectContext';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';

const initialProject = useProjectStore.getState();
const reason = { agent: 'Codex', projectName: 'Second canvas' };
const note = (project: string, projectName: string, text: string): KeptNote =>
  ({ text, project, projectName, following: reason, line: noteKeptLine(reason) });
const on = (id: string, name: string) => {
  setProjectContext({ id, revision: `rev-${id}` });
  publishOpenProject({ id, name });
};

beforeEach(() => {
  resetCanvasFollowForTests();
  resetBackendConnectionForTests();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  act(() => { resetCanvasFollowForTests(); resetBackendConnectionForTests(); });
  useProjectStore.setState(initialProject, true);
  useCanvasPinsStore.setState({ composer: null, composerCanvas: null, draft: '', drafts: {}, kept: [], error: null, errorProject: null } as never);
  publishOpenProject(null);
  setProjectContext(null);
  vi.restoreAllMocks();
});

describe('LOW-1: kept notes show the newest two, with "Show 7 more" for the rest', () => {
  const nine = Array.from({ length: 9 }, (_, i) => note(`p${i}`, `Project ${i}`, `Note ${i}`));

  it('nine kept: the newest two, the control with the real count, sentence case, no period', () => {
    on('home', 'Home');
    useCanvasPinsStore.setState({ kept: nine } as never);
    render(<PinComposer />);
    const notices = screen.getAllByRole('status');
    expect(notices).toHaveLength(2);
    expect(notices.map((item) => within(item).getByText(/^Note \d$/).textContent)).toEqual(['Note 7', 'Note 8']);
    const more = screen.getByRole('button', { name: 'Show 7 more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('the control opens the whole list, each note with its own Copy note and ×; a × in it drops only its own', () => {
    on('home', 'Home');
    useCanvasPinsStore.setState({ kept: nine } as never);
    const { container } = render(<PinComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 7 more' }));
    const notices = screen.getAllByRole('status');
    expect(notices).toHaveLength(9);
    expect(container.querySelector('.canvas-pin-kept-stack')).toHaveAttribute('data-open');
    for (const item of notices) {
      expect(within(item).getByRole('button', { name: 'Copy note' })).toBeTruthy();
      expect(within(item).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    }
    const write = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText: write } });
    fireEvent.click(within(notices[0]).getByRole('button', { name: 'Copy note' }));
    expect(write).toHaveBeenCalledWith('Note 0');
    fireEvent.click(within(notices[3]).getByRole('button', { name: 'Dismiss' }));
    expect(useCanvasPinsStore.getState().kept.map((item) => item.project)).not.toContain('p3');
    expect(screen.getAllByRole('status')).toHaveLength(8);
    // Closing it again: the newest two.
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Show 6 more' })).toBeTruthy();
  });

  it('two or fewer: no control; the open list closes itself once none is hidden', () => {
    on('home', 'Home');
    useCanvasPinsStore.setState({ kept: nine.slice(0, 3) } as never);
    render(<PinComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    fireEvent.click(within(screen.getAllByRole('status')[0]).getByRole('button', { name: 'Dismiss' }));
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull();
    act(() => useCanvasPinsStore.setState({ kept: [...useCanvasPinsStore.getState().kept, note('p9', 'Project 9', 'Note 9')] } as never));
    // A new note starts collapsed.
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('the open list scrolls inside a cap (CSS), so it never reaches the project bar or the selection toolbar', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '../src/styles/canvasPins.css'), 'utf8');
    const rule = /\.canvas-pin-kept-stack\[data-open\] \.canvas-pin-kept-list \{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/max-height:\s*min\(40vh, 360px\)/);
    expect(rule?.[1]).toMatch(/overflow-y:\s*auto/);
  });
});

describe('GM round 5 answer 5: a kept notice keeps the note\'s line breaks, clamped to 2 lines', () => {
  it('shows the breaks, blank-line runs collapsed; Copy note copies the note whole', () => {
    on('alpha', 'Alpha');
    const text = 'first line\n\n\n   \nsecond line\nthird line';
    useCanvasPinsStore.setState({ kept: [note('alpha', 'Alpha', text)] } as never);
    const { container } = render(<PinComposer />);
    const quote = container.querySelector('.canvas-pin-toast__note')!;
    expect(quote.textContent).toBe('first line\nsecond line\nthird line');
    // The tooltip is the whole note, stripped like every display (fix round 10, GM r16 answer 3): a line of only spaces is empty.
    // The whole note: spaces inside kept as typed (GM r19 answer 1, PR #200 fix round 12).
    expect(quote).toHaveAttribute('title', 'first line\n\n\n   \nsecond line\nthird line');
    const write = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText: write } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy note' }));
    expect(write).toHaveBeenCalledWith(text);
  });

  it('keptNoteDisplay collapses runs of blank lines and spaces-only lines, and trims', () => {
    expect(keptNoteDisplay('a' + '\n'.repeat(278) + 'b')).toBe('a\nb');
    // GM r19 answer 1 (fix round 12): whitespace at the ends goes, the first line's indent too; inside, a
    // line's spaces stay, and a run of blank or spaces-only lines still folds in the display.
    expect(keptNoteDisplay('\n\n a \n \t \nb\n\n')).toBe('a \nb');
    expect(keptNoteDisplay('one line')).toBe('one line');
  });

  it('the CSS keeps the breaks inside the 2-line clamp', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '../src/styles/canvasPins.css'), 'utf8');
    const rule = /\.canvas-pin-toast__note \{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/white-space:\s*pre-line/);
    expect(rule).toMatch(/-webkit-line-clamp:\s*2/);
  });
});

describe('N-5 and N-6: a kept note\'s project name, a failed send\'s error', () => {
  it('N-5: a project renamed after its note was kept is named as it is now', () => {
    on('gamma', 'Third canvas');
    useProjectStore.setState({ projects: [{ id: 'alpha', name: 'Alpha (renamed)' }] } as never);
    useCanvasPinsStore.setState({ kept: [note('alpha', 'Alpha', 'A note')] } as never);
    render(<PinComposer />);
    expect(screen.getByRole('status').textContent).toContain('Your note for “Alpha (renamed)” wasn’t sent');
  });

  it('N-5: a deleted project keeps the name it had', () => {
    on('gamma', 'Third canvas');
    useProjectStore.setState({ projects: [] } as never);
    useCanvasPinsStore.setState({ kept: [note('alpha', 'Alpha', 'A note')] } as never);
    render(<PinComposer />);
    expect(screen.getByRole('status').textContent).toContain('Your note for “Alpha” wasn’t sent');
  });

  it('N-6: leaving the project a send failed on clears its error; it never comes back on return', () => {
    on('alpha', 'Alpha');
    useCanvasPinsStore.setState({ error: "Couldn't save the note. Nebula didn't respond.", errorProject: 'alpha' } as never);
    const view = render(<PinComposer />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => on('beta', 'Second canvas'));
    view.rerender(<PinComposer />);
    expect(useCanvasPinsStore.getState().error).toBeNull();
    act(() => on('alpha', 'Alpha'));
    view.rerender(<PinComposer />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('N-6: an error of another project is left alone by a switch that never was on it', () => {
    on('beta', 'Second canvas');
    useCanvasPinsStore.setState({ error: 'x', errorProject: 'alpha' } as never);
    const view = render(<PinComposer />);
    act(() => on('gamma', 'Third canvas'));
    view.rerender(<PinComposer />);
    expect(useCanvasPinsStore.getState().error).toBe('x');
  });
});

describe('LOW-2: a mask stroke under way ends the moment the lock starts', () => {
  // jsdom loads no image and draws nothing: the painter's image loads at once
  // and every 2D call is recorded.
  let strokes: string[] = [];
  beforeEach(() => {
    strokes = [];
    class LoadingImage {
      naturalWidth = 200;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      crossOrigin = '';
      set src(_value: string) { setTimeout(() => this.onload?.(), 0); }
    }
    vi.stubGlobal('Image', LoadingImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({}, {
      get: (_target, key) => (key === 'stroke' ? () => strokes.push('stroke') : () => {}),
      set: () => true,
    }) as never);
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
    HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
    HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => true);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const openPainter = async () => {
    const view = render(<MaskPainterModal imageUrl="/image.png" initialMask={null} onSave={vi.fn()} onClose={vi.fn()} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const canvas = view.container.querySelector<HTMLCanvasElement>('.mask-painter__strokes')!;
    expect(canvas).toBeTruthy();
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    return canvas;
  };

  it('before: a live stroke paints; a follow mid-stroke stops it at once, and a later move or release paints nothing', async () => {
    const canvas = await openPainter();
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 20, clientY: 10 });
    const live = strokes.length;
    expect(live).toBe(2); // the dot, then the segment
    act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Codex' }));
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 60 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(strokes.length).toBe(live);
    // The follow ends: the old stroke doesn't resume on a move without a press.
    act(() => setFollowingSwitch(null));
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 120, clientY: 60 });
    expect(strokes.length).toBe(live);
  });

  it('a move that arrives before React re-renders with the lock paints nothing either (the handler asks the lock)', async () => {
    const canvas = await openPainter();
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });
    const before = strokes.length;
    // Offline straight from the connection module, then a move in the same tick.
    noteBackendConnection('offline');
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 60, clientY: 40 });
    expect(strokes.length).toBe(before);
    expect(HTMLCanvasElement.prototype.releasePointerCapture).toHaveBeenCalled();
  });
});

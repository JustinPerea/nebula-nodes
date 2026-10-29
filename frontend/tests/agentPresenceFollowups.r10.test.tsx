/**
 * Fix round 10 of PR #200 (review 9, GM r16):
 * - LOW-2 / GM r16 answer 2: after × focus lands on the next notice's ×, never
 *   on a primary or destructive action, so a second Enter can only dismiss. A
 *   notice with no × takes focus itself; an empty stack goes to the surface's
 *   start of page content ("Recent projects" on Projects).
 * - LOW-3: the leave fallback never cuts an exit short when the animation
 *   started late (a blocked main thread): it waits out what is left.
 * - MEDIUM-1 / GM r16 answer 3: the canvas display is an output path. The note
 *   and the reply show stripped, whatever the store kept as typed (the
 *   backend's half: backend/tests/test_pin_text_as_typed.py).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pin } from '../src/lib/wsClient';

const flow = vi.hoisted(() => ({ state: { transform: [0, 0, 1] as [number, number, number], nodeLookup: new Map<string, unknown>() } }));
vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));

const { LEAVE_SLACK_MS, STALL_FADE_MS, STALL_LIMIT_MS, useLeave } = await import('../src/lib/noticeLeave');
const { keptNoteDisplay, pinDisplayText } = await import('../src/lib/canvasPins');
const { PinLayer } = await import('../src/components/canvas/PinLayer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

// jsdom runs no CSS: stand in for noticeRegion.css's leave animation.
type Stub = EventTarget & { animationName: string; currentTime: number; playState: string; pending: boolean; playbackRate: number;
  effect: { getComputedTiming: () => { endTime: number } }; cancel: () => void };
const realGetAnimations = Element.prototype.getAnimations;
let stubs = new WeakMap<Element, Stub>();
let running = false;
beforeEach(() => {
  stubs = new WeakMap();
  running = false;
  Element.prototype.getAnimations = function getAnimations(this: Element) {
    const kind = this.getAttribute('data-leaving');
    if (!kind) return [];
    let stub = stubs.get(this);
    if (!stub) {
      stub = Object.assign(new EventTarget(), {
        animationName: kind === 'row' ? 'notice-row-out' : 'notice-surface-out', currentTime: 0,
        playState: running ? 'running' : 'finished', pending: false, playbackRate: 1,
        effect: { getComputedTiming: () => ({ endTime: 294 }) },
        cancel() { this.playState = 'idle'; this.dispatchEvent(new Event('cancel')); },
      });
      stubs.set(this, stub);
    }
    return [stub] as unknown as Animation[];
  };
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  Element.prototype.getAnimations = realGetAnimations;
  vi.useRealTimers();
});

/** Enter on a focused button activates it, as a browser does. */
const enter = () => act(() => { (document.activeElement as HTMLElement | null)?.click(); });

describe('GM r16 answer 2 (review 9 LOW-2): focus after × lands on the next notice\'s ×', () => {
  type Kind = 'run' | 'undo' | 'bare' | 'delete';
  const fired: string[] = [];
  function Notice({ slot, kind, label, open, onDismiss }: { slot: string; kind: Kind; label: string; open: boolean; onDismiss: () => void }) {
    const leave = useLeave(open ? label : null);
    const target = document.querySelector(`[data-testid="${slot}"]`);
    if (!target || !leave.shown) return null;
    return createPortal(
      <div className={`n-${kind}`} {...leave.props}>
        <span>{leave.shown}</span>
        {kind === 'run' && <button type="button" onClick={() => fired.push(`Run ${label}`)}>Run</button>}
        {kind === 'undo' && <button type="button" onClick={() => fired.push(`Undo ${label}`)}>Undo</button>}
        {kind === 'delete' && <button type="button" onClick={() => fired.push(`Delete ${label}`)}>Delete</button>}
        {kind !== 'bare' && <button type="button" aria-label={`Dismiss ${label}`} onClick={onDismiss}>×</button>}
      </div>,
      target,
    );
  }
  function Stack({ kinds, page }: { kinds: Kind[]; page: 'projects' | 'canvas' | 'main' }) {
    const [open, setOpen] = useState(kinds.map(() => true));
    const [ready, setReady] = useState(false);
    return (
      <>
        {page === 'projects' && <h2 id="recent-projects-title">Recent projects</h2>}
        {page === 'canvas' && <div className="canvas-wrapper" tabIndex={0} data-testid="canvas" />}
        {page === 'main' && <main data-testid="main">Board</main>}
        <div className="notice-region" ref={() => { if (!ready) setReady(true); }}>
          {kinds.map((_, i) => <div key={i} className="notice-region__slot" data-testid={`slot-${i}`} />)}
        </div>
        {ready && kinds.map((kind, i) => (
          <Notice key={i} slot={`slot-${i}`} kind={kind} label={`N${i}`} open={open[i]}
            onDismiss={() => setOpen((now) => now.map((value, j) => (j === i ? false : value)))} />
        ))}
      </>
    );
  }
  beforeEach(() => { fired.length = 0; });

  it('× then a second Enter never runs, undoes or deletes in another notice: it can only dismiss', () => {
    for (const kinds of [['bare', 'run'], ['run', 'undo'], ['undo', 'run', 'delete'], ['delete', 'run']] as Kind[][]) {
      cleanup(); fired.length = 0;
      render(<Stack kinds={kinds} page="canvas" />);
      screen.getByRole('button', { name: `Dismiss N${kinds.length - 1}` }).focus();
      enter();
      // On the notice before: its ×, not its Run, Undo or Delete.
      expect(document.activeElement?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement).className, kinds.join()).toMatch(/^Dismiss N|n-bare/);
      enter(); enter(); enter();
      expect(fired, kinds.join()).toEqual([]);
      expect(document.activeElement).not.toBe(document.body);
    }
  });

  it('goes to the next notice\'s ×, else the one before\'s', () => {
    render(<Stack kinds={['run', 'undo', 'run']} page="canvas" />);
    screen.getByRole('button', { name: 'Dismiss N0' }).focus();
    enter();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss N1' }));
    cleanup();
    render(<Stack kinds={['run', 'undo']} page="canvas" />);
    screen.getByRole('button', { name: 'Dismiss N1' }).focus();
    enter();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss N0' }));
  });

  it('a notice with no × takes focus itself', () => {
    render(<Stack kinds={['run', 'bare']} page="canvas" />);
    screen.getByRole('button', { name: 'Dismiss N0' }).focus();
    enter();
    expect(document.activeElement).toBe(document.querySelector('.n-bare'));
    expect(document.activeElement).toHaveAttribute('tabindex', '-1');
  });

  it('an empty stack goes to the start of page content: "Recent projects" on Projects, the canvas, a Studio\'s <main>', () => {
    for (const [page, target] of [['projects', () => screen.getByRole('heading', { name: 'Recent projects' })],
      ['canvas', () => screen.getByTestId('canvas')], ['main', () => screen.getByTestId('main')]] as const) {
      cleanup();
      render(<Stack kinds={['undo']} page={page} />);
      screen.getByRole('button', { name: 'Dismiss N0' }).focus();
      enter();
      expect(document.activeElement, page).toBe(target());
      enter();
      expect(fired).toEqual([]);
    }
  });
});

describe('review 9 LOW-3: the fallback waits out a leave that started late', () => {
  function Probe({ value }: { value: string | null }) {
    const leave = useLeave(value);
    return leave.shown ? <div data-testid="item" {...leave.props}>{leave.shown}</div> : null;
  }

  it('a main thread blocked past the leave\'s first frame: still running at the timer, so it waits, then ends at the real end', () => {
    vi.useFakeTimers();
    running = true;
    const { rerender } = render(<Probe value="One" />);
    rerender(<Probe value={null} />);
    const item = screen.getByTestId('item');
    const animation = item.getAnimations()[0] as unknown as Stub;
    // The timer was armed for 294 + slack, but the animation's first frame came 400 ms late.
    act(() => { vi.advanceTimersByTime(294 + LEAVE_SLACK_MS - 1); });
    animation.currentTime = 142;
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('item')).toHaveAttribute('data-leaving', 'surface');
    // What it has left (152 ms) plus the slack, from the check.
    act(() => { vi.advanceTimersByTime(152 + LEAVE_SLACK_MS - 20); });
    expect(screen.getByTestId('item')).toBeInTheDocument();
    // The animation ends: its own animationend ends the leave.
    act(() => {
      for (const type of ['animationend', 'webkitAnimationEnd']) {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, 'animationName', { value: 'notice-surface-out' });
        item.dispatchEvent(event);
      }
    });
    expect(screen.queryByTestId('item')).toBeNull();
  });

  it('GM r12 answer 5: a paused (stalled) leave waits up to the limit, then finishes with the reduced-motion fade from where it stands, never a hard cut', () => {
    vi.useFakeTimers();
    running = true;
    const fades: Array<EventTarget & { keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    const realAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const fade = Object.assign(new EventTarget(), { keyframes, options });
      fades.push(fade);
      return fade as unknown as Animation;
    } as typeof HTMLElement.prototype.animate;
    try {
      const { rerender } = render(<Probe value="One" />);
      rerender(<Probe value={null} />);
      const item = screen.getByTestId('item');
      const animation = item.getAnimations()[0] as unknown as Stub;
      animation.playState = 'paused';
      animation.currentTime = 108;
      // Round 10 cut it at the first timer (review 10 NIT-1: 569 ms at opacity 1).
      act(() => { vi.advanceTimersByTime(STALL_LIMIT_MS - 50); });
      expect(screen.getByTestId('item')).toHaveAttribute('data-leaving', 'surface');
      expect(fades).toHaveLength(0);
      act(() => { vi.advanceTimersByTime(100); });
      // The fade, not a cut: still there, fading over the reduced-motion time.
      expect(screen.getByTestId('item')).toBeInTheDocument();
      expect(fades).toHaveLength(1);
      expect(fades[0].options.duration).toBe(STALL_FADE_MS);
      expect(fades[0].keyframes.map((k) => k.opacity)).toEqual(['1', '0']);
      expect(animation.playState).toBe('idle');
      // The exit finishes with the fade: then it goes (the space closes then).
      act(() => { fades[0].dispatchEvent(new Event('finish')); });
      expect(screen.queryByTestId('item')).toBeNull();
    } finally {
      HTMLElement.prototype.animate = realAnimate;
    }
  });

  it('GM r12 answer 5: an endless leave also fades at the limit, and the fade has its own bound', () => {
    vi.useFakeTimers();
    running = true;
    const realAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function animate() { return new EventTarget() as unknown as Animation; } as typeof HTMLElement.prototype.animate;
    try {
      const { rerender } = render(<Probe value="One" />);
      rerender(<Probe value={null} />);
      const animation = screen.getByTestId('item').getAnimations()[0] as unknown as Stub;
      animation.effect = { getComputedTiming: () => ({ endTime: Infinity }) };
      act(() => { vi.advanceTimersByTime(STALL_LIMIT_MS + 300); });
      expect(screen.getByTestId('item')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(STALL_FADE_MS + LEAVE_SLACK_MS + 1); });
      expect(screen.queryByTestId('item')).toBeNull();
    } finally {
      HTMLElement.prototype.animate = realAnimate;
    }
  });

  it('GM r12 answer 5: with the tab hidden, the exit finishes at once (at the start, or the moment it hides)', async () => {
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    try {
      running = true;
      const first = render(<Probe value="One" />);
      first.rerender(<Probe value={null} />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByTestId('item')).toBeNull();
      first.unmount();
      state = 'visible';
      const second = render(<Probe value="Two" />);
      second.rerender(<Probe value={null} />);
      expect(screen.getByTestId('item')).toBeInTheDocument();
      state = 'hidden';
      act(() => { document.dispatchEvent(new Event('visibilitychange')); });
      expect(screen.queryByTestId('item')).toBeNull();
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (visibility) Object.defineProperty(Document.prototype, 'visibilityState', visibility);
    }
  });

  it('a finished one with no event goes at the first check', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Probe value="One" />);
    rerender(<Probe value={null} />);
    act(() => { vi.advanceTimersByTime(294 + LEAVE_SLACK_MS + 1); });
    expect(screen.queryByTestId('item')).toBeNull();
  });
});

describe('GM r16 answer 3: the canvas shows a note and a reply stripped, whatever the store kept', () => {
  // A seeded generator: the same 3,000 cases every run (the backend's fuzz, ported).
  const KNOWN = ['\x1b[31m', '\x1b[0m', '\x1b]0;t\x07', '\x1b]8;;http://e\x1b\\', '\x1bPq#0\x1b\\', '\x1b_Gf=1\x1b\\', '\x1b^pm\x1b\\',
    '\x1bXsos\x1b\\', '\x9b31m', '\x9d0;t\x9c', '\x90q\x9c', '\x9f a\x9c', '\x9e b\x9c', '\x98 c\x9c', '\x1b', '\x1b]', '\x1bP', '\x9d',
    '\x90', '\x1b[', '\x1b[?', '\x1bP\x1b[31m\x1b\\', '\x1b]\x1b]0;x\x07\x07', '\x00', '\x07', '\x08', '\x0b', '\x0c', '\x7f', '\x85',
    ' ', '\r', '\r\n', '\x1bc', '\x1b(B', '\x1b7', '\x1b#8', '\x1bN', '\x1bO', '‮', '​'];
  const ALPHABET = [...Array.from({ length: 0xa0 }, (_, i) => String.fromCharCode(i)), ...'abc ⏎é‮​<>"\\'];
  const cases = (n: number) => {
    let seed = 9;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      let text = 'x';
      for (let parts = 1 + Math.floor(random() * 12); parts > 0; parts -= 1) {
        const r = random();
        if (r < 0.45) text += pick(KNOWN);
        else if (r < 0.8) text += Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(ALPHABET)).join('');
        else text += 'word ';
      }
      out.push(text);
    }
    return [...out, ...KNOWN, ...KNOWN.map((k) => `a${k}b\nsecond line`)];
  };
  // No C0 but \n and \t, no DEL, no C1 (ESC is C0); no format characters either.
  // eslint-disable-next-line no-control-regex -- the bytes it looks for
  const BAD = /[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}]/u;

  it('pinDisplayText: no control byte, for 3,000 notes and replies', () => {
    const leaks = cases(3000).flatMap((raw) => [pinDisplayText(raw), pinDisplayText(raw, { multiline: false }),
      pinDisplayText(raw, { fold: false }), keptNoteDisplay(raw)].filter((out) => BAD.test(out)).map((out) => [raw, out]));
    expect(leaks.slice(0, 3)).toEqual([]);
  });

  it('it matches the backend\'s shown form on the forms review 9 tried', () => {
    // Spaces inside stay (GM r19 answer 1, fix round 12), as the backend now shows them.
    expect(pinDisplayText('say \x1bPlease\tkeep  \nline two \x1b]0;t\x07end \x85x‮   ')).toBe('say \nline two end \nx');
    expect(pinDisplayText('done \x1b[1mbold\x1b[0m\x9b2J and \x07bell\nnext', { multiline: false })).toBe('done bold and bell next');
    expect(pinDisplayText('  indented\n\n\n\nnext', { fold: false })).toBe('indented\n\n\n\nnext');
    expect(pinDisplayText('  indented\n\n\n\nnext')).toBe('indented\nnext');
  });

  it('the pin card, its label and the reply show stripped text (200 raw notes and replies)', () => {
    flow.state.nodeLookup = new Map([['n4', { id: 'n4', measured: { width: 240, height: 160 }, internals: { positionAbsolute: { x: 0, y: 0 } } }]]);
    const raws = cases(200).slice(0, 200);
    const pins: Pin[] = raws.map((raw, i) => ({
      id: `pin_${i}`, text: raw, anchor: { x: i, y: i }, position: null, status: 'resolved', createdAt: new Date().toISOString(),
      detached: false, reply: { agent: { id: 'c', name: 'Codex', color: '#5B9DFF' }, text: `re ${raw}`, at: new Date().toISOString() },
    }) as unknown as Pin);
    useCanvasPinsStore.setState({ pins, removing: {}, composer: null, error: null } as never);
    const { container } = render(<PinLayer />);
    const badges = [...container.querySelectorAll<HTMLButtonElement>('.canvas-pin__badge')];
    expect(badges).toHaveLength(200);
    for (const badge of badges) {
      expect(BAD.test(badge.getAttribute('aria-label') ?? '')).toBe(false);
      fireEvent.click(badge);
    }
    const cards = [...container.querySelectorAll('.canvas-pin__card')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(BAD.test(card.textContent ?? ''), card.textContent ?? '').toBe(false);
  }, 60_000); // 200 pins rendered: about 1 s alone, longer on a loaded machine.
});

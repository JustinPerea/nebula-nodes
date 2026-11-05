/**
 * PR #204 round 15, GM r24 a: a because line sends the general notice away on every Commons state,
 * the New collection prompt open included. The prompt's backdrop (.commons-prompt, a fixed layer
 * over the whole window at rgba(0, 0, 0, 0.4)) was answering the hit test for the page's line, so
 * the line read as covered and the notice stayed (lib/notConnectedLine lineUncovered). The rule now
 * looks beneath a layer the line shows through: a dim with no picture, blur, text or replaced
 * content of its own. Anything else over the line still covers it (review 8 MEDIUM-2).
 */
import { readFileSync } from 'node:fs';
import { ADD_TO_NAME } from './helpers/commonsAddNames';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: null as string | null }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/personSession')>(),
  personToken: async () => transport.token,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { FakeObserver.all.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  /** Every observed line is in the window. */
  static allInView() {
    for (const observer of FakeObserver.all) {
      const entries = [...observer.targets].map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 }) as unknown as IntersectionObserverEntry);
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}
vi.stubGlobal('IntersectionObserver', FakeObserver);

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const lines = await import('../src/lib/notConnectedLine');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');

const PAGE = 'Nebula couldn’t load Commons because this tab isn’t connected as you. Open the link Nebula printed when it started.';
const TOKEN = 'a'.repeat(43);
/** The prompt's backdrop as the app styles it (styles/commons.css), not a copy of its values. */
const PROMPT_RULE = /body\.app-slava-restraint \.commons-prompt \{[^}]*\}/.exec(
  readFileSync(join(__dirname, '../src/styles/commons.css'), 'utf8'))![0];

/** Round 17 (GM r27 3): the mask painter's overlay as the app styles it (styles/mask-painter.css). */
const MASK_RULE = /\.mask-painter__overlay \{[^}]*\}/.exec(
  readFileSync(join(__dirname, '../src/styles/mask-painter.css'), 'utf8'))![0];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function answer(path: string): Response {
  if (path.endsWith('/status')) return json({ worker: { running: false, state: 'idle' }, queue: {} });
  if (path.endsWith('/collections')) return json([{ id: 'c1', name: 'Refs', kind: 'user' }]);
  if (path.endsWith('/search')) return json({ results: [] });
  return json({});
}

const RECT = { left: 100, right: 300, top: 100, bottom: 120, width: 200, height: 20, x: 100, y: 100, toJSON: () => ({}) } as DOMRect;
/**
 * jsdom has no layout: every element gets one rect, and the hit test answers as a browser does
 * where `over` (topmost first) sits above the point: the first layer, then the stack down to the
 * line and the page.
 */
let over: () => Element[] = () => [];
function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
  const stack = (x: number, y: number): Element[] => {
    void x; void y;
    const line = document.querySelector('[data-commons-line]');
    return [...over(), ...(line ? [line] : []), document.body, document.documentElement];
  };
  Object.assign(document, {
    elementFromPoint: (x: number, y: number) => stack(x, y)[0] ?? null,
    elementsFromPoint: (x: number, y: number) => stack(x, y),
  });
}
const unstubLayout = () => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
};

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
async function until(check: () => void, max = 3000): Promise<void> {
  for (let waited = 0; ; waited += 50) {
    try { check(); return; } catch (error) { if (waited >= max) throw error; }
    await tick(50);
  }
}
const generalNotice = () => document.querySelector('.person-required');
/** The lines in the window, the observer told, and the rule's frame run. */
async function settled() {
  await tick(0);
  act(() => FakeObserver.allInView());
  await tick(100);
}

let style: HTMLStyleElement;
beforeEach(() => {
  vi.useFakeTimers();
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  lines.resetLinesForTests();
  window.sessionStorage.clear();
  FakeObserver.all = [];
  transport.token = null;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string) => answer(path));
  document.body.classList.add('app-slava-restraint');
  style = document.createElement('style');
  style.textContent = `${PROMPT_RULE}\n${MASK_RULE}`;
  document.head.append(style);
  over = () => [];
  stubLayout();
});
afterEach(() => {
  cleanup();
  act(() => notePersonPromoted());
  lines.resetLinesForTests();
  style.remove();
  document.body.classList.remove('app-slava-restraint');
  vi.restoreAllMocks();
  unstubLayout();
  vi.useRealTimers();
});

// ── the rule ────────────────────────────────────────────────────────────────

describe('lineUncovered: a layer the line shows through doesn\'t cover it (GM r24 a)', () => {
  /** What each test adds to the page, taken away after it. */
  const added: Element[] = [];
  afterEach(() => { added.splice(0).forEach((element) => element.remove()); });
  const layer = (css: string, inner = '', tag = 'div') => {
    const element = document.createElement(tag);
    added.push(element);
    element.setAttribute('style', css);
    element.textContent = inner;
    document.body.append(element);
    return element;
  };
  let line: HTMLElement;
  beforeEach(() => {
    line = document.createElement('p');
    added.push(line);
    line.textContent = 'A line under the layer.';
    document.body.append(line);
  });
  const coveredBy = (top: Element) => {
    over = () => [top];
    Object.assign(document, {
      elementFromPoint: () => top,
      elementsFromPoint: () => [top, line, document.body, document.documentElement],
    });
    return !lines.lineUncovered(line);
  };

  it('the threshold is a named constant', () => {
    // Round 17 (GM r27 3): lowered from 0.85.
    expect(lines.SEE_THROUGH_ALPHA).toBe(0.6);
  });
  it('the prompt\'s own backdrop, as commons.css styles it: the line shows through', () => {
    const backdrop = document.createElement('div');
    added.push(backdrop);
    backdrop.className = 'commons-prompt';
    backdrop.append(Object.assign(document.createElement('div'), { className: 'commons-prompt__card' }));
    document.body.append(backdrop);
    expect(getComputedStyle(backdrop).backgroundColor).toMatch(/rgba\(0, 0, 0, 0\.4\)/);
    expect(coveredBy(backdrop)).toBe(false);
  });
  it('the mask painter\'s own overlay, as mask-painter.css styles it: a cover (GM r27 3)', () => {
    const overlay = document.createElement('div');
    added.push(overlay);
    overlay.className = 'mask-painter__overlay';
    document.body.append(overlay);
    expect(getComputedStyle(overlay).backgroundColor).toMatch(/rgba\(6, 12, 16, 0\.72\)/);
    expect(coveredBy(overlay)).toBe(true);
  });
  it('a dim at 0.4 (the prompt), 0.45 (a dialog), 0.59, a transparent wrapper, a hidden layer: not a cover', () => {
    expect(coveredBy(layer('background-color: rgba(0, 0, 0, 0.4)'))).toBe(false);
    expect(coveredBy(layer('background-color: rgba(0, 0, 0, 0.45)'))).toBe(false);
    expect(coveredBy(layer('background-color: rgb(0 0 0 / 45%)'))).toBe(false);
    expect(coveredBy(layer('background-color: rgba(0, 0, 0, 0.59)'))).toBe(false);
    expect(coveredBy(layer('background-color: transparent'))).toBe(false);
    expect(coveredBy(layer('visibility: hidden; background-color: rgb(0, 0, 0)'))).toBe(false);
  });
  it('an opaque panel, or one at 0.6 and up: a cover, as the Settings dock is (GM r27 3)', () => {
    expect(coveredBy(layer('background-color: rgb(20, 20, 20)'))).toBe(true);
    expect(coveredBy(layer('background-color: rgba(0, 0, 0, 0.6)'))).toBe(true);
    // The mask painter's overlay and an 0.8 toast: the line behind reads at 20–28% contrast.
    expect(coveredBy(layer('background-color: rgba(26, 26, 28, 0.72)'))).toBe(true);
    expect(coveredBy(layer('background-color: rgba(20, 20, 20, 0.8)'))).toBe(true);
    expect(coveredBy(layer('background-color: rgba(20, 20, 20, 0.85)'))).toBe(true);
    expect(coveredBy(layer('background-color: rgba(20, 20, 20, 0.9)'))).toBe(true);
  });
  it('a see-through layer with words, a picture, or a blur of its own: a cover', () => {
    expect(coveredBy(layer('background-color: transparent', 'Words over the line'))).toBe(true);
    expect(coveredBy(layer('background-color: transparent; background-image: url(x.png)'))).toBe(true);
    expect(coveredBy(layer('', '', 'img'))).toBe(true);
    expect(coveredBy(layer('', '', 'video'))).toBe(true);
    expect(coveredBy(layer('', '', 'canvas'))).toBe(true);
  });
  it('a blur behind the layer: a cover', () => {
    const blurred = layer('background-color: rgba(0, 0, 0, 0.2)');
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const computed = real(element, pseudo);
      if (element !== blurred) return computed;
      return new Proxy(computed, { get: (target, key) => (key === 'backdropFilter' ? 'blur(8px)' : Reflect.get(target, key, target)) });
    });
    expect(coveredBy(blurred)).toBe(true);
  });
  it('under a see-through dim, an opaque layer still covers it: the look goes down the stack and stops there', () => {
    const dim = layer('background-color: rgba(0, 0, 0, 0.4)');
    const panel = layer('background-color: rgb(20, 20, 20)');
    Object.assign(document, { elementFromPoint: () => dim, elementsFromPoint: () => [dim, panel, line, document.body] });
    expect(lines.lineUncovered(line)).toBe(false);
  });
  it('a stack of see-through layers that never reaches the line (it isn\'t at that point): not counted', () => {
    // (An ancestor of the line reaches it, as the rule has it: a line with pointer-events: none.)
    const dim = layer('background-color: rgba(0, 0, 0, 0.4)');
    const wrapper = layer('background-color: transparent');
    Object.assign(document, { elementFromPoint: () => dim, elementsFromPoint: () => [dim, wrapper] });
    expect(lines.lineUncovered(line)).toBe(false);
  });
  it('a browser with no elementsFromPoint: the topmost answer decides, as before', () => {
    const dim = layer('background-color: rgba(0, 0, 0, 0.4)');
    Object.assign(document, { elementFromPoint: () => dim });
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
    expect(lines.lineUncovered(line)).toBe(false);
  });
});

// ── every Commons state with a because line ─────────────────────────────────

function Page() {
  return <><CommonsView /><PersonRequiredBanner /></>;
}
const openPrompt = async () => {
  fireEvent.change(screen.getByRole('combobox', { name: ADD_TO_NAME }), { target: { value: '__new__' } });
  await tick(0);
  fireEvent.change(screen.getByRole('textbox', { name: /New collection name/ }), { target: { value: 'Warm serifs' } });
};
const pageLineShows = () => expect([...document.querySelectorAll('[data-commons-line]')].map((line) => line.textContent)).toContain(PAGE);

describe('the Commons: a because line up, no general notice (GM r24 a)', () => {
  it('held: never connected', async () => {
    act(() => reportPersonRequired());
    render(<Page />);
    await until(pageLineShows);
    await settled();
    expect(generalNotice()).toBeNull();
  });

  it('demoted', async () => {
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<Page />);
    await tick(600);
    act(() => reportPersonRequired());
    await until(pageLineShows);
    await settled();
    expect(generalNotice()).toBeNull();
  });

  it('a stale token kept across a reload', async () => {
    window.sessionStorage.setItem('nebula.person', JSON.stringify({ token: 'stale-person-token-0123456789', backend: 'http://127.0.0.1:8000' }));
    transport.token = 'stale-person-token-0123456789';
    act(() => reportPersonRequired());
    await tick(200);
    render(<Page />);
    await until(pageLineShows);
    await settled();
    expect(generalNotice()).toBeNull();
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('the New collection prompt open at a demote: its backdrop over the page line', async () => {
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<Page />);
    await tick(600);
    await openPrompt();
    over = () => [...document.querySelectorAll('.commons-prompt')];
    act(() => reportPersonRequired());
    await until(pageLineShows);
    await settled();
    expect(document.querySelector('.commons-prompt')).not.toBeNull();
    expect(screen.getByText('You can create collections when this tab is connected as you.')).toBeTruthy();
    expect(generalNotice()).toBeNull();
  });

  it('control: the same prompt over an opaque layer brings the notice back (the test can see it)', async () => {
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<Page />);
    await tick(600);
    await openPrompt();
    const panel = document.createElement('div');
    panel.setAttribute('style', 'background-color: rgb(20, 20, 20)');
    document.body.append(panel);
    over = () => [...document.querySelectorAll('.commons-prompt'), panel];
    act(() => reportPersonRequired());
    await until(pageLineShows);
    await settled();
    // Round 17 (GM r27 2): it waits for a line it can count, up to the cap.
    await tick(lines.BECAUSE_LINE_WAIT_MS);
    expect(generalNotice()).not.toBeNull();
    panel.remove();
  });
});

// ── Round 17 (review 13 LOW-2, GM r27 2): on a demote the notice waits for the because line ──
// Live, the notice slid in about 140 ms before the page's because line landed (its loads are
// refused after the held rule's 150 ms), then slid out: two changes. The Commons says a demote
// there brings its own line (expectBecauseLine), and the notice waits for it, capped at
// BECAUSE_LINE_WAIT_MS. Every frame is recorded: the observer reports each line in view as soon
// as it mounts, as a browser does within a frame.
describe('a demote on the Commons: the notice waits for the because line (GM r27 2)', () => {
  /** Each 10 ms frame from the demote: [ms, notice up, page line up]. */
  async function framesFromDemote(until: number): Promise<[number, boolean, boolean][]> {
    const frames: [number, boolean, boolean][] = [];
    // Any notice mounted at all, even one gone again in the same commit (jsdom runs no leave
    // animation, so a notice let in and sent out at once would never be read by a frame; live it
    // drew for 200 ms).
    let mounted = false;
    const seen = (records: MutationRecord[]) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('.person-required') || node.querySelector('.person-required'))) mounted = true;
      }
    };
    const watch = new MutationObserver(seen);
    watch.observe(document.body, { subtree: true, childList: true });
    act(() => reportPersonRequired());
    for (let t = 0; t <= until; t += 10) {
      seen(watch.takeRecords());
      const lineUp = [...document.querySelectorAll('[data-commons-line]')].some((line) => line.textContent === PAGE);
      frames.push([t, generalNotice() !== null || mounted, lineUp]);
      mounted = false;
      act(() => FakeObserver.allInView());
      await tick(10);
    }
    watch.disconnect();
    return frames;
  }

  it('the cap is Add\'s, 1.5 s', async () => {
    const { ADD_LINE_HOLD_MS } = await import('../src/components/commons/useLockLineHold');
    expect(lines.BECAUSE_LINE_WAIT_MS).toBe(1500);
    expect(lines.BECAUSE_LINE_WAIT_MS).toBe(ADD_LINE_HOLD_MS);
  });

  it('the line lands within the cap: no frame shows the notice, before or after it', async () => {
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<Page />);
    await tick(600);
    const frames = await framesFromDemote(2500);
    const lineAt = frames.find(([, , line]) => line)?.[0];
    expect(lineAt).toBeDefined();
    expect(lineAt!).toBeLessThan(lines.BECAUSE_LINE_WAIT_MS);
    expect(frames.filter(([, notice]) => notice)).toEqual([]);
  });

  it('with the prompt open at the demote, the same', async () => {
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<Page />);
    await tick(600);
    await openPrompt();
    over = () => [...document.querySelectorAll('.commons-prompt')];
    const frames = await framesFromDemote(2500);
    expect(frames.some(([, , line]) => line)).toBe(true);
    expect(frames.filter(([, notice]) => notice)).toEqual([]);
  });

  it('no line it can count (an opaque layer over it): the notice enters at the cap, not before', async () => {
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<Page />);
    await tick(600);
    const panel = document.createElement('div');
    panel.setAttribute('style', 'background-color: rgb(20, 20, 20)');
    document.body.append(panel);
    over = () => [panel];
    const frames = await framesFromDemote(2500);
    const enteredAt = frames.find(([, notice]) => notice)?.[0];
    panel.remove();
    expect(enteredAt).toBeDefined();
    expect(enteredAt!).toBeGreaterThanOrEqual(lines.BECAUSE_LINE_WAIT_MS);
    expect(enteredAt!).toBeLessThanOrEqual(lines.BECAUSE_LINE_WAIT_MS + 20);
  });

  it('the Commons closes while the notice waits: it enters then, not at the cap', async () => {
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    // The banner stays mounted (unmounting it clears its line); only the Commons goes.
    const Both = ({ commons }: { commons: boolean }) => <>{commons && <CommonsView />}<PersonRequiredBanner /></>;
    const view = render(<Both commons />);
    await tick(600);
    const panel = document.createElement('div');
    panel.setAttribute('style', 'background-color: rgb(20, 20, 20)');
    document.body.append(panel);
    over = () => [panel];
    act(() => reportPersonRequired());
    await tick(50);
    expect(generalNotice()).toBeNull();
    view.rerender(<Both commons={false} />);
    await tick(10);
    panel.remove();
    expect(generalNotice()).not.toBeNull();
  });

  it('a notice up whose words change while the Commons is open: it stays, no leave', async () => {
    const { setPersonBannerLine } = await import('../src/lib/personSession');
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<Page />);
    await tick(600);
    const panel = document.createElement('div');
    panel.setAttribute('style', 'background-color: rgb(20, 20, 20)');
    document.body.append(panel);
    over = () => [panel];
    act(() => reportPersonRequired());
    await tick(lines.BECAUSE_LINE_WAIT_MS + 50);
    const before = generalNotice();
    expect(before).not.toBeNull();
    act(() => setPersonBannerLine('Other words for the same notice.'));
    await tick(10);
    panel.remove();
    expect(generalNotice()).toBe(before);
    expect(generalNotice()?.hasAttribute('data-leaving')).toBe(false);
    expect(generalNotice()?.textContent).toContain('Other words for the same notice.');
  });

  it('a screen that brings no line of its own (no Commons): the notice enters at once', async () => {
    render(<PersonRequiredBanner />);
    act(() => reportPersonRequired());
    await tick(0);
    expect(generalNotice()).not.toBeNull();
  });

  it('a notice already up isn\'t taken away when the Commons opens', async () => {
    const view = render(<PersonRequiredBanner />);
    act(() => reportPersonRequired());
    await tick(0);
    expect(generalNotice()).not.toBeNull();
    const release = lines.expectBecauseLine();
    view.rerender(<PersonRequiredBanner />);
    await tick(10);
    expect(generalNotice()).not.toBeNull();
    release();
  });
});

/**
 * PR #204 round 10, review 8:
 * - MEDIUM-2: a line covered by something opaque (Settings' dock) doesn't count; the dock closing,
 *   or a panel moving, settles the lines again (lib/notConnectedLine lineUncovered).
 * - MEDIUM-3: a line registers once and its words update in place, so a line whose words change
 *   keeps what the observer said, and the notice neither comes back nor announces.
 * - LOW-3: the observer's ratio guard, the unregister guard, and two lines in one element.
 * Harness from presenceRound9.notice.test.tsx.
 */
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { FakeObserver.all.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  static report(within: Element, isIntersecting: boolean, intersectionRatio = isIntersecting ? 0.5 : 0) {
    for (const observer of FakeObserver.all) {
      const entries = [...observer.targets].filter((target) => within === target || within.contains(target))
        .map((target) => ({ target, isIntersecting, intersectionRatio }) as unknown as IntersectionObserverEntry);
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}
vi.stubGlobal('IntersectionObserver', FakeObserver);

const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { LineText } = await import('../src/components/LineText');
const lines = await import('../src/lib/notConnectedLine');
const session = await import('../src/lib/personSession');
const copy = await import('../src/lib/errorCopy');

const banner = () => document.querySelector('.person-required');
const announced = () => document.querySelector('.person-required__announce')?.textContent ?? null;
const nextFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
const quiet = async () => { for (let i = 0; i < 3; i++) await nextFrame(); };
const because = copy.notConnectedBecause('save your preferences', false);
const becauseToo = copy.notConnectedBecause('change keys', false);

/**
 * jsdom has no layout: give every element one rect, and hit testing that answers with the dock
 * where it covers. `covered` is the share of the sampled points (centre, then left, right, top,
 * bottom) the dock answers for.
 */
const hits = { covered: 0, calls: 0 };
function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 100, right: 300, top: 100, bottom: 120, width: 200, height: 20, x: 100, y: 100, toJSON: () => ({}) } as DOMRect);
  let point = 0;
  (document as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => {
    hits.calls += 1;
    const dock = document.querySelector('.settings-dock');
    const line = document.querySelector('.settings-row__error');
    const index = point++ % 5;
    return dock && index < hits.covered * 5 ? dock : line;
  };
}

const handle: { show: (line: string | null) => void; dock: (open: boolean) => void } = { show: () => {}, dock: () => {} };
function Settings({ live = true }: { live?: boolean }) {
  const [line, setLine] = useState<string | null>(null);
  const [dock, setDock] = useState(false);
  useEffect(() => { handle.show = setLine; handle.dock = setDock; }, []);
  return <>
    <PersonRequiredBanner />
    {line && <p className="settings-row__error" role={live ? 'alert' : undefined}><LineText text={line} /></p>}
    {dock && <div className="settings-dock" />}
  </>;
}

beforeEach(() => {
  session.resetPersonSessionForTests(); lines.resetLinesForTests(); FakeObserver.all = [];
  hits.covered = 0; hits.calls = 0;
});
afterEach(() => {
  cleanup(); session.notePersonPromoted(); lines.resetLinesForTests(); vi.restoreAllMocks();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

const showInView = async (text: string, live = true) => {
  render(<Settings live={live} />);
  act(() => session.reportPersonRequired());
  act(() => handle.show(text));
  act(() => FakeObserver.report(document.querySelector('.settings-row__error')!, true));
  await quiet();
};

describe('review 8 MEDIUM-2: a covered line doesn\'t count', () => {
  it('wholly under the dock: the notice shows; the dock closing lets the line count, and the notice steps out', async () => {
    stubLayout();
    hits.covered = 1;
    await showInView(because);
    act(() => handle.dock(true));
    await quiet();
    expect(hits.calls).toBeGreaterThan(0);
    expect(banner()).not.toBeNull();
    act(() => handle.dock(false));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('partly under the dock (one point still lands on the line): it counts', async () => {
    stubLayout();
    hits.covered = 0.8;
    await showInView(because);
    act(() => handle.dock(true));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('the dock opening over a counted line brings the notice back', async () => {
    stubLayout();
    hits.covered = 1;
    await showInView(because);
    await waitFor(() => expect(banner()).toBeNull());
    act(() => handle.dock(true));
    await waitFor(() => expect(banner()).not.toBeNull());
  });

  it('a line wholly outside the window has no point to sample and doesn\'t count', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, right: 300, top: -200, bottom: -180, width: 200, height: 20, x: 100, y: -200, toJSON: () => ({}) } as DOMRect);
    (document as { elementFromPoint: () => Element | null }).elementFromPoint = () => document.body;
    const element = document.createElement('p');
    document.body.append(element);
    expect(lines.lineUncovered(element)).toBe(false);
    element.remove();
  });
});

describe('review 8 MEDIUM-3: new words update the one registration', () => {
  it('a line that isn\'t a live region: said once when it takes the notice\'s place, not again when its words change', async () => {
    await showInView(because, false);
    await waitFor(() => expect(banner()).toBeNull());
    await waitFor(() => expect(announced()).toBe(because));
    act(() => handle.show(becauseToo));
    await quiet();
    expect(document.querySelector('.settings-row__error')!.textContent).toBe(becauseToo);
    expect(banner()).toBeNull();
    expect(announced()).toBe(because);
  });

  it('a because line swapped for another: no flash of the notice, nothing announced', async () => {
    await showInView(because);
    await waitFor(() => expect(banner()).toBeNull());
    const before = announced();
    const seen: boolean[] = [];
    const watch = new MutationObserver(() => { seen.push(banner() !== null); });
    watch.observe(document.body, { subtree: true, childList: true });
    act(() => handle.show(becauseToo));
    await quiet();
    watch.disconnect();
    expect(document.querySelector('.settings-row__error')!.textContent).toBe(becauseToo);
    expect(seen.every((shown) => !shown)).toBe(true);
    expect(banner()).toBeNull();
    expect(announced()).toBe(before);
    expect(lines.registeredLines().size).toBe(1);
  });
});

describe('review 8 LOW-3: the guards', () => {
  it('intersecting at ratio 0 (an edge touching the window) is not in view', async () => {
    render(<Settings />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(because));
    act(() => FakeObserver.report(document.querySelector('.settings-row__error')!, true, 0));
    await quiet();
    expect(banner()).not.toBeNull();
  });

  it('an old registration unregistering again leaves the element\'s other owner registered', () => {
    const element = document.createElement('p');
    document.body.append(element);
    const first = lines.registerLine(element, because);
    const second = lines.registerLine(element, becauseToo);
    first();
    first.unregister();
    expect(lines.registeredLines().get(element)?.text).toBe(becauseToo);
    first.update(because);
    expect(lines.registeredLines().get(element)?.text).toBe(becauseToo);
    second();
    expect(lines.registeredLines().has(element)).toBe(false);
    expect(element.hasAttribute(lines.LINE_ATTR)).toBe(false);
    element.remove();
  });

  it('two LineTexts in one element don\'t lose each other (StrictMode\'s double mount too)', async () => {
    const lock = copy.personLockLine('change keys', false);
    const both: { set: (n: number) => void } = { set: () => {} };
    function Two() {
      const [count, setCount] = useState(2);
      useEffect(() => { both.set = setCount; }, []);
      return <p className="two"><LineText text={lock} />{count > 1 && <LineText text={because} />}</p>;
    }
    render(<StrictMode><Two /></StrictMode>);
    const element = document.querySelector('.two')!;
    expect(lines.registeredLines().get(element)?.kind).toBe('fix');
    act(() => both.set(1));
    expect(lines.registeredLines().get(element)?.kind).toBe('lock');
    expect(element.hasAttribute(lines.LINE_ATTR)).toBe(true);
  });

  it('whichever comes first, the fix line counts while it is there', () => {
    const lock = copy.personLockLine('change keys', false);
    render(<p className="order"><LineText text={because} /><LineText text={lock} /></p>);
    expect(lines.registeredLines().get(document.querySelector('.order')!)?.kind).toBe('fix');
  });
});

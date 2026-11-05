/**
 * PR #204 round 11 (review 9 lock-sweep MEDIUM-2): a because line handing over to another
 * element in one commit (A unregisters, B registers) used to drop the answer until B's first
 * observer entry, so the general notice flashed back (about 330 ms live) and was announced again.
 * Now the answer on screen holds until that entry (lib/notConnectedLine settle). Both shapes:
 * A on one element and B on another, and two LineText instances swapped on one element (a
 * ternary, as ProjectHome's error box has). Harness from presenceRound10.lines.test.tsx.
 */
import { useEffect, useState } from 'react';
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
  static report(within: Element, isIntersecting: boolean) {
    for (const observer of FakeObserver.all) {
      const entries = [...observer.targets].filter((target) => within === target || within.contains(target))
        .map((target) => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 0.5 : 0 }) as unknown as IntersectionObserverEntry);
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
const quiet = async () => { for (let i = 0; i < 4; i++) await nextFrame(); };
const lineA = copy.notConnectedBecause('save the style', false);
const lineB = copy.notConnectedBecause('load your work', false);

type Shown = { at: 'a' | 'b'; text: string; variant?: 0 | 1 } | null;
const handle: { show: (shown: Shown) => void } = { show: () => {} };
function Cards() {
  const [shown, setShown] = useState<Shown>(null);
  useEffect(() => { handle.show = setShown; }, []);
  return <>
    <PersonRequiredBanner />
    <div className="card-a">{shown?.at === 'a' && <p className="line-a"><LineText text={shown.text} /></p>}</div>
    {/* One element, two LineText instances by a ternary (ProjectHome's error box). */}
    <div className="card-b">{shown?.at === 'b' && <p className="line-b">
      {shown.variant === 1 ? <LineText key="one" text={shown.text} /> : <LineText key="zero" text={shown.text} />}
    </p>}</div>
  </>;
}

beforeEach(() => { session.resetPersonSessionForTests(); lines.resetLinesForTests(); FakeObserver.all = []; });
afterEach(() => { cleanup(); session.notePersonPromoted(); lines.resetLinesForTests(); });

const watchBanner = () => {
  const seen: boolean[] = [];
  const watch = new MutationObserver(() => { seen.push(banner() !== null); });
  watch.observe(document.body, { subtree: true, childList: true });
  return { seen, stop: () => watch.disconnect() };
};

async function start(shown: Shown, selector: string) {
  render(<Cards />);
  act(() => session.reportPersonRequired());
  act(() => handle.show(shown));
  act(() => FakeObserver.report(document.querySelector(selector)!, true));
  await quiet();
  await waitFor(() => expect(banner()).toBeNull());
}

describe('a because line handing over to another element (review 9 MEDIUM-2)', () => {
  it('A on one card, then B on another in one commit: no flash, nothing announced again (as a change of words)', async () => {
    await start({ at: 'a', text: lineA }, '.line-a');
    const watch = watchBanner();
    act(() => handle.show({ at: 'b', text: lineB }));
    await quiet(); // frames pass before B's first entry: the answer holds
    expect(banner()).toBeNull();
    act(() => FakeObserver.report(document.querySelector('.line-b')!, true));
    await quiet();
    watch.stop();
    expect(watch.seen.every((shown) => !shown)).toBe(true);
    expect(banner()).toBeNull();
    expect(announced()).toBe(lineA);
  });

  it('two instances swapped on one element (a ternary): no flash', async () => {
    await start({ at: 'b', text: lineB, variant: 0 }, '.line-b');
    const watch = watchBanner();
    act(() => handle.show({ at: 'b', text: lineB, variant: 1 }));
    await quiet();
    act(() => FakeObserver.report(document.querySelector('.line-b')!, true));
    await quiet();
    watch.stop();
    expect(watch.seen.every((shown) => !shown)).toBe(true);
    expect(banner()).toBeNull();
  });

  it('the hold ends with the entry: B out of view brings the notice back', async () => {
    await start({ at: 'a', text: lineA }, '.line-a');
    act(() => handle.show({ at: 'b', text: lineB }));
    await quiet();
    act(() => FakeObserver.report(document.querySelector('.line-b')!, false));
    await quiet();
    expect(banner()).not.toBeNull();
  });
});

/**
 * PR #204 round 12, GM r20 3: one rule for the general notice. A because line on screen sends it
 * away; a lock line alone keeps it; when both show, the because line wins. The rule is checked
 * here after a demote on the two sections GM named: the Commons (GM's shot 09 showed its because
 * line beside the notice) and Personal agents. `noticeBesideBecauseLine` is the ratchet: it fails
 * whenever the general notice shows while a registered because line is on screen (in view by the
 * observer, rendered). The live check runs the same rule on every screen it visits, and records
 * each frame from a demote until the handover settles.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: () => new Promise<Response>(() => {}),
}));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
const api = vi.hoisted(() => ({ fetchPersonalAgents: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  fetchPersonalAgents: (...args: unknown[]) => api.fetchPersonalAgents(...args),
}));

/** An IntersectionObserver the test drives: a line is out of view until `report` says otherwise. */
class FakeObserver {
  static all: FakeObserver[] = [];
  static inView = new Set<Element>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { FakeObserver.all.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  /** Every observed line enters the window, as the browser reports it after layout. */
  static reportAll() {
    for (const observer of FakeObserver.all) {
      const entries = [...observer.targets].map((target) => {
        FakeObserver.inView.add(target);
        return { target, isIntersecting: true, intersectionRatio: 0.5 } as unknown as IntersectionObserverEntry;
      });
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}
vi.stubGlobal('IntersectionObserver', FakeObserver);

const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { CommonsView } = await import('../src/components/commons/CommonsView');
const { PersonalAgentsSection } = await import('../src/components/panels/settings/PersonalAgentsSection');
const lines = await import('../src/lib/notConnectedLine');
const session = await import('../src/lib/personSession');
const { holdCommonsCalls } = await import('../src/lib/commonsHold');
const copy = await import('../src/lib/errorCopy');

const banner = () => document.querySelector('.person-required');

/** The ratchet (GM r20 3): the general notice never shows beside a because line on screen. */
function noticeBesideBecauseLine(): string[] {
  if (!banner()) return [];
  return [...lines.registeredLines()]
    .filter(([element, line]) => line.kind === 'fix' && element.isConnected && FakeObserver.inView.has(element) && lines.lineRendered(element))
    .map(([, line]) => `the general notice shows beside "${line.text}"`);
}

const frames = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
/** The handover (150 ms), the line's first observer entry, and the frame that settles the lines. */
const handover = async () => {
  await frames(200);
  act(() => FakeObserver.reportAll());
  await frames(50);
  await frames(50);
};
const demote = () => act(() => { session.notePersonPromoted(); session.reportPersonRequired(); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  session.resetPersonSessionForTests();
  lines.resetLinesForTests();
  holdCommonsCalls(false);
  FakeObserver.all = [];
  FakeObserver.inView = new Set();
  api.fetchPersonalAgents.mockReset().mockResolvedValue({ warningAcknowledged: true, agents: [] });
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  lines.resetLinesForTests();
  vi.useRealTimers();
});

describe('one rule for the general notice (GM r20 3)', () => {
  it('a demote, then the Commons: once the handover settles, only the because line shows', async () => {
    render(<><PersonRequiredBanner /><CommonsView /></>);
    await frames(200);
    demote();
    await handover();
    const shown = [...lines.registeredLines()].filter(([element, line]) => line.kind === 'fix' && element.isConnected);
    // The Commons' because line (its status read or its references, whichever answered first).
    expect(shown).toHaveLength(1);
    expect(shown[0][0].closest('[data-commons-line="not-connected"]')).not.toBeNull();
    expect(banner()).toBeNull();
    // Add's lock line is there too: a lock line alone would keep the notice; beside the because line it doesn't.
    expect([...lines.registeredLines().values()].some((line) => line.kind === 'lock')).toBe(true);
    expect(noticeBesideBecauseLine()).toEqual([]);
  });

  it('Personal agents: its because line sends the notice away', async () => {
    render(<><PersonRequiredBanner /><PersonalAgentsSection /></>);
    await frames(50);
    demote();
    await handover();
    const shown = [...lines.registeredLines()].filter(([element, line]) => line.kind === 'fix' && element.isConnected);
    expect(shown.map(([, line]) => line.text)).toEqual([copy.notConnectedBecause('load your agents')]);
    expect(banner()).toBeNull();
    expect(noticeBesideBecauseLine()).toEqual([]);
  });

  it('a lock line alone keeps the notice', async () => {
    render(<PersonRequiredBanner />);
    const line = document.createElement('p');
    line.textContent = 'You can add references when this tab is connected as you.';
    document.body.appendChild(line);
    const registration = lines.registerLine(line, line.textContent);
    act(() => session.reportPersonRequired());
    await handover();
    expect(banner()).not.toBeNull();
    expect(noticeBesideBecauseLine()).toEqual([]);
    registration();
    line.remove();
  });

  it('the ratchet fails a because line on screen beside the notice', async () => {
    // The notice drawn by hand beside a registered because line: what GM's shot 09 showed.
    const notice = document.createElement('div');
    notice.className = 'person-required';
    document.body.appendChild(notice);
    const line = document.createElement('p');
    const because = copy.notConnectedBecause('load the references');
    line.textContent = because;
    document.body.appendChild(line);
    const registration = lines.registerLine(line, because);
    act(() => FakeObserver.reportAll());
    expect(noticeBesideBecauseLine()).toEqual([`the general notice shows beside "${because}"`]);
    registration();
    line.remove();
    notice.remove();
  });
});

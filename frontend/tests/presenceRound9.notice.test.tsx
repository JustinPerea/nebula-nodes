/**
 * PR #204 round 9, review 7 MEDIUM-1: the one-notice rule reads registrations, not the page's
 * text. A line registers through <LineText> (FailureLines and CommonsErrorLine render through
 * it), and counts only while an IntersectionObserver (root: the window) says it is in view and
 * nothing it can't see hides it. Review 7: a because line scrolled out of Settings' scroll box
 * still sent the notice away, and an agent's note quoting the general words did too.
 */
import { StrictMode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

/** An IntersectionObserver the test drives: each observed line is out of view until it says so. */
class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  readonly options: IntersectionObserverInit | undefined;
  constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.options = options;
    FakeObserver.all.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  /** Reports each line inside `within` (or the line itself) in or out of view. */
  static report(within: Element, inView: boolean) {
    for (const observer of FakeObserver.all) {
      const entries = [...observer.targets].filter((target) => within === target || within.contains(target)).map((target) => ({
        target, isIntersecting: inView, intersectionRatio: inView ? 0.5 : 0,
      }) as unknown as IntersectionObserverEntry);
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}
vi.stubGlobal('IntersectionObserver', FakeObserver);

const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { LineText } = await import('../src/components/LineText');
const { FailureLines } = await import('../src/components/failure/FailureLines');
const { CommonsErrorLine } = await import('../src/components/commons/CommonsErrorLine');
const lines = await import('../src/lib/notConnectedLine');
const session = await import('../src/lib/personSession');
const copy = await import('../src/lib/errorCopy');

const banner = () => document.querySelector('.person-required');
const nextFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
const quiet = async () => { for (let i = 0; i < 3; i++) await nextFrame(); };
const because = copy.notConnectedBecause('save your preferences', false);

const handle: { show: (line: string | null) => void } = { show: () => {} };
/** Settings' shape: a scroll box with the line at its foot. */
function Settings() {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => { handle.show = setLine; }, []);
  return <>
    <PersonRequiredBanner />
    <div className="settings-scroll" style={{ overflow: 'auto', height: 200 }}>
      <div style={{ height: 2000 }}>Preferences</div>
      {line && <p className="settings-row__error" role="alert"><LineText text={line} /></p>}
    </div>
  </>;
}

beforeEach(() => { session.resetPersonSessionForTests(); lines.resetLinesForTests(); FakeObserver.all = []; });
afterEach(() => { cleanup(); session.notePersonPromoted(); lines.resetLinesForTests(); });

describe('review 7 MEDIUM-1: a line counts only while it is in view', () => {
  it('watches with the window as root, any part in view counting', async () => {
    render(<Settings />);
    act(() => handle.show(because));
    await nextFrame();
    expect(FakeObserver.all).toHaveLength(1);
    expect(FakeObserver.all[0].options?.root ?? null).toBeNull();
    const thresholds = [FakeObserver.all[0].options?.threshold ?? []].flat();
    expect(thresholds.some((value) => value > 0)).toBe(true);
  });

  it('a because line scrolled out of the scroll box: the notice shows; scrolled into view: it steps out', async () => {
    render(<Settings />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(because));
    const line = document.querySelector('.settings-row__error')!;
    // Not reported yet (below the box's fold): it doesn't count.
    await quiet();
    expect(banner()).not.toBeNull();
    act(() => FakeObserver.report(line, false));
    await quiet();
    expect(banner()).not.toBeNull();
    act(() => FakeObserver.report(line, true));
    await waitFor(() => expect(banner()).toBeNull());
    // Scrolled back out: the notice comes back.
    act(() => FakeObserver.report(line, false));
    await waitFor(() => expect(banner()).not.toBeNull());
  });

  it('in view but hidden by an ancestor IntersectionObserver can\'t see (inert alone): the notice stays, and goes when that lifts', async () => {
    render(<Settings />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(because));
    const box = document.querySelector<HTMLElement>('.settings-scroll')!;
    act(() => FakeObserver.report(box, true));
    await waitFor(() => expect(banner()).toBeNull());
    // Only `inert` changes (review 7 LOW-4, N7): no class, no style, no text.
    await quiet();
    act(() => { box.setAttribute('inert', ''); });
    await waitFor(() => expect(banner()).not.toBeNull());
    await quiet();
    act(() => { box.removeAttribute('inert'); });
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('the round 8 case: Settings in the hidden, inert group the Commons leaves mounted', async () => {
    function App() {
      const [commons, setCommons] = useState(false);
      useEffect(() => { handleCommons.set = setCommons; }, []);
      return <>
        <PersonRequiredBanner />
        <div className={`workspace-overlays${commons ? ' workspace-overlays--hidden' : ''}`} inert={commons} hidden={commons}>
          <p className="settings-row__error"><LineText text={because} /></p>
        </div>
      </>;
    }
    const handleCommons: { set: (value: boolean) => void } = { set: () => {} };
    render(<App />);
    act(() => session.reportPersonRequired());
    const line = document.querySelector('.settings-row__error')!;
    act(() => FakeObserver.report(line, true));
    await waitFor(() => expect(banner()).toBeNull());
    act(() => handleCommons.set(true));
    // A hidden element leaves the viewport too.
    act(() => FakeObserver.report(line, false));
    await waitFor(() => expect(banner()).not.toBeNull());
    act(() => handleCommons.set(false));
    act(() => FakeObserver.report(line, true));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('a closed popover: its line unmounts or leaves the viewport, and the notice comes back', async () => {
    function Popover() {
      const [open, setOpen] = useState(true);
      useEffect(() => { handlePopover.set = setOpen; }, []);
      return <>
        <PersonRequiredBanner />
        {open && <div role="dialog"><p><LineText text={because} /></p></div>}
      </>;
    }
    const handlePopover: { set: (value: boolean) => void } = { set: () => {} };
    render(<Popover />);
    act(() => session.reportPersonRequired());
    act(() => FakeObserver.report(document.querySelector('[role="dialog"]')!, true));
    await waitFor(() => expect(banner()).toBeNull());
    act(() => handlePopover.set(false));
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(lines.registeredLines().size).toBe(0);
  });
});

describe('review 7 NIT-2 and NIT-3: what registers, not what the page says', () => {
  it('an agent\'s note quoting the general words exactly leaves the notice showing', async () => {
    render(<>
      <PersonRequiredBanner />
      <article className="agent-note"><p className="agent-note-card__text" data-agent-text="">{`The tab said: “${copy.PERSON_REQUIRED_COPY}” — ${because}`}</p></article>
    </>);
    act(() => session.reportPersonRequired());
    act(() => FakeObserver.report(document.body, true));
    await quiet();
    expect(document.querySelector('.agent-note')!.textContent).toContain(copy.PERSON_REQUIRED_COPY);
    expect(banner()).not.toBeNull();
    expect(lines.registeredLines().size).toBe(0);
  });

  it('a line split over a heading and a reason registers by its reason', async () => {
    render(<>
      <PersonRequiredBanner />
      <div role="alert"><FailureLines failure={{ heading: 'Couldn’t load your agents.', reason: copy.personRequiredCopy(false) }} /></div>
    </>);
    act(() => session.reportPersonRequired());
    act(() => FakeObserver.report(document.body, true));
    await waitFor(() => expect(banner()).toBeNull());
    expect([...lines.registeredLines().values()].map((line) => line.kind)).toEqual(['fix']);
  });

  it('a Commons line: neutral (the shared because style, GM r14 (4)) and a status when it is the because form, red and an alert otherwise', async () => {
    const commons = copy.commonsNotConnectedCopy('Couldn’t load the references.', false);
    expect(commons).toBe('Nebula couldn’t load the references because this tab isn’t connected as you. Open the link Nebula printed when it started.');
    render(<>
      <PersonRequiredBanner />
      <CommonsErrorLine line={commons} />
      <CommonsErrorLine line="Couldn’t load the references. Nebula didn’t respond. Try again." />
    </>);
    const [person, other] = [...document.querySelectorAll('.commons-notice')];
    expect(person.hasAttribute('data-line-because')).toBe(true);
    expect(person.getAttribute('role')).toBe('status');
    expect(other.className).toBe('commons-notice commons-notice--error');
    expect(other.hasAttribute('data-line-because')).toBe(false);
    expect(other.getAttribute('role')).toBe('alert');
    act(() => session.reportPersonRequired());
    act(() => FakeObserver.report(document.body, true));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('the words stay in the surface\'s own element: its role and class, with an anchor that never shows', () => {
    const { container } = render(<p className="row" role="alert"><LineText text={because} /></p>);
    const row = container.querySelector('p')!;
    expect(row.textContent).toBe(because);
    expect(row.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(row.querySelector<HTMLElement>('[data-line-anchor]')!.style.display).toBe('none');
    expect([...lines.registeredLines().keys()]).toEqual([row]);
  });

  it('StrictMode\'s double mount leaves one registration, and unmount none', () => {
    const view = render(<StrictMode><p><LineText text={because} /></p></StrictMode>);
    expect(lines.registeredLines().size).toBe(1);
    view.unmount();
    expect(lines.registeredLines().size).toBe(0);
  });

  it('a line whose words change re-registers under its new kind', () => {
    function Row({ text }: { text: string }) { return <p><LineText text={text} /></p>; }
    const view = render(<Row text={because} />);
    expect([...lines.registeredLines().values()].map((line) => line.kind)).toEqual(['fix']);
    view.rerender(<Row text={copy.notConnectedBecause('save your preferences', true, 'debug-port')} />);
    expect([...lines.registeredLines().values()].map((line) => line.kind)).toEqual(['defers']);
    view.rerender(<Row text="Couldn’t save. Try again." />);
    expect(lines.registeredLines().size).toBe(0);
  });
});

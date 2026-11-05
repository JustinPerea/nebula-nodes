/**
 * PR #204 round 8, GM r11: the general notice steps out only beside a line that carries the fix
 * itself. A "because" line (or the general words) names the fix, so the notice steps out; a lock
 * line, or a line ending "The notice below says why.", doesn't, so the notice stays. Review 6:
 * a line counts only while it is rendered (MEDIUM-1: the Commons keeps Settings in a hidden,
 * inert group), the dev setups' lines keep the notice (MEDIUM-2), the held proposal card's line
 * is a lock line (LOW-3), and the swap is announced once (NIT-3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { notConnectedKind, currentFixLine, registerLine, resetLinesForTests, lineRendered } = await import('../src/lib/notConnectedLine');
const { LineText } = await import('../src/components/LineText');
const session = await import('../src/lib/personSession');
const copy = await import('../src/lib/errorCopy');
const { heldProposalLine, heldQuestionsLine } = await import('../src/store/heldAssetProposals');

const banner = () => document.querySelector('.person-required');
const announced = () => document.querySelector('.person-required__announce')?.textContent ?? null;
const nextFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
const quiet = async () => { for (let i = 0; i < 3; i++) await nextFrame(); };

const handle: { show: (line: string | null) => void; hide: (hidden: boolean) => void } = { show: () => {}, hide: () => {} };
/** The app's shape: Settings and Chat in the shared group the Commons hides (App.tsx). */
function Screen({ live = false }: { live?: boolean }) {
  const [line, setLine] = useState<string | null>(null);
  const [commons, setCommons] = useState(false);
  useEffect(() => { handle.show = setLine; handle.hide = setCommons; }, []);
  return <>
    <PersonRequiredBanner />
    <div className={`workspace-overlays${commons ? ' workspace-overlays--hidden' : ''}`} inert={commons}>
      {line && (live ? <p role="status"><LineText text={line} /></p> : <p className="settings-row__error"><LineText text={line} /></p>)}
    </div>
  </>;
}

const because = copy.notConnectedBecause('load your agents', false);

beforeEach(() => { session.resetPersonSessionForTests(); resetLinesForTests(); });
afterEach(() => { cleanup(); session.notePersonPromoted(); vi.restoreAllMocks(); });

describe('GM r11: the three kinds of line', () => {
  it('a because line and the general words carry the fix', () => {
    expect(notConnectedKind(because)).toBe('fix');
    expect(notConnectedKind(copy.notConnectedBecause('save the style', true, 'packaged'))).toBe('fix');
    expect(notConnectedKind(`Couldn’t run the node. ${copy.PERSON_REQUIRED_COPY}`)).toBe('fix');
    expect(notConnectedKind(copy.PERSON_REQUIRED_APP_COPY)).toBe('fix');
    expect(notConnectedKind(copy.MARK_READ_REFUSED_COPY)).toBe('fix');
  });

  it('the dev setups\' lines defer to the notice', () => {
    expect(notConnectedKind(copy.PERSON_REQUIRED_DEV_COPY)).toBe('defers');
    expect(notConnectedKind(copy.MARK_READ_REFUSED_DEV_COPY)).toBe('defers');
    for (const reason of ['debug-port', 'dev-renderer']) {
      expect(notConnectedKind(copy.notConnectedBecause('save the style', true, reason))).toBe('defers');
      expect(notConnectedKind(copy.personRequiredCopy(true, reason))).toBe('defers');
    }
  });

  it('a lock line names no fix', () => {
    expect(notConnectedKind(heldQuestionsLine())).toBe('lock');
    expect(notConnectedKind(heldProposalLine())).toBe('lock');
    expect(notConnectedKind('You can accept proposals when this tab is connected as you.')).toBe('lock');
    expect(notConnectedKind('You can send notes when this window is connected as you.')).toBe('lock');
  });

  it('a line about something else is none of them', () => {
    expect(notConnectedKind('Couldn’t save. Try again.')).toBeNull();
    expect(notConnectedKind('Nebula couldn’t save the style because the server stopped.')).toBeNull();
  });
});

describe('GM r11: the notice beside each kind', () => {
  it('a because line: the notice steps out, and comes back when it goes', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(because));
    await waitFor(() => expect(banner()).toBeNull());
    act(() => handle.show(null));
    await waitFor(() => expect(banner()).not.toBeNull());
  });

  it('MEDIUM-2: a dev setup\'s line ("The notice below says why.") keeps the notice', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(copy.notConnectedBecause('load your agents', true, 'dev-renderer')));
    await nextFrame();
    await nextFrame();
    expect(document.body.textContent).toContain('The notice below says why.');
    expect(banner()).not.toBeNull();
  });

  it('LOW-3: the held proposal card\'s line is a lock line, so both show', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(heldProposalLine()));
    await nextFrame();
    await nextFrame();
    expect(banner()).not.toBeNull();
  });
});

describe('review 6 MEDIUM-1: only a rendered line counts', () => {
  it('the Commons: Settings\' because line in the hidden, inert group leaves the notice showing', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(because));
    await waitFor(() => expect(banner()).toBeNull());
    // Go to the Commons with Settings still open: the group is hidden and inert, the line stays mounted.
    act(() => handle.hide(true));
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(document.querySelector('.workspace-overlays--hidden')?.textContent).toBe(because);
    // Back from the Commons: the line is on screen again, and the notice steps out.
    act(() => handle.hide(false));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('a class or a style that hides the line, changed on its own, brings the notice back (and back out)', async () => {
    const sheet = document.createElement('style');
    sheet.textContent = '.gone { display: none; }';
    document.head.appendChild(sheet);
    try {
      render(<Screen />);
      act(() => session.reportPersonRequired());
      act(() => handle.show(because));
      await waitFor(() => expect(banner()).toBeNull());
      const group = document.querySelector<HTMLElement>('.workspace-overlays')!;
      // Only an attribute changes: no text, no node added or removed. Each change waits until the
      // scan the last swap scheduled has run, so only the attribute change can bring the next one.
      await quiet();
      act(() => { group.classList.add('gone'); });
      await waitFor(() => expect(banner()).not.toBeNull());
      await quiet();
      act(() => { group.classList.remove('gone'); });
      await waitFor(() => expect(banner()).toBeNull());
      await quiet();
      act(() => { group.style.display = 'none'; });
      await waitFor(() => expect(banner()).not.toBeNull());
      await quiet();
      act(() => { group.style.display = ''; });
      await waitFor(() => expect(banner()).toBeNull());
    } finally {
      sheet.remove();
    }
  });

  it('display: none from a style sheet, an inline style, visibility and opacity each hide a line', () => {
    const style = document.createElement('style');
    style.textContent = '.gone { display: none; }';
    document.head.appendChild(style);
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (const html of [`<div class="gone"><p>${because}</p></div>`, `<div style="display:none"><p>${because}</p></div>`,
      `<p style="visibility:hidden">${because}</p>`, `<div style="opacity:0"><p>${because}</p></div>`,
      `<div inert><p>${because}</p></div>`, `<div hidden><p>${because}</p></div>`,
      `<div aria-hidden="true"><p>${because}</p></div>`]) {
      root.innerHTML = html;
      const stop = registerLine(root.querySelector('p')!, because);
      expect(currentFixLine(), html).toBeNull();
      stop();
    }
    root.innerHTML = `<div><p>${because}</p></div>`;
    const stop = registerLine(root.querySelector('p')!, because);
    expect(currentFixLine()?.text).toBe(because);
    stop();
    root.remove();
    style.remove();
  });

  it('in a browser, the element\'s own checkVisibility decides', () => {
    const p = document.createElement('p');
    p.textContent = because;
    document.body.appendChild(p);
    const check = vi.fn(() => false);
    (p as unknown as { checkVisibility: () => boolean }).checkVisibility = check;
    expect(lineRendered(p)).toBe(false);
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ checkOpacity: true, checkVisibilityCSS: true }));
    check.mockReturnValue(true);
    expect(lineRendered(p)).toBe(true);
    p.remove();
  });

  it('a line that fades in counts once its animation ends', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    let visible = false;
    const original = HTMLElement.prototype as unknown as { checkVisibility?: unknown };
    const had = Object.prototype.hasOwnProperty.call(original, 'checkVisibility');
    original.checkVisibility = function (this: HTMLElement) { return visible; };
    try {
      act(() => handle.show(because));
      await nextFrame();
      await nextFrame();
      expect(banner()).not.toBeNull();
      visible = true;
      act(() => { document.querySelector('.settings-row__error')!.dispatchEvent(new Event('animationend', { bubbles: true })); });
      await waitFor(() => expect(banner()).toBeNull());
    } finally {
      if (!had) delete original.checkVisibility;
    }
  });
});

describe('review 6 NIT-3: the swap is announced once, politely', () => {
  it('the notice\'s words, then the line that took its place, then the words again', async () => {
    render(<Screen />);
    expect(announced()).toBe('');
    const region = document.querySelector('.person-required__announce')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    act(() => session.reportPersonRequired());
    expect(announced()).toBe(session.currentPersonBannerLine());
    // The visible notice isn't a second live region.
    expect(banner()!.closest('[aria-live]')).toBeNull();
    act(() => handle.show(because));
    await waitFor(() => expect(announced()).toBe(because));
    // The same region throughout: it was mounted empty, not with its text.
    expect(document.querySelector('.person-required__announce')).toBe(region);
    act(() => handle.show(null));
    await waitFor(() => expect(announced()).toBe(session.currentPersonBannerLine()));
  });

  it('each swap is one change of the region\'s words, with no empty step between (the region\'s own copy never counts)', async () => {
    render(<Screen />);
    const region = document.querySelector('.person-required__announce')!;
    const said: string[] = [];
    const observer = new MutationObserver(() => { if (said[said.length - 1] !== region.textContent) said.push(region.textContent ?? ''); });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    act(() => session.reportPersonRequired());
    const words = session.currentPersonBannerLine()!;
    await waitFor(() => expect(region.textContent).toBe(words));
    act(() => handle.show(because));
    await waitFor(() => expect(region.textContent).toBe(because));
    act(() => handle.show(null));
    await waitFor(() => expect(region.textContent).toBe(words));
    await nextFrame();
    await nextFrame();
    observer.disconnect();
    expect(said).toEqual([words, because, words]);
  });

  it('a line in its own live region announces itself, so the region says nothing for it', async () => {
    render(<Screen live />);
    act(() => session.reportPersonRequired());
    act(() => handle.show(because));
    await waitFor(() => expect(banner()).toBeNull());
    expect(announced()).toBe('');
  });
});

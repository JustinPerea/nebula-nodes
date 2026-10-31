/**
 * PR #204 round 7, GM r8 (1): one notice, not two. While a specific line on screen already says
 * this tab isn't connected as the person (a "because" line, a card's own line), the general
 * notice steps out, and comes back when that line goes. Beside the locked question form, whose
 * lock says it only in a tooltip, it stays. One derived state (the registered lines, round 9) drives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { currentFixLine, registerLine, resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { LineText } = await import('../src/components/LineText');
const session = await import('../src/lib/personSession');
const { notConnectedBecause, personRequiredCopy } = await import('../src/lib/errorCopy');
const { heldQuestionsLine } = await import('../src/store/heldAssetProposals');

const banner = () => document.querySelector('.person-required');
const handle: { showLine: (line: string | null) => void } = { showLine: () => {} };
const showLine = (line: string | null) => handle.showLine(line);
function Screen({ title }: { title?: string }) {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => { handle.showLine = setLine; }, []);
  return <>
    <PersonRequiredBanner />
    {line && <p className="settings-row__error"><LineText text={line} /></p>}
    {title && <button type="button" aria-disabled="true" title={title}>Send answers</button>}
  </>;
}

beforeEach(() => { session.resetPersonSessionForTests(); resetLinesForTests(); });
afterEach(() => { cleanup(); session.notePersonPromoted(); });

describe('GM r8 (1): one notice, not two', () => {
  it('a because line on screen: the general notice steps out; the line gone: it comes back', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    expect(banner()).not.toBeNull();
    act(() => showLine(notConnectedBecause('load your agents', false)));
    await waitFor(() => expect(banner()).toBeNull());
    // The notice's line stays set: what defers to it (the note dialog) still does.
    expect(session.currentPersonBannerLine()).not.toBeNull();
    act(() => showLine(null));
    await waitFor(() => expect(banner()).not.toBeNull());
  });

  it('a card\'s line in the general words counts too', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    act(() => showLine(`Couldn’t run the node. ${personRequiredCopy()}`));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('beside the locked question form (its lock says it in a tooltip only), the notice stays', async () => {
    expect(heldQuestionsLine()).toBe('You can answer this when this tab is connected as you.');
    render(<Screen title={heldQuestionsLine()} />);
    expect(document.querySelector(`[title="${heldQuestionsLine()}"]`)).not.toBeNull();
    act(() => session.reportPersonRequired());
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    expect(banner()).not.toBeNull();
  });

  it('a line about something else leaves it in place', async () => {
    render(<Screen />);
    act(() => session.reportPersonRequired());
    act(() => showLine('Couldn’t save. Try again.'));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
    expect(banner()).not.toBeNull();
  });

  it('the derived state reads registrations: the page\'s words, a hidden line and a tooltip don\'t count', () => {
    const root = document.createElement('div');
    root.innerHTML = `<div class="person-required"><span>${personRequiredCopy()}</span></div>
      <p hidden>${notConnectedBecause('save the style', false)}</p><button title="${personRequiredCopy()}">x</button>`;
    document.body.appendChild(root);
    const hidden = root.querySelector('p')!;
    const stopHidden = registerLine(hidden, hidden.textContent!);
    expect(currentFixLine()).toBeNull();
    const shown = document.createElement('p');
    shown.textContent = notConnectedBecause('save the style', false);
    root.appendChild(shown);
    // On the page but not registered: it doesn't count (review 7 NIT-2).
    expect(currentFixLine()).toBeNull();
    const stop = registerLine(shown, shown.textContent);
    expect(currentFixLine()?.text).toBe(shown.textContent);
    stop(); stopHidden();
    expect(currentFixLine()).toBeNull();
    root.remove();
  });
});

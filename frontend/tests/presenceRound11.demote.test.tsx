/**
 * PR #204 round 11, review 9:
 * - gates-trace MEDIUM-1: the held rule's 150 ms run from the demote itself (personSession), so a
 *   Commons opened on a tab demoted long ago sends nothing and shows the never-connected lines
 *   from its first frame (f93f2968 sent its reads with the stale token, then switched).
 * - lock-sweep-ui MEDIUM-3 (GM r19 item 2): a demote and the promote keep what the person typed
 *   in the Commons, and focus that a demote takes away moves to the section's line (tabIndex -1),
 *   back to the same control on the promote, and never away from a control that is still there.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  return {
    ...real,
    apiFetch: (path: string, init?: RequestInit) => {
      net.sent.push(`${String(init?.method ?? 'GET').toUpperCase()} ${path.split('?')[0]}`);
      return new Promise<Response>(() => {}); // never answers: the test reads what was sent
    },
  };
});
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
// The demoted tab still holds its old person token (a backend restart): f93f2968 sent with it.
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  personToken: async () => 'stale-token',
}));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const session = await import('../src/lib/personSession');
const { holdCommonsCalls } = await import('../src/lib/commonsHold');

const commonsSent = () => net.sent.filter((request) => request.includes('/api/commons'));
const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  session.resetPersonSessionForTests();
  holdCommonsCalls(false); // a view's render flag from an earlier test must not hold this one's calls
  net.sent = [];
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  vi.useRealTimers();
});

const demote = () => act(() => { session.notePersonPromoted(); session.reportPersonRequired(); });

describe('a Commons opened on a tab demoted long ago (review 9 gates-trace MEDIUM-1)', () => {
  it('sends nothing and shows the never-connected line from the first frame', async () => {
    demote();
    await settle(1000);
    expect(session.personDemotedSettled()).toBe(true);
    render(<CommonsView />);
    // The first frame: no live status, nothing sent.
    expect(screen.queryByText('Connecting…')).toBeNull();
    expect(commonsSent()).toEqual([]);
    await flush();
    expect(commonsSent()).toEqual([]);
    expect(document.querySelector('[data-commons-line="not-connected"]')?.textContent)
      .toMatch(/^Nebula couldn’t .* because this tab isn’t connected as you\./);
    // GM r18 c: every because line sits in the shared box.
    const lines = [...document.querySelectorAll('[data-line-because]')];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !line.closest('[data-line-box]')).map((line) => line.textContent)).toEqual([]);
  });

  it('a Commons call sent before any view renders is held too (commonsApi reads the session)', async () => {
    const { commonsApi } = await import('../src/lib/commonsApi');
    demote();
    await settle(1000);
    await expect(commonsApi.collections()).rejects.toMatchObject({
      message: expect.stringMatching(/because this tab isn’t connected as you\./),
    });
    expect(commonsSent()).toEqual([]);
  });

  it('inside the first 150 ms of a demote nothing switches yet (a quick reconnect)', async () => {
    demote();
    await settle(100);
    expect(session.personDemotedSettled()).toBe(false);
    await settle(60);
    expect(session.personDemotedSettled()).toBe(true);
  });
});

describe('drafts and focus across a demote and the promote (GM r19 item 2)', () => {
  it('keeps the search and the URL draft; focus goes to the line, then back to the field', async () => {
    render(<CommonsView />);
    await flush();
    const search = document.querySelector<HTMLInputElement>('input[name="commons-search"]')!;
    fireEvent.change(search, { target: { value: 'warm serif' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const url = screen.getByRole('textbox', { name: 'Image or page URL' });
    fireEvent.change(url, { target: { value: 'https://example.invalid/half' } });
    act(() => url.focus());
    expect(document.activeElement).toBe(url);

    demote();
    await settle(200);
    await flush();
    await settle(50);
    // The URL field went away (Add is locked): focus is on a line that can take it, never body.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.hasAttribute('data-focus-line')).toBe(true);
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
    expect(document.querySelector<HTMLInputElement>('input[name="commons-search"]')!.value).toBe('warm serif');

    act(() => session.notePersonPromoted());
    await flush();
    await settle(50);
    const back = screen.getByRole('textbox', { name: 'Image or page URL' });
    expect(back).toHaveValue('https://example.invalid/half');
    expect(document.activeElement).toBe(back);
    expect(document.querySelector<HTMLInputElement>('input[name="commons-search"]')!.value).toBe('warm serif');
  });

  it('a demote never pulls focus from a control that is still there', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    try {
      render(<CommonsView />);
      await flush();
      const search = document.querySelector<HTMLInputElement>('input[name="commons-search"]')!;
      act(() => search.focus());
      act(() => outside.focus()); // the person moved on
      demote();
      await settle(200);
      await flush();
      await settle(50);
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});

describe('"New collection…" locks with Add (GM r19 follow-up)', () => {
  it('disabled and inert on a held tab; the rest of the select stays live; works after the promote', async () => {
    act(() => session.reportPersonRequired());
    render(<CommonsView />);
    await settle(200);
    const select = screen.getByRole('combobox', { name: 'Add to' });
    const option = [...select.querySelectorAll('option')].find((o) => o.textContent === 'New collection…')!;
    expect(option.disabled).toBe(true);
    expect(select).not.toHaveAttribute('aria-disabled');
    fireEvent.change(select, { target: { value: '__new__' } });
    await flush();
    expect(screen.queryByRole('textbox', { name: /New collection name/ })).toBeNull();
    expect(commonsSent().filter((r) => r.startsWith('POST'))).toEqual([]);
    act(() => session.notePersonPromoted());
    await flush();
    expect(option.disabled).toBe(false);
    fireEvent.change(select, { target: { value: '__new__' } });
    await flush();
    expect(screen.getByRole('textbox', { name: /New collection name/ })).toBeTruthy();
  });
});

describe('Add on a held tab (GM r18)', () => {
  it('Add is locked with its line under it, no empty-state line, and a drop is taken and sends nothing', async () => {
    act(() => session.reportPersonRequired());
    render(<CommonsView />);
    await settle(200);
    await flush();
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    const line = document.getElementById(add.getAttribute('aria-describedby')!.split(' ').pop()!)!;
    expect(line.textContent).toBe('You can add references when this tab is connected as you.');
    expect(line.previousElementSibling).toBe(add);
    fireEvent.click(add);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.body.textContent).not.toMatch(/No matches\. Drop images or videos here/);
    const wrap = document.querySelector('.commons-grid-wrap')!;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    const over = fireEvent.dragOver(wrap, { dataTransfer: { types: ['Files'], files: [file], dropEffect: 'copy' } });
    expect(over).toBe(false); // taken: the browser doesn't open the file
    expect(wrap.className).not.toMatch(/dragging/);
    const dropped = fireEvent.drop(wrap, { dataTransfer: { types: ['Files'], files: [file] } });
    expect(dropped).toBe(false);
    await flush();
    expect(commonsSent().filter((r) => r.startsWith('POST'))).toEqual([]);
  });
});

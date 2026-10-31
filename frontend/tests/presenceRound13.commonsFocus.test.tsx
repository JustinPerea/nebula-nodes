/**
 * PR #204 round 13, review 10 lock-look-ui:
 * - MEDIUM-2 (GM r19 item 2: "A demote must never pull focus from a control that is still
 *   there"): CommonsView keyed its whole body on the demote, so every filter remounted and focus
 *   on an unlabelled one (the Media select, a range, a checkbox) jumped to Add's line, and an IME
 *   composition in the search was cut. Now only the data panes start again: each control is the
 *   same element across the demote and the promote, still focused, and a composition goes on.
 * - NIT-2: a held and a demoted Commons showed different because lines (the last refusal won).
 *   One line by state: the status's.
 * - The promote reads each load once: the loads' own retry on the promote and the new view land
 *   in one render (the old remount's retry ran on the unmounted body and did nothing).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
// A person token is at hand (the promoted tab's), so a live Commons sends its reads.
vi.mock('../src/lib/personSession', async (original) => ({
  ...await original<typeof import('../src/lib/personSession')>(),
  personToken: async () => 'person-token',
}));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const session = await import('../src/lib/personSession');
const { holdCommonsCalls } = await import('../src/lib/commonsHold');

const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
const flush = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };
const demote = async () => {
  act(() => { session.notePersonPromoted(); session.reportPersonRequired(); });
  await settle(200);
  await flush();
  await settle(50);
};
const promote = async () => {
  act(() => session.notePersonPromoted());
  await flush();
  await settle(50);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  session.resetPersonSessionForTests();
  holdCommonsCalls(false);
  net.sent = [];
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  vi.useRealTimers();
});

const filters = () => within(screen.getByRole('complementary', { name: 'Commons filters' }));

/** Each kind of control in the Commons' header and filter column, found the way a person names it. */
const CONTROLS: Array<[string, () => HTMLElement]> = [
  ['the search field', () => document.querySelector<HTMLInputElement>('input[name="commons-search"]')!],
  ['the palette hex field', () => filters().getByRole('textbox', { name: 'Palette hex' })],
  ['the keyword field', () => filters().getByRole('textbox', { name: 'Add keyword' })],
  ['the Collection select', () => filters().getByRole('combobox', { name: 'Collection' })],
  ['the Media select', () => filters().getByRole('combobox', { name: 'Media' })],
  ['the Role select', () => filters().getByRole('combobox', { name: 'Role' })],
  ['the Made by select', () => filters().getByRole('combobox', { name: 'Made by' })],
  ['an axis lower bound', () => filters().getAllByRole('slider')[0]],
  ['an axis upper bound', () => filters().getAllByRole('slider')[1]],
  ['the ΔE range', () => filters().getAllByRole('slider').at(-1)!],
  ['Corrected only', () => filters().getByRole('checkbox', { name: 'Corrected only' })],
  ['Has comments', () => filters().getByRole('checkbox', { name: 'Has comments' })],
  ['the Add to select', () => screen.getByRole('combobox', { name: 'Add to' })],
  ['a section tab', () => screen.getByRole('tab', { name: 'Inbox' })],
  ['Add itself (it locks in place)', () => screen.getByRole('button', { name: 'Add' })],
];

describe('a demote keeps focus on a Commons control that is still there (review 10 MEDIUM-2)', () => {
  for (const [name, find] of CONTROLS) {
    it(`${name}: the same element, still focused, through the demote and the promote`, async () => {
      render(<CommonsView />);
      await flush();
      const control = find();
      act(() => control.focus());
      expect(document.activeElement).toBe(control);

      await demote();
      expect(control.isConnected).toBe(true);
      expect(find()).toBe(control);
      expect(document.activeElement).toBe(control);

      await promote();
      expect(find()).toBe(control);
      expect(document.activeElement).toBe(control);
    });
  }

  it('the URL field goes away with Add\'s menu: focus to Add\'s line, back on the promote; the filters stay the same elements', async () => {
    render(<CommonsView />);
    await flush();
    const media = filters().getByRole('combobox', { name: 'Media' });
    fireEvent.change(media, { target: { value: 'image' } });
    const search = document.querySelector<HTMLInputElement>('input[name="commons-search"]')!;
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const url = screen.getByRole('textbox', { name: 'Image or page URL' });
    fireEvent.change(url, { target: { value: 'https://example.invalid/half' } });
    act(() => url.focus());

    await demote();
    expect(url.isConnected).toBe(false);
    expect(document.activeElement?.hasAttribute('data-focus-line')).toBe(true);
    expect(document.activeElement?.textContent).toBe('You can add references when this tab is connected as you.');
    expect(filters().getByRole('combobox', { name: 'Media' })).toBe(media);
    expect(media).toHaveValue('image');
    expect(document.querySelector('input[name="commons-search"]')).toBe(search);

    await promote();
    const back = screen.getByRole('textbox', { name: 'Image or page URL' });
    expect(back).toHaveValue('https://example.invalid/half');
    expect(document.activeElement).toBe(back);
    expect(filters().getByRole('combobox', { name: 'Media' })).toBe(media);
  });

  it('an IME composition in the search goes on across a demote (compositionstart and update, no end yet)', async () => {
    render(<CommonsView />);
    await flush();
    const search = document.querySelector<HTMLInputElement>('input[name="commons-search"]')!;
    act(() => search.focus());
    fireEvent.compositionStart(search, { data: '' });
    fireEvent.change(search, { target: { value: 'かn' } });
    fireEvent.compositionUpdate(search, { data: 'かn' });

    await demote();
    // The same field, focused, the composing text untouched: nothing committed it.
    expect(document.querySelector('input[name="commons-search"]')).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe('かn');

    // The IME finishes: its text replaces the fragment, never appended to a committed copy.
    fireEvent.compositionUpdate(search, { data: 'かな' });
    fireEvent.change(search, { target: { value: 'かな' } });
    fireEvent.compositionEnd(search, { data: 'かな' });
    expect(search.value).toBe('かな');
    await promote();
    expect(document.querySelector('input[name="commons-search"]')).toBe(search);
    expect(search.value).toBe('かな');
  });
});

describe('the data still starts again on a demote and the promote', () => {
  it('a demote empties the panes and shows the not-connected state; the promote reads each load once', async () => {
    act(() => session.notePersonPromoted());
    render(<CommonsView />);
    await settle(300);
    await flush();
    const firstReads = net.sent.filter((request) => request.includes('/api/commons')).length;
    expect(firstReads).toBeGreaterThan(0);

    await demote();
    expect(document.querySelector('[data-commons-line="not-connected"]')).not.toBeNull();

    net.sent = [];
    await promote();
    await settle(300);
    await flush();
    const reads = net.sent.filter((request) => request.includes('/api/commons'));
    // Collections, the status and the search: once each, not again through a load's own retry.
    expect(reads.filter((r) => r === 'GET /api/commons/collections')).toHaveLength(1);
    expect(reads.filter((r) => r === 'GET /api/commons/status')).toHaveLength(1);
    expect(reads.filter((r) => r === 'POST /api/commons/search')).toHaveLength(1);
  });
});

describe('one because line by state, not by the last refusal (review 10 NIT-2)', () => {
  const STATUS_LINE = 'Nebula couldn’t check the Commons status because this tab isn’t connected as you. Open the link Nebula printed when it started.';
  const lineText = () => document.querySelector('[data-commons-line="not-connected"]')?.textContent;

  it('a tab that never connected: the status line, after the search refuses too, and after a new search', async () => {
    act(() => session.reportPersonRequired());
    render(<CommonsView />);
    await settle(400);
    await flush();
    expect(lineText()).toBe(STATUS_LINE);
    // A new search refuses later still: the line stays the status's.
    fireEvent.change(document.querySelector('input[name="commons-search"]')!, { target: { value: 'warm' } });
    await settle(400);
    await flush();
    expect(lineText()).toBe(STATUS_LINE);
    // The status poll refuses again: the same line.
    await settle(5100);
    await flush();
    expect(lineText()).toBe(STATUS_LINE);
  });

  it('a demoted tab shows the same line as one that never connected', async () => {
    render(<CommonsView />);
    await flush();
    await demote();
    await settle(400);
    await flush();
    expect(lineText()).toBe(STATUS_LINE);
    fireEvent.change(document.querySelector('input[name="commons-search"]')!, { target: { value: 'warm' } });
    await settle(400);
    await flush();
    expect(lineText()).toBe(STATUS_LINE);
  });
});

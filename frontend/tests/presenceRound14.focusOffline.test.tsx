/**
 * PR #204 round 14 (GM r23 3 with review 11 MEDIUM-1's handover): going offline hides Add's line,
 * so focus on it moves on as a demote does (to the heading, never the page), and keeps the
 * control it stands in for: back online it returns to the line, and on the promote to the field.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ADD_NAME } from './helpers/commonsAddNames';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  return {
    ...real,
    apiFetch: (path: string, init?: RequestInit) => {
      net.sent.push(`${String(init?.method ?? 'GET').toUpperCase()} ${path.split('?')[0]}`);
      // Round 18c (GM r30 2): the collections answer (none), so Add and Add to are live once
      // connected; with them pending both are disabled ("Not loaded").
      if (path.split('?')[0] === '/api/commons/collections' && String(init?.method ?? 'GET').toUpperCase() === 'GET') {
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
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
const connection = await import('../src/lib/backendConnection');

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
  act(() => connection.noteBackendConnection('online'));
  act(() => session.notePersonPromoted());
  vi.useRealTimers();
});


const offline = async (down: boolean) => {
  act(() => connection.noteBackendConnection(down ? 'offline' : 'online'));
  await flush();
  await settle(1600);
  await flush();
};

describe('offline hides the focused line; focus moves on and comes back', () => {
  it('the URL field: Add\'s line, the heading while offline, the line again, then the field on the promote', async () => {
    render(<CommonsView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ADD_NAME }));
    const url = screen.getByRole('textbox', { name: 'Image or page URL' });
    fireEvent.change(url, { target: { value: 'https://example.invalid/half' } });
    act(() => url.focus());

    await demote();
    await settle(1600);
    await flush();
    expect(document.activeElement?.textContent).toBe('You can add references when this tab is connected as you.');

    await offline(true);
    expect(document.querySelector('.person-lock-line')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.hasAttribute('data-workspace-heading')).toBe(true);

    await offline(false);
    expect(document.activeElement?.textContent).toBe('You can add references when this tab is connected as you.');

    await promote();
    const back = screen.getByRole('textbox', { name: 'Image or page URL' });
    expect(back).toHaveValue('https://example.invalid/half');
    expect(document.activeElement).toBe(back);
  });

  it('focus the person moved elsewhere meanwhile stays where they put it', async () => {
    render(<CommonsView />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ADD_NAME }));
    act(() => screen.getByRole('textbox', { name: 'Image or page URL' }).focus());
    await demote();
    await settle(1600);
    await flush();
    const search = document.querySelector<HTMLInputElement>('input[name="commons-search"]')!;
    act(() => search.focus());
    await offline(true);
    await offline(false);
    await promote();
    expect(document.activeElement).toBe(search);
  });
});

/**
 * PR #204 round 18l (GM r43 Q5): a close answered 404 "Commons is disabled" never shows its own line
 * in the app: the Commons API notes the Commons off (lib/commonsOff), the Commons view switches to
 * its off view, the dialog unmounts with the pane, and focus goes to the Commons heading by the one
 * handover rule. The "Commons off" row in tests/commonsCopy.ratchet is tested-only for that reason.
 * On the real Commons screens with the real Commons API (only apiFetch is stubbed).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withFocusFixup } from './helpers/focusFixup';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (o) => ({ ...await o<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (o) => ({ ...await o<typeof import('../src/lib/personSession')>(), personToken: async () => 'a'.repeat(43) }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { notePersonPromoted, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { commonsOffNow } = await import('../src/lib/commonsOff');
const { CLOSE_COMMONS_OFF } = await import('../src/lib/errorCopy');
vi.setConfig({ testTimeout: 30_000 });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const status = { worker: { running: false, state: 'idle' }, queue: {}, meter: { calls: 0, cap: 100, remaining: 100, resets_at: '2026-11-02T00:00:00Z' } };
const batch = { mode: 'assisted_review', state: 'open', batch_revision: 3, attempts: 0, call_budget: 3, items: [], closed_at: null, close_hash: null };
const off = { on: false };
async function answer(path: string, init?: RequestInit): Promise<Response> {
  if (off.on) return json({ detail: 'Commons is disabled' }, 404);
  if (path.endsWith('/evaluation/close') && init?.method === 'POST') { off.on = true; return json({ detail: 'Commons is disabled' }, 404); }
  if (path.endsWith('/status')) return json(status);
  if (path.endsWith('/collections')) return json([{ id: 'c1', name: 'Refs', kind: 'manual' }]);
  if (path.endsWith('/search')) return json({ results: [] });
  if (path.endsWith('/review')) return json(batch);
  if (path.endsWith('/candidates')) return json([]);
  return json({});
}

withFocusFixup();
beforeEach(() => {
  vi.useFakeTimers();
  document.body.className = 'app-slava-restraint';
  resetPersonSessionForTests(); resetCommonsSessionForTests(); resetLinesForTests(); resetBackendConnectionForTests();
  window.sessionStorage.clear();
  off.on = false;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation((p: string, i?: RequestInit) => answer(String(p), i));
});
afterEach(() => { cleanup(); act(() => notePersonPromoted()); act(() => resetBackendConnectionForTests()); resetCommonsSessionForTests(); vi.useRealTimers(); document.body.className = ''; });

it('a close answered 404 "Commons is disabled": the off view, the dialog gone, focus on the heading', async () => {
  render(<CommonsView />);
  await tick(1000);
  fireEvent.click(screen.getByRole('tab', { name: 'Agent review' }));
  await tick(1000);
  fireEvent.click(screen.getByRole('button', { name: 'Close review & resume library analysis…' }));
  const close = screen.getByRole('button', { name: 'Close as assisted review' });
  act(() => close.focus());
  fireEvent.click(close);
  await tick(1000);
  expect(commonsOffNow()).toBe(true);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.querySelector('.commons-review')).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(document.body.textContent).toContain('Commons is turned off for this Nebula.');
  // The close's own row never shows in the app: the off view says it.
  expect(document.body.textContent).not.toContain(CLOSE_COMMONS_OFF);
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Commons', level: 1 }));
});

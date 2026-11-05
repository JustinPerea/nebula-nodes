/**
 * PR #204 round 18l (review 17 MEDIUM-2, GM r43 Q7), in Agent review itself with the real Commons
 * API (only apiFetch is stubbed): a grade the pane sees running locks the open dialog's close with
 * the grade line (an aria lock, focusable, never native), and the grade line from a refused close
 * goes on the pane's own 5 s poll once it reads no grade running; the dialog asks nothing itself.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withFocusFixup } from './helpers/focusFixup';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (o) => ({ ...await o<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (o) => ({ ...await o<typeof import('../src/lib/personSession')>(), personToken: async () => 'a'.repeat(43) }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsReview } = await import('../src/components/commons/CommonsReview');
const { notePersonPromoted, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { CLOSE_GRADE_RUNNING } = await import('../src/lib/errorCopy');
vi.setConfig({ testTimeout: 30_000 });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const item = (status: string) => ({ position: 0, width: 10, height: 10, image_sha256: 'x', status, revision: 1, proposal: null,
  reviewed_labels: null, reviewer: null, reviewed_at: null, error: null });
const pane = { status: 'ready', closeAnswer: null as [number, unknown] | null, reviewReads: 0 };
const batch = () => ({ mode: 'assisted_review', independent_ground_truth: false, state: 'open', batch_revision: 3, closed_at: null,
  close_hash: null, manifest_hash: 'm', items: [item(pane.status)], model: 'x', fields: {}, axes: [], roles: [], keywords: [], call_budget: 3, attempts: 1 });
async function answer(path: string, init?: RequestInit): Promise<Response> {
  if (path.endsWith('/evaluation/close') && init?.method === 'POST') return json(pane.closeAnswer![1], pane.closeAnswer![0]);
  if (path.endsWith('/review')) { pane.reviewReads += 1; return json(batch()); }
  if (path.includes('/image')) return new Response('png', { headers: { 'content-type': 'image/png' } });
  return json({});
}

const fixup = withFocusFixup();
beforeEach(() => {
  vi.useFakeTimers();
  document.body.className = 'app-slava-restraint';
  resetPersonSessionForTests(); resetCommonsSessionForTests(); resetLinesForTests(); resetBackendConnectionForTests();
  pane.status = 'ready'; pane.closeAnswer = null; pane.reviewReads = 0;
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
  transport.fetch.mockReset();
  transport.fetch.mockImplementation((p: string, i?: RequestInit) => answer(String(p), i));
});
afterEach(() => { cleanup(); act(() => notePersonPromoted()); act(() => resetBackendConnectionForTests()); resetCommonsSessionForTests(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.className = ''; });

async function openDialog() {
  render(<CommonsReview active onWork={() => {}} />);
  await tick(1000);
  fireEvent.click(screen.getByRole('button', { name: 'Close review & resume library analysis…' }));
  const close = screen.getByRole('button', { name: 'Close as assisted review' });
  act(() => close.focus());
  return close;
}

it('a grade the poll sees running: the grade line, the close locked in place with focus kept; live again once it ends', async () => {
  const close = await openDialog();
  pane.status = 'running';
  await tick(5000);
  const box = screen.getByText(CLOSE_GRADE_RUNNING);
  expect(close.getAttribute('aria-disabled')).toBe('true');
  expect(close.hasAttribute('disabled')).toBe(false);
  expect(close.getAttribute('aria-describedby')).toBe(box.closest('[data-commons-line]')!.id);
  act(() => fixup.current().flush());
  expect(document.activeElement).toBe(close);
  pane.status = 'ready';
  await tick(5000);
  expect(screen.queryByText(CLOSE_GRADE_RUNNING)).toBeNull();
  expect(close.getAttribute('aria-disabled')).toBeNull();
  expect(document.activeElement).toBe(close);
});

it('a close refused for a running grade: the line goes on the pane\'s next read with no grade running', async () => {
  const close = await openDialog();
  pane.closeAnswer = [409, { detail: 'A grading attempt is still running. Close after it finishes.' }];
  fireEvent.click(close);
  await tick(50);
  expect(screen.getByText(CLOSE_GRADE_RUNNING)).toBeTruthy();
  const reads = pane.reviewReads;
  await tick(5000);
  expect(pane.reviewReads).toBe(reads + 1);
  expect(screen.queryByText(CLOSE_GRADE_RUNNING)).toBeNull();
  expect(close.getAttribute('aria-disabled')).toBeNull();
});

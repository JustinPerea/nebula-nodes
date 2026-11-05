/**
 * PR #204 round 18i (GM r39 Fix B, GM r32): while a pane's latest read has failed, it shows only
 * its failure line, until a read succeeds. No "Prepare the reference set in Blind labeling first."
 * and no "0 / 15 reviewed · 0 grades ready" under "Nebula couldn’t load Agent review…": those
 * would be stale. Agent review's 5 s poll can fail after a read answered, with a batch or without.
 * (Blind labeling never reads by itself once answered; Settings keeps its saved values on a failed
 * re-read, GM r32 3; a reference's detail has nothing to show until it reads.) These run the real
 * Commons API; only fetch is stubbed.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const REVIEW = 'Nebula couldn’t load Agent review because the server didn’t respond. Try again.';
const PREPARE = 'Prepare the reference set in Blind labeling first.';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const state: { answers: Array<'down' | 'none' | 'batch'>; last: 'down' | 'none' | 'batch' } = { answers: [], last: 'none' };

const batch = { mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'fixture', state: 'open', batch_revision: 7,
  closed_at: null, close_hash: null, model: 'fixture-model', fields: { type_style: ['none', 'serif'] }, axes: ['quiet_loud'],
  roles: ['accent'], keywords: ['geometric_type'], call_budget: 0, attempts: 1,
  items: [{ position: 0, image_sha256: 'fixture', width: 40, height: 32, status: 'pending', revision: 1, palette: [],
    reviewed_labels: null, reviewer: null, reviewed_at: null, error: null, proposal: null }] };

async function backend(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  if (path !== '/api/commons/review' && path !== '/api/commons/evaluation') return json({});
  const answer = state.answers.shift() ?? state.last;
  state.last = answer;
  if (answer === 'down') return new Response('Service Unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
  return json(answer === 'batch' ? batch : null);
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsReview } = await import('../src/components/commons/CommonsReview');

async function until(check: () => unknown, max = 3000): Promise<void> {
  for (let waited = 0; ; waited += 50) {
    try { check(); return; } catch (error) { if (waited >= max) throw error; }
    await act(() => vi.advanceTimersByTimeAsync(50));
  }
}
const pane = () => document.querySelector('section.commons-evaluation')!;
const text = () => pane().textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  state.answers = []; state.last = 'none';
  vi.stubGlobal('fetch', vi.fn(backend));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('Agent review with no batch: a failed poll shows only the line, until a read succeeds', async () => {
  render(<CommonsReview />);
  await until(() => expect(text()).toContain(PREPARE));
  expect(text()).toContain('0 / 15 reviewed');
  state.last = 'down';
  await until(() => expect(text()).toContain(REVIEW), 6000);
  expect(text()).not.toContain(PREPARE);
  expect(text()).not.toContain('reviewed');
  expect(text()).not.toContain('grades ready');
  // The next poll answers: the pane comes back, with no line.
  state.last = 'none';
  await until(() => expect(text()).toContain(PREPARE), 6000);
  expect(text()).not.toContain(REVIEW);
});

it('Agent review with a batch: a failed poll hides the stale count and references too', async () => {
  state.last = 'batch';
  render(<CommonsReview />);
  await until(() => expect(text()).toContain('0 / 1 reviewed'));
  state.last = 'down';
  await until(() => expect(text()).toContain(REVIEW), 6000);
  expect(text()).not.toContain('reviewed');
  expect(screen.queryByRole('navigation', { name: 'References to review' })).toBeNull();
  // Its Try again reads it again.
  state.last = 'batch';
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await until(() => expect(text()).toContain('0 / 1 reviewed'));
  expect(text()).not.toContain(REVIEW);
});

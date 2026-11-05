/**
 * PR #204 round 18h: the Commons panes' load lines.
 * - GM r38 3c: a pane's load line reads again quietly on reconnect, as the page row does: back
 *   online, no stale "didn’t respond" shows while the load reads again (Settings, the detail,
 *   Blind labeling).
 * - Review 16 NIT-2 (N15, N16, N17): a Try again that succeeds clears the line, in Blind labeling,
 *   Agent review's image and Blind labeling's image (Settings' was pinned in 18f).
 * These run the real Commons API and apiFetch; only the browser's fetch is stubbed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const state: { failing: Set<string>; review: unknown; evaluation: unknown } = { failing: new Set(), review: null, evaluation: null };
const reads: string[] = [];

const evaluationBatch = () => ({ revision: 3, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: 'fixture', sealed: null, seal_hash: null,
  closed: null, close_hash: null, fields: { type_style: ['none'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'],
  excluded_count: 0, assisted_reviews: 0,
  items: [{ position: 0, image_sha256: 'fixture-image', width: 40, height: 32, accent_locked: false, labels: null, accents: [], no_accents: false,
    palette: [{ index: 0, hex: '#ff0000', share: 1 }] }] });
const reviewBatch = () => ({ mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'fixture',
  state: 'open', batch_revision: 7, closed_at: null, close_hash: null, model: 'fixture-model', fields: { type_style: ['none'] }, axes: ['quiet_loud'],
  roles: ['accent'], keywords: ['geometric_type'], call_budget: 0, attempts: 1,
  items: [{ position: 0, image_sha256: 'fixture', width: 40, height: 32, status: 'ready', revision: 1,
    palette: [{ index: 0, hex: '#ff0000', share: 1 }], reviewed_labels: null, reviewer: null, reviewed_at: null, error: null, proposal: null }] });

async function backend(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  reads.push(path);
  if (state.failing.has(path)) return new Response('Service Unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
  if (/^\/api\/commons\/evaluation\/items\/\d+\/image$/.test(path)) return new Response('fixture', { headers: { 'content-type': 'image/png' } });
  if (path === '/api/commons/evaluation') return json(state.evaluation);
  if (path === '/api/commons/review') return json(state.review);
  if (path === '/api/commons/status') return json({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  if (['/api/commons/collections', '/api/commons/folders', '/api/commons/vocabulary/candidates'].includes(path)) return json([]);
  if (path === '/api/commons/settings') return json({ daily_cap: 100 });
  if (path === '/api/commons/assets/a1') return json({
    asset: { id: 'a1', media: 'image', width: 40, height: 32, made_by: 'human', analysis_state: 'ready', last_error: null, measurements: null },
    effective: { fields: {}, sources: {}, corrected_paths: [], analysis: null },
    corrections: [], regions: [], borrowings: [], blob_url: '/api/commons/blobs/fixture.png', memberships: [] });
  return json({});
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsReview } = await import('../src/components/commons/CommonsReview');
const { CommonsEvaluation } = await import('../src/components/commons/CommonsEvaluation');
const { CommonsSettings } = await import('../src/components/commons/CommonsSettings');
const { CommonsDetail } = await import('../src/components/commons/CommonsDetail');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');

const line = () => document.querySelector('[data-commons-line]');
const NO_ANSWER = /because the server didn’t respond\. Try again\.$/;

beforeEach(() => {
  state.failing = new Set(); state.review = null; state.evaluation = null; reads.length = 0;
  document.body.className = 'app-slava-restraint';
  vi.stubGlobal('fetch', vi.fn(backend));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup(); act(() => resetBackendConnectionForTests()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.className = ''; });

async function tryAgainClears(failing: string) {
  await waitFor(() => expect(line()?.textContent).toMatch(NO_ANSWER), { timeout: 10_000 });
  state.failing.delete(failing);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(line()).toBeNull(), { timeout: 10_000 });
}

describe('a Try again that succeeds clears the line', () => {
  it('Blind labeling (N15)', async () => {
    state.failing.add('/api/commons/evaluation');
    render(<CommonsEvaluation />);
    await tryAgainClears('/api/commons/evaluation');
  });

  it('Agent review’s image (N16)', async () => {
    state.review = reviewBatch();
    state.failing.add('/api/commons/evaluation/items/0/image');
    render(<CommonsReview />);
    await tryAgainClears('/api/commons/evaluation/items/0/image');
    expect(document.querySelector('img.review-reference')).not.toBeNull();
  });

  it('Blind labeling’s image (N17)', async () => {
    state.evaluation = evaluationBatch();
    state.failing.add('/api/commons/evaluation/items/0/image');
    render(<CommonsEvaluation />);
    await tryAgainClears('/api/commons/evaluation/items/0/image');
  });
});

describe('GM r38 3c: a pane load line reads again quietly on reconnect', () => {
  async function quietOnReconnect(failing: string) {
    await waitFor(() => expect(line()?.textContent).toMatch(NO_ANSWER), { timeout: 10_000 });
    act(() => noteBackendConnection('offline'));
    expect(line()).toBeNull();
    state.failing.delete(failing);
    const before = reads.filter((path) => path === failing).length;
    act(() => noteBackendConnection('online'));
    // The first render back online has no stale line.
    expect(line()).toBeNull();
    await waitFor(() => expect(reads.filter((path) => path === failing).length).toBeGreaterThan(before), { timeout: 10_000 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(line()).toBeNull();
  }

  it('Settings, not loaded', async () => {
    state.failing.add('/api/commons/folders');
    render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
    await quietOnReconnect('/api/commons/folders');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Folder path' })).toBeTruthy());
  });

  it('Blind labeling', async () => {
    state.failing.add('/api/commons/evaluation');
    render(<CommonsEvaluation />);
    await quietOnReconnect('/api/commons/evaluation');
  });

  it('the reference detail', async () => {
    state.failing.add('/api/commons/assets/a1');
    render(<CommonsDetail assetId="a1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    await quietOnReconnect('/api/commons/assets/a1');
  });

  it('Agent review', async () => {
    state.failing.add('/api/commons/review');
    render(<CommonsReview />);
    await quietOnReconnect('/api/commons/review');
  });

  it('it comes back only if the load fails again', async () => {
    state.failing.add('/api/commons/evaluation');
    render(<CommonsEvaluation />);
    await waitFor(() => expect(line()?.textContent).toMatch(NO_ANSWER), { timeout: 10_000 });
    act(() => noteBackendConnection('offline'));
    act(() => noteBackendConnection('online'));
    expect(line()).toBeNull();
    await waitFor(() => expect(line()?.textContent).toMatch(NO_ANSWER), { timeout: 10_000 });
  });
});

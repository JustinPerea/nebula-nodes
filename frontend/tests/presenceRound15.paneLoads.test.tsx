/**
 * PR #204 round 15 (GM r25, pane loads): a Commons pane's load that Nebula answered with no reason
 * (a 5xx, 408 or 429) says it in the because form, under the pane's own words, verbatim:
 *   Agent review:         "Nebula couldn’t load Agent review because it didn’t respond. Try again."
 *   reference detail:     "Nebula couldn’t load this reference because it didn’t respond. Try again."
 *   Blind labeling:       "Nebula couldn’t load Blind labeling because it didn’t respond. Try again."
 *   Commons Settings:     "Nebula couldn’t load the Commons settings because it didn’t respond. Try again."
 * The pane names its load whichever of its requests failed (Settings reads three). These run the
 * real Commons API and apiFetch; only the browser's fetch is stubbed.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const REVIEW = 'Nebula couldn’t load Agent review because it didn’t respond. Try again.';
const REFERENCE = 'Nebula couldn’t load this reference because it didn’t respond. Try again.';
const LABELING = 'Nebula couldn’t load Blind labeling because it didn’t respond. Try again.';
const SETTINGS = 'Nebula couldn’t load the Commons settings because it didn’t respond. Try again.';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The path that fails, and how. */
const state: { failing: string; status: number } = { failing: '', status: 503 };

async function backend(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
  if (path === state.failing) return new Response('Service Unavailable', { status: state.status, headers: { 'content-type': 'text/plain' } });
  if (path === '/api/commons/evaluation' || path === '/api/commons/review') return json(null);
  if (path === '/api/commons/status') return json({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  if (['/api/commons/collections', '/api/commons/folders', '/api/commons/vocabulary/candidates'].includes(path)) return json([]);
  return json({});
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsReview } = await import('../src/components/commons/CommonsReview');
const { CommonsEvaluation } = await import('../src/components/commons/CommonsEvaluation');
const { CommonsDetail } = await import('../src/components/commons/CommonsDetail');
const { CommonsSettings } = await import('../src/components/commons/CommonsSettings');

beforeEach(() => {
  state.status = 503;
  vi.stubGlobal('fetch', vi.fn(backend));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('each pane load, no answer, verbatim', () => {
  for (const code of [503, 500, 408, 429]) {
    it(`Agent review (${code})`, async () => {
      state.failing = '/api/commons/review'; state.status = code;
      render(<CommonsReview />);
      expect(await screen.findByText(REVIEW)).toBeTruthy();
    });
  }

  it('reference detail', async () => {
    state.failing = '/api/commons/assets/a1';
    render(<CommonsDetail assetId="a1" onClose={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    expect(await screen.findByText(REFERENCE)).toBeTruthy();
  });

  it('Blind labeling', async () => {
    state.failing = '/api/commons/evaluation';
    render(<CommonsEvaluation />);
    expect(await screen.findByText(LABELING)).toBeTruthy();
  });

  for (const failing of ['/api/commons/settings', '/api/commons/folders', '/api/commons/vocabulary/candidates']) {
    it(`Commons Settings, whichever of its reads fails (${failing.slice('/api/commons/'.length)})`, async () => {
      state.failing = failing;
      render(<CommonsSettings status={null} onOpenAsset={vi.fn()} onChanged={vi.fn()} />);
      expect(await screen.findByText(SETTINGS)).toBeTruthy();
    });
  }
});

describe('another cause keeps its own words', () => {
  it('a refusal with a reason the backend wrote is not a no-answer line', async () => {
    state.failing = '';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      return path === '/api/commons/review' ? json({ detail: 'The review set is closed.' }, 409) : backend(input);
    }));
    render(<CommonsReview />);
    expect(await screen.findByText('Couldn’t load Agent review. The review set is closed.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('didn’t respond');
  });
});

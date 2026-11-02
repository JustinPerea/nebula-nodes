/**
 * PR #204 round 15 (GM r25, pane loads): a Commons pane's load that Nebula answered with no reason
 * (a 5xx, 408 or 429) says it in the because form, under the pane's own words, verbatim:
 *   Agent review:         "Nebula couldn’t load Agent review because it didn’t respond. Try again."
 *   reference detail:     "Nebula couldn’t load this reference because it didn’t respond. Try again."
 *   Blind labeling:       "Nebula couldn’t load Blind labeling because it didn’t respond. Try again."
 *   Commons Settings:     "Nebula couldn’t load the Commons settings because it didn’t respond. Try again."
 * The pane names its load whichever of its requests failed (Settings reads three). These run the
 * real Commons API and apiFetch; only the browser's fetch is stubbed.
 * Round 17 (review 13 NIT-3): on fake time, each wait a fixed number of 50 ms steps.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lineLook, NEUTRAL } from './helpers/lineLook';

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

/** Moves fake time in 50 ms steps until `check` passes, up to `max` ms. */
async function until(check: () => unknown, max = 3000): Promise<void> {
  for (let waited = 0; ; waited += 50) {
    try { check(); return; } catch (error) { if (waited >= max) throw error; }
    await act(() => vi.advanceTimersByTimeAsync(50));
  }
}
/** The line shows, and (round 18, GM r28 1) in the neutral look: a load that got no answer
 * destroys nothing. Read through the app's stylesheets. */
async function shows(words: string): Promise<void> {
  await until(() => screen.getByText(words));
  // Round 18b (GM r29 1): every load line is neutral, whatever its reason.
  const line = [...document.querySelectorAll('[data-commons-line]')].find((el) => el.textContent === words)!;
  expect(line.hasAttribute('data-line-neutral'), words).toBe(true);
  expect(lineLook(line), words).toEqual(NEUTRAL);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.className = 'app-slava-restraint';
  state.status = 503;
  vi.stubGlobal('fetch', vi.fn(backend));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.className = ''; });

describe('each pane load, no answer, verbatim', () => {
  for (const code of [503, 500, 408, 429]) {
    it(`Agent review (${code})`, async () => {
      state.failing = '/api/commons/review'; state.status = code;
      render(<CommonsReview />);
      await shows(REVIEW);
    });
  }

  it('reference detail', async () => {
    state.failing = '/api/commons/assets/a1';
    render(<CommonsDetail assetId="a1" onClose={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn()} />);
    await shows(REFERENCE);
  });

  it('Blind labeling', async () => {
    state.failing = '/api/commons/evaluation';
    render(<CommonsEvaluation />);
    await shows(LABELING);
  });

  for (const failing of ['/api/commons/settings', '/api/commons/folders', '/api/commons/vocabulary/candidates']) {
    it(`Commons Settings, whichever of its reads fails (${failing.slice('/api/commons/'.length)})`, async () => {
      state.failing = failing;
      render(<CommonsSettings status={null} onOpenAsset={vi.fn()} onChanged={vi.fn()} />);
      await shows(SETTINGS);
    });
  }
});

describe('a failed settings read shows no form (GM r29: only the heading and the line)', () => {
  /** Every field and control the settings pane draws. */
  const controls = () => [...document.querySelectorAll('.commons-settings :is(button, input, select, textarea, form, fieldset, [role="button"])')];
  for (const failing of ['/api/commons/settings', '/api/commons/folders', '/api/commons/vocabulary/candidates']) {
    it(`no Save, Link folder, field or maintenance action while it has failed (${failing.slice('/api/commons/'.length)})`, async () => {
      state.failing = failing;
      render(<CommonsSettings status={null} onOpenAsset={vi.fn()} onChanged={vi.fn()} />);
      await shows(SETTINGS);
      expect(controls().map((el) => el.outerHTML.slice(0, 60))).toEqual([]);
      for (const name of [/^Save$/, /^Link folder$/, /Re-analyze/, /Import moodboards/, /Export zip/]) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(screen.queryByLabelText('Folder path')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    });
  }
  it('before the read answers, no form either; once it answers, the form', async () => {
    state.failing = '';
    render(<CommonsSettings status={null} onOpenAsset={vi.fn()} onChanged={vi.fn()} />);
    expect(controls()).toEqual([]);
    await until(() => screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Link folder' })).toBeTruthy();
  });
});

describe('another cause: the because form where its reason has a clause, else the reason as it is (GM r29 1)', () => {
  const answer = (failing: string, status: number, detail: string) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    return path === failing ? json({ detail }, status) : backend(input);
  }));
  it('a reason with no clause yet: "Nebula couldn’t load X." and the reason as it is, neutral, no "Try again."', async () => {
    state.failing = '';
    answer('/api/commons/review', 409, 'The review set is closed.');
    render(<CommonsReview />);
    await shows('Nebula couldn’t load Agent review. The review set is closed.');
    expect(document.body.textContent).not.toContain('didn’t respond');
  });
  it('the reference detail\'s 404: the because form, "Reload …" not "Try again."', async () => {
    state.failing = '';
    answer('/api/commons/assets/ast_1', 404, "That reference isn't there anymore. Reload to get the latest references.");
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    await shows('Nebula couldn’t load this reference because it isn’t there anymore. Reload to get the latest references.');
    // As the settings: nothing to edit over a reference nothing read, only Close.
    expect([...document.querySelectorAll('.commons-detail :is(button, input, select, textarea, form)')].map((el) => el.textContent)).toEqual(['Close']);
  });
});

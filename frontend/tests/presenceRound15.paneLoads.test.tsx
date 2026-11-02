/**
 * PR #204 round 15 (GM r25, pane loads): a Commons pane's load that Nebula answered with no reason
 * (a 5xx, 408 or 429) says it in the because form, under the pane's own words, verbatim:
 *   Agent review:         "Nebula couldn’t load Agent review because the server didn’t respond. Try again."
 *   reference detail:     "Nebula couldn’t load this reference because the server didn’t respond. Try again."
 *   Blind labeling:       "Nebula couldn’t load Blind labeling because the server didn’t respond. Try again."
 *   Commons Settings:     "Nebula couldn’t load Commons settings because the server didn’t respond. Try again."
 * The pane names its load whichever of its requests failed (Settings reads three). These run the
 * real Commons API and apiFetch; only the browser's fetch is stubbed.
 * Round 17 (review 13 NIT-3): on fake time, each wait a fixed number of 50 ms steps.
 * Round 18d (review 14 live NIT-3): each test imports and renders a whole pane; under a loaded
 * run that took 5.4 s once, so the file has the 30 s the held-status test got.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lineLook, NEUTRAL } from './helpers/lineLook';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const REVIEW = 'Nebula couldn’t load Agent review because the server didn’t respond. Try again.';
const REFERENCE = 'Nebula couldn’t load this reference because the server didn’t respond. Try again.';
const LABELING = 'Nebula couldn’t load Blind labeling because the server didn’t respond. Try again.';
const SETTINGS = 'Nebula couldn’t load Commons settings because the server didn’t respond. Try again.';

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
  // Round 18f (GM r35 4): a line ending "Try again." ends in its button, so the words span it.
  const find = () => [...document.querySelectorAll('[data-commons-line]')].find((el) => el.textContent === words);
  await until(() => expect(find(), words).toBeTruthy());
  // Round 18b (GM r29 1): every load line is neutral, whatever its reason.
  const line = find()!;
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
  for (const code of [503, 502, 504, 408]) {
    it(`Agent review (${code})`, async () => {
      state.failing = '/api/commons/review'; state.status = code;
      render(<CommonsReview />);
      await shows(REVIEW);
    });
  }
  // Round 18d (GM r31): a rate limit has its own line.
  it('Agent review (429): the server is busy', async () => {
    state.failing = '/api/commons/review'; state.status = 429;
    render(<CommonsReview />);
    await shows('Nebula couldn’t load Agent review because the server is busy. Try again in a moment.');
  });
  // Round 18c (GM r30 3): the server's own error isn't "didn't respond".
  for (const code of [500, 501]) {
    it(`Agent review (${code}): the server hit an error`, async () => {
      state.failing = '/api/commons/review'; state.status = code;
      render(<CommonsReview />);
      await shows('Nebula couldn’t load Agent review because the server hit an error. Try again.');
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
  // Round 18f (GM r35 4): the line's own "Try again" is part of the line, not the form.
  const controls = () => [...document.querySelectorAll('.commons-settings :is(button, input, select, textarea, form, fieldset, [role="button"])')]
    .filter((el) => !el.closest('[data-commons-line]'));
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

describe('another cause: the because form, its clause or the 4xx line (GM r29 1, r30)', () => {
  const answer = (failing: string, status: number, detail: string) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    return path === failing ? json({ detail }, status) : backend(input);
  }));
  it('a reason not listed: the 4xx line, neutral; the backend\'s words only in the console (GM r30)', async () => {
    state.failing = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer('/api/commons/review', 409, 'The review set is closed.');
    render(<CommonsReview />);
    await shows('Nebula couldn’t load Agent review because the server didn’t accept it. Try again.');
    expect(document.body.textContent).not.toContain('The review set is closed');
    expect(warn.mock.calls.flat().join(' ')).toContain('The review set is closed.');
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

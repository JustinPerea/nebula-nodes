import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvaluationBatch } from '../src/lib/commonsEvaluationTypes';

/**
 * error-copy (GM - Design, reviewing #165, 2026-10-22): with a dropped
 * connection the leave popover's second line and the red banner above Blind
 * labeling both read the browser's "Failed to fetch". "That is a TypeError
 * message, not copy." A failed Commons request now says GM's line:
 *   lost connection          -> "Nebula's server isn't answering. Make sure it's running, then try again."
 *   408, 429 or any 5xx      -> "Nebula didn't respond. Try again."
 *   any other 4xx            -> the backend's detail (written copy), as before.
 * These run the real Commons API and apiFetch; only the browser's fetch is
 * stubbed, so the words are made where the requests are, not per screen.
 */

const LOST = "Nebula's server isn't answering. Make sure it's running, then try again.";
const NO_ANSWER = "Nebula didn't respond. Try again.";
// Round 2 (GM's WRAP rule): "when the surface already has a retry button, the
// reason line drops its 'try again'. The button is the retry." The leave
// popover offers Save and leave, so it says these.
const LOST_SHORT = "Nebula's server isn't answering. Make sure it's running.";
const NO_ANSWER_SHORT = "Nebula didn't respond.";
// Round 2: the banner is a one-line surface: "Couldn’t {verb} {object}. {reason}".
const LABELS = "Couldn’t save your labels.";
const CONFLICT = 'Labels changed in another window. Reload before saving.';

vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

type Failure = 'network' | 503 | 502 | 429 | 408 | 409;
const state: { labels: Failure } = { labels: 'network' };

function batch(): EvaluationBatch {
  return { revision: 3, state: 'open', denominator: 150, tuning_count: 30, manifest_hash: 'fixture', sealed: null, seal_hash: null,
    closed: null, close_hash: null,
    fields: { type_style: ['none', 'humanist_sans'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'], excluded_count: 0, assisted_reviews: 0,
    items: [{ position: 0, image_sha256: 'fixture-image', width: 40, height: 32, accent_locked: true, labels: null,
      palette: [{ index: 0, hex: '#ff0000', share: 1 }] }] } as EvaluationBatch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function backend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname;
  if (/^\/api\/commons\/evaluation\/items\/\d+\/labels$/.test(path) && method === 'PUT') {
    const failure = state.labels;
    if (failure === 'network') throw new TypeError('Failed to fetch');
    if (failure === 409) return json({ detail: CONFLICT }, 409);
    // A proxy's or server's own page, not JSON: main showed "Commons request failed (503)".
    return new Response('Service Unavailable', { status: failure, headers: { 'content-type': 'text/plain' } });
  }
  if (/^\/api\/commons\/evaluation\/items\/\d+\/image$/.test(path)) return new Response('fixture', { headers: { 'content-type': 'image/png' } });
  if (path === '/api/commons/evaluation') return json(batch());
  if (path === '/api/commons/review') return json(null);
  if (path === '/api/commons/status') return json({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  if (path === '/api/commons/search') return json({ results: [] });
  if (['/api/commons/collections', '/api/commons/folders', '/api/commons/vocabulary/candidates'].includes(path)) return json([]);
  if (path === '/api/commons/settings') return json({});
  return json({});
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsView } = await import('../src/components/commons/CommonsView');
const { CommonsEvaluation } = await import('../src/components/commons/CommonsEvaluation');
const { useUIStore } = await import('../src/store/uiStore');
const { commonsUnsaved } = await import('../src/lib/commonsUnsaved');

beforeEach(() => {
  state.labels = 'network';
  vi.stubGlobal('fetch', vi.fn(backend));
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Image', class {
    onload?: () => void;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const cases: Array<[string, Failure, string, string]> = [
  ['a lost connection', 'network', LOST, LOST_SHORT],
  ['a 503', 503, NO_ANSWER, NO_ANSWER_SHORT],
  ['a 502', 502, NO_ANSWER, NO_ANSWER_SHORT],
  ['a 429', 429, NO_ANSWER, NO_ANSWER_SHORT],
  ['a 408', 408, NO_ANSWER, NO_ANSWER_SHORT],
];

describe('the red banner above Blind labeling', () => {
  const banner = async () => {
    await waitFor(() => expect(document.querySelector('.commons-notice--error[role="alert"]')).not.toBeNull());
    return document.querySelector('.commons-notice--error[role="alert"]')!;
  };
  it.each(cases)('after %s says the heading and GM\'s line, not the raw message', async (_name, failure, line) => {
    state.labels = failure;
    render(<CommonsEvaluation />);
    fireEvent.click(await screen.findByText('Set neutral'));
    fireEvent.click(screen.getByText('Save labels'));
    const alert = await banner();
    expect(alert.textContent).toBe(`${LABELS} ${line}`);
    expect(alert).not.toHaveTextContent('Failed to fetch');
    expect(alert).not.toHaveTextContent(/Commons request failed|\(\d{3}\)/);
  });

  it('a 409 still says the backend\'s own words', async () => {
    state.labels = 409;
    render(<CommonsEvaluation />);
    fireEvent.click(await screen.findByText('Set neutral'));
    fireEvent.click(screen.getByText('Save labels'));
    expect((await banner()).textContent).toBe(`${LABELS} ${CONFLICT}`);
  });
});

describe('the leave popover\'s reason line', () => {
  const popover = () => screen.getByRole('alertdialog');
  async function failSaveAndLeave() {
    render(<CommonsView />);
    const tabs = await screen.findByRole('tablist', { name: 'Commons sections' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /^Blind labeling/ }));
    await screen.findByText('Describe the visual language.');
    fireEvent.change(screen.getByLabelText('type style'), { target: { value: 'humanist_sans' } });
    await waitFor(() => expect(commonsUnsaved()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Save and leave' }));
    await waitFor(() => expect(popover()).toHaveTextContent("Couldn’t save your labels."));
    return popover();
  }

  it.each(cases)('after %s reads GM\'s short line under the heading, and Save and leave is offered again', async (_name, failure, _line, short) => {
    state.labels = failure;
    const shown = await failSaveAndLeave();
    expect(shown.querySelector('.commons-leave__line')).toHaveTextContent("Couldn’t save your labels.");
    expect(shown.querySelector('.commons-leave__reason')?.textContent).toBe(short);
    expect(shown).not.toHaveTextContent('Failed to fetch');
    expect(within(shown).getByRole('button', { name: 'Save and leave' })).toBeTruthy();
    expect(useUIStore.getState().viewMode).toBe('commons');
  });

  it('after a 409 keeps the backend\'s words and offers no Save and leave', async () => {
    state.labels = 409;
    const shown = await failSaveAndLeave();
    await waitFor(() => expect(shown.querySelector('.commons-leave__reason')?.textContent).toBe(CONFLICT));
    expect(within(shown).queryByRole('button', { name: 'Save and leave' })).toBeNull();
  });
});

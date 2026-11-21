import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Moodboard } from '../../types';

/**
 * Error copy (design, 2026-10-22): "Check the other Commons save paths
 * and the board save too, since the same raw string probably leaks there."
 * On main a board save with no answer showed "Failed to fetch", and a 503
 * "Save failed: 503". The board's save now says the design's lines; the
 * backend's own 4xx reason is kept, after "Save failed:". A 4xx with no
 * reason says the design's line for its status; like the design's other
 * lines it stands alone, since the board's notice has no heading of its own.
 * The real lib/api.ts and apiFetch run here; only the browser's fetch is
 * stubbed.
 */

// A failure is one sentence in the because form, and beside a Try again button it ends "Try again."
const NO_ANSWER = 'The server didn’t respond. Try again.';

vi.mock('../../lib/wsClient', () => ({
  wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} },
}));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));

import { MoodboardStudioView } from './MoodboardStudioView';
import { noteProbeAnswer, startHealthProbe, subscribeHealthProbeRequests } from '../../lib/backendConnection';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';

type Failure = 'network' | 503 | 500 | 429 | 'detail-409' | 'bare-400' | 'bare-403' | 'bare-413' | 'field-list' | 'conflict' | 'disk-full';
const state: { edits: Failure | null; put: Failure | null; load: Failure | null; analyze: Failure | null; create: (() => Response) | null } = { edits: null, put: null, load: null, analyze: null, create: null };

const board = (): Moodboard => ({
  id: 'g1', name: 'Global board', version: 1, notes: '', mode: 'look', strength: 0.7,
  images: [{ id: 'i1', url: '/api/outputs/i1.png', weight: 1, notes: '', privateNote: '', excluded: false,
    placements: [{ id: 'c-i1', frameId: null, x: 0, y: 0, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '' }] }],
  analysis: null, direction: '', avoid: [], pinnedColors: { include: [], exclude: [] },
  briefOverride: null, thumbnail: '/api/outputs/i1.png', createdAt: '', updatedAt: '',
} as unknown as Moodboard);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fail(failure: Failure): Response {
  if (failure === 'network') throw new TypeError('Failed to fetch');
  if (failure === 'detail-409') return json({ detail: 'The store refused this write.' }, 409);
  if (failure === 'disk-full') return json({ detail: 'No space left on device', storage: 'full', code: 'project_store' }, 507);
  if (failure === 'bare-400') return new Response('', { status: 400 });
  if (failure === 'bare-403') return new Response('', { status: 403 });
  if (failure === 'bare-413') return new Response('', { status: 413 });
  if (failure === 'field-list') return json({ detail: [{ loc: ['body', 'ops', 0, 'images', 0, 'url'], msg: 'field required', type: 'missing' }] }, 422);
  // Someone else saved the board: the Studio rebases and sends again, three times.
  if (failure === 'conflict') return json({ detail: 'version conflict', code: 'version_conflict', board: { ...board(), version: 7 } }, 409);
  return new Response('<html>Service Unavailable</html>', { status: failure, headers: { 'content-type': 'text/html' } });
}

async function backend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? 'GET').toUpperCase();
  if (url.pathname === '/api/moodboards/g1/edits' && method === 'POST' && state.edits) return fail(state.edits);
  if (url.pathname === '/api/moodboards/g1' && method === 'PUT' && state.put) return fail(state.put);
  if (url.pathname === '/api/moodboards/g1/edits' && method === 'POST') {
    return json({ board: { ...board(), version: 2 }, version: 2, applied: [], undo: { ops: [] } });
  }
  if (url.pathname === '/api/moodboards/g1/analyze' && method === 'POST' && state.analyze) return fail(state.analyze);
  if (url.pathname === '/api/moodboards/g1/analyze' && method === 'POST') return json(board());
  if (url.pathname === '/api/moodboards/g1' && method === 'GET') return state.load ? fail(state.load) : json(board());
  if (url.pathname === '/api/moodboards' && method === 'POST' && state.create) return state.create();
  if (url.pathname === '/api/moodboards' && method === 'GET') return json(url.searchParams.get('scope') === 'global' ? [board()] : []);
  return json({});
}

beforeEach(() => {
  state.edits = null;
  state.put = null;
  state.load = null;
  state.analyze = null;
  state.create = null;
  vi.stubGlobal('fetch', vi.fn(backend));
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['p1', 'Project']);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openStudio() {
  act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
  render(<MoodboardStudioView />);
  await screen.findByDisplayValue('Global board');
}

const notice = async () => {
  await waitFor(() => expect(document.querySelector('.moodboard-studio__notice--error')).not.toBeNull(), { timeout: 3000 });
  return document.querySelector('.moodboard-studio__notice--error')!;
};

/** What each failure says after "because", beside a Try again button. */
const cases: Array<[string, Failure, string]> = [
  ['a lost connection', 'network', 'the server isn’t answering. Try again.'],
  ['a 503', 503, 'the server didn’t respond. Try again.'],
  ['a 500', 500, 'the server hit an error. Try again.'],
  ['a 429', 429, 'the server is busy. Try again.'],
];

/** The notice's line: one sentence. */
const line = (shown: Element) => shown.querySelector('.failure-lines__reason')?.textContent;

// A saved board's own save that fails keeps the edit in the draft (nothing rolls back)
// and the toolbar's Retry sends it again, so it says what a new board's failed create says (design):
// the neutral because-line, the "Not saved" chip. The cause names what happened; the backend's own
// reason is in the console only.
const saved = (cause: string) => `Nebula couldn’t save the moodboard because ${cause}. Try again.`;
const neutral = async () => {
  await waitFor(() => expect(document.querySelector('.moodboard-studio__notice--neutral')).not.toBeNull(), { timeout: 3000 });
  return document.querySelector('.moodboard-studio__notice--neutral')!;
};
const causes: Array<[string, Failure, string]> = [
  ['a lost connection', 'network', 'the server isn’t answering'],
  // The dev proxy's 503 page is the backend gone (lib/backend): no answer.
  ['a 503', 503, 'the server isn’t answering'],
  ['a 500', 500, 'the server hit an error'],
  ['a 429', 429, 'the server is busy'],
];

describe('a board save that fails', () => {
  it.each(causes)('an image edit after %s says the neutral line, "Not saved" and Try again', async (_name, failure, cause) => {
    state.edits = failure;
    await openStudio();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    expect((await neutral()).textContent).toBe(saved(cause));
    expect(document.querySelector('.moodboard-studio__notice--error')).toBeNull();
    expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
    expect(screen.queryByText(/Failed to fetch|Save failed: \d{3}/)).toBeNull();
    // Try again stays: saving again can work.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it.each(causes)('a board field (its name) after %s says the neutral line', async (_name, failure, cause) => {
    state.put = failure;
    await openStudio();
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'Renamed' } });
    expect((await neutral()).textContent).toBe(saved(cause));
  });

  // Each line ends with the step that works; where that step is
  // a reload there is no Retry (sending the same edit again fails the same way).
  it.each([
    ['detail-409', saved('the server didn’t accept this save'), true],
    ['field-list', saved('the server didn’t accept this save'), true],
    ['bare-400', saved('the server didn’t accept this save'), true],
    ['bare-403', 'Nebula couldn’t save the moodboard because you’re signed out. Open the link Nebula printed when it started.', false],
    ['bare-413', 'Nebula couldn’t save the moodboard because it’s too large. Remove some images, then try again.', true],
    ['disk-full', 'Nebula couldn’t save the moodboard because the disk is full. Free up some space, then try again.', true],
    ['conflict', 'Nebula couldn’t save the moodboard because it changed somewhere else. Reload to get the latest version.', false],
  ] as const)('a %s says its neutral line, no status code, no server words, and Try again only where trying again works', async (failure, line, retry) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.edits = failure;
    await openStudio();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    const shown = await neutral();
    expect(shown.textContent).toBe(line);
    expect(shown.textContent).not.toMatch(/\d|field required|images\.0\.url|refused this write|No space left/);
    expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retry);
  });

  it('a board that fails to load says one because line beside Try again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.load = 503;
    act(() => { useUIStore.getState().enterMoodboardEditor('g1', 'global'); });
    render(<MoodboardStudioView />);
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(line(alert)).toBe('Nebula couldn’t load the moodboard because the server didn’t respond. Try again.'));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

});

// The ask: "Make Retry redo the failed action, never a different one."
// The toolbar's Retry after an analyze failure analyzes again, so the notice
// takes the design's short line (WRAP: "The button is the retry"). On 867f254e
// the Retry saved the board instead and the line kept its "Try again".
describe('an analyze that fails', () => {
  it.each(cases)('after %s says one because line, beside Try again', async (_name, failure, clause) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.analyze = failure;
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(line(await notice())).toBe(`Nebula couldn’t analyze the moodboard because ${clause}`);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('Try again analyzes again, and never saves the board instead', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.analyze = 503;
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(async () => expect(line(await notice())).toMatch(/^Nebula couldn’t analyze the moodboard/));
    const sent = () => vi.mocked(fetch).mock.calls.map(([input, init]) =>
      `${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(input)).pathname}`);
    const before = sent().length;
    state.analyze = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sent().slice(before)).toContain('POST /api/moodboards/g1/analyze'));
    expect(sent().slice(before).filter((call) => call.startsWith('PUT ') || call.endsWith('/edits'))).toEqual([]);
    await waitFor(() => expect(document.querySelector('.moodboard-studio__notice--error')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a save failure after it takes the save line again (its Try again saves)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.analyze = 503;
    await openStudio();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(async () => expect(line(await notice())).toMatch(/^Nebula couldn’t analyze the moodboard/));
    state.edits = 503;
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    expect((await neutral()).textContent).toBe(saved('the server isn’t answering'));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

// A line that no button redoes shows no Retry, and keeps the design's full line.
describe('a line no Try again redoes', () => {
  it('has no Try again beside it, and keeps its full line', async () => {
    await openStudio();
    const key = Object.keys(useAssetStudioDraftStore.getState().entries)[0];
    act(() => {
      useAssetStudioDraftStore.getState().patch(key, { saveState: 'error',
        saveError: { heading: 'Couldn’t upload the image.', reason: NO_ANSWER } });
    });
    expect(line(await notice())).toBe('Nebula couldn’t upload the image because the server didn’t respond. Try again.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

// A failed save is still owed when an upload or brief failure replaces its
// line. The toolbar keeps its Retry, and that Retry saves (the save is the
// action that failed and still has to happen); autosave waits while the
// board says Error. The notice keeps the upload's own full line, since its
// Retry doesn't redo the upload.
describe('a save still owed under another failure', () => {
  it('keeps the toolbar Try again, and Try again saves the board again', async () => {
    state.edits = 503;
    await openStudio();
    fireEvent.change(screen.getAllByRole('slider', { name: /^Weight/ })[0], { target: { value: '0.5' } });
    expect((await neutral()).textContent).toBe(saved('the server isn’t answering'));
    const key = Object.keys(useAssetStudioDraftStore.getState().entries)[0];
    // What the upload's catch does (MoodboardStudioView: patch({ saveError })).
    act(() => {
      useAssetStudioDraftStore.getState().patch(key, {
        saveError: { heading: 'Couldn’t upload the image.', reason: NO_ANSWER } });
    });
    expect(line(await notice())).toBe('Nebula couldn’t upload the image because the server didn’t respond. Try again.');
    const sent = () => vi.mocked(fetch).mock.calls.map(([input, init]) =>
      `${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(input)).pathname}`);
    const before = sent().length;
    state.edits = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sent().slice(before).some((call) =>
      call === 'POST /api/moodboards/g1/edits' || call === 'PUT /api/moodboards/g1')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
  });
});

// A new board's create goes through the real lib/api here, so its heading and line are
// what the person reads. Nothing is lost when it fails: the neutral line, never "create".
describe('a new board\'s save (its create) that fails', () => {
  const openNewWithName = async () => {
    act(() => { useUIStore.getState().enterMoodboardEditor('new', 'global'); });
    render(<MoodboardStudioView />);
    await screen.findByDisplayValue('Untitled Moodboard');
    // An image on the unsaved board: New saves it first.
    act(() => { useAssetStudioDraftStore.getState().edit(JSON.stringify(['moodboard', 'global', 'new']),
      (draft) => ({ ...(draft as object), images: board().images })); });
    fireEvent.click(screen.getByRole('button', { name: '+ New moodboard' }));
  };

  // A create cut off with no answer probes first: the banner's probe finds Nebula online here.
  let stopProbe: () => void = () => {};
  beforeEach(() => {
    stopProbe = subscribeHealthProbeRequests(() => { act(() => { noteProbeAnswer(startHealthProbe(), 'online'); }); });
  });
  afterEach(() => { stopProbe(); });

  it('with no answer: the neutral save line and the "Not saved" chip, as a background save says it', async () => {
    state.create = () => { throw new TypeError('Failed to fetch'); };
    await openNewWithName();
    const line = await screen.findByText('Nebula couldn’t save the moodboard because the server isn’t answering. Try again.');
    expect(line.closest('.moodboard-studio__notice')!.className).toContain('moodboard-studio__notice--neutral');
    expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
    expect(document.body.textContent).not.toMatch(/Couldn.t create/);
  });

  // Neutral, the same line for the 409 and the 422; Retry creates without the refused id.
  it('a 409 for an id another project\'s board was made with: the neutral line, as the id 422', async () => {
    state.create = () => json({ detail: 'This request id already made a board in another project (or in Global). Use a new request id for this board.',
      code: 'request_id_scope' }, 409);
    await openNewWithName();
    expect((await neutral()).textContent).toBe(saved('the server didn’t accept this save'));
    expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/request id|Global\)/);
    expect(useAssetStudioDraftStore.getState().entries[JSON.stringify(['moodboard', 'global', 'new'])].createRequestId).toBeNull();
  });

  it('a 422 refusing the create\'s id: 7(b)\'s neutral line, never "create", never the server\'s words', async () => {
    state.create = () => json({ detail: "requestId must be 8 to 128 letters, digits, '-' or '_'" }, 422);
    await openNewWithName();
    expect((await neutral()).textContent).toBe(saved('the server didn’t accept this save'));
    expect(document.body.textContent).not.toMatch(/Couldn.t create|requestId/);
    expect(document.querySelector('.moodboard-studio-toolbar__state')!.textContent).toBe('Not saved');
  });
});

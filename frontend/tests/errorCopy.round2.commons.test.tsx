import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * error-copy round 2 (GM - Design), the Commons:
 * - Upload per file: "heading 'Couldn’t upload {filename}.' with the mapped
 *   reason line below it, e.g. 'Couldn’t upload dusk.png. That's too large
 *   to save.' Never pass the raw backend text through." The backend sends,
 *   per refused file, its machine `reason` and the person's line (`person`,
 *   from backend/commons/person_copy.py, the one table of those words); the
 *   frontend shows `person`, never `error`.
 * - text-wrap: pretty on the popover's and the notices' body text, "so a
 *   short last word is never left alone on a line".
 * The real Commons API and apiFetch run; only the browser's fetch is stubbed.
 */

vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RAW = ['image is larger than the 25 MB cap', 'unsupported file type (accepted: jpg, png, webp, gif, heic, mp4, mov)',
  'unreadable image: cannot identify image file', 'something new'];

async function backend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname;
  if (path === '/api/commons/intake/files' && method === 'POST') {
    return json({ results: [
      { filename: 'dusk.png', ok: false, error: RAW[0], reason: 'too_large', person: "That's too large to save." },
      { filename: 'notes.txt', ok: false, error: RAW[1], reason: 'unsupported_type',
        person: "Nebula can't read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV." },
      { filename: 'broken.png', ok: false, error: RAW[2], reason: 'unreadable', person: "That file couldn't be read. It may be damaged." },
      // A code newer than this frontend: the backend's line still shows.
      { filename: 'new.png', ok: false, error: RAW[3], reason: 'a_code_this_build_does_not_know', person: 'Nebula is still checking that file.' },
      // No `person` (a backend from before this change): GM's 4xx fallback, never `error`.
      { filename: 'odd.png', ok: false, error: RAW[3], reason: 'a_code_this_build_does_not_know' },
      { filename: 'fine.png', ok: true, asset_id: 'a1' },
    ] });
  }
  if (path === '/api/commons/status') return json({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } });
  if (path === '/api/commons/search') return json({ results: [] });
  if (path === '/api/commons/collections') return json([{ id: 'c1', name: 'Refs', kind: 'user', brand: null }]);
  if (['/api/commons/folders', '/api/commons/vocabulary/candidates'].includes(path)) return json([]);
  return json({});
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsView } = await import('../src/components/commons/CommonsView');
const { useUIStore } = await import('../src/store/uiStore');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(backend));
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Commons upload, per file', () => {
  it('each refused file: heading "Couldn\'t upload {filename}." with the mapped reason below it, never the raw text', async () => {
    render(<CommonsView />);
    const grid = await waitFor(() => {
      const found = document.querySelector('.commons-grid-wrap');
      expect(found).not.toBeNull();
      return found!;
    });
    // The upload goes to the first collection, once it has loaded.
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/api/commons/collections'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const files = ['dusk.png', 'notes.txt', 'broken.png', 'new.png', 'odd.png', 'fine.png'].map((name) => new File(['x'], name));
    fireEvent.drop(grid, { dataTransfer: { files, types: ['Files'] } });
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.querySelectorAll('.failure-lines')).toHaveLength(5));
    const shown = [...alert.querySelectorAll('.failure-lines')].map((item) => [
      item.querySelector('.failure-lines__heading')?.textContent, item.querySelector('.failure-lines__reason')?.textContent]);
    expect(shown).toEqual([
      ["Couldn’t upload dusk.png.", "That's too large to save."],
      ["Couldn’t upload notes.txt.", "Nebula can't read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV."],
      ["Couldn’t upload broken.png.", "That file couldn't be read. It may be damaged."],
      ["Couldn’t upload new.png.", 'Nebula is still checking that file.'],
      ["Couldn’t upload odd.png.", "Try again, or reload if it keeps happening."],
    ]);
    for (const raw of RAW) expect(alert).not.toHaveTextContent(raw);
    // On 1fc3d846 the refresh after an upload cleared the error at once (a
    // search that worked said setError(null)), so these never stayed up.
    // They are their own list now; the count of what was added shows too.
    expect(screen.getByText('Added 1 of 6.')).toBeTruthy();
  });
});

describe('text-wrap: pretty on popover and notice body text (GM)', () => {
  const css = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');
  const rule = (source: string, selector: string) => {
    const at = source.indexOf(`${selector} {`);
    expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
    return source.slice(at, source.indexOf('}', at));
  };
  it.each([
    ['commons.css', 'body.app-slava-restraint .commons-leave__reason'],
    ['commons.css', 'body.app-slava-restraint .commons-notice'],
    ['moodboard-studio.css', 'body.app-slava-restraint .moodboard-studio__notice'],
    ['character-studio.css', 'body.app-slava-restraint .character-studio-view__notice'],
    ['layouts.css', '.failure-lines'],
  ])('%s %s', (file, selector) => {
    expect(rule(css(file), selector)).toMatch(/text-wrap:\s*pretty/);
  });
});

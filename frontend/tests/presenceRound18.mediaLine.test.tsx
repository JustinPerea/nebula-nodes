/**
 * PR #204 round 18 (GM r28 1): a reference's media that Nebula didn't answer for says so in the
 * one Commons line style, neutral, inside its tile. Runs the real Commons API and apiFetch; only
 * the browser's fetch is stubbed (503, no reason). Read through the app's own stylesheets.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lineLook, NEUTRAL } from './helpers/lineLook';

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsMedia } = await import('../src/components/commons/CommonsMedia');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');

beforeEach(() => {
  document.body.className = 'app-slava-restraint';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Service Unavailable', { status: 503, headers: { 'content-type': 'text/plain' } })));
});
afterEach(() => { cleanup(); resetLinesForTests(); vi.unstubAllGlobals(); document.body.className = ''; });

it('a media load with no answer draws the neutral Commons line, not bare text', async () => {
  const view = render(<CommonsMedia path="/api/commons/blobs/a.png" alt="Reference" />);
  const line = await waitFor(() => {
    const box = view.container.querySelector('[data-commons-line]');
    expect(box).not.toBeNull();
    return box!;
  });
  expect(line.textContent).toBe('Nebula couldn’t load this reference because it didn’t respond. Try again.');
  expect(line.tagName).toBe('SPAN');
  expect(line.hasAttribute('data-line-neutral')).toBe(true);
  expect(lineLook(line)).toEqual(NEUTRAL);
});

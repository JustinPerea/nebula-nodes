/**
 * PR #204 round 18h, review 16 (commons-reconnect logic lens): races and Try again.
 *
 * - PA (LOW-1): a link's late read-back renames only the notice it wrote, never a newer one.
 * - PB/PB2 (LOW-2): a collections read that answers after a newer one is dropped, and Add to
 *   shows the collection Add sends to, by construction.
 * - PC (GM r38 3b): a Try again whose re-read fails for another reason keeps focus on the new
 *   line's Try again.
 * - PF (GM r38 3a): Agent review's loaded-state line ending "Try again." has the button.
 * Probes from review 16, turned into assertions.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withFocusFixup } from './helpers/focusFixup';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (o) => ({ ...await o<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (o) => ({ ...await o<typeof import('../src/lib/personSession')>(), personToken: async () => 'a'.repeat(43) }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { CommonsSettings } = await import('../src/components/commons/CommonsSettings');
const { CommonsReview } = await import('../src/components/commons/CommonsReview');
const { notePersonPromoted, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
vi.setConfig({ testTimeout: 30_000 });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const status = { worker: { running: false, state: 'idle' }, queue: {}, meter: { calls: 0, cap: 100, remaining: 100, resets_at: '2026-11-02T00:00:00Z' } };
type H = (path: string, init?: RequestInit) => Promise<Response> | Response | undefined;
let hook: H = () => undefined;
const bodies: { path: string; body: string }[] = [];
function base(path: string, init?: RequestInit): Promise<Response> {
  const h = hook(path, init);
  if (h) return Promise.resolve(h);
  if (init?.method === 'POST') bodies.push({ path, body: String(init.body ?? '') });
  if (path.endsWith('/status')) return Promise.resolve(json(status));
  if (path.endsWith('/collections') && init?.method === 'POST') return Promise.resolve(json({ id: 'c2', name: 'New', kind: 'manual' }));
  if (path.endsWith('/collections')) return Promise.resolve(json([{ id: 'c1', name: 'Refs', kind: 'manual' }]));
  if (path.endsWith('/search')) return Promise.resolve(json({ results: [] }));
  if (path.endsWith('/folders') && init?.method === 'POST') return Promise.resolve(json({ id: 'f9', path: '/Users/me', ignores: [] }));
  if (path.endsWith('/folders')) return Promise.resolve(json([{ id: 'f9', path: '/Users/me', ignores: [], last_scan_at: null, last_scan_summary: null, device_states: [] }]));
  if (path.endsWith('/candidates')) return Promise.resolve(json([]));
  if (path.endsWith('/settings')) return Promise.resolve(json({ daily_cap: 100 }));
  if (path.includes('reanalyze')) return Promise.resolve(json({ queued: 0 }));
  return Promise.resolve(json({}));
}
// Round 18l: Chrome's focus fixup, so focus asserted here is where Chrome would leave it.
withFocusFixup();
beforeEach(() => {
  vi.useFakeTimers();
  document.body.className = 'app-slava-restraint';
  resetPersonSessionForTests(); resetCommonsSessionForTests(); resetLinesForTests(); resetBackendConnectionForTests();
  hook = () => undefined; bodies.length = 0;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation((p: string, i?: RequestInit) => base(String(p), i));
});
afterEach(() => { cleanup(); act(() => notePersonPromoted()); act(() => resetBackendConnectionForTests()); resetCommonsSessionForTests(); vi.useRealTimers(); });

it('PA: a link\'s late read-back leaves a newer notice alone', async () => {
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let foldersReads = 0;
  render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
  await tick(1000);
  // Hold the first read-back (the link's) only.
  transport.fetch.mockImplementation(async (p: string, i?: RequestInit) => {
    const path = String(p);
    if (path.endsWith('/folders') && i?.method !== 'POST' && ++foldersReads === 1) { await gate; }
    return base(path, i);
  });
  foldersReads = 0;
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder path' }), { target: { value: '~' } });
  fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
  await tick(50);
  const notice = () => document.querySelector<HTMLElement>('.commons-notice[role="status"]');
  expect(notice()?.textContent).toBe('Linked “~”. Scanning it now.');
  fireEvent.click(screen.getByRole('button', { name: 'Re-analyze stale' }));
  await tick(100);
  expect(notice()?.textContent).toBe('Queued 0 stale items for re-analysis.');
  release();
  await tick(100);
  // The newer notice stays; the link's read-back renames only its own.
  expect(notice()?.textContent).toBe('Queued 0 stale items for re-analysis.');
  expect(notice()?.getAttribute('title')).toBeNull();
});

it('PB: Import\'s re-read, sent before New collection lands, answers after the merge', async () => {
  render(<CommonsView />);
  await tick(1000);
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let reads = 0;
  let created = false;
  transport.fetch.mockImplementation(async (p: string, i?: RequestInit) => {
    const path = String(p);
    if (path.endsWith('/collections') && i?.method === 'POST') created = true;
    if (path.endsWith('/collections') && i?.method !== 'POST') {
      reads += 1;
      const list = [{ id: 'c1', name: 'Refs', kind: 'manual' }, ...(created ? [{ id: 'c2', name: 'New', kind: 'manual' }] : [])];
      if (reads === 1) { await gate; return json(list); }
      return json({ detail: 'x' }, 503);
    }
    if (path.includes('moodboard')) return json({ collections: 0, added: 0, skipped: [] });
    return base(path, i);
  });
  fireEvent.click(document.querySelector<HTMLButtonElement>('.commons-add > button')!);
  await tick(10);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Import moodboards' }));
  await tick(50);
  const sel = () => document.querySelector<HTMLSelectElement>('.commons-field--inline select')!;
  fireEvent.change(sel(), { target: { value: '__new__' } });
  await tick(10);
  fireEvent.change(screen.getByRole('textbox', { name: /New collection name/ }), { target: { value: 'New' } });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await tick(500);
  expect(sel().value).toBe('c2');
  release();
  await tick(500);
  const s = sel();
  // Import's older read answered last: dropped, so New stays chosen and listed.
  expect(s.value).toBe('c2');
  expect(s.options[s.selectedIndex]?.textContent).toBe('New');
  expect([...s.options].map((o) => o.value)).toContain('c2');
  fireEvent.click(document.querySelector<HTMLButtonElement>('.commons-add > button')!);
  await tick(10);
  const box = screen.getByRole('textbox', { name: 'Image or page URL' });
  fireEvent.change(box, { target: { value: 'https://example.invalid/a.png' } });
  fireEvent.submit(box.closest('form')!);
  await tick(100);
  expect(bodies.filter((b) => b.path.endsWith('/intake/url')).map((b) => JSON.parse(b.body).collection_id)).toEqual(['c2']);
});

it('PB2: (no failure) Import\'s re-read, sent before New collection lands, answers after the merge', async () => {
  render(<CommonsView />);
  await tick(1000);
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let reads = 0;
  let created = false;
  transport.fetch.mockImplementation(async (p: string, i?: RequestInit) => {
    const path = String(p);
    if (path.endsWith('/collections') && i?.method === 'POST') created = true;
    if (path.endsWith('/collections') && i?.method !== 'POST') {
      reads += 1;
      const list = [{ id: 'c1', name: 'Refs', kind: 'manual' }, ...(created ? [{ id: 'c2', name: 'New', kind: 'manual' }] : [])];
      if (reads === 1) { await gate; return json(list); }
      return json(list);
    }
    if (path.includes('moodboard')) return json({ collections: 0, added: 0, skipped: [] });
    return base(path, i);
  });
  fireEvent.click(document.querySelector<HTMLButtonElement>('.commons-add > button')!);
  await tick(10);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Import moodboards' }));
  await tick(50);
  const sel = () => document.querySelector<HTMLSelectElement>('.commons-field--inline select')!;
  fireEvent.change(sel(), { target: { value: '__new__' } });
  await tick(10);
  fireEvent.change(screen.getByRole('textbox', { name: /New collection name/ }), { target: { value: 'New' } });
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await tick(500);
  expect(sel().value).toBe('c2');
  release();
  await tick(500);
  const s = sel();
  // Import's older read answered last: dropped, so New stays chosen and listed.
  expect(s.value).toBe('c2');
  expect(s.options[s.selectedIndex]?.textContent).toBe('New');
  expect([...s.options].map((o) => o.value)).toContain('c2');
  fireEvent.click(document.querySelector<HTMLButtonElement>('.commons-add > button')!);
  await tick(10);
  const box = screen.getByRole('textbox', { name: 'Image or page URL' });
  fireEvent.change(box, { target: { value: 'https://example.invalid/a.png' } });
  fireEvent.submit(box.closest('form')!);
  await tick(100);
  expect(bodies.filter((b) => b.path.endsWith('/intake/url')).map((b) => JSON.parse(b.body).collection_id)).toEqual(['c2']);
});

it('PC: a Try again whose re-read fails for another reason keeps focus on the new line\'s Try again', async () => {
  let collectionsStatus = 503;
  transport.fetch.mockImplementation(async (p: string, i?: RequestInit) => {
    const path = String(p);
    if (path.endsWith('/collections') && i?.method !== 'POST') return json({ detail: 'x' }, collectionsStatus);
    return base(path, i);
  });
  render(<CommonsView />);
  await tick(3000);
  const btn = () => screen.queryByRole('button', { name: 'Try again' });
  expect(document.querySelector('[data-commons-line]')?.textContent).toMatch(/didn’t respond\. Try again\.$/);
  collectionsStatus = 500;
  act(() => btn()!.focus());
  fireEvent.click(btn()!);
  await tick(2000);
  expect(document.querySelector('[data-commons-line]')?.textContent).toMatch(/hit an error\. Try again\.$/);
  expect(btn()).not.toBeNull();
  expect(document.activeElement).toBe(btn());
});

it('PF: Agent review answered, then its 5 s re-read fails: the line ending "Try again." has the button', async () => {
  let fail = false;
  const batch = { id: 'b1', state: 'open', attempts: 0, call_budget: 3, items: [] };
  transport.fetch.mockImplementation(async (p: string, i?: RequestInit) => {
    const path = String(p);
    if (path.endsWith('/review')) return fail ? json({ detail: 'x' }, 500) : json(batch);
    return base(path, i);
  });
  render(<CommonsReview active onWork={() => {}} />);
  await tick(1000);
  expect(document.querySelector('[data-commons-line]')).toBeNull();
  fail = true;
  await tick(5100);
  expect(document.querySelector('[data-commons-line]')?.textContent).toMatch(/Try again\.$/);
  const button = screen.getByRole('button', { name: 'Try again' });
  // The button reads at once; the 5 s poll goes on as before.
  const before = transport.fetch.mock.calls.filter(([p]) => String(p).endsWith('/review')).length;
  fail = false;
  fireEvent.click(button);
  await tick(50);
  expect(transport.fetch.mock.calls.filter(([p]) => String(p).endsWith('/review')).length).toBe(before + 1);
  expect(document.querySelector('[data-commons-line]')).toBeNull();
});

it('H8: a newer list without the chosen collection: Add to and Add both move to the list\'s first', async () => {
  let gone = false;
  transport.fetch.mockImplementation(async (p: string, i?: RequestInit) => {
    const path = String(p);
    if (path.endsWith('/collections') && i?.method !== 'POST') {
      return json(gone ? [{ id: 'c1', name: 'Refs', kind: 'manual' }]
        : [{ id: 'c1', name: 'Refs', kind: 'manual' }, { id: 'c2', name: 'New', kind: 'manual' }]);
    }
    if (path.includes('moodboard')) return json({ collections: 0, added: 0, skipped: [] });
    return base(path, i);
  });
  render(<CommonsView />);
  await tick(1000);
  const sel = () => document.querySelector<HTMLSelectElement>('.commons-field--inline select')!;
  fireEvent.change(sel(), { target: { value: 'c2' } });
  await tick(10);
  expect(sel().value).toBe('c2');
  // Another window removed "New"; Import's re-read lists only Refs.
  gone = true;
  fireEvent.click(document.querySelector<HTMLButtonElement>('.commons-add > button')!);
  await tick(10);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Import moodboards' }));
  await tick(500);
  expect(sel().value).toBe('c1');
  fireEvent.click(document.querySelector<HTMLButtonElement>('.commons-add > button')!);
  await tick(10);
  const box = screen.getByRole('textbox', { name: 'Image or page URL' });
  fireEvent.change(box, { target: { value: 'https://example.invalid/a.png' } });
  fireEvent.submit(box.closest('form')!);
  await tick(100);
  expect(bodies.filter((b) => b.path.endsWith('/intake/url')).map((b) => JSON.parse(b.body).collection_id)).toEqual(['c1']);
});

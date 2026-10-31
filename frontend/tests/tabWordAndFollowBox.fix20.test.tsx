/**
 * Round 20 of PR #199 (GM r29):
 * - fix 2: every line with "tab" or "window" uses the shared word (lib/tabWord):
 *   "tab" in the browser, "window" in the desktop app;
 * - 1 and fix 1: Nebula's own reopen this tab couldn't follow shows on
 *   Projects in the neutral box, the line ending at the failure, with
 *   [Open “Delta”] in place of Try again;
 * - 2: the recover answer's `sourceName` reaches the tab.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const fetched = vi.hoisted(() => ({ body: {} as Record<string, unknown> }));
vi.mock('../src/lib/apiRequest', () => ({
  apiRequest: vi.fn(async () => new Response(JSON.stringify(fetched.body), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import { tabWord } from '../src/lib/tabWord';
import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { recoverProject, saveProject } from '../src/lib/projects';
import { apiRequest } from '../src/lib/apiRequest';

const src = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');

describe('GM r29 fix 2: the shared tab/window word', () => {
  afterEach(() => { delete (window as { nebulaDesktop?: unknown }).nebulaDesktop; vi.resetModules(); });

  it('GM r31, 3: the other-tab follow failure is active, in the browser’s word and the desktop app’s', async () => {
    vi.resetModules();
    const browser = await import('../src/store/projectStore');
    expect(browser.personFollowFailedLine('Delta')).toBe('You reopened “Delta” in another tab, but this tab couldn’t follow it.');
    (window as { nebulaDesktop?: unknown }).nebulaDesktop = { apiBaseUrl: 'http://127.0.0.1:1' };
    vi.resetModules();
    const desktop = await import('../src/store/projectStore');
    expect(desktop.personFollowFailedLine('Delta')).toBe('You reopened “Delta” in another window, but this window couldn’t follow it.');
  });

  it('“tab” in the browser, “window” in the desktop app', () => {
    expect(tabWord(false)).toBe('tab');
    expect(tabWord(true)).toBe('window');
    expect(tabWord()).toBe('tab');
  });

  it('a browser build says “tab” in the kept lines', async () => {
    vi.resetModules();
    const core = await import('../src/components/projects/restoreCopyCore');
    const discard = await import('../src/components/projects/KeptDiscardConfirm');
    expect(core.LATEST_EDITS_KEPT).toBe('Your latest edits weren’t saved yet. They’re kept in this tab.');
    expect(core.RESTORE_COPY_FALLBACK_KEPT).toBe('Nebula restored its project list before your latest edits were saved. They’re kept in this tab.');
    expect(discard.DISCARD_KEPT_BODY).toBe('They’re only in this tab, so they can’t be brought back.');
  });

  it('the desktop app says “window” in the same lines', async () => {
    (window as { nebulaDesktop?: unknown }).nebulaDesktop = { apiBaseUrl: 'http://127.0.0.1:1' };
    vi.resetModules();
    const core = await import('../src/components/projects/restoreCopyCore');
    const discard = await import('../src/components/projects/KeptDiscardConfirm');
    expect(core.LATEST_EDITS_KEPT).toBe('Your latest edits weren’t saved yet. They’re kept in this window.');
    expect(core.RESTORE_COPY_FALLBACK_KEPT.endsWith('They’re kept in this window.')).toBe(true);
    expect(discard.DISCARD_KEPT_BODY).toBe('They’re only in this window, so they can’t be brought back.');
  });

  it('no line in this PR’s copy hard-codes the word', () => {
    const literal = /['"`][^'"`\n]*\b(this|the|another) (tab|window)\b[^'"`\n]*['"`]/;
    const files = ['components/projects/restoreCopyCore.ts', 'components/projects/KeptDiscardConfirm.tsx'];
    for (const file of files) expect(src(file).split('\n').filter((line) => literal.test(line) && !/^\s*(\/\/|\*)/.test(line))).toEqual([]);
    const store = src('store/projectStore.ts');
    for (const line of ['Nebula was updated while this ', 'and the ${TAB} reloads to use the update', 'then reload the ${TAB} to use the update',
      'but this ${TAB} couldn’t follow it.', 'Reload the ${TAB} to use the update']) expect(store).toContain(line);
    expect(store).not.toMatch(/['"`][^'"`\n]*\b(this|the|another) (tab|window)\b[^'"`\n]*\b(couldn’t follow|was open|reloads to use|to use the update)/);
  });
});

const base = { projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;

describe('GM r29, 1 and fix 1: the boot-follow box on Projects', () => {
  it('neutral, the line ending at the failure, and [Open “Delta”] as its only button', () => {
    const onRetry = vi.fn();
    const { container } = render(<ProjectHome {...base} onRetry={onRetry} retry="openFollowed" openFollowedName="Delta"
      error="Nebula opened “Delta”, but this tab couldn’t follow it." />);
    expect(container.querySelector('.project-home__error')).toBeNull();
    const box = container.querySelector<HTMLElement>('[data-followed-notice]')!;
    expect(box.classList.contains('project-home__notice')).toBe(true);
    expect(box.textContent).toContain('Nebula opened “Delta”, but this tab couldn’t follow it.');
    expect(box.textContent).not.toContain('Open it from Projects');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    const buttons = box.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Open “Delta”');
    fireEvent.click(buttons[0]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('the neutral box’s rule: the notice’s border and fill, not the error’s', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/project-home.css'), 'utf8');
    const rule = css.split('\n').find((line) => line.startsWith('body.app-slava-restraint .project-home__notice {'))!;
    expect(rule).toContain('border: 1px solid var(--sr-edge-strong)');
    expect(rule).toContain('background: var(--sr-canvas-elevated)');
  });

  it('any other error keeps the error box and Try again', () => {
    const { container } = render(<ProjectHome {...base} retry="redo" error="Couldn’t load your projects." />);
    expect(container.querySelector('.project-home__error')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('GM r30 item 2: the lock line under the open project’s card', () => {
  const card = (id: string, name: string) => ({ id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
    lastOpenedAt: null, nodeCount: 1, edgeCount: 0, thumbnail: null });
  it('the line goes under the held card only, Open stays live and is described by it', () => {
    const onOpen = vi.fn();
    const line = 'You can reopen “Delta” when the run finishes.';
    const { container } = render(<ProjectHome {...base} onOpen={onOpen} projects={[card('delta', 'Delta'), card('echo', 'Echo')]}
      reopenHold={{ id: 'delta', line }} />);
    const lines = container.querySelectorAll<HTMLElement>('[data-reopen-hold]');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe(line);
    expect(lines[0].id).toBe('project-lock-delta');
    const open = screen.getAllByRole('button', { name: /^Open/ }).find((button) => button.getAttribute('aria-describedby') === 'project-lock-delta')!;
    expect(open).toBeTruthy();
    expect((open as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith('delta');
  });

  it('no hold: no line', () => {
    const { container } = render(<ProjectHome {...base} projects={[card('delta', 'Delta')]} reopenHold={null} />);
    expect(container.querySelector('[data-reopen-hold]')).toBeNull();
  });
});

describe('GM r29, 2: the recover answer’s source reaches the tab', () => {
  const answer = (more: Record<string, unknown>) => ({ project: { id: 'c', name: 'Recovered Shot 7 copy' }, workspaceRevision: 'r', ...more });

  it('`sourceName` is kept with the copy', async () => {
    fetched.body = answer({ sourceName: 'Shot 7 copy' });
    expect((await recoverProject('src', { nodes: [], edges: [] } as never, 'rid', 1)).sourceName).toBe('Shot 7 copy');
  });

  it('none, or not a name: none (the copy’s name is never read for it)', async () => {
    fetched.body = answer({});
    expect((await recoverProject('src', { nodes: [], edges: [] } as never, 'rid', 1)).sourceName).toBeUndefined();
    fetched.body = answer({ sourceName: 7 });
    expect((await recoverProject('src', { nodes: [], edges: [] } as never, 'rid', 1)).sourceName).toBeUndefined();
  });
});

describe('review 18 MEDIUM-1: a handoff names its deletes', () => {
  const sent = () => JSON.parse(String((vi.mocked(apiRequest).mock.calls.at(-1)![2] as RequestInit).body)) as Record<string, unknown>;
  it('the tab-local nodes this tab deleted go as deletedNodeIds; none, no field (an omission is never a delete)', async () => {
    fetched.body = { project: { id: 'alpha', name: 'Alpha' }, workspaceRevision: 'r' };
    await saveProject('alpha', { nodes: [], edges: [] } as never, 'rev', { params: {}, labels: {}, deleted: ['d-1'] });
    expect(sent().deletedNodeIds).toEqual(['d-1']);
    await saveProject('alpha', { nodes: [], edges: [] } as never, 'rev', { params: {}, labels: {}, deleted: [] });
    expect('deletedNodeIds' in sent()).toBe(false);
    await saveProject('alpha', { nodes: [], edges: [] } as never, 'rev');
    expect('deletedNodeIds' in sent()).toBe(false);
  });
});

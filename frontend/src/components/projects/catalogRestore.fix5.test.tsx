/**
 * Fix round 5 of PR #199 (GM r7 and round 5's answers, review 5's nits,
 * 2026-10-28): the restore notice is one outcome per line from the first
 * render; the Undo toast leaves on its own time as the app's other toasts
 * do. (Restore disabled at the project limit is gone: a restore may pass
 * it, Justin 2026-10-29, fix round 12.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary, type TrashedProject } from './ProjectHome';
import {
  canvasHeldLogLine, canvasHoldRefusedLogLine, catalogRestoreNotice,
} from './catalogRestoreCopy';
import type { CatalogRestore } from '../../lib/projects';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const NOW = Date.parse('2026-10-28T12:00:00Z');
const OPEN = "Nebula’s project list was damaged, so it restored the last good copy";
const KEPT = 'The damaged file was kept.';
const NOT_WHOLE = "Nebula couldn’t read the whole damaged file, so changes made after that copy may be missing.";
const ALPHA = 'a'.repeat(32);
const LOGO = 'l'.repeat(32);
const DUNES = 'd'.repeat(32);

const restore = (overrides: Partial<CatalogRestore> = {}): CatalogRestore => ({
  id: 'r'.repeat(32), at: '2026-10-28T10:15:00+00:00', kind: 'restored', source: 'catalog.json.bak',
  damagedFile: '/x/catalog.json.damaged-20261028T101500Z-1a2b3c4d', damagedReadWhole: true,
  addedBack: [], addedBackCount: 0, notAddedBackCount: 0, ...overrides,
});
const project = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', lastOpenedAt: null,
  nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const trashed = (id: string, name: string): TrashedProject => ({
  ...project(id, name), deletedAt: '2026-10-27T10:00:00Z', purgeAt: '2026-11-26T10:00:00Z',
});
const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [project(LOGO, 'Logo')], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});
const openTrash = () => fireEvent.click(screen.getByRole('button', { name: /Recently deleted/ }));

describe('Restore is never greyed by the project limit (Justin, 2026-10-29)', () => {
  it('stays enabled with the list full and restores, with no limit tooltip', () => {
    const onRestore = vi.fn();
    render(<ProjectHome {...props({ projects: [project(LOGO, 'Logo'), project(DUNES, 'Dunes')],
      trash: [trashed(ALPHA, 'Alpha')], onRestore })} />);
    openTrash();
    const button = screen.getByRole('button', { name: 'Restore Alpha' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(button.getAttribute('title')).toBeNull();
    expect(button.className).not.toContain('at-limit');
    fireEvent.click(button);
    expect(onRestore).toHaveBeenCalledWith(ALPHA);
  });
});

describe('GM round 5, 3: the restore notice is stacked from the first render', () => {
  it('stacks the opening, the not-read-whole line and the kept line on first load', () => {
    const notice = catalogRestoreNotice(restore({ damagedReadWhole: false }), NOW, { projects: [], trash: [] });
    expect(notice.lines).toEqual([`${OPEN}.`, NOT_WHOLE, KEPT]);
  });

  it('stacks a notice with one outcome too', () => {
    const notice = catalogRestoreNotice(restore({ addedBack: [{ id: DUNES, name: 'Dunes' }], addedBackCount: 1 }),
      NOW, { projects: [project(DUNES, 'Dunes')], trash: [] });
    expect(notice.lines).not.toBeNull();
    expect(notice.lines?.join(' ')).toBe(notice.text);
  });

  it('renders one paragraph per line on the Projects home on first load', () => {
    render(<ProjectHome {...props({ catalogRestore: restore({ damagedReadWhole: false }) })} />);
    const lines = document.querySelectorAll('.project-home__restore-lines > p');
    expect([...lines].map((line) => line.textContent)).toEqual([`${OPEN}.`, NOT_WHOLE, KEPT]);
  });
});

describe('review 5, N-2: the Undo toast times out like the app\'s other toasts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('leaves after its time, and holds while the person points at it', () => {
    const onDismiss = vi.fn();
    render(<ProjectHome {...props({ lastDeleted: { id: ALPHA, name: 'Alpha' }, onDismissUndo: onDismiss })} />);
    const toast = screen.getByRole('button', { name: 'Undo' }).closest('.project-home__toast') as HTMLElement;
    fireEvent.mouseEnter(toast);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    act(() => { vi.advanceTimersByTime(8000); });
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('GM held model: the Agent log lines', () => {
  it('words a hold an agent caused, named and unnamed', () => {
    expect(canvasHeldLogLine('Codex', 'cleared'))
      .toBe('Codex cleared the canvas. The one you had open is kept until Nebula can save it as a project.');
    expect(canvasHeldLogLine(null, 'replaced'))
      .toBe('An agent replaced the canvas. The one you had open is kept until Nebula can save it as a project.');
  });

  it('words a refused clear or replace at the limit', () => {
    expect(canvasHoldRefusedLogLine('Codex', 'clear'))
      .toBe("Codex tried to clear the canvas you had open. Nebula stopped it because that canvas isn’t saved as a project yet.");
    expect(canvasHoldRefusedLogLine(null, 'replace'))
      .toBe("An agent tried to replace the canvas you had open. Nebula stopped it because that canvas isn’t saved as a project yet.");
  });
});

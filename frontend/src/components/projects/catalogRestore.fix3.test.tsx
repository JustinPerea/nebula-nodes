/**
 * Fix round 3 of PR #199 (GM - Design r4 and r5, 2026-10-27; review 3's
 * M-B and L-5): the notice says only lines that are still true, against
 * the projects and Recently deleted as they are now; "Open Recently
 * deleted" only while Recently deleted holds one of its items; the limit
 * lines; the waiting line on the Projects home; the saved toast.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary, type TrashedProject } from './ProjectHome';
import {
  canvasLimitLine, canvasSavedToast, canvasWaitingLine, catalogRestoreNotice, OPEN_RECENTLY_DELETED,
} from './catalogRestoreCopy';
import type { CatalogRestore } from '../../lib/projects';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const NOW = Date.parse('2026-10-27T12:00:00Z');
const OPEN = "Nebula’s project list was damaged, so it restored the last good copy";
const KEPT = 'The damaged file was kept.';
const NOT_WHOLE = "Nebula couldn’t read the whole damaged file, so changes made after that copy may be missing.";
const HERO = 'h'.repeat(32);
const DUNES = 'd'.repeat(32);
const LOGO = 'l'.repeat(32);
const SCRATCH = 's'.repeat(32);

const restore = (overrides: Partial<CatalogRestore> = {}): CatalogRestore => ({
  id: 'r'.repeat(32), at: '2026-10-27T10:15:00+00:00', kind: 'restored', source: 'catalog.json.bak',
  damagedFile: '/x/catalog.json.damaged-20261027T101500Z-1a2b3c4d', damagedReadWhole: true,
  addedBack: [], addedBackCount: 0, notAddedBackCount: 0, ...overrides,
});
const project = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', lastOpenedAt: null,
  nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const trashed = (id: string, name: string): TrashedProject => ({
  ...project(id, name), deletedAt: '2026-10-26T10:00:00Z', purgeAt: '2026-11-25T10:00:00Z',
});
const now = (projects: ProjectSummary[], trash: TrashedProject[], canvasNotFiled: { reason: 'projects' | 'storage'; projectLimit?: number } | null = null) =>
  ({ projects, trash, canvasNotFiled });

// The review's S1: Hero added back into Recently deleted, plus a reverted Logo (not read whole).
const s1 = restore({
  addedBack: [{ id: HERO, name: 'Hero', trashed: true }], addedBackCount: 1,
  reverted: [{ id: LOGO, name: 'Logo' }], revertedCount: 1, damagedReadWhole: false,
});
const heroLine = '“Hero”, a newer project it found, is in Recently deleted. Restore it from there to keep it.';
const logoLine = '“Logo” went back to its version in that copy, so its latest edits aren’t there.';

describe('GM r4: the notice only shows lines that are still true', () => {
  it('says Hero is in Recently deleted only while it is there', () => {
    const before = catalogRestoreNotice(s1, NOW, now([project(LOGO, 'Logo')], [trashed(HERO, 'Hero')]));
    expect(before.lines).toContain(heroLine);
    expect(before.openRecentlyDeleted).toBe(true);
    expect(before.recentlyDeletedIds).toEqual([HERO]);
    const after = catalogRestoreNotice(s1, NOW, now([project(LOGO, 'Logo'), project(HERO, 'Hero')], []));
    expect(after.text).not.toContain('Hero');
    expect(after.openRecentlyDeleted).toBe(false);
  });

  it('hides "Open Recently deleted" when something else is all Recently deleted holds', () => {
    const after = catalogRestoreNotice(s1, NOW, now([project(LOGO, 'Logo'), project(HERO, 'Hero')], [trashed(DUNES, 'Dunes')]));
    expect(after.openRecentlyDeleted).toBe(false);
    expect(after.recentlyDeletedIds).toEqual([]);
  });

  it('drops each kind of line once it no longer holds', () => {
    const record = restore({
      source: 'catalog.json.bak.1', copyAt: '2026-10-25T11:00:00+00:00', damagedReadWhole: true,
      cameBack: [{ id: DUNES, name: 'Dunes', how: 'trashed' }], cameBackCount: 1,
      backInTrash: [{ id: HERO, name: 'Hero' }], backInTrashCount: 1,
      notAddedBack: [{ id: SCRATCH, name: 'Scratch', reason: 'incomplete' }], notAddedBackCount: 1,
    });
    const all = catalogRestoreNotice(record, NOW, now([project(DUNES, 'Dunes')], [trashed(HERO, 'Hero')]));
    expect(all.lines).toEqual([
      `${OPEN} from 2 days ago.`,
      '“Scratch”, a newer project, couldn’t be added back.',
      '“Dunes” was deleted, but the copy still had it, so it’s back. Delete it again if you don’t need it.',
      '“Hero” is in Recently deleted again because the copy had it there. Restore it again if you need it.',
      KEPT,
    ]);
    // The person deletes Dunes again and restores Hero; Scratch turns up (an agent's recover).
    const none = catalogRestoreNotice(record, NOW, now([project(HERO, 'Hero'), project(SCRATCH, 'Scratch')], [trashed(DUNES, 'Dunes')]));
    expect(none.text).toBe(`${OPEN} from 2 days ago. ${KEPT}`);
    // Stacked at first, so it stays one line per outcome (GM r6, bug 1).
    expect(none.lines).toEqual([`${OPEN} from 2 days ago.`, KEPT]);
  });

  it('keeps the opening and "The damaged file was kept." when every outcome has gone', () => {
    const after = catalogRestoreNotice(s1, NOW, now([project(HERO, 'Hero')], []));
    expect(after.text).toBe(`${OPEN}. ${NOT_WHOLE} ${KEPT}`);
    const whole = catalogRestoreNotice({ ...s1, damagedReadWhole: true }, NOW, now([project(HERO, 'Hero')], []));
    expect(whole.text).toBe(`${OPEN}. ${KEPT}`);
  });

  it('names the saved canvas by its name now, and drops it once it is gone', () => {
    const record = restore({ recoveredCanvas: { id: SCRATCH, name: 'Scratch (recovered)' } });
    expect(catalogRestoreNotice(record, NOW, now([project(SCRATCH, 'My scratch')], [])).text)
      .toContain('saved as its own project, “My scratch”, so nothing in it is lost.');
    expect(catalogRestoreNotice(record, NOW, now([], [])).text).toBe(`${OPEN}. ${KEPT}`);
  });

  it('says counts past the named rows as recorded, less the rows that went', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ id: index.toString(16).padStart(32, '0'), name: `P${index}` }));
    const record = restore({ reverted: many, revertedCount: 140 });
    const list = many.slice(1).map((row) => project(row.id, row.name));
    expect(catalogRestoreNotice(record, NOW, now(list, [])).text)
      .toContain('139 projects went back to their versions in that copy');
  });
});

describe('GM r5: the limit lines, in the canvas line\'s place', () => {
  it('words the project limit with the number', () => {
    expect(canvasLimitLine('projects', { projectLimit: 500, trashHasItems: false }))
      .toBe("The canvas you had open couldn’t be saved as its own project because you’ve reached the limit of 500 projects. Nothing in it is lost. Delete a project and Nebula will save it.");
  });

  it('words the size cap by whether Recently deleted has items', () => {
    expect(canvasLimitLine('storage', { projectLimit: 500, trashHasItems: true }))
      .toBe("The canvas you had open couldn’t be saved as its own project because Nebula’s project list is full. Nothing in it is lost. Permanently delete a project in Recently deleted and Nebula will save it.");
    expect(canvasLimitLine('storage', { projectLimit: 500, trashHasItems: false }))
      .toBe("The canvas you had open couldn’t be saved as its own project because Nebula’s project list is full. Nothing in it is lost. Delete a project, then remove it from Recently deleted too, and Nebula will save it.");
  });

  it('sits after the reverted line and before the not-read-whole line, and only while the canvas waits', () => {
    const record = restore({ ...s1, addedBack: [], addedBackCount: 0, canvasNotFiled: { reason: 'storage' } });
    const waiting = catalogRestoreNotice(record, NOW, now([project(LOGO, 'Logo')], [trashed(DUNES, 'Dunes')], { reason: 'storage', projectLimit: 500 }));
    expect(waiting.lines).toEqual([`${OPEN}.`, logoLine, canvasLimitLine('storage', { projectLimit: 500, trashHasItems: true }), NOT_WHOLE, KEPT]);
    expect(waiting.openRecentlyDeleted).toBe(true);
    const filed = catalogRestoreNotice(record, NOW, now([project(LOGO, 'Logo')], [trashed(DUNES, 'Dunes')]));
    expect(filed.text).not.toContain('couldn’t be saved');
  });

  it('never says "128 MB" or "storage"', () => {
    for (const trashHasItems of [true, false]) {
      expect(canvasLimitLine('storage', { projectLimit: 500, trashHasItems })).not.toMatch(/MB|storage/);
      expect(canvasWaitingLine('storage', { projectLimit: 500, trashHasItems })).not.toMatch(/MB|storage/);
    }
  });
});

describe('GM r5: the waiting line and the saved toast', () => {
  it('words the waiting line for each limit', () => {
    expect(canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: true }))
      .toBe("The canvas you had open isn’t saved as a project yet because you’ve reached the limit of 500 projects. Nothing in it is lost. Delete a project and Nebula will save it.");
    expect(canvasWaitingLine('storage', { projectLimit: 500, trashHasItems: true }))
      .toBe("The canvas you had open isn’t saved as a project yet because Nebula’s project list is full. Nothing in it is lost. Permanently delete a project in Recently deleted and Nebula will save it.");
    expect(canvasWaitingLine('storage', { projectLimit: 500, trashHasItems: false }))
      .toBe("The canvas you had open isn’t saved as a project yet because Nebula’s project list is full. Nothing in it is lost. Delete a project, then remove it from Recently deleted too, and Nebula will save it.");
  });

  it('says the saved project by its real name, without "nothing in it is lost"', () => {
    expect(canvasSavedToast('Recovered canvas 2'))
      .toBe('The canvas you had open was saved as its own project, “Recovered canvas 2”.');
  });
});

const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [project(LOGO, 'Logo')], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});

describe('the Projects home', () => {
  it('drops Hero\'s line and the button when Hero is restored, live', () => {
    const { rerender } = render(<ProjectHome {...props({ catalogRestore: s1, trash: [trashed(HERO, 'Hero')] })} />);
    expect(screen.getByText(heroLine)).toBeTruthy();
    expect(screen.getByRole('button', { name: OPEN_RECENTLY_DELETED })).toBeTruthy();
    rerender(<ProjectHome {...props({ catalogRestore: s1, projects: [project(LOGO, 'Logo'), project(HERO, 'Hero')], trash: [trashed(DUNES, 'Dunes')] })} />);
    expect(screen.queryByText(heroLine)).toBeNull();
    expect(screen.queryByRole('button', { name: OPEN_RECENTLY_DELETED })).toBeNull();
  });

  it('opens Recently deleted to the notice\'s items', () => {
    render(<ProjectHome {...props({ catalogRestore: s1, trash: [trashed(DUNES, 'Dunes'), trashed(HERO, 'Hero')] })} />);
    fireEvent.click(screen.getByRole('button', { name: OPEN_RECENTLY_DELETED }));
    const row = screen.getByRole('listitem', { name: 'Hero' });
    expect(row.getAttribute('data-from-notice')).toBe('true');
    expect(screen.getByRole('listitem', { name: 'Dunes' }).getAttribute('data-from-notice')).toBeNull();
  });

  it('shows the waiting line while the canvas waits, with no Dismiss, and drops it once saved', () => {
    const waiting = { reason: 'storage' as const, projectLimit: 500 };
    const { rerender } = render(<ProjectHome {...props({ canvasNotFiled: waiting, trash: [trashed(DUNES, 'Dunes')] })} />);
    const line = screen.getByText(canvasWaitingLine('storage', { projectLimit: 500, trashHasItems: true }));
    const notice = line.closest('.project-home__waiting') as HTMLElement;
    expect(notice).toBeTruthy();
    expect(notice.querySelector('[aria-label="Dismiss"]')).toBeNull();
    expect(screen.getByRole('button', { name: OPEN_RECENTLY_DELETED })).toBeTruthy();
    rerender(<ProjectHome {...props({ canvasNotFiled: null, trash: [trashed(DUNES, 'Dunes')] })} />);
    expect(document.querySelector('.project-home__waiting')).toBeNull();
  });

  it('has no Open Recently deleted on the project-limit waiting line', () => {
    render(<ProjectHome {...props({ canvasNotFiled: { reason: 'projects', projectLimit: 500 }, trash: [trashed(DUNES, 'Dunes')] })} />);
    expect(screen.getByText(canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: true }))).toBeTruthy();
    expect(screen.queryByRole('button', { name: OPEN_RECENTLY_DELETED })).toBeNull();
  });

  it('says the limit in the restore notice, not twice', () => {
    const record = restore({ canvasNotFiled: { reason: 'projects' } });
    render(<ProjectHome {...props({ catalogRestore: record, canvasNotFiled: { reason: 'projects', projectLimit: 500 } })} />);
    expect(screen.getAllByText(/you’ve reached the limit of 500 projects/)).toHaveLength(1);
  });
});

describe('the saved toast on the Projects home', () => {
  it('names the project the waiting canvas was saved as', () => {
    const onDismiss = vi.fn();
    render(<ProjectHome {...props({ canvasSaved: { id: SCRATCH, name: 'Recovered canvas' }, onDismissCanvasSaved: onDismiss })} />);
    expect(screen.getByText('The canvas you had open was saved as its own project, “Recovered canvas”.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' }).at(-1)!);
    expect(onDismiss).toHaveBeenCalled();
  });
});

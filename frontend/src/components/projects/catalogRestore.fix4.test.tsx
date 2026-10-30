/**
 * Fix round 4 of PR #199 (GM - Design r6, 2026-10-27; review 4's M-1 and
 * L-1): "Nothing in it is lost." in every limit and waiting form, never
 * "It stays open"; one outcome per line however many remain; 6px between
 * the lines; no ring on a focus target the page moves focus to (tabindex
 * -1), never focus moved on load. (Undo refused past the limit is gone:
 * a restore may pass the project limit, Justin 2026-10-29, fix round 12.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary, type TrashedProject } from './ProjectHome';
import {
  canvasLimitLine, canvasWaitingLine, catalogRestoreNotice,
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
const ALPHA = 'a'.repeat(32);

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
const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
  projects: [project(LOGO, 'Logo')], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
});

describe('GM r6: "Nothing in it is lost." in every limit and waiting form', () => {
  it('words the three restore limit forms', () => {
    expect(canvasLimitLine('projects', { projectLimit: 500, trashHasItems: false }))
      .toBe("The canvas you had open couldn’t be saved as its own project because you’ve reached the limit of 500 projects. Nothing in it is lost. Delete a project and Nebula will save it.");
    expect(canvasLimitLine('storage', { projectLimit: 500, trashHasItems: true }))
      .toBe("The canvas you had open couldn’t be saved as its own project because Nebula’s project list is full. Nothing in it is lost. Permanently delete a project in Recently deleted and Nebula will save it.");
    expect(canvasLimitLine('storage', { projectLimit: 500, trashHasItems: false }))
      .toBe("The canvas you had open couldn’t be saved as its own project because Nebula’s project list is full. Nothing in it is lost. Delete a project, then remove it from Recently deleted too, and Nebula will save it.");
  });

  it('words the three waiting forms', () => {
    expect(canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: true }))
      .toBe("The canvas you had open isn’t saved as a project yet because you’ve reached the limit of 500 projects. Nothing in it is lost. Delete a project and Nebula will save it.");
    expect(canvasWaitingLine('storage', { projectLimit: 500, trashHasItems: true }))
      .toBe("The canvas you had open isn’t saved as a project yet because Nebula’s project list is full. Nothing in it is lost. Permanently delete a project in Recently deleted and Nebula will save it.");
    expect(canvasWaitingLine('storage', { projectLimit: 500, trashHasItems: false }))
      .toBe("The canvas you had open isn’t saved as a project yet because Nebula’s project list is full. Nothing in it is lost. Delete a project, then remove it from Recently deleted too, and Nebula will save it.");
  });

  it('never says the canvas stays open, and has no Open canvas button', () => {
    for (const reason of ['projects', 'storage'] as const) {
      for (const trashHasItems of [true, false]) {
        expect(canvasLimitLine(reason, { projectLimit: 3, trashHasItems })).not.toMatch(/stays open/i);
      }
    }
    render(<ProjectHome {...props({ catalogRestore: restore({ canvasNotFiled: { reason: 'projects' } }),
      canvasNotFiled: { reason: 'projects', projectLimit: 3 } })} />);
    expect(screen.queryByRole('button', { name: /open canvas/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/stays open/i);
  });
});

describe('GM r6 bug 1: one outcome per line, however many remain', () => {
  const s1 = restore({
    addedBack: [{ id: HERO, name: 'Hero', trashed: true }], addedBackCount: 1, damagedReadWhole: false,
  });

  it('stays stacked after a line drops (KEY-line-gone)', () => {
    const before = catalogRestoreNotice(s1, NOW, now([project(LOGO, 'Logo')], [trashed(HERO, 'Hero')]));
    expect(before.lines).toHaveLength(4);
    const after = catalogRestoreNotice(s1, NOW, now([project(LOGO, 'Logo'), project(HERO, 'Hero')], []));
    expect(after.lines).toEqual([`${OPEN}.`, NOT_WHOLE, KEPT]);
  });

  it('stays stacked when every outcome has gone', () => {
    const record = restore({
      source: 'catalog.json.bak.1', copyAt: '2026-10-25T11:00:00+00:00',
      cameBack: [{ id: DUNES, name: 'Dunes', how: 'trashed' }], cameBackCount: 1,
      backInTrash: [{ id: HERO, name: 'Hero' }], backInTrashCount: 1,
    });
    const none = catalogRestoreNotice(record, NOW, now([project(HERO, 'Hero')], [trashed(DUNES, 'Dunes')]));
    expect(none.lines).toEqual([`${OPEN} from 2 days ago.`]);
  });

  it('stays stacked when the limit line drops once the canvas is saved', () => {
    const record = restore({ canvasNotFiled: { reason: 'projects' }, damagedReadWhole: false });
    const waiting = catalogRestoreNotice(record, NOW, now([], [], { reason: 'projects', projectLimit: 3 }));
    expect(waiting.lines).toHaveLength(4);
    const filed = catalogRestoreNotice(record, NOW, now([], []));
    expect(filed.lines).toEqual([`${OPEN}.`, NOT_WHOLE, KEPT]);
  });

  it('stays stacked in the rebuilt notice', () => {
    const record = restore({ kind: 'rebuilt', source: null, notAddedBack: [{ id: HERO, name: 'Hero', reason: 'incomplete' }],
      notAddedBackCount: 1, canvasNotFiled: { reason: 'projects' } });
    const filed = catalogRestoreNotice(record, NOW, now([], []));
    expect(filed.lines).not.toBeNull();
    expect(filed.lines?.length).toBe(3);
  });

  it('renders one paragraph per remaining line on the Projects home', () => {
    render(<ProjectHome {...props({ catalogRestore: s1, projects: [project(LOGO, 'Logo'), project(HERO, 'Hero')] })} />);
    const lines = document.querySelectorAll('.project-home__restore-lines > p');
    expect([...lines].map((line) => line.textContent)).toEqual([`${OPEN}.`, NOT_WHOLE, KEPT]);
  });

  // GM round 5 (fix round 5 of PR #199): stacked from the first render,
  // so a notice that was short at first is stacked too (it was one line).
  it('stacks a notice that was short at first too (GM round 5)', () => {
    const single = catalogRestoreNotice(restore(), NOW, now([project(LOGO, 'Logo')], []));
    expect(single.lines).toEqual([`${OPEN}.`, 'No projects were missing.']);
  });
});

const css = readFileSync(join(__dirname, '..', '..', 'styles', 'project-home.css'), 'utf8');

describe('GM r6 bug 2: 6px between the lines, the line height within one stays', () => {
  it('spaces the stacked lines 6px apart', () => {
    expect(css).toMatch(/\.project-home__restore-lines\s*\{[^}]*gap:\s*6px/);
    expect(css).toMatch(/\.project-home__notice\s*\{[^}]*line-height:\s*1\.5/);
  });
});

// GM r6 bug 4 ("never a ring, keyboard or not") is superseded by main's
// notice-stack rule (PR #200, GM pr200 r16 #2 and r17): a target the page
// moves focus to rings from :focus-visible only, so a notice closed from the
// keyboard rings what takes focus next and one closed with a click rings
// nothing; with no notice left, "Recent projects" takes it.
describe('a focus target the page moves focus to rings from the keyboard only (PR #200 GM r17)', () => {
  it('rings "Recent projects" and the notices from :focus-visible, never from :focus', () => {
    expect(css).toMatch(/\.project-home #recent-projects-title:focus-visible\s*\{[^}]*outline:\s*var\(--sr-focus-outline\)/);
    expect(css).not.toMatch(/\[tabindex="-1"\]:focus\s*[,{][^}]*outline:\s*var\(--sr-focus-outline\)/);
  });

  it('moves focus to "Recent projects" after a dismiss', () => {
    // Review 13 of PR #199 (MEDIUM-1): the stack's rule, once the notice goes.
    const view = render(<ProjectHome {...props({ catalogRestore: restore() })} />);
    const close = screen.getAllByRole('button', { name: 'Dismiss' })[0];
    close.focus();
    fireEvent.click(close);
    view.rerender(<ProjectHome {...props({ catalogRestore: null })} />);
    expect(document.activeElement?.id).toBe('recent-projects-title');
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('moves focus nowhere on load, with every notice showing', () => {
    render(<ProjectHome {...props({ catalogRestore: restore({ canvasNotFiled: { reason: 'storage' } }),
      canvasNotFiled: { reason: 'storage', projectLimit: 500 }, trash: [trashed(DUNES, 'Dunes')],
      canvasSaved: { id: HERO, name: 'Recovered canvas' }, lastDeleted: { id: ALPHA, name: 'Alpha' } })} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Undo of a delete may pass the project limit (Justin, 2026-10-29)', () => {
  it('says Undo asked when the toast\'s button restores', () => {
    const onRestore = vi.fn();
    render(<ProjectHome {...props({ lastDeleted: { id: ALPHA, name: 'Alpha' }, onRestore })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onRestore).toHaveBeenCalledWith(ALPHA, 'undo');
  });

  it('keeps the Undo toast whole: no refusal line takes its place', () => {
    render(<ProjectHome {...props({ lastDeleted: { id: ALPHA, name: 'Alpha' } })} />);
    expect(screen.getByText(/Moved “Alpha” to Recently deleted/).closest('.project-home__toast')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.queryByText(/Couldn’t restore/)).toBeNull();
  });
});

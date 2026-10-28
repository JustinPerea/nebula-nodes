/**
 * Fix round 2 of PR #199 (GM - Design r3, 2026-10-27; review 2's L6): the
 * B layout (an opening line, one outcome per line, "The damaged file was
 * kept." last), the open canvas's sentence and its "(recovered)" name, no
 * comma before the age, GM's age scale, the not-read-whole sentence, the
 * rebuild's Agent log line, and "Open Recently deleted" that never outlives
 * its use or moves focus for an agent.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import { catalogRestoreLine, catalogRestoreLogLine, catalogRestoreNotice, copyAge, OPEN_RECENTLY_DELETED, recoveredCanvasSentence } from './catalogRestoreCopy';
import type { CatalogRestore, TrashedProject } from '../../lib/projects';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const DAMAGED = '/Users/someone/.nebula/projects/catalog.json.damaged-20261027T101500Z-1a2b3c4d';
const NOW = Date.parse('2026-10-27T12:00:00Z');
const TWO_DAYS_AGO = '2026-10-25T11:00:00+00:00';
const OPEN = "Nebula's project list was damaged, so it restored the last good copy";
const KEPT = 'The damaged file was kept.';

const restore = (overrides: Partial<CatalogRestore> = {}): CatalogRestore => ({
  id: 'r'.repeat(32), at: '2026-10-27T10:15:00+00:00', kind: 'restored', source: 'catalog.json.bak',
  damagedFile: DAMAGED, damagedReadWhole: true, addedBack: [], addedBackCount: 0, notAddedBackCount: 0, ...overrides,
});
const rows = (...names: string[]) => names.map((name, index) => ({ id: String(index).repeat(32), name }));
const trashedRows = (...names: string[]) => rows(...names).map((row) => ({ ...row, trashed: true }));
const older = { source: 'catalog.json.bak.1', copyAt: TWO_DAYS_AGO };
const line = (overrides: Partial<CatalogRestore>) => catalogRestoreLine(restore(overrides), NOW);

describe('GM r3 string 1: the open canvas, saved as its own project', () => {
  it('names the project it was, and "Recovered canvas" when that is unknown', () => {
    expect(recoveredCanvasSentence('Alpha (recovered)'))
      .toBe('The canvas you had open was saved as its own project, “Alpha (recovered)”, so nothing in it is lost.');
    expect(recoveredCanvasSentence('Alpha (recovered 2)'))
      .toBe('The canvas you had open was saved as its own project, “Alpha (recovered 2)”, so nothing in it is lost.');
    expect(recoveredCanvasSentence(null))
      .toBe('The canvas you had open was saved as its own project, “Recovered canvas”, so nothing in it is lost.');
  });

  it('is one sentence, the same whether the copy was older, the project missing or unproven', () => {
    expect(line({ recoveredCanvas: { id: 'c'.repeat(32), name: 'Alpha (recovered)' } }))
      .toBe(`${OPEN}. The canvas you had open was saved as its own project, “Alpha (recovered)”, so nothing in it is lost. ${KEPT}`);
  });
});

describe('GM r3: the open project that couldn\'t be added back, saved from its canvas', () => {
  // The live check's B: the canvas sentence is the one sentence for that
  // project (GM: one sentence for "couldn't restore"); its failed add-back
  // isn't said again beside "so nothing in it is lost".
  const canvas = { recoveredCanvas: { id: 'c'.repeat(32), name: 'Scratch (recovered)' }, openProjectMissing: 's'.repeat(32) };
  const scratch = { id: 's'.repeat(32), name: 'Scratch', reason: 'incomplete' };

  it('says only the canvas sentence for it', () => {
    expect(line({ ...canvas, notAddedBack: [scratch], notAddedBackCount: 1 }))
      .toBe(`${OPEN}. The canvas you had open was saved as its own project, “Scratch (recovered)”, so nothing in it is lost. ${KEPT}`);
  });

  it('still names the other projects that couldn\'t be added back', () => {
    const other = { id: 'h'.repeat(32), name: 'Hero', reason: 'incomplete' };
    expect(line({ ...canvas, notAddedBack: [scratch, other], notAddedBackCount: 2 }))
      .toBe(`${OPEN}. “Hero”, a newer project, couldn't be added back. The canvas you had open was saved as its own project, “Scratch (recovered)”, so nothing in it is lost. ${KEPT}`);
  });

  it('keeps the failed line when the canvas wasn\'t saved', () => {
    expect(line({ openProjectMissing: 's'.repeat(32), notAddedBack: [scratch], notAddedBackCount: 1 }))
      .toContain('“Scratch”, a newer project, couldn\'t be added back.');
  });
});

describe('GM r3 strings 2 and 3: the age, with no comma before it', () => {
  it('has no comma before the age in any form', () => {
    expect(line({ ...older })).toBe(`${OPEN} from 2 days ago. No projects were missing.`);
    expect(line({ ...older, cameBack: rows('Draft'), cameBackCount: 1, addedBack: rows('X'), addedBackCount: 1 }))
      .toContain(`${OPEN} from 2 days ago and added back “X”, a newer project it found.`);
  });

  it('follows the scale, with dates as the home cards write them', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const hour = 3_600_000;
    expect(copyAge(at(30_000), NOW)).toBe('less than an hour ago');
    expect(copyAge(at(59 * 60_000), NOW)).toBe('less than an hour ago');
    expect(copyAge(at(hour), NOW)).toBe('an hour ago');
    expect(copyAge(at(5 * hour), NOW)).toBe('5 hours ago');
    expect(copyAge(at(23 * hour), NOW)).toBe('23 hours ago');
    expect(copyAge(at(24 * hour), NOW)).toBe('a day ago');
    expect(copyAge(at(47 * hour), NOW)).toBe('a day ago');
    expect(copyAge(at(48 * hour), NOW)).toBe('2 days ago');
    expect(copyAge(at(6 * 24 * hour), NOW)).toBe('6 days ago');
    expect(copyAge(at(7 * 24 * hour), NOW)).toBe('a week ago');
    expect(copyAge(at(13 * 24 * hour), NOW)).toBe('a week ago');
    const card = (iso: string, withYear: boolean) => new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' as const } : {}),
    }).format(new Date(iso));
    expect(copyAge('2026-10-12T12:00:00Z', NOW)).toBe(card('2026-10-12T12:00:00Z', false));
    expect(copyAge('2025-10-12T12:00:00Z', NOW)).toBe(card('2025-10-12T12:00:00Z', true));
    expect(copyAge(null, NOW)).toBeNull();
    // Never "earlier today" or "over a week ago".
    expect([1, 3, 10, 20].map((days) => copyAge(at(days * 24 * hour), NOW)).join(' ')).not.toMatch(/earlier today|over a week/);
  });
});

describe('GM r3 string 4: a damaged file that was not read whole', () => {
  it('says so in place of "No projects were missing."', () => {
    expect(line({ damagedReadWhole: false }))
      .toBe(`${OPEN}. Nebula couldn't read the whole damaged file, so changes made after that copy may be missing. ${KEPT}`);
    expect(line({ damagedReadWhole: false, addedBack: rows('Dunes'), addedBackCount: 1 }))
      .toBe(`${OPEN} and added back “Dunes”, a newer project it found. Nebula couldn't read the whole damaged file, so changes made after that copy may be missing. ${KEPT}`);
  });
});

describe('GM r3: the B layout', () => {
  it('stacks one outcome per line after the opening, in order, with the kept line last', () => {
    const notice = catalogRestoreNotice(restore({
      ...older, addedBack: trashedRows('Newer'), addedBackCount: 1,
      reverted: rows('Logo'), revertedCount: 1, cameBack: rows('Draft'), cameBackCount: 1,
      backInTrash: rows('Revived'), backInTrashCount: 1, recoveredCanvas: { id: 'c'.repeat(32), name: 'Scratch (recovered)' },
    }), NOW);
    expect(notice.lines).toEqual([
      `${OPEN} from 2 days ago.`,
      '“Newer”, a newer project it found, is in Recently deleted. Restore it from there to keep it.',
      "“Logo” went back to its version in that copy, so its latest edits aren't there.",
      "“Draft” was deleted, but the copy still had it, so it's back. Delete it again if you don't need it.",
      '“Revived” is in Recently deleted again because the copy had it there. Restore it again if you need it.',
      'The canvas you had open was saved as its own project, “Scratch (recovered)”, so nothing in it is lost.',
      KEPT,
    ]);
    expect(notice.openRecentlyDeleted).toBe(true);
  });

  // GM round 5 (fix round 5 of PR #199): always stacked, one outcome per
  // line from the first render; GM r3's inline single outcome is retired.
  it('stacks a single outcome too (GM round 5; was inline, as in A)', () => {
    const notice = catalogRestoreNotice(restore({ ...older, reverted: rows('Logo'), revertedCount: 1 }), NOW);
    expect(notice.lines).toEqual([`${OPEN} from 2 days ago.`, "“Logo” went back to its version in that copy, so its latest edits aren't there.", KEPT]);
    expect(notice.text).toBe(`${OPEN} from 2 days ago. “Logo” went back to its version in that copy, so its latest edits aren't there. ${KEPT}`);
  });

  it('renders the lines stacked, without bullets, with the button beside them', () => {
    const trash: TrashedProject[] = [{
      id: '0'.repeat(32), name: 'Newer', createdAt: TWO_DAYS_AGO, updatedAt: TWO_DAYS_AGO, lastOpenedAt: TWO_DAYS_AGO,
      nodeCount: 0, edgeCount: 0, thumbnail: null, deletedAt: TWO_DAYS_AGO, purgeAt: '2026-11-24T11:00:00+00:00',
    } as TrashedProject];
    // Logo is in the list and Newer in Recently deleted (the notice says only what still holds: fix round 3).
    const logo = { id: 'l'.repeat(32), name: 'Logo', createdAt: TWO_DAYS_AGO, updatedAt: TWO_DAYS_AGO, lastOpenedAt: null,
      nodeCount: 0, edgeCount: 0, thumbnail: null };
    const { container } = render(<ProjectHome projects={[logo]} loading={false} busy={false} error={null} trash={trash}
      onCreate={vi.fn()} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRetry={vi.fn()}
      catalogRestore={restore({ ...older, addedBack: trashedRows('Newer'), addedBackCount: 1, reverted: [{ id: logo.id, name: 'Logo' }], revertedCount: 1 })} />);
    const lines = container.querySelector('.project-home__restore-lines');
    expect(lines?.tagName).not.toBe('UL');
    expect(Array.from(lines?.children ?? []).map((child) => child.textContent)).toEqual([
      `${OPEN} from 2 days ago.`,
      '“Newer”, a newer project it found, is in Recently deleted. Restore it from there to keep it.',
      "“Logo” went back to its version in that copy, so its latest edits aren't there.",
      KEPT,
    ]);
    expect(screen.getByRole('button', { name: OPEN_RECENTLY_DELETED })).toBeTruthy();
  });
});

describe('GM r3 string 5: the rebuild\'s Agent log line', () => {
  it('says what it recovered, what it could not, and where the file is', () => {
    const rebuilt = { kind: 'rebuilt' as const, source: null };
    expect(catalogRestoreLogLine(restore({ ...rebuilt, addedBack: rows('Hero study'), addedBackCount: 1 })))
      .toBe(`Rebuilt the project list from the damaged file. Recovered “Hero study”. The damaged file was kept at ${DAMAGED}.`);
    expect(catalogRestoreLogLine(restore({
      ...rebuilt, damagedReadWhole: false, addedBack: rows('A', 'B', 'C', 'D'), addedBackCount: 4,
      notAddedBack: [{ id: 'x'.repeat(32), reason: 'incomplete', name: 'Logo' }], notAddedBackCount: 1,
    }))).toBe(`Rebuilt the project list from the damaged file. Recovered 4 projects. Couldn't recover “Logo”. Couldn't read the whole file. The damaged file was kept at ${DAMAGED}.`);
  });
});

describe('review 2, L6: "Open Recently deleted"', () => {
  const trashed = (name: string, id: string): TrashedProject => ({
    id, name, createdAt: TWO_DAYS_AGO, updatedAt: TWO_DAYS_AGO, lastOpenedAt: TWO_DAYS_AGO,
    nodeCount: 0, edgeCount: 0, thumbnail: null, deletedAt: TWO_DAYS_AGO, purgeAt: '2026-11-24T11:00:00+00:00',
  } as TrashedProject);
  const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
    projects: [], loading: false, busy: false, error: null,
    onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(),
    catalogRestore: restore({ addedBack: trashedRows('Hero'), addedBackCount: 1 }), ...overrides,
  });

  it('hides the button once Recently deleted is empty', () => {
    const { rerender } = render(<ProjectHome {...props({ trash: [trashed('Hero', '0'.repeat(32))] })} />);
    expect(screen.getByRole('button', { name: OPEN_RECENTLY_DELETED })).toBeTruthy();
    rerender(<ProjectHome {...props({ trash: [] })} />);
    expect(screen.queryByRole('button', { name: OPEN_RECENTLY_DELETED })).toBeNull();
  });

  it('is used once: an agent deleting a project later never reopens the list or moves focus', () => {
    const { rerender } = render(<ProjectHome {...props({ trash: [trashed('Hero', '0'.repeat(32))] })} />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: OPEN_RECENTLY_DELETED })); });
    // The person restores Hero: the trash empties and the list goes.
    rerender(<ProjectHome {...props({ trash: [] })} />);
    const heading = document.getElementById('project-home-title');
    act(() => { heading?.focus(); });
    // An agent deletes Dunes: the list comes back.
    rerender(<ProjectHome {...props({ trash: [trashed('Dunes', 'd'.repeat(32))] })} />);
    expect(screen.getByRole('button', { name: /Recently deleted/, expanded: false })).toBeTruthy();
    expect(document.activeElement).toBe(heading);
  });
});

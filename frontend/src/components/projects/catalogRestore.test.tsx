/**
 * The Projects home notice after Nebula restored a damaged project list
 * (GM - Design on PR #199, rounds 1 and 2, 2026-10-27): every form word for
 * word, shown as a status notice until the person closes it with ×, never
 * the damaged file's path; announced (its region fills after it mounts),
 * and × leaves focus on the page heading.
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

const restore = (overrides: Partial<CatalogRestore> = {}): CatalogRestore => ({
  id: 'r'.repeat(32), at: '2026-10-27T10:15:00+00:00', kind: 'restored', source: 'catalog.json.bak',
  // Read to its end unless a test says otherwise: the forms below are GM's
  // for what the damaged file showed.
  damagedFile: DAMAGED, damagedReadWhole: true, addedBack: [], addedBackCount: 0, notAddedBackCount: 0, ...overrides,
});
const rows = (...names: string[]) => names.map((name, index) => ({ id: String(index).repeat(32), name }));
const trashedRows = (...names: string[]) => rows(...names).map((row) => ({ ...row, trashed: true }));
const failedRows = (...names: (string | null)[]) => names.map((name, index) => ({
  id: String(index).repeat(32), reason: 'incomplete', ...(name ? { name } : {}),
}));
const line = (overrides: Partial<CatalogRestore>) => catalogRestoreLine(restore(overrides), NOW);
const OPEN = "Nebula's project list was damaged, so it restored the last good copy";

describe('form 1: restored, with what was added back', () => {
  it('names one, two or three projects added back, and counts from four', () => {
    expect(line({ addedBack: rows('Dunes'), addedBackCount: 1 }))
      .toBe(`${OPEN} and added back “Dunes”, a newer project it found.`);
    expect(line({ addedBack: rows('Dunes', 'Glass'), addedBackCount: 2 }))
      .toBe(`${OPEN} and added back “Dunes” and “Glass”, newer projects it found.`);
    expect(line({ addedBack: rows('Dunes', 'Glass', 'Logo'), addedBackCount: 3 }))
      .toBe(`${OPEN} and added back “Dunes”, “Glass” and “Logo”, newer projects it found.`);
    expect(line({ addedBack: rows('A', 'B', 'C', 'D'), addedBackCount: 4 }))
      .toBe(`${OPEN} and added back 4 newer projects it found.`);
  });

  it('says no projects were missing only when there is nothing else to say', () => {
    expect(line({})).toBe(`${OPEN}. No projects were missing.`);
  });

  it('never says no projects were missing when the damaged file could not be read to its end', () => {
    // A cut or zeroed file (live check of fix round 1): what it held past the
    // damage is unknown, so something may be lost (GM r3 string 4).
    const notWhole = "Nebula couldn't read the whole damaged file, so changes made after that copy may be missing.";
    expect(line({ damagedReadWhole: false })).toBe(`${OPEN}. ${notWhole} The damaged file was kept.`);
    expect(line({ damagedReadWhole: undefined })).toBe(`${OPEN}. ${notWhole} The damaged file was kept.`);
    expect(line({ damagedReadWhole: false, source: 'catalog.json.bak.1', copyAt: TWO_DAYS_AGO }))
      .toBe(`${OPEN} from 2 days ago. ${notWhole} The damaged file was kept.`);
    expect(line({ damagedReadWhole: false, addedBack: rows('Dunes'), addedBackCount: 1 }))
      .toBe(`${OPEN} and added back “Dunes”, a newer project it found. ${notWhole} The damaged file was kept.`);
    // Nothing kept, nothing claimed.
    expect(line({ damagedReadWhole: false, damagedFile: null, setAside: [] })).toBe(`${OPEN}.`);
  });
});

describe('form 2 (round 1): add-backs that failed', () => {
  it('names what failed when all failed', () => {
    expect(line({ notAddedBack: failedRows('Hero study'), notAddedBackCount: 1 }))
      .toBe(`${OPEN}. “Hero study”, a newer project, couldn't be added back. The damaged file was kept.`);
    expect(line({ notAddedBack: failedRows('A', 'B'), notAddedBackCount: 2 }))
      .toBe(`${OPEN}. “A” and “B”, newer projects, couldn't be added back. The damaged file was kept.`);
    expect(line({ notAddedBack: failedRows('A', 'B', 'C', 'D'), notAddedBackCount: 4 }))
      .toBe(`${OPEN}. 4 newer projects couldn't be added back. The damaged file was kept.`);
  });

  it('counts even one to three when a name could not be read', () => {
    expect(line({ notAddedBack: failedRows(null, null), notAddedBackCount: 2 }))
      .toBe(`${OPEN}. 2 newer projects couldn't be added back. The damaged file was kept.`);
    expect(line({ notAddedBack: failedRows(null), notAddedBackCount: 1 }))
      .toBe(`${OPEN}. 1 newer project couldn't be added back. The damaged file was kept.`);
  });

  it('gives form 1, then what failed, when some were added back', () => {
    expect(line({ addedBack: rows('Logo'), addedBackCount: 1, notAddedBack: failedRows('Dunes'), notAddedBackCount: 1 }))
      .toBe(`${OPEN} and added back “Logo”, a newer project it found. “Dunes” couldn't be added back. The damaged file was kept.`);
  });

  it('only says the damaged file was kept when it was', () => {
    expect(line({ damagedFile: null, notAddedBack: failedRows('Dunes'), notAddedBackCount: 1 }))
      .toBe(`${OPEN}. “Dunes”, a newer project, couldn't be added back.`);
  });
});

describe('form 2 (round 2): added back into Recently deleted', () => {
  it('says where they are and offers to open it', () => {
    const one = catalogRestoreNotice(restore({ addedBack: trashedRows('Logo'), addedBackCount: 1 }), NOW);
    expect(one.text).toBe(`${OPEN}. “Logo”, a newer project it found, is in Recently deleted. Restore it from there to keep it.`);
    expect(one.openRecentlyDeleted).toBe(true);
    expect(line({ addedBack: trashedRows('Logo', 'Hero study'), addedBackCount: 2 }))
      .toBe(`${OPEN}. “Logo” and “Hero study”, newer projects it found, are in Recently deleted. Restore them from there to keep them.`);
    expect(line({ addedBack: trashedRows('A', 'B', 'C', 'D'), addedBackCount: 4 }))
      .toBe(`${OPEN}. 4 newer projects it found are in Recently deleted. Restore them from there to keep them.`);
  });

  it('keeps "added back" for projects really back on the grid', () => {
    expect(line({ addedBack: [...rows('Dunes'), ...trashedRows('Logo').map((row) => ({ ...row, id: 'l'.repeat(32) }))], addedBackCount: 2 }))
      .toBe(`${OPEN} and added back “Dunes”, a newer project it found. “Logo”, a newer project it found, is in Recently deleted. Restore it from there to keep it.`);
  });
});

describe('form 3: what an older copy decided', () => {
  const older = { source: 'catalog.json.bak.1', copyAt: TWO_DAYS_AGO };

  it('says the copy is older up front when its age is known', () => {
    expect(line({ ...older, reverted: rows('Logo'), revertedCount: 1 }))
      .toBe(`${OPEN} from 2 days ago. “Logo” went back to its version in that copy, so its latest edits aren't there. The damaged file was kept.`);
    expect(line({ ...older })).toBe(`${OPEN} from 2 days ago. No projects were missing.`);
    expect(line({ source: 'catalog.json.bak.1', copyAt: null, reverted: rows('Logo'), revertedCount: 1 }))
      .toBe(`${OPEN}. “Logo” went back to its version in that copy, so its latest edits aren't there. The damaged file was kept.`);
  });

  it('(a) reverted', () => {
    expect(line({ ...older, reverted: rows('Logo', 'Hero'), revertedCount: 2 }))
      .toBe(`${OPEN} from 2 days ago. “Logo” and “Hero” went back to their versions in that copy, so their latest edits aren't there. The damaged file was kept.`);
    expect(line({ ...older, reverted: rows('A', 'B', 'C', 'D'), revertedCount: 4 }))
      .toBe(`${OPEN} from 2 days ago. 4 projects went back to their versions in that copy, so their latest edits aren't there. The damaged file was kept.`);
  });

  it('(a) leaves out the open project whose graph came from the live canvas', () => {
    expect(line({ ...older, reverted: [{ ...rows('Logo')[0], liveCanvas: true }], revertedCount: 1 }))
      .toBe(`${OPEN} from 2 days ago. No projects were missing.`);
  });

  it('(b) back after it was deleted', () => {
    expect(line({ ...older, cameBack: rows('Draft'), cameBackCount: 1 }))
      .toBe(`${OPEN} from 2 days ago. “Draft” was deleted, but the copy still had it, so it's back. Delete it again if you don't need it.`);
    expect(line({ ...older, cameBack: rows('Draft', 'Old hero'), cameBackCount: 2 }))
      .toBe(`${OPEN} from 2 days ago. “Draft” and “Old hero” were deleted, but the copy still had them, so they're back. Delete them again if you don't need them.`);
    expect(line({ ...older, cameBack: rows('A', 'B', 'C', 'D'), cameBackCount: 4 }))
      .toBe(`${OPEN} from 2 days ago. 4 deleted projects are back because the copy still had them. Delete them again if you don't need them.`);
  });

  it('(c) back in Recently deleted, with the button', () => {
    const one = catalogRestoreNotice(restore({ ...older, backInTrash: rows('Logo'), backInTrashCount: 1 }), NOW);
    expect(one.text).toBe(`${OPEN} from 2 days ago. “Logo” is in Recently deleted again because the copy had it there. Restore it again if you need it.`);
    expect(one.openRecentlyDeleted).toBe(true);
    expect(line({ ...older, backInTrash: rows('Logo', 'Hero'), backInTrashCount: 2 }))
      .toBe(`${OPEN} from 2 days ago. “Logo” and “Hero” are in Recently deleted again because the copy had them there. Restore them again if you need them.`);
    expect(line({ ...older, backInTrash: rows('A', 'B', 'C', 'D'), backInTrashCount: 4 }))
      .toBe(`${OPEN} from 2 days ago. 4 projects are in Recently deleted again because the copy had them there. Restore them again if you need them.`);
  });

  it('gives one sentence per outcome, (a) then (b) then (c)', () => {
    expect(line({ ...older, reverted: rows('Logo'), revertedCount: 1, cameBack: rows('Draft'), cameBackCount: 1,
      backInTrash: rows('Hero'), backInTrashCount: 1 }))
      .toBe(`${OPEN} from 2 days ago. “Logo” went back to its version in that copy, so its latest edits aren't there. `
        + '“Draft” was deleted, but the copy still had it, so it\'s back. Delete it again if you don\'t need it. '
        + '“Hero” is in Recently deleted again because the copy had it there. Restore it again if you need it. The damaged file was kept.');
  });

  it('never says no projects were missing when the open canvas was filed as its own project', () => {
    expect(line({ ...older, recoveredCanvas: { id: 'c'.repeat(32), name: 'Recovered canvas' } }))
      .toBe(`${OPEN} from 2 days ago. ${recoveredCanvasSentence('Recovered canvas')} The damaged file was kept.`);
  });

  it('says the age on GM\'s scale (r3; the full scale is in catalogRestore.fix2.test.tsx)', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(copyAge(at(30_000), NOW)).toBe('less than an hour ago');
    expect(copyAge(at(3_600_000), NOW)).toBe('an hour ago');
    expect(copyAge(at(3 * 3_600_000), NOW)).toBe('3 hours ago');
    expect(copyAge(at(25 * 3_600_000), NOW)).toBe('a day ago');
    expect(copyAge(at(49 * 3_600_000), NOW)).toBe('2 days ago');
    expect(copyAge(null, NOW)).toBeNull();
  });
});

describe('form 4 (round 1): rebuilt, no good copy', () => {
  const rebuilt = { kind: 'rebuilt' as const, source: null };

  it('says when nothing was spotted missing', () => {
    expect(line({ ...rebuilt, addedBack: rows('Dunes'), addedBackCount: 1 }))
      .toBe("Nebula's project list was damaged and there was no good copy, so it recovered every project it could still read. "
        + "If a project you expect isn't here, it couldn't be recovered. The damaged file was kept.");
  });

  it('names up to three spotted missing, counts from four, and leaves Recently deleted out', () => {
    const start = "Nebula's project list was damaged and there was no good copy, so it recovered every project it could still read.";
    expect(line({ ...rebuilt, notAddedBack: failedRows('Hero study'), notAddedBackCount: 1 }))
      .toBe(`${start} “Hero study” couldn't be recovered, and others may be missing too. The damaged file was kept.`);
    expect(line({ ...rebuilt, notAddedBack: failedRows('A', 'B', 'C', 'D'), notAddedBackCount: 4 }))
      .toBe(`${start} 4 projects couldn't be recovered, and others may be missing too. The damaged file was kept.`);
    expect(line({ ...rebuilt, notAddedBack: [{ ...failedRows('Old')[0], trashed: true }], notAddedBackCount: 1 }))
      .toBe(`${start} If a project you expect isn't here, it couldn't be recovered. The damaged file was kept.`);
  });
});

describe('the Agent log line (round 2)', () => {
  it('is sentences with the path', () => {
    expect(catalogRestoreLogLine(restore({ addedBack: rows('Logo'), addedBackCount: 1 })))
      .toBe(`Restored the project list from catalog.json.bak. The damaged file was kept at ${DAMAGED}. Added back “Logo”.`);
    expect(catalogRestoreLogLine(restore({ addedBack: rows('A', 'B', 'C', 'D'), addedBackCount: 4 })))
      .toBe(`Restored the project list from catalog.json.bak. The damaged file was kept at ${DAMAGED}. Added back 4 projects.`);
    expect(catalogRestoreLogLine(restore({ notAddedBack: failedRows('Hero study'), notAddedBackCount: 1 })))
      .toBe(`Restored the project list from catalog.json.bak. The damaged file was kept at ${DAMAGED}. Couldn't add back “Hero study”.`);
    expect(catalogRestoreLogLine(restore({ addedBack: trashedRows('Logo'), addedBackCount: 1 })))
      .toBe(`Restored the project list from catalog.json.bak. The damaged file was kept at ${DAMAGED}. Put “Logo” in Recently deleted.`);
    expect(catalogRestoreLogLine(restore({ notAddedBack: failedRows(null, null), notAddedBackCount: 2 })))
      .toBe(`Restored the project list from catalog.json.bak. The damaged file was kept at ${DAMAGED}. Couldn't add back 2 projects.`);
  });
});

describe('the Projects home notice', () => {
  const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
    projects: [], loading: false, busy: false, error: null,
    onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
  });

  it('is a polite live notice that stays until the person closes it with ×, without the damaged path', () => {
    const onDismissCatalogRestore = vi.fn();
    // Dunes is in the list (the notice says only what still holds: fix round 3).
    const dunes = { id: '0'.repeat(32), name: 'Dunes', createdAt: TWO_DAYS_AGO, updatedAt: TWO_DAYS_AGO, lastOpenedAt: null,
      nodeCount: 0, edgeCount: 0, thumbnail: null };
    const { rerender } = render(<ProjectHome {...props({ projects: [dunes], catalogRestore: restore({ addedBack: rows('Dunes'), addedBackCount: 1 }), onDismissCatalogRestore })} />);
    const notice = screen.getByText(/project list was damaged/).closest('[aria-live="polite"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('added back “Dunes”, a newer project it found.');
    expect(notice?.textContent).not.toContain('catalog.json');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissCatalogRestore).toHaveBeenCalledTimes(1);
    rerender(<ProjectHome {...props({ catalogRestore: null, onDismissCatalogRestore })} />);
    expect(screen.queryByText(/project list was damaged/)).toBeNull();
  });

  it('fills a status region that was already there, so it is announced', () => {
    const { container, rerender } = render(<ProjectHome {...props({ catalogRestore: null })} />);
    const regions = () => Array.from(container.querySelectorAll('[aria-live="polite"]'));
    const before = regions();
    expect(before.some((region) => region.textContent === '')).toBe(true);
    rerender(<ProjectHome {...props({ catalogRestore: restore() })} />);
    const filled = regions().find((region) => region.textContent?.includes('project list was damaged'));
    expect(filled && before.includes(filled)).toBe(true);
  });

  it('puts focus on the page heading after × from the keyboard', () => {
    const onDismissCatalogRestore = vi.fn();
    render(<ProjectHome {...props({ catalogRestore: restore(), onDismissCatalogRestore })} />);
    const close = screen.getByRole('button', { name: 'Dismiss' });
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement?.id).toBe('project-home-title');
  });

  it('opens Recently deleted from the notice and moves focus there', () => {
    const trash: TrashedProject[] = [{
      id: '0'.repeat(32), name: 'Logo', createdAt: TWO_DAYS_AGO, updatedAt: TWO_DAYS_AGO, lastOpenedAt: TWO_DAYS_AGO,
      nodeCount: 0, edgeCount: 0, thumbnail: null, deletedAt: TWO_DAYS_AGO, purgeAt: '2026-11-24T11:00:00+00:00',
    } as TrashedProject];
    render(<ProjectHome {...props({ trash, catalogRestore: restore({ addedBack: trashedRows('Logo'), addedBackCount: 1 }) })} />);
    act(() => { fireEvent.click(screen.getByRole('button', { name: OPEN_RECENTLY_DELETED })); });
    const toggle = screen.getByRole('button', { name: /Recently deleted/, expanded: true });
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('button', { name: 'Restore Logo' })).toBeTruthy();
  });
});

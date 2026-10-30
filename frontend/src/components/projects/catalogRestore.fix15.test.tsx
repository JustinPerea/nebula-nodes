/**
 * Round 15 of PR #199 (GM r19 and review 13), the Projects home.
 * - GM r19 (a): "Nebula couldn’t read the whole damaged file…" only when the
 *   damaged file had records Nebula couldn't read (`damagedRecordsUnread`).
 * - GM r19 (b): the open canvas's project is said once: the canvas line
 *   owns it, and the left-out-at-limit line names only the others.
 * - Review 13 merge-integrity MEDIUM-1: the restore notices above the stack
 *   follow its focus rule (× → the notice now in its place, else the heading).
 * - Review 13 merge-integrity LOW-1: the restore copy loads lazily.
 * - Review 13 merge-integrity LOW-2 (M5): the [Reload Nebula] label.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import * as restoreCopy from './catalogRestoreCopy';
import { catalogRestoreNotice } from './catalogRestoreCopy';
import { primeRestoreCopyForTests, restoreCopyNow } from './restoreCopyLoader';
import type { CatalogRestore } from '../../lib/projects';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const OPENING = 'Nebula’s project list was damaged, so it restored the last good copy.';
const NOT_READ_WHOLE = 'Nebula couldn’t read the whole damaged file, so changes made after that copy may be missing.';
const DELTA = 'd'.repeat(32);
const EPSILON = 'e'.repeat(32);

function leftOut(extra: Partial<CatalogRestore> = {}): CatalogRestore {
  const rows = [{ id: DELTA, reason: 'limit', name: 'Delta' }, { id: EPSILON, reason: 'limit', name: 'Epsilon' }];
  return {
    id: 'r', at: '2026-10-30T12:00:00Z', kind: 'restored', source: 'catalog.json.bak', damagedFile: '/p/catalog.json.damaged-1',
    setAside: ['/p/catalog.json.damaged-1'], addedBack: [], addedBackCount: 0,
    notAddedBack: rows, notAddedBackCount: 2, notAddedBackLimitCount: 2, projectLimit: 3,
    damagedReadWhole: false, ...extra,
  } as CatalogRestore;
}
const props = (more: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({ projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...more });

afterEach(() => { primeRestoreCopyForTests(restoreCopy); });

describe('GM r19 (a): the not-read-whole line only for records Nebula couldn’t read', () => {
  it('a file cut only past its last record (every record read): no "may be missing"', () => {
    const lines = catalogRestoreNotice(leftOut({ damagedRecordsUnread: false })).lines ?? [];
    expect(lines).not.toContain(NOT_READ_WHOLE);
    expect(lines).toEqual([OPENING,
      '“Delta” and “Epsilon” weren’t added back because you’ve reached the limit of 3 projects. They’re still in the damaged file, which was kept.']);
  });
  it('records Nebula couldn’t read: said; and from a record before the field (unknown), still said', () => {
    expect(catalogRestoreNotice(leftOut({ damagedRecordsUnread: true })).lines).toContain(NOT_READ_WHOLE);
    expect(catalogRestoreNotice(leftOut()).lines).toContain(NOT_READ_WHOLE);
  });
  it('nothing else to say, and nothing unread: "No projects were missing."', () => {
    const notice = catalogRestoreNotice(leftOut({ notAddedBack: [], notAddedBackCount: 0, notAddedBackLimitCount: 0,
      damagedRecordsUnread: false }));
    expect(notice.text).toBe(`${OPENING} No projects were missing.`);
  });
});

describe('GM r19 (b): the open canvas’s project is said once, by its canvas line', () => {
  it('the canvas waits on the limit: the left-out line names only the others', () => {
    const restore = leftOut({ openProjectMissing: EPSILON, openProjectName: 'Epsilon', canvasNotFiled: { reason: 'projects' },
      damagedRecordsUnread: false });
    const now = { projects: [], trash: [], projectLimit: 3, canvasNotFiled: { reason: 'projects' as const, projectLimit: 3 } };
    const lines = catalogRestoreNotice(restore, undefined, now).lines ?? [];
    expect(lines.filter((line) => line.includes('Epsilon'))).toEqual([]);
    expect(lines).toContain('“Delta” wasn’t added back because you’ve reached the limit of 3 projects. It’s still in the damaged file, which was kept.');
    expect(lines.some((line) => line.startsWith('The canvas you had open couldn’t be saved as its own project because'))).toBe(true);
  });
  it('without a canvas line, the open project stays in the left-out line', () => {
    const lines = catalogRestoreNotice(leftOut({ openProjectMissing: EPSILON, damagedRecordsUnread: false })).lines ?? [];
    expect(lines[1]).toMatch(/^“Delta” and “Epsilon” weren’t added back/);
  });
});

describe('review 13 MEDIUM-1: the restore notices follow the notice stack’s focus rule', () => {
  const copyNotice = { line: 'Nebula was updated. Your edits are in “Alpha (recovered)”.', restore: null };
  it('× on the restore notice moves focus to the notice now in its place (the copy notice’s ×), not the heading', () => {
    const view = render(<ProjectHome {...props({ catalogRestore: leftOut(), copyNotice })} />);
    const close = screen.getAllByRole('button', { name: 'Dismiss' })[0];
    expect(close?.classList.contains('project-home__toast-close')).toBe(true);
    close.focus();
    fireEvent.click(close);
    view.rerender(<ProjectHome {...props({ catalogRestore: null, copyNotice })} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
    expect(document.activeElement?.classList.contains('project-home__notice-close')).toBe(true);
  });
  it('the held-unreadable notice’s × with the waiting line below: focus goes to the waiting line (it has no ×)', () => {
    const waiting = { reason: 'projects' as const, projectLimit: 3 };
    const view = render(<ProjectHome {...props({ canvasHeldUnreadable: { count: 1 }, canvasNotFiled: waiting })} />);
    const close = screen.getByRole('button', { name: 'Dismiss' });
    close.focus();
    fireEvent.click(close);
    view.rerender(<ProjectHome {...props({ canvasHeldUnreadable: null, canvasNotFiled: waiting })} />);
    expect(document.activeElement?.classList.contains('project-home__waiting')).toBe(true);
  });
  it('with nothing left: the "Recent projects" heading', () => {
    const view = render(<ProjectHome {...props({ canvasHeldUnreadable: { count: 2 } })} />);
    const close = screen.getByRole('button', { name: 'Dismiss' });
    close.focus();
    fireEvent.click(close);
    view.rerender(<ProjectHome {...props({ canvasHeldUnreadable: null })} />);
    expect(document.activeElement?.id).toBe('recent-projects-title');
  });
});

describe('review 13 LOW-1: the restore copy loads when a restore notice needs it', () => {
  it('nothing loads for a home with no restore; a restore notice loads it and then says it', async () => {
    primeRestoreCopyForTests(null);
    const view = render(<ProjectHome {...props()} />);
    expect(restoreCopyNow()).toBeNull();
    view.rerender(<ProjectHome {...props({ catalogRestore: leftOut({ damagedRecordsUnread: false }) })} />);
    expect(await screen.findByText(/“Delta” and “Epsilon” weren’t added back/)).toBeTruthy();
    expect(restoreCopyNow()).not.toBeNull();
  });
});

describe('review 13 LOW-2 (M5): [Reload Nebula] after an update', () => {
  it('replaces Try again', () => {
    const onRetry = vi.fn();
    render(<ProjectHome {...props({ error: 'Nebula was updated while this tab was open.', retry: 'reloadNebula', onRetry })} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Reload Nebula' })); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

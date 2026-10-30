/**
 * Fix round 14 of PR #199 (GM r18, Q5): a restore adds no record back past
 * the project limit. Records Nebula could read but left out because of the
 * limit get their own line, which replaces "couldn’t be added back" for them:
 * named up to three (the shared name list), counted from four. "Changes made
 * after that copy may be missing" stays only for what Nebula couldn't read.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import { catalogRestoreNotice, leftOutAtLimitLine } from './catalogRestoreCopy';
import type { CatalogRestore } from '../../lib/projects';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const OPENING = 'Nebula’s project list was damaged, so it restored the last good copy.';
const NOT_READ_WHOLE = 'Nebula couldn’t read the whole damaged file, so changes made after that copy may be missing.';
const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

function restore(leftOut: number, extra: Partial<CatalogRestore> = {}): CatalogRestore {
  const rows = NAMES.slice(0, leftOut).map((name, index) => ({ id: `${index}`.padStart(32, 'a'), reason: 'limit', name }));
  return {
    id: 'r', at: '2026-10-29T12:00:00Z', kind: 'restored', source: 'catalog.json.bak', damagedFile: '/p/catalog.json.damaged-1',
    setAside: ['/p/catalog.json.damaged-1'], addedBack: [], addedBackCount: 0,
    notAddedBack: rows, notAddedBackCount: rows.length, notAddedBackLimitCount: rows.length, projectLimit: 500,
    damagedReadWhole: true, ...extra,
  } as CatalogRestore;
}

describe('GM r18, Q5: records left out at the limit say so', () => {
  it('two names, verbatim; no "may be missing", and "which was kept" is said once', () => {
    const notice = catalogRestoreNotice(restore(2));
    expect(notice.lines).toEqual([OPENING,
      '“Alpha” and “Beta” weren’t added back because you’ve reached the limit of 500 projects. They’re still in the damaged file, which was kept.']);
  });

  it('three names', () => {
    expect(catalogRestoreNotice(restore(3)).lines).toEqual([OPENING,
      '“Alpha”, “Beta” and “Gamma” weren’t added back because you’ve reached the limit of 500 projects. They’re still in the damaged file, which was kept.']);
  });

  it('from four, a count (GM: "5 projects weren’t added back …")', () => {
    expect(catalogRestoreNotice(restore(4)).lines?.[1])
      .toBe('4 projects weren’t added back because you’ve reached the limit of 500 projects. They’re still in the damaged file, which was kept.');
    expect(catalogRestoreNotice(restore(5)).lines?.[1])
      .toBe('5 projects weren’t added back because you’ve reached the limit of 500 projects. They’re still in the damaged file, which was kept.');
    // A count past the rows the record lists is said as recorded.
    expect(catalogRestoreNotice(restore(2, { notAddedBackCount: 120, notAddedBackLimitCount: 120 })).lines?.[1])
      .toMatch(/^120 projects weren’t added back because/);
  });

  it('one name', () => {
    expect(leftOutAtLimitLine(['Alpha'], 1, 500))
      .toBe('“Alpha” wasn’t added back because you’ve reached the limit of 500 projects. It’s still in the damaged file, which was kept.');
  });

  it('a mix: what Nebula couldn’t read keeps its lines, what the limit left out has its own', () => {
    const base = restore(2);
    const mixed = catalogRestoreNotice({ ...base, damagedReadWhole: false,
      notAddedBack: [...base.notAddedBack!, { id: 'c'.repeat(32), reason: 'unreadable' }], notAddedBackCount: 3 });
    expect(mixed.lines).toEqual([OPENING,
      '1 newer project couldn’t be added back.',
      '“Alpha” and “Beta” weren’t added back because you’ve reached the limit of 500 projects. They’re still in the damaged file, which was kept.',
      NOT_READ_WHOLE]);
    // Unreadable alone: the generic lines, as before.
    const unread = catalogRestoreNotice({ ...restore(0), damagedReadWhole: false });
    expect(unread.lines).toEqual([OPENING, NOT_READ_WHOLE, 'The damaged file was kept.']);
  });

  it('the limit now (the listing’s) wins; a left-out project back in the list drops from the line', () => {
    const now = { projects: [{ id: '0'.padStart(32, 'a'), name: 'Alpha' }], trash: [], projectLimit: 3 };
    expect(catalogRestoreNotice(restore(2), undefined, now).lines?.[1])
      .toBe('“Beta” wasn’t added back because you’ve reached the limit of 3 projects. It’s still in the damaged file, which was kept.');
  });

  it('renders on the Projects home', () => {
    const props = { projects: [], loading: false, busy: false, error: null,
      onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;
    render(<ProjectHome {...props} catalogRestore={restore(2)} projectLimit={500} />);
    expect(screen.getByText(/“Alpha” and “Beta” weren’t added back because you’ve reached the limit of 500 projects\./)).toBeTruthy();
    expect(screen.queryByText(/may be missing/)).toBeNull();
  });
});

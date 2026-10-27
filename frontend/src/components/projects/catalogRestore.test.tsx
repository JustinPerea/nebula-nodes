/**
 * The Projects home notice after Nebula restored a damaged project list
 * (GM's lines, 2026-10-27): every form word for word, shown as a status
 * notice until the person closes it with ×, and never the damaged file's path.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import { catalogRestoreLine, catalogRestoreLogLine, REBUILD_SECOND_SENTENCE_PLACEHOLDER } from './catalogRestoreCopy';
import type { CatalogRestore } from '../../lib/projects';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const DAMAGED = '/Users/someone/.nebula/projects/catalog.json.damaged-20261027T101500Z-1a2b3c4d';

const restore = (overrides: Partial<CatalogRestore> = {}): CatalogRestore => ({
  id: 'r'.repeat(32), at: '2026-10-27T10:15:00+00:00', kind: 'restored', source: 'catalog.json.bak',
  damagedFile: DAMAGED, addedBack: [], addedBackCount: 0, notAddedBackCount: 0, ...overrides,
});
const added = (...names: string[]) => names.map((name, index) => ({ id: String(index).repeat(32), name }));

describe('catalogRestoreLine', () => {
  it('names one project added back', () => {
    expect(catalogRestoreLine(restore({ addedBack: added('Dunes'), addedBackCount: 1 })))
      .toBe("Nebula's project list was damaged, so it restored the last good copy and added back “Dunes”, a newer project it found.");
  });

  it('names two projects added back', () => {
    expect(catalogRestoreLine(restore({ addedBack: added('Dunes', 'Glass'), addedBackCount: 2 })))
      .toBe("Nebula's project list was damaged, so it restored the last good copy and added back “Dunes” and “Glass”, newer projects it found.");
  });

  it('names three projects added back', () => {
    expect(catalogRestoreLine(restore({ addedBack: added('Dunes', 'Glass', 'Logo'), addedBackCount: 3 })))
      .toBe("Nebula's project list was damaged, so it restored the last good copy and added back “Dunes”, “Glass” and “Logo”, newer projects it found.");
  });

  it('counts four or more projects added back', () => {
    expect(catalogRestoreLine(restore({ addedBack: added('A', 'B', 'C', 'D'), addedBackCount: 4 })))
      .toBe("Nebula's project list was damaged, so it restored the last good copy and added back 4 newer projects it found.");
    expect(catalogRestoreLine(restore({ addedBack: added('A', 'B', 'C', 'D', 'E', 'F', 'G'), addedBackCount: 7 })))
      .toBe("Nebula's project list was damaged, so it restored the last good copy and added back 7 newer projects it found.");
  });

  it('says no projects were missing only when nothing was added back and nothing failed', () => {
    expect(catalogRestoreLine(restore()))
      .toBe("Nebula's project list was damaged, so it restored the last good copy. No projects were missing.");
  });

  it('uses form 1 with what was added when adding back failed partway', () => {
    const line = catalogRestoreLine(restore({ addedBack: added('Dunes'), addedBackCount: 1, notAddedBackCount: 2 }));
    expect(line).toBe("Nebula's project list was damaged, so it restored the last good copy and added back “Dunes”, a newer project it found.");
    expect(line).not.toContain('No projects were missing');
  });

  it('never says no projects were missing when every add-back failed', () => {
    expect(catalogRestoreLine(restore({ notAddedBackCount: 1 })))
      .toBe("Nebula's project list was damaged, so it restored the last good copy.");
  });

  it('says a rebuild with the placeholder for its pending second sentence', () => {
    expect(REBUILD_SECOND_SENTENCE_PLACEHOLDER).toBe('[GM: second sentence pending]');
    expect(catalogRestoreLine(restore({ kind: 'rebuilt', source: null, addedBack: added('Dunes'), addedBackCount: 1 })))
      .toBe("Nebula's project list was damaged, so it rebuilt it from your project folders. [GM: second sentence pending]");
  });
});

describe('catalogRestoreLogLine', () => {
  it('gives the Agent log the source and where the damaged file is kept', () => {
    expect(catalogRestoreLogLine(restore({ addedBackCount: 2, notAddedBackCount: 1 })))
      .toBe(`Project list restored from catalog.json.bak; damaged file kept at ${DAMAGED}; 2 added back, 1 not added back.`);
    expect(catalogRestoreLogLine(restore({ kind: 'rebuilt', source: null, damagedFile: null, addedBackCount: 3 })))
      .toBe('Project list rebuilt from the damaged files (no good copy); 3 added back.');
  });
});

describe('the Projects home notice', () => {
  const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
    projects: [], loading: false, busy: false, error: null,
    onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
  });

  it('is a status notice that stays until the person closes it with ×, without the damaged path', () => {
    const onDismissCatalogRestore = vi.fn();
    const { rerender } = render(<ProjectHome {...props({ catalogRestore: restore({ addedBack: added('Dunes'), addedBackCount: 1 }), onDismissCatalogRestore })} />);
    const notice = screen.getByText(/project list was damaged/).closest('[role="status"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('added back “Dunes”, a newer project it found.');
    expect(notice?.textContent).not.toContain('catalog.json');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissCatalogRestore).toHaveBeenCalledTimes(1);
    rerender(<ProjectHome {...props({ catalogRestore: null, onDismissCatalogRestore })} />);
    expect(screen.queryByText(/project list was damaged/)).toBeNull();
  });
});

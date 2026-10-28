/**
 * Fix round 7 of PR #199 (GM r8 and GM's answers to review 7): a canvas
 * saved over the save limit has GM's own line, in the toast and the restore
 * notice alike, never beside the plain one; several named mark only those
 * over it (plural form for GM). The plural waiting line says the real number
 * of deletes (GM's answer 3). A Restore that deletes can't free says so
 * without a false count (review 7, N-2). The saved toast wraps (GM r8).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary } from './ProjectHome';
import {
  canvasLimitLine, canvasSavedToast, canvasWaitingLine, catalogRestoreNotice, recoveredCanvasSentence,
  restoreAtLimitTooltip,
} from './catalogRestoreCopy';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const OVER = "The canvas you had open was saved as its own project, “Delta (recovered)”. It's over the save limit, so new changes won't save until it's smaller.";

describe("GM: the saved line for a canvas over the save limit", () => {
  it('the toast, verbatim, in place of the plain line', () => {
    expect(canvasSavedToast('Delta (recovered)', null, true)).toBe(OVER);
    expect(canvasSavedToast('Delta (recovered)', null, false)).toBe('The canvas you had open was saved as its own project, “Delta (recovered)”.');
  });

  it('the restore notice line, verbatim, never beside the plain one', () => {
    expect(recoveredCanvasSentence('Delta (recovered)', true)).toBe(OVER);
    const notice = catalogRestoreNotice({ kind: 'restored', source: 'catalog.json.bak', addedBack: [], addedBackCount: 0,
      notAddedBackCount: 0, damagedFile: '/x/catalog.json.damaged', damagedReadWhole: true, openProjectMissing: 'd'.repeat(32),
      recoveredCanvas: { id: 'c1', name: 'Delta (recovered)', overSaveLimit: true } } as never, Date.now(),
    { projects: [{ id: 'c1', name: 'Delta (recovered)' }], trash: [] });
    expect(notice.lines).toContain(OVER);
    expect(notice.text).not.toContain('so nothing in it is lost');
  });

  it('several named: only those over the limit are marked', () => {
    expect(canvasSavedToast('B', [{ name: 'A' }, { name: 'B', overSaveLimit: true }]))
      .toBe("The canvases you had open were saved as their own projects, “A” and “B”. “B” is over the save limit, so new changes to it won't save until it's smaller.");
    expect(canvasSavedToast('C', [{ name: 'A', overSaveLimit: true }, { name: 'B' }, { name: 'C', overSaveLimit: true }]))
      .toBe("The canvases you had open were saved as their own projects, “A”, “B” and “C”. “A” and “C” are over the save limit, so new changes to them won't save until they're smaller.");
    expect(canvasSavedToast('D', [{ name: 'A' }, { name: 'B' }, { name: 'C', overSaveLimit: true }, { name: 'D' }]))
      .toBe("4 canvases you had open were saved as their own projects. One of them is over the save limit, so new changes to it won't save until it's smaller.");
    expect(canvasSavedToast('B', [{ name: 'A' }, { name: 'B' }]))
      .toBe('The canvases you had open were saved as their own projects, “A” and “B”.');
  });
});

describe("GM's answer 3: the plural line's real number", () => {
  const two = { projectLimit: 3, trashHasItems: false, canvases: [{ name: 'A' }, { name: 'B' }] };
  it('"Delete 2 projects and Nebula will save them." from the listing', () => {
    expect(canvasWaitingLine('projects', { ...two, deletes: 2 })).toBe(
      "The canvases you had open, “A” and “B”, aren't saved as projects yet because you've reached the limit of 3 projects. Nothing in them is lost. Delete 2 projects and Nebula will save them.");
    expect(canvasLimitLine('projects', { ...two, deletes: 3 })).toContain('Delete 3 projects and Nebula will save them.');
    expect(canvasWaitingLine('projects', two)).toContain('Delete 2 projects and Nebula will save them.');
  });
  it('the size-cap plurals stay as written', () => {
    expect(canvasWaitingLine('storage', { ...two, trashHasItems: true })).toContain(
      'Permanently delete projects in Recently deleted and Nebula will save them.');
  });
});

describe('Review 7, N-2: a Restore no count of deletes frees', () => {
  it('says no false "after you delete a project"', () => {
    const line = restoreAtLimitTooltip(3, { refused: 'projects', deletes: null, heldTakesPlace: true, waiting: 3 });
    expect(line).not.toContain('after you delete');
    // GM r9 (2), verbatim (fix round 8).
    expect(line).toBe("You can restore it once the canvases you had open are saved as projects. They're holding the last places.");
  });
  it('GM answer 6: the real count, plural', () => {
    expect(restoreAtLimitTooltip(3, { refused: 'projects', deletes: 4, heldTakesPlace: true, waiting: 3 })).toBe(
      'You can restore it after you delete 4 projects. The canvases you had open are holding the last places.');
  });
});

describe('GM r8: the saved toast wraps', () => {
  const project = (id: string, name: string): ProjectSummary => ({
    id, name, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', lastOpenedAt: null,
    nodeCount: 0, edgeCount: 0, thumbnail: null,
  });
  const props = (overrides: Partial<ProjectHomeProps> = {}): ProjectHomeProps => ({
    projects: [project('l'.repeat(32), 'Logo')], loading: false, busy: false, error: null,
    onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn(), ...overrides,
  });
  it('renders the whole sentence with both names', () => {
    render(<ProjectHome {...props({ canvasSaved: { id: 'b', name: 'Recovered canvas 2',
      filed: [{ id: 'a', name: 'Recovered canvas' }, { id: 'b', name: 'Recovered canvas 2' }] } })} />);
    const line = screen.getByText('The canvases you had open were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”.');
    expect(line.classList.contains('project-home__toast-text')).toBe(true);
  });
});

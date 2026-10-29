/**
 * Fix round 8 of PR #199 (GM r9, GM's answers to review 8, and GM's rule (a)
 * on the Undo check): the restore notice names every canvas filed while it
 * shows and no toast does; a later filing on its own says "Another canvas…";
 * every saved canvas over the limit gets the plural "They're over…"; the
 * held canvases that couldn't be read merge into the restore notice (closing
 * "The damaged files were kept.") or stand alone with ×; and the person's
 * Agent log rows when an agent's write saved the
 * canvas first (rule (a)).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary } from './ProjectHome';
import {
  canvasHeldLogLine, canvasSavedToast, catalogRestoreNotice,
} from './catalogRestoreCopy';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const project = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', lastOpenedAt: null,
  nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const restored = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', kind: 'restored', source: 'catalog.json.bak', addedBack: [], addedBackCount: 0, notAddedBackCount: 0,
  damagedFile: '/x/catalog.json.damaged', damagedReadWhole: true, openProjectMissing: 'd'.repeat(32),
  recoveredCanvas: { id: A, name: 'Recovered canvas' }, ...extra,
}) as never;
const now = (projects = [{ id: A, name: 'Recovered canvas' }, { id: B, name: 'Recovered canvas 2' }]) => ({ projects, trash: [] });

describe("GM's answer 1 to review 8: the restore notice names every canvas filed", () => {
  it('one sentence for both, "so nothing in them is lost", verbatim', () => {
    const notice = catalogRestoreNotice(restored({ alsoFiled: [{ id: B, name: 'Recovered canvas 2' }] }), Date.now(), now());
    expect(notice.lines).toContain('The canvases you had open were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”, so nothing in them is lost.');
    expect(notice.text).not.toContain('so nothing in it is lost');
  });

  it('a filed canvas deleted for good drops out; one left reads singular', () => {
    const notice = catalogRestoreNotice(restored({ alsoFiled: [{ id: B, name: 'Recovered canvas 2' }] }), Date.now(),
      now([{ id: A, name: 'Recovered canvas' }]));
    expect(notice.lines).toContain('The canvas you had open was saved as its own project, “Recovered canvas”, so nothing in it is lost.');
  });

  it('the over-limit tail, and the plural when every one is over (GM r9, 1)', () => {
    const some = catalogRestoreNotice(restored({ alsoFiled: [{ id: B, name: 'Recovered canvas 2', overSaveLimit: true }] }), Date.now(), now());
    expect(some.lines).toContain("The canvases you had open were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”, so nothing in them is lost. “Recovered canvas 2” is over the save limit, so new changes to it won’t save until it’s smaller.");
    const every = catalogRestoreNotice(restored({ recoveredCanvas: { id: A, name: 'Recovered canvas', overSaveLimit: true },
      alsoFiled: [{ id: B, name: 'Recovered canvas 2', overSaveLimit: true }] }), Date.now(), now());
    expect(every.lines).toContain("The canvases you had open were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”. They’re over the save limit, so new changes to them won’t save until they’re smaller.");
  });

  it('no toast for a canvas the notice names (ProjectHome renders only the notice line)', () => {
    render(<ProjectHome projects={[project(A, 'Recovered canvas'), project(B, 'Recovered canvas 2')]} loading={false} busy={false}
      error={null} onCreate={vi.fn()} onOpen={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRetry={vi.fn()}
      catalogRestore={restored({ alsoFiled: [{ id: B, name: 'Recovered canvas 2' }] })} />);
    expect(document.querySelector('.project-home__toast')).toBeNull();
    expect(screen.getByText(/were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”, so nothing in them is lost\./)).toBeTruthy();
  });
});

describe('The toast for a later filing on its own', () => {
  it('"Another canvas you had open…", verbatim, and its plural', () => {
    expect(canvasSavedToast('Recovered canvas 2', null, false, true))
      .toBe('Another canvas you had open was saved as its own project, “Recovered canvas 2”.');
    expect(canvasSavedToast('C', [{ name: 'B' }, { name: 'C' }], false, true))
      .toBe('Other canvases you had open were saved as their own projects, “B” and “C”.');
    expect(canvasSavedToast('B', null, true, true))
      .toBe("Another canvas you had open was saved as its own project, “B”. It’s over the save limit, so new changes won’t save until it’s smaller.");
  });

  it('GM r9 (1): every one over is not named again', () => {
    expect(canvasSavedToast('B', [{ name: 'A', overSaveLimit: true }, { name: 'B', overSaveLimit: true }]))
      .toBe("The canvases you had open were saved as their own projects, “A” and “B”. They’re over the save limit, so new changes to them won’t save until they’re smaller.");
    expect(canvasSavedToast('A', [{ name: 'A', overSaveLimit: true }])).toBe(
      "The canvas you had open was saved as its own project, “A”. It’s over the save limit, so new changes won’t save until it’s smaller.");
  });
});

describe('GM r9: the held canvases that couldn\'t be read', () => {
  const base = { projects: [project(A, 'Recovered canvas')], loading: false, busy: false, error: null,
    onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;

  it('merges into the restore notice before the closing, which names both files', () => {
    const notice = catalogRestoreNotice(restored(), Date.now(), now([{ id: A, name: 'Recovered canvas' }]), { heldUnreadable: { count: 1 } });
    expect(notice.lines?.slice(-2)).toEqual([
      "Nebula couldn’t read a canvas you had open that was waiting to be saved, so it may be lost.",
      'The damaged files were kept.',
    ]);
    render(<ProjectHome {...base} catalogRestore={restored()} canvasHeldUnreadable={{ count: 1 }} />);
    // One notice says it: no second, standalone one.
    expect(screen.getAllByText(/couldn’t read a canvas you had open/)).toHaveLength(1);
    expect(screen.getByText('The damaged files were kept.')).toBeTruthy();
  });

  it('alone: its own notice styled like the restore notice, with × that closes it', () => {
    const onDismiss = vi.fn();
    render(<ProjectHome {...base} canvasHeldUnreadable={{ count: 2 }} onDismissCanvasHeldUnreadable={onDismiss} />);
    const line = screen.getByText("Nebula couldn’t read 2 canvases you had open that were waiting to be saved, so they may be lost. The damaged file was kept.");
    const notice = line.closest('.project-home__notice');
    expect(notice?.classList.contains('project-home__restore')).toBe(true);
    expect(notice?.classList.contains('project-home__waiting')).toBe(false);
    fireEvent.click(notice!.querySelector('button[aria-label="Dismiss"]')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("GM's rule (a): the person's Agent log rows when the canvas was saved first", () => {
  it('edit, clear, load, verbatim; "An agent" when unknown', () => {
    expect(canvasHeldLogLine('Codex', 'changed', 'Recovered canvas', true))
      .toBe('Codex changed a copy of the canvas you had open. The original was saved as its own project, “Recovered canvas”.');
    expect(canvasHeldLogLine('Codex', 'cleared', 'Recovered canvas'))
      .toBe('Codex cleared the canvas. The one you had open was saved as its own project, “Recovered canvas”.');
    expect(canvasHeldLogLine(null, 'replaced', 'Recovered canvas'))
      .toBe('An agent replaced the canvas. The one you had open was saved as its own project, “Recovered canvas”.');
    // Held aside (above the limit's room) keeps its own line.
    expect(canvasHeldLogLine('Codex', 'cleared')).toBe('Codex cleared the canvas. The one you had open is kept until Nebula can save it as a project.');
  });
});

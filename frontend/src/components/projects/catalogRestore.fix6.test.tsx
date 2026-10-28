/**
 * Fix round 6 of PR #199 (review 6 and GM's answers, 2026-10-28): the
 * waiting line counts or names every canvas that waits and the saved toast
 * names each one filed (N-2); Restore greys on the backend's own verdict,
 * held canvases counted, with GM's tooltip and the real number of deletes
 * (L-3); a disabled Restore keeps its look under the pointer (L-4); the
 * refused toast takes focus only after keyboard input (N-4); a project
 * deleted today reads 30 days (GM bug 2); a held canvas that couldn't be
 * read is said (L-1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary, type TrashedProject } from './ProjectHome';
import {
  canvasHeldLogLine, canvasHeldUnreadableLine, canvasHoldRefusedLogLine, canvasLimitLine, canvasSavedToast,
  canvasWaitingLine, restoreAtLimitTooltip,
} from './catalogRestoreCopy';
import { daysLeft, removalNote } from './trashDays';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const ALPHA = 'a'.repeat(32);
const LOGO = 'l'.repeat(32);
const DUNES = 'd'.repeat(32);
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
const context = { projectLimit: 3, trashHasItems: false };

describe('N-2: every canvas that waits is counted or named', () => {
  it('keeps the singular line for one canvas', () => {
    expect(canvasWaitingLine('projects', { ...context, canvases: [{ name: 'Delta' }] })).toBe(
      "The canvas you had open isn't saved as a project yet because you've reached the limit of 3 projects. Nothing in it is lost. Delete a project and Nebula will save it.");
  });

  it('names up to 3 when every name is known (GM (a), the name helper)', () => {
    expect(canvasWaitingLine('projects', { ...context, canvases: [{ name: 'Delta' }, { name: 'Gamma' }] })).toBe(
      "The canvases you had open, “Delta” and “Gamma”, aren't saved as projects yet because you've reached the limit of 3 projects. Nothing in them is lost. Delete projects and Nebula will save them.");
  });

  it('counts when a name is unknown, and from 4', () => {
    expect(canvasWaitingLine('projects', { ...context, canvases: [{ name: 'Delta' }, { name: null }] })).toBe(
      "2 canvases you had open aren't saved as projects yet because you've reached the limit of 3 projects. Nothing in them is lost. Delete projects and Nebula will save them.");
    const four = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];
    expect(canvasWaitingLine('storage', { ...context, trashHasItems: true, canvases: four })).toBe(
      "4 canvases you had open aren't saved as projects yet because Nebula's project list is full. Nothing in them is lost. Permanently delete projects in Recently deleted and Nebula will save them.");
  });

  it('counts in the restore notice line too', () => {
    expect(canvasLimitLine('projects', { ...context, canvases: [{ name: null }, { name: null }] })).toBe(
      "2 canvases you had open couldn't be saved as their own projects because you've reached the limit of 3 projects. Nothing in them is lost. Delete projects and Nebula will save them.");
  });

  it('renders the counted waiting line on Projects home', () => {
    render(<ProjectHome {...props({ canvasNotFiled: { reason: 'projects', projectLimit: 3, canvases: [{ name: null }, { name: null }] } })} />);
    expect(screen.getByText(/^2 canvases you had open aren't saved as projects yet/)).toBeTruthy();
  });

  it('the saved toast names each canvas it filed', () => {
    expect(canvasSavedToast('Recovered canvas')).toBe('The canvas you had open was saved as its own project, “Recovered canvas”.');
    const two = [{ name: 'Recovered canvas' }, { name: 'Recovered canvas 2' }];
    expect(canvasSavedToast('Recovered canvas 2', two)).toBe(
      'The canvases you had open were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”.');
    expect(canvasSavedToast('D', [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])).toBe(
      '4 canvases you had open were saved as their own projects.');
    render(<ProjectHome {...props({ canvasSaved: { id: 'x', name: 'Recovered canvas 2', filed: [
      { id: 'w', name: 'Recovered canvas' }, { id: 'x', name: 'Recovered canvas 2' }] } })} />);
    expect(screen.getByText(/“Recovered canvas” and “Recovered canvas 2”/)).toBeTruthy();
  });
});

describe("L-3: Restore greys on the backend's verdict", () => {
  it("words GM's tooltip when a held canvas holds the last place, and the real number of deletes", () => {
    expect(restoreAtLimitTooltip(3, { refused: 'projects', deletes: 1, heldTakesPlace: true, waiting: 1 })).toBe(
      'You can restore it after you delete a project. The canvas you had open is holding the last place.');
    expect(restoreAtLimitTooltip(3, { refused: 'projects', deletes: 2, heldTakesPlace: false, waiting: 1 })).toBe(
      "You can restore it after you delete 2 projects. You've reached the limit of 3 projects.");
    expect(restoreAtLimitTooltip(3, { refused: 'projects', deletes: 1, heldTakesPlace: true, waiting: 2 })).toBe(
      'You can restore it after you delete a project. The canvases you had open are holding the last places.');
    expect(restoreAtLimitTooltip(500)).toBe("You can restore it after you delete a project. You've reached the limit of 500 projects.");
  });

  it('greys Restore while the list shows fewer projects than the limit (review 6, H8)', () => {
    const onRestore = vi.fn();
    render(<ProjectHome {...props({ projects: [project(LOGO, 'Logo'), project(DUNES, 'Dunes')], projectLimit: 3,
      trash: [trashed(ALPHA, 'Alpha')], onRestore,
      restoreRoom: { refused: 'projects', deletes: 1, heldTakesPlace: true, waiting: 1 } })} />);
    openTrash();
    const button = screen.getByRole('button', { name: 'Restore Alpha' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('You can restore it after you delete a project. The canvas you had open is holding the last place.');
    fireEvent.click(button);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('keeps Restore enabled with no verdict below the limit', () => {
    render(<ProjectHome {...props({ projectLimit: 3, trash: [trashed(ALPHA, 'Alpha')] })} />);
    openTrash();
    expect(screen.getByRole('button', { name: 'Restore Alpha' }).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('L-4: a disabled button keeps its look under the pointer', () => {
  const css = readFileSync(join(__dirname, '../../styles/project-home.css'), 'utf8');
  it('every hover rule that skips :disabled skips aria-disabled too', () => {
    const rules = css.split('\n').filter((line) => line.includes(':hover:not(:disabled)'));
    expect(rules.length).toBeGreaterThan(5);
    for (const rule of rules) expect(rule).toContain(':hover:not(:disabled):not([aria-disabled="true"])');
  });

  it('no rule gives the at-limit Restore a hover look of its own', () => {
    expect(css).not.toMatch(/restore--at-limit:hover/);
  });
});

describe('N-4: the refused toast takes focus only after keyboard input', () => {
  const refused = { id: ALPHA, name: 'Alpha', refused: "Couldn't restore “Alpha”. You've reached the limit of 3 projects." };

  it('leaves focus alone after a mouse click', () => {
    const { rerender } = render(<ProjectHome {...props({ trash: [trashed(ALPHA, 'Alpha')] })} />);
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    rerender(<ProjectHome {...props({ trash: [trashed(ALPHA, 'Alpha')], lastDeleted: refused })} />);
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to × after keyboard input, when focus was lost', () => {
    const { rerender } = render(<ProjectHome {...props({ trash: [trashed(ALPHA, 'Alpha')] })} />);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    rerender(<ProjectHome {...props({ trash: [trashed(ALPHA, 'Alpha')], lastDeleted: refused })} />);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss');
  });
});

describe('GM bug 2: Removed for good in 30 days', () => {
  const day = 86_400_000;
  const at = (iso: string) => Date.parse(iso);

  it('reads 30 for a project deleted today, at any hour', () => {
    const deleted = '2026-10-28T00:00:05Z';
    const purge = '2026-11-27T00:00:05Z';
    expect(daysLeft(deleted, purge, at(deleted))).toBe(30);
    expect(daysLeft(deleted, purge, at(deleted) + 1000)).toBe(30);
    expect(daysLeft(deleted, purge, at(deleted) + day - 1)).toBe(30);
    expect(removalNote(deleted, purge, at(deleted) + 3_600_000)).toBe('Removed for good in 30 days');
  });

  it('counts down a day for each whole day since', () => {
    const deleted = '2026-10-28T23:30:00Z';
    const purge = '2026-11-27T23:30:00Z';
    expect(daysLeft(deleted, purge, at(deleted) + day)).toBe(29);
    expect(daysLeft(deleted, purge, at(deleted) + 28 * day + 1)).toBe(2);
    expect(removalNote(deleted, purge, at(deleted) + 29 * day)).toBe('Removed for good within a day');
    expect(daysLeft(deleted, purge, at(purge) + day)).toBe(0);
  });

  it('never reads 31 when the clock was read before the delete (the list opened first)', () => {
    const deleted = '2026-10-28T10:00:00Z';
    const purge = '2026-11-27T10:00:00Z';
    expect(daysLeft(deleted, purge, at(deleted) - 5 * 60_000)).toBe(30);
    expect(daysLeft(deleted, purge, at(deleted) - 2 * day)).toBe(30);
  });

  it('is the same whatever offset the times are written in, across a summer-time change', () => {
    // 2026-11-01 is the US fall-back day: a local day there is 25 hours.
    const deleted = '2026-10-31T22:00:00-07:00';
    const purge = '2026-11-30T21:00:00-08:00';
    expect(daysLeft(deleted, purge, at(deleted))).toBe(30);
    expect(daysLeft('2026-10-28T15:30:00+05:30', '2026-11-27T10:00:00Z', at('2026-10-28T10:00:00Z'))).toBe(30);
  });

  it('a list left open reads the clock again when a project is deleted', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at('2026-10-28T09:00:00Z'));
      const first = { ...trashed(LOGO, 'Logo'), deletedAt: '2026-10-20T09:00:00Z', purgeAt: '2026-11-19T09:00:00Z' };
      const { rerender } = render(<ProjectHome {...props({ trash: [first] })} />);
      openTrash();
      vi.setSystemTime(at('2026-10-28T12:00:00Z'));
      const today = { ...trashed(ALPHA, 'Alpha'), deletedAt: '2026-10-28T12:00:00Z', purgeAt: '2026-11-27T12:00:00Z' };
      rerender(<ProjectHome {...props({ trash: [first, today] })} />);
      expect(screen.getByText(/Removed for good in 30 days/)).toBeTruthy();
      expect(screen.queryByText(/31 days/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('L-1 and the Agent log lines', () => {
  it('says a held canvas that could not be read', () => {
    expect(canvasHeldUnreadableLine(1)).toBe(
      "Nebula couldn't read a canvas you had open that was waiting to be saved, so it may be lost. The damaged file was kept.");
    expect(canvasHeldUnreadableLine(null)).toBe(
      "Nebula couldn't read the file that kept the canvases you had open, so some may be lost. The damaged file was kept.");
    render(<ProjectHome {...props({ canvasHeldUnreadable: { count: 2 } })} />);
    expect(screen.getByText(/couldn't read 2 canvases you had open/)).toBeTruthy();
  });

  it("words GM's line for any other write", () => {
    expect(canvasHoldRefusedLogLine('Codex', 'change')).toBe(
      "Codex tried to change the canvas you had open. Nebula stopped it because that canvas isn't saved as a project yet.");
    expect(canvasHoldRefusedLogLine(null, 'change')).toBe(
      "An agent tried to change the canvas you had open. Nebula stopped it because that canvas isn't saved as a project yet.");
    expect(canvasHeldLogLine('Codex', 'changed')).toBe(
      'Codex changed the canvas. The one you had open is kept until Nebula can save it as a project.');
  });
});

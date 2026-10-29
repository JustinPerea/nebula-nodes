/**
 * Fix round 9 of PR #199. GM r10: canvases are named in the order they were
 * saved, which is number order, in the notice, the toast and the counted
 * forms (with the over-limit tail). GM r11, 4: an agent's copy of the
 * person's canvas is named as the agent's, on its own line ("Codex’s
 * changes were saved…", "An agent’s" when unknown), saved or waiting, in
 * the notice and the toast alike; "the canvas you had open" only ever
 * means the person's own.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps, type ProjectSummary } from './ProjectHome';
import {
  agentCopySavedLine, agentCopyWaitingLine, canvasSavedToast, canvasWaitingLine, catalogRestoreNotice, savedOrder,
} from './catalogRestoreCopy';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const project = (id: string, name: string): ProjectSummary => ({
  id, name, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z', lastOpenedAt: null,
  nodeCount: 0, edgeCount: 0, thumbnail: null,
});
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const restored = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', kind: 'restored', source: 'catalog.json.bak', addedBack: [], addedBackCount: 0, notAddedBackCount: 0,
  damagedFile: '/x/catalog.json.damaged', damagedReadWhole: true, openProjectMissing: 'd'.repeat(32), ...extra,
}) as never;
const base = { projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;

describe('GM r10: in the order they were saved', () => {
  it('the restore notice names “Recovered canvas” before “Recovered canvas 2”', () => {
    // The live canvas, filed second, is the restore's own; the held one, filed first, joined it.
    const notice = catalogRestoreNotice(restored({
      recoveredCanvas: { id: B, name: 'Recovered canvas 2', filedAt: '2026-10-28T10:00:00.200Z' },
      alsoFiled: [{ id: A, name: 'Recovered canvas', filedAt: '2026-10-28T10:00:00.100Z' }],
    }), Date.now(), { projects: [{ id: A, name: 'Recovered canvas' }, { id: B, name: 'Recovered canvas 2' }], trash: [] });
    expect(notice.lines).toContain('The canvases you had open were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”, so nothing in them is lost.');
  });

  it('the toast too; with no time, by number', () => {
    expect(canvasSavedToast('Recovered canvas', [{ id: B, name: 'Recovered canvas 2' }, { id: A, name: 'Recovered canvas' }]))
      .toBe('The canvases you had open were saved as their own projects, “Recovered canvas” and “Recovered canvas 2”.');
    expect(savedOrder([{ name: 'X 3' }, { name: 'X' }, { name: 'X 2' }]).map((row) => row.name)).toEqual(['X', 'X 2', 'X 3']);
  });

  it('GM r10, 4: "Other canvases…", and from 4 on the count, with the over-limit tail', () => {
    expect(canvasSavedToast('B', [{ name: 'A' }, { name: 'B' }], false, true))
      .toBe('Other canvases you had open were saved as their own projects, “A” and “B”.');
    const four = [{ name: 'R' }, { name: 'R 2' }, { name: 'R 3', overSaveLimit: true }, { name: 'R 4' }];
    expect(canvasSavedToast('R 4', four, false, true)).toBe('4 other canvases you had open were saved as their own projects. '
      + "One of them is over the save limit, so new changes to it won’t save until it’s smaller.");
  });
});

describe("GM r11, 4: the agent's copy is the agent's", () => {
  it('the restore notice: the original, then the copy on its own line, verbatim', () => {
    const notice = catalogRestoreNotice(restored({
      recoveredCanvas: { id: A, name: 'Recovered canvas' },
      agentCopies: [{ id: B, name: 'Recovered canvas copy', agentCopy: { agent: 'Codex' } }],
    }), Date.now(), { projects: [{ id: A, name: 'Recovered canvas' }, { id: B, name: 'Recovered canvas copy' }], trash: [] });
    expect(notice.lines).toContain('The canvas you had open was saved as its own project, “Recovered canvas”, so nothing in it is lost.');
    expect(notice.lines).toContain('Codex’s changes were saved as their own project, “Recovered canvas copy”.');
    expect(notice.text).not.toMatch(/canvases you had open/);
  });

  it('"An agent’s" when the agent isn\'t known; curly ’', () => {
    expect(agentCopySavedLine(null, 'Recovered canvas copy')).toBe('An agent’s changes were saved as their own project, “Recovered canvas copy”.');
  });

  it('waiting at the project limit, verbatim', () => {
    expect(agentCopyWaitingLine('Codex', 'projects', { projectLimit: 500, trashHasItems: false })).toBe(
      "Codex’s copy of your canvas isn’t saved as a project yet because you’ve reached the limit of 500 projects. Nothing in it is lost. Delete a project and Nebula will save it.");
  });

  it('waiting at the size cap, with the size advice by Recently deleted', () => {
    expect(agentCopyWaitingLine('Codex', 'storage', { projectLimit: 500, trashHasItems: true })).toBe(
      "Codex’s copy of your canvas isn’t saved as a project yet because Nebula’s project list is full. Nothing in it is lost. Permanently delete a project in Recently deleted and Nebula will save it.");
    expect(agentCopyWaitingLine(null, 'storage', { projectLimit: 500, trashHasItems: false })).toBe(
      "An agent’s copy of your canvas isn’t saved as a project yet because Nebula’s project list is full. Nothing in it is lost. Delete a project, then remove it from Recently deleted too, and Nebula will save it.");
  });

  it("the waiting line never calls the copy the person's", () => {
    const line = canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: false,
      canvases: [{ name: null, agentCopy: { agent: 'Codex' } }] });
    expect(line).not.toMatch(/canvas you had open/);
    expect(line).toMatch(/^Codex’s copy of your canvas/);
    const both = canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: false,
      canvases: [{ name: 'Delta' }, { name: null, agentCopy: { agent: 'Codex' } }] });
    expect(both).toBe("The canvas you had open isn’t saved as a project yet because you’ve reached the limit of 500 projects. Nothing in it is lost. Delete a project and Nebula will save it. "
      + "Codex’s copy of your canvas isn’t saved as a project yet because you’ve reached the limit of 500 projects. Nothing in it is lost. Delete a project and Nebula will save it.");
  });

  it('the toast follows the same split', () => {
    expect(canvasSavedToast('Recovered canvas copy', null, false, false, { agent: 'Codex' }))
      .toBe('Codex’s changes were saved as their own project, “Recovered canvas copy”.');
    expect(canvasSavedToast('Recovered canvas copy', [{ id: A, name: 'Recovered canvas' },
      { id: B, name: 'Recovered canvas copy', agentCopy: { agent: 'Codex' } }]))
      .toBe('The canvas you had open was saved as its own project, “Recovered canvas”. Codex’s changes were saved as their own project, “Recovered canvas copy”.');
  });

  it('rendered: the home waiting notice and the restore notice', () => {
    render(<ProjectHome {...base} projects={[project(A, 'Recovered canvas'), project(C, 'Recovered canvas copy')]}
      catalogRestore={restored({ recoveredCanvas: { id: A, name: 'Recovered canvas' },
        agentCopies: [{ id: C, name: 'Recovered canvas copy', agentCopy: { agent: 'Codex' } }] })} />);
    expect(screen.getByText('Codex’s changes were saved as their own project, “Recovered canvas copy”.')).toBeTruthy();
  });

  it('rendered: the copy waiting on home', () => {
    render(<ProjectHome {...base} canvasNotFiled={{ reason: 'projects', projectLimit: 500,
      canvases: [{ name: null, agentCopy: { agent: 'Codex' } }] }} />);
    expect(screen.getByText(/^Codex’s copy of your canvas isn’t saved as a project yet/)).toBeTruthy();
  });
});

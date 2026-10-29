/**
 * Fix round 10 of PR #199. GM r12: each waiting line has its own count (the
 * person's canvas is saved first, so its line counts only what it needs;
 * an agent's copy's counts the total), the copy's over-limit tail, and
 * [Save as a project] beside the line a restore leaves when this tab's edits
 * weren't saved, with its toast naming the project. GM r13, 2: the copy's
 * size-cap waiting line.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import { agentCopySavedLine, agentCopyWaitingLine, canvasWaitingLine, editsRecoveredToast, SAVE_AS_A_PROJECT } from './catalogRestoreCopy';
import { RESTORED_LIST_UNSAVED } from '../../store/projectStore';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}),
    subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() },
}));

const base = { projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;
const LIMIT = { projectLimit: 4, trashHasItems: false };

describe('GM r12, 2: each waiting line its own count, the person first', () => {
  it("the person's line counts what it needs, the copy's line the total", () => {
    expect(canvasWaitingLine('projects', { ...LIMIT, deletes: 2,
      canvases: [{ name: null, deletes: 1 }, { name: null, agentCopy: { agent: 'Codex' }, deletes: 2 }] }))
      .toBe("The canvas you had open isn’t saved as a project yet because you’ve reached the limit of 4 projects. "
        + 'Nothing in it is lost. Delete a project and Nebula will save it. '
        + "Codex’s copy of your canvas isn’t saved as a project yet because you’ve reached the limit of 4 projects. "
        + 'Nothing in it is lost. Delete 2 projects and Nebula will save it.');
  });

  it('a copy alone waiting counts what it needs', () => {
    expect(canvasWaitingLine('projects', { ...LIMIT, deletes: 1,
      canvases: [{ name: null, agentCopy: { agent: null }, deletes: 1 }] }))
      .toBe("An agent’s copy of your canvas isn’t saved as a project yet because you’ve reached the limit of 4 projects. "
        + 'Nothing in it is lost. Delete a project and Nebula will save it.');
  });

  it('rendered on home with the listing’s per-canvas counts', () => {
    render(<ProjectHome {...base} canvasNotFiled={{ reason: 'projects', projectLimit: 4, deletes: 2,
      canvases: [{ name: null, deletes: 1 }, { name: null, agentCopy: { agent: 'Codex' }, deletes: 2 }] }} />);
    expect(screen.getByText(/Codex’s copy of your canvas .* Delete 2 projects and Nebula will save it\.$/)).toBeTruthy();
    expect(screen.getByText(/^The canvas you had open isn’t saved .* Delete a project and Nebula will save it\. Codex’s/)).toBeTruthy();
  });
});

describe('GM r13, 2: the copy at the size cap', () => {
  it('"Nothing in it is lost." then the singular size advice, by whether Recently deleted has items', () => {
    expect(agentCopyWaitingLine('Codex', 'storage', { projectLimit: 500, trashHasItems: true }))
      .toBe("Codex’s copy of your canvas isn’t saved as a project yet because Nebula’s project list is full. "
        + 'Nothing in it is lost. Permanently delete a project in Recently deleted and Nebula will save it.');
    expect(agentCopyWaitingLine('Codex', 'storage', { projectLimit: 500, trashHasItems: false }))
      .toBe("Codex’s copy of your canvas isn’t saved as a project yet because Nebula’s project list is full. "
        + 'Nothing in it is lost. Delete a project, then remove it from Recently deleted too, and Nebula will save it.');
  });
});

describe('GM r12, 3: the saved copy over the save limit', () => {
  it('verbatim, named or not', () => {
    expect(agentCopySavedLine('Codex', 'X copy', true))
      .toBe("Codex’s changes were saved as their own project, “X copy”. It’s over the save limit, so new changes to it won’t save until it’s smaller.");
    expect(agentCopySavedLine(null, 'X copy', true))
      .toBe("An agent’s changes were saved as their own project, “X copy”. It’s over the save limit, so new changes to it won’t save until it’s smaller.");
  });
});

describe('GM r12, 1: [Save as a project] after a restore stopped this tab’s edits', () => {
  it('the whole line, and the button runs the save', () => {
    const onRetry = vi.fn();
    render(<ProjectHome {...base} error={RESTORED_LIST_UNSAVED} retry="save" onRetry={onRetry} />);
    expect(screen.getByText("Nebula restored its project list before your latest edits were saved. They’re kept in this tab.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: SAVE_AS_A_PROJECT }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(SAVE_AS_A_PROJECT).toBe('Save as a project');
  });

  it('the saved toast names the project', () => {
    render(<ProjectHome {...base} editsRecoveredAs={{ id: 'p', name: 'Delta (recovered)' }} />);
    expect(screen.getByText(editsRecoveredToast('Delta (recovered)'))).toBeTruthy();
    // GM r14 on PR #199, 1, verbatim.
    expect(editsRecoveredToast('Delta (recovered)')).toBe('Your latest edits were saved as their own project, “Delta (recovered)”.');
  });
});

/**
 * Fix round 13 of PR #199 (GM r17): "Delete a project and Nebula will save
 * it." stays at the limit; past it (a list an Undo took over the limit, then
 * a canvas waiting) the line names the number: "Delete 2 projects and Nebula
 * will save it.", on the Projects home's waiting line, in the restore
 * notice, and in an agent copy's own line. The listing's per-canvas counts
 * reach the store, so each line has its own.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import { canvasLimitLine, canvasWaitingLine } from './catalogRestoreCopy';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));

const base = { projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;
const AT = 'The canvas you had open isn’t saved as a project yet because you’ve reached the limit of 500 projects. Nothing in it is lost.';

describe('GM r17: the person’s line names the number past the limit', () => {
  it('at the limit (one delete): "Delete a project and Nebula will save it."', () => {
    expect(canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: false, canvases: [{ name: null, deletes: 1 }], deletes: 1 }))
      .toBe(`${AT} Delete a project and Nebula will save it.`);
    // A listing with no count says the same.
    expect(canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: false }))
      .toBe(`${AT} Delete a project and Nebula will save it.`);
  });

  it('past it: "Delete 2 projects and Nebula will save it.", in the waiting line and the restore notice', () => {
    const context = { projectLimit: 500, trashHasItems: false, canvases: [{ name: null, deletes: 2 }], deletes: 2 };
    expect(canvasWaitingLine('projects', context)).toBe(`${AT} Delete 2 projects and Nebula will save it.`);
    expect(canvasLimitLine('projects', context)).toBe(
      'The canvas you had open couldn’t be saved as its own project because you’ve reached the limit of 500 projects. '
      + 'Nothing in it is lost. Delete 2 projects and Nebula will save it.');
    // The total alone (an older listing without per-canvas counts) counts too.
    expect(canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: false, deletes: 3 }))
      .toBe(`${AT} Delete 3 projects and Nebula will save it.`);
  });

  it("each line its own count: the person's 2, Codex's copy 3", () => {
    const line = canvasWaitingLine('projects', { projectLimit: 500, trashHasItems: false, deletes: 3,
      canvases: [{ name: null, deletes: 2 }, { name: null, agentCopy: { agent: 'Codex' }, deletes: 3 }] });
    expect(line).toBe(`${AT} Delete 2 projects and Nebula will save it. `
      + 'Codex’s copy of your canvas isn’t saved as a project yet because you’ve reached the limit of 500 projects. '
      + 'Nothing in it is lost. Delete 3 projects and Nebula will save it.');
  });

  it('the size cap never gives a number', () => {
    expect(canvasWaitingLine('storage', { projectLimit: 500, trashHasItems: true, deletes: 2 })).not.toMatch(/Delete 2/);
  });

  it('renders on the Projects home', () => {
    render(<ProjectHome {...base} canvasNotFiled={{ reason: 'projects', projectLimit: 3, canvases: [{ name: null, deletes: 2 }], deletes: 2 }} />);
    expect(screen.getByText(/Delete 2 projects and Nebula will save it\.$/)).toBeTruthy();
  });
});

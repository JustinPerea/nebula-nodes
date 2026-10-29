/**
 * Fix round 11 of PR #199 (GM r14 and r15; review 11, Q9).
 * - GM r14, 2: one canvas of the person's always gets "Delete a project";
 *   "Delete N projects" only when several of theirs wait; the size cap never
 *   gives a number.
 * - GM r14, 1 and 3: the saved toast, and the agent-closed line as a toast
 *   on Projects home.
 * - GM r15, Q11: the kept line with [Save as a project] in the canvas
 *   notice region, until resolved.
 * - Q9: a `#moodboard/<id>` link that waited while the tab followed an
 *   agent's switch doesn't count as the person's own open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}` }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: { setViewing: vi.fn(), notePersonAct: vi.fn(), connect: vi.fn(), subscribe: vi.fn(() => () => {}),
    subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() },
}));

import { ProjectHome, type ProjectHomeProps } from './ProjectHome';
import { KeptEditsNotice } from './KeptEditsNotice';
import { agentClosedLine, canvasHeldLogLine, canvasLimitLine, canvasWaitingLine, editsRecoveredToast, SAVE_AS_A_PROJECT } from './catalogRestoreCopy';
import { RESTORED_LIST_UNSAVED, useProjectStore } from '../../store/projectStore';
import { useMoodboardDeepLink } from '../../hooks/useMoodboardDeepLink';
import { useUIStore } from '../../store/uiStore';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../../lib/canvasFollow';
import { pulseKeptCanvas, resetKeptCanvasForTests } from '../../lib/keptCanvas';
import { setProjectContext } from '../../lib/projectContext';
import { wsClient } from '../../lib/wsClient';

const base = { projects: [], loading: false, busy: false, error: null,
  onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;
const LIMIT = { projectLimit: 4, trashHasItems: false };

afterEach(() => {
  resetKeptCanvasForTests();
  resetCanvasFollowForTests();
  setProjectContext(null);
  window.history.replaceState(null, '', '/');
});

describe("GM r14, 2: the person's line counts only when several of theirs wait", () => {
  // GM r17 (fix round 13) superseded "whatever the listing counts": past the
  // limit one canvas of theirs names the number too (catalogRestore.fix13).
  it('one canvas of theirs: "Delete a project" at the limit, the number past it', () => {
    for (const line of [canvasWaitingLine, canvasLimitLine]) {
      expect(line('projects', { ...LIMIT, deletes: 1, canvases: [{ name: 'Alpha', deletes: 1 }] }))
        .toMatch(/Nothing in it is lost\. Delete a project and Nebula will save it\.$/);
      expect(line('projects', { ...LIMIT, deletes: 3, canvases: [{ name: 'Alpha', deletes: 3 }] }))
        .toMatch(/Nothing in it is lost\. Delete 3 projects and Nebula will save it\.$/);
    }
  });

  it('several of theirs: the real number, "…and Nebula will save them."', () => {
    expect(canvasWaitingLine('projects', { ...LIMIT, deletes: 2, canvases: [{ name: 'A', deletes: 1 }, { name: 'B', deletes: 2 }] }))
      .toBe("The canvases you had open, “A” and “B”, aren’t saved as projects yet because you’ve reached the limit of 4 projects. "
        + 'Nothing in them is lost. Delete 2 projects and Nebula will save them.');
  });

  it('the size cap never gives a number', () => {
    const line = canvasWaitingLine('storage', { ...LIMIT, deletes: 3, canvases: [{ name: 'A', deletes: 3 }] });
    expect(line).toBe("The canvas you had open isn’t saved as a project yet because Nebula’s project list is full. "
      + 'Nothing in it is lost. Delete a project, then remove it from Recently deleted too, and Nebula will save it.');
    expect(line).not.toMatch(/\d/);
  });
});

describe('GM r14, 1 and 3; GM r15, Q10: the lines, verbatim', () => {
  it('the saved toast', () => {
    expect(editsRecoveredToast('Alpha (recovered)')).toBe('Your latest edits were saved as their own project, “Alpha (recovered)”.');
  });

  it('the agent-closed lines, "An agent" when unknown', () => {
    expect(agentClosedLine('Codex', 'clear', 'X')).toBe('Codex cleared the canvas. “X” is kept as its own project.');
    expect(agentClosedLine('Codex', 'replace', 'X')).toBe('Codex replaced the canvas. “X” is kept as its own project.');
    expect(agentClosedLine('Codex', 'change', 'X')).toBe('Codex made its changes on a copy of “X”. “X” is kept as it was.');
    expect(agentClosedLine(null, 'clear', 'X')).toBe('An agent cleared the canvas. “X” is kept as its own project.');
  });

  it('the log row: "kept" for a canvas that already was a project, "saved" for one that wasn\'t', () => {
    expect(canvasHeldLogLine('Codex', 'changed', 'My film', true, true))
      .toBe('Codex made its changes on a copy of “My film”. “My film” is kept as it was.');
    expect(canvasHeldLogLine('Codex', 'changed', 'Recovered canvas', true, false))
      .toBe('Codex changed a copy of the canvas you had open. The original was saved as its own project, “Recovered canvas”.');
  });

  it('Projects home shows the agent-closed line as a toast', () => {
    const onDismiss = vi.fn();
    render(<ProjectHome {...base} agentClosedNote={{ id: 's1', text: agentClosedLine('Codex', 'clear', 'Recovered canvas') }}
      onDismissAgentClosedNote={onDismiss} />);
    expect(screen.getByText('Codex cleared the canvas. “Recovered canvas” is kept as its own project.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('GM r15, Q11: the kept line in the canvas notice region', () => {
  const kept = { sourceId: 'p1', sourceName: 'Delta', lead: null, saving: false, error: null };

  it('the line and [Save as a project]; no Dismiss; the click saves', () => {
    const saveKeptEdits = vi.fn(async () => {});
    useProjectStore.setState({ screen: 'workspace', keptEdits: kept, saveKeptEdits });
    render(<KeptEditsNotice />);
    expect(screen.getByText(RESTORED_LIST_UNSAVED)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: SAVE_AS_A_PROJECT }));
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
  });

  it('disabled while saving; a failure says why under the line; a refused edit pulses it', () => {
    useProjectStore.setState({ screen: 'workspace', keptEdits: { ...kept, saving: true } });
    const { container, rerender } = render(<KeptEditsNotice />);
    expect((screen.getByRole('button', { name: SAVE_AS_A_PROJECT }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { useProjectStore.setState({ keptEdits: { ...kept, error: "Couldn’t save your edits." } }); });
    rerender(<KeptEditsNotice />);
    expect(screen.getByRole('alert').textContent).toBe("Couldn’t save your edits.");
    act(() => { pulseKeptCanvas(Date.now() + 10_000); });
    expect(container.querySelector('.kept-edits-notice--pulse')).not.toBeNull();
  });

  it('not on Projects home', () => {
    useProjectStore.setState({ screen: 'home', keptEdits: kept });
    const { container } = render(<KeptEditsNotice />);
    expect(container.textContent).toBe('');
    useProjectStore.setState({ keptEdits: null });
  });
});

describe('review 11, Q9: a #moodboard link counts only when the person\'s navigation opens the project', () => {
  const notePersonAct = vi.mocked(wsClient.notePersonAct);

  it("the link loaded with the page goes into the open project as the person's open", () => {
    notePersonAct.mockClear();
    setProjectContext({ id: 'proj1', revision: 'r1' });
    useUIStore.setState({ viewMode: 'canvas', moodboardEditorId: null });
    useProjectStore.setState({ screen: 'home', initialized: true, busy: false, activeProject: { id: 'proj1', name: 'P' } as never });
    window.history.replaceState(null, '', '/#moodboard/b1');
    const hook = renderHook(() => useMoodboardDeepLink());
    expect(notePersonAct).toHaveBeenCalledWith('personOpen', 'proj1');
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    hook.unmount();
  });

  it("a link that waited while the tab followed an agent's switch doesn't say the person opened it", () => {
    notePersonAct.mockClear();
    useUIStore.setState({ viewMode: 'canvas', moodboardEditorId: null });
    useProjectStore.setState({ screen: 'home', initialized: false, busy: false, activeProject: null });
    window.history.replaceState(null, '', '/#moodboard/b1');
    const hook = renderHook(() => useMoodboardDeepLink());
    // Codex opens P: the tab follows, and lands on Projects with P loaded.
    act(() => { setFollowingSwitch({ agent: 'Codex', projectName: 'P' } as never); });
    act(() => { setFollowingSwitch(null); });
    setProjectContext({ id: 'proj1', revision: 'r1' });
    act(() => { useProjectStore.setState({ initialized: true, activeProject: { id: 'proj1', name: 'P' } as never }); });
    expect(notePersonAct).not.toHaveBeenCalled();
    expect(useProjectStore.getState().screen).toBe('workspace');
    expect(useUIStore.getState()).toMatchObject({ viewMode: 'moodboard-editor', moodboardEditorId: 'b1' });
    hook.unmount();
  });
});

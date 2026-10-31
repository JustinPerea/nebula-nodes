/**
 * Round 15 of PR #199 (GM r19 and r20; review 13), the kept tab's own side.
 * - GM r19, 5: kept Undo covers typing and a rename (as normal Undo does),
 *   an added node is the kept tab's own (a local node, one step), and an
 *   empty kept Undo reads disabled wherever its button shows.
 * - Review 13 kept-scratch LOW-4: the mutants that survived (redo
 *   truncation, the bottom bar's kept Clear, refuseTabOnlyEdit while the save
 *   is on its way, a typing-then-redo round trip, the stale notice button,
 *   the bottom bar's Arrange) each have a test now.
 * - GM r19, 4 and r20: the lock order (kept first) and the routes that
 *   replace the canvas hold with their kept lines.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}),
  disconnect: vi.fn(), send: vi.fn(), setViewing: vi.fn(), notePersonAct: vi.fn(), setKeptEdits: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(), getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    screenToFlowPosition: (point: { x: number; y: number }) => point }),
  useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
    selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));

import { CanvasUndoNotice, NOTHING_TO_REDO, NOTHING_TO_UNDO } from '../src/components/canvas/CanvasUndoNotice';
import { Toolbar } from '../src/components/panels/Toolbar';
import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { CommandPalette } from '../src/components/CommandPalette';
import { ReactFlowProvider } from '@xyflow/react';
import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { OpenCopyButton } from '../src/components/canvas/OpenCopyButton';
import { KeptEditsNotice, DISCARD_KEPT_OFFLINE, SAVE_KEPT_OFFLINE } from '../src/components/projects/KeptEditsNotice';
import { DISCARD_EDITS, DISCARD_KEPT_BODY, DISCARD_KEPT_TITLE, KEEP_THEM } from '../src/components/projects/KeptDiscardConfirm';
import { keepCanvasLocally, releaseKeptCanvas, useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { useUIStore } from '../src/store/uiStore';
import { KEPT_MARK, canvasLockOf, lockedAction, refuseTabOnlyEdit } from '../src/lib/canvasLock';
import { RUN_LOCK_REASON } from '../src/lib/cinemaScene';
import { keptLockTitle, resetKeptCanvasForTests, setKeptCanvasSaving, subscribeKeptPulse } from '../src/lib/keptCanvas';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { offlineReason } from '../src/lib/useBackendOffline';

function node(id: string, x = 0, selected = false): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 }, selected,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, outputs: {}, state: 'idle' },
  };
}
const wire = (id: string, source: string, target: string): Edge => ({ id, source, target, type: 'typed-edge' });
const SAVED_STEP = { nodes: [node('n1'), node('n2', 400), node('n3', 800)], edges: [], savedHistory: true } as never;
const ids = () => useGraphStore.getState().nodes.map((n) => n.id);
const values = () => useGraphStore.getState().nodes.map((n) => String(n.data.params.value));
const labels = () => useGraphStore.getState().nodes.map((n) => n.data.label);
const type = (id: string, value: string) => {
  const current = useGraphStore.getState().nodes.find((n) => n.id === id)!;
  useGraphStore.getState().updateNodeData(id, { params: { ...current.data.params, value } });
};
let fetchSpy: ReturnType<typeof vi.spyOn>;
let pulses = 0;
let stopPulses: () => void = () => {};
let clock = 100_000;
const initialProject = useProjectStore.getState();

beforeEach(() => {
  resetKeptCanvasForTests();
  useGraphStore.setState({
    nodes: [node('n1'), node('n2', 400), node('n3', 800)], edges: [wire('e1', 'n1', 'n2'), wire('e2', 'n2', 'n3')],
    isExecuting: false, undoStack: [SAVED_STEP], redoStack: [], keptUndo: [], keptRedo: [], undoNotice: null,
  });
  keepCanvasLocally();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  pulses = 0;
  clock = 100_000;
  // Each call a step apart (2 s) unless a test holds the clock.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 2000));
  stopPulses = subscribeKeptPulse(() => { pulses += 1; });
});
afterEach(() => {
  cleanup();
  stopPulses();
  releaseKeptCanvas();
  resetKeptCanvasForTests();
  resetBackendConnectionForTests();
  useProjectStore.setState(initialProject, true);
  vi.restoreAllMocks();
});

function expectTabOnly() {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(useGraphStore.getState().undoStack).toEqual([SAVED_STEP]);
  expect(useGraphStore.getState().redoStack).toEqual([]);
}

describe('GM r19 (5): kept Undo covers typing and a rename', () => {
  it('typing is a kept step: Undo puts the value back, Redo brings it again; nothing is sent', () => {
    type('n1', 'n1 typed');
    expect(useGraphStore.getState().keptUndo).toHaveLength(1);
    useGraphStore.getState().undo();
    expect(values()).toEqual(['n1', 'n2', 'n3']);
    useGraphStore.getState().redo();
    expect(values()).toEqual(['n1 typed', 'n2', 'n3']);
    expectTabOnly();
    expect(pulses).toBe(0);
  });

  it('typing within 500 ms on one node is one step, as normal Undo takes it', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 100));
    type('n1', 'n');
    type('n1', 'n1');
    type('n1', 'n1 t');
    expect(useGraphStore.getState().keptUndo).toHaveLength(1);
    useGraphStore.getState().undo();
    expect(values()).toEqual(['n1', 'n2', 'n3']);
  });

  it('a rename is live and a kept step (review 13 kept-scratch LOW-2): the typed name stays; Undo puts the old one back', () => {
    useGraphStore.getState().renameNode('n2', 'Hero prompt');
    expect(labels()).toEqual(['Text Input', 'Hero prompt', 'Text Input']);
    expect(pulses).toBe(0);
    useGraphStore.getState().undo();
    expect(labels()).toEqual(['Text Input', 'Text Input', 'Text Input']);
    useGraphStore.getState().redo();
    expect(labels()[1]).toBe('Hero prompt');
    expectTabOnly();
  });

  it('M13: typing into a copy, then Undo and Redo, keeps what was typed (the step is taken as the canvas has it)', () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((n) => ({ ...n, selected: n.id === 'n3' })) }));
    useGraphStore.getState().duplicateSelected();
    const copy = ids()[3];
    type(copy, 'copy typed');
    useGraphStore.getState().undo(); // the typing
    useGraphStore.getState().undo(); // the copy
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    useGraphStore.getState().redo(); // the copy, as it was
    useGraphStore.getState().redo(); // the typing
    expect(useGraphStore.getState().nodes.find((n) => n.id === copy)?.data.params.value).toBe('copy typed');
    // Taken off again with the typing, it comes back with it.
    useGraphStore.getState().undo();
    useGraphStore.getState().undo();
    useGraphStore.getState().redo();
    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes.find((n) => n.id === copy)?.data.params.value).toBe('copy typed');
    expectTabOnly();
  });

  it('M4: a new kept edit after Undo empties Redo, and Redo then changes nothing', () => {
    useGraphStore.getState().deleteNode('n1');
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().keptRedo).toHaveLength(1);
    type('n2', 'n2 typed');
    expect(useGraphStore.getState().keptRedo).toEqual([]);
    useGraphStore.getState().redo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('GM r19 (5): adding a node is the kept tab’s own', () => {
  it('a library add puts a local node on this tab (no request), one step Undo takes off', async () => {
    const added = await useGraphStore.getState().addNode('text-input', { x: 50, y: 60 });
    expect(added).toBeTruthy();
    expect(ids()).toEqual(['n1', 'n2', 'n3', added]);
    const made = useGraphStore.getState().nodes.at(-1)!;
    expect(made).toMatchObject({ type: 'model-node', position: { x: 50, y: 60 }, data: { definitionId: 'text-input', state: 'idle' } });
    expect(pulses).toBe(0);
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    useGraphStore.getState().redo();
    expect(ids()).toEqual(['n1', 'n2', 'n3', added]);
    expectTabOnly();
  });

  it('the library’s click and the palette’s node command add while kept (they were refused before the store saw them)', async () => {
    useUIStore.setState((state) => ({ libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
      panels: { ...state.panels, library: { ...state.panels.library, visible: true } } }));
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse Text nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Text Input' }));
    await act(async () => { await Promise.resolve(); });
    expect(ids()).toHaveLength(4);
    cleanup();
    render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Text Input' } });
    // The node command (not the canvas search's "on canvas · focus" row).
    const item = screen.getAllByRole('button', { name: /^Text Input/ }).find((b) => !/on canvas/.test(b.textContent ?? ''))!;
    expect(item).toBeEnabled();
    fireEvent.click(item);
    await act(async () => { await Promise.resolve(); });
    expect(ids()).toHaveLength(5);
    expect(useGraphStore.getState().keptUndo.filter((step) => step.kind === 'add')).toHaveLength(2);
    expect(pulses).toBe(0);
    expectTabOnly();
  });

  it('a library node dropped on the canvas takes the tab-only gate (files and assets refuse further in)', () => {
    const canvas = readFileSync(resolve(__dirname, '../src/components/Canvas.tsx'), 'utf8');
    const drop = canvas.slice(canvas.indexOf('const onDrop = useCallback('), canvas.indexOf('const onDragOver'));
    expect(drop).toContain('if (refuseTabOnlyEdit()) return;');
    expect(drop).not.toContain('refuseCanvasEdit()');
  });

  it('while [Save as a project] is on its way, an add is refused with a pulse', async () => {
    setKeptCanvasSaving(true);
    expect(await useGraphStore.getState().addNode('text-input', { x: 0, y: 0 })).toBeNull();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(pulses).toBe(1);
  });
});

describe('review 13 kept-scratch LOW-4: the surviving mutants', () => {
  it('M10: refuseTabOnlyEdit refuses (and pulses) while [Save as a project] is on its way, and lets typing through before', () => {
    expect(refuseTabOnlyEdit()).toBe(false);
    setKeptCanvasSaving(true);
    expect(refuseTabOnlyEdit()).toBe(true);
    expect(pulses).toBe(1);
  });

  it('M17: the bottom bar’s Arrange (autoLayout) is a kept step too', () => {
    const before = useGraphStore.getState().nodes.map((n) => ({ ...n.position }));
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((n, index) => ({ ...n, position: { x: 0, y: index } })) }));
    const scrambled = useGraphStore.getState().nodes.map((n) => ({ ...n.position }));
    useGraphStore.getState().autoLayout();
    expect(useGraphStore.getState().keptUndo).toHaveLength(1);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes.map((n) => n.position)).toEqual(scrambled);
    void before;
    expectTabOnly();
  });

  it('M8: the bottom bar’s Clear while kept asks its own confirm, sends nothing and is one kept step', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: /Canvas actions/ }));
    fireEvent.click(screen.getByRole('button', { name: /Clear canvas/ }));
    expect(confirm).toHaveBeenCalledWith('Clear the canvas? 3 nodes will be removed. Undo brings them back.');
    expect(ids()).toEqual([]);
    expect(useGraphStore.getState().keptUndo).toHaveLength(1);
    act(() => useGraphStore.getState().undo());
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expectTabOnly();
  });

  it('M14 and GM r19 (5): a kept notice whose step is no longer on top reads disabled; an empty stack too', () => {
    render(<CanvasUndoNotice />);
    act(() => useGraphStore.getState().deleteNode('n1'));
    expect(screen.getByRole('button', { name: 'Undo' })).not.toBeDisabled();
    // A newer kept step: the notice's step isn't next any more.
    act(() => type('n2', 'n2 typed'));
    const stale = screen.getByRole('button', { name: 'Undo' });
    expect(stale).toBeDisabled();
    expect(stale).toHaveAttribute('title', NOTHING_TO_UNDO);
    fireEvent.click(stale);
    expect(values()).toEqual(['n2 typed', 'n3']);
    // Undo both: the notice offers Redo for the delete; a new edit empties Redo.
    act(() => { useGraphStore.getState().undo(); useGraphStore.getState().undo(); });
    expect(screen.getByRole('button', { name: 'Redo' })).not.toBeDisabled();
    act(() => type('n3', 'n3 typed'));
    expect(useGraphStore.getState().keptRedo).toEqual([]);
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveAttribute('title', NOTHING_TO_REDO);
  });
});

describe('GM r19 (4): kept first in the lock order', () => {
  it('the bottom Run while kept shows the kept line and mark over a follow and offline', () => {
    noteBackendConnection('offline');
    render(<Toolbar />);
    const run = screen.getByRole('button', { name: /^Run/ });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', keptLockTitle('run-nodes'));
    expect(run).toHaveAttribute(KEPT_MARK);
    expect(run).not.toHaveAttribute('data-offline-disabled');
  });

  it('merge-integrity LOW-2 (M2): unkept and offline, a control the run holds says the run’s line, not the offline one', () => {
    const props = lockedAction(canvasLockOf(null, true, false), { title: 'Generate', kept: 'generate' }, { verb: 'generate', run: true });
    expect(props.title).toBe(RUN_LOCK_REASON);
    expect(props.title).not.toBe(offlineReason('generate'));
  });
});

describe('GM r20: the routes that would replace a kept canvas hold, each with its own verb', () => {
  it('Back to projects, Open copy: disabled with the kept mark and their lines; the lines name both ways out', () => {
    useProjectStore.setState({ activeProject: { id: 'alpha', name: 'Alpha' } as never, screen: 'workspace' });
    render(<><ProjectWorkspaceControls /><OpenCopyButton projectId="copy" onOpen={() => {}} /></>);
    const home = screen.getByRole('button', { name: 'Back to projects' });
    expect(home).toBeDisabled();
    expect(home).toHaveAttribute(KEPT_MARK);
    expect(home).toHaveAttribute('title', 'You can go to Projects after you save it as a project or discard the kept edits.');
    const open = screen.getByRole('button', { name: 'Open copy' });
    expect(open).toHaveAttribute('title', 'You can open another project after you save it as a project or discard the kept edits.');
    expect(keptLockTitle('create')).toBe('You can create a project after you save it as a project or discard the kept edits.');
    expect(keptLockTitle('load')).toBe('You can load a graph after you save it as a project or discard the kept edits.');
    expect(keptLockTitle('import')).toBe('You can import a graph after you save it as a project or discard the kept edits.');
    // Unkept, they're as before.
    act(() => releaseKeptCanvas());
    expect(screen.getByRole('button', { name: 'Back to projects' })).toHaveAttribute('title', 'Projects');
    expect(screen.getByRole('button', { name: 'Back to projects' })).not.toBeDisabled();
  });

  it('the bottom bar’s Load and Import show their own kept lines', () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: /Canvas actions/ }));
    expect(screen.getByRole('button', { name: /Load graph/ })).toHaveAttribute('title', keptLockTitle('load'));
    expect(screen.getByRole('button', { name: /Import CLI graph/ })).toHaveAttribute('title', keptLockTitle('import'));
  });

  it('GM r19 (2): Forget ID has its own verb, verbatim, at both of its controls', () => {
    expect(keptLockTitle('forget')).toBe('You can forget the ID after you save it as a project.');
    for (const file of ['components/panels/RunHistoryPanel.tsx', 'components/panels/ForgetRecoveryConfirm.tsx']) {
      const source = readFileSync(resolve(__dirname, '../src', file), 'utf8');
      expect(source, file).toMatch(/kept: 'forget'/);
      expect(source, file).not.toMatch(/kept: 'unlock'/);
    }
  });
});

describe('GM r20: [Save as a project] [Discard edits] on the kept line', () => {
  beforeEach(() => {
    useProjectStore.setState({ screen: 'workspace', activeProject: { id: 'alpha', name: 'Alpha' } as never,
      keptEdits: { sourceId: 'alpha', sourceName: 'Alpha', lead: null, saving: false, error: null } });
  });

  it('Discard asks first: GM’s title, body and buttons, focus on [Keep them]; Keep them and Escape change nothing', () => {
    const discard = vi.spyOn(useProjectStore.getState(), 'discardKeptEdits');
    render(<KeptEditsNotice />);
    fireEvent.click(screen.getByRole('button', { name: DISCARD_EDITS }));
    const dialog = screen.getByRole('alertdialog', { name: DISCARD_KEPT_TITLE });
    expect(dialog).toHaveTextContent(DISCARD_KEPT_BODY);
    expect(DISCARD_KEPT_TITLE).toBe('Discard the kept edits?');
    expect(DISCARD_KEPT_BODY).toBe('They’re only in this tab, so they can’t be brought back.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: KEEP_THEM }));
    fireEvent.click(screen.getByRole('button', { name: KEEP_THEM }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: DISCARD_EDITS }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it('[Discard edits] in the confirm discards', () => {
    const discard = vi.spyOn(useProjectStore.getState(), 'discardKeptEdits').mockResolvedValue();
    render(<KeptEditsNotice />);
    fireEvent.click(screen.getByRole('button', { name: DISCARD_EDITS }));
    const inDialog = screen.getAllByRole('button', { name: DISCARD_EDITS }).find((button) => button.closest('[role="alertdialog"]'))!;
    fireEvent.click(inDialog);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('GM r19 (4): each button names its own blocker: a run’s line, then its own offline line', () => {
    useGraphStore.setState({ isExecuting: true });
    const view = render(<KeptEditsNotice />);
    for (const name of ['Save as a project', DISCARD_EDITS]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
      expect(screen.getByRole('button', { name })).toHaveAttribute('title', RUN_LOCK_REASON);
    }
    act(() => useGraphStore.setState({ isExecuting: false }));
    act(() => noteBackendConnection('offline'));
    view.rerender(<KeptEditsNotice />);
    expect(screen.getByRole('button', { name: 'Save as a project' })).toHaveAttribute('title', SAVE_KEPT_OFFLINE);
    expect(screen.getByRole('button', { name: DISCARD_EDITS })).toHaveAttribute('title', DISCARD_KEPT_OFFLINE);
    expect(SAVE_KEPT_OFFLINE).toBe('You can save it as a project when Nebula reconnects.');
    expect(screen.getByRole('button', { name: 'Save as a project' })).toBeDisabled();
  });
});

// Keep the UI store's selection from leaking between files.
afterEach(() => { useUIStore.setState({ selectedNodeId: null }); });

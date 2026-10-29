import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { NodeSettingsAction } from '../src/components/nodes/NodeSettingsAction';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { canvasLockOf, KEPT_MARK } from '../src/lib/canvasLock';
import { KEPT_LOCK_TITLES, resetKeptCanvasForTests, setCanvasKept, subscribeKeptPulse } from '../src/lib/keptCanvas';
import { setSelectionActionSlot } from '../src/lib/selectionActionSlot';

/**
 * GM r16 on PR #199, 4: while the canvas is kept in this tab after a
 * restore, every control that writes or spends is disabled in the shared
 * disabled look, its tooltip saying what unlocks it; Copy, Download and
 * typing stay live; the lock reasons go kept, run, follow, offline; the
 * keyboard shortcuts for the disabled actions are refused the same way.
 */
const original = {
  executeNode: useGraphStore.getState().executeNode,
  executeCluster: useGraphStore.getState().executeCluster,
};

function node(id: string, x = 0): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 }, selected: true,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, outputs: {}, state: 'idle' },
  };
}

beforeEach(() => {
  resetKeptCanvasForTests();
  useGraphStore.setState({ nodes: [node('n1'), node('n2', 400)], edges: [], isExecuting: false, clipboard: null,
    undoStack: [], redoStack: [], ...original });
  useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: false } } }));
});
afterEach(() => {
  resetKeptCanvasForTests();
  vi.restoreAllMocks();
});

const button = (name: RegExp) => screen.getByRole('button', { name });

describe('GM r16, 4: the selection toolbar while the canvas is kept', () => {
  it('disables Ask, Run, Duplicate, Arrange and Delete with their own tooltips; Copy and Download stay', () => {
    render(<SelectionToolbar />);
    expect(button(/^Run selected nodes$/)).not.toBeDisabled();
    act(() => setCanvasKept(true));
    const locked: [RegExp, string][] = [
      [/^Ask$/, KEPT_LOCK_TITLES.ask], [/^Run selected nodes$/, KEPT_LOCK_TITLES.run],
      [/^Duplicate$/, KEPT_LOCK_TITLES.duplicate], [/^Arrange$/, KEPT_LOCK_TITLES.arrange],
      [/^Delete selected nodes$/, KEPT_LOCK_TITLES.delete],
    ];
    for (const [name, title] of locked) {
      const control = button(name);
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', title);
      expect(control).toHaveAttribute(KEPT_MARK, '');
    }
    expect(button(/^Copy$/)).not.toBeDisabled();
    expect(button(/^Copy$/)).not.toHaveAttribute(KEPT_MARK);
    // Download: disabled only for having no outputs, never by the kept lock.
    expect(button(/Download selected outputs/)).not.toHaveAttribute(KEPT_MARK);
    // Released: back as they were.
    act(() => setCanvasKept(false));
    expect(button(/^Run selected nodes$/)).not.toBeDisabled();
    expect(button(/^Duplicate$/)).toHaveAttribute('title', 'Duplicate selected nodes');
  });

  it('the exact tooltips', () => {
    expect(KEPT_LOCK_TITLES.run).toBe('You can run this after you save it as a project.');
    expect(KEPT_LOCK_TITLES.duplicate).toBe('You can duplicate this after you save it as a project.');
    expect(KEPT_LOCK_TITLES.delete).toBe('You can delete this after you save it as a project.');
    expect(KEPT_LOCK_TITLES.arrange).toBe('You can arrange this after you save it as a project.');
  });

  it("the Note and the node's Settings are disabled too", () => {
    useGraphStore.setState({ nodes: [node('n1')] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    const note = button(/^Note for agents$/);
    expect(note).toBeDisabled();
    expect(note).toHaveAttribute('title', KEPT_LOCK_TITLES.note);
    const slot = document.querySelector<HTMLElement>('.selection-toolbar__node-actions')!;
    act(() => setSelectionActionSlot(slot));
    render(<NodeSettingsAction id="n1" />);
    const settings = button(/^Show node settings$/);
    expect(settings).toBeDisabled();
    expect(settings).toHaveAttribute('title', KEPT_LOCK_TITLES.settings);
    expect(settings).toHaveAttribute(KEPT_MARK, '');
    act(() => setCanvasKept(false));
    expect(button(/^Show node settings$/)).not.toBeDisabled();
    expect(button(/^Show node settings$/)).toHaveAttribute('title', 'Show node settings');
  });
});

describe('GM r16, 4: the lock reasons go kept, run, follow, offline', () => {
  const following = { projectId: 'p', projectName: 'Delta' } as never;
  it('kept first, over a run, a follow and offline', () => {
    const lock = canvasLockOf(following, true, true);
    expect(lock.act({ busy: 'Wait for the active run to finish', title: 'Duplicate selected nodes', kept: 'duplicate' }))
      .toEqual({ [KEPT_MARK]: '', disabled: true, title: KEPT_LOCK_TITLES.duplicate });
    // Typing stays: fields read `locked`, which the kept canvas alone never sets.
    expect(canvasLockOf(null, false, true).locked).toBe(false);
  });
  it('then a run going, over a follow', () => {
    const act = canvasLockOf(following, false, false).act({ busy: 'Wait for the active run to finish', title: 'Duplicate selected nodes' });
    expect(act).toMatchObject({ disabled: true, title: 'Wait for the active run to finish' });
  });
  it('then the follow, then offline (no tooltip of its own)', () => {
    expect(canvasLockOf(following, true, false).act({ title: 'Duplicate selected nodes' }).title).toBe('Wait for “Delta” to open.');
    expect(canvasLockOf(null, true, false).act({ title: 'Duplicate selected nodes' })).toMatchObject({ disabled: true, title: 'Duplicate selected nodes' });
  });
  it('Settings stays live while following or offline, and only the kept canvas disables it', () => {
    expect(canvasLockOf(following, true, false).keptOnly('settings', 'Show node settings')).toEqual({ disabled: false, title: 'Show node settings' });
    expect(canvasLockOf(null, false, true).keptOnly('settings', 'Show node settings')).toEqual({ [KEPT_MARK]: '', disabled: true, title: KEPT_LOCK_TITLES.settings });
  });
});

describe('GM r16, 4: the keyboard shortcuts for the disabled actions are refused the same way', () => {
  it('Duplicate, Delete, Run, Arrange, Undo and Paste change nothing and send nothing, and each pulses the kept line', async () => {
    act(() => setCanvasKept(true));
    let pulses = 0;
    const stop = subscribeKeptPulse(() => { pulses += 1; });
    const before = useGraphStore.getState().nodes.map((n) => ({ ...n }));
    const store = useGraphStore.getState();
    const now = vi.spyOn(Date, 'now');
    let clock = 10_000;
    const each = async (name: string, run: () => unknown) => {
      clock += 2000; now.mockReturnValue(clock);
      const was = pulses;
      await run();
      expect(pulses, name).toBe(was + 1);
    };
    await each('duplicate (⌘D)', () => store.duplicateSelected());
    await each('delete (Delete)', () => store.deleteCanvasElements(['n1'], []));
    await each('run (⌘Enter)', () => store.executeGraph());
    await each('arrange', () => store.autoLayoutSelected());
    await each('undo (⌘Z)', () => store.undo());
    await each('paste (⌘V)', () => store.pasteClipboard({ view: null }));
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().nodes.map(({ id, position }) => ({ id, position })))
      .toEqual(before.map(({ id, position }) => ({ id, position })));
    stop();
  });

  it('a press on a disabled control pulses the kept line', async () => {
    const { KeptEditsNotice } = await import('../src/components/projects/KeptEditsNotice');
    const { useProjectStore } = await import('../src/store/projectStore');
    useProjectStore.setState({ screen: 'workspace', keptEdits: { sourceId: 'p', sourceName: 'Delta', lead: null, saving: false, error: null } });
    act(() => setCanvasKept(true));
    render(<><KeptEditsNotice /><SelectionToolbar /></>);
    let pulses = 0;
    const stop = subscribeKeptPulse(() => { pulses += 1; });
    vi.spyOn(Date, 'now').mockReturnValue(50_000);
    fireEvent.pointerDown(button(/^Duplicate$/));
    expect(pulses).toBe(1);
    stop();
    useProjectStore.setState({ keptEdits: null });
  });
});

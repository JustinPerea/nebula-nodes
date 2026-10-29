import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { NodeSettingsAction } from '../src/components/nodes/NodeSettingsAction';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { canvasLockOf, KEPT_MARK } from '../src/lib/canvasLock';
import {
  KEPT_GENERIC_LINE, keptLockTitle, resetKeptCanvasForTests, setCanvasKept, subscribeKeptPulse,
} from '../src/lib/keptCanvas';
import { buildCommands } from '../src/lib/commandPalette';
import { setSelectionActionSlot } from '../src/lib/selectionActionSlot';

/**
 * GM r16 and r17 on PR #199: while the canvas is kept in this tab after a
 * restore, every control that writes to Nebula or spends is disabled in the
 * shared disabled look, its tooltip saying what unlocks it, one line per
 * control (the generic line is only a safety net nobody sees). What only
 * changes this tab's canvas stays live: typing, Duplicate (its copies are
 * this tab's own nodes) and Settings (it opens the Inspector, whose param
 * edits are typing); Copy, Download, zoom, pan and the Agent log too. The
 * lock reasons go kept, run, follow, offline; the keyboard shortcuts for the
 * disabled actions are refused the same way.
 */
const original = {
  executeNode: useGraphStore.getState().executeNode,
  executeCluster: useGraphStore.getState().executeCluster,
};

function node(id: string, x = 0, outputs: NodeData['outputs'] = {}): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 }, selected: true,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: id }, outputs, state: 'idle' },
  };
}

beforeEach(() => {
  resetKeptCanvasForTests();
  window.localStorage.removeItem('nebula:chat-selection');
  useGraphStore.setState({ nodes: [node('n1'), node('n2', 400)], edges: [], isExecuting: false, clipboard: null,
    undoStack: [], redoStack: [], ...original });
  useUIStore.setState((state) => ({ panels: { ...state.panels, chat: { ...state.panels.chat, visible: false } } }));
});
afterEach(() => {
  resetKeptCanvasForTests();
  window.localStorage.removeItem('nebula:chat-selection');
  vi.restoreAllMocks();
});

const button = (name: RegExp) => screen.getByRole('button', { name });

describe('GM r16/r17: the selection toolbar while the canvas is kept', () => {
  it('disables Ask, Run, Arrange and Delete with their own lines; Copy, Download and Duplicate stay', () => {
    render(<SelectionToolbar />);
    expect(button(/^Run selected nodes$/)).not.toBeDisabled();
    act(() => setCanvasKept(true));
    const locked: [RegExp, string][] = [
      [/^Ask$/, keptLockTitle('ask')], [/^Run selected nodes$/, keptLockTitle('run')],
      [/^Arrange$/, keptLockTitle('arrange')], [/^Delete selected nodes$/, keptLockTitle('delete')],
    ];
    for (const [name, title] of locked) {
      const control = button(name);
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', title);
      expect(control).toHaveAttribute(KEPT_MARK, '');
    }
    for (const live of [/^Copy$/, /^Duplicate$/]) {
      expect(button(live)).not.toBeDisabled();
      expect(button(live)).not.toHaveAttribute(KEPT_MARK);
    }
    expect(button(/^Duplicate$/)).toHaveAttribute('title', 'Duplicate selected nodes');
    // Download: disabled only for having no outputs, never by the kept lock.
    expect(button(/Download selected outputs/)).not.toHaveAttribute(KEPT_MARK);
    act(() => setCanvasKept(false));
    expect(button(/^Run selected nodes$/)).not.toBeDisabled();
    expect(button(/^Arrange$/)).toHaveAttribute('title', 'Arrange selected nodes');
  });

  it('Download is live while kept when the selection has outputs (GM r17 bug: it only reads)', () => {
    useGraphStore.setState({ nodes: [node('n1', 0, { image: { type: 'Image', value: '/api/outputs/a.png' } as never })] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    const download = button(/Download selected outputs/);
    expect(download).not.toBeDisabled();
    expect(download).not.toHaveAttribute(KEPT_MARK);
    expect(download).toHaveAttribute('title', 'Download 1 selected output');
  });

  it("GM r17's lines, verbatim; Ask names the chat's agent", () => {
    expect(keptLockTitle('note')).toBe('You can add notes after you save it as a project.');
    expect(keptLockTitle('duplicate')).toBe('You can duplicate nodes after you save it as a project.');
    expect(keptLockTitle('arrange')).toBe('You can arrange nodes after you save it as a project.');
    expect(keptLockTitle('settings')).toBe('You can change settings after you save it as a project.');
    expect(keptLockTitle('run')).toBe('You can run this after you save it as a project.');
    expect(keptLockTitle('delete')).toBe('You can delete this after you save it as a project.');
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({ agent: 'codex' }));
    expect(keptLockTitle('ask')).toBe('You can ask Codex after you save it as a project.');
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({ agent: 'claude' }));
    expect(keptLockTitle('ask')).toBe('You can ask Claude after you save it as a project.');
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({ agent: 'personal:hermes' }));
    expect(keptLockTitle('ask')).toBe('You can ask your agent after you save it as a project.');
  });

  it("the Note is disabled; the node's Settings stays live (it opens the Inspector)", () => {
    useGraphStore.setState({ nodes: [node('n1')] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    const note = button(/^Note for agents$/);
    expect(note).toBeDisabled();
    expect(note).toHaveAttribute('title', keptLockTitle('note'));
    const slot = document.querySelector<HTMLElement>('.selection-toolbar__node-actions')!;
    act(() => setSelectionActionSlot(slot));
    render(<NodeSettingsAction id="n1" />);
    const settings = button(/^Show node settings$/);
    expect(settings).not.toBeDisabled();
    expect(settings).not.toHaveAttribute(KEPT_MARK);
    expect(settings).toHaveAttribute('title', 'Show node settings');
  });

  it('no control on the toolbar shows the generic line', () => {
    useGraphStore.setState({ nodes: [node('n1')] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    const kept = [...document.querySelectorAll(`[${KEPT_MARK}]`)];
    expect(kept.length).toBeGreaterThanOrEqual(4);
    for (const control of kept) expect(control.getAttribute('title')).not.toBe(KEPT_GENERIC_LINE);
  });
});

describe('GM r17, Q2: every control names its own kept line', () => {
  const root = join(__dirname, '../src/components');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
  it("no lock.act call uses the generic 'other' (tsc makes `kept` required)", () => {
    const calls = files(root).flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      // Each call's whole argument, parentheses balanced.
      return [...text.matchAll(/lock\.act\(/g)].map((match) => {
        let depth = 0;
        let end = match.index! + 'lock.act'.length;
        for (; end < text.length; end += 1) {
          if (text[end] === '(') depth += 1;
          else if (text[end] === ')' && --depth === 0) break;
        }
        return { path, call: text.slice(match.index, end + 1) };
      });
    });
    expect(calls.length).toBeGreaterThan(40);
    for (const { path, call } of calls) {
      expect(call, path).toMatch(/kept: (item\.kept|paletteKeptAction\(cmd\.id\)|'[a-z-]+')/);
      expect(call, path).not.toMatch(/kept: 'other'/);
    }
  });
  it('every command palette command that acts has its own line', async () => {
    const source = readFileSync(join(root, 'CommandPalette.tsx'), 'utf8');
    const map = source.slice(source.indexOf('function paletteKeptAction'), source.indexOf('return \'other\';'));
    const commands = buildCommands({
      addNodeAtCenter: () => {}, runGraph: () => {}, save: () => {}, load: () => {}, fitView: () => {},
      enterCreateView: () => {}, togglePanel: () => {}, startAgentQuery: () => {}, canRun: true, canSave: true,
      canLoad: true, canvasNodes: [], focusNode: () => {},
    } as never).filter((command) => command.acts);
    for (const command of commands) {
      const named = map.includes(`'${command.id}'`) || (command.id.startsWith('node:') && map.includes("'node:'"));
      expect(named, command.id).toBe(true);
    }
  });
});

describe('GM r16, 4: the lock reasons go kept, run, follow, offline', () => {
  const following = { projectId: 'p', projectName: 'Delta' } as never;
  it('kept first, over a run, a follow and offline', () => {
    const lock = canvasLockOf(following, true, true);
    expect(lock.act({ busy: 'Wait for the active run to finish', title: 'Arrange selected nodes', kept: 'arrange' }))
      .toEqual({ [KEPT_MARK]: '', disabled: true, title: keptLockTitle('arrange') });
    // Typing stays: fields read `locked`, which the kept canvas alone never sets.
    expect(canvasLockOf(null, false, true).locked).toBe(false);
  });
  it("a 'live' control is left on by the kept canvas, never by a follow, a run or offline", () => {
    expect(canvasLockOf(null, false, true).act({ title: 'Duplicate selected nodes', kept: 'live' }))
      .toEqual({ disabled: false, title: 'Duplicate selected nodes' });
    expect(canvasLockOf(following, false, true).act({ title: 'Duplicate selected nodes', kept: 'live' }).title).toBe('Wait for “Delta” to open.');
    expect(canvasLockOf(null, false, true).act({ busy: 'Wait for the active run to finish', kept: 'live' }).disabled).toBe(true);
  });
  it('then a run going, over a follow', () => {
    const act = canvasLockOf(following, false, false).act({ busy: 'Wait for the active run to finish', title: 'Arrange selected nodes', kept: 'arrange' });
    expect(act).toMatchObject({ disabled: true, title: 'Wait for the active run to finish' });
  });
  it('then the follow, then offline (no tooltip of its own)', () => {
    expect(canvasLockOf(following, true, false).act({ title: 'Arrange selected nodes', kept: 'arrange' }).title).toBe('Wait for “Delta” to open.');
    expect(canvasLockOf(null, true, false).act({ title: 'Arrange selected nodes', kept: 'arrange' })).toMatchObject({ disabled: true, title: 'Arrange selected nodes' });
  });
});

describe('the keyboard shortcuts while kept', () => {
  it('Delete, Run, Arrange, Undo and Paste change nothing and send nothing, and each pulses the kept line', async () => {
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

  it('Duplicate (⌘D, the toolbar, the Inspector, the context menu) makes this tab\'s copies and sends nothing (GM r17)', async () => {
    act(() => setCanvasKept(true));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let pulses = 0;
    const stop = subscribeKeptPulse(() => { pulses += 1; });
    useGraphStore.getState().duplicateSelected();
    useGraphStore.getState().duplicateNode('n1');
    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(5);
    expect(nodes.filter((n) => !/^n\d+$/.test(n.id)).map((n) => n.data.params.value).sort()).toEqual(['n1', 'n1', 'n2']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pulses).toBe(0);
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
    fireEvent.pointerDown(button(/^Arrange$/));
    expect(pulses).toBe(1);
    stop();
    useProjectStore.setState({ keptEdits: null });
  });
});

describe('GM r17: the disabled trash is neutral at 0.45, never a dim red', () => {
  it('canvas.css sets the disabled Delete to the toolbar colour at 0.45', () => {
    const css = readFileSync(join(__dirname, '../src/styles/canvas.css'), 'utf8');
    expect(css).toMatch(/\.selection-toolbar__button--danger:disabled \{\s*color: inherit;\s*opacity: 0\.45;\s*\}/);
    // After the toolbar's own :disabled (same specificity: the later wins).
    expect(css.indexOf('.selection-toolbar__button--danger:disabled')).toBeGreaterThan(css.indexOf('.selection-toolbar__button:disabled'));
  });
});

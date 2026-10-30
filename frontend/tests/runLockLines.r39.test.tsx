import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM, PR #198 r39 item 2 and r40 item 3 (the lock-lines follow-up):
 * - Every control this tab's run holds says what unlocks it, by its own verb:
 *   "You can … when the run finishes." (lib/runLock's table; canvasLock has
 *   no default line any more, so a new lock names its own).
 * - The deferred run notice is a state line, read live: "You can run “X”
 *   when the current run finishes." while a run goes, with [Run] disabled and
 *   that same line as its tooltip; "You can run “X” now." once it finishes,
 *   with [Run] enabled. No toast, no timer. A canvas replace takes it away.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
  useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
    screenToFlowPosition: (p: unknown) => p, getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
  useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
    selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));

import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { Toolbar } from '../src/components/panels/Toolbar';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { CinemaStudioToolbar } from '../src/components/cinema-studio/CinemaStudioToolbar';
import { ModelNode } from '../src/components/nodes/ModelNode';
import { DeferredRunNotice } from '../src/components/canvas/DeferredRunNotice';
import { canvasLockOf } from '../src/lib/canvasLock';
import { deferredRunLine, RUN_LOCK_VERBS, runFinishesLine } from '../src/lib/runLock';
import { runLockedLine, runLockedWiresLine } from '../src/lib/cinemaScene';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const INITIAL_PROPOSALS = { ...useCanvasProposalsStore.getState() };
afterEach(() => {
  cleanup();
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  useCanvasProposalsStore.setState(INITIAL_PROPOSALS, true);
});

const textNode = (id: string, label: string, selected = true) => ({ id, type: 'model-node', position: { x: 0, y: 0 }, selected,
  data: { label, definitionId: 'text-input', params: {}, outputs: {}, state: 'idle' } }) as unknown as Node<NodeData>;
const titleOf = (name: RegExp) => screen.getAllByRole('button')
  .find((b) => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))?.getAttribute('title');

describe('GM r39 item 2: each run-locked control says its own verb', () => {
  it('the helper and the table: "You can <verb> when the run finishes."', () => {
    expect(runFinishesLine(RUN_LOCK_VERBS.duplicateIt)).toBe('You can duplicate it when the run finishes.');
    expect(runFinishesLine(RUN_LOCK_VERBS.generateShot)).toBe('You can generate this shot when the run finishes.');
    expect(runFinishesLine(RUN_LOCK_VERBS.runIt)).toBe('You can run it when the run finishes.');
    expect(runFinishesLine(RUN_LOCK_VERBS.forgetRun)).toBe('You can forget this run when the run finishes.');
    expect(runFinishesLine(RUN_LOCK_VERBS.arrangeCanvas)).toBe('You can arrange the canvas when the run finishes.');
    expect(runFinishesLine(RUN_LOCK_VERBS.loadCanvas)).toBe('You can load a canvas when the run finishes.');
    expect(runFinishesLine(RUN_LOCK_VERBS.importCanvas)).toBe('You can import a canvas when the run finishes.');
    expect(runFinishesLine(RUN_LOCK_VERBS.clearCanvas)).toBe('You can clear the canvas when the run finishes.');
  });

  it('canvasLock has no default run line: the control names its own', () => {
    const lock = canvasLockOf(null, false);
    expect(lock.act({ title: 'Duplicate' }, { run: true, runTitle: 'You can duplicate it when the run finishes.' }))
      .toEqual({ disabled: true, title: 'You can duplicate it when the run finishes.' });
    const source = readFileSync(resolve(__dirname, '../src/lib/canvasLock.ts'), 'utf8');
    expect(source).not.toMatch(/runTitle \?\?/);
    expect(source).not.toMatch(/RUN_LOCK_REASON/);
  });

  it('the context menu: the row\'s verb plus "it"', () => {
    useGraphStore.setState({ nodes: [textNode('n4', 'Brief')], edges: [], isExecuting: true });
    act(() => useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n4', null));
    render(<ContextMenu />);
    expect(titleOf(/^Run This Node/)).toBe('You can run it when the run finishes.');
    expect(titleOf(/^Duplicate/)).toBe('You can duplicate it when the run finishes.');
    expect(titleOf(/^Delete/)).toBe('You can delete it when the run finishes.');
  });

  it('the selection toolbar: "it" for one node, "them" for several', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true });
    const { unmount } = render(<SelectionToolbar />);
    expect(titleOf(/^Run selected/)).toBe('You can run it when the run finishes.');
    expect(titleOf(/^Duplicate/)).toBe('You can duplicate it when the run finishes.');
    expect(titleOf(/^Delete selected/)).toBe('You can delete it when the run finishes.');
    unmount();
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief'), textNode('n2', 'Note')] });
    render(<SelectionToolbar />);
    expect(titleOf(/^Run selected/)).toBe('You can run them when the run finishes.');
    expect(titleOf(/^Arrange/)).toBe('You can arrange them when the run finishes.');
    expect(titleOf(/^Delete selected/)).toBe('You can delete them when the run finishes.');
  });

  it('the Canvas actions panel: Auto-layout, Load, Import, Clear and Save; the panel line covers the group', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief', false)], edges: [], isExecuting: true });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    const panel = screen.getByRole('region', { name: 'Canvas actions' });
    const by = (name: string) => within(panel).getByRole('button', { name });
    expect(by('Arrange nodes')).toHaveAttribute('title', 'You can arrange the canvas when the run finishes.');
    expect(by('Load graph')).toHaveAttribute('title', 'You can load a canvas when the run finishes.');
    expect(by('Import CLI graph')).toHaveAttribute('title', 'You can import a canvas when the run finishes.');
    expect(by('Clear canvas…')).toHaveAttribute('title', 'You can clear the canvas when the run finishes.');
    expect(by('Save graph')).toHaveAttribute('title', 'You can save the canvas when the run finishes.');
    expect(within(panel).getByRole('status').textContent).toBe('You can save, load, import or clear the canvas when the run finishes.');
    expect(document.body.innerHTML).not.toMatch(/Wait for the active run/);
  });

  it('Run history: Forget and Clear', () => {
    useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
    useGraphStore.setState({ isExecuting: true, runHistory: [{ id: 'r1', status: 'complete', trigger: 'graph', startedAt: Date.now(),
      snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] } }] as never,
    providerRecoveries: [{ runId: 'paid-run', nodeId: 'world-node', resumeOperationId: 'op', existingWorldId: null, durable: true }] as never });
    render(<RunHistoryPanel />);
    expect(screen.getByRole('button', { name: /^Forget the recovery ID for / }))
      .toHaveAttribute('title', 'You can forget this run when the run finishes.');
    expect(screen.getByRole('button', { name: 'Clear run history' }))
      .toHaveAttribute('title', 'You can clear the run history when the run finishes.');
  });

  it('Cinema\'s Generate: "You can generate this shot when the run finishes."', () => {
    useGraphStore.setState({ isExecuting: true, nodes: [{ id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
      data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
        params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 's1', prompt: 'a' }] } } } }] as never });
    render(<CinemaStudioToolbar cinemaNodeId="n1" />);
    const generate = screen.getByRole('button', { name: /^Generat/ });
    expect(generate).toBeDisabled();
    expect(generate).toHaveAttribute('title', 'You can generate this shot when the run finishes.');
  });

  it('a model node\'s next step: "You can run it when the run finishes."', () => {
    const node = { id: 'n7', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
      data: { definitionId: 'preview', label: 'Look', params: {}, state: 'complete',
        outputs: { input: { type: 'Image', value: '/api/outputs/run/a.png' } } } } as unknown as Node<NodeData>;
    useGraphStore.setState({ nodes: [node], edges: [], isExecuting: true });
    const { container } = render(<ModelNode {...({ id: 'n7', data: node.data, selected: true } as NodeProps)} />);
    const next = container.querySelector('[data-next-step-anchor="n7"]');
    expect(next).not.toBeNull();
    expect(next).toHaveAttribute('title', 'You can run it when the run finishes.');
  });

  it('the run-lock refusals take the same lock line after what failed', () => {
    expect(runLockedLine('delete', 1, '“Brief”')).toBe('Couldn’t delete “Brief”. You can delete it when the run finishes.');
    expect(runLockedLine('delete', 2, undefined, ['A', 'B'])).toBe('Couldn’t delete “A” and “B”. You can delete them when the run finishes.');
    expect(runLockedLine('undo')).toBe('Couldn’t undo. You can undo when the run finishes.');
    expect(runLockedLine('redo')).toBe('Couldn’t redo. You can redo when the run finishes.');
    expect(runLockedWiresLine(2)).toBe('Couldn’t delete 2 connections. You can delete them when the run finishes.');
  });

  it('adding a connected node while this tab runs: the add heading, then "You can add it when the run finishes."', async () => {
    const said: string[] = [];
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief', false)], edges: [], isExecuting: true, notify: (text: string) => { said.push(text); } } as never);
    await useGraphStore.getState().addNodeAndConnect('text-input', { x: 0, y: 0 },
      { source: 'n1', sourceHandle: 'text', target: 'new', targetHandle: 'text', newNodeIs: 'target' });
    // The heading is addHeading's own, unchanged here.
    expect(said).toEqual(["Couldn't add “Text Input”. You can add it when the run finishes."]);
  });

  it('no person UI says the old line, and every run lock names its own line', () => {
    const root = resolve(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // Comments may quote history; code may not say it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/Wait for the active run|Wait for the run to finish first|current run or graph import/.test(code)) offenders.push(file.slice(root.length));
      // A run lock passed to act or lockedAction carries its runTitle (the type
      // requires it; this keeps a cast from slipping one through).
      for (const start of [...code.matchAll(/\b(?:\.act|lockedAction)\(/g)].map((m) => m.index! + m[0].length)) {
        let depth = 1;
        let end = start;
        while (end < code.length && depth > 0) {
          if (code[end] === '(') depth += 1;
          else if (code[end] === ')') depth -= 1;
          end += 1;
        }
        const call = code.slice(start, end);
        if (/\brun: /.test(call) && !/runTitle/.test(call)) offenders.push(`${file.slice(root.length)}: ${call.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('GM r40 item 3: the deferred run notice is a state line, read live', () => {
  const hold = (nodeIds: string[]) => useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds } } as never);
  const runButton = () => screen.getByRole('button', { name: /Run/ });
  const summary = () => document.querySelector('.proposal-bar__summary')?.textContent;

  it('the line: names by the shared list, "it" only when nothing has a name', () => {
    expect(deferredRunLine(['Brief'], true)).toBe('You can run “Brief” when the current run finishes.');
    expect(deferredRunLine(['Brief'], false)).toBe('You can run “Brief” now.');
    expect(deferredRunLine(['Brief', 'Text', 'Text'], true)).toBe('You can run “Brief” and 2 “Text” nodes when the current run finishes.');
    expect(deferredRunLine(['A', 'B', 'C', 'D'], false)).toBe('You can run 4 nodes now.');
    expect(deferredRunLine([], true)).toBe('You can run it when the current run finishes.');
    expect(deferredRunLine(['', ' '], false)).toBe('You can run it now.');
  });

  it('while a run goes: the line, [Run] disabled with it as its tooltip, [Dismiss] enabled; then it swaps in place', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief', false)], edges: [], isExecuting: true });
    hold(['n3']);
    render(<DeferredRunNotice />);
    const region = screen.getByRole('status');
    expect(summary()).toBe('You can run “Brief” when the current run finishes.');
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveAttribute('title', 'You can run “Brief” when the current run finishes.');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    const notices = { undo: useGraphStore.getState().undoNotice, message: useGraphStore.getState().messageNotice };
    act(() => useGraphStore.setState({ isExecuting: false }));
    // The same element, its line swapped; no toast.
    expect(screen.getByRole('status')).toBe(region);
    expect(summary()).toBe('You can run “Brief” now.');
    expect(runButton()).toBeEnabled();
    expect(runButton().getAttribute('title')).toBeNull();
    expect({ undo: useGraphStore.getState().undoNotice, message: useGraphStore.getState().messageNotice }).toEqual(notices);
  });

  it('a run that is starting holds it too', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief', false)], edges: [], isExecuting: false, runStarting: true } as never);
    hold(['n3']);
    render(<DeferredRunNotice />);
    expect(summary()).toBe('You can run “Brief” when the current run finishes.');
    expect(runButton()).toBeDisabled();
  });

  it('a rename of the held node while it waits shows at once, in the line and the tooltip', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief', false), textNode('n4', 'Other', false)], edges: [], isExecuting: true });
    hold(['n3']);
    render(<DeferredRunNotice />);
    act(() => useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => (node.id === 'n3'
      ? { ...node, data: { ...node.data, label: 'Hero brief' } } : node)) })));
    expect(summary()).toBe('You can run “Hero brief” when the current run finishes.');
    expect(runButton()).toHaveAttribute('title', 'You can run “Hero brief” when the current run finishes.');
    act(() => useGraphStore.setState({ isExecuting: false }));
    expect(summary()).toBe('You can run “Hero brief” now.');
  });

  it('several held nodes, in canvas order; a held node deleted meanwhile drops out; none left: "it"', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief', false), textNode('n5', 'Note', false)], edges: [], isExecuting: true });
    hold(['n5', 'n3']);
    render(<DeferredRunNotice />);
    expect(summary()).toBe('You can run “Brief” and “Note” when the current run finishes.');
    act(() => useGraphStore.setState((state) => ({ nodes: state.nodes.filter((node) => node.id !== 'n3') })));
    expect(summary()).toBe('You can run “Note” when the current run finishes.');
    act(() => useGraphStore.setState({ nodes: [] }));
    expect(summary()).toBe('You can run it when the current run finishes.');
  });

  it('[Dismiss] works while the run goes', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief', false)], edges: [], isExecuting: true });
    hold(['n3']);
    render(<DeferredRunNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useCanvasProposalsStore.getState().deferredRun).toBeNull();
  });
});

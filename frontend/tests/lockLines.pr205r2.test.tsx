import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * GM on PR #205, round 2 (and review 1's lock-line NITs):
 * - Item 3: the command palette's Run, Save and Load are "Run canvas", "Save
 *   canvas", "Load canvas". Locked by the run, each row stays in place,
 *   greyed, with its lock line as its own secondary text (a tooltip doesn't
 *   show on a row reached by the arrow keys), and aria-describedby on it.
 * - Item 4: Cmd+D "You can duplicate “X” when the run finishes." (names as
 *   Delete names them), Cmd+V "You can paste when the run finishes.", where
 *   the Delete, Undo and Redo lines show.
 * - Item 5: a wire dropped during a run opens no picker; the drop says "You
 *   can add a node when the run finishes." (Canvas; the live check), and a
 *   picker open when a run starts says it on a press, and closes.
 * - Review 1 NIT-3: the deferred notice keeps "… now." through its exit.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
    screenToFlowPosition: (p: unknown) => p, getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
  useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
    selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));

import { CommandPalette } from '../src/components/CommandPalette';
import { Toolbar } from '../src/components/panels/Toolbar';
import { DeferredRunNotice } from '../src/components/canvas/DeferredRunNotice';
import { buildCommands } from '../src/lib/commandPalette';
import { runLockedLine } from '../src/lib/cinemaScene';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { appRules, cascaded } from './helpers/cssCascade';

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const INITIAL_PROPOSALS = { ...useCanvasProposalsStore.getState() };
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  useCanvasProposalsStore.setState(INITIAL_PROPOSALS, true);
});

function textNode(id: string, label: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected, width: 120, height: 60,
    data: { label, definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
const store = () => useGraphStore.getState();

describe('GM r2 item 4: Cmd+D and Cmd+V during a run say their lock line', () => {
  it('the lines: one name, several by the name-list rule, no name; paste', () => {
    expect(runLockedLine('duplicate', 1, '“Brief”')).toBe('You can duplicate “Brief” when the run finishes.');
    expect(runLockedLine('duplicate', 2, undefined, ['Brief', 'Note'])).toBe('You can duplicate “Brief” and “Note” when the run finishes.');
    expect(runLockedLine('duplicate', 1)).toBe('You can duplicate the node when the run finishes.');
    expect(runLockedLine('paste')).toBe('You can paste when the run finishes.');
  });

  it('Cmd+D (duplicateSelected): nothing is duplicated, and the line shows where Delete\'s does', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief', true), textNode('n2', 'Note')], edges: [], isExecuting: true,
      undoNotice: null, messageNotice: null });
    act(() => { store().duplicateSelected(); });
    expect(store().nodes).toHaveLength(2);
    expect(store().undoNotice?.text).toBe('You can duplicate “Brief” when the run finishes.');
    act(() => { useGraphStore.setState({ nodes: [textNode('n1', 'Brief', true), textNode('n2', 'Note', true)] }); });
    act(() => { store().duplicateSelected(); });
    expect(store().undoNotice?.text).toBe('You can duplicate “Brief” and “Note” when the run finishes.');
  });

  it('Cmd+V (pasteClipboard): nothing is pasted, and the line shows', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief', true)], edges: [], isExecuting: false, undoNotice: null, messageNotice: null });
    act(() => { store().copySelected(); });
    act(() => { useGraphStore.setState({ isExecuting: true }); });
    let pasted: string[] = ['x'];
    act(() => { pasted = store().pasteClipboard(); });
    expect(pasted).toEqual([]);
    expect(store().nodes).toHaveLength(1);
    expect(store().undoNotice?.text).toBe('You can paste when the run finishes.');
  });

  it('with no run, the same keys act and say nothing of a lock', () => {
    useGraphStore.setState({ nodes: [textNode('local-1', 'Brief', true)], edges: [], isExecuting: false, undoNotice: null, messageNotice: null });
    act(() => { store().duplicateSelected(); });
    expect(store().nodes.length).toBeGreaterThan(1);
    expect(store().undoNotice?.text ?? '').not.toMatch(/when the run finishes/);
  });
});

describe('GM r2 item 3: the command palette', () => {
  const ctx = (running: boolean) => ({ addNodeAtCenter: vi.fn(), runGraph: vi.fn(), save: vi.fn(), load: vi.fn(), fitView: vi.fn(),
    enterCreateView: vi.fn(), togglePanel: vi.fn(), startAgentQuery: vi.fn(), canRun: !running, canSave: !running, canLoad: !running,
    running, canvasNodes: [], focusNode: vi.fn() });
  const actions = (running: boolean) => buildCommands(ctx(running)).filter((cmd) => cmd.id === 'action:run' || cmd.id === 'action:save' || cmd.id === 'action:load');

  it('the items say "canvas"', () => {
    expect(actions(false).map((cmd) => cmd.title)).toEqual(['Run canvas', 'Save canvas', 'Load canvas']);
    expect(actions(false).map((cmd) => cmd.lockLine)).toEqual([undefined, undefined, undefined]);
  });

  it('locked by the run, each says its line', () => {
    expect(actions(true).map((cmd) => cmd.lockLine)).toEqual([
      'You can run the canvas when the run finishes.',
      'You can save the canvas when the run finishes.',
      'You can load a canvas when the run finishes.',
    ]);
  });

  it('rendered during a run: each row in place and disabled, the line as its own text, described by it, no tooltip', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true });
    render(<CommandPalette />);
    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
    const lines = {
      'Run canvas': 'You can run the canvas when the run finishes.',
      'Save canvas': 'You can save the canvas when the run finishes.',
      'Load canvas': 'You can load a canvas when the run finishes.',
    };
    const rows = screen.getAllByRole('button').filter((button) => button.className.includes('command-palette__item'));
    expect(rows.slice(0, 3).map((row) => row.querySelector('.command-palette__item-title')?.textContent)).toEqual(Object.keys(lines));
    for (const [name, line] of Object.entries(lines)) {
      const row = rows.find((button) => button.querySelector('.command-palette__item-title')?.textContent === name)!;
      expect(row).toBeDisabled();
      expect(row).not.toHaveAttribute('title');
      expect(row).toHaveAccessibleName(name);
      expect(row).toHaveAccessibleDescription(line);
      const text = row.querySelector('.command-palette__item-lock')!;
      expect(text.textContent).toBe(line);
      expect(row.getAttribute('aria-describedby')).toBe(text.id);
    }
  });

  it('with no run, no lock line and no description', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: false });
    render(<CommandPalette />);
    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
    expect(document.querySelector('.command-palette__item-lock')).toBeNull();
  });

  it('the shared grey, as the cascade resolves it on a rendered locked row and its line', () => {
    document.body.className = 'app-slava-restraint';
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true });
    render(<CommandPalette />);
    act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
    const row = [...document.querySelectorAll('.command-palette__item')].find((item) => item.querySelector('.command-palette__item-lock'))!;
    const line = row.querySelector('.command-palette__item-lock')!;
    expect(cascaded(row).get('|color')?.value).toMatch(/^var\(--disabled-label/);
    expect(cascaded(row).get('|opacity')?.value).toBe('1');
    expect(cascaded(line).get('|color')?.value).toMatch(/^var\(--disabled-label/);
    document.body.className = '';
  });

  it('the shared grey: the locked row and its line take the shared ink, no extra dimming (disabled-buttons.css)', () => {
    const rules = appRules().filter((each) => each.file === 'styles/disabled-buttons.css'
      && each.selector.startsWith('.command-palette__item:is(:disabled'));
    const row = rules.find((each) => !each.selector.includes('item-sub'));
    const sub = rules.find((each) => each.selector.endsWith('.command-palette__item-sub'));
    for (const rule of [row, sub]) {
      expect(rule?.decls.find((decl) => decl.prop === 'color')?.value).toMatch(/^var\(--disabled-label/);
      expect(rule?.decls.find((decl) => decl.prop === 'opacity')?.value).toMatch(/^1/);
    }
  });
});

describe('review 1 NIT-3: the deferred notice keeps its line through its exit', () => {
  const realGetAnimations = Element.prototype.getAnimations;
  beforeEach(() => {
    // jsdom runs no CSS: a leaving notice runs its -out animation.
    const stub = Object.assign(new EventTarget(), { animationName: 'notice-surface-out', currentTime: 0, playbackRate: 1,
      effect: { getComputedTiming: () => ({ endTime: 294 }) } });
    Element.prototype.getAnimations = function getAnimations(this: Element) {
      return this.getAttribute('data-leaving') ? [stub] as unknown as Animation[] : [];
    };
  });
  afterEach(() => { Element.prototype.getAnimations = realGetAnimations; });

  it('Run pressed on "… now.": leaving, it still says "now" with [Run] enabled, though the run it started is going', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief')], edges: [], isExecuting: false });
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n3'] } } as never);
    const { container } = render(<DeferredRunNotice />);
    expect(screen.getByText('You can run “Brief” now.')).toBeInTheDocument();
    // What runDeferred does: the notice goes, and the run starts.
    act(() => {
      useCanvasProposalsStore.setState({ deferredRun: null } as never);
      useGraphStore.setState({ runStarting: true });
    });
    const notice = container.querySelector('.proposal-bar--notice')!;
    expect(notice).toHaveAttribute('data-leaving');
    expect(notice.querySelector('.proposal-bar__summary')?.textContent).toBe('You can run “Brief” now.');
    expect(screen.getByRole('button', { name: /Run/, hidden: true })).not.toBeDisabled();
    act(() => { useGraphStore.setState({ isExecuting: true, runStarting: false }); });
    expect(notice.querySelector('.proposal-bar__summary')?.textContent).toBe('You can run “Brief” now.');
  });

  it('while it shows, the line still follows the run (the r40 swap)', () => {
    useGraphStore.setState({ nodes: [textNode('n3', 'Brief')], edges: [], isExecuting: true });
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n3'] } } as never);
    render(<DeferredRunNotice />);
    expect(screen.getByText('You can run “Brief” when the current run finishes.')).toBeInTheDocument();
    act(() => { useGraphStore.setState({ isExecuting: false }); });
    expect(screen.getByText('You can run “Brief” now.')).toBeInTheDocument();
  });
});

describe('GM r2 item 5: the run lock line for a dropped wire', () => {
  it('sayRunLocked shows the line where the key presses\' lines show', () => {
    useGraphStore.setState({ undoNotice: null, messageNotice: null });
    act(() => { store().sayRunLocked('You can add a node when the run finishes.'); });
    expect(store().undoNotice).toMatchObject({ text: 'You can add a node when the run finishes.', offer: null });
  });
});

describe('review 1 NIT-4: Canvas actions gives each control its true reason', () => {
  it.each([
    [{ createLaunchingIds: ['p'] }, 'when Nebula finishes preparing the run'],
    [{ createLaunchingIds: ['p'], isExecuting: true }, 'when the run finishes'],
  ])('%j: the group line and each control say the same wait', (state, when) => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], ...state } as never);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    const panel = screen.getByRole('region', { name: 'Canvas actions' });
    expect(within(panel).getByRole('status')).toHaveTextContent(`You can save, load, import or clear the canvas ${when}.`);
    for (const [name, verb] of [['Save graph', 'save the canvas'], ['Load graph', 'load a canvas'],
      ['Import CLI graph', 'import a canvas'], ['Clear canvas…', 'clear the canvas']]) {
      expect(within(panel).getByRole('button', { name })).toHaveAttribute('title', `You can ${verb} ${when}.`);
    }
  });
});

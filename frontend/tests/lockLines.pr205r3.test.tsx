import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

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
import { GraphFileActions } from '../src/components/GraphFileActions';
import { buildCommands } from '../src/lib/commandPalette';
import { SHORTCUT_GROUPS } from '../src/lib/keyboardShortcuts';
import { RUN_LOCK_VERBS, canvasWaitLine } from '../src/lib/runLock';
import { GRAPH_LOAD_EVENT, GRAPH_SAVE_EVENT } from '../src/lib/graphFileActions';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { appRules, cascaded } from './helpers/cssCascade';

/**
 * GM on PR #205, round 3 and round 4 (and review 2's lines-palette-keys):
 * - r3 item 1: one name per command everywhere: the "Canvas" heading, "Save
 *   canvas", "Load canvas", "Import CLI canvas", the shortcuts sheet's "Run
 *   canvas", "Fit view" (palette, sheet and toolbar), the palette's panel
 *   rows in sentence case, and "run the canvas" in its lock line (review 2
 *   LOW-3; NIT-2: also while a run is starting).
 * - r3 item 2: palette rows an import or Create's launch locks say that
 *   wait's line, from the same table.
 * - r3 item 3 and review 2 LOW-1: the palette is a combobox and listbox; the
 *   arrows reach locked rows (aria-disabled), whose line is their description
 *   (read through aria-activedescendant), Enter on one does nothing, and the
 *   keyboard highlight is a selected-row surface, on locked rows too.
 * - r4 item 4: Cmd+Enter, Cmd+S and Cmd+O during a run say the palette's
 *   lines in the key presses' place (Cmd+Enter: canvasKeys.pr205r3).
 */

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
afterEach(() => {
  cleanup();
  document.body.className = '';
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
});

function textNode(id: string, label: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, width: 120, height: 60,
    data: { label, definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
const store = () => useGraphStore.getState();
const WAITS = [
  ['a run', { isExecuting: true }, 'when the run finishes'],
  ['an import', { isImportingGraph: true }, 'when the import finishes'],
  ['Create\'s launch', { createLaunchingIds: ['p'] }, 'when Nebula finishes preparing the run'],
] as const;
const openPalette = () => act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });

describe('GM r3 item 1: one name per command', () => {
  it('Canvas actions: the "Canvas" heading over Save canvas, Load canvas and Import CLI canvas', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')] });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    const group = screen.getByRole('group', { name: 'Canvas files' });
    expect(within(group).getByRole('heading').textContent).toBe('Canvas');
    for (const name of ['Save canvas', 'Load canvas', 'Import CLI canvas']) expect(within(group).getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /^Save canvas/ })).toHaveAttribute('title', 'Save canvas (Ctrl+S or ⌘S)');
    expect(within(group).getByRole('button', { name: /^Load canvas/ })).toHaveAttribute('title', 'Load canvas (Ctrl+O or ⌘O)');
    expect(group.textContent).not.toMatch(/graph/i);
  });

  it('the shortcuts sheet: "Canvas", "Run canvas", "Fit view", "Save canvas", "Load canvas"; the palette and the toolbar say "Fit view" too', () => {
    const labels = Object.fromEntries(SHORTCUT_GROUPS.flatMap((group) => group.items.map((item) => [item.keys.join('+'), item.label])));
    expect(SHORTCUT_GROUPS.map((group) => group.title)).toEqual(['Canvas', 'View', 'App']);
    expect(labels['Mod+Enter']).toBe('Run canvas');
    expect(labels['Shift+1']).toBe('Fit view');
    expect(labels['Mod+S']).toBe('Save canvas');
    expect(labels['Mod+O']).toBe('Load canvas');
    expect(JSON.stringify(SHORTCUT_GROUPS)).not.toMatch(/graph/i);
    const commands = buildCommands({ addNodeAtCenter: vi.fn(), runGraph: vi.fn(), save: vi.fn(), load: vi.fn(), fitView: vi.fn(),
      enterCreateView: vi.fn(), togglePanel: vi.fn(), startAgentQuery: vi.fn(), canRun: true, canSave: true, canLoad: true,
      canvasNodes: [], focusNode: vi.fn() });
    expect(commands.find((cmd) => cmd.id === 'action:fit')?.title).toBe('Fit view');
    expect(commands.filter((cmd) => cmd.id.startsWith('view:')).map((cmd) => cmd.title)).toEqual([
      'Open Creator Studio', 'Keyboard shortcuts', 'Toggle node library', 'Toggle inspector', 'Toggle settings',
      'Toggle chat', 'Toggle assets', 'Toggle run history']);
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')] });
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Fit view' })).toBeInTheDocument();
  });

  it('the canvas Run: "Run canvas." as its tooltip; "run the canvas" while a run starts and during an import (review 2 LOW-3, NIT-2)', () => {
    expect(Object.keys(RUN_LOCK_VERBS)).not.toContain('runGraph');
    expect(Object.values(RUN_LOCK_VERBS).join(' ')).not.toMatch(/graph/);
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')] });
    const view = render(<Toolbar />);
    const run = () => screen.getByRole('button', { name: /^Run\b/ });
    expect(run().getAttribute('title')).toMatch(/^Run canvas\. /);
    act(() => { useGraphStore.setState({ runStarting: true }); });
    view.rerender(<Toolbar />);
    expect(run()).toHaveAttribute('title', 'You can run the canvas when the run finishes.');
    act(() => { useGraphStore.setState({ runStarting: false, isImportingGraph: true }); });
    expect(run()).toHaveAttribute('title', 'You can run the canvas when the import finishes.');
  });
});

describe('GM r3 item 2: the palette\'s locked rows say their wait', () => {
  it.each(WAITS)('locked by %s: Run (when it waits), Save and Load each say its line, as their own text', (_label, state, when) => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], ...state } as never);
    render(<CommandPalette />);
    openPalette();
    for (const [name, verb] of [['Save canvas', 'save the canvas'], ['Load canvas', 'load a canvas']] as const) {
      const row = screen.getByRole('option', { name });
      expect(row).toHaveAttribute('aria-disabled', 'true');
      expect(row).toHaveAccessibleDescription(`You can ${verb} ${when}.`);
      expect(row.querySelector('.command-palette__item-lock')?.textContent).toBe(`You can ${verb} ${when}.`);
    }
    // Create's launch doesn't hold Run (a run can start beside it).
    const runRow = screen.getByRole('option', { name: 'Run canvas' });
    if ('createLaunchingIds' in state) expect(runRow).not.toHaveAttribute('aria-disabled');
    else expect(runRow).toHaveAccessibleDescription(`You can run the canvas ${when}.`);
  });

  it('the table is one: canvasWaitLine reads the run first, then the launch, then the import', () => {
    expect(canvasWaitLine('save the canvas', { isExecuting: true, isImportingGraph: true, createLaunchingIds: ['p'] })).toBe('You can save the canvas when the run finishes.');
    expect(canvasWaitLine('save the canvas', { isExecuting: false, runStarting: true, isImportingGraph: true, createLaunchingIds: [] })).toBe('You can save the canvas when the run finishes.');
    expect(canvasWaitLine('save the canvas', { isExecuting: false, isImportingGraph: true, createLaunchingIds: ['p'] })).toBe('You can save the canvas when Nebula finishes preparing the run.');
    expect(canvasWaitLine('save the canvas', { isExecuting: false, isImportingGraph: true, createLaunchingIds: [] })).toBe('You can save the canvas when the import finishes.');
    expect(canvasWaitLine('save the canvas', { isExecuting: false, isImportingGraph: false, createLaunchingIds: [] })).toBeNull();
  });
});

describe('review 2 LOW-1 and GM r3 item 3: the palette from the keyboard', () => {
  it('a combobox over a listbox: the field\'s active descendant is the highlighted option; the arrows reach a locked one, whose line is its description', async () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true });
    render(<CommandPalette />);
    openPalette();
    // The field takes focus on the next tick.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const field = screen.getByRole('combobox', { name: 'Search commands and nodes' });
    const list = screen.getByRole('listbox');
    expect(field).toHaveAttribute('aria-controls', list.id);
    expect(field).toHaveAttribute('aria-expanded', 'true');
    const options = within(list).getAllByRole('option');
    expect(field.getAttribute('aria-activedescendant')).toBe(options[0].id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    act(() => { fireEvent.keyDown(field, { key: 'ArrowDown' }); });
    const save = screen.getByRole('option', { name: 'Save canvas' });
    expect(field.getAttribute('aria-activedescendant')).toBe(save.id);
    expect(field).toHaveFocus();
    expect(save).toHaveAttribute('aria-selected', 'true');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAccessibleDescription('You can save the canvas when the run finishes.');
    // From a focused locked row too (Tab, a click), the arrows go on to the next.
    act(() => { save.focus(); });
    act(() => { fireEvent.keyDown(save, { key: 'ArrowDown' }); });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Load canvas' }));
  });

  it('Enter (or a click) on a locked row does nothing: no save, the palette stays open', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true });
    const saved = vi.fn();
    window.addEventListener(GRAPH_SAVE_EVENT, saved);
    render(<CommandPalette />);
    openPalette();
    const field = screen.getByRole('combobox', { name: 'Search commands and nodes' });
    act(() => { fireEvent.keyDown(field, { key: 'ArrowDown' }); });
    act(() => { fireEvent.keyDown(field, { key: 'Enter' }); });
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'Save canvas' })); });
    window.removeEventListener(GRAPH_SAVE_EVENT, saved);
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Search commands and nodes' })).toBeInTheDocument();
  });

  it('the highlight is the selected-row surface, never a disabled token, and a locked row keeps it', () => {
    const rule = appRules().find((each) => each.file === 'styles/command-palette.css'
      && each.selector === 'body.app-slava-restraint .command-palette__item--selected');
    const background = rule?.decls.find((decl) => decl.prop === 'background')?.value ?? '';
    expect(background).toMatch(/^var\(--sr-surface-control-active/);
    expect(background).not.toMatch(/disabled|0, 0, 0/);
    document.body.className = 'app-slava-restraint';
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true });
    render(<CommandPalette />);
    openPalette();
    act(() => { fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search commands and nodes' }), { key: 'ArrowDown' }); });
    const save = screen.getByRole('option', { name: 'Save canvas' });
    expect(save.className).toContain('command-palette__item--selected');
    const won = cascaded(save);
    expect(won.get('|background')?.value ?? won.get('|background-color')?.value).toMatch(/^var\(--sr-surface-control-active/);
  });
});

describe('GM r4 item 4: Cmd+S and Cmd+O while a wait holds the files', () => {
  it.each(WAITS)('during %s: each key says the palette\'s line where the key presses\' lines show, and nothing opens', (_label, state, when) => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], undoNotice: null, messageNotice: null, ...state } as never);
    const events = vi.fn();
    window.addEventListener(GRAPH_SAVE_EVENT, events);
    window.addEventListener(GRAPH_LOAD_EVENT, events);
    render(<GraphFileActions />);
    act(() => { fireEvent.keyDown(document, { key: 's', metaKey: true }); });
    expect(store().undoNotice?.text).toBe(`You can save the canvas ${when}.`);
    act(() => { fireEvent.keyDown(document, { key: 'o', metaKey: true }); });
    expect(store().undoNotice?.text).toBe(`You can load a canvas ${when}.`);
    window.removeEventListener(GRAPH_SAVE_EVENT, events);
    window.removeEventListener(GRAPH_LOAD_EVENT, events);
    expect(events).not.toHaveBeenCalled();
  });

  it('from inside Canvas actions too (its own key handler)', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true, undoNotice: null } as never);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    const panel = screen.getByRole('region', { name: 'Canvas actions' });
    act(() => { fireEvent.keyDown(within(panel).getByRole('button', { name: /^Load canvas/ }), { key: 's', metaKey: true }); });
    expect(store().undoNotice?.text).toBe('You can save the canvas when the run finishes.');
  });

  it('with no wait, no line (a save refused for its own reason keeps its way)', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], undoNotice: null, providerStartAmbiguities: [{}] } as never);
    render(<GraphFileActions />);
    act(() => { fireEvent.keyDown(document, { key: 's', metaKey: true }); });
    expect(store().undoNotice).toBeNull();
  });
});

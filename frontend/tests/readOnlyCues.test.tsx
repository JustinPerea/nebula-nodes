import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * Offline is read-only, and it looks it (GM, rounds 14 and 15 of PR #114).
 * Round 15 rebuilt it from React state: every control that edits renders
 * `disabled` from useBackendOffline() with the offline mark (not-allowed
 * cursor, dimmed); nothing watches the DOM. Review 14's H1 was the old
 * MutationObserver re-triggering itself forever as soon as anything rendered
 * under the canvas while offline (the tab froze when a node was selected);
 * H2/L4 was the observer enabling a field React had disabled.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
// The banner's health probe: no answer (the banner is what the press pulses).
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
}));
vi.mock('../src/lib/canvasSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasSelection')>(),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { Inspector } from '../src/components/panels/Inspector';
import { NodeInspectorPopover } from '../src/components/panels/NodeInspectorPopover';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { NodeLabel } from '../src/components/nodes/NodeLabel';
import { BackendConnectionStatus } from '../src/components/BackendConnectionStatus';
import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { noteBackendConnection, resetBackendConnectionForTests, subscribeBlockedEdits } from '../src/lib/backendConnection';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_PROJECT_STATE = { ...useProjectStore.getState() };

function textNode(id: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'hello' }, outputs: {}, state: 'idle' } };
}

let observerCallbacks = 0;
const RealMO = globalThis.MutationObserver;
class CountingMO extends RealMO {
  constructor(callback: MutationCallback) {
    super((records, observer) => {
      observerCallbacks += 1;
      if (observerCallbacks > 200) { observer.disconnect(); return; }
      callback(records, observer);
    });
  }
}

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  observerCallbacks = 0;
  globalThis.MutationObserver = CountingMO as never;
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
  useProjectStore.setState(INITIAL_PROJECT_STATE, true);
});
afterEach(() => {
  globalThis.MutationObserver = RealMO;
  vi.restoreAllMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

describe('H1: selecting a node while offline', () => {
  it('the selection toolbar renders and the page settles (nothing loops on the DOM)', async () => {
    useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2')], edges: [] });
    render(<ReactFlowProvider><div className="canvas-wrapper canvas--read-only"><SelectionToolbar /></div></ReactFlowProvider>);
    act(() => noteBackendConnection('offline'));
    // The toolbar appears (a DOM change under the canvas), and more follow.
    act(() => useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2')] }));
    act(() => useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2', true)] }));
    await settle();
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    expect(observerCallbacks).toBeLessThan(5);
  });

  it('the Inspector popover open while offline: a node change re-renders it and the page settles', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    try {
      useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().selectNode('n1');
      useUIStore.getState().setInspectorVisible(true);
      render(<NodeInspectorPopover />);
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      act(() => noteBackendConnection('offline'));
      await settle();
      const before = observerCallbacks;
      // The node's state changes (a badge, a run's state): the Inspector re-renders.
      act(() => useGraphStore.setState({ nodes: [{ ...textNode('n1', true), data: { ...textNode('n1').data, state: 'error', error: 'x' } }] }));
      act(() => useGraphStore.setState({ nodes: [{ ...textNode('n1', true), data: { ...textNode('n1').data, label: 'Brief' } }] }));
      // And any other DOM change inside it (a badge, a hint appearing).
      act(() => { document.querySelector('.node-inspector-popover')?.appendChild(document.createElement('span')); });
      await settle();
      expect(observerCallbacks - before).toBeLessThan(5);
      const prompt = document.querySelector('.node-inspector-popover textarea');
      expect(prompt).toBeDisabled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('nothing in the canvas or the Inspector popover watches the DOM for read-only', () => {
    const src = join(__dirname, '../src');
    for (const file of ['components/Canvas.tsx', 'components/panels/NodeInspectorPopover.tsx']) {
      expect(readFileSync(join(src, file), 'utf8')).not.toMatch(/useReadOnlyFields|MutationObserver/);
    }
  });
});

describe('the selection toolbar while offline (GM, round 15)', () => {
  it('Run, Ask, Note, Duplicate and Delete are disabled with the mark; Copy stays', () => {
    useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2', true)], edges: [] });
    render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>);
    act(() => noteBackendConnection('offline'));
    const bar = screen.getByRole('toolbar');
    for (const title of ['Ask agent about selection', 'Duplicate selected nodes', 'Arrange selected nodes', 'Delete selected nodes']) {
      const button = within(bar).getByTitle(title);
      expect(button, title).toBeDisabled();
      expect(button, title).toHaveAttribute('data-offline-disabled');
    }
    const run = within(bar).getByRole('button', { name: 'Run selected nodes' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('data-offline-disabled');
    expect(within(bar).getByTitle('Copy selected nodes')).toBeEnabled();
    // Note shows for one node.
    act(() => useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2')] }));
    expect(screen.getByRole('button', { name: 'Note for agents' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Note for agents' })).toHaveAttribute('data-offline-disabled');
  });

  it('H2/L4: on reconnect each control follows React again (a running graph keeps Run disabled)', () => {
    useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
    render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>);
    act(() => noteBackendConnection('offline'));
    act(() => useGraphStore.setState({ isExecuting: true }));
    act(() => noteBackendConnection('online'));
    expect(screen.getByRole('button', { name: 'Run selected nodes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run selected nodes' })).not.toHaveAttribute('data-offline-disabled');
    act(() => useGraphStore.setState({ isExecuting: false }));
    expect(screen.getByRole('button', { name: 'Run selected nodes' })).toBeEnabled();
  });

  it('a press on a disabled control pulses the banner (one listener, no observer)', () => {
    let blocked = 0;
    const stop = subscribeBlockedEdits(() => { blocked += 1; });
    useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
    render(<ReactFlowProvider><BackendConnectionStatus /><SelectionToolbar /></ReactFlowProvider>);
    act(() => noteBackendConnection('offline'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run selected nodes' }));
    expect(blocked).toBe(1);
    fireEvent.pointerDown(screen.getByTitle('Copy selected nodes'));
    expect(blocked).toBe(1);
    stop();
  });
});

describe('the Inspector while offline (typing and opening it, the H1 path)', () => {
  it('its fields are disabled with the mark, it settles, and they come back on reconnect', async () => {
    useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
    useUIStore.getState().selectNode('n1');
    act(() => noteBackendConnection('offline'));
    const { container } = render(<Inspector embedded />);
    await settle();
    const fields = [...container.querySelectorAll('textarea, input:not([type="search"]), select')]
      .filter((field) => !(field as HTMLInputElement).placeholder?.startsWith('Search'));
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toBeDisabled();
      expect(field).toHaveAttribute('data-offline-disabled');
    }
    expect(observerCallbacks).toBeLessThan(5);
    act(() => noteBackendConnection('online'));
    for (const field of fields) expect(field).toBeEnabled();
  });
});

describe('the context menu while offline', () => {
  it('every item is disabled with the mark', () => {
    useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n4', null);
    render(<ContextMenu />);
    act(() => noteBackendConnection('offline'));
    for (const name of ['Run This Node', 'Leave a note for agents…', /^Duplicate/, /^Delete/]) {
      const item = screen.getByRole('button', { name });
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute('data-offline-disabled');
    }
  });

  it('the empty canvas\'s note is disabled too', () => {
    useUIStore.getState().showContextMenu({ x: 20, y: 30 }, null, { x: 1, y: 2 });
    render(<ContextMenu />);
    act(() => noteBackendConnection('offline'));
    expect(screen.getByRole('button', { name: 'Leave a note for agents here…' })).toBeDisabled();
  });
});

describe('a rename being typed when the connection drops (L5)', () => {
  it('keeps its draft, disabled, with no line; Enter after reconnect saves it', () => {
    const renameNode = vi.fn();
    useGraphStore.setState({ renameNode });
    render(<NodeLabel nodeId="n1" label="Text Input" displayName="Text Input" />);
    fireEvent.doubleClick(screen.getByText('Text Input'));
    const input = screen.getByRole('textbox', { name: 'Node name' });
    fireEvent.change(input, { target: { value: 'Brief draft' } });
    act(() => noteBackendConnection('offline'));
    expect(screen.getByRole('textbox', { name: 'Node name' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Node name' })).toHaveValue('Brief draft');
    expect(screen.getByRole('textbox', { name: 'Node name' })).toHaveAttribute('data-offline-disabled');
    fireEvent.blur(screen.getByRole('textbox', { name: 'Node name' }));
    expect(renameNode).not.toHaveBeenCalled();
    act(() => noteBackendConnection('online'));
    const back = screen.getByRole('textbox', { name: 'Node name' });
    expect(back).toBeEnabled();
    expect(back).toHaveValue('Brief draft');
    fireEvent.keyDown(back, { key: 'Enter' });
    expect(renameNode).toHaveBeenCalledWith('n1', 'Brief draft');
  });

  it('a double-click while offline doesn\'t open a rename', () => {
    noteBackendConnection('offline');
    render(<NodeLabel nodeId="n1" label="Text Input" displayName="Text Input" />);
    fireEvent.doubleClick(screen.getByText('Text Input'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the library while offline', () => {
  it('still browses; its items show as disabled, don\'t drag, and a click adds nothing', () => {
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode });
    useUIStore.setState((state) => ({
      libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
      panels: { ...state.panels, library: { ...state.panels.library, visible: true } },
    }));
    noteBackendConnection('offline');
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse Text nodes' }));
    const item = screen.getByRole('button', { name: 'Text Input' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('draggable', 'false');
    fireEvent.click(item);
    expect(addNode).not.toHaveBeenCalled();
  });

  it('"Set up" is disabled with the mark (dimmed, not-allowed) and opens nothing', () => {
    const openProviderSetup = vi.fn();
    useUIStore.setState((state) => ({
      openProviderSetup,
      settingsCache: { ...state.settingsCache, apiKeys: {}, loaded: true },
      libraryCollapsed: { __nebulaLibraryInit: true },
      panels: { ...state.panels, library: { ...state.panels.library, visible: true } },
    }));
    noteBackendConnection('offline');
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse Image nodes' }));
    fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'Nano Banana' } });
    const setUp = screen.getAllByRole('button', { name: /^Connection settings for / })[0];
    expect(setUp).toBeDisabled();
    expect(setUp).toHaveAttribute('data-offline-disabled');
    fireEvent.click(setUp);
    expect(openProviderSetup).not.toHaveBeenCalled();
  }, 20_000);
});

describe('the project bar while offline', () => {
  it('hides "Save failed · Retry" while offline and shows it again online', () => {
    useProjectStore.setState({ activeProject: { id: 'A', name: 'Harbor' } as never, screen: 'workspace',
      saveStatus: 'error', saveError: null } as never);
    render(<ProjectWorkspaceControls />);
    expect(screen.getByRole('button', { name: 'Save failed · Retry' })).toBeInTheDocument();
    act(() => noteBackendConnection('offline'));
    expect(screen.queryByRole('button', { name: 'Save failed · Retry' })).not.toBeInTheDocument();
    act(() => noteBackendConnection('online'));
    expect(screen.getByRole('button', { name: 'Save failed · Retry' })).toBeInTheDocument();
  });
});

describe('the banner (GM, round 15 item 1)', () => {
  const css = readFileSync(join(__dirname, '../src/App.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('keeps the same y whether or not the selection toolbar shows: fixed, top 150px, nothing moves it', () => {
    const rule = /\.backend-connection\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/top:\s*150px/);
    // No other rule sets its top (no toolbar-dependent offset), except the
    // home screen's own place under its top bar (GM, round 17 C).
    const others = [...css.matchAll(/([^{}]*\.backend-connection[^{}]*)\{([^}]*)\}/g)]
      .filter(([, selector]) => selector.trim().split(/\s*\n\s*/).at(-1) !== '.backend-connection')
      .filter(([, selector]) => selector.trim() !== ".backend-connection[data-placement='home']");
    for (const [, selector, body] of others) expect(body, selector).not.toMatch(/(^|;|\s)top:/);
  });
});

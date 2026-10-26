import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi, UseBoundStore } from 'zustand';
import { Toolbar } from '../../src/components/panels/Toolbar';
import { GRAPH_LOAD_EVENT, GRAPH_SAVE_EVENT } from '../../src/lib/graphFileActions';
import { ConnectionLostError, RequestFailedError } from '../../src/lib/errorCopy';

interface ToolbarGraph {
  isExecuting: boolean;
  isImportingGraph: boolean;
  isCancelling: boolean;
  createLaunchingIds: string[];
  providerStartAmbiguities: unknown[];
  providerRecoveries: unknown[];
  nodes: { id: string }[];
  executeGraph: () => void;
  cancelExecution: () => void;
  autoLayout: () => void;
  clearGraph: (options?: { undoStep?: object }) => void;
  loadGraph: (...args: unknown[]) => void;
  beginUndoStep: () => object;
  cancelUndoStep: (step: object) => void;
}

interface ToolbarUI {
  resetPanelLayout: () => void;
  settingsCache: { apiKeys: Record<string, string>; loaded: boolean };
  viewMode: 'canvas' | 'create' | 'editor' | 'commons';
  commonsEnabled: boolean;
  canvasFocusRequest: unknown | null;
  canvasFocusRevision: number;
  canvasViewportRevision: number;
}

const mocks = vi.hoisted(() => ({
  graph: null as UseBoundStore<StoreApi<ToolbarGraph>> | null,
  ui: null as UseBoundStore<StoreApi<ToolbarUI>> | null,
  execute: vi.fn(), cancel: vi.fn(), layout: vi.fn(), clear: vi.fn(), load: vi.fn(),
  undoStep: { step: 'before clear' }, beginStep: vi.fn(), cancelStep: vi.fn(),
  reset: vi.fn(), fit: vi.fn(), fetch: vi.fn(), cli: vi.fn(),
  zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
  flow: { transform: [0, 0, 1] as [number, number, number], minZoom: 0.1, maxZoom: 4 },
}));

import { CANVAS_NOTICE_EVENT, type CanvasNoticeDetail } from '../../src/lib/canvasNotice';
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ fitView: mocks.fit, zoomIn: mocks.zoomIn, zoomOut: mocks.zoomOut, zoomTo: mocks.zoomTo }),
  useStore: <T,>(selector: (state: typeof mocks.flow) => T) => selector(mocks.flow),
  // Fit view reads the canvas size to frame open proposals' ghosts (useFitCanvasView).
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));
vi.mock('../../src/store/graphStore', async () => {
  const { create } = await import('zustand');
  mocks.graph = create<ToolbarGraph>(() => ({
    isExecuting: false, isImportingGraph: false, isCancelling: false,
    createLaunchingIds: [], providerStartAmbiguities: [], providerRecoveries: [], nodes: [{ id: 'n1' }],
    executeGraph: mocks.execute, cancelExecution: mocks.cancel, autoLayout: mocks.layout,
    clearGraph: mocks.clear, loadGraph: mocks.load,
    beginUndoStep: () => { mocks.beginStep(); return mocks.undoStep; }, cancelUndoStep: mocks.cancelStep,
  }));
  return { useGraphStore: mocks.graph };
});
vi.mock('../../src/store/uiStore', async () => {
  const { create } = await import('zustand');
  mocks.ui = create<ToolbarUI>(() => ({ resetPanelLayout: mocks.reset, viewMode: 'canvas', commonsEnabled: false,
    canvasFocusRequest: null, canvasFocusRevision: 0, canvasViewportRevision: 0,
    settingsCache: { apiKeys: {}, loaded: true } }));
  return { useUIStore: mocks.ui };
});
// The price table has its own tests; here it stays unloaded so Run reads "N paid".
vi.mock('../../src/store/pricingStore', async () => {
  const { create } = await import('zustand');
  return { usePricingStore: create(() => ({ table: null, loading: false, load: async () => {} })) };
});
vi.mock('../../src/lib/backend', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('../../src/lib/api', () => ({ fetchCLIGraph: () => mocks.cli() }));
vi.mock('../../src/lib/canvasFit', () => ({ CANVAS_ZOOM_DURATION: 200, CANVAS_FIT_DURATION: 300, computeCanvasFitPadding: () => 0.2 }));

const INITIAL_GRAPH = { ...mocks.graph!.getState() };
const notices = vi.fn();
const onNotice = (event: Event) => notices((event as CustomEvent<CanvasNoticeDetail>).detail.text);
const INITIAL_UI = { ...mocks.ui!.getState() };
function openActions() {
  const trigger = screen.getByRole('button', { name: 'Canvas actions' });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, panel: screen.getByRole('region', { name: 'Canvas actions' }) };
}

describe('Canvas toolbar hierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.graph!.setState(INITIAL_GRAPH, true);
    mocks.ui!.setState(INITIAL_UI, true);
    mocks.fetch.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    // Error copy round 3f (GM): the alerts are canvas notices now.
    notices.mockReset();
    window.addEventListener(CANVAS_NOTICE_EVENT, onNotice);
  });
  afterEach(() => {
    cleanup();
    window.removeEventListener(CANVAS_NOTICE_EVENT, onNotice);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // GM - Design, 2026-10-23: notices sit "just above the bottom bar", and the
  // Inspector clamps "so it stays above the bottom bar". Both read where the
  // bar really starts, measured here, not a fixed number.
  it('publishes where the bar starts, its open Canvas actions panel included', () => {
    vi.stubGlobal('innerHeight', 800);
    const root = document.documentElement;
    const { unmount } = render(<Toolbar />);
    const bar = screen.getByRole('group', { name: 'Canvas controls' });
    expect(bar).toHaveAttribute('data-bottom-bar');
    bar.getBoundingClientRect = () => new DOMRect(395, 729, 490, 47);
    fireEvent(window, new Event('resize'));
    expect(root.style.getPropertyValue('--bottom-bar-clearance')).toBe('71px');
    const { panel } = openActions();
    // Marked as the panel: it covers only its own width (lib/bottomBar.ts).
    expect(panel).toHaveAttribute('data-bottom-bar', 'panel');
    panel.getBoundingClientRect = () => new DOMRect(485, 480, 310, 237);
    fireEvent(window, new Event('resize'));
    expect(root.style.getPropertyValue('--bottom-bar-clearance')).toBe('320px');
    unmount();
    expect(root.style.getPropertyValue('--bottom-bar-clearance')).toBe('');
    vi.unstubAllGlobals();
  });

  it('keeps zoom on the bar: steps, a live percentage that resets to 100%, and fit', () => {
    mocks.flow.transform = [0, 0, 0.87];
    render(<Toolbar />);
    const zoom = screen.getByRole('group', { name: 'Zoom' });
    fireEvent.click(within(zoom).getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(within(zoom).getByRole('button', { name: 'Zoom out' }));
    expect(mocks.zoomIn).toHaveBeenCalledWith({ duration: 200 });
    expect(mocks.zoomOut).toHaveBeenCalledWith({ duration: 200 });
    fireEvent.click(within(zoom).getByRole('button', { name: 'Zoom 87%, reset to 100%' }));
    expect(mocks.zoomTo).toHaveBeenCalledWith(1, { duration: 200 });
    fireEvent.click(within(zoom).getByRole('button', { name: 'Fit view' }));
    expect(mocks.fit).toHaveBeenCalledWith(expect.objectContaining({ duration: 300 }));
    mocks.flow.transform = [0, 0, 1];
  });

  it('disables zoom steps at the canvas limits', () => {
    mocks.flow.transform = [0, 0, 4];
    const { unmount } = render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Zoom in' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(false);
    unmount();
    mocks.flow.transform = [0, 0, 0.1];
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(true);
    mocks.flow.transform = [0, 0, 1];
  });

  it('keeps Run and Canvas actions named, and defers secondary controls without executing', () => {
    render(<Toolbar />);
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Canvas actions' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Save graph' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Zoom' })).getByRole('button', { name: 'Fit view' })).toBeInTheDocument();
    const { trigger, panel } = openActions();
    expect(trigger).toHaveAttribute('aria-controls', panel.id);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveFocus();
    expect(within(panel).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Save graphCtrl / ⌘ S', 'Load graphCtrl / ⌘ O', 'Import CLI graph', 'Clear canvas…', 'Arrange nodes', 'Reset panels',
    ]);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.cli).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('region', { name: 'Canvas actions' })).not.toBeInTheDocument();
  });

  it('closes with Escape and restores the trigger without passing node shortcuts to Canvas', () => {
    const canvasKey = vi.fn();
    render(<div onKeyDown={canvasKey}><Toolbar /></div>);
    const { trigger, panel } = openActions();
    const save = within(panel).getByRole('button', { name: 'Save graph' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(save, { key: 'Delete' });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(canvasKey).not.toHaveBeenCalled();
    fireEvent.keyDown(save, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Canvas actions' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('dismisses on outside pointer or focus while leaving the new focus alone', () => {
    render(<><Toolbar /><button>Outside control</button></>);
    openActions();
    const outside = screen.getByRole('button', { name: 'Outside control' });
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole('region', { name: 'Canvas actions' })).not.toBeInTheDocument();
    openActions();
    act(() => outside.focus());
    expect(screen.queryByRole('region', { name: 'Canvas actions' })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it('allows ordinary Tab navigation within the disclosure and dismisses after focus leaves', () => {
    render(<><Toolbar /><button>Next control</button></>);
    const { trigger, panel } = openActions();
    const actions = within(panel).getAllByRole('button');
    expect(actions.every((button) => button.tabIndex === 0)).toBe(true);
    fireEvent.keyDown(trigger, { key: 'Tab' });
    act(() => actions[0].focus());
    expect(actions[0]).toHaveFocus();
    expect(panel).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Next control' }).focus());
    expect(screen.queryByRole('region', { name: 'Canvas actions' })).not.toBeInTheDocument();
  });

  it('dispatches each file shortcut once and closes, preserving its existing app controller', () => {
    const onSave = vi.fn();
    const onLoad = vi.fn();
    window.addEventListener(GRAPH_SAVE_EVENT, onSave);
    window.addEventListener(GRAPH_LOAD_EVENT, onLoad);
    try {
      render(<Toolbar />);
      const { trigger, panel } = openActions();
      fireEvent.keyDown(within(panel).getByRole('button', { name: 'Save graph' }), { key: 's', metaKey: true });
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole('region', { name: 'Canvas actions' })).not.toBeInTheDocument();
      openActions();
      fireEvent.keyDown(trigger, { key: 'o', ctrlKey: true });
      expect(onLoad).toHaveBeenCalledTimes(1);
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(GRAPH_SAVE_EVENT, onSave);
      window.removeEventListener(GRAPH_LOAD_EVENT, onLoad);
    }
  });

  it.each([
    [{ isExecuting: true }, 'Wait for the active run to finish.'],
    [{ isImportingGraph: true }, 'Wait for the graph import to finish.'],
    [{ createLaunchingIds: ['preparing'] }, 'Wait for generation preparation to finish.'],
  ])('keeps replacement and saving blocked while unavailable: %j', (state, reason) => {
    mocks.graph!.setState(state);
    const onSave = vi.fn();
    const onLoad = vi.fn();
    window.addEventListener(GRAPH_SAVE_EVENT, onSave);
    window.addEventListener(GRAPH_LOAD_EVENT, onLoad);
    try {
      render(<Toolbar />);
      const { panel, trigger } = openActions();
      for (const name of ['Save graph', 'Load graph', 'Import CLI graph', 'Clear canvas…']) {
        const button = within(panel).getByRole('button', { name });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(reason);
        fireEvent.click(button);
      }
      fireEvent.keyDown(trigger, { key: 's', ctrlKey: true });
      fireEvent.keyDown(trigger, { key: 'o', metaKey: true });
      expect(onSave).not.toHaveBeenCalled();
      expect(onLoad).not.toHaveBeenCalled();
      expect(window.confirm).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.cli).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(GRAPH_SAVE_EVENT, onSave);
      window.removeEventListener(GRAPH_LOAD_EVENT, onLoad);
    }
  });

  it('shows paid-start review as the reason saving is blocked without changing replacement admission', () => {
    mocks.graph!.setState({ providerStartAmbiguities: [{ id: 'review' }] });
    render(<Toolbar />);
    const { panel } = openActions();
    expect(within(panel).getByRole('button', { name: 'Save graph' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Save graph' })).toHaveAccessibleDescription('Check the waiting World Labs run before you save.');
    expect(within(panel).getByRole('button', { name: 'Load graph' })).toBeEnabled();
  });

  it('keeps Stop explicit during a run and prevents repeat cancellation while stopping', () => {
    mocks.graph!.setState({ isExecuting: true });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    act(() => mocks.graph!.setState({ isCancelling: true }));
    const stopping = screen.getByRole('button', { name: 'Stopping…' });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(stopping);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });

  it('requires clear confirmation in product language and only clears after backend acceptance', async () => {
    mocks.graph!.setState({ providerRecoveries: [{ id: 'recovery' }], providerStartAmbiguities: [{ id: 'review' }] });
    let finishClear: (value: { ok: boolean }) => void;
    mocks.fetch.mockReturnValue(new Promise((resolve) => { finishClear = resolve; }));
    render(<Toolbar />);
    const { panel, trigger } = openActions();
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear canvas…' }));
    expect(trigger).toHaveFocus();
    expect(window.confirm).toHaveBeenCalledWith('Clear the canvas? 1 node will be removed, and the stored canvas used by connected tools will be reset. Save your graph first to keep a copy.');
    expect(mocks.fetch).toHaveBeenCalledWith('/api/graph?force=true', { method: 'DELETE' });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.graph!.getState().providerRecoveries).toHaveLength(1);
    await act(async () => finishClear!({ ok: true }));
    expect(mocks.graph!.getState().providerRecoveries).toEqual([]);
    expect(mocks.graph!.getState().providerStartAmbiguities).toEqual([]);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    // One undo step, taken before the backend clear's graphSync can empty the canvas.
    expect(mocks.beginStep).toHaveBeenCalledTimes(1);
    expect(mocks.clear).toHaveBeenCalledWith({ undoStep: mocks.undoStep });
  });

  it('leaves canvas and provider recovery state intact after clear is refused', async () => {
    mocks.graph!.setState({ providerRecoveries: [{ id: 'recovery' }] });
    mocks.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: 'Provider is still settling.' }) });
    render(<Toolbar />);
    const { panel } = openActions();
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear canvas…' }));
    // error-copy round 2 (GM): the heading names the action, then the reason.
    await waitFor(() => expect(notices).toHaveBeenCalledWith("Couldn't clear the canvas. Provider is still settling."));
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.cancelStep).toHaveBeenCalledWith(mocks.undoStep);
    expect(mocks.graph!.getState().providerRecoveries).toHaveLength(1);
    expect(mocks.graph!.getState().nodes).toHaveLength(1);
  });

  it('error-copy round 2: a refused clear with no reason says GM\'s line, never the status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    render(<Toolbar />);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Clear canvas…' }));
    await waitFor(() => expect(notices).toHaveBeenCalledWith(
      "Couldn't clear the canvas. Try again, or reload if it keeps happening."));
  });

  it('does not request clear after a declined confirmation or a run starting during confirmation', () => {
    render(<Toolbar />);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Clear canvas…' }));
    expect(mocks.fetch).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockImplementationOnce(() => { mocks.graph!.setState({ isExecuting: true }); return true; });
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Clear canvas…' }));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('rechecks graph admission after CLI fetch instead of replacing a running graph', async () => {
    let finishCLI: (value: { nodes: unknown[]; edges: unknown[] }) => void;
    mocks.cli.mockReturnValue(new Promise((resolve) => { finishCLI = resolve; }));
    render(<Toolbar />);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Import CLI graph' }));
    act(() => mocks.graph!.setState({ isExecuting: true }));
    await act(async () => finishCLI!({ nodes: [], edges: [] }));
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.fit).not.toHaveBeenCalled();
  });

  it('fits the imported graph only while the same Canvas target and viewport are current', async () => {
    vi.useFakeTimers();
    mocks.cli.mockResolvedValue({ nodes: [{ id: 'imported' }], edges: [] });
    render(<Toolbar />);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Import CLI graph' }));
    await act(async () => undefined);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.fit).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(50));
    expect(mocks.fit).toHaveBeenCalledWith({ padding: 0.2, duration: 300 });
  });

  it.each([
    { viewMode: 'create' as const },
    { canvasFocusRequest: { nodeId: 'other' } },
    { canvasFocusRevision: 1 },
    { canvasViewportRevision: 1 },
  ])('does not refit after import when navigation or viewport ownership changes: %j', async (state) => {
    vi.useFakeTimers();
    mocks.cli.mockResolvedValue({ nodes: [{ id: 'imported' }], edges: [] });
    render(<Toolbar />);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Import CLI graph' }));
    await act(async () => undefined);
    act(() => mocks.ui!.setState(state));
    await act(async () => vi.advanceTimersByTime(50));
    expect(mocks.fit).not.toHaveBeenCalled();
  });

  it('does not revive an import fit after navigating away and back or unmounting', async () => {
    vi.useFakeTimers();
    mocks.cli.mockResolvedValue({ nodes: [{ id: 'imported' }], edges: [] });
    const view = render(<Toolbar />);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Import CLI graph' }));
    await act(async () => undefined);
    act(() => { mocks.ui!.setState({ viewMode: 'create' }); mocks.ui!.setState({ viewMode: 'canvas' }); });
    await act(async () => vi.advanceTimersByTime(50));
    expect(mocks.fit).not.toHaveBeenCalled();
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Import CLI graph' }));
    await act(async () => undefined);
    view.unmount();
    await act(async () => vi.advanceTimersByTime(50));
    expect(mocks.fit).not.toHaveBeenCalled();
  });

  it('ignores a CLI response arriving after the toolbar unmounts', async () => {
    let finishCLI: (value: { nodes: unknown[]; edges: unknown[] }) => void;
    mocks.cli.mockReturnValue(new Promise((resolve) => { finishCLI = resolve; }));
    const view = render(<Toolbar />);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Import CLI graph' }));
    view.unmount();
    await act(async () => finishCLI!({ nodes: [{ id: 'imported' }], edges: [] }));
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.fit).not.toHaveBeenCalled();
  });

  // Error copy round 3e (GM): "Couldn't import the CLI graph." then the
  // reason; it said "Could not fetch CLI graph — is the backend running?".
  it.each([
    [new ConnectionLostError(new TypeError('Failed to fetch')), "Nebula's server isn't answering. Make sure it's running, then try again."],
    [new RequestFailedError("Couldn't load the canvas.", 503), "Nebula didn't respond. Try again."],
    [new Error('boom'), "Try again, or reload if it keeps happening."],
  ])('a failed CLI import names the action over the reason (%#)', async (error, reason) => {
    mocks.cli.mockRejectedValue(error);
    render(<Toolbar />);
    fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Import CLI graph' }));
    await waitFor(() => expect(notices).toHaveBeenCalledWith(`Couldn't import the CLI graph. ${reason}`));
  });

  it('runs layout only after explicit selection and preserves Reset panels behavior', () => {
    window.localStorage.setItem('nebula:agentLog:pos', 'synthetic');
    const resetEvent = vi.fn();
    window.addEventListener('nebula:layout-reset', resetEvent);
    try {
      render(<Toolbar />);
      fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Arrange nodes' }));
      expect(mocks.layout).toHaveBeenCalledTimes(1);
      fireEvent.click(within(openActions().panel).getByRole('button', { name: 'Reset panels' }));
      expect(mocks.reset).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem('nebula:agentLog:pos')).toBeNull();
      expect(resetEvent).toHaveBeenCalledTimes(1);
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('nebula:layout-reset', resetEvent);
    }
  });
});

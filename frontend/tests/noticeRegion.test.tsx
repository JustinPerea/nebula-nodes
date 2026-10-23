import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * GM - Design, 2026-10-23: "move the notice out of the canvas layer ... Put
 * notices in one app-level region above every panel (above layer 10),
 * bottom-centre, sitting just above the bottom bar. Proposal-bar notices and
 * every 3g canvas notice go there."
 *
 * The canvas notice used to render inside the proposal bar's React Flow
 * Panel, inside `.react-flow` (a z-index 0 stacking context), so a floating
 * panel at layer 10+ covered it. The Canvas fixture here keeps that real
 * shape: a `.react-flow` box holding the real proposal bar.
 */

vi.mock('../src/lib/api', async (original) => ({
  ...await original<typeof import('../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({ runCostConfirmUsd: 1 }), fetchCLIGraph: () => new Promise(() => {}),
}));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...await original<typeof import('../src/lib/kreaConnection')>(),
  getKreaConnection: vi.fn().mockResolvedValue({ status: 'disconnected' }),
}));
vi.mock('../src/lib/agentNotes', async (original) => ({
  ...await original<typeof import('../src/lib/agentNotes')>(),
  fetchAgentNotes: vi.fn().mockResolvedValue({ projectId: 'p1', notes: [], unread: 0, keptWith: 'project' }),
}));
vi.mock('../src/hooks/useCommonsCapability', () => ({ useCommonsCapability: vi.fn() }));
vi.mock('../src/hooks/useZoomManifest', () => ({ useZoomManifest: vi.fn() }));
vi.mock('../src/components/projects/ProjectCoordinator', () => ({ ProjectCoordinator: () => null }));
vi.mock('../src/components/Canvas', async () => {
  const { ProposalBar } = await import('../src/components/canvas/DeferredCanvasOverlays');
  return {
    Canvas: () => (
      <div className="react-flow" data-testid="canvas" style={{ zIndex: 0 }}>
        <button type="button" data-testid="pane">Canvas pane</button>
        <ProposalBar />
      </div>
    ),
  };
});
vi.mock('../src/components/GraphFileActions', () => ({ GraphFileActions: () => null }));
vi.mock('../src/components/BackendConnectionStatus', () => ({ BackendConnectionStatus: () => null }));
vi.mock('../src/components/ProviderRecoveryStatus', () => ({ ProviderRecoveryStatus: () => null }));
vi.mock('../src/components/WorkspaceRail', () => ({ WorkspaceRail: () => null }));
vi.mock('../src/components/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('../src/components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../src/components/onboarding/OnboardingOverlay', () => ({ OnboardingOverlay: () => null }));
vi.mock('../src/components/panels/NodeLibrary', () => ({ NodeLibrary: () => null }));
vi.mock('../src/components/panels/AssetsPanel', () => ({ AssetsPanel: () => null }));
vi.mock('../src/components/panels/RunHistoryPanel', () => ({ RunHistoryPanel: () => null }));
vi.mock('../src/components/panels/NodeInspectorPopover', () => ({
  NodeInspectorPopover: () => <div className="node-inspector-popover panel" data-testid="inspector">Inspector</div>,
}));
vi.mock('../src/components/panels/Toolbar', () => ({ Toolbar: () => null }));
vi.mock('../src/components/panels/AgentLog', () => ({ AgentLog: () => null }));
vi.mock('../src/components/panels/Settings', () => ({ Settings: () => null }));
vi.mock('../src/components/panels/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../src/components/agent-notes/AgentNotesCorner', () => ({ AppAgentNotes: () => null }));
vi.mock('../src/components/create-studio/CreateView', () => ({
  CreateView: () => <div className="create-studio" data-testid="studio">Creator Studio</div>,
}));

import App from '../src/App';
import { useUIStore } from '../src/store/uiStore';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { showNotice } from '../src/lib/canvasNotice';

// The region and the proposal bar are lazy chunks: under a loaded machine
// their import alone can take longer than findBy's 1 s default.
const LAZY = { timeout: 10_000 };
const SLOW = 20_000;

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const initialProjects = useProjectStore.getState();
const initialProposals = useCanvasProposalsStore.getState();

beforeEach(() => {
  useUIStore.setState({ ...initialUI, hasOnboarded: true, viewMode: 'canvas' }, true);
  useGraphStore.setState({ nodes: [], edges: [], runHistory: [], activeRuns: [], undoNotice: null });
  useProjectStore.setState({ ...initialProjects, screen: 'workspace', initialized: true, loading: false,
    activeProject: { id: 'p1', name: 'Harbor' } as never }, true);
  usePricingStore.setState({ table: { currencies: {}, nodes: {} }, loading: false });
});
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  useProjectStore.setState(initialProjects, true);
  useCanvasProposalsStore.setState(initialProposals, true);
});

/** The one app-level region: not inside the canvas, a Studio, or any panel. */
function expectInRegion(element: HTMLElement, root: HTMLElement) {
  const region = element.closest('[data-notice-region]');
  expect(region, 'the notice renders in the app-level notice region').not.toBeNull();
  expect(element.closest('.react-flow')).toBeNull();
  expect(element.closest('[data-testid="studio"]')).toBeNull();
  expect(element.closest('.panel')).toBeNull();
  // Mounted by App itself, beside the screens, never inside one.
  expect(region!.parentElement).toBe(root);
  expect(document.querySelectorAll('[data-notice-region]')).toHaveLength(1);
}

/** The notice (role status or alert) that says `text`. */
async function noticeWith(text: string): Promise<HTMLElement> {
  const line = await screen.findByText(text, {}, LAZY);
  const notice = line.closest<HTMLElement>('[role="status"], [role="alert"]');
  expect(notice).not.toBeNull();
  return notice!;
}

/** An agent's edit that Cmd-Z just undid: "Undid … edit" with Redo. */
function undidAgentEdit() {
  const entry = { agentName: 'Claude Code', agentColor: '#E8825A' } as never;
  useGraphStore.setState({
    redoStack: [entry],
    undoNotice: { id: 9001, text: 'Undid Claude Code\'s edit', agentColor: '#E8825A', offer: 'redo', entry },
  });
}

describe('one app-level notice region', () => {
  it('the canvas undo notice renders there, outside .react-flow, with its Redo', async () => {
    const { container } = render(<App />);
    await screen.findByTestId('canvas');
    act(undidAgentEdit);
    const notice = await noticeWith('Undid Claude Code\'s edit');
    expect(notice).toHaveAttribute('role', 'status');
    expectInRegion(notice, container);
    const redo = screen.getByRole('button', { name: 'Redo' });
    expect(notice.contains(redo)).toBe(true);
  }, SLOW);

  it('a canvasNotice event (an alert turned notice) lands there too', async () => {
    const { container } = render(<App />);
    await screen.findByTestId('canvas');
    act(() => showNotice("Couldn't save the graph. Try again, or reload if it keeps happening."));
    const notice = await screen.findByRole('alert', {}, LAZY);
    expectInRegion(notice, container);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useGraphStore.getState().undoNotice).toBeNull();
  }, SLOW);

  it('the proposal bar\'s own notice (Run when the current run finishes) lands there', async () => {
    const { container } = render(<App />);
    await screen.findByTestId('canvas');
    act(() => useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Claude Code', nodeIds: ['n7'] } as never }));
    const line = await screen.findByText(/Run them when the current run finishes/, {}, LAZY);
    expectInRegion(line, container);
    expect(line.closest('.proposal-bar-panel')).toBeNull();
  }, SLOW);

  it('a Studio screen\'s notice lands in the same region, outside the Studio', async () => {
    useUIStore.setState({ viewMode: 'create' });
    const { container } = render(<App />);
    await screen.findByTestId('studio', {}, LAZY);
    act(() => useGraphStore.getState().notify("Couldn't add Veo 3.1. Reconnect, then add it again."));
    const notice = await screen.findByRole('alert', {}, LAZY);
    expectInRegion(notice, container);
  }, SLOW);

  it('stays one region across a screen switch', async () => {
    render(<App />);
    await screen.findByTestId('canvas');
    act(() => useGraphStore.getState().notify('Imported. One note.', 'info'));
    await noticeWith('Imported. One note.');
    act(() => useUIStore.setState({ viewMode: 'create' }));
    await screen.findByTestId('studio', {}, LAZY);
    expect(document.querySelectorAll('[data-notice-region]')).toHaveLength(1);
    expect((await noticeWith('Imported. One note.')).closest('[data-notice-region]')).not.toBeNull();
  }, SLOW);
});

/**
 * GM: "the region never takes pointer events outside its notices." jsdom does
 * no hit testing, so `topmostAt` applies the browser's rule to the real
 * stylesheet's computed values: the topmost box at a point gets the click
 * unless its pointer-events is none, and then the box under it does. The
 * live check clicks the real canvas beside a real notice.
 */
describe('clicks around the region', () => {
  let sheet: HTMLStyleElement;
  beforeEach(() => {
    sheet = document.createElement('style');
    // The region's own rules (round 2: in the entry) and the notices'.
    sheet.textContent = ['noticeRegion.css', 'canvasProposals.css']
      .map((file) => readFileSync(join(__dirname, '../src/styles', file), 'utf8')).join('\n');
    document.head.append(sheet);
  });
  afterEach(() => sheet.remove());

  function topmostAt(x: number, y: number, stack: HTMLElement[]): HTMLElement {
    for (const element of stack) {
      const box = element.getBoundingClientRect();
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (inside && getComputedStyle(element).pointerEvents !== 'none') return element;
    }
    throw new Error(`nothing takes a click at ${x},${y}`);
  }

  it('land on the canvas under the region\'s empty space, and on the notice over it', async () => {
    render(<App />);
    const pane = await screen.findByTestId('pane');
    const paneClicks = vi.fn();
    pane.addEventListener('click', paneClicks);
    act(() => useGraphStore.getState().notify('Imported. One note.', 'info'));
    const notice = await noticeWith('Imported. One note.');
    const region = notice.closest<HTMLElement>('[data-notice-region]');
    expect(region).not.toBeNull();
    expect(getComputedStyle(region!).pointerEvents).toBe('none');
    expect(getComputedStyle(notice).pointerEvents).toBe('auto');
    // Every box between the region and its notices passes clicks through too.
    const wrappers: HTMLElement[] = [];
    for (let element = notice.parentElement; element && element !== region; element = element.parentElement) {
      wrappers.push(element);
      expect(getComputedStyle(element).pointerEvents).toBe('none');
    }
    // 1280x800: the region spans the width above the bar; the notice sits in its middle.
    region!.getBoundingClientRect = () => new DOMRect(16, 600, 1248, 121);
    wrappers.forEach((element) => { element.getBoundingClientRect = () => new DOMRect(16, 600, 1248, 121); });
    notice.getBoundingClientRect = () => new DOMRect(380, 681, 520, 40);
    pane.getBoundingClientRect = () => new DOMRect(0, 0, 1280, 800);
    const stack = [notice, ...wrappers, region!, pane];
    fireEvent.click(topmostAt(200, 700, stack));
    expect(paneClicks).toHaveBeenCalledTimes(1);
    fireEvent.click(topmostAt(640, 700, stack));
    expect(paneClicks).toHaveBeenCalledTimes(1);
  }, SLOW);
});

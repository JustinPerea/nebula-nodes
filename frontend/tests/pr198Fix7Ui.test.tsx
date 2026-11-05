import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * PR #198 fix round 7, rendered:
 * - M2 / N1 / N2: one run lock in lib/canvasLock, ordered run, then follow,
 *   then offline. Where the run's line wins, the control carries no
 *   following mark (data-following-disabled), so it never looks like the
 *   follow lock's.
 * - GM r9 bug 1: no toolbar tooltip starts with a "Delete:"-style prefix.
 * - L7 (GM r9 answer 5): the notice region keeps clear of the docked log.
 * - The Delete key and Cmd+Z during this tab's run say the run's line, also
 *   while following.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
    useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
      selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
  };
});

import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { Toolbar } from '../src/components/panels/Toolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { AgentLog } from '../src/components/panels/AgentLog';
import { RUN_LOCK_REASON } from '../src/lib/cinemaScene';
import { FOLLOWING_MARK, canvasLockOf } from '../src/lib/canvasLock';
import { resetCanvasFollowForTests, setFollowingSwitch } from '../src/lib/canvasFollow';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
afterEach(() => {
  cleanup();
  act(() => { resetCanvasFollowForTests(); setFollowingSwitch(null); resetBackendConnectionForTests(); });
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  document.documentElement.style.removeProperty('--agent-log-clearance');
});

const WAIT = 'Wait for “Second canvas” to open.';
const textNode = (id: string, label: string, selected = true) => ({ id, type: 'model-node', position: { x: 0, y: 0 }, selected,
  data: { label, definitionId: 'text-input', params: {}, outputs: {}, state: 'idle' } }) as unknown as Node<NodeData>;
const follow = () => act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
const button = (name: RegExp) => screen.getAllByRole('button')
  .find((b) => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));

describe('M2: the run lock comes first, and carries no following mark', () => {
  it('canvasLockOf: run, then follow, then offline', () => {
    const lock = canvasLockOf({ projectName: 'Second canvas', agent: 'Codex' }, true);
    expect(lock.act(undefined, { run: true })).toEqual({ disabled: true, title: RUN_LOCK_REASON });
    expect(lock.act(undefined, { run: true, runTitle: 'Wait for the graph import to finish.' }).title)
      .toBe('Wait for the graph import to finish.');
    expect(lock.act()).toMatchObject({ disabled: true, title: WAIT, [FOLLOWING_MARK]: '' });
    expect(canvasLockOf(null, true).act()).toMatchObject({ disabled: true });
    expect(canvasLockOf(null, true).act().title).not.toBe(RUN_LOCK_REASON);
  });

  it('SelectionToolbar, run and follow: the run-locked buttons have no following mark; Ask keeps it', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief'), textNode('n2', 'Note')], edges: [], isExecuting: true });
    follow();
    render(<SelectionToolbar />);
    for (const name of [/^Run/i, /^Duplicate/i, /^Arrange/i, /^Delete/i]) {
      const b = button(name)!;
      expect(b.getAttribute('title'), String(name)).toBe(RUN_LOCK_REASON);
      expect(b.hasAttribute(FOLLOWING_MARK), String(name)).toBe(false);
    }
    expect(button(/^Ask/i)!.hasAttribute(FOLLOWING_MARK)).toBe(true);
  });

  it('the Canvas actions panel: Load, Import, Clear and Arrange read the run line over following', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief', false)], edges: [], isExecuting: true });
    follow();
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    for (const name of ['Load graph', 'Import CLI graph', 'Clear canvas', 'Arrange']) {
      const b = screen.getAllByRole('button').find((candidate) => candidate.textContent?.startsWith(name));
      expect(b, name).toBeDefined();
      expect(b, name).toBeDisabled();
      expect(b!.getAttribute('title'), name).toBe(RUN_LOCK_REASON);
      expect(b!.hasAttribute(FOLLOWING_MARK), name).toBe(false);
    }
  });

  it('the Canvas actions panel offline and running: the run line, not offline\'s', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief', false)], edges: [], isExecuting: true });
    act(() => noteBackendConnection(false));
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    const arrange = screen.getAllByRole('button').find((b) => b.textContent?.startsWith('Arrange'))!;
    expect(arrange.getAttribute('title')).toBe(RUN_LOCK_REASON);
  });

  it('the context menu, run and follow: Run, Duplicate and Delete read the run line', () => {
    useGraphStore.setState({ nodes: [textNode('n4', 'Brief')], edges: [], isExecuting: true });
    follow();
    act(() => useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n4', null));
    render(<ContextMenu />);
    for (const name of [/^Run This Node/i, /^Duplicate/i, /^Delete/i]) {
      const b = button(name)!;
      expect(b, String(name)).toBeDefined();
      expect(b.getAttribute('title'), String(name)).toBe(RUN_LOCK_REASON);
      expect(b.hasAttribute(FOLLOWING_MARK), String(name)).toBe(false);
    }
  });

  it('the Delete key and Cmd+Z during this tab\'s run say the run\'s line, also while following', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief')], edges: [], isExecuting: true, undoNotice: null } as never);
    follow();
    useGraphStore.getState().deleteSelected();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(JSON.stringify(useGraphStore.getState().undoNotice ?? useGraphStore.getState())).toMatch(/Wait for the active run to finish/);
    const step = { kind: 'snapshot', nodes: [], edges: [] };
    useGraphStore.setState({ undoNotice: null, undoStack: [step], redoStack: [] } as never);
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
    expect(JSON.stringify(useGraphStore.getState().undoNotice)).toMatch(/Wait for the active run to finish/);
  });
});

describe('GM r9 bug 1: no tooltip starts with a "Delete:"-style prefix', () => {
  const PREFIX = /^[A-Z][A-Za-z ]{1,24}:\s/;
  it('every SelectionToolbar button, in each lock state', () => {
    useGraphStore.setState({ nodes: [textNode('n1', 'Brief'), textNode('n2', 'Note')], edges: [] });
    for (const setup of [() => {}, () => useGraphStore.setState({ isExecuting: true }), follow,
      () => act(() => noteBackendConnection(false))]) {
      setup();
      const { unmount } = render(<SelectionToolbar />);
      for (const b of screen.getAllByRole('button')) expect(b.getAttribute('title') ?? '', b.textContent ?? '').not.toMatch(PREFIX);
      unmount();
    }
  });

  it('no toolbar source builds one', () => {
    const root = resolve(__dirname, '../src/components');
    for (const file of ['SelectionToolbar.tsx', 'panels/Toolbar.tsx', 'nodes/ModelNode.tsx',
      'cinema-studio/CinemaStudioToolbar.tsx', 'cinema-studio/CinemaShotsRail.tsx']) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source, file).not.toMatch(/['`"](Delete|Run|Duplicate|Arrange|Ask|Remove|Next step): ['`"]?\s*\+/);
      expect(source, file).not.toMatch(/`(Delete|Run|Duplicate|Arrange|Ask|Remove|Next step): \$\{/);
    }
  });
});

describe('fix round 8, L5 (review 7): the last run-locked buttons read canvasLock\'s order', () => {
  it('DeferredRunNotice\'s Run: the run line, no following mark, while running and following', async () => {
    const { DeferredRunNotice } = await import('../src/components/canvas/DeferredRunNotice');
    const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n1'] } } as never);
    follow();
    act(() => useGraphStore.setState({ isExecuting: true }));
    render(<DeferredRunNotice />);
    const run = screen.getByRole('button', { name: /Run/ });
    expect(run).toBeDisabled();
    expect(run.getAttribute('title')).toBe(RUN_LOCK_REASON);
    expect(run.hasAttribute(FOLLOWING_MARK)).toBe(false);
    act(() => useGraphStore.setState({ isExecuting: false }));
    expect(screen.getByRole('button', { name: /Run/ }).getAttribute('title')).toBe(WAIT);
    useCanvasProposalsStore.setState({ deferredRun: null } as never);
  });

  it('the sources: Rerun with latest source, Forget and the deferred Run go through lock.act with the run', () => {
    const root = resolve(__dirname, '../src/components');
    const sites: [string, RegExp][] = [
      ['nodes/ModelNode.tsx', /lock\.act\(\{ disabled: !latestPaperSourceReady,[\s\S]{0,240}\{ run: isExecuting \}\)\}\s*onClick[\s\S]{0,240}Rerun with latest source/],
      ['panels/RunHistoryPanel.tsx', /lock\.act\(\{ disabled: clearingRecovery === key, title: FORGET_TITLE, kept: 'forget' \}, \{ run: isExecuting \}\)/],
      ['canvas/DeferredRunNotice.tsx', /lock\.act\(\{ kept: 'run' \}, \{ run: isExecuting \|\| runStarting \}\)/],
    ];
    for (const [file, pattern] of sites) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source, file).toMatch(pattern);
      expect(source, file).not.toMatch(/disabled=\{isExecuting \|\| (!latestPaperSourceReady|clearingRecovery|runStarting)/);
    }
  });
});

describe('L7: the notice region keeps clear of the docked Agent log', () => {
  const rect = (left: number, right: number, top: number, bottom: number) =>
    ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  it('docked at the bottom right: the clearance is its width plus the gap; hidden: none', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1180 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(820, 1164, 440, 784));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true } as never);
    const { unmount } = render(<AgentLog />);
    expect(document.documentElement.style.getPropertyValue('--agent-log-clearance')).toBe(`${1180 - 820 + 8}px`);
    // Its top edge plus the gap, for a proposal card that sits above it (PR #216 r1).
    expect(document.documentElement.style.getPropertyValue('--agent-log-top')).toBe(`${800 - 440 + 8}px`);
    // Hidden: both go (review 1 LOW-6 of PR #216: the notice stack reads them).
    act(() => { useUIStore.setState({ agentLogEnabled: false } as never); });
    expect(document.documentElement.style.getPropertyValue('--agent-log-clearance')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--agent-log-top')).toBe('');
    act(() => { useUIStore.setState({ agentLogEnabled: true } as never); });
    expect(document.documentElement.style.getPropertyValue('--agent-log-top')).toBe(`${800 - 440 + 8}px`);
    unmount();
    expect(document.documentElement.style.getPropertyValue('--agent-log-clearance')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--agent-log-top')).toBe('');
    spy.mockRestore();
  });

  it('giving way to the card (GM r6) never moves the line it writes: its top is the one it has with no give', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1180 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    // Squeezed to 200 of its own 344 (the person's resize, inline).
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(820, 1164, 584, 784));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true } as never);
    const { container, unmount } = render(<AgentLog />);
    const log = container.querySelector<HTMLElement>('.agent-log')!;
    act(() => { log.style.height = '344px'; window.dispatchEvent(new Event('resize')); });
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--agent-log-top')).toBe(`${800 - 440 + 8}px`);
    expect(root.getPropertyValue('--agent-log-natural-h')).toBe('344px');
    expect(root.getPropertyValue('--agent-log-floor')).not.toBe('');
    expect(log.dataset.docked).toBe('true');
    // Its floor: the header and 2 rows of the body, with the body's padding
    // and the log's borders (37 + 8 + 8 + 2 × 20 + 2).
    const head = log.querySelector<HTMLElement>('.agent-log__drag-row')!;
    const body = log.querySelector<HTMLElement>('.agent-log__body')!;
    Object.defineProperty(head, 'offsetHeight', { configurable: true, value: 37 });
    Object.defineProperty(log, 'offsetHeight', { configurable: true, value: 344 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 342 });
    body.style.padding = '8px 0';
    body.style.lineHeight = '20px';
    for (const msg of log.querySelectorAll<HTMLElement>('.agent-log__msg')) msg.style.lineHeight = '20px';
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(root.getPropertyValue('--agent-log-floor')).toBe('95px');
    unmount();
    expect(root.getPropertyValue('--agent-log-natural-h')).toBe('');
    expect(root.getPropertyValue('--agent-log-floor')).toBe('');
    spy.mockRestore();
  });

  it('the log\'s body gives way on the spring, held at its foot, down to its floor (GM r6)', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/layouts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const block = /\.agent-log\.agent-log--open\[data-docked\],\s*\.agent-log\.agent-log--open\[data-floating\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/--agent-log-give: var\(--agent-log-squeeze, 0px\);/);
    expect(block).toMatch(/--agent-log-shown-h: clamp\(var\(--agent-h-closed\), calc\(var\(--agent-log-natural-h, 80vh\) - var\(--agent-log-give\)\), var\(--agent-log-natural-h, 80vh\)\);/);
    // Bounded by the shown height while a give is in force (review 3 MEDIUM-2).
    expect(block).toMatch(/max-height:\s*max\(var\(--agent-log-shown-h\), calc\(80vh - var\(--agent-log-give\) \* 10000000\)\)/);
    expect(block).toMatch(/transition:\s*--agent-log-give 420ms var\(--agent-log-spring\)/);
    expect(css).toMatch(/\.agent-log\.agent-log--open\[data-docked\] \.agent-log__body,/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.agent-log\.agent-log--open\[data-docked\],/);
  });

  it('dragged to the top left: no clearance', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1180 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(16, 360, 16, 300));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true } as never);
    render(<AgentLog />);
    expect(document.documentElement.style.getPropertyValue('--agent-log-clearance')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--agent-log-top')).toBe('');
    spy.mockRestore();
  });

  it('the region reads it', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/noticeRegion.css'), 'utf8');
    // Round 18 (GM r28 2): the right inset is the larger of the gutter, the log and a right side panel.
    expect(css).toMatch(/--notice-r:\s*max\(var\(--page-gutter, 16px\), var\(--agent-log-clearance, 0px\), var\(--notice-right-clearance, 0px\)\)/);
    expect(css).toMatch(/\bright:\s*max\(var\(--notice-r\),/);
    expect(css).toMatch(/bottom:\s*var\(--notice-region-bottom\)/);
  });
});

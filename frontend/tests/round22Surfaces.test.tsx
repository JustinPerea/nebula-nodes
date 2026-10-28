import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * Round 22 of PR #195, GM - Design's blockers A and B, verbatim:
 * A. "Every action surface shares the read-only state while following,
 *    tooltip “Wait for “X” to open.”": the selection toolbar's Run, Ask,
 *    Note, Duplicate and Delete; the Inspector's Run, Duplicate and Delete
 *    (the panel and the popover); node card buttons, context menus and
 *    anything else that acts. Settings and Copy may stay enabled. Disabled
 *    is the neutral look, never orange, and hover never highlights a
 *    disabled Run. Offline plus following: disabled too. One source: the
 *    following and offline state (lib/canvasLock.ts), so no surface drifts.
 * B. While following the bar hides the save status and the node count;
 *    "Opening “X”…" takes the whole slot at the same width, the full name in
 *    the bar's tooltip and aria-label, in every follow frame.
 * Toasts (GM answer 1): up to 3 lines, never cut with "…"; Undo and × sit
 * vertically centred on the right.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }),
}));
vi.mock('../src/lib/canvasSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasSelection')>(),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Inspector } from '../src/components/panels/Inspector';
import { NodeInspectorPopover } from '../src/components/panels/NodeInspectorPopover';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { NodeLabel } from '../src/components/nodes/NodeLabel';
import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { Toolbar } from '../src/components/panels/Toolbar';
import { ProjectWorkspaceControls } from '../src/components/projects/ProjectWorkspaceControls';
import { noteBackendConnection, resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetCanvasFollowForTests, setFollowingSwitch, subscribeFollowPulse } from '../src/lib/canvasFollow';
import { useFollowingReadOnly } from '../src/hooks/useFollowingReadOnly';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_PROJECT_STATE = { ...useProjectStore.getState() };
const WAIT = 'Wait for “beta” to open.';
const follow = () => act(() => setFollowingSwitch({ projectName: 'beta', agent: 'Codex' }));

function textNode(id: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: 'Hero prompt', definitionId: 'text-input', params: { value: 'hello' }, outputs: {}, state: 'idle' } };
}

function Gate() {
  useFollowingReadOnly();
  return null;
}

beforeEach(() => {
  cleanup();
  resetBackendConnectionForTests();
  resetCanvasFollowForTests();
  useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  useUIStore.setState(INITIAL_UI_STATE, true);
  useProjectStore.setState(INITIAL_PROJECT_STATE, true);
});
afterEach(() => {
  cleanup();
  resetCanvasFollowForTests();
  resetBackendConnectionForTests();
  vi.restoreAllMocks();
});

/** An action surface's control while following: disabled, marked, GM's tooltip. */
function expectWaiting(control: HTMLElement, what: string) {
  expect(control, what).toBeDisabled();
  expect(control, what).toHaveAttribute('data-following-disabled');
  expect(control, what).toHaveAttribute('title', WAIT);
}

const modes = [
  ['following', () => follow()],
  ['offline and following', () => { act(() => noteBackendConnection('offline')); follow(); }],
] as const;

describe('A: every action surface, while following', () => {
  for (const [mode, enter] of modes) {
    it(`${mode}: the selection toolbar's Run, Ask, Note, Duplicate, Arrange and Delete; Copy stays`, () => {
      useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2', true)], edges: [] });
      render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>);
      enter();
      const bar = screen.getByRole('toolbar');
      expectWaiting(within(bar).getByRole('button', { name: 'Run selected nodes' }), 'Run');
      expectWaiting(within(bar).getByRole('button', { name: /^Ask/ }), 'Ask');
      expectWaiting(within(bar).getByRole('button', { name: /^Duplicate/ }), 'Duplicate');
      expectWaiting(within(bar).getByRole('button', { name: /^Arrange/ }), 'Arrange');
      expectWaiting(within(bar).getByRole('button', { name: 'Delete selected nodes' }), 'Delete');
      expect(within(bar).getByRole('button', { name: /^Copy/ })).toBeEnabled();
      act(() => useGraphStore.setState({ nodes: [textNode('n1', true), textNode('n2')] }));
      expectWaiting(screen.getByRole('button', { name: 'Note for agents' }), 'Note');
    });

    it(`${mode}: the Inspector panel's Run, Duplicate and Delete, and its fields`, async () => {
      useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
      useUIStore.getState().selectNode('n1');
      const { container } = render(<Inspector embedded />);
      enter();
      expectWaiting(screen.getByRole('button', { name: /^Run/ }), 'Run');
      expectWaiting(screen.getByRole('button', { name: /^Duplicate/ }), 'Duplicate');
      expectWaiting(screen.getByRole('button', { name: /^Delete/ }), 'Delete');
      for (const field of container.querySelectorAll('textarea')) expect(field).toBeDisabled();
    });

    it(`${mode}: the node popover's Inspector`, () => {
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
        enter();
        const popover = document.querySelector('.node-inspector-popover') as HTMLElement;
        expect(popover).not.toBeNull();
        expectWaiting(within(popover).getByRole('button', { name: /^Run/ }), 'Run');
        expectWaiting(within(popover).getByRole('button', { name: /^Duplicate/ }), 'Duplicate');
        expectWaiting(within(popover).getByRole('button', { name: /^Delete/ }), 'Delete');
        expect(popover.querySelector('textarea')).toBeDisabled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it(`${mode}: the context menu's items`, () => {
      useGraphStore.setState({ nodes: [textNode('n4', true)], edges: [] });
      useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n4', null);
      render(<ContextMenu />);
      enter();
      for (const name of ['Run This Node', 'Leave a note for agents…', /^Duplicate/, /^Delete/]) {
        expectWaiting(screen.getByRole('button', { name }), String(name));
      }
    });

    it(`${mode}: the bottom toolbar's Run`, () => {
      useGraphStore.setState({ nodes: [textNode('n1')], edges: [] });
      render(<ReactFlowProvider><Toolbar /></ReactFlowProvider>);
      enter();
      const run = screen.getByRole('button', { name: /^Run/ });
      expect(run).toHaveAttribute('title', WAIT);
      expect(run.getAttribute('aria-disabled') === 'true' || (run as HTMLButtonElement).disabled).toBe(true);
    });

    it(`${mode}: the library's items show disabled and don't drag`, () => {
      useUIStore.setState((state) => ({
        libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
        panels: { ...state.panels, library: { ...state.panels.library, visible: true } },
      }));
      render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
      enter();
      fireEvent.click(screen.getByRole('button', { name: 'Browse Text nodes' }));
      const item = screen.getByRole('button', { name: 'Text Input' });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAttribute('draggable', 'false');
    });
  }

  it('a node title: no rename opens while following', () => {
    render(<NodeLabel nodeId="n1" label="Hero prompt" displayName="Text Input" />);
    follow();
    fireEvent.doubleClick(screen.getByText('Hero prompt'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a press on a control disabled while following pulses the project bar', () => {
    let pulses = 0;
    const stop = subscribeFollowPulse(() => { pulses += 1; });
    useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
    render(<ReactFlowProvider><Gate /><SelectionToolbar /></ReactFlowProvider>);
    follow();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Run selected nodes' }));
    expect(pulses).toBe(1);
    stop();
  });

  it('back to normal when the follow ends', () => {
    useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
    render(<ReactFlowProvider><SelectionToolbar /></ReactFlowProvider>);
    follow();
    act(() => setFollowingSwitch(null));
    const run = screen.getByRole('button', { name: 'Run selected nodes' });
    expect(run).toBeEnabled();
    expect(run).not.toHaveAttribute('data-following-disabled');
    expect(run.getAttribute('title')).not.toBe(WAIT);
  });
});

describe('A: one source for the read-only state', () => {
  const SRC = join(__dirname, '../src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
  // Surfaces outside the canvas, read-only only while offline: they don't
  // act on the canvas a follow replaces.
  const OFFLINE_ONLY = new Set([
    'components/BackendConnectionStatus.tsx',
    'components/ProviderReadinessBadge.tsx',
    'components/canvas/CanvasViewReporter.tsx',
    'components/commons/CommonsCloseBatch.tsx',
    'components/commons/CommonsDetail.tsx',
    'components/commons/CommonsEvaluation.tsx',
    'components/commons/CommonsLeavePopover.tsx',
    'components/commons/CommonsReview.tsx',
    'components/commons/CommonsSettings.tsx',
    'components/commons/CommonsView.tsx',
    'components/panels/ChatPanel.tsx',
    'components/panels/ForgetRecoveryConfirm.tsx',
    'components/panels/PermissionCard.tsx',
    'components/panels/Settings.tsx',
    'components/panels/settings/ProvidersTab.tsx',
    'components/projects/ProjectHome.tsx',
    'components/projects/ProjectWorkspaceControls.tsx',
    // PR #198's hook that hides a screen's load-failure notice offline: not a
    // canvas edit, so the lock has nothing to add (the #195 merge).
    'hooks/useOfflineHiddenNotice.ts',
    'lib/canvasLock.ts',
    'lib/useBackendOffline.ts',
  ]);

  it('every canvas surface reads it from lib/canvasLock, never offline on its own', () => {
    const direct = files(SRC).filter((path) => /\buseBackendOffline\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path)).filter((path) => !OFFLINE_ONLY.has(path));
    expect(direct).toEqual([]);
  });

  it('the canvas surfaces use it', () => {
    for (const file of ['components/SelectionToolbar.tsx', 'components/panels/Inspector.tsx', 'components/ContextMenu.tsx',
      'components/nodes/ModelNode.tsx', 'components/nodes/NodeLabel.tsx', 'components/panels/Toolbar.tsx',
      'components/cinema-studio/CinemaShotPanel.tsx', 'components/canvas/ProposalBar.tsx', 'components/Canvas.tsx',
      'components/nodes/VideoEditAction.tsx', 'components/panels/NodeLibrary.tsx', 'components/ConnectionPopup.tsx',
      'components/panels/RunHistoryPanel.tsx']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(/\buseCanvasLock\(/);
    }
  });
});

describe('A: the disabled Run looks neutral', () => {
  const css = readFileSync(join(__dirname, '../src/styles/canvas.css'), 'utf8');
  /** The block whose selector list names `selector` exactly. */
  const rule = (selector: string) => {
    const match = new RegExp(`(?:^|\\n|,\\s*)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]`).exec(css);
    return match ? css.slice(match.index, css.indexOf('}', match.index)) : '';
  };
  it('a disabled Run takes the toolbar\'s disabled look: no fill, never orange', () => {
    const disabled = rule('.selection-toolbar__button--primary:disabled');
    expect(disabled).toMatch(/background: transparent;/);
    expect(disabled).toMatch(/opacity: 0\.34;/);
    expect(disabled).not.toMatch(/accent/);
  });
  it('hover never highlights a disabled control', () => {
    expect(css).toContain('.selection-toolbar__button:hover:not(:disabled)');
    expect(css).toContain('.selection-toolbar__button--primary:hover:not(:disabled)');
    expect(rule('.selection-toolbar__button--primary:disabled:hover')).toMatch(/background: transparent;/);
  });
});

describe('B: the project bar while following', () => {
  const project = { id: 'alpha', name: 'Glass campaign', createdAt: '', updatedAt: '', lastOpenedAt: null, nodeCount: 1,
    edgeCount: 0, thumbnail: null };
  for (const status of ['saved', 'unsaved', 'saving', 'error'] as const) {
    for (const offline of [false, true]) {
      it(`hides the save state and the count (${status}${offline ? ', offline' : ''})`, () => {
        useProjectStore.setState({ activeProject: project as never, screen: 'workspace', saveStatus: status });
        useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [] });
        const { container } = render(<ProjectWorkspaceControls />);
        if (offline) act(() => noteBackendConnection('offline'));
        follow();
        const bar = container.querySelector('.project-workspace-controls') as HTMLElement;
        expect(container.querySelector('.project-workspace-controls__status')).toBeNull();
        expect(container.querySelector('.project-workspace-controls__retry')).toBeNull();
        expect(container.querySelector('.project-workspace-controls__count')).toBeNull();
        expect(bar.textContent).toBe('Opening “beta”…');
        expect(bar).toHaveAttribute('title', 'Opening “beta”…');
        expect(bar).toHaveAttribute('aria-label', 'Opening “beta”…');
      });
    }
  }

  it('a long name: the bar keeps its width, the tooltip and label carry the whole name', () => {
    useProjectStore.setState({ activeProject: project as never, screen: 'workspace', saveStatus: 'unsaved' });
    const { container } = render(<ProjectWorkspaceControls />);
    const bar = container.querySelector('.project-workspace-controls') as HTMLElement;
    bar.getBoundingClientRect = () => ({ width: 221, height: 30, x: 0, y: 0, top: 0, left: 0, right: 221, bottom: 30, toJSON: () => ({}) });
    const name = 'Second canvas with a name far too long for the project bar';
    act(() => setFollowingSwitch({ projectName: name, agent: 'Codex' }));
    expect(bar.style.width).toBe('221px');
    expect(bar).toHaveAttribute('title', `Opening “${name}”…`);
    expect(bar).toHaveAttribute('aria-label', `Opening “${name}”…`);
  });

  it('the paused state hides too', () => {
    useProjectStore.setState({ activeProject: project as never, screen: 'workspace', saveStatus: 'paused',
      savePaused: { bytes: 20_000_000 } as never });
    const { container } = render(<ProjectWorkspaceControls />);
    follow();
    expect(container.querySelector('.project-workspace-controls__paused')).toBeNull();
  });
});

describe('Toasts: up to 3 lines, never cut, buttons centred on the right (GM answer 1)', () => {
  const css = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8');
  const block = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };
  it('the line wraps and is never cut with an ellipsis', () => {
    const text = block('.canvas-undo-notice__text');
    expect(text).not.toMatch(/text-overflow: ellipsis/);
    expect(text).not.toMatch(/white-space: nowrap/);
    expect(text).toMatch(/overflow-wrap: anywhere;/);
    expect(css).not.toMatch(/canvas-undo-notice[^{]*\{[^}]*line-clamp/);
  });
  it('Undo and × sit vertically centred on the right', () => {
    const notice = block('.canvas-undo-notice');
    expect(notice).toMatch(/align-items: center;/);
    expect(block('.canvas-undo-notice__text')).toMatch(/flex: 1 1 auto;/);
  });
  it('wide enough that an agent-clear line takes at most 3 lines', () => {
    expect(block('.canvas-undo-notice')).toMatch(/max-width: min\(var\(--notice-max-w, 560px\), calc\(100vw - 32px\)\);/);
  });
});

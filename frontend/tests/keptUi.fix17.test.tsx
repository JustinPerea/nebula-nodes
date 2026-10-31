/**
 * Round 17 of PR #199 (GM r23), the person's side of a kept canvas:
 * - b: a node added while kept has a tab-local id no agent can address, so
 *   its id slot is empty (its room kept) until it has a real `nN` id.
 * - c: on such a node the selection bar shows Note and Ask, both locked with
 *   GM's lines (Note is no longer hidden: hiding it shifted the bar), and
 *   both Run buttons, the selection bar's and the bottom bar's, are locked
 *   through the shared lock with "You can run nodes after you save it as a
 *   project.".
 * - d: the Discard confirm sits on the same scrim as the app's other
 *   aria-modal confirms (the shared `.prompt-dialog` overlay).
 * - 3: the restore notice's chunk-retry fallback says the full kept sentence
 *   while kept, never the short line, and never suggests reloading.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}),
  disconnect: vi.fn(), send: vi.fn(), setViewing: vi.fn(), notePersonAct: vi.fn(), setKeptEdits: vi.fn() } }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}`,
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
  useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(), getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    screenToFlowPosition: (point: { x: number; y: number }) => point }),
  useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
    selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
  useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
}));

import { ModelNode } from '../src/components/nodes/ModelNode';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { Toolbar } from '../src/components/panels/Toolbar';
import { KeptDiscardConfirm } from '../src/components/projects/KeptDiscardConfirm';
import { ProjectHome, type ProjectHomeProps } from '../src/components/projects/ProjectHome';
import { RESTORE_COPY_FALLBACK, RESTORE_COPY_FALLBACK_KEPT } from '../src/components/projects/restoreCopyCore';
import { primeRestoreCopyForTests, restoreCopyNow, setRestoreCopyImportForTests } from '../src/components/projects/restoreCopyLoader';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { KEPT_MARK } from '../src/lib/canvasLock';
import { keptLockTitle, resetKeptCanvasForTests, setCanvasKept } from '../src/lib/keptCanvas';
import type { CatalogRestore } from '../src/lib/projects';

const TAB_ONLY = '69c47ca6-0b1e-4c55-9d6a-2f3e8b1c0d4e';

function node(id: string, selected = true): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'typed' }, outputs: {}, state: 'idle' },
  };
}

beforeEach(() => {
  resetKeptCanvasForTests();
  window.localStorage.removeItem('nebula:chat-selection');
  useGraphStore.setState({ nodes: [node('n1')], edges: [], isExecuting: false, runStarting: false });
  useUIStore.setState({ selectedNodeId: null });
});
afterEach(() => {
  cleanup();
  resetKeptCanvasForTests();
  vi.restoreAllMocks();
});

const button = (name: RegExp) => screen.getByRole('button', { name });

describe('GM r23 (b): a tab-only node shows no id', () => {
  function renderCard(id: string) {
    const data = node(id).data;
    useGraphStore.setState({ nodes: [{ ...node(id), id }] });
    const view = render(<ModelNode {...({ id, data, selected: false } as NodeProps)} />);
    return { view, chip: () => view.container.querySelector<HTMLElement>('.model-node__id-chip') };
  }

  it('a tab-local id leaves the slot empty: no text, nothing to drag, hidden from assistive tech', () => {
    const { view, chip } = renderCard(TAB_ONLY);
    const slot = chip();
    expect(slot).not.toBeNull();
    expect(slot).toHaveClass('model-node__id-chip--pending');
    expect(slot!.textContent).toBe('');
    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(slot).not.toHaveAttribute('draggable');
    expect(slot).not.toHaveAttribute('title');
    expect(view.container.textContent).not.toContain('69c4');
  });

  it('a real id shows, and can be dragged into the chat', () => {
    const { chip } = renderCard('n2');
    expect(chip()!.textContent).toBe('n2');
    expect(chip()).not.toHaveClass('model-node__id-chip--pending');
    expect(chip()).toHaveAttribute('draggable', 'true');
    expect(chip()).toHaveAttribute('title', 'Drag into the chat panel to reference this node');
  });

  it('a nearly-real id (n2a, N2) is still tab-only', () => {
    for (const id of ['n2a', 'N2', 'n']) {
      const { chip } = renderCard(id);
      expect(chip()!.textContent).toBe('');
      cleanup();
    }
  });

  it('the empty slot keeps its room, so the header does not shift when the id arrives', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/nodes.css'), 'utf8');
    const rule = css.match(/\.model-node__id-chip--pending \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/visibility:\s*hidden/);
    expect(rule).not.toMatch(/display:\s*none/);
    expect(css).toMatch(/\.model-node__id-chip--pending::before \{ content: '[^']+'; \}/);
  });
});

describe('GM r23 (c): the selection bar on a tab-only node while kept', () => {
  it('Note and Ask both show, locked, with GM’s lines; Run is locked with the run-nodes line', () => {
    useGraphStore.setState({ nodes: [node(TAB_ONLY)] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    const expected: [RegExp, string][] = [
      [/^Note for agents$/, 'You can leave a note after you save it as a project.'],
      // GM r25 (3): the one Ask line, the agent's name or "your agent".
      [/^Ask$/, 'You can ask your agent after you save it as a project.'],
      [/^Run selected nodes$/, 'You can run nodes after you save it as a project.'],
    ];
    for (const [name, line] of expected) {
      const control = button(name);
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', line);
      expect(control).toHaveAttribute(KEPT_MARK, '');
    }
  });

  it('the lines are declared with the other kept lines (GM r25, 3: one Ask and one Note line on any node)', () => {
    expect(keptLockTitle('note')).toBe('You can leave a note after you save it as a project.');
    expect(keptLockTitle('run-nodes')).toBe('You can run nodes after you save it as a project.');
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({ agent: 'claude' }));
    expect(keptLockTitle('ask')).toBe('You can ask Claude after you save it as a project.');
  });

  it('the bar has the same controls before and after the node gets its real id (no shift)', () => {
    useGraphStore.setState({ nodes: [node(TAB_ONLY)] });
    act(() => setCanvasKept(true));
    const view = render(<SelectionToolbar />);
    const names = () => [...view.container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    const tabOnly = names();
    act(() => useGraphStore.setState({ nodes: [node('n2')] }));
    expect(names()).toEqual(tabOnly);
  });

  it('a saved node while kept keeps its own lines (the chat’s agent named)', () => {
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({ agent: 'codex' }));
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    expect(button(/^Note for agents$/)).toHaveAttribute('title', keptLockTitle('note'));
    expect(button(/^Ask$/)).toHaveAttribute('title', 'You can ask Codex after you save it as a project.');
  });

  it('with several nodes, one of them tab-only, Ask waits for agents to see it', () => {
    useGraphStore.setState({ nodes: [node('n1'), node(TAB_ONLY)] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    expect(button(/^Ask$/)).toHaveAttribute('title', 'You can ask your agent after you save it as a project.');
    expect(screen.queryByRole('button', { name: /^Note for agents$/ })).toBeNull();
  });

  it('both Run buttons are locked the same way: disabled, the shared kept mark, the run-nodes line', () => {
    act(() => setCanvasKept(true));
    render(<><SelectionToolbar /><Toolbar /></>);
    const selectionRun = button(/^Run selected nodes$/);
    const bottomRun = [...document.querySelectorAll<HTMLButtonElement>('.toolbar__button--primary')][0];
    expect(bottomRun.textContent).toContain('Run');
    for (const run of [selectionRun, bottomRun]) {
      expect(run).toBeDisabled();
      expect(run).toHaveAttribute(KEPT_MARK, '');
      expect(run).toHaveAttribute('title', 'You can run nodes after you save it as a project.');
    }
    // The selection bar's disabled Run drops the accent (the toolbar's own
    // neutral disabled look), and the kept mark's shared dimming applies.
    const canvasCss = readFileSync(resolve(__dirname, '../src/styles/canvas.css'), 'utf8');
    expect(canvasCss).toMatch(/\.selection-toolbar__button--primary:disabled,\s*\.selection-toolbar__button--primary:disabled:hover \{[^}]*background: transparent;/);
    const appCss = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
    expect(appCss).toMatch(/\[data-kept-disabled\],?\s*(\[data-tab-local-disabled\] )?\{\s*opacity: 0\.6;/);
  });
});

describe('GM r23 (d): the Discard confirm’s scrim', () => {
  it('is the shared .prompt-dialog overlay, the scrim of the app’s other aria-modal confirms', () => {
    render(<KeptDiscardConfirm onKeep={vi.fn()} onDiscard={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toHaveClass('prompt-dialog');
    const css = readFileSync(resolve(__dirname, '../src/styles/prompt-dialog.css'), 'utf8');
    expect(css.match(/^\.prompt-dialog \{([^}]*)\}/m)?.[1]).toMatch(/background: rgb\(0 0 0 \/ \d+%\);/);
    // The same overlay as Forget ID's confirm and the held-edits confirm.
    for (const other of ['panels/ForgetRecoveryConfirm.tsx', 'projects/UnsavedEditsNotice.tsx']) {
      expect(readFileSync(resolve(__dirname, '../src/components', other), 'utf8')).toMatch(/<div[^>]*className="prompt-dialog"/);
    }
  });
});

describe('GM r23 (3): the chunk-retry fallback', () => {
  const real = restoreCopyNow();
  afterEach(() => { setRestoreCopyImportForTests(null); primeRestoreCopyForTests(real); });

  const restore = { id: 'r', at: '2026-10-29T12:00:00Z', kind: 'restored', source: 'catalog.json.bak',
    damagedFile: '/p/catalog.json.damaged-1', setAside: [], addedBack: [], addedBackCount: 0,
    notAddedBack: [], notAddedBackCount: 0, damagedReadWhole: true } as unknown as CatalogRestore;
  const props = { projects: [], loading: false, busy: false, error: null,
    onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } satisfies ProjectHomeProps;

  async function fallbackFor(kept: boolean): Promise<string> {
    primeRestoreCopyForTests(null);
    setRestoreCopyImportForTests(() => Promise.reject(new Error('chunk')));
    if (kept) act(() => setCanvasKept(true));
    const view = render(<ProjectHome {...props} catalogRestore={restore} />);
    await waitFor(() => expect(view.container.querySelector('[data-restore-fallback]')).not.toBeNull());
    return view.container.querySelector('[data-restore-fallback]')!.textContent ?? '';
  }

  it('nothing kept: the short line', async () => {
    expect(await fallbackFor(false)).toBe('Nebula restored its project list.');
  });

  it('while kept: GM’s full sentence, from the entry chunk, never a reload', async () => {
    const line = await fallbackFor(true);
    expect(line).toBe('Nebula restored its project list before your latest edits were saved. They’re kept in this tab.');
    expect(line).toBe(RESTORE_COPY_FALLBACK_KEPT);
    expect(line).not.toMatch(/reload/i);
    expect(RESTORE_COPY_FALLBACK).not.toMatch(/reload/i);
  });

  it('the kept sentence is the store’s kept line, word for word', async () => {
    const { RESTORED_LIST_UNSAVED } = await import('../src/store/projectStore');
    expect(RESTORE_COPY_FALLBACK_KEPT).toBe(RESTORED_LIST_UNSAVED);
  });
});

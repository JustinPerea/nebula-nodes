/**
 * Round 18 of PR #199, the selection bar's Ask and Note (and the context
 * menu's note):
 * - GM r25 (3): while edits are kept, one wording on any node, saved (nN) or
 *   tab-only: "You can ask Codex after you save it as a project." (the chat's
 *   agent, "your agent" when none is picked) and "You can leave a note after
 *   you save it as a project.". The separate tab-only lines and GM r17's
 *   "You can add notes…" are gone.
 * - GM r26 (4): on a normal tab, a duplicated or pasted node keeps a
 *   tab-local id until the project is next opened. Ask and Note on a
 *   selection holding one are locked through the shared lock
 *   (TAB_LOCAL_MARK), Note kept in place: "You can ask an agent about this
 *   node after you reopen the project." / "You can leave a note on this node
 *   after you reopen the project.". While kept, the kept lines win. A
 *   stopgap the bulk-create PR deletes.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}),
  disconnect: vi.fn(), send: vi.fn(), setViewing: vi.fn(), notePersonAct: vi.fn(), setKeptEdits: vi.fn() } }));

import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { canvasLockOf, KEPT_MARK, TAB_LOCAL_MARK } from '../src/lib/canvasLock';
import { resetKeptCanvasForTests, setCanvasKept } from '../src/lib/keptCanvas';

const TAB_LOCAL = '69c47ca6-0b1e-4c55-9d6a-2f3e8b1c0d4e';
const ASK_KEPT_CODEX = 'You can ask Codex after you save it as a project.';
const ASK_KEPT_NONE = 'You can ask your agent after you save it as a project.';
const NOTE_KEPT = 'You can leave a note after you save it as a project.';
const ASK_LOCAL = 'You can ask an agent about this node after you reopen the project.';
const NOTE_LOCAL = 'You can leave a note on this node after you reopen the project.';

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
  window.localStorage.removeItem('nebula:chat-selection');
});

const button = (name: RegExp) => screen.getByRole('button', { name });
const ask = () => button(/^Ask$/);
const note = () => button(/^Note for agents$/);

function expectLocked(control: HTMLElement, line: string, mark: string) {
  expect(control).toBeDisabled();
  expect(control).toHaveAttribute('title', line);
  expect(control).toHaveAttribute(mark, '');
}

describe('GM r25 (3): one wording for Ask and Note while kept', () => {
  it('a tab-only node: the chat agent named, and the one note line', () => {
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({ agent: 'codex' }));
    useGraphStore.setState({ nodes: [node(TAB_LOCAL)] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    expectLocked(ask(), ASK_KEPT_CODEX, KEPT_MARK);
    expectLocked(note(), NOTE_KEPT, KEPT_MARK);
  });

  it('a tab-only node with no agent picked keeps the old line’s "your agent"', () => {
    useGraphStore.setState({ nodes: [node(TAB_LOCAL)] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    expectLocked(ask(), ASK_KEPT_NONE, KEPT_MARK);
  });

  it('a saved node: the same two lines', () => {
    window.localStorage.setItem('nebula:chat-selection', JSON.stringify({ agent: 'codex' }));
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    expectLocked(ask(), ASK_KEPT_CODEX, KEPT_MARK);
    expectLocked(note(), NOTE_KEPT, KEPT_MARK);
  });

  it('the context menu’s notes say the same line, on a node and on the canvas', () => {
    act(() => setCanvasKept(true));
    useUIStore.setState({ contextMenu: { visible: true, position: { x: 100, y: 100 }, nodeId: 'n1', flowPosition: null } });
    const view = render(<ContextMenu />);
    expectLocked(button(/Leave a note for agents…/), NOTE_KEPT, KEPT_MARK);
    view.unmount();
    useUIStore.setState({ contextMenu: { visible: true, position: { x: 100, y: 100 }, nodeId: null, flowPosition: { x: 0, y: 0 } } });
    render(<ContextMenu />);
    expectLocked(button(/Leave a note for agents here…/), NOTE_KEPT, KEPT_MARK);
  });

  it('the retired lines are nowhere in the app', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(resolve(__dirname, '../src'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/You can add notes after|You can ask an agent after you save|'note-tab-only'|'ask-tab-only'/);
    }
  });
});

describe('GM r26 (4): a tab-local node on a normal tab (a stopgap)', () => {
  it('Ask and Note are locked with GM’s lines, in the shared lock’s look; Note stays in place', () => {
    useGraphStore.setState({ nodes: [node(TAB_LOCAL)] });
    render(<SelectionToolbar />);
    expectLocked(ask(), ASK_LOCAL, TAB_LOCAL_MARK);
    expectLocked(note(), NOTE_LOCAL, TAB_LOCAL_MARK);
    expect(ask()).not.toHaveAttribute(KEPT_MARK);
  });

  it('the bar has the same controls for a tab-local node and a saved one (no shift)', () => {
    useGraphStore.setState({ nodes: [node(TAB_LOCAL)] });
    const view = render(<SelectionToolbar />);
    const names = () => [...view.container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent);
    const local = names();
    act(() => useGraphStore.setState({ nodes: [node('n2')] }));
    expect(names()).toEqual(local);
  });

  it('a saved node: Ask and Note are live', () => {
    render(<SelectionToolbar />);
    for (const control of [ask(), note()]) {
      expect(control).not.toBeDisabled();
      expect(control).not.toHaveAttribute(TAB_LOCAL_MARK);
    }
    expect(ask()).toHaveAttribute('title', 'Ask agent about selection');
  });

  it('several nodes, one tab-local: Ask is locked', () => {
    useGraphStore.setState({ nodes: [node('n1'), node(TAB_LOCAL)] });
    render(<SelectionToolbar />);
    expectLocked(ask(), ASK_LOCAL, TAB_LOCAL_MARK);
  });

  it('while kept, the kept lines win', () => {
    useGraphStore.setState({ nodes: [node(TAB_LOCAL)] });
    act(() => setCanvasKept(true));
    render(<SelectionToolbar />);
    expectLocked(ask(), ASK_KEPT_NONE, KEPT_MARK);
    expectLocked(note(), NOTE_KEPT, KEPT_MARK);
    expect(ask()).not.toHaveAttribute(TAB_LOCAL_MARK);
    expect(note()).not.toHaveAttribute(TAB_LOCAL_MARK);
  });

  it('the lock order: kept, then tab-local, then the run, following and offline', () => {
    const own = { title: 'Ask agent about selection', kept: 'ask' as const, tabLocal: 'ask' as const };
    expect(canvasLockOf(null, true).act(own)).toEqual({ [TAB_LOCAL_MARK]: '', disabled: true, title: ASK_LOCAL });
    expect(canvasLockOf(null, false).act(own, { run: true })).toEqual({ [TAB_LOCAL_MARK]: '', disabled: true, title: ASK_LOCAL });
    expect(canvasLockOf(null, false, true).act(own)).toEqual({ [KEPT_MARK]: '', disabled: true, title: ASK_KEPT_NONE });
  });

  it('the context menu’s note on a tab-local node is locked with its line', () => {
    useGraphStore.setState({ nodes: [node(TAB_LOCAL)] });
    useUIStore.setState({ contextMenu: { visible: true, position: { x: 100, y: 100 }, nodeId: TAB_LOCAL, flowPosition: null } });
    render(<ContextMenu />);
    expectLocked(button(/Leave a note for agents…/), NOTE_LOCAL, TAB_LOCAL_MARK);
  });

  it('the context menu’s note on a saved node is live', () => {
    useUIStore.setState({ contextMenu: { visible: true, position: { x: 100, y: 100 }, nodeId: 'n1', flowPosition: null } });
    render(<ContextMenu />);
    const item = button(/Leave a note for agents…/);
    expect(item).not.toBeDisabled();
    expect(item).not.toHaveAttribute(TAB_LOCAL_MARK);
  });

  it('the mark has the shared disabled look, and the stopgap says the bulk-create PR deletes it', () => {
    const appCss = readFileSync(resolve(__dirname, '../src/App.css'), 'utf8');
    expect(appCss).toMatch(/\[data-kept-disabled\],\s*\[data-tab-local-disabled\] \{\s*cursor: not-allowed !important;/);
    expect(appCss).toMatch(/\[data-kept-disabled\],\s*\[data-tab-local-disabled\] \{\s*opacity: 0\.6;/);
    const lock = readFileSync(resolve(__dirname, '../src/lib/canvasLock.ts'), 'utf8');
    expect(lock).toMatch(/STOPGAP: the bulk-create PR/);
  });
});

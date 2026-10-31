import { Profiler, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider, type Node } from '@xyflow/react';
import { CommandPalette } from '../src/components/CommandPalette';
import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

// Always-mounted panels that don't draw the canvas must not re-render on a
// graph change: on a 120-node canvas the closed palette rebuilt every
// command (model search text included) on each run event.

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };

function textNode(id: string, label: string, x = 0, y = 0): Node {
  return {
    id, type: 'model-node', position: { x, y },
    data: { definitionId: 'text-input', label, params: { value: '' }, outputs: {} },
  } as unknown as Node;
}

function counted(children: ReactNode) {
  const commits = { count: 0 };
  const view = render(
    <ReactFlowProvider>
      <Profiler id="panel" onRender={() => { commits.count += 1; }}>{children}</Profiler>
    </ReactFlowProvider>,
  );
  return { commits, view };
}

/** A graph change of the kind a run event or an agent edit makes. */
function changeOneNode() {
  act(() => {
    useGraphStore.setState((state) => ({
      nodes: state.nodes.map((node, index) => (index === 0
        ? { ...node, data: { ...node.data, params: { value: `changed ${Math.random()}` } } }
        : node)),
    }));
  });
}

describe('panels that do not draw the canvas', () => {
  beforeEach(() => {
    cleanup();
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState({ nodes: [textNode('a', 'Alpha'), textNode('b', 'Bravo', 400)] });
  });

  afterEach(() => vi.restoreAllMocks());

  it('the closed command palette does not re-render on a graph change', () => {
    const { commits } = counted(<CommandPalette />);
    commits.count = 0;
    changeOneNode();
    changeOneNode();
    expect(commits.count).toBe(0);
  });

  it('the open palette still finds canvas nodes, including one added while it is open', () => {
    render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
    act(() => { window.dispatchEvent(new CustomEvent('nebula:command-palette-open')); });
    const search = screen.getByRole('combobox', { name: 'Search commands and nodes' });
    fireEvent.change(search, { target: { value: 'Charlie' } });
    expect(screen.queryByRole('option', { name: /Charlie/ })).toBeNull();
    act(() => {
      useGraphStore.setState((state) => ({ nodes: [...state.nodes, textNode('c', 'Charlie', 800)] }));
    });
    expect(screen.getByRole('option', { name: /Charlie/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'Bravo' } });
    expect(screen.getByRole('option', { name: /Bravo/ })).toBeTruthy();
  });

  it('the open node library does not re-render on a graph change', () => {
    useUIStore.setState((state) => ({
      libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
      panels: { ...state.panels, library: { ...state.panels.library, visible: true } },
    }));
    const { commits } = counted(<NodeLibrary />);
    commits.count = 0;
    changeOneNode();
    changeOneNode();
    expect(commits.count).toBe(0);
  });

  it('the library frees a reserved slot once a node lands on it', () => {
    useUIStore.setState((state) => ({
      libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
      panels: { ...state.panels, library: { ...state.panels.library, visible: true } },
    }));
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode, nodes: [] });
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Browse Text nodes' }));
    const textInput = screen.getByRole('button', { name: 'Text Input' });

    fireEvent.click(textInput);
    const first = addNode.mock.calls[0][1] as { x: number; y: number };
    // graphSync materializes the node at the reserved slot, then it's deleted.
    act(() => { useGraphStore.setState({ nodes: [textNode('n1', 'Text', first.x, first.y)] }); });
    act(() => { useGraphStore.setState({ nodes: [] }); });

    fireEvent.click(textInput);
    expect(addNode.mock.calls[1][1]).toEqual(first);
  });
});

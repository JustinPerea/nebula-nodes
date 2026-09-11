import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';


const originalExecuteNode = useGraphStore.getState().executeNode;
const originalExecuteCluster = useGraphStore.getState().executeCluster;


function selectedNode(id: string): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    selected: true,
    data: {
      label: 'Text Input',
      definitionId: 'text-input',
      params: { value: 'hello' },
      outputs: {},
      state: 'idle',
    },
  };
}


describe('SelectionToolbar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    useGraphStore.setState({
      nodes: [],
      edges: [],
      isExecuting: false,
      clipboard: null,
      executeNode: originalExecuteNode,
      executeCluster: originalExecuteCluster,
    });
    useUIStore.setState((state) => ({
      panels: {
        ...state.panels,
        chat: { ...state.panels.chat, visible: false },
      },
    }));
  });

  it('stays absent with no selection', () => {
    render(<SelectionToolbar />);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('shows valid selection actions and disables download without outputs', () => {
    useGraphStore.setState({ nodes: [selectedNode('n1'), selectedNode('n2')] });
    render(<SelectionToolbar />);

    expect(screen.getByRole('toolbar')).toHaveAttribute('data-selected-count', '2');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByTitle('Run selected nodes')).toBeEnabled();
    expect(screen.getByTitle('Arrange selected nodes')).toBeEnabled();
    expect(screen.getByLabelText('Download selected outputs')).toBeDisabled();
  });

  it('copies selection and opens the agent without sending a message', () => {
    useGraphStore.setState({ nodes: [selectedNode('n1')] });
    render(<SelectionToolbar />);

    fireEvent.click(screen.getByTitle('Copy selected nodes'));
    expect(useGraphStore.getState().clipboard?.nodes.map((node) => node.id)).toEqual(['n1']);

    fireEvent.click(screen.getByTitle('Ask agent about selection'));
    expect(useUIStore.getState().panels.chat.visible).toBe(true);
  });

  it('runs one selected downstream node through target execution, not an isolated cluster', () => {
    const executeNode = vi.fn().mockResolvedValue(undefined);
    const executeCluster = vi.fn().mockResolvedValue(undefined);
    const prompt = { ...selectedNode('prompt'), selected: false };
    const world = {
      ...selectedNode('world'),
      data: {
        ...selectedNode('world').data,
        label: 'World Labs Environment',
        definitionId: 'worldlabs-environment',
      },
    };
    useGraphStore.setState({
      nodes: [prompt, world],
      edges: [{
        id: 'prompt-to-world',
        source: 'prompt',
        sourceHandle: 'text',
        target: 'world',
        targetHandle: 'prompt',
      }],
      executeNode,
      executeCluster,
    });
    render(<SelectionToolbar />);

    fireEvent.click(screen.getByTitle('Run selected nodes'));

    expect(executeNode).toHaveBeenCalledOnce();
    expect(executeNode).toHaveBeenCalledWith('world');
    expect(executeCluster).not.toHaveBeenCalled();
  });

  it('retains cluster execution for a deliberate multi-selection', () => {
    const executeNode = vi.fn().mockResolvedValue(undefined);
    const executeCluster = vi.fn().mockResolvedValue(undefined);
    useGraphStore.setState({
      nodes: [selectedNode('n1'), selectedNode('n2')],
      executeNode,
      executeCluster,
    });
    render(<SelectionToolbar />);

    fireEvent.click(screen.getByTitle('Run selected nodes'));

    expect(executeCluster).toHaveBeenCalledOnce();
    expect(executeCluster).toHaveBeenCalledWith(['n1', 'n2']);
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('requires confirmation and backend acknowledgement before deleting the whole selection', async () => {
    useGraphStore.setState({ nodes: [selectedNode('n1'), selectedNode('n2')] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<SelectionToolbar />);

    fireEvent.click(screen.getByLabelText('Delete selected nodes'));
    expect(useGraphStore.getState().nodes).toHaveLength(2);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByLabelText('Delete selected nodes'));
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    await waitFor(() => expect(useGraphStore.getState().nodes).toHaveLength(0));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };

describe('NodeLibrary accessible authoring', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    useUIStore.setState(INITIAL_UI_STATE, true);
    useUIStore.setState((state) => ({
      libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
      panels: {
        ...state.panels,
        library: { ...state.panels.library, visible: true },
      },
    }));
  });

  it('exposes node definitions as focusable buttons with click-to-add behavior', () => {
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode });

    render(
      <ReactFlowProvider>
        <NodeLibrary />
      </ReactFlowProvider>,
    );

    const textInput = screen.getByRole('button', { name: 'Text Input' });
    expect(textInput).toHaveAttribute('draggable', 'true');
    expect(textInput).toHaveAttribute('tabindex', '0');

    textInput.focus();
    fireEvent.keyDown(textInput, { key: 'Enter' });
    fireEvent.click(textInput);
    fireEvent.click(textInput, { detail: 2 });

    expect(addNode).toHaveBeenCalledOnce();
    expect(addNode).toHaveBeenCalledWith(
      'text-input',
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  });
});

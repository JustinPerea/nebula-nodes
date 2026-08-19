import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { CommandPalette } from '../src/components/CommandPalette';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };

describe('CommandPalette node insertion', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    useUIStore.setState(INITIAL_UI_STATE, true);
  });

  it('reserves distinct slots across consecutive palette additions', () => {
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode, nodes: [] });

    render(
      <ReactFlowProvider>
        <CommandPalette />
      </ReactFlowProvider>,
    );

    const insert = (query: string) => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
      const search = screen.getByRole('textbox', { name: '' });
      fireEvent.change(search, { target: { value: query } });
      fireEvent.click(screen.getByRole('button', { name: new RegExp(query) }));
    };

    insert('Cinema Scene');
    insert('Remotion Composition');

    expect(addNode).toHaveBeenCalledTimes(2);
    const [first, second] = addNode.mock.calls.map((call) => call[1]);
    expect(first).not.toEqual(second);
    expect(
      Math.abs(first.x - second.x) >= 320
      || Math.abs(first.y - second.y) >= 220,
    ).toBe(true);
  });
});

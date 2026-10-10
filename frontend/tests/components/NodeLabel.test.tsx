import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

import { NodeLabel } from '../../src/components/nodes/NodeLabel';
import { useGraphStore } from '../../src/store/graphStore';
import { NODE_RENAME_EVENT } from '../../src/lib/keyboardShortcuts';

describe('NodeLabel', () => {
  const renameNode = vi.fn();
  beforeEach(() => {
    renameNode.mockReset();
    useGraphStore.setState({ renameNode });
  });

  it('renames on double-click and saves with Enter', () => {
    render(<NodeLabel nodeId="n1" label="Text Input" displayName="Text Input" />);
    fireEvent.doubleClick(screen.getByText('Text Input'));
    const input = screen.getByRole('textbox', { name: 'Node name' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Brief' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(renameNode).toHaveBeenCalledWith('n1', 'Brief');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('cancels with Escape without renaming', () => {
    render(<NodeLabel nodeId="n1" label="Text Input" displayName="Text Input" />);
    fireEvent.doubleClick(screen.getByText('Text Input'));
    const input = screen.getByRole('textbox', { name: 'Node name' });
    fireEvent.change(input, { target: { value: 'Brief' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(renameNode).not.toHaveBeenCalled();
    expect(screen.getByText('Text Input')).toBeTruthy();
  });

  it('opens for its own node on the F2 rename event, and shows the model name once renamed', () => {
    render(<NodeLabel nodeId="n1" label="Brief" displayName="Text Input" />);
    expect(screen.getByText('Brief').getAttribute('title')).toContain('Text Input');
    act(() => { window.dispatchEvent(new CustomEvent(NODE_RENAME_EVENT, { detail: { nodeId: 'n2' } })); });
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => { window.dispatchEvent(new CustomEvent(NODE_RENAME_EVENT, { detail: { nodeId: 'n1' } })); });
    expect(screen.getByRole('textbox', { name: 'Node name' })).toHaveProperty('value', 'Brief');
  });
});

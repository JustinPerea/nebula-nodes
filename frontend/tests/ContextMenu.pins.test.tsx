import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: vi.fn() } }));

const { ContextMenu } = await import('../src/components/ContextMenu');
const { useUIStore } = await import('../src/store/uiStore');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

function open(nodeId: string | null, flowPosition: { x: number; y: number } | null = null) {
  useUIStore.getState().showContextMenu({ x: 20, y: 30 }, nodeId, flowPosition);
}

beforeEach(() => {
  useCanvasPinsStore.setState({ composer: null, pins: [], removing: {}, error: null });
});
afterEach(() => {
  cleanup();
  useUIStore.getState().hideContextMenu();
});

describe('context menu notes for agents', () => {
  it('offers a node note for backend nodes and opens the composer', () => {
    open('n4');
    render(<ContextMenu />);
    const item = screen.getByRole('button', { name: 'Leave a note for agents…' }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    expect(useCanvasPinsStore.getState().composer).toEqual({ nodeId: 'n4' });
    expect(useUIStore.getState().contextMenu.visible).toBe(false);
  });

  it('disables the node note for nodes the backend has not seen (UUID ids)', () => {
    open('7d1f6a52-2c35-4c55-9df3-111111111111');
    render(<ContextMenu />);
    const item = screen.getByRole('button', { name: 'Leave a note for agents…' }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
  });

  it('pane right-click shows a single item that pins at the flow position', () => {
    open(null, { x: 420, y: -80 });
    render(<ContextMenu />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Leave a note for agents here…']);
    fireEvent.click(buttons[0]);
    expect(useCanvasPinsStore.getState().composer).toEqual({ position: { x: 420, y: -80 } });
  });

  it('shows nothing for a pane menu without a flow position', () => {
    open(null);
    const { container } = render(<ContextMenu />);
    expect(container.firstChild).toBeNull();
  });
});

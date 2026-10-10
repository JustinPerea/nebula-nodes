import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));

vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/canvasPins', () => ({ ...api, MAX_PIN_TEXT: 280 }));

const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

function pin(text: string) {
  return {
    id: 'pin_a', text, anchor: { nodeId: 'n4' }, position: { x: 0, y: 0 }, status: 'open',
    createdAt: '2026-10-10T14:00:00+00:00', detached: false, reply: null,
  };
}

beforeEach(() => {
  useCanvasPinsStore.setState({ projectId: 'p1', pins: [], composer: null, removing: {}, error: null });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('PinComposer', () => {
  it('renders nothing until a note is being composed', () => {
    render(<PinComposer />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('caps the text and creates the pin on the composed target', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    api.createPin.mockResolvedValue(pin('warmer'));
    render(<PinComposer />);
    const input = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLInputElement;
    expect(input.maxLength).toBe(280);
    fireEvent.change(input, { target: { value: '  warmer  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    expect(api.createPin).toHaveBeenCalledWith('warmer', { nodeId: 'n4' });
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels on empty text or Cancel without calling the backend', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    const { unmount } = render(<PinComposer />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for agents' }), { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    unmount();

    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    render(<PinComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(api.createPin).not.toHaveBeenCalled();
  });

  it('shows a dismissable alert when the backend refuses the pin', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    api.createPin.mockRejectedValue(new Error('This action only works from the Nebula canvas.'));
    render(<PinComposer />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for agents' }), { target: { value: 'redo this one' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('only works from the Nebula canvas');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

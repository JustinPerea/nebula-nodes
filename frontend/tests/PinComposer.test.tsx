import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));

// Fix round 4 of PR #200: PinComposer reads project names (projectStore, which
// loads graphStore and connects), and the kept notices' own helpers.
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api, MAX_PIN_TEXT: 280 }));

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
    const input = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    // Fix round 11 (GM r12 answer 3): only what shows counts, so no native
    // maxLength (it counts escape codes). GM r20 note 1: a change past 280
    // shown characters is refused whole, never cut to fit.
    expect(input.maxLength).toBe(-1);
    fireEvent.change(input, { target: { value: 'x'.repeat(290) } });
    expect(input.value).toBe('');
    // Refused, the counter shows at once, whatever is left (GM r20 addendum).
    expect(screen.getByText('280 left')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'x'.repeat(280) } });
    expect(input.value).toBe('x'.repeat(280));
    expect(screen.getByText('0 left')).toBeTruthy();
    fireEvent.change(input, { target: { value: `${'\x1b[31m'.repeat(40)}${'y'.repeat(280)}` } });
    expect(input.value).toBe(`${'\x1b[31m'.repeat(40)}${'y'.repeat(280)}`);
    fireEvent.change(input, { target: { value: '  warmer  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send note' }));
    });
    // Round 23 (M-1): and the project it was composed on (none open here).
    expect(api.createPin).toHaveBeenCalledWith('warmer', { nodeId: 'n4' }, null);
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels on empty text or Cancel without calling the backend', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    const { unmount } = render(<PinComposer />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for agents' }), { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send note' }));
    });
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    unmount();

    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    render(<PinComposer />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(api.createPin).not.toHaveBeenCalled();
  });

  it('shows a dismissable neutral line when the backend refuses the pin, and keeps the dialog open with the note (GM r20 Q1)', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n4' });
    // Round 3e: a refusal arrives as the API's typed error (apiRequest), not a plain Error,
    // whose own text no surface shows any more.
    api.createPin.mockRejectedValue(new RequestFailedError("Couldn't save the note.", 403, { reason: 'This action only works from the Nebula canvas.' }));
    render(<PinComposer />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for agents' }), { target: { value: 'redo this one' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send note' }));
    });
    // A person-gate 403: GM r22 Q1's line, no "try again".
    expect(screen.getByRole('status').textContent).toBe('Notes can only be added from the Nebula canvas.×');
    expect((screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement).value).toBe('redo this one');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

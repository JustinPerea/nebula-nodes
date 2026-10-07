import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { ResultCard } from '../../src/components/create-studio/ResultCard';

function node(state: NodeData['state'], outputs: NodeData['outputs']): Node<NodeData> {
  return { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'n1', definitionId: 'nano-banana', params: {}, state, outputs } };
}

const noop = () => {};

describe('ResultCard zoom affordances', () => {
  it('a completed image gets a full-area overlay + corner button, and clicking the overlay zooms', () => {
    const onZoom = vi.fn();
    const { container } = render(
      <ResultCard node={node('complete', { image: { type: 'Image', value: '/api/outputs/a.png' } })}
        onOpenInCanvas={noop} onUseAsInput={noop} onDelete={noop} onZoom={onZoom} />,
    );
    const overlay = container.querySelector('.result-card__zoom-overlay');
    expect(overlay).not.toBeNull();
    expect(container.querySelector('.result-card__zoom-btn')).not.toBeNull();
    fireEvent.click(overlay!);
    expect(onZoom).toHaveBeenCalledTimes(1);
  });

  it('a completed video gets only the corner button (no full-area overlay, so controls stay usable)', () => {
    const { container } = render(
      <ResultCard node={node('complete', { video: { type: 'Video', value: '/api/outputs/a.mp4' } })}
        onOpenInCanvas={noop} onUseAsInput={noop} onDelete={noop} onZoom={noop} />,
    );
    expect(container.querySelector('.result-card__zoom-btn')).not.toBeNull();
    expect(container.querySelector('.result-card__zoom-overlay')).toBeNull();
  });

  it('a text / non-media result has no zoom affordances', () => {
    const { container } = render(
      <ResultCard node={node('complete', { text: { type: 'Text', value: 'hi' } })}
        onOpenInCanvas={noop} onUseAsInput={noop} onDelete={noop} onZoom={noop} />,
    );
    expect(container.querySelector('.result-card__zoom-btn')).toBeNull();
    expect(container.querySelector('.result-card__zoom-overlay')).toBeNull();
  });

  it('an incomplete (executing) image has no zoom affordances', () => {
    const { container } = render(
      <ResultCard node={node('executing', { image: { type: 'Image', value: '/api/outputs/a.png' } })}
        onOpenInCanvas={noop} onUseAsInput={noop} onDelete={noop} onZoom={noop} />,
    );
    expect(container.querySelector('.result-card__zoom-btn')).toBeNull();
    expect(container.querySelector('.result-card__zoom-overlay')).toBeNull();
  });
});

describe('ResultCard saves', () => {
  const completed = () => node('complete', { image: { type: 'Image', value: '/api/outputs/a.png' } });

  it('waits for the save and prevents duplicate requests before confirming success', async () => {
    let finish!: (result: { savedPath: string }) => void;
    const onSaveToFolder = vi.fn(() => new Promise<{ savedPath: string }>((resolve) => { finish = resolve; }));
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    const button = view.getByTitle('Save to folder');
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(view.queryByTitle('Saved!')).toBeNull();
    fireEvent.click(button);
    expect(onSaveToFolder).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ savedPath: '/tmp/a.png' }); });
    expect(view.getByTitle('Saved!')).toBeEnabled();
  });

  it('keeps cancellation neutral and permits another save', async () => {
    const onSaveToFolder = vi.fn().mockResolvedValue({ savedPath: '' });
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    fireEvent.click(view.getByTitle('Save to folder'));
    await waitFor(() => expect(view.getByTitle('Save to folder')).toBeEnabled());
    expect(view.queryByTitle('Saved!')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows a failed save and allows a successful retry', async () => {
    const onSaveToFolder = vi.fn().mockRejectedValueOnce(new Error('Disk full'))
      .mockResolvedValueOnce({ savedPath: '/tmp/retry.png' });
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    fireEvent.click(view.getByTitle('Save to folder'));
    expect(await view.findByRole('alert')).toHaveTextContent('Disk full');
    expect(view.queryByTitle('Saved!')).toBeNull();
    fireEvent.click(view.getByTitle('Save to folder'));
    await waitFor(() => expect(view.getByTitle('Saved!')).toBeEnabled());
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('clears the success timer when the card unmounts', async () => {
    const clear = vi.spyOn(window, 'clearTimeout');
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={vi.fn().mockResolvedValue({ savedPath: '/tmp/a.png' })} />);
    fireEvent.click(view.getByTitle('Save to folder'));
    await waitFor(() => expect(view.getByTitle('Saved!')).toBeEnabled());
    clear.mockClear();
    view.unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it.each(['success', 'failure'] as const)('ignores pending output A %s after the same node replaces it with B', async (outcome) => {
    let finish!: (result: { savedPath: string }) => void;
    let reject!: (error: Error) => void;
    const onSaveToFolder = vi.fn(() => new Promise<{ savedPath: string }>((resolve, rejectPromise) => {
      finish = resolve;
      reject = rejectPromise;
    }));
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    fireEvent.click(view.getByTitle('Save to folder'));
    expect(view.getByTitle('Saving…')).toBeDisabled();
    view.rerender(<ResultCard node={node('complete', { image: { type: 'Image', value: '/api/outputs/b.png' } })}
      onOpenInCanvas={noop} onUseAsInput={noop} onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    expect(view.getByTitle('Save to folder')).toBeEnabled();
    await act(async () => {
      if (outcome === 'success') finish({ savedPath: '/tmp/a.png' });
      else reject(new Error('Output A failed'));
    });
    expect(view.getByTitle('Save to folder')).toBeEnabled();
    expect(view.queryByTitle('Saved!')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
    expect(onSaveToFolder).toHaveBeenCalledExactlyOnceWith('/api/outputs/a.png');
  });

  it.each(['success', 'failure'] as const)('keeps output B pending when an older output A request settles with %s', async (outcome) => {
    const pending: { finish: (result: { savedPath: string }) => void; reject: (error: Error) => void }[] = [];
    const onSaveToFolder = vi.fn(() => new Promise<{ savedPath: string }>((finish, reject) => {
      pending.push({ finish, reject });
    }));
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    fireEvent.click(view.getByTitle('Save to folder'));
    view.rerender(<ResultCard node={node('complete', { image: { type: 'Image', value: '/api/outputs/b.png' } })}
      onOpenInCanvas={noop} onUseAsInput={noop} onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    fireEvent.click(view.getByTitle('Save to folder'));
    expect(onSaveToFolder.mock.calls.map(([url]) => url)).toEqual(['/api/outputs/a.png', '/api/outputs/b.png']);
    await act(async () => {
      if (outcome === 'success') pending[0].finish({ savedPath: '/tmp/a.png' });
      else pending[0].reject(new Error('Output A failed'));
    });
    const button = view.getByTitle('Saving…');
    expect(button).toBeDisabled();
    expect(view.queryByTitle('Saved!')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
    fireEvent.click(button);
    expect(onSaveToFolder).toHaveBeenCalledTimes(2);
    await act(async () => { pending[1].finish({ savedPath: '/tmp/b.png' }); });
    expect(view.getByTitle('Saved!')).toBeEnabled();
  });

  it('resets an existing save error when a different node has the same output URL', async () => {
    const onSaveToFolder = vi.fn().mockRejectedValueOnce(new Error('First node failed'));
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    fireEvent.click(view.getByTitle('Save to folder'));
    expect(await view.findByRole('alert')).toHaveTextContent('First node failed');
    view.rerender(<ResultCard node={{ ...completed(), id: 'replacement-node' }} onOpenInCanvas={noop}
      onUseAsInput={noop} onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByTitle('Save to folder')).toBeEnabled();
  });

  it('gives a replacement output its own success timer', async () => {
    vi.useFakeTimers();
    const onSaveToFolder = vi.fn().mockResolvedValue({ savedPath: '/tmp/synthetic.png' });
    const view = render(<ResultCard node={completed()} onOpenInCanvas={noop} onUseAsInput={noop}
      onDelete={noop} onSaveToFolder={onSaveToFolder} />);
    try {
      await act(async () => { fireEvent.click(view.getByTitle('Save to folder')); });
      expect(view.getByTitle('Saved!')).toBeEnabled();
      act(() => { vi.advanceTimersByTime(1000); });
      view.rerender(<ResultCard node={node('complete', { image: { type: 'Image', value: '/api/outputs/b.png' } })}
        onOpenInCanvas={noop} onUseAsInput={noop} onDelete={noop} onSaveToFolder={onSaveToFolder} />);
      expect(view.queryByTitle('Saved!')).toBeNull();
      await act(async () => { fireEvent.click(view.getByTitle('Save to folder')); });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(view.getByTitle('Saved!')).toBeEnabled();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(view.getByTitle('Save to folder')).toBeEnabled();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});

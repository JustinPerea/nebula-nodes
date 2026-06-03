import { render, fireEvent } from '@testing-library/react';
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

import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { ResultsGallery, type ResultsGalleryProps } from '../../src/components/create-studio/ResultsGallery';
import type { RunRecord } from '../../src/lib/runHistory';

function result(index: number, url = `/api/outputs/result-${index}.png`): Node<NodeData> {
  return {
    id: `result-${index}`, type: 'model-node', position: { x: index * 320, y: 0 },
    data: { label: `Image ${index}`, definitionId: 'nano-banana', params: {}, state: 'complete',
      outputs: { image: { type: 'Image', value: url } } },
  };
}

function props(nodes: Node<NodeData>[]): ResultsGalleryProps {
  return {
    nodes, selectedIds: new Set(), records: nodes.map((node, index) => ({
      genId: `generation-${index}`, modelNodeIds: [node.id], prompt: `Prompt ${index}`, ts: index + 1,
    })),
    onOpenInCanvas: vi.fn(), onUseAsInput: vi.fn(), onDelete: vi.fn(),
  };
}

describe('ResultsGallery', () => {
  it('keeps 30 results and their actions available when switching grid/list, without changing nodes or records', () => {
    const state = props(Array.from({ length: 30 }, (_, index) => result(index)));
    const original = JSON.stringify([state.nodes, state.records]);
    const view = render(<ResultsGallery {...state} />);
    expect(view.getByRole('status')).toHaveTextContent('30 results');
    const region = view.getByRole('region', { name: 'Create results' });
    expect(within(region).getAllByRole('button', { name: 'Open in canvas' })).toHaveLength(30);
    const oldest = within(region).getByText('Image 0').closest('.result-card')!;
    const newest = within(region).getByText('Image 29').closest('.result-card')!;
    const cards = region.querySelectorAll('.result-card');
    expect(cards[0]).toBe(newest);
    expect(cards[cards.length - 1]).toBe(oldest);
    fireEvent.click(view.getByRole('button', { name: 'List' }));
    expect(view.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByRole('button', { name: 'Grid' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(region).getAllByRole('button', { name: 'Open in canvas' })).toHaveLength(30);
    fireEvent.click(within(oldest as HTMLElement).getByRole('button', { name: 'Open in canvas' }));
    fireEvent.click(within(newest as HTMLElement).getByRole('button', { name: 'Use as input' }));
    expect(state.onOpenInCanvas).toHaveBeenCalledExactlyOnceWith('result-0');
    expect(state.onUseAsInput).toHaveBeenCalledExactlyOnceWith('/api/outputs/result-29.png');
    expect(state.onDelete).not.toHaveBeenCalled();
    expect(JSON.stringify([state.nodes, state.records])).toBe(original);
  });

  it('preserves source/selected filters in the stationary toolbar', () => {
    const state = { ...props([result(0), result(1)]), defaultTab: 'canvas' as const, selectedIds: new Set(['result-1']) };
    const view = render(<ResultsGallery {...state} />);
    expect(view.getByRole('button', { name: 'Canvas' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByRole('status')).toHaveTextContent('1 result');
    fireEvent.click(view.getByRole('button', { name: 'Selected (1) · Show all' }));
    expect(view.getByRole('status')).toHaveTextContent('2 results');
    fireEvent.click(view.getByRole('button', { name: 'Show selected' }));
    expect(view.getByRole('status')).toHaveTextContent('1 result');
    expect(state.onOpenInCanvas).not.toHaveBeenCalled();
    expect(state.onUseAsInput).not.toHaveBeenCalled();
  });

  it('restores the result opener after closing fullscreen', () => {
    const view = render(<ResultsGallery {...props([result(0)])} />);
    const opener = view.getByRole('button', { name: 'View full screen' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = view.getByRole('dialog', { name: 'Result preview' });
    expect(within(dialog).getByRole('button', { name: 'Close (Esc)' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('falls back to the results region if the opener output is replaced while fullscreen is open', () => {
    const state = props([result(0)]);
    const view = render(<ResultsGallery {...state} />);
    const opener = view.getByRole('button', { name: 'View full screen' });
    opener.focus();
    fireEvent.click(opener);
    view.rerender(<ResultsGallery {...state} nodes={[result(0, '/api/outputs/replacement.png')]} />);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(opener.isConnected).toBe(false);
    expect(view.getByRole('region', { name: 'Create results' })).toHaveFocus();
  });

  it('closes when the last output disappears, returns to the source toolbar and does not reopen on arrival', () => {
    const state = props([result(0)]);
    const view = render(<ResultsGallery {...state} />);
    const opener = view.getByRole('button', { name: 'View full screen' });
    opener.focus();
    fireEvent.click(opener);
    view.rerender(<ResultsGallery {...state} nodes={[]} />);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('button', { name: 'Session' })).toHaveFocus();
    view.rerender(<ResultsGallery {...state} />);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('status')).toHaveTextContent('1 result');
  });

  it('pins selected media through node replacement, filtering and deletion, then restores comparison focus', () => {
    const state = { ...props([result(0), result(1), result(2)]), defaultTab: 'canvas' as const };
    const view = render(<ResultsGallery {...state} />);
    const original = JSON.stringify(state.nodes);
    const choices = view.getAllByRole('button', { name: 'Compare', exact: true });
    fireEvent.click(choices[0]); fireEvent.click(choices[1]);
    expect(choices[2]).toBeDisabled();
    fireEvent.click(view.getByRole('button', { name: 'Session', exact: true }));
    view.rerender(<ResultsGallery {...state} nodes={[result(0, '/api/outputs/newer.png')]} />);
    const opener = view.getByRole('button', { name: 'Compare selected' });
    opener.focus(); fireEvent.click(opener);
    view.rerender(<ResultsGallery {...state} nodes={[]} emptyState={<p>Start creating</p>} />);
    const dialog = view.getByRole('dialog', { name: 'Compare results' });
    expect(within(dialog).getByAltText('First result')).toHaveAttribute('src', '/api/outputs/result-0.png');
    expect(within(dialog).getByAltText('Second result')).toHaveAttribute('src', '/api/outputs/result-1.png');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus();
    expect(JSON.stringify(state.nodes)).toBe(original);
    expect(state.onDelete).not.toHaveBeenCalled(); expect(state.onUseAsInput).not.toHaveBeenCalled();
  });

  it('shows matching saved prompt/settings and copies them explicitly instead of edited live authoring', () => {
    const media = result(0);
    media.data.params = { seed: 999 };
    const history: RunRecord[] = [{ id: 'saved-run', status: 'complete', trigger: 'node', startedAt: 1700000000000,
      resultOutputs: { [media.id]: structuredClone(media.data.outputs) }, snapshot: {
        nodes: [{ id: media.id, definitionId: 'nano-banana', params: { seed: 42 }, outputs: {} },
          { id: 'saved-prompt', definitionId: 'text-input', params: { value: 'Full original prompt\nSecond line' }, outputs: {} }],
        edges: [{ id: 'prompt', source: 'saved-prompt', sourceHandle: 'text', target: media.id, targetHandle: 'prompt' }],
      } }];
    const onReuseSettings = vi.fn();
    const state = { ...props([media]), history, onReuseSettings };
    const original = JSON.stringify([media, history]);
    const view = render(<ResultsGallery {...state} />);
    const disclosure = view.getByText('Saved recipe').closest('details')!;
    fireEvent.click(view.getByText('Saved recipe'));
    disclosure.setAttribute('open', '');
    expect(disclosure).toHaveTextContent('Full original prompt');
    expect(disclosure).toHaveTextContent('42'); expect(disclosure).not.toHaveTextContent('999');
    expect(onReuseSettings).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Reuse settings' }));
    expect(onReuseSettings).toHaveBeenCalledWith(expect.objectContaining({ runId: 'saved-run', reusableDraft: expect.objectContaining({ prompt: 'Full original prompt\nSecond line', params: { seed: 42 }, quantity: 1 }) }));
    expect(JSON.stringify([media, history])).toBe(original);
  });

  it('keeps two versions of the same node distinct and allows another choice after removing one pin', () => {
    const state = props([result(0), result(1)]);
    const view = render(<ResultsGallery {...state} />);
    fireEvent.click(view.getAllByRole('button', { name: 'Compare', exact: true })[1]);
    view.rerender(<ResultsGallery {...state} nodes={[result(0, '/api/outputs/replacement.png'), result(1)]} />);
    fireEvent.click(within(view.getByText('Image 0').closest('.result-card') as HTMLElement).getByRole('button', { name: 'Compare', exact: true }));
    fireEvent.click(view.getByRole('button', { name: 'Compare selected' }));
    const dialog = view.getByRole('dialog', { name: 'Compare results' });
    expect(within(dialog).getByAltText('First result')).toHaveAttribute('src', '/api/outputs/result-0.png');
    expect(within(dialog).getByAltText('Second result')).toHaveAttribute('src', '/api/outputs/replacement.png');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.click(view.getByRole('button', { name: 'Remove result 1 from comparison' }));
    expect(view.getByRole('button', { name: 'Compare', exact: true })).toBeEnabled();
  });
});

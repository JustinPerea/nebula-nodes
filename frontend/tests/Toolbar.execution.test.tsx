import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const graphFileMocks = vi.hoisted(() => ({
  saveToFile: vi.fn(),
  loadFromFile: vi.fn(),
}));

vi.mock('../src/lib/graphFile', () => graphFileMocks);

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({
      fitView: vi.fn(),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    }),
  };
});

import { Toolbar } from '../src/components/panels/Toolbar';
import { useGraphStore } from '../src/store/graphStore';

describe('Toolbar execution lifecycle', () => {
  beforeEach(() => {
    graphFileMocks.saveToFile.mockReset();
    graphFileMocks.saveToFile.mockResolvedValue(undefined);
    graphFileMocks.loadFromFile.mockReset();
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({
      nodes: [{
        id: 'world',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: {},
          state: 'executing',
          outputs: {},
        },
      }],
      edges: [],
      isExecuting: true,
      isCancelling: true,
      uncertainWorldLabsRunId: null,
      providerRecoveries: [],
      providerStartAmbiguities: [],
    });
  });

  it('shows a disabled stopping state until backend work becomes terminal', () => {
    const cancelExecution = vi.fn(async () => undefined);
    useGraphStore.setState({ cancelExecution });

    render(<Toolbar />);

    const stopping = screen.getByRole('button', { name: 'Stopping…' });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveAttribute('aria-busy', 'true');
    expect(stopping).toHaveAttribute('title', 'Waiting for execution to stop safely');
    fireEvent.click(stopping);
    expect(cancelExecution).not.toHaveBeenCalled();
  });

  it('blocks button and keyboard-event saves while a paid start is unsettled', () => {
    render(<Toolbar />);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', 'Wait for the active run to finish before saving');
    fireEvent.click(save);
    fireEvent(window, new CustomEvent('nebula:save'));

    expect(graphFileMocks.saveToFile).not.toHaveBeenCalled();
  });

  it('blocks saves while an ambiguous paid start has no safe recovery ID', () => {
    useGraphStore.setState({
      isExecuting: false,
      isCancelling: false,
      providerStartAmbiguities: [{
        runId: 'paid-run',
        nodeId: 'world',
        kind: 'worldlabs-environment',
        message: 'The paid start may have been accepted.',
        durable: true,
      }],
    });

    render(<Toolbar />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute(
      'title',
      'Resolve the World Labs paid-start review before saving',
    );
    fireEvent(window, new CustomEvent('nebula:save'));

    expect(graphFileMocks.saveToFile).not.toHaveBeenCalled();
  });

  it('serializes an idle World node once its exact recovery ID is present', async () => {
    useGraphStore.setState({
      nodes: [{
        id: 'world',
        type: 'model-node',
        position: { x: 0, y: 0 },
        data: {
          label: 'World Labs Environment',
          definitionId: 'worldlabs-environment',
          params: { existing_world_id: 'world-accepted' },
          state: 'idle',
          outputs: {},
        },
      }],
      isExecuting: false,
      isCancelling: false,
      providerRecoveries: [{
        runId: 'paid-run',
        nodeId: 'world',
        resumeOperationId: null,
        existingWorldId: 'world-accepted',
        durable: true,
      }],
      providerStartAmbiguities: [],
    });

    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(graphFileMocks.saveToFile).toHaveBeenCalledWith(
      [expect.objectContaining({
        id: 'world',
        data: expect.objectContaining({
          params: { existing_world_id: 'world-accepted' },
        }),
      })],
      [],
      { x: 0, y: 0, zoom: 1 },
    ));
  });
});

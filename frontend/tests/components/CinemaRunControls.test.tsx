import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CinemaStudioToolbar } from '../../src/components/cinema-studio/CinemaStudioToolbar';
import { CinemaShotPanel } from '../../src/components/cinema-studio/CinemaShotPanel';
import { CinemaShotsRail } from '../../src/components/cinema-studio/CinemaShotsRail';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import type { CinemaSceneSpec } from '../../src/types';

const scene: CinemaSceneSpec = {
  version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
  shots: [{ id: 'a', prompt: 'First shot' }, { id: 'b', prompt: 'Second shot' }],
};

describe('Cinema tracked run controls', () => {
  const cancelRun = vi.fn<(runId: string) => Promise<void>>().mockResolvedValue(undefined);
  const executeNode = vi.fn(async () => undefined);
  const executeShot = vi.fn<(nodeId: string, shotId: string) => Promise<void>>().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    useGraphStore.setState({
      nodes: [], edges: [], isExecuting: true, isCancelling: false,
      activeRuns: [
        { id: 'shot-a', kind: 'cinema-shot', nodeIds: ['n1'], nodeId: 'n1', shotId: 'a', status: 'running' },
        { id: 'shot-b', kind: 'cinema-shot', nodeIds: ['n1'], nodeId: 'n1', shotId: 'b', status: 'running' },
        { id: 'other-scene', kind: 'cinema-shot', nodeIds: ['n2'], nodeId: 'n2', shotId: 'a', status: 'running' },
      ],
      cancelRun, executeNode, executeShot,
      isShotAdmissionBlocked: () => false,
    });
    useUIStore.setState((state) => ({
      cinemaEditorNodeId: 'n1',
      panels: { ...state.panels, history: { ...state.panels.history, visible: false } },
    }));
  });

  it('stops only active runs belonging to the current scene', () => {
    render(<CinemaStudioToolbar cinemaNodeId="n1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop scene' }));
    expect(cancelRun.mock.calls.map(([id]) => id)).toEqual(['shot-a', 'shot-b']);
  });

  it('keeps Stop disabled with truthful stopping text during cancellation', () => {
    useGraphStore.setState((state) => ({
      activeRuns: state.activeRuns.map((run) => run.nodeId === 'n1' ? { ...run, status: 'cancelling' } : run),
    }));
    render(<CinemaStudioToolbar cinemaNodeId="n1" />);
    const stop = screen.getByRole('button', { name: 'Stopping…' });
    expect(stop).toBeDisabled();
    expect(stop).toHaveAttribute('aria-busy', 'true');
  });

  it('opens history on Canvas from the Cinema workspace', () => {
    render(<CinemaStudioToolbar cinemaNodeId="n1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
    expect(useUIStore.getState().cinemaEditorNodeId).toBeNull();
    expect(useUIStore.getState().panels.history.visible).toBe(true);
  });

  it('stops only the selected shot and blocks duplicate generation', () => {
    render(<CinemaShotPanel cinemaNodeId="n1" scene={scene} shot={scene.shots[0]} onChangeShot={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop shot' }));
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith('shot-a');
    expect(screen.getByRole('button', { name: 'Generating…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate all' })).toBeDisabled();
  });

  it('allows a distinct idle shot while another shot is owned', () => {
    useGraphStore.setState((state) => ({ activeRuns: state.activeRuns.filter((run) => run.id !== 'shot-b') }));
    render(<CinemaShotPanel cinemaNodeId="n1" scene={scene} shot={scene.shots[1]} onChangeShot={vi.fn()} />);
    const generate = screen.getByRole('button', { name: 'Generate shot' });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    expect(executeShot).toHaveBeenCalledExactlyOnceWith('n1', 'b');
  });

  it('explains and disables an idle shot while shared inputs are owned, then allows retry', () => {
    useGraphStore.setState((state) => ({
      activeRuns: state.activeRuns.filter((run) => run.id !== 'shot-b'),
      isShotAdmissionBlocked: () => true,
    }));
    const view = render(<CinemaShotPanel cinemaNodeId="n1" scene={scene} shot={scene.shots[1]} onChangeShot={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Generate shot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate 2' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Another run is using shared inputs');
    fireEvent.click(screen.getByRole('button', { name: 'Generate shot' }));
    expect(executeShot).not.toHaveBeenCalled();
    act(() => useGraphStore.setState({ isShotAdmissionBlocked: () => false }));
    view.rerender(<CinemaShotPanel cinemaNodeId="n1" scene={scene} shot={scene.shots[1]} onChangeShot={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Generate shot' })).toBeEnabled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('blocks selected shot generation while an overlapping graph run owns the scene', () => {
    useGraphStore.setState({ activeRuns: [{ id: 'graph', kind: 'graph', nodeIds: ['n1'], status: 'running' }] });
    render(<CinemaShotPanel cinemaNodeId="n1" scene={scene} shot={scene.shots[0]} onChangeShot={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Generate shot' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop shot' })).toBeNull();
  });

  it('keeps an active shot badge truthful when backend scene output is still the last completed image', () => {
    const completedScene = { ...scene, shots: scene.shots.map((shot) => ({ ...shot, output: { status: 'done' as const, imageUrl: '/api/outputs/old.png' } })) };
    render(<CinemaShotsRail cinemaNodeId="n1" scene={completedScene} selectedShotId="a"
      onSelect={vi.fn()} onAddShot={vi.fn()} onRemoveShot={vi.fn()} onReorder={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Generating Shot 1' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Generating Shot 2' })).toBeInTheDocument();
  });
});

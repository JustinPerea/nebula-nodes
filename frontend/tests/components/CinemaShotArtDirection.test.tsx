import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { CinemaSceneSpec, CinemaShot, NodeData } from '../../src/types';
import { freezeRunSnapshot, type RunRecord } from '../../src/lib/runHistory';
import { effectiveCinemaLook } from '../../src/lib/cinemaArtDirection';
import { CinemaShotPanel } from '../../src/components/cinema-studio/CinemaShotPanel';
import { useGraphStore } from '../../src/store/graphStore';
import { useCinemaMotionStore } from '../../src/store/cinemaMotionStore';
import { useCinemaUploadStore } from '../../src/store/cinemaUploadStore';

const requests = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/lib/backend', async (original) => ({ ...await original<typeof import('../../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => requests.fetch(...args) }));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

const initial = { ...useGraphStore.getState() };
const executeNode = vi.fn();
const executeShot = vi.fn();

function scene(): CinemaSceneSpec {
  return { version: 1, base: { model: 'seedream-4-5', params: { seed: 123 } }, aspectRatio: '16:9',
    palette: { swatches: ['#123456', '#abcdef'], strength: 0.7, method: 'lab-transfer', sourceImageUrl: '/palette.png' },
    look: { preset: 'custom', grain: 0.6, halation: 0.3, vignette: 0.5, contrast: 0.4, saturation: -0.1, temperature: 0.2, lutId: 'scene-lut' },
    shots: [
      { id: 'a', prompt: 'First shot', refImageUrls: ['/composition.png'], output: { status: 'done', imageUrl: '/a.png', hash: 'earlier' },
        variations: [{ url: '/a.png', seed: 123 }, { url: '/a-2.png', seed: 124 }], selectedVariation: 0 },
      { id: 'b', prompt: 'Sibling', output: { status: 'done', imageUrl: '/b.png' } },
    ] };
}
function source(spec: CinemaSceneSpec): Node<NodeData> {
  return { id: 'local-scene', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, data: {
    label: 'Scene', definitionId: 'cinema-scene', params: { scene: spec }, state: 'complete',
    outputs: { shot_a: { type: 'Image', value: '/a.png' }, shot_b: { type: 'Image', value: '/b.png' } },
  } };
}
const currentScene = () => useGraphStore.getState().nodes[0].data.params.scene as CinemaSceneSpec;
const currentShot = () => currentScene().shots[0];
function changeShot(update: (current: CinemaShot) => CinemaShot) {
  useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current,
    shots: current.shots.map((shot) => shot.id === 'a' ? update(shot) : shot) }));
}
function StorePanel({ shotId = 'a' }: { shotId?: string }) {
  const spec = useGraphStore((state) => state.nodes[0].data.params.scene) as CinemaSceneSpec;
  return <CinemaShotPanel cinemaNodeId="local-scene" scene={spec} shot={spec.shots.find((shot) => shot.id === shotId)!}
    onChangeShot={changeShot} />;
}
function assertNoGeneration() {
  expect(executeNode).not.toHaveBeenCalled();
  expect(executeShot).not.toHaveBeenCalled();
  expect(requests.fetch).not.toHaveBeenCalled();
  expect(useGraphStore.getState().activeRuns).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  useCinemaMotionStore.getState().clear();
  useCinemaUploadStore.getState().clear();
  const spec = scene();
  const history: RunRecord[] = [{ id: 'previous', trigger: 'node', status: 'complete', startedAt: 1,
    snapshot: freezeRunSnapshot({ nodes: [{ id: 'local-scene', definitionId: 'cinema-scene', params: { scene: spec }, outputs: {} }], edges: [] }) }];
  const edges: Edge[] = [{ id: 'motion', source: 'local-scene', sourceHandle: 'shot_a', target: 'video', targetHandle: 'image' }];
  useGraphStore.setState({ ...initial, nodes: [source(spec)], edges, runHistory: history, activeRuns: [],
    isExecuting: false, isImportingGraph: false, executeNode, executeShot, isShotAdmissionBlocked: () => false });
});
afterEach(() => { cleanup(); useGraphStore.setState(initial, true); useCinemaMotionStore.getState().clear(); useCinemaUploadStore.getState().clear(); });

describe('Cinema shot palette and look authoring', () => {
  it('enables real palette controls without copying scene fields, keeps unedited fields inherited and resets to the latest scene', () => {
    render(<StorePanel />);
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('First shot');
    expect(screen.queryByRole('button', { name: 'Generate all' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Override palette' }));
    expect(currentShot().overrides?.palette).toEqual({});
    expect(screen.getByLabelText('Shot palette strength')).toHaveValue('0.7');
    fireEvent.change(screen.getByLabelText('Shot palette strength'), { target: { value: '0.35' } });
    expect(currentShot().overrides?.palette).toEqual({ strength: 0.35 });
    act(() => useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current,
      palette: { ...current.palette!, swatches: ['#00aa88'], strength: 0.9, method: 'histogram' } })));
    expect(screen.getByLabelText('Shot swatch 1')).toHaveValue('#00aa88');
    expect(screen.getByLabelText('Shot palette method')).toHaveValue('histogram');
    expect(screen.getByLabelText('Shot palette strength')).toHaveValue('0.35');
    fireEvent.click(screen.getByRole('button', { name: 'Reset shot palette to scene' }));
    expect(currentShot().overrides).toBeUndefined();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Override palette' }));
    expect(screen.getByLabelText('Shot palette strength')).toHaveValue('0.9');
    assertNoGeneration();
  });

  it('edits saved partial palette and look overrides without pinning unrelated scene controls', () => {
    useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current,
      shots: current.shots.map((shot) => shot.id === 'a' ? { ...shot, overrides: { palette: { strength: 0.2 }, look: { grain: 0.8 } } } : shot) }));
    render(<StorePanel />);
    expect(screen.getByLabelText('Shot palette strength')).toHaveValue('0.2');
    expect(screen.getByLabelText('Shot grain')).toHaveValue('0.8');
    expect(screen.getByLabelText('Shot halation')).toHaveValue('0.3');
    fireEvent.change(screen.getByLabelText('Shot palette method'), { target: { value: 'reinhard' } });
    fireEvent.change(screen.getByLabelText('Shot grain'), { target: { value: '0.45' } });
    expect(currentShot().overrides).toEqual({ palette: { strength: 0.2, method: 'reinhard' }, look: { grain: 0.45 } });
    act(() => useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current,
      look: { ...current.look!, halation: 0.9, contrast: -0.4 } })));
    expect(screen.getByLabelText('Shot halation')).toHaveValue('0.9');
    expect(screen.getByLabelText('Shot contrast')).toHaveValue('-0.4');
    assertNoGeneration();
  });

  it('selects a named look without inherited custom floats or LUT, then deliberately edits Custom', () => {
    render(<StorePanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Override look' }));
    fireEvent.change(screen.getByLabelText('Shot grain'), { target: { value: '0.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kodak Portra' }));
    expect(currentShot().overrides?.look).toEqual({ preset: 'kodak-portra' });
    expect(effectiveCinemaLook(currentScene().look, currentShot().overrides?.look)).toEqual({ preset: 'kodak-portra' });
    expect(screen.getByRole('button', { name: 'Kodak Portra' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Shot grain')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(currentShot().overrides?.look).toMatchObject({ preset: 'custom', grain: 0, halation: 0, temperature: 0 });
    expect(currentShot().overrides?.look).not.toHaveProperty('lutId');
    fireEvent.change(screen.getByLabelText('Shot temperature'), { target: { value: '0.5' } });
    expect(currentShot().overrides?.look?.temperature).toBe(0.5);
    assertNoGeneration();
  });

  it('resets only the selected override and preserves current results, variations, siblings, edges and frozen run history', () => {
    useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current,
      shots: current.shots.map((shot) => shot.id === 'a' ? { ...shot, overrides: { palette: { strength: 0.2 }, look: { preset: 'teal-orange' } } } : shot) }));
    const before = currentScene();
    const history = useGraphStore.getState().runHistory;
    const edges = useGraphStore.getState().edges;
    const outputs = useGraphStore.getState().nodes[0].data.outputs;
    render(<StorePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset shot look to scene' }));
    expect(currentShot().overrides).toEqual({ palette: { strength: 0.2 } });
    expect(currentShot().output).toBe(before.shots[0].output);
    expect(currentShot().variations).toBe(before.shots[0].variations);
    expect(currentShot().selectedVariation).toBe(0);
    expect(currentShot().refImageUrls).toBe(before.shots[0].refImageUrls);
    expect(currentScene().shots[1]).toBe(before.shots[1]);
    expect(useGraphStore.getState().edges).toEqual(edges);
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual(outputs);
    expect(useGraphStore.getState().runHistory).toBe(history);
    expect(history[0].snapshot.nodes[0].params.scene).toEqual(scene());
    assertNoGeneration();
  });

  it('uses the latest shared fields and shot even if the control event comes from an older render', () => {
    useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current,
      shots: current.shots.map((shot) => shot.id === 'a' ? { ...shot, overrides: { palette: {} } } : shot) }));
    const original = currentScene();
    render(<CinemaShotPanel cinemaNodeId="local-scene" scene={original} shot={original.shots[0]} onChangeShot={changeShot} />);
    act(() => useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current,
      palette: { ...current.palette!, swatches: ['#aabbcc', '#ddeeff', '#00ff00'], strength: 0.9 },
      shots: current.shots.map((shot) => shot.id === 'a' ? { ...shot, prompt: 'New prompt',
        output: { status: 'done', imageUrl: '/new.png' }, overrides: { palette: { strength: 0.35 }, look: { grain: 0.7 } } } : shot) })));
    fireEvent.change(screen.getByLabelText('Shot swatch 1'), { target: { value: '#ff3300' } });
    expect(currentShot()).toMatchObject({ prompt: 'New prompt', output: { imageUrl: '/new.png' },
      overrides: { palette: { strength: 0.35, swatches: ['#ff3300', '#ddeeff', '#00ff00'] }, look: { grain: 0.7 } } });
    assertNoGeneration();
  });

  it('keeps palette add/remove functional and independent from the sibling when selecting a different shot', () => {
    const view = render(<StorePanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Override palette' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add shot swatch' }));
    expect(currentShot().overrides?.palette?.swatches).toEqual(['#123456', '#abcdef', '#808080']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot swatch 2' }));
    expect(currentShot().overrides?.palette?.swatches).toEqual(['#123456', '#808080']);
    view.rerender(<StorePanel shotId="b" />);
    expect(screen.getByRole('checkbox', { name: 'Override palette' })).not.toBeChecked();
    expect(screen.getByRole('heading', { name: 'Shot 2' })).toBeVisible();
    assertNoGeneration();
  });

  it('keeps prompt and generation actions ahead of advanced controls and exposes selected-shot media grouping', () => {
    const { container } = render(<StorePanel />);
    const editor = container.querySelector('.cinema-shot-panel__editor')!;
    const prompt = within(editor as HTMLElement).getByRole('textbox', { name: 'Prompt' });
    const generate = screen.getByRole('button', { name: 'Generate shot' });
    const artDirection = screen.getByRole('region', { name: 'Shot art direction' });
    expect(prompt.compareDocumentPosition(generate) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(generate.compareDocumentPosition(artDirection) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.cinema-shot-panel__media img')).toHaveAttribute('alt', 'Shot 1 preview');
    expect(container.querySelector('.cinema-shot-panel__preview')).toHaveAttribute('data-aspect', '16:9');
  });

  it('shows unknown saved palette and look values faithfully without changing the stored recipe', () => {
    const palette = { ...scene().palette!, method: 'future-method' } as unknown as NonNullable<CinemaSceneSpec['palette']>;
    useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current, palette,
      look: { preset: 'future-look', grain: 0.4 },
      shots: current.shots.map((shot) => shot.id === 'a' ? { ...shot, overrides: { palette: {}, look: {} } } : shot) }));
    render(<StorePanel />);
    expect(screen.getByLabelText('Shot palette method')).toHaveValue('future-method');
    expect(screen.getByText('Saved look: future-look')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'false');
    expect(currentScene().palette?.method).toBe('future-method');
    expect(currentShot().overrides).toEqual({ palette: {}, look: {} });
    assertNoGeneration();
  });

  it('matches named preset merging while preserving explicit scalars and LUTs and inheriting unknown/custom presets', () => {
    const shared = { preset: 'custom', grain: 0.9, temperature: 0.3, lutId: 'scene-lut' };
    expect(effectiveCinemaLook(shared, { preset: 'kodak-portra', grain: 0.4, lutId: 'shot-lut' }))
      .toEqual({ preset: 'kodak-portra', grain: 0.4, lutId: 'shot-lut' });
    expect(effectiveCinemaLook(shared, { preset: 'future-look', grain: 0.4 }))
      .toEqual({ preset: 'future-look', grain: 0.4, temperature: 0.3, lutId: 'scene-lut' });
    expect(effectiveCinemaLook(shared, { grain: 0.4 }))
      .toEqual({ preset: 'custom', grain: 0.4, temperature: 0.3, lutId: 'scene-lut' });
  });

  it('shows neutral look values for an absent scene look and an empty shot override without authoring a grade', () => {
    useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current, look: undefined,
      shots: current.shots.map((shot) => shot.id === 'a' ? { ...shot, overrides: { look: {} } } : shot) }));
    const before = currentScene();
    const history = useGraphStore.getState().runHistory;
    render(<StorePanel />);
    for (const key of ['grain', 'halation', 'vignette', 'contrast', 'saturation', 'temperature']) {
      expect(screen.getByLabelText(`Shot ${key}`)).toHaveValue('0');
    }
    expect(currentScene()).toBe(before);
    expect(currentScene().look).toBeUndefined();
    expect(currentShot().overrides?.look).toEqual({});
    expect(currentShot().output).toBe(before.shots[0].output);
    expect(useGraphStore.getState().runHistory).toBe(history);
    fireEvent.change(screen.getByLabelText('Shot contrast'), { target: { value: '0.1' } });
    expect(currentShot().overrides?.look).toEqual({ contrast: 0.1 });
    assertNoGeneration();
  });

  it('displays missing saved custom fields as zero while preserving its explicit contrast and current result', () => {
    useGraphStore.getState().updateScene('local-scene', (current) => ({ ...current, look: { contrast: 0.1 },
      shots: current.shots.map((shot) => shot.id === 'a' ? { ...shot, overrides: { look: {} } } : shot) }));
    const before = currentScene();
    render(<StorePanel />);
    expect(screen.getByLabelText('Shot contrast')).toHaveValue('0.1');
    for (const key of ['grain', 'halation', 'vignette']) expect(screen.getByLabelText(`Shot ${key}`)).toHaveValue('0');
    expect(currentScene()).toBe(before);
    expect(currentScene().look).toEqual({ contrast: 0.1 });
    expect(currentShot().overrides?.look).toEqual({});
    fireEvent.change(screen.getByLabelText('Shot grain'), { target: { value: '0.15' } });
    expect(currentShot().overrides?.look).toEqual({ grain: 0.15 });
    expect(currentShot().output).toBe(before.shots[0].output);
    assertNoGeneration();
  });
});

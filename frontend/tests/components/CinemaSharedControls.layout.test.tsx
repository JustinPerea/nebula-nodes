import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CinemaSharedControls } from '../../src/components/cinema-studio/CinemaSharedControls';
import { attachCinemaReferences, removeCinemaReferenceUpload, retryCinemaReferenceUpload } from '../../src/lib/cinemaUploads';
import type { CinemaSceneSpec } from '../../src/types';

interface UploadState {
  id: string;
  nodeId: string;
  shotId?: string;
  name: string;
  status: 'uploading' | 'error';
  error?: string;
  canRetry: boolean;
}
const metadata = vi.hoisted(() => ({ uploads: [] as UploadState[] }));
vi.mock('../../src/store/cinemaUploadStore', () => ({
  useCinemaUploadStore: (selector: (state: typeof metadata) => unknown) => selector(metadata),
}));
vi.mock('../../src/lib/cinemaUploads', () => ({
  attachCinemaReferences: vi.fn(), retryCinemaReferenceUpload: vi.fn(), removeCinemaReferenceUpload: vi.fn(),
}));

function scene(): CinemaSceneSpec {
  return {
    version: 1, base: { model: 'seedream-4-5', params: { seed: 42 } }, aspectRatio: '16:9',
    character: { refImageUrls: ['/character.png'], strength: 0.8, sheetUrl: '/sheet.png' },
    palette: { swatches: ['#112233', '#abcdef'], strength: 0.7, method: 'lab-transfer' },
    look: { preset: 'kodak-portra' },
    shots: [{ id: 'first', prompt: 'First shot', output: { status: 'done', imageUrl: '/result.png' },
      variations: [{ url: '/result.png', seed: 42 }], selectedVariation: 0 }],
  };
}

function disclosure() {
  return screen.getByText('Scene settings').closest('details')!;
}
function toggleSettings() {
  fireEvent.click(screen.getByText('Scene settings').closest('summary')!);
}

describe('Cinema collapsed shared scene settings', () => {
  beforeEach(() => { vi.clearAllMocks(); metadata.uploads = []; });

  it('starts collapsed with actual scene context and toggles without authoring or attaching', () => {
    const current = scene();
    const frozen = structuredClone(current);
    const change = vi.fn();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={current} connectedRefs={['/linked.png']} onChange={change} />);
    expect(disclosure()).not.toHaveAttribute('open');
    // jsdom's role query does not hide details descendants; native visibility
    // still reports them correctly through the disclosure's open state.
    expect(screen.getByRole('combobox', { name: 'Base model' })).not.toBeVisible();
    const summary = disclosure().querySelector('summary')!;
    expect(summary).toHaveTextContent('Seedream 4.5');
    expect(summary).toHaveTextContent('16:9');
    expect(summary).toHaveTextContent('Kodak Portra');
    expect(summary).toHaveTextContent('2 palette colors');
    expect(summary).toHaveTextContent('2 character references');
    toggleSettings();
    expect(disclosure()).toHaveAttribute('open');
    expect(screen.getByRole('combobox', { name: 'Base model' })).toHaveValue('seedream-4-5');
    toggleSettings();
    expect(disclosure()).not.toHaveAttribute('open');
    expect(current).toEqual(frozen);
    expect(change).not.toHaveBeenCalled();
    expect(attachCinemaReferences).not.toHaveBeenCalled();
    expect(retryCinemaReferenceUpload).not.toHaveBeenCalled();
    expect(removeCinemaReferenceUpload).not.toHaveBeenCalled();
  });

  it('updates the collapsed summary from current props without inventing optional stages', () => {
    const change = vi.fn();
    const current = scene();
    const view = render(<CinemaSharedControls cinemaNodeId="scene" scene={current} onChange={change} />);
    const next: CinemaSceneSpec = { ...current, base: { model: 'flux-kontext' }, aspectRatio: '4:5',
      character: undefined, palette: undefined, look: undefined };
    view.rerender(<CinemaSharedControls cinemaNodeId="scene" scene={next} onChange={change} />);
    expect(disclosure()).not.toHaveAttribute('open');
    const summary = disclosure().querySelector('summary')!;
    expect(summary).toHaveTextContent('FLUX Kontext');
    expect(summary).toHaveTextContent('4:5');
    expect(summary).toHaveTextContent('No film look');
    expect(summary).toHaveTextContent('No palette');
    expect(summary).toHaveTextContent('No character references');
    expect(change).not.toHaveBeenCalled();
  });

  it('labels model, aspect and shared art controls and displays unknown saved selectors accurately', () => {
    const current = scene();
    current.base.model = 'saved-model-v2';
    current.aspectRatio = '3:2';
    current.look = { preset: 'saved-look-v2' };
    current.palette!.method = 'saved-method-v2' as NonNullable<CinemaSceneSpec['palette']>['method'];
    const change = vi.fn();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={current} onChange={change} />);
    expect(disclosure().querySelector('summary')).toHaveTextContent('saved-model-v2');
    expect(disclosure().querySelector('summary')).toHaveTextContent('saved-look-v2');
    toggleSettings();
    const model = screen.getByRole('combobox', { name: 'Base model' });
    const aspect = screen.getByRole('combobox', { name: 'Aspect ratio' });
    const method = screen.getByRole('combobox', { name: 'Scene palette method' });
    expect(model).toHaveValue('saved-model-v2');
    expect(screen.getByRole('option', { name: 'saved-model-v2' })).toBeVisible();
    expect(aspect).toHaveValue('3:2');
    expect(screen.getByRole('option', { name: '3:2' })).toBeVisible();
    expect(method).toHaveValue('saved-method-v2');
    expect(screen.getByLabelText('Scene palette strength')).toHaveValue('0.7');
    expect(screen.getByLabelText('Scene swatch 1')).toHaveValue('#112233');
    expect(change).not.toHaveBeenCalled();
  });

  it('keeps upload errors, pending ownership and recovery visible while settings remain closed', () => {
    metadata.uploads = [
      { id: 'pending', nodeId: 'scene', name: 'pending.png', status: 'uploading', canRetry: true },
      { id: 'failed', nodeId: 'scene', name: 'failed.png', status: 'error', error: 'Upload failed.', canRetry: true },
      { id: 'interrupted', nodeId: 'scene', name: 'interrupted.png', status: 'error', error: 'Attach this image again.', canRetry: false },
      { id: 'shot-upload', nodeId: 'scene', shotId: 'first', name: 'shot.png', status: 'uploading', canRetry: true },
      { id: 'other-scene', nodeId: 'other', name: 'other.png', status: 'uploading', canRetry: true },
    ];
    const change = vi.fn();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={scene()} onChange={change} />);
    expect(disclosure()).not.toHaveAttribute('open');
    expect(screen.getByText('pending.png')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Uploading…');
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.queryByText('shot.png')).toBeNull();
    expect(screen.queryByText('other.png')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry interrupted.png' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove upload pending.png' }));
    expect(retryCinemaReferenceUpload).toHaveBeenCalledExactlyOnceWith('failed');
    expect(removeCinemaReferenceUpload).toHaveBeenCalledExactlyOnceWith('pending');
    expect(disclosure()).not.toHaveAttribute('open');
    expect(change).not.toHaveBeenCalled();
  });

  it('retains multi-reference attachment and connected reference ownership inside the disclosure', () => {
    const change = vi.fn();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={scene()} connectedRefs={['/linked.png']} onChange={change} />);
    const first = new File(['one'], 'first.png', { type: 'image/png' });
    const second = new File(['two'], 'second.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Character reference images'), { target: { files: [first, second] } });
    expect(attachCinemaReferences).toHaveBeenCalledExactlyOnceWith('scene', undefined, [first, second]);
    toggleSettings();
    expect(screen.getByRole('img', { name: 'Connected character reference 1' })).toHaveAttribute('src', expect.stringContaining('/linked.png'));
    expect(screen.getAllByRole('button', { name: /Remove character reference/ })).toHaveLength(1);
    expect(change).not.toHaveBeenCalled();
  });

  it('applies model and aspect changes to the latest scene while preserving authored and generated data', () => {
    const original = scene();
    const change = vi.fn<(update: (current: CinemaSceneSpec) => CinemaSceneSpec) => void>();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={original} onChange={change} />);
    toggleSettings();
    fireEvent.change(screen.getByRole('combobox', { name: 'Base model' }), { target: { value: 'nano-banana' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Aspect ratio' }), { target: { value: '9:16' } });
    const latest = scene();
    latest.base.params = { seed: 81, resolution: '4K' };
    latest.shots[0] = { ...latest.shots[0], prompt: 'New prompt', output: { status: 'done', imageUrl: '/latest.png' } };
    const modelNext = change.mock.calls[0][0](latest);
    expect(modelNext).toEqual({ ...latest, base: { model: 'nano-banana', params: latest.base.params } });
    expect(modelNext.shots).toBe(latest.shots);
    const aspectNext = change.mock.calls[1][0](latest);
    expect(aspectNext).toEqual({ ...latest, aspectRatio: '9:16' });
    expect(aspectNext.character).toBe(latest.character);
  });

  it('edits reused palette and look controls against latest settings without replacing other scene state', () => {
    const original = scene();
    original.look = { preset: 'custom', grain: 0.2 };
    const change = vi.fn<(update: (current: CinemaSceneSpec) => CinemaSceneSpec) => void>();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={original} onChange={change} />);
    toggleSettings();
    fireEvent.change(screen.getByLabelText('Scene palette strength'), { target: { value: '0.9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add scene swatch' }));
    fireEvent.change(screen.getByLabelText('Scene grain'), { target: { value: '0.6' } });
    const latest = scene();
    latest.palette = { swatches: ['#654321'], method: 'reinhard', strength: 0.4, sourceImageUrl: '/palette-source.png' };
    latest.look = { preset: 'custom', grain: 0.4, contrast: 0.6, lutId: 'saved-lut' };
    const strengthNext = change.mock.calls[0][0](latest);
    expect(strengthNext.palette).toEqual({ ...latest.palette, strength: 0.9 });
    expect(strengthNext.shots).toBe(latest.shots);
    expect(change.mock.calls[1][0](latest).palette).toEqual({ ...latest.palette, swatches: ['#654321', '#808080'] });
    expect(change.mock.calls[2][0](latest).look).toEqual({ ...latest.look, grain: 0.6 });
    expect(attachCinemaReferences).not.toHaveBeenCalled();
  });

  it('keeps named scene looks lean and removing a reference preserves the latest sheet and output', () => {
    const change = vi.fn<(update: (current: CinemaSceneSpec) => CinemaSceneSpec) => void>();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={scene()} onChange={change} />);
    toggleSettings();
    fireEvent.click(screen.getByRole('button', { name: 'B&W Tri-X' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove character reference 1' }));
    const latest = scene();
    latest.look = { preset: 'custom', grain: 0.8, contrast: 0.4 };
    expect(change.mock.calls[0][0](latest).look).toEqual({ preset: 'bw-tri-x' });
    const next = change.mock.calls[1][0](latest);
    expect(next.character).toEqual({ ...latest.character, refImageUrls: [] });
    expect(next.shots).toBe(latest.shots);
  });
});

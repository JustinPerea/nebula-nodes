import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CinemaSharedControls } from '../../src/components/cinema-studio/CinemaSharedControls';
import { CinemaShotPanel } from '../../src/components/cinema-studio/CinemaShotPanel';
import { CinemaStudioToolbar } from '../../src/components/cinema-studio/CinemaStudioToolbar';
import { useGraphStore } from '../../src/store/graphStore';
import { attachCinemaReferences, removeCinemaReferenceUpload, retryCinemaReferenceUpload } from '../../src/lib/cinemaUploads';
import type { CinemaSceneSpec, CinemaShot } from '../../src/types';

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
  useCinemaUploadStore: Object.assign((selector: (state: typeof metadata) => unknown) => selector(metadata), {
    getState: () => ({ ...metadata, reconcileTargets: vi.fn(), clear: vi.fn(), interrupt: vi.fn() }),
  }),
  getCinemaUploadIssue: (nodeId: string, shotId?: string, includeAllShots = false) => {
    const uploads = metadata.uploads.filter((upload) => upload.nodeId === nodeId
      && (includeAllShots || upload.shotId === undefined || upload.shotId === shotId));
    if (!uploads.length) return null;
    return uploads.some((upload) => upload.status === 'uploading')
      ? 'Wait for reference uploads to finish.'
      : 'Retry or remove failed references before generating.';
  },
}));
vi.mock('../../src/lib/cinemaUploads', () => ({
  attachCinemaReferences: vi.fn(),
  retryCinemaReferenceUpload: vi.fn(),
  removeCinemaReferenceUpload: vi.fn(),
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

function scene(): CinemaSceneSpec {
  return {
    version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
    character: { refImageUrls: ['/old-character.png'], strength: 0.8, sheetUrl: '/sheet.png' },
    palette: { swatches: ['#123456'], strength: 0.7, method: 'lab-transfer' },
    look: { preset: 'custom', grain: 0.2 },
    shots: [{ id: 'a', prompt: 'First shot', refImageUrls: ['/old-composition.png'] }, { id: 'b', prompt: 'Second shot' }],
  };
}

function upload(patch: Partial<UploadState> = {}): UploadState {
  return { id: 'pending', nodeId: 'scene', name: 'logo.png', status: 'uploading', canRetry: true, ...patch };
}

describe('Cinema reference feedback and explicit generation', () => {
  const executeNode = vi.fn(async () => undefined);
  const executeShot = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    metadata.uploads = [];
    useGraphStore.setState({ nodes: [], edges: [], isExecuting: false, isImportingGraph: false, activeRuns: [],
      executeNode, executeShot, isShotAdmissionBlocked: () => false });
  });

  it('attaches files to the correct scene or shot without changing scene data or executing', () => {
    const current = scene();
    const sharedChange = vi.fn();
    const shotChange = vi.fn();
    render(<>
      <CinemaSharedControls cinemaNodeId="scene" scene={current} onChange={sharedChange} />
      <CinemaShotPanel cinemaNodeId="scene" scene={current} shot={current.shots[0]} onChangeShot={shotChange} />
    </>);
    const character = new File(['image'], 'character.png', { type: 'image/png' });
    const composition = new File(['image'], 'composition.webp', { type: 'image/webp' });
    fireEvent.change(screen.getByLabelText('Character reference images'), { target: { files: [character] } });
    fireEvent.change(screen.getByLabelText('Composition reference images'), { target: { files: [composition] } });
    expect(attachCinemaReferences).toHaveBeenNthCalledWith(1, 'scene', undefined, [character]);
    expect(attachCinemaReferences).toHaveBeenNthCalledWith(2, 'scene', 'a', [composition]);
    expect(sharedChange).not.toHaveBeenCalled();
    expect(shotChange).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it.each(['uploading', 'error'] as const)('blocks shot, variations and All while a shared reference is %s', (status) => {
    metadata.uploads = [upload({ status })];
    const current = scene();
    render(<CinemaShotPanel cinemaNodeId="scene" scene={current} shot={current.shots[0]} onChangeShot={vi.fn()} />);
    for (const name of ['Generate shot', 'Generate 2', 'Generate all']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(screen.getByRole('status')).toHaveTextContent(status === 'uploading' ? 'Wait for reference uploads' : 'Retry or remove');
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it('keeps an independent shot available while a sibling uploads, and blocks All', () => {
    metadata.uploads = [upload({ shotId: 'b' })];
    const current = scene();
    render(<CinemaShotPanel cinemaNodeId="scene" scene={current} shot={current.shots[0]} onChangeShot={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Generate all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Generate shot' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate shot' }));
    expect(executeShot).toHaveBeenCalledExactlyOnceWith('scene', 'a');
    expect(executeNode).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('other shot');
  });

  it('re-reads upload ownership at click time even before the next render', () => {
    const current = scene();
    render(<CinemaShotPanel cinemaNodeId="scene" scene={current} shot={current.shots[0]} onChangeShot={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Generate shot' })).toBeEnabled();
    metadata.uploads = [upload({ shotId: 'a' })];
    fireEvent.click(screen.getByRole('button', { name: 'Generate shot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate all' }));
    expect(executeShot).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('shows per-file pending/error recovery and permits more attachment while pending', () => {
    metadata.uploads = [upload(), upload({ id: 'failed', name: 'failed.webp', status: 'error', error: 'Unsupported image bytes.' }),
      upload({ id: 'interrupted', name: 'interrupted.png', status: 'error', error: 'Attach this image again or remove it.', canRetry: false }),
      upload({ id: 'other-shot', name: 'hidden.png', shotId: 'b' })];
    render(<CinemaSharedControls cinemaNodeId="scene" scene={scene()} onChange={vi.fn()} />);
    expect(screen.getByText('logo.png')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Uploading…');
    expect(screen.getAllByRole('alert').map((element) => element.textContent)).toEqual(['Unsupported image bytes.', 'Attach this image again or remove it.']);
    expect(screen.queryByText('hidden.png')).toBeNull();
    expect(screen.getByRole('button', { name: 'Attach character references' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry interrupted.png' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed.webp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove upload logo.png' }));
    expect(retryCinemaReferenceUpload).toHaveBeenCalledExactlyOnceWith('failed');
    expect(removeCinemaReferenceUpload).toHaveBeenCalledExactlyOnceWith('pending');
    expect(executeNode).not.toHaveBeenCalled();
    expect(executeShot).not.toHaveBeenCalled();
  });

  it('scopes shot upload rows to the selected shot and enables generation only after resolution', () => {
    const current = scene();
    metadata.uploads = [upload({ shotId: 'a', status: 'error', error: 'Retry this image.' }), upload({ id: 'sibling', name: 'sibling.png', shotId: 'b' })];
    const view = render(<CinemaShotPanel cinemaNodeId="scene" scene={current} shot={current.shots[0]} onChangeShot={vi.fn()} />);
    expect(screen.getByText('logo.png')).toBeVisible();
    expect(screen.queryByText('sibling.png')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry logo.png' }));
    expect(retryCinemaReferenceUpload).toHaveBeenCalledExactlyOnceWith('pending');
    metadata.uploads = [];
    view.rerender(<CinemaShotPanel cinemaNodeId="scene" scene={current} shot={current.shots[0]} onChangeShot={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Generate shot' })).toBeEnabled();
    expect(executeShot).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate shot' }));
    expect(executeShot).toHaveBeenCalledExactlyOnceWith('scene', 'a');
  });

  it('gates toolbar All for every upload in the scene and rechecks before executing', () => {
    const view = render(<CinemaStudioToolbar cinemaNodeId="scene" />);
    metadata.uploads = [upload({ shotId: 'b', status: 'error' })];
    fireEvent.click(screen.getByRole('button', { name: 'Generate all' }));
    expect(executeNode).not.toHaveBeenCalled();
    view.rerender(<CinemaStudioToolbar cinemaNodeId="scene" />);
    expect(screen.getByRole('button', { name: 'Generate all' })).toBeDisabled();
    metadata.uploads = [upload({ nodeId: 'different-scene' })];
    view.rerender(<CinemaStudioToolbar cinemaNodeId="scene" />);
    expect(screen.getByRole('button', { name: 'Generate all' })).toBeEnabled();
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('applies shared edits to the latest scene and preserves current shot results and character sheet', () => {
    const original = scene();
    const change = vi.fn<(update: (current: CinemaSceneSpec) => CinemaSceneSpec) => void>();
    render(<CinemaSharedControls cinemaNodeId="scene" scene={original} onChange={change} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'nano-banana' } });
    const latest = scene();
    latest.base.params = { seed: 42 };
    latest.shots[0] = { ...latest.shots[0], prompt: 'Edited while uploading', output: { status: 'done', imageUrl: '/new-result.png' },
      variations: [{ url: '/new-result.png', seed: 42 }], selectedVariation: 0 };
    const next = change.mock.calls[0][0](latest);
    expect(next.base).toEqual({ model: 'nano-banana', params: { seed: 42 } });
    expect(next.shots).toBe(latest.shots);
    fireEvent.click(screen.getByRole('button', { name: 'Remove character reference 1' }));
    expect(change.mock.calls[1][0](latest).character).toEqual({ refImageUrls: [], strength: 0.8, sheetUrl: '/sheet.png' });
  });

  it('applies prompt and reference edits to the latest shot without reverting results or overrides', () => {
    const current = scene();
    const change = vi.fn<(update: (current: CinemaShot) => CinemaShot) => void>();
    render(<CinemaShotPanel cinemaNodeId="scene" scene={current} shot={current.shots[0]} onChangeShot={change} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Updated prompt' } });
    const latest: CinemaShot = { ...current.shots[0], refImageUrls: ['/new-ref.png', '/old-composition.png'],
      output: { status: 'done', imageUrl: '/current.png' }, variations: [{ url: '/current.png', seed: 4 }], selectedVariation: 0,
      overrides: { look: { preset: 'bw-tri-x' } } };
    const next = change.mock.calls[0][0](latest);
    expect(next).toEqual({ ...latest, prompt: 'Updated prompt' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove composition reference 1' }));
    expect(change.mock.calls[1][0](latest)).toEqual({ ...latest, refImageUrls: ['/new-ref.png'] });
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommonsDetail } from '../src/components/commons/CommonsDetail';
import { CommonsSettings } from '../src/components/commons/CommonsSettings';
import type { AssetDetail } from '../src/lib/commonsTypes';

const api = vi.hoisted(() => ({
  asset: vi.fn(), comment: vi.fn(), folders: vi.fn(), settings: vi.fn(), candidates: vi.fn(), linkFolder: vi.fn(),
}));
vi.mock('../src/lib/commonsApi', () => ({ commonsApi: api }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => <span>Reference image</span> }));

function detail(): AssetDetail {
  return {
    asset: { id: 'fixture-asset', media: 'image', width: 40, height: 32, made_by: 'human', analysis_state: 'ready', last_error: null, measurements: null },
    effective: { fields: {}, sources: {}, corrected_paths: [], analysis: null },
    corrections: [], regions: [], borrowings: [], blob_url: '/api/commons/blobs/fixture.png',
    memberships: [{ id: 'fixture-membership', collection: 'fixture-collection', collection_name: 'Fixture references', brand: null,
      role: 'neutral', why: null, actor: 'human', in_inbox: 0, sightings: [], comments: [] }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.asset.mockResolvedValue(detail());
  api.comment.mockResolvedValue({ id: 'fixture-comment' });
  api.folders.mockResolvedValue([]); api.settings.mockResolvedValue({}); api.candidates.mockResolvedValue([]);
  api.linkFolder.mockResolvedValue({ id: 'fixture-folder' });
});
afterEach(() => cleanup());

describe('Commons comment submissions', () => {
  it('preserves a rejected comment, shows the error and permits an explicit successful retry', async () => {
    api.comment.mockRejectedValueOnce(new Error('Comment could not be saved'));
    const onChanged = vi.fn();
    render(<CommonsDetail assetId="fixture-asset" onClose={vi.fn()} onDeleted={vi.fn()} onChanged={onChanged} />);
    const input = await screen.findByRole('textbox', { name: 'Add a comment' });
    fireEvent.change(input, { target: { value: 'Keep this comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Comment could not be saved');
    expect(input).toHaveValue('Keep this comment');
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(api.comment).toHaveBeenCalledTimes(2);
    expect(api.comment).toHaveBeenLastCalledWith('fixture-asset', 'Keep this comment', 'fixture-membership');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.asset).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks duplicate submissions and preserves a newer comment typed during the pending write', async () => {
    const pending = deferred<unknown>(); api.comment.mockReturnValueOnce(pending.promise);
    const onChanged = vi.fn();
    render(<CommonsDetail assetId="fixture-asset" onClose={vi.fn()} onDeleted={vi.fn()} onChanged={onChanged} />);
    const input = await screen.findByRole('textbox', { name: 'Add a comment' });
    fireEvent.change(input, { target: { value: 'Submitted comment' } });
    const post = screen.getByRole('button', { name: 'Post' });
    fireEvent.click(post); fireEvent.click(post);
    expect(api.comment).toHaveBeenCalledTimes(1);
    expect(post).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Next comment draft' } });
    await act(async () => pending.resolve({ id: 'fixture-comment' }));
    expect(input).toHaveValue('Next comment draft');
    expect(post).toBeEnabled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('clears a committed comment even when its read-back fails, retaining the read error', async () => {
    api.asset.mockResolvedValueOnce(detail()).mockRejectedValue(new Error('Read-back offline'));
    const onChanged = vi.fn();
    render(<CommonsDetail assetId="fixture-asset" onClose={vi.fn()} onDeleted={vi.fn()} onChanged={onChanged} />);
    const input = await screen.findByRole('textbox', { name: 'Add a comment' });
    fireEvent.change(input, { target: { value: 'Committed comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(await screen.findByRole('alert')).toHaveTextContent('Read-back offline');
    expect(api.comment).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('Commons linked-folder submissions', () => {
  it('preserves a rejected path, shows its error and retries without losing the input', async () => {
    api.linkFolder.mockRejectedValueOnce(new Error('Folder is not allowed'));
    const onChanged = vi.fn();
    render(<CommonsSettings status={null} onOpenAsset={vi.fn()} onChanged={onChanged} />);
    const input = screen.getByRole('textbox', { name: 'Folder path' });
    await waitFor(() => expect(api.folders).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: '/synthetic/references' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Folder is not allowed');
    expect(input).toHaveValue('/synthetic/references');
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(api.linkFolder).toHaveBeenCalledTimes(2);
    expect(api.linkFolder).toHaveBeenLastCalledWith('/synthetic/references');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.folders).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks duplicate linking and retains a newer path typed during a successful write', async () => {
    const pending = deferred<unknown>(); api.linkFolder.mockReturnValueOnce(pending.promise);
    const onChanged = vi.fn();
    render(<CommonsSettings status={null} onOpenAsset={vi.fn()} onChanged={onChanged} />);
    const input = screen.getByRole('textbox', { name: 'Folder path' });
    await waitFor(() => expect(api.folders).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: '/synthetic/first' } });
    const submit = screen.getByRole('button', { name: 'Link folder' });
    fireEvent.click(submit); fireEvent.click(submit);
    expect(api.linkFolder).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: '/synthetic/next' } });
    await act(async () => pending.resolve({ id: 'fixture-folder' }));
    expect(input).toHaveValue('/synthetic/next');
    expect(submit).toBeEnabled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('clears a committed path if refreshing the folder list fails and preserves that error', async () => {
    api.folders.mockResolvedValueOnce([]).mockRejectedValue(new Error('Folder refresh offline'));
    const onChanged = vi.fn();
    render(<CommonsSettings status={null} onOpenAsset={vi.fn()} onChanged={onChanged} />);
    const input = screen.getByRole('textbox', { name: 'Folder path' });
    await waitFor(() => expect(api.folders).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: '/synthetic/committed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(await screen.findByRole('alert')).toHaveTextContent('Folder refresh offline');
    expect(api.linkFolder).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

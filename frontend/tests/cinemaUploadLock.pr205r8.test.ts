import { afterEach, describe, expect, it } from 'vitest';
import { getCinemaUploadIssue, otherShotsUploadLine, uploadReasonRole, useCinemaUploadStore, type CinemaReferenceUpload } from '../src/store/cinemaUploadStore';

// GM PR #205 r14 item 3: the Cinema panel's lock reason for failed reference
// uploads takes the lock form and names them by the shared name-list rule.
const failed = (name: string, extra: Partial<CinemaReferenceUpload> = {}): CinemaReferenceUpload =>
  ({ id: `u-${name}`, attempt: 'a', nodeId: 'scene', name, status: 'error', error: 'Upload failed.', canRetry: true, ...extra });

describe('the panel\'s lock reason names the uploads to try again or remove', () => {
  afterEach(() => { useCinemaUploadStore.getState().clear(); });
  it.each([
    [['ref.png'], 'You can generate after you try “ref.png” again or remove it.'],
    [['a.png', 'b.png'], 'You can generate after you try “a.png” and “b.png” again or remove them.'],
    [['a.png', 'b.png', 'c.png'], 'You can generate after you try “a.png”, “b.png” and “c.png” again or remove them.'],
    [['a.png', 'b.png', 'c.png', 'd.png'], 'You can generate after you try 4 uploads again or remove them.'],
  ])('%j', (names, line) => {
    useCinemaUploadStore.getState().setUploads(() => names.map((name) => failed(name)));
    expect(getCinemaUploadIssue('scene')).toBe(line);
  });
  it('only the uploads that block this shot are named (another shot\'s stay out)', () => {
    useCinemaUploadStore.getState().setUploads(() => [failed('shared.png'), failed('mine.png', { shotId: 's1' }), failed('other.png', { shotId: 's2' })]);
    expect(getCinemaUploadIssue('scene', 's1')).toBe('You can generate after you try “shared.png” and “mine.png” again or remove them.');
  });
  it('control: an upload still on its way keeps the wait line', () => {
    useCinemaUploadStore.getState().setUploads(() => [failed('ref.png'), failed('next.png', { status: 'uploading' })]);
    expect(getCinemaUploadIssue('scene')).toBe('Wait for reference uploads to finish before generating.');
  });
});

describe('GM PR #205 r14 item 4: a stopped upload\'s reason is neutral', () => {
  afterEach(() => { useCinemaUploadStore.getState().clear(); });
  it('a canvas import stops an upload on its way: a status, not an alert; a failure stays an alert', () => {
    useCinemaUploadStore.getState().setUploads(() => [failed('ref.png', { status: 'uploading' }), failed('bad.png')]);
    useCinemaUploadStore.getState().interrupt();
    const [stopped, bad] = useCinemaUploadStore.getState().uploads;
    expect(stopped).toMatchObject({ status: 'error', error: 'The upload stopped because a canvas import started.', stopped: true });
    expect([uploadReasonRole(stopped), uploadReasonRole(bad)]).toEqual(['status', 'alert']);
    expect(uploadReasonRole({ ...stopped, status: 'uploading', stopped: undefined })).toBe('status');
  });
  it('the stopped mark isn\'t kept across a reload: the file is gone then, a problem to fix', async () => {
    const { createCinemaUploadStore } = await import('../src/store/cinemaUploadStore');
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } };
    const first = createCinemaUploadStore(storage);
    first.getState().setUploads(() => [failed('ref.png', { status: 'uploading' })]);
    first.getState().interrupt();
    const reloaded = createCinemaUploadStore(storage).getState().uploads[0];
    expect(reloaded.stopped).toBeUndefined();
    expect(uploadReasonRole(reloaded)).toBe('alert');
  });
});

describe('GM PR #205 r15 item 3: Generate all\'s lock reason names the other shots holding it', () => {
  afterEach(() => { useCinemaUploadStore.getState().clear(); });
  const shots = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => ({ id }));
  const on = (shotId: string, status: 'uploading' | 'error' = 'uploading') => failed(`${shotId}-${status}.png`, { shotId, status });
  it.each([
    ['one shot, pending', [on('s2')], 'You can generate all when the uploads in “Shot 2” finish.'],
    ['two shots, pending', [on('s3'), on('s2'), on('s2')], 'You can generate all when the uploads in “Shot 2” and “Shot 3” finish.'],
    ['four shots, pending: a count', [on('s2'), on('s3'), on('s4'), on('s5')], 'You can generate all when the uploads in 4 shots finish.'],
    ['one shot, failed', [on('s2', 'error')], 'You can generate all after you try the uploads in “Shot 2” again or remove them.'],
    ['two shots, failed', [on('s2', 'error'), on('s4', 'error')], 'You can generate all after you try the uploads in “Shot 2” and “Shot 4” again or remove them.'],
    ['pending and failed: the pending ones, by their shots', [on('s2', 'error'), on('s3')], 'You can generate all when the uploads in “Shot 3” finish.'],
  ])('%s', (_label, uploads, line) => {
    useCinemaUploadStore.getState().setUploads(() => uploads);
    expect(otherShotsUploadLine('scene', 's1', shots)).toBe(line);
  });
  it('none for this shot\'s own uploads, shared ones, another scene\'s, or a shot no longer in the scene', () => {
    useCinemaUploadStore.getState().setUploads(() => [on('s1'), failed('shared.png'), failed('x.png', { nodeId: 'other', shotId: 's2' }),
      failed('gone.png', { shotId: 'removed' })]);
    expect(otherShotsUploadLine('scene', 's1', shots)).toBeNull();
  });
});

describe('GM PR #205 r15 item 2: a stopped upload after a reload reads as the other reloaded rows', () => {
  it('"Remove it, then attach the image again.", an alert like them, no Try again', async () => {
    const { createCinemaUploadStore } = await import('../src/store/cinemaUploadStore');
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } };
    const first = createCinemaUploadStore(storage);
    first.getState().setUploads(() => [failed('ref.png', { status: 'uploading' }), failed('bad.png', { error: "Couldn't upload bad.png. Too large." })]);
    first.getState().interrupt();
    const [stopped, bad] = createCinemaUploadStore(storage).getState().uploads;
    expect(stopped).toMatchObject({ error: 'Remove it, then attach the image again.', canRetry: false });
    expect(uploadReasonRole(stopped)).toBe('alert');
    expect(bad).toMatchObject({ error: "Couldn't upload bad.png. Too large.", canRetry: false });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { getCinemaUploadIssue, otherShotsUploadLine, uploadOffersTryAgain, useCinemaUploadStore, type CinemaReferenceUpload } from '../src/store/cinemaUploadStore';
import { bundleRefusalLine } from '../src/lib/graphFile';

// GM PR #205 r17: the panel's lock line comes from what each row offers (the
// test its Try again button reads), so it never promises "try again" for a
// row that can only be removed.
const row = (name: string, canRetry: boolean, extra: Partial<CinemaReferenceUpload> = {}): CinemaReferenceUpload =>
  ({ id: `u-${name}`, attempt: 'a', nodeId: 'scene', name, status: 'error', error: 'Upload failed.', canRetry, ...extra });

afterEach(() => { useCinemaUploadStore.getState().clear(); });

describe('GM PR #205 r17: the shot panel\'s line, by what each row offers', () => {
  it.each([
    ['remove-only, one file', [row('ref.png', false)], 'You can generate after you remove “ref.png”.'],
    ['remove-only, two files (shot 12)', [row('ref.png', false), row('lost.png', false)],
      'You can generate after you remove “ref.png” and “lost.png”.'],
    ['try-again only', [row('a.png', true), row('b.png', true)],
      'You can generate after you try “a.png” and “b.png” again or remove them.'],
    ['mixed: two sentences, one per kind', [row('a.png', true), row('ref.png', false), row('lost.png', false)],
      'You can generate after you try “a.png” again or remove it. You can generate after you remove “ref.png” and “lost.png”.'],
  ])('%s', (_label, uploads, line) => {
    useCinemaUploadStore.getState().setUploads(() => uploads);
    expect(getCinemaUploadIssue('scene')).toBe(line);
  });

  it('the line and the row read the same test (a retryable row still uploading offers no Try again)', () => {
    expect(uploadOffersTryAgain(row('a.png', true))).toBe(true);
    expect(uploadOffersTryAgain(row('a.png', false))).toBe(false);
    expect(uploadOffersTryAgain(row('a.png', true, { status: 'uploading' }))).toBe(false);
  });

  it('the reloaded rows of shot 12: both remove-only, and the stopped one opens with what happened', async () => {
    const { createCinemaUploadStore } = await import('../src/store/cinemaUploadStore');
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); } };
    const first = createCinemaUploadStore(storage);
    first.getState().setUploads(() => [row('ref.png', true, { status: 'uploading' }), row('lost.png', true, { status: 'uploading' })]);
    first.getState().interrupt();
    const reloaded = createCinemaUploadStore(storage).getState().uploads;
    expect(reloaded.map((upload) => upload.error)).toEqual([
      'Upload was interrupted. Remove it, then attach the image again.',
      'Upload was interrupted. Remove it, then attach the image again.']);
    useCinemaUploadStore.getState().setUploads(() => reloaded);
    expect(getCinemaUploadIssue('scene')).toBe('You can generate after you remove “ref.png” and “lost.png”.');
  });
});

describe('GM PR #205 r17: Generate all\'s line for other shots, by what their rows offer', () => {
  const shots = ['s1', 's2', 's3', 's4'].map((id) => ({ id }));
  it.each([
    ['remove-only', [row('x.png', false, { shotId: 's2' })], 'You can generate all after you remove the uploads in “Shot 2”.'],
    ['try-again', [row('x.png', true, { shotId: 's2' })], 'You can generate all after you try the uploads in “Shot 2” again or remove them.'],
    ['mixed shots: two sentences', [row('x.png', true, { shotId: 's2' }), row('y.png', false, { shotId: 's3' }), row('z.png', false, { shotId: 's4' })],
      'You can generate all after you try the uploads in “Shot 2” again or remove them. You can generate all after you remove the uploads in “Shot 3” and “Shot 4”.'],
    ['a shot with a row that can be tried again takes the try form', [row('x.png', true, { shotId: 's2' }), row('y.png', false, { shotId: 's2' })],
      'You can generate all after you try the uploads in “Shot 2” again or remove them.'],
  ])('%s', (_label, uploads, line) => {
    useCinemaUploadStore.getState().setUploads(() => uploads);
    expect(otherShotsUploadLine('scene', 's1', shots)).toBe(line);
  });
});

describe('GM PR #205 r17 item 3: a size refusal with no size names the limit', () => {
  it.each([
    [{ code: 'bundle_upload_too_large', limitBytes: 528 * 1024 * 1024 }, 'This file is larger than 528 MB, the most Nebula opens.'],
    [{ code: 'bundle_member_too_large', limitBytes: 256 * 1024 * 1024 }, 'One of its files is larger than 256 MB, the most Nebula opens.'],
    [{ code: 'bundle_upload_too_large', sizeBytes: 600 * 1024 * 1024, limitBytes: 528 * 1024 * 1024 }, 'This file is 600.0 MB. Nebula opens files up to 528 MB.'],
  ])('%j', (body, line) => {
    expect(bundleRefusalLine(body)).toBe(line);
  });
  it('no limit either: no line (the heading alone)', () => {
    expect(bundleRefusalLine({ code: 'bundle_upload_too_large' })).toBeNull();
    expect(bundleRefusalLine({ code: 'bundle_member_too_large', sizeBytes: 5 })).toBeNull();
  });
});

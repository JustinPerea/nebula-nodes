import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { CommonsMedia } from '../src/components/commons/CommonsMedia';
const blob = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/commonsApi', () => ({ commonsApi: { blob } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('loads protected bytes and revokes its temporary URL on unmount', async () => {
  blob.mockResolvedValue(new Blob(['image']));
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:protected');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const { unmount } = render(<CommonsMedia path="/api/commons/blobs/a.png" alt="Reference" />);
  await waitFor(() => expect(screen.getByAltText('Reference').getAttribute('src')).toBe('blob:protected'));
  expect(blob).toHaveBeenCalledWith('/api/commons/blobs/a.png', expect.any(AbortSignal));
  expect(create).toHaveBeenCalledTimes(1);
  unmount();
  expect(revoke).toHaveBeenCalledWith('blob:protected');
});

/**
 * "Download a copy" (the over-the-limit panel, Q118) past the browser string
 * cap: GM's heading and line in the notice (GM copy batch, 2026-10-25).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, subscribeFirst: () => () => {},
  connect: () => {}, send: () => {} } }));
vi.mock('../src/lib/canvasNotice', async (original) => ({
  ...await original<typeof import('../src/lib/canvasNotice')>(), showNotice: vi.fn(),
}));
vi.mock('../src/lib/graphFileShared', async (original) => ({
  ...await original<typeof import('../src/lib/graphFileShared')>(), saveProjectCopyToFile: vi.fn(),
}));

const { useProjectStore } = await import('../src/store/projectStore');
const { showNotice } = await import('../src/lib/canvasNotice');
const shared = await import('../src/lib/graphFileShared');

afterEach(() => vi.restoreAllMocks());

describe('Download a copy', () => {
  it("past the string cap: Couldn't download a copy. It's too big to download in a browser.", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(shared.saveProjectCopyToFile).mockRejectedValueOnce(new shared.BrowserStringLimitError());
    useProjectStore.setState({ activeProject: { id: 'p1', name: 'Glass campaign' } } as never);
    await useProjectStore.getState().downloadProjectCopy();
    // PR #204 r6 (review 4 LOW-2): the failure goes with the line, for its code and stamp.
    expect(showNotice).toHaveBeenCalledWith("Couldn't download a copy. It's too big to download in a browser.", 'error',
      expect.any(shared.BrowserStringLimitError));
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { useCinemaMotionStore } from '../src/store/cinemaMotionStore';
import { createCinemaUploadStore } from '../src/store/cinemaUploadStore';

// GM PR #205 r10 item 4: what a canvas import says to a connection and an
// upload it stops ("pending" and "Retry" are the app's words, not the person's).

afterEach(() => useCinemaMotionStore.getState().clear());

describe('a canvas import interrupts', () => {
  it('a Cinema shot\'s connection still waiting', () => {
    useCinemaMotionStore.getState().setHandoffs(() => [{ nodeId: 'n1', shotId: 's1', attempt: 'a', graphRevision: 0, status: 'pending' }]);
    useCinemaMotionStore.getState().interruptPending();
    expect(useCinemaMotionStore.getState().handoffs[0]).toMatchObject({
      status: 'error', error: 'A canvas import interrupted the connection. Try again when the import finishes.',
    });
  });

  it('an upload still on its way', () => {
    const store = createCinemaUploadStore(null);
    store.getState().setUploads(() => [{ id: 'u1', attempt: 'a', nodeId: 'n1', name: 'ref.png', status: 'uploading', canRetry: true }]);
    store.getState().interrupt();
    expect(store.getState().uploads[0]).toMatchObject({
      status: 'error', error: 'The upload stopped because a canvas import started.',
    });
  });
});

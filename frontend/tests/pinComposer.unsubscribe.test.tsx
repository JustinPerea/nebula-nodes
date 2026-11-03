// #220 review 1 NIT-4: PinComposer's refit listener (onPinTextLoaded) leaves
// with the component. A listener kept after unmount would set state on a dead
// component at every later load and pile up across remounts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const live = vi.hoisted(() => new Set<() => void>());
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
// The real module, with onPinTextLoaded counted: each listener is in `live`
// from its subscribe until its own unsubscribe runs.
vi.mock('../src/lib/canvasPins', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/canvasPins')>();
  return {
    ...real,
    onPinTextLoaded: (listener: () => void) => {
      live.add(listener);
      const off = real.onPinTextLoaded(listener);
      return () => { live.delete(listener); off(); };
    },
  };
});

const { PinComposer } = await import('../src/components/canvas/PinComposer');

afterEach(cleanup);

describe('#220 review 1 NIT-4: PinComposer unsubscribes from onPinTextLoaded on unmount', () => {
  it('one listener while mounted, none of its own after unmount, across remounts', () => {
    // The store's own listener registers as its module loads (before any render).
    const base = live.size;
    for (let round = 0; round < 3; round += 1) {
      const view = render(<PinComposer />);
      expect(live.size).toBe(base + 1);
      view.unmount();
      expect(live.size).toBe(base);
    }
  });
});

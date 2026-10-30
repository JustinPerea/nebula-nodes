// Review 13 L-2 (PR #200 fix round 14): the Unicode data is its own chunk,
// fetched as lib/canvasPins loads. Pins that arrive before it are neither
// dropped nor shown unsanitized: they wait for it, in arrival order; the
// note dialog waits for it before it counts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const gate = vi.hoisted(() => {
  let open: () => void = () => {};
  const ready = new Promise<void>((resolve) => { open = resolve; });
  return { ready, open: () => open() };
});
vi.mock('../src/lib/pinTextUnicode.json', async (importOriginal) => {
  await gate.ready;
  return importOriginal();
});
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

const pins = await import('../src/lib/canvasPins');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { PinComposer } = await import('../src/components/canvas/PinComposer');

const pin = (id: string, text: string) => ({ id, text, anchor: { nodeId: 'n1' }, status: 'open', createdAt: '2026-10-29T10:00:00+00:00' });
afterEach(cleanup);

describe('review 13 L-2: the Unicode data loads lazily', () => {
  it('is not in the entry: no static import of the JSON', () => {
    const source = readFileSync(join(__dirname, '../src/lib/canvasPins.ts'), 'utf8');
    expect(source).not.toMatch(/^import [^;]*pinTextUnicode\.json/m);
    expect(source).toMatch(/import\('\.\/pinTextUnicode\.json'\)/);
  });

  it('pins pushed before the data waits for it, in order, then show sanitized; the dialog counts only once it is in', async () => {
    expect(pins.pinTextIsLoaded()).toBe(false);
    const store = useCanvasPinsStore.getState();
    store.apply({ projectId: 'p1', pins: [pin('pin_a', 'warmer \x1b[31mred\x1b[0m 葛\u{E0100}\u{E0101}')] });
    store.apply({ projectId: 'p1', pins: [pin('pin_a', 'warmer'), pin('pin_b', '❤️‍‍')] });
    // Not shown yet, and nothing unsanitized either.
    expect(useCanvasPinsStore.getState().pins).toEqual([]);
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    expect(screen.queryByRole('textbox', { name: 'Note for agents' })).toBeNull();
    await act(async () => {
      gate.open();
      await pins.pinTextReady;
      await Promise.resolve();
    });
    expect(pins.pinTextIsLoaded()).toBe(true);
    // The later listing won, as it would have without the wait.
    expect(useCanvasPinsStore.getState().pins.map((p) => [p.id, p.text])).toEqual([['pin_a', 'warmer'], ['pin_b', '❤️‍‍']]);
    expect(pins.pinDisplayText('❤️‍‍')).toBe('❤️');
    expect(pins.pinDisplayText('warmer \x1b[31mred\x1b[0m 葛\u{E0100}\u{E0101}')).toBe('warmer red 葛\u{E0100}');
    expect(screen.getByRole('textbox', { name: 'Note for agents' })).toBeTruthy();
  });
});

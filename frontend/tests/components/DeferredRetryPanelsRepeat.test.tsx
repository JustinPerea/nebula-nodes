import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MaskPainterModal, RunHistoryPanel } from '../../src/components/DeferredPanels';
import { useUIStore } from '../../src/store/uiStore';

// A deferred panel whose chunk fails more than once (still offline on the
// next open). Its own file, so each chunk starts unloaded: a chunk that has
// loaded stays loaded for the file (see DeferredRetryPanels.test.tsx).

const chunks = vi.hoisted(() => ({
  failures: new Map<string, number>(),
  loads: new Map<string, number>(),
}));

vi.mock('../../src/lib/deferredChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/deferredChunks')>();
  const { lazyWithPreload } = await import('../../src/lib/lazyWithPreload');
  const flaky = <M,>(name: string, module: M) => () => {
    chunks.loads.set(name, (chunks.loads.get(name) ?? 0) + 1);
    const left = chunks.failures.get(name) ?? 0;
    if (left > 0) {
      chunks.failures.set(name, left - 1);
      return Promise.reject(new Error(`chunk failed: ${name}`));
    }
    return Promise.resolve(module);
  };
  return {
    ...actual,
    DeferredRunHistoryPanel: lazyWithPreload(
      flaky('history', { RunHistoryPanel: () => <p>Run History stub</p> }), (m) => m.RunHistoryPanel),
    DeferredMaskPainterModal: lazyWithPreload(
      flaky('mask', { MaskPainterModal: () => <div role="dialog" aria-label="Real mask painter" /> }),
      (m) => m.MaskPainterModal),
  };
});

const initialUI = useUIStore.getState();
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a deferred panel whose chunk keeps failing', () => {
  it('Run History does not stay marked open after a retry that failed too', async () => {
    chunks.failures.set('history', 2);
    render(<RunHistoryPanel />);
    act(() => useUIStore.getState().togglePanel('history'));
    await flush();
    expect(useUIStore.getState().panels.history.visible).toBe(false);

    // The second open fails as well: the dock closes again, so the next
    // click is an open, not a toggle off of an empty dock.
    act(() => useUIStore.getState().togglePanel('history'));
    await flush();
    expect(screen.queryByText('Run History stub')).toBeNull();
    expect(useUIStore.getState().panels.history.visible).toBe(false);

    act(() => useUIStore.getState().togglePanel('history'));
    expect(await screen.findByText('Run History stub')).toBeInTheDocument();
    expect(useUIStore.getState().panels.history.visible).toBe(true);
  });

  it("the mask painter's Try again keeps focus while it tries, and after it fails", async () => {
    chunks.failures.set('mask', 3);
    const props = { imageUrl: '/api/outputs/a.png', initialMask: null, onSave: () => {}, onClose: () => {} };
    const first = render(<MaskPainterModal {...props} />);
    await flush();
    first.unmount();
    render(<MaskPainterModal {...props} />);
    await flush();
    const loadsBefore = chunks.loads.get('mask') ?? 0;

    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    tryAgain.focus();
    fireEvent.click(tryAgain);
    const busy = screen.getByRole('button', { name: 'Trying again…' });
    // A disabled button drops keyboard focus to the page in browsers; this
    // one stays focusable and ignores clicks until the attempt settles.
    expect(busy).not.toBeDisabled();
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    await flush();
    expect(chunks.loads.get('mask')).toBe(loadsBefore + 1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' }));
  });
});


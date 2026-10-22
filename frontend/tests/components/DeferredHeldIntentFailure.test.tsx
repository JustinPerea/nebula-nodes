import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';

// What a held intent does when the chunk it waits for cannot load
// (lib/heldIntents.ts, components/DeferredPanels.tsx). Review of the second
// entry split (docs/notes/2026-10-22-perf-entry-split-2.md): a ⌘K or a rail
// open after a failed palette chunk must try the chunk again, and a hold must
// never outlive the failed load it was waiting for, so a later window focus or
// a manual open does not replay an old ⌘K or an old Enhance message.
//
// The real chunks are replaced by stubs that follow the same claim protocol
// as CommandPalette.tsx and ChatPanel.tsx, behind a loader that fails a set
// number of times. Each test resets the module registry, so it gets its own
// fresh chunks, held intents and UI store (a chunk that loaded stays loaded).

const chunks = vi.hoisted(() => ({
  failures: new Map<string, number>(),
  loads: new Map<string, number>(),
}));

// Registered per test (vi.doMock after vi.resetModules), so every test gets fresh chunks.
const mockChunks = () => vi.doMock('../../src/lib/deferredChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/deferredChunks')>();
  const { lazyWithPreload } = await import('../../src/lib/lazyWithPreload');
  const { claimIntent } = await import('../../src/lib/heldIntents');
  const { isPaletteHotkey } = await import('../../src/lib/commandPaletteKeys');
  const { useEffect, useState } = await import('react');
  const flaky = <M,>(name: string, module: M) => () => {
    chunks.loads.set(name, (chunks.loads.get(name) ?? 0) + 1);
    const left = chunks.failures.get(name) ?? 0;
    if (left > 0) {
      chunks.failures.set(name, left - 1);
      return Promise.reject(new Error(`chunk failed: ${name}`));
    }
    return Promise.resolve(module);
  };
  function PaletteStub() {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        if (!isPaletteHotkey(event)) return;
        event.preventDefault();
        setOpen((was) => !was);
      };
      document.addEventListener('keydown', onKey);
      const claim = claimIntent('command-palette');
      if (claim.held) setOpen(true);
      return () => {
        claim.release();
        document.removeEventListener('keydown', onKey);
      };
    }, []);
    return <p>{open ? 'Palette open' : 'Palette closed'}</p>;
  }
  function ChatStub() {
    const [input, setInput] = useState('');
    useEffect(() => {
      const claim = claimIntent<{ message: string }>('chat-send');
      if (claim.held) setInput(claim.held.message);
      return claim.release;
    }, []);
    return <textarea aria-label="Chat input" value={input} readOnly />;
  }
  return {
    ...actual,
    DeferredCommandPalette: lazyWithPreload(flaky('palette', { CommandPalette: PaletteStub }), (m) => m.CommandPalette),
    DeferredChatPanel: lazyWithPreload(flaky('chat', { ChatPanel: ChatStub }), (m) => m.ChatPanel),
  };
});

type Panels = typeof import('../../src/components/DeferredPanels');
type UI = typeof import('../../src/store/uiStore');
let panels: Panels;
let ui: UI['useUIStore'];

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
const focusWindow = () => act(() => { window.dispatchEvent(new Event('focus')); });
const pressCmdK = () => {
  const press = createEvent.keyDown(document, { key: 'k', metaKey: true });
  fireEvent(document, press);
  return press;
};

beforeEach(async () => {
  vi.resetModules();
  mockChunks();
  chunks.failures.clear();
  chunks.loads.clear();
  panels = await import('../../src/components/DeferredPanels');
  ui = (await import('../../src/store/uiStore')).useUIStore;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('command palette after its chunk failed', () => {
  it('a ⌘K tries the chunk again and opens the palette when that load succeeds', async () => {
    chunks.failures.set('palette', 1);
    render(<panels.CommandPalette />);
    await flush();
    expect(chunks.loads.get('palette')).toBe(1);
    expect(screen.queryByText(/Palette/)).toBeNull();

    const press = pressCmdK();
    expect(press.defaultPrevented).toBe(true);
    expect(await screen.findByText('Palette open')).toBeInTheDocument();
    expect(chunks.loads.get('palette')).toBe(2);
  });

  it('the rail\'s Search tries the chunk again too', async () => {
    chunks.failures.set('palette', 1);
    render(<panels.CommandPalette />);
    await flush();
    act(() => { window.dispatchEvent(new CustomEvent('nebula:command-palette-open')); });
    expect(await screen.findByText('Palette open')).toBeInTheDocument();
    expect(chunks.loads.get('palette')).toBe(2);
  });

  it('a ⌘K whose retry fails is forgotten: a later focus loads the palette closed', async () => {
    chunks.failures.set('palette', 2);
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    render(<panels.CommandPalette />);
    await flush();
    pressCmdK();
    await flush();
    expect(screen.queryByText(/Palette/)).toBeNull();

    // Two window focuses, far enough apart that each may fetch: whichever one
    // brings the chunk in, the old ⌘K must not open the palette.
    focusWindow();
    await flush();
    now += 60_000;
    focusWindow();
    await flush();
    expect(screen.queryByText('Palette open')).toBeNull();
    expect(screen.getByText('Palette closed')).toBeInTheDocument();
  });
});

describe('chat after its chunk failed', () => {
  it('an Enhance send whose load failed is forgotten: the next manual open shows an empty input', async () => {
    chunks.failures.set('chat', 2);
    render(<panels.ChatPanel />);
    await flush();
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:chat-send', { detail: { message: 'An old idea', sourceNodeId: 'n1' } }));
    });
    await flush();
    // The open's retry failed too, so the chat closed again.
    expect(ui.getState().panels.chat.visible).toBe(false);
    expect(chunks.loads.get('chat')).toBe(2);

    act(() => ui.getState().togglePanel('chat'));
    const input = await screen.findByRole('textbox', { name: 'Chat input' });
    expect(input).toHaveValue('');
  });
});

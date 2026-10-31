import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

// The second entry-split pass (docs/notes/2026-10-22-perf-entry-split-2.md):
// the chat, the node Inspector, the Assets dock, the command palette, graph
// save / open and four canvas overlays left the startup entry. These tests
// pin what the person sees: what they did before a chunk arrived (a ⌘K, an
// Enhance's chat-send) is not lost, a piece fetches nothing while closed, the
// first open after the idle preload draws with no loading step, and graph
// save / open reach their module at the moment of use.

const apiMocks = vi.hoisted(() => ({
  fetchClaudeStatus: vi.fn(), fetchCodexStatus: vi.fn(), fetchChatModels: vi.fn(), fetchPersonalAgents: vi.fn(),
  fetchCharacters: vi.fn(), fetchMoodboards: vi.fn(), fetchPresets: vi.fn(),
}));
vi.mock('../../src/lib/api', async (original) => ({
  ...await original<typeof import('../../src/lib/api')>(),
  fetchClaudeStatus: apiMocks.fetchClaudeStatus,
  fetchCodexStatus: apiMocks.fetchCodexStatus,
  fetchChatModels: apiMocks.fetchChatModels,
  fetchPersonalAgents: apiMocks.fetchPersonalAgents,
  fetchCharacters: apiMocks.fetchCharacters,
  fetchMoodboards: apiMocks.fetchMoodboards,
}));
vi.mock('../../src/lib/createPresets', async (original) => ({
  ...await original<typeof import('../../src/lib/createPresets')>(),
  fetchPresets: apiMocks.fetchPresets,
}));
// No chat socket in these tests: the URL never resolves.
vi.mock('../../src/lib/backend', async (original) => ({
  ...await original<typeof import('../../src/lib/backend')>(),
  backendWebSocketUrl: vi.fn(() => new Promise<string>(() => {})),
}));
// The Inspector's own fields are covered by its tests; here only the popover's arrival matters.
vi.mock('../../src/components/panels/Inspector', () => ({
  Inspector: () => <p>Inspector fields</p>,
}));

import { AssetsPanel, ChatPanel, CommandPalette, NodeInspectorPopover } from '../../src/components/DeferredPanels';
import { deferredAtOnce } from '../../src/components/deferredAtOnce';
import {
  DEFERRED_PRELOADS,
  DeferredAssetsPanel,
  DeferredChatPanel,
  DeferredCommandPalette,
  DeferredNodeInspectorPopover,
  graphFileModule,
} from '../../src/lib/deferredChunks';
import { claimIntent, dropIntent, heldIntent, holdIntent, isIntentClaimed } from '../../src/lib/heldIntents';
import { deferredModule, lazyWithPreload } from '../../src/lib/lazyWithPreload';
import { useUIStore } from '../../src/store/uiStore';

const initialUI = useUIStore.getState();
// Tests that load a chunk cold include its first module transform, which can
// take seconds on a loaded machine; they get room for it (what they assert is
// unchanged).
const COLD = { timeout: 20_000 };
const COLD_TEST = 30_000;
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  apiMocks.fetchClaudeStatus.mockResolvedValue({ installed: true, loggedIn: true });
  apiMocks.fetchCodexStatus.mockResolvedValue({ installed: true, loggedIn: true, mode: 'chatgpt' });
  apiMocks.fetchChatModels.mockResolvedValue({ agent: 'claude', status: 'ready', auth: { mode: 'claudeai' }, models: [] });
  apiMocks.fetchPersonalAgents.mockResolvedValue({ warningAcknowledged: false, agents: [] });
  apiMocks.fetchCharacters.mockResolvedValue([]);
  apiMocks.fetchMoodboards.mockResolvedValue([]);
  apiMocks.fetchPresets.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('held intents (lib/heldIntents.ts)', () => {
  it('holds the latest intent until the piece claims it, then hands it over once', () => {
    holdIntent('chat-send', { message: 'first' });
    holdIntent('chat-send', { message: 'latest' });
    expect(heldIntent('chat-send')).toEqual({ message: 'latest' });
    expect(isIntentClaimed('chat-send')).toBe(false);

    const claim = claimIntent<{ message: string }>('chat-send');
    expect(claim.held).toEqual({ message: 'latest' });
    expect(isIntentClaimed('chat-send')).toBe(true);
    expect(heldIntent('chat-send')).toBeUndefined();

    claim.release();
    expect(isIntentClaimed('chat-send')).toBe(false);
    expect(claimIntent('chat-send').held).toBeUndefined();
    claimIntent('chat-send').release();
  });

  it('drops a held intent the person took back (a second ⌘K)', () => {
    holdIntent('command-palette', true);
    dropIntent('command-palette');
    const claim = claimIntent('command-palette');
    expect(claim.held).toBeUndefined();
    claim.release();
  });
});

describe('deferred command palette', () => {
  it('a ⌘K that beats the chunk opens the palette once it lands, with its commands', async () => {
    expect(DeferredCommandPalette.isLoaded()).toBe(false);
    render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
    const press = createEvent.keyDown(document, { key: 'k', metaKey: true });
    fireEvent(document, press);
    // Taken from the browser at once, as before (no page shortcut runs underneath).
    expect(press.defaultPrevented).toBe(true);

    expect(await screen.findByRole('option', { name: 'Toggle run history' }, COLD)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search commands and nodes' })).toBeInTheDocument();

    // Once in, it owns the hotkey: the next ⌘K closes it.
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.queryByRole('option', { name: 'Toggle run history' })).toBeNull();
  }, COLD_TEST);

  it('once preloaded, the first open from the rail draws synchronously, with its items', async () => {
    await DeferredCommandPalette.preload();
    render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
    act(() => { window.dispatchEvent(new CustomEvent('nebula:command-palette-open')); });
    expect(screen.getByRole('option', { name: 'Toggle run history' })).toBeInTheDocument();
  }, COLD_TEST);
});

describe('the palette hotkey right after it opens', () => {
  it('a ⌘K in the same moment as the open closes it, not opens it again', async () => {
    await DeferredCommandPalette.preload();
    render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
    // Both land before React commits the open: the second ⌘K must still read it as open.
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:command-palette-open'));
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(screen.queryByRole('option', { name: 'Toggle run history' })).toBeNull();
  }, COLD_TEST);
});

describe('deferred chat', () => {
  it('a chat-send that beats the chunk opens the chat and lands in its input', async () => {
    expect(DeferredChatPanel.isLoaded()).toBe(false);
    const { container } = render(<ChatPanel />);
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:chat-send', { detail: { message: 'Make the light warmer', sourceNodeId: 'n1' } }));
    });
    // The open shows on the launcher at once.
    expect(useUIStore.getState().panels.chat.visible).toBe(true);
    await waitFor(() => expect(container.querySelector('textarea')).toHaveValue('Make the light warmer'), COLD);
  }, COLD_TEST);

  it('once in, a chat-send goes straight to the panel (nothing held)', async () => {
    await DeferredChatPanel.preload();
    const { container } = render(<ChatPanel />);
    await flush();
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:chat-send', { detail: { message: 'Second idea' } }));
    });
    expect(heldIntent('chat-send')).toBeUndefined();
    await waitFor(() => expect(container.querySelector('textarea')).toHaveValue('Second idea'), COLD);
  }, COLD_TEST);
});

describe('deferred node Inspector', () => {
  it('fetches nothing while closed and opens on the first open', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
    const anchor = document.createElement('div');
    anchor.dataset.nodeInspectorAnchor = 'n1';
    anchor.getBoundingClientRect = () => new DOMRect(400, 200, 240, 160);
    document.body.appendChild(anchor);
    const preload = vi.spyOn(DeferredNodeInspectorPopover, 'preload');

    render(<NodeInspectorPopover />);
    await flush();
    expect(preload).not.toHaveBeenCalled();
    expect(DeferredNodeInspectorPopover.isLoaded()).toBe(false);
    expect(screen.queryByText('Inspector fields')).toBeNull();

    act(() => {
      useUIStore.getState().selectNode('n1');
      useUIStore.getState().setInspectorVisible(true);
    });
    expect(await screen.findByText('Inspector fields', {}, COLD)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close inspector' })).toBeInTheDocument();
    anchor.remove();
    vi.unstubAllGlobals();
  }, COLD_TEST);
});

describe('deferred Assets dock', () => {
  it('opens on the first open with its tabs', async () => {
    expect(DeferredAssetsPanel.isLoaded()).toBe(false);
    render(<ReactFlowProvider><AssetsPanel /></ReactFlowProvider>);
    expect(await screen.findByRole('tab', { name: 'Moodboards' }, COLD)).toBeInTheDocument();
  }, COLD_TEST);
});

describe('graph save / open at the moment of use', () => {
  it('the graph file module is preloaded on idle with the other deferred chunks', () => {
    expect(DEFERRED_PRELOADS).toContain(graphFileModule.preload);
  });

  it('loads once, and a failed load retries from a fresh URL on the next use', async () => {
    const module = { saveToFile: vi.fn() };
    const load = vi.fn()
      .mockRejectedValueOnce(new TypeError(`Failed to fetch dynamically imported module: ${location.origin}/assets/graphFile-abc.js`))
      .mockRejectedValueOnce(new TypeError(`Failed to fetch dynamically imported module: ${location.origin}/assets/graphFile-abc.js`));
    const importModule = vi.fn(async () => module);
    const graphFile = deferredModule(load, { importModule });

    await expect(graphFile.load()).rejects.toThrow('dynamically imported module');
    expect(graphFile.isLoaded()).toBe(false);
    // Chromium keeps the failed import: the next use fetches the same chunk with a fresh query.
    await expect(graphFile.load()).resolves.toBe(module);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importModule.mock.calls[0][0]).toMatch(/\/assets\/graphFile-abc\.js\?retry=/);
    await expect(graphFile.load()).resolves.toBe(module);
    expect(load).toHaveBeenCalledTimes(2);
    expect(graphFile.isLoaded()).toBe(true);
  });
});

describe('overlays mounted at once (components/deferredAtOnce.tsx)', () => {
  it('draw nothing until their chunk lands, then what the store holds; a failed chunk leaves the rest', async () => {
    let resolve!: (module: { Overlay: () => JSX.Element }) => void;
    const Overlay = lazyWithPreload(
      () => new Promise<{ Overlay: () => JSX.Element }>((done) => { resolve = done; }),
      (module) => module.Overlay,
    );
    const AtOnce = deferredAtOnce(Overlay, 'TestOverlay');
    render(<><p>Canvas</p><AtOnce /></>);
    expect(screen.getByText('Canvas')).toBeInTheDocument();
    expect(screen.queryByText('Proposal from Claude')).toBeNull();
    await act(async () => { resolve({ Overlay: () => <p>Proposal from Claude</p> }); });
    expect(await screen.findByText('Proposal from Claude')).toBeInTheDocument();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = lazyWithPreload(() => Promise.reject(new Error('chunk failed')), (module: { Overlay: () => JSX.Element }) => module.Overlay);
    const BrokenAtOnce = deferredAtOnce(Broken, 'BrokenOverlay');
    cleanup();
    render(<><p>Canvas still here</p><BrokenAtOnce /></>);
    await flush();
    expect(screen.getByText('Canvas still here')).toBeInTheDocument();
  });
});

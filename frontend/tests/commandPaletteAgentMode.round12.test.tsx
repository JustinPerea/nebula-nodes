import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

// Review 11, two older palette bugs (fixed now: Justin, complete fixes as we
// hit them). "Ask the agent…" closed the palette (run closed it before the
// command ran, since 657f7a19), so agent mode was unreachable and its Escape
// (back to commands) never ran. And an Escape (or Enter) that only ends an
// IME composition in the search field closed the palette (or ran a command).

vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn().mockRejectedValue(new TypeError('Offline fixture')),
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

import { CommandPalette } from '../src/components/CommandPalette';
import { useGraphStore } from '../src/store/graphStore';

const initialGraph = useGraphStore.getState();
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
const dialog = () => screen.queryByRole('dialog', { name: 'Search commands and nodes' });
const commandsField = () => screen.queryByPlaceholderText('Search commands and nodes…');
const agentField = () => screen.queryByPlaceholderText('Describe what to build, then Enter…');
const openPalette = async () => {
  act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
  await settle();
};
const askItem = () => [...document.querySelectorAll<HTMLButtonElement>('.command-palette__item')]
  .find((item) => item.textContent?.includes('Ask the agent…'));

describe('the palette: agent mode and IME composition', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useGraphStore.setState({ nodes: [], edges: [] } as never);
    render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    useGraphStore.setState(initialGraph, true);
  });

  it('"Ask the agent…" (clicked) opens agent mode in the palette, with the field focused', async () => {
    await openPalette();
    act(() => { fireEvent.click(askItem()!); });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(agentField()).not.toBeNull();
    expect(document.activeElement).toBe(agentField());
  });

  it('"Ask the agent…" by Enter from the search field opens agent mode too', async () => {
    await openPalette();
    act(() => { fireEvent.change(commandsField()!, { target: { value: 'ask the agent' } }); });
    act(() => { fireEvent.keyDown(commandsField()!, { key: 'Enter' }); });
    await settle();
    expect(agentField()).not.toBeNull();
  });

  it('Escape in agent mode goes back to commands, still open', async () => {
    await openPalette();
    act(() => { fireEvent.click(askItem()!); });
    await settle();
    act(() => { fireEvent.keyDown(agentField()!, { key: 'Escape' }); });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(commandsField()).not.toBeNull();
    act(() => { fireEvent.keyDown(commandsField()!, { key: 'Escape' }); });
    await settle();
    expect(dialog()).toBeNull();
  });

  it('Enter in agent mode sends the text to the chat and closes', async () => {
    const sent: string[] = [];
    const listen = (event: Event) => sent.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('nebula:chat-send', listen);
    await openPalette();
    act(() => { fireEvent.click(askItem()!); });
    await settle();
    act(() => { fireEvent.change(agentField()!, { target: { value: 'animate a logo' } }); });
    act(() => { fireEvent.keyDown(agentField()!, { key: 'Enter' }); });
    await settle();
    window.removeEventListener('nebula:chat-send', listen);
    expect(sent).toEqual(['animate a logo']);
    expect(dialog()).toBeNull();
  });

  it.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('an Escape that ends a composition (%s) leaves the palette open', async (_name, flags) => {
    await openPalette();
    act(() => { fireEvent.keyDown(commandsField()!, { key: 'Escape', ...flags }); });
    await settle();
    expect(dialog()).not.toBeNull();
  });

  it('an Enter that commits a composition runs nothing', async () => {
    await openPalette();
    act(() => { fireEvent.change(commandsField()!, { target: { value: 'ask the agent' } }); });
    act(() => { fireEvent.keyDown(commandsField()!, { key: 'Enter', isComposing: true }); });
    await settle();
    expect(agentField()).toBeNull();
    expect(dialog()).not.toBeNull();
  });

  it('in agent mode, a composing Escape stays in agent mode and a composing Enter sends nothing', async () => {
    const sent: string[] = [];
    const listen = (event: Event) => sent.push((event as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener('nebula:chat-send', listen);
    await openPalette();
    act(() => { fireEvent.click(askItem()!); });
    await settle();
    act(() => { fireEvent.change(agentField()!, { target: { value: 'ロゴ' } }); });
    act(() => { fireEvent.keyDown(agentField()!, { key: 'Enter', keyCode: 229 }); });
    act(() => { fireEvent.keyDown(agentField()!, { key: 'Escape', isComposing: true }); });
    await settle();
    window.removeEventListener('nebula:chat-send', listen);
    expect(sent).toEqual([]);
    expect(agentField()).not.toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

// Review 10, L-1: with focus on a palette item (Cmd+K, Tab to "Run canvas"),
// Escape and the arrows did nothing: only the search field handled them. The
// dialog itself now handles them: Escape closes it (or leaves the agent
// prompt, as from the field), and the arrows move the active item and focus
// together, as the field moves the active item.

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
const field = () => screen.getByPlaceholderText('Search commands and nodes…');
const enabledItems = () => [...document.querySelectorAll<HTMLButtonElement>('.command-palette__item:not([disabled])')];
const selectedItem = () => document.querySelector('.command-palette__item--selected');
const openPalette = async () => {
  act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
  await settle();
};

describe('the palette: Escape and the arrows with focus on an item', () => {
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

  it('Escape on an item closes the palette', async () => {
    await openPalette();
    const first = enabledItems()[0];
    act(() => { first.focus(); });
    act(() => { fireEvent.keyDown(first, { key: 'Escape' }); });
    await settle();
    expect(dialog()).toBeNull();
  });

  it('Escape on "Clear search" closes it too', async () => {
    await openPalette();
    act(() => { fireEvent.change(field(), { target: { value: 'zzzz-nothing-matches-this' } }); });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    act(() => { clear.focus(); });
    act(() => { fireEvent.keyDown(clear, { key: 'Escape' }); });
    await settle();
    expect(dialog()).toBeNull();
  });

  it('Tab to an item makes it the active one', async () => {
    await openPalette();
    const second = enabledItems()[1];
    act(() => { second.focus(); });
    expect(selectedItem()).toBe(second);
  });

  it('ArrowDown and ArrowUp move focus and the active item together', async () => {
    await openPalette();
    const items = enabledItems();
    act(() => { items[0].focus(); });
    act(() => { fireEvent.keyDown(items[0], { key: 'ArrowDown' }); });
    expect(document.activeElement).toBe(items[1]);
    expect(selectedItem()).toBe(items[1]);
    act(() => { fireEvent.keyDown(items[1], { key: 'ArrowDown' }); });
    expect(document.activeElement).toBe(items[2]);
    expect(selectedItem()).toBe(items[2]);
    act(() => { fireEvent.keyDown(items[2], { key: 'ArrowUp' }); });
    expect(document.activeElement).toBe(items[1]);
    expect(selectedItem()).toBe(items[1]);
    expect(dialog()).not.toBeNull();
  });

  it('they stop at the ends, as in the field', async () => {
    await openPalette();
    const items = enabledItems();
    act(() => { items[0].focus(); });
    act(() => { fireEvent.keyDown(items[0], { key: 'ArrowUp' }); });
    expect(document.activeElement).toBe(items[0]);
    const last = items.at(-1)!;
    act(() => { last.focus(); });
    act(() => { fireEvent.keyDown(last, { key: 'ArrowDown' }); });
    expect(document.activeElement).toBe(last);
  });

  it('a disabled item is passed over (it cannot take focus)', async () => {
    await openPalette();
    // "Run canvas" is disabled on an empty canvas, and it is the first item.
    const all = [...document.querySelectorAll<HTMLButtonElement>('.command-palette__item')];
    expect(all[0].disabled).toBe(true);
    const items = enabledItems();
    act(() => { items[1].focus(); });
    act(() => { fireEvent.keyDown(items[1], { key: 'ArrowUp' }); });
    expect(document.activeElement).toBe(items[0]);
    act(() => { fireEvent.keyDown(items[0], { key: 'ArrowUp' }); });
    expect(document.activeElement).toBe(items[0]);
    expect(selectedItem()).toBe(items[0]);
  });

  it('from the field the arrows still move the active item and keep focus there (unchanged)', async () => {
    await openPalette();
    const items = [...document.querySelectorAll<HTMLButtonElement>('.command-palette__item')];
    expect(selectedItem()).toBe(items[0]);
    act(() => { fireEvent.keyDown(field(), { key: 'ArrowDown' }); });
    expect(selectedItem()).toBe(items[1]);
    expect(field()).toHaveFocus();
    act(() => { fireEvent.keyDown(field(), { key: 'Escape' }); });
    await settle();
    expect(dialog()).toBeNull();
  });
});

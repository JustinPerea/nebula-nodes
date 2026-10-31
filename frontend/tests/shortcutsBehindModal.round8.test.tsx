import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

// Review 7, M-1, made structural: while any modal dialog is open (the paid
// placeholder confirm, a prompt, the keyboard shortcuts), the app-wide keys
// that act on the graph don't act behind it, wherever focus is: ⌘O doesn't
// open a file over the canvas, ⌘K doesn't open the palette (whose "Run graph"
// would run behind the dialog). ⌘S doesn't save either.

const mocks = vi.hoisted(() => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('../src/lib/graphFile', () => ({ saveToFile: mocks.saveToFile, loadFromFile: mocks.loadFromFile }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

import { GraphFileActions } from '../src/components/GraphFileActions';
import { CommandPalette } from '../src/components/CommandPalette';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialGraph = { ...useGraphStore.getState() };
const initialUI = { ...useUIStore.getState() };

function openModal() {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.className = 'placeholder-run';
  document.body.appendChild(dialog);
  return dialog;
}

beforeEach(() => {
  mocks.saveToFile.mockReset().mockResolvedValue(undefined);
  mocks.loadFromFile.mockReset().mockResolvedValue(null);
  useUIStore.setState({ ...initialUI, viewMode: 'canvas' }, true);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
});

describe('app-wide graph keys yield to an open dialog', () => {
  it('⌘O and ⌘S do nothing behind it (focus on the page)', async () => {
    render(<ReactFlowProvider><GraphFileActions /></ReactFlowProvider>);
    openModal();
    fireEvent.keyDown(document.body, { key: 'o', metaKey: true });
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.loadFromFile).not.toHaveBeenCalled();
    expect(mocks.saveToFile).not.toHaveBeenCalled();
  });

  it('⌘K does not open the palette behind it', () => {
    render(<ReactFlowProvider><CommandPalette /></ReactFlowProvider>);
    const dialog = openModal();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(screen.queryByRole('combobox')).toBeNull();
    dialog.remove();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('with no dialog open, ⌘O still opens a file', async () => {
    render(<ReactFlowProvider><GraphFileActions /></ReactFlowProvider>);
    fireEvent.keyDown(document.body, { key: 'o', metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.loadFromFile).toHaveBeenCalledOnce();
  });
});

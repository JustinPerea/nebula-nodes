/**
 * Error copy round 3f, alerts and confirms (GM - Design, "my call"):
 * "Every error alert becomes a canvas notice (non-blocking, dismissable),
 * using the words you listed. A native alert stops the whole canvas over
 * something that needs no answer." The size and "saved without" alerts become
 * notices with GM's words. (The delete confirm this round kept is gone since
 * undo puts back everything a delete removed: tests/undoRestoresDeletes.test.tsx.)
 *
 * The notice is the canvas's own (CanvasUndoNotice, the graph store's
 * undoNotice): an error reads as role="alert", its Dismiss is a button, and
 * screens other than the canvas show the same notice (StudioNotice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';
import { StudioNotice } from '../src/components/canvas/StudioNotice';
import { graphSizeLine, skippedFilesLine } from '../src/lib/graphFile';

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };
let alertSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
});

describe('a canvas notice for an error', () => {
  it('is announced as an alert and dismissed with a button', () => {
    useGraphStore.getState().notify("Couldn't save the graph. Try again, or reload if it keeps happening.");
    render(<CanvasUndoNotice />);
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent("Couldn't save the graph. Try again, or reload if it keeps happening.");
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.focus();
    expect(document.activeElement).toBe(dismiss);
    fireEvent.click(dismiss);
    expect(useGraphStore.getState().undoNotice).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a note that isn\'t an error stays a status', () => {
    useGraphStore.getState().notify('Imported. One note.', 'info');
    render(<CanvasUndoNotice />);
    expect(screen.getByRole('status')).toHaveTextContent('Imported. One note.');
  });

  it('shows on a studio screen too, without an agent edit\'s Undo', () => {
    useGraphStore.getState().notify("Couldn't add Veo 3.1. Reconnect, then add it again.");
    render(<StudioNotice />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't add Veo 3.1.");
  });
});

describe('GM\'s size and "saved without" lines', () => {
  it('names the graph\'s size and what Nebula opens', () => {
    expect(graphSizeLine(300 * 1024 * 1024, 250 * 1024 * 1024)).toBe('This graph is 300.0 MB. Nebula opens graphs up to 250 MB.');
  });

  it('says how many files a saved graph left out, singular and plural', () => {
    expect(skippedFilesLine(1)).toBe('Graph saved without 1 of its files. It may be missing when the graph is opened somewhere else.');
    expect(skippedFilesLine(3)).toBe('Graph saved without 3 of its files. They may be missing when the graph is opened somewhere else.');
  });
});

// The delete confirm round 3f kept is gone: undo now puts back everything a
// delete removed, and every delete path says "Deleted the node." with Undo
// (GM, 2026-10-23; tests/undoRestoresDeletes.test.tsx).

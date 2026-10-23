/**
 * Error copy round 3f, alerts and confirms (GM - Design, "my call"):
 * "Every error alert becomes a canvas notice (non-blocking, dismissable),
 * using the words you listed. A native alert stops the whole canvas over
 * something that needs no answer." The size and "saved without" alerts become
 * notices with GM's words, and the delete confirm keeps GM's plural ("Delete
 * {n} nodes?" / "Delete this node?") on every path that deletes, since undo
 * doesn't put back everything a delete removes (the notes say what it misses).
 *
 * The notice is the canvas's own (CanvasUndoNotice, the graph store's
 * undoNotice): an error reads as role="alert", its Dismiss is a button, and
 * screens other than the canvas show the same notice (StudioNotice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { CanvasUndoNotice } from '../src/components/canvas/CanvasUndoNotice';
import { StudioNotice } from '../src/components/canvas/StudioNotice';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ContextMenu } from '../src/components/ContextMenu';
import { deleteConfirmLine } from '../src/lib/deleteConfirm';
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

function node(id: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'hello' }, outputs: {}, state: 'idle' } };
}

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

describe('the delete confirm', () => {
  it('gets the plural right', () => {
    expect(deleteConfirmLine(1)).toBe('Delete this node?');
    expect(deleteConfirmLine(3)).toBe('Delete 3 nodes?');
  });

  it('the selection toolbar asks it', () => {
    useGraphStore.setState({ nodes: [node('n1', true), node('n2', true)], edges: [], isExecuting: false });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Delete selected nodes'));
    expect(confirm).toHaveBeenCalledWith('Delete 2 nodes?');
    expect(useGraphStore.getState().nodes).toHaveLength(2);
  });

  it('the context menu asks it', () => {
    useGraphStore.setState({ nodes: [node('n1')], edges: [], isExecuting: false });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n1', null);
    render(<ContextMenu />);
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    expect(confirm).toHaveBeenCalledWith('Delete this node?');
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('the Delete key asks it, after the World Labs refusal', () => {
    useGraphStore.setState({ nodes: [node('n1'), node('n2')], edges: [], isExecuting: false });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(useGraphStore.getState().allowCanvasDelete(['n1', 'n2'], { confirm: true })).toBe(false);
    expect(confirm).toHaveBeenCalledWith('Delete 2 nodes?');
  });
});

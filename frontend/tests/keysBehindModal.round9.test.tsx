import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 8, L-d: every document- or window-wide key listener yields while a
// modal dialog is open, wherever focus is (the page included), through one
// shared guard (lib/canvasShortcutScope.ts keyBlockedByModal). A dialog's or
// popup's own keys yield only to a modal dialog on top of it.

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: () => () => {}, disconnect: vi.fn() } }));
vi.mock('../src/components/editor/EditorBreadcrumb', () => ({ EditorBreadcrumb: () => null }));
vi.mock('../src/components/editor/TimelineRuler', () => ({ TimelineRuler: () => <div>Ruler</div> }));
vi.mock('../src/components/editor/TimelineTrack', () => ({ TimelineTrack: () => <div>Track</div> }));
vi.mock('../src/components/editor/TimelinePlayhead', () => ({ TimelinePlayhead: () => null }));

import { keyBlockedByModal } from '../src/lib/canvasShortcutScope';
import { isStudioShortcutTarget } from '../src/components/moodboard-studio/studioKeys';
import { useRemotionKeyboard } from '../src/components/video-editor/useRemotionKeyboard';
import { WorkspaceRail } from '../src/components/WorkspaceRail';
import { ContextMenu } from '../src/components/ContextMenu';
import { EditorView } from '../src/components/editor/EditorView';
import { VideoPreview } from '../src/components/editor/VideoPreview';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

/** The paid placeholder confirm, as it is on the page: an alertdialog marked modal, with its Cancel. */
function openModal(role = 'alertdialog') {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', role);
  dialog.setAttribute('aria-modal', 'true');
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  dialog.appendChild(cancel);
  document.body.appendChild(dialog);
  return { dialog, cancel };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe('the shared guard', () => {
  it('no dialog: nothing yields', () => {
    expect(keyBlockedByModal()).toBe(false);
  });
  it('any open modal dialog blocks the page-wide keys (no owner)', () => {
    openModal();
    expect(keyBlockedByModal()).toBe(true);
  });
  it("a dialog's own keys act while it is the one on top, and yield to one opened over it", () => {
    const below = openModal('dialog').dialog;
    expect(keyBlockedByModal(below)).toBe(false);
    openModal();
    expect(keyBlockedByModal(below)).toBe(true);
  });
  it("an owner that holds its own modal dialog (the tour's overlay around its card) keeps its keys until one opens over it", () => {
    const overlay = document.createElement('div');
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    expect(keyBlockedByModal(overlay)).toBe(false);
    openModal();
    expect(keyBlockedByModal(overlay)).toBe(true);
  });
  it('a popup that is no modal dialog yields to any open one', () => {
    const popup = document.createElement('div');
    document.body.appendChild(popup);
    openModal();
    expect(keyBlockedByModal(popup)).toBe(true);
  });
});

describe('the rail: Escape never closes the drawer behind an open alertdialog', () => {
  it('focus on the page, the placeholder dialog open: the drawer stays', () => {
    useUIStore.getState().setLeftDock('library');
    render(<WorkspaceRail />);
    openModal();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUIStore.getState().leftDock).toBe('library');
  });
});

describe('Moodboard Studio keys', () => {
  it.each(['undo', 'redo', 'save', 'delete'] as const)('%s on the page yields to an open dialog', (action) => {
    expect(isStudioShortcutTarget(document.body, action)).toBe(true);
    openModal();
    expect(isStudioShortcutTarget(document.body, action)).toBe(false);
  });
  it('the Board view\'s fit (Shift+1) too', () => {
    openModal();
    expect(isStudioShortcutTarget(document.body)).toBe(false);
  });
});

describe('the Remotion editor keys', () => {
  function Harness() {
    useRemotionKeyboard({ remotionNodeId: 'r1', currentFrame: 12 });
    return null;
  }
  beforeEach(() => {
    useUIStore.setState({ selectedTrackItemId: 't1' } as never);
  });

  it('control: Delete on the page deletes the selected item', () => {
    const remove = vi.fn();
    useGraphStore.setState({ deleteTrackItem: remove } as never);
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(remove).toHaveBeenCalledOnce();
  });

  it('Delete, Backspace and Cmd+D do nothing behind a dialog, on the page or on its button', () => {
    const remove = vi.fn();
    const duplicate = vi.fn();
    useGraphStore.setState({ deleteTrackItem: remove, duplicateTrackItemAtPlayhead: duplicate } as never);
    render(<Harness />);
    const { cancel } = openModal();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(cancel, { key: 'Backspace' });
    fireEvent.keyDown(document.body, { key: 'd', metaKey: true });
    fireEvent.keyDown(cancel, { key: 'd', ctrlKey: true });
    expect(remove).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    expect(useUIStore.getState().selectedTrackItemId).toBe('t1');
  });
});

describe('the trim editor keys (EditorView)', () => {
  const source: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Clip', definitionId: 'video-upload', params: {}, state: 'complete',
      outputs: { video: { type: 'Video', value: '/api/outputs/clip.mp4' } } } };
  const edit: Node<NodeData> = { id: 'n2', type: 'model-node', position: { x: 300, y: 0 },
    data: { label: 'Edit', definitionId: 'video-edit', params: {
      clips: [{ id: 'c1', start: 0, duration: 10, sourceIn: 0, sourceOut: 10, volume: 1, mute: false }],
      sourceDuration: 10, sourceFps: 30 }, state: 'idle', outputs: {} } };
  const wire: Edge = { id: 'e1', source: 'n1', sourceHandle: 'video', target: 'n2', targetHandle: 'video_in' };
  const clip = () => ((useGraphStore.getState().nodes.find((n) => n.id === 'n2')?.data.params.clips as Array<Record<string, unknown>>) ?? []);

  beforeEach(() => {
    useGraphStore.setState({ nodes: [source, edit], edges: [wire] });
    useUIStore.setState({ viewMode: 'editor', editorTargetNodeId: 'n2', selectedClipId: 'c1' } as never);
  });

  it('M, I, O, B, Cmd+K, Delete and Escape do nothing behind a dialog', () => {
    render(<EditorView />);
    const { cancel } = openModal();
    for (const key of ['m', 'i', 'o', 'b']) fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.keyDown(cancel, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(clip()).toEqual([{ id: 'c1', start: 0, duration: 10, sourceIn: 0, sourceOut: 10, volume: 1, mute: false }]);
    expect(useUIStore.getState().selectedClipId).toBe('c1');
    expect(useUIStore.getState().viewMode).toBe('editor');
  });

  it('control: M mutes the selected clip with no dialog', () => {
    render(<EditorView />);
    fireEvent.keyDown(document.body, { key: 'm' });
    expect(clip()[0].mute).toBe(true);
  });
});

describe("the trim editor's Space", () => {
  it('does not play behind a dialog', () => {
    const togglePlaying = vi.fn();
    useUIStore.setState({ isPlaying: false, renderedPreviewUrl: null, togglePlaying } as never);
    const edit = { id: 'e', position: { x: 0, y: 0 }, data: { label: 'Edit', definitionId: 'video-edit', state: 'idle',
      outputs: {}, params: { clips: [] } } } as Node<NodeData>;
    render(<VideoPreview sourceUrl="/synthetic.mp4" editNode={edit} />);
    openModal();
    fireEvent.keyDown(document.body, { key: ' ' });
    expect(togglePlaying).not.toHaveBeenCalled();
  });
});

describe('the context menu', () => {
  it('Escape on the page belongs to the dialog over it, not to the menu behind', () => {
    vi.useFakeTimers();
    try {
      useUIStore.getState().showContextMenu({ x: 20, y: 30 }, 'n4', null);
      render(<ContextMenu />);
      act(() => { vi.runAllTimers(); });
      openModal();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(useUIStore.getState().contextMenu.visible).toBe(true);
    } finally {
      vi.useRealTimers();
      useUIStore.getState().hideContextMenu();
    }
  });
});

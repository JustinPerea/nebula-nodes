import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemotionEditorToolbar } from '../../src/components/video-editor/RemotionEditorToolbar';

const addMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../src/store/graphStore', () => ({
  useGraphStore: (selector: (s: {
    addTrackItemWithCanvasMirror: typeof addMock;
    deleteTrackItem: typeof deleteMock;
  }) => unknown) =>
    selector({
      addTrackItemWithCanvasMirror: addMock,
      deleteTrackItem: deleteMock,
    }),
}));

let mockSelectedId: string | null = null;
vi.mock('../../src/store/uiStore', () => ({
  useUIStore: (selector: (s: { selectedTrackItemId: string | null }) => unknown) =>
    selector({ selectedTrackItemId: mockSelectedId }),
}));

describe('RemotionEditorToolbar', () => {
  beforeEach(() => {
    addMock.mockReset();
    deleteMock.mockReset();
    mockSelectedId = null;
  });

  it('renders four add buttons', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /\+ text/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ svg/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ image/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ video/i })).toBeInTheDocument();
  });

  it('+ Text dispatches addTrackItemWithCanvasMirror with TextNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ text/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'TextNode' }));
  });

  it('+ Image dispatches with ImageAssetNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ image/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'ImageAssetNode' }));
  });

  it('Delete button is disabled when nothing is selected', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).toBeDisabled();
  });

  it('Delete button dispatches deleteTrackItem when a TrackItem is selected', () => {
    mockSelectedId = 'track-1';
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(deleteMock).toHaveBeenCalledWith('r1', 'track-1');
  });
});

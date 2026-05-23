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
let mockIsRecording = false;
const setSelectedMock = vi.fn();
const toggleRecordingMock = vi.fn();
vi.mock('../../src/store/uiStore', () => ({
  useUIStore: (selector: (s: {
    selectedTrackItemId: string | null;
    setSelectedTrackItem: typeof setSelectedMock;
    isKeyframeRecording: boolean;
    toggleKeyframeRecording: typeof toggleRecordingMock;
  }) => unknown) =>
    selector({
      selectedTrackItemId: mockSelectedId,
      setSelectedTrackItem: setSelectedMock,
      isKeyframeRecording: mockIsRecording,
      toggleKeyframeRecording: toggleRecordingMock,
    }),
}));

describe('RemotionEditorToolbar', () => {
  beforeEach(() => {
    addMock.mockReset();
    deleteMock.mockReset();
    setSelectedMock.mockReset();
    toggleRecordingMock.mockReset();
    mockSelectedId = null;
    mockIsRecording = false;
  });

  it('renders six add buttons', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    expect(screen.getByRole('button', { name: /\+ text/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ svg/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ image/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ video/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ iso block/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\+ lottie/i })).toBeInTheDocument();
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

  it('+ Iso Block dispatches addTrackItemWithCanvasMirror with IsometricBlock', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ iso block/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'IsometricBlock' }));
  });

  it('+ Lottie dispatches addTrackItemWithCanvasMirror with LottieNode', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: /\+ lottie/i }));
    expect(addMock).toHaveBeenCalledWith('r1', expect.objectContaining({ componentType: 'LottieNode' }));
  });

  it('Delete button is disabled when nothing is selected', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).toBeDisabled();
  });

  it('Delete button dispatches deleteTrackItem AND clears selection when a TrackItem is selected', () => {
    mockSelectedId = 'track-1';
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const del = screen.getByRole('button', { name: /delete/i });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(deleteMock).toHaveBeenCalledWith('r1', 'track-1');
    expect(setSelectedMock).toHaveBeenCalledWith(null);
  });

  it('REC button toggles keyframe recording', () => {
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const rec = screen.getByRole('button', { name: /rec/i });
    expect(rec).toHaveClass('remotion-editor-toolbar__record');
    expect(rec).not.toHaveClass('remotion-editor-toolbar__record--active');
    fireEvent.click(rec);
    expect(toggleRecordingMock).toHaveBeenCalledTimes(1);
  });

  it('REC button reflects active recording state', () => {
    mockIsRecording = true;
    render(<RemotionEditorToolbar remotionNodeId="r1" />);
    const rec = screen.getByRole('button', { name: /rec/i });
    expect(rec).toHaveClass('remotion-editor-toolbar__record--active');
    expect(rec).toHaveAttribute('title', 'Recording keyframes - click to stop');
  });
});

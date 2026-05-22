import { useEffect } from 'react';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';

interface UseRemotionKeyboardOptions {
  remotionNodeId: string;
  currentFrame: number;
}

export function useRemotionKeyboard({ remotionNodeId, currentFrame }: UseRemotionKeyboardOptions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      const selectedId = useUIStore.getState().selectedTrackItemId;

      // Delete / Backspace → delete selected TrackItem
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedId) return;
        e.preventDefault();
        useGraphStore.getState().deleteTrackItem(remotionNodeId, selectedId);
        useUIStore.getState().setSelectedTrackItem(null);
        return;
      }

      // Cmd+D / Ctrl+D → duplicate at playhead
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        if (!selectedId) return;
        e.preventDefault();
        useGraphStore.getState().duplicateTrackItemAtPlayhead(remotionNodeId, selectedId, currentFrame);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [remotionNodeId, currentFrame]);
}

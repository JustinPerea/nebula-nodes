import { useEffect } from 'react';
import { wsClient } from '../lib/wsClient';
import { useBoardReadingStore } from '../store/boardReadingStore';
import { useBoardCanvasStore } from '../store/boardCanvasStore';
import { boardReadingSweep } from '../lib/boardReadingCursor';

/** How long a burst of board saves waits before the reading is read again. */
const RELOAD_MS = 400;

/** Keep this board's reading current while the Studio has it open: read it
 *  now, take each run's word from the socket, and read it again after a save
 *  (the image set may have changed) or a reconnect. */
export function useBoardReadingSync(boardId: string | null): void {
  useEffect(() => {
    if (!boardId) return;
    const store = useBoardReadingStore.getState();
    void store.load(boardId);
    let timer: number | null = null;
    const reload = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void useBoardReadingStore.getState().load(boardId); }, RELOAD_MS);
    };
    const unsubscribe = wsClient.subscribe((event) => {
      if (event.type === 'boardReadingRun') {
        if (event.boardId !== boardId) return;
        useBoardReadingStore.getState().takeRun(boardId, event.run);
        const { by } = event.run;
        // An agent's read: its cursor's look sweep (a typed hook until PR #211's cursor takes it).
        if (by.kind === 'agent' && by.id) {
          const board = useBoardCanvasStore.getState().studioBoard;
          boardReadingSweep({ boardId, agentId: by.id, agentName: by.name ?? 'An agent',
            imageIds: board?.boardId === boardId ? board.imageIds : [], running: event.run.status === 'running' });
        }
      } else if (event.type === 'storedAssetChanged') {
        if (event.kind === 'moodboard' && event.id === boardId && !event.deleted) reload();
      } else if (event.type === 'socketReconnected') {
        reload();
      }
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [boardId]);
}

import { useBoardCanvasStore } from '../../store/boardCanvasStore';

/** The saved board the Studio has open (the id an agent cursor's anchors carry), or undefined for a draft. */
export function useStudioBoardId(): string | undefined {
  return useBoardCanvasStore((s) => s.studioBoard?.boardId);
}

import { create } from 'zustand';

/**
 * The saved Character the Character Studio has open, and how many reference
 * views it holds, published by the Studio so the agent cursor can tell a
 * view that was removed ("gone": the cursor holds its spot) from a panel
 * that simply isn't open. The Character counterpart of
 * boardCanvasStore.studioBoard. A draft publishes nothing. Lives in the
 * lazy chunks (the Studio and the cursor layer), not the entry.
 */
export interface StudioCharacter {
  characterId: string;
  viewCount: number;
}

interface StudioCharacterState {
  studioCharacter: StudioCharacter | null;
  setStudioCharacter: (character: StudioCharacter | null) => void;
}

export const useStudioCharacterStore = create<StudioCharacterState>((set, get) => ({
  studioCharacter: null,
  setStudioCharacter: (character) => {
    const was = get().studioCharacter;
    if (was?.characterId === character?.characterId && was?.viewCount === character?.viewCount) return;
    set({ studioCharacter: character });
  },
}));

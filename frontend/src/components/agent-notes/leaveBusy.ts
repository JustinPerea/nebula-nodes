import { createContext } from 'react';

/**
 * The corner's control waiting on the Commons' save in progress before it
 * leaves (commons-leave): it reads "Saving…" and is busy (BusyButton).
 */
export const LeaveBusyContext = createContext<HTMLElement | null>(null);

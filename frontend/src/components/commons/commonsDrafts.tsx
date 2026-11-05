import { useState, type ReactNode } from 'react';
import { CommonsDrafts } from './commonsDraftsContext';

/** The Commons' drafts (components/commons/commonsDraftsContext): one map for the view's life. */
export function CommonsDraftsProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => new Map<string, unknown>());
  return <CommonsDrafts.Provider value={drafts}>{children}</CommonsDrafts.Provider>;
}

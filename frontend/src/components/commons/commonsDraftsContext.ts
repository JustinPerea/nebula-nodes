import { createContext, useCallback, useContext, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * PR #204 round 11 (review 9 MEDIUM-3, GM r19 item 2): what the person has typed or opened in the
 * Commons (the search and filters, the URL draft, the open Add menu, the section, the open
 * reference, a membership note, a keyword) outlives the view's remount on a demote and on the
 * promote (CommonsView keys its body so every pane reads again). The drafts live above that key;
 * the loaded data doesn't. Outside the Commons view (a test rendering one pane) it is plain state.
 */
export const CommonsDrafts = createContext<Map<string, unknown> | null>(null);

export function useCommonsDraft<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const drafts = useContext(CommonsDrafts);
  const [value, setValue] = useState<T>(() => (drafts?.has(key) ? drafts.get(key) as T : initial));
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue((current) => {
      const value = typeof next === 'function' ? (next as (current: T) => T)(current) : next;
      drafts?.set(key, value);
      return value;
    });
  }, [drafts, key]);
  return [value, set];
}

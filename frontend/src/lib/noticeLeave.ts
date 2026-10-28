import { useCallback, useLayoutEffect, useRef, useState, type AnimationEvent, type ReactNode } from 'react';

/**
 * The one place a notice-region item leaves (fix round 7 of PR #200, GM r11
 * answer 2: "The leave mirrors the enter for EVERY surface, toasts included").
 *
 * An item that goes stays mounted, marked `data-leaving` with its kind, until
 * its own leave animation ends; noticeRegion.css gives each kind its leave
 * (a surface scales out on the exit spring, a row collapses, reduced motion
 * fades). It is `inert` from the first frame of its leave, so focus is never
 * left on it: whatever moves focus does so at the start, not the end. A leave
 * animation is any animation whose name ends in `-out`; an item with none
 * running (no region CSS, a test without layout) goes at once, as before.
 */
export type LeaveKind = 'surface' | 'row';

const isLeave = (name: string | undefined) => Boolean(name && /-out$/.test(name));

/** Whether a leave animation is running on the element itself. */
export function runsLeave(element: Element | null): boolean {
  if (!element || typeof element.getAnimations !== 'function') return false;
  return element.getAnimations().some((animation) => isLeave((animation as CSSAnimation).animationName));
}

export interface LeaveProps {
  ref: (element: HTMLElement | null) => void;
  'data-leaving'?: LeaveKind;
  inert?: boolean;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
}

/**
 * One item: `shown` is the value while it is there and, once it goes, the
 * last value until its leave ends. Spread `props` on the item's own element.
 * A new value while it leaves brings it back at once.
 */
export function useLeave<T>(value: T | null | undefined | false, kind: LeaveKind = 'surface'): {
  shown: T | null; leaving: boolean; props: LeaveProps;
} {
  const present = value === null || value === undefined || value === false ? null : value;
  const [last, setLast] = useState<T | null>(present);
  const [leaving, setLeaving] = useState(false);
  if (present !== null && (present !== last || leaving)) {
    setLast(present);
    setLeaving(false);
  } else if (present === null && last !== null && !leaving) {
    setLeaving(true);
  }
  const element = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => { element.current = node; }, []);
  const done = useCallback(() => { setLast(null); setLeaving(false); }, []);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM read: whether a leave animation runs is known only once the mark is drawn; none runs, it goes before paint
    if (leaving && !runsLeave(element.current)) done();
  }, [leaving, done]);
  const shown = present ?? (leaving ? last : null);
  return {
    shown,
    leaving: present === null && shown !== null,
    props: {
      ref,
      'data-leaving': present === null && shown !== null ? kind : undefined,
      inert: present === null && shown !== null ? true : undefined,
      onAnimationEnd: (event) => {
        if (event.target === event.currentTarget && isLeave(event.animationName) && present === null) done();
      },
    },
  };
}

/**
 * For an item its parent mounts only while it is there (a toast drawn as
 * `{toast && <Toast />}`): `<NoticeLeave value={toast}>{(toast, leave) =>
 * <Toast … leave={leave} />}</NoticeLeave>` keeps it through its leave.
 */
export function NoticeLeave<T>({ value, kind = 'surface', children }: {
  value: T | null | undefined | false; kind?: LeaveKind; children: (shown: T, leave: LeaveProps) => ReactNode;
}): ReactNode {
  const { shown, props } = useLeave(value, kind);
  return shown === null ? null : children(shown, props);
}

type Entry<T> = { key: string; item: T; leaving: boolean };

/** Where each item that went sits: it keeps its place among the rest. */
function merge<T>(before: Entry<T>[], items: readonly T[], keyOf: (item: T) => string): Entry<T>[] {
  const at = new Map(items.map((item, index) => [keyOf(item), index]));
  const out: Entry<T>[] = [];
  let next = 0;
  for (const entry of before) {
    const index = at.get(entry.key);
    if (index === undefined) {
      out.push({ ...entry, leaving: true });
      continue;
    }
    while (next <= index) {
      const item = items[next];
      out.push({ key: keyOf(item), item, leaving: false });
      next += 1;
    }
  }
  for (; next < items.length; next += 1) out.push({ key: keyOf(items[next]), item: items[next], leaving: false });
  return out;
}

/**
 * A list of rows: `rows` holds each row still there and each that went,
 * in place, until its own leave ends. `hold` keeps the rows that went as
 * they are, unmarked (their surface is leaving with them in it).
 * `onRowLeft` runs after a row's leave ends (the open kept list re-sizes
 * there, not at its start).
 */
export function useLeavingRows<T>(items: readonly T[], keyOf: (item: T) => string, { hold = false, onRowLeft }: {
  hold?: boolean; onRowLeft?: () => void;
} = {}): {
  rows: Array<{ key: string; item: T; leaving: boolean }>;
  rowProps: (key: string, leaving: boolean) => LeaveProps;
} {
  const [state, setState] = useState(() => ({ items, entries: items.map((item) => ({ key: keyOf(item), item, leaving: false })) }));
  let entries = state.entries;
  // A list made afresh each render (`kept.slice(-2)`) is the same list when
  // its items are.
  if (state.items !== items && (state.items.length !== items.length || state.items.some((item, index) => item !== items[index]))) {
    entries = merge(state.entries, items, keyOf);
    setState({ items, entries });
  }
  const elements = useRef(new Map<string, HTMLElement>());
  const finish = useCallback((key: string) => {
    setState((now) => {
      if (!now.entries.some((entry) => entry.key === key && entry.leaving)) return now;
      return { ...now, entries: now.entries.filter((entry) => !(entry.key === key && entry.leaving)) };
    });
    onRowLeft?.();
  }, [onRowLeft]);
  const pending = entries.filter((entry) => entry.leaving).map((entry) => entry.key).join('\n');
  useLayoutEffect(() => {
    if (hold || !pending) return;
    for (const key of pending.split('\n')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM read: as above, a row with no leave running goes before paint
      if (!runsLeave(elements.current.get(key) ?? null)) finish(key);
    }
  }, [pending, hold, finish]);
  return {
    rows: entries,
    rowProps: (key, leaving) => ({
      ref: (node) => {
        if (node) elements.current.set(key, node);
        else if (elements.current.get(key)?.isConnected === false) elements.current.delete(key);
      },
      'data-leaving': leaving && !hold ? 'row' : undefined,
      inert: leaving ? true : undefined,
      onAnimationEnd: (event) => {
        if (leaving && event.target === event.currentTarget && isLeave(event.animationName)) finish(key);
      },
    }),
  };
}

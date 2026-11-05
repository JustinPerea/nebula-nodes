/** This tab's id. The canvas sends it on every write (`X-Nebula-Tab`, see
 * apiFetch), and the backend echoes it in the graphSync that write causes
 * (`edit.tab`). That is how a tab tells the echo of its own edit from an edit
 * made somewhere else (an agent, another window), which becomes an undo step.
 *
 * Kept across a reload of the same tab (review 19 item 5 on PR #199): Nebula
 * lets only the window that saved a tab-local node say its delete, so a
 * reload must not make the tab a stranger to its own nodes. The id lives in
 * sessionStorage, and a page gives it up as it goes (`pagehide` marks it
 * free). The next page in the same tab takes it only when it is marked
 * free, and clears the mark. A duplicated browser tab copies sessionStorage
 * while the first tab is still open, so the id isn't marked free and the
 * copy makes its own. Without storage (a private mode that refuses it), the
 * id is fresh per page load, as before.
 *
 * The free mark alone lets two live tabs share an id when a tab is copied
 * while it shows another page and both then come back (review 20 LOW-4 on
 * PR #199). So a live page also holds its id with a Web Lock named after it
 * (`nebula-tab:<id>`), and lets go of it at `pagehide` (review 21 LOW-1): a
 * reload's new page finds it free at once and keeps the id. The claim never
 * waits (`ifAvailable`): a page whose id's lock another live page holds
 * makes a new id at once, on load and when it comes back from the
 * back/forward cache. Until the claim settles the id is unconfirmed, and
 * nothing that names it is sent (apiFetch and the socket's hello await
 * `tabIdReady`), so the id a page ever sends never changes while it lives,
 * except once for a page back from the back/forward cache whose id a copy
 * took meanwhile: it moves before it sends anything (`onTabIdRekeyed`).
 * Where Web Locks don't exist, the free mark is all there is, as before. */
const ID_KEY = 'nebula:tabId';
const FREE_KEY = 'nebula:tabIdFree';

function makeTabId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `tab-${random}`;
}

function session(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The id this page uses: the tab's own when the page before it in this tab
 * gave it up, else a new one (stored for the next reload). */
export function takeTabId(storage: Storage | null = session()): string {
  try {
    const stored = storage?.getItem(ID_KEY) ?? null;
    const free = storage?.getItem(FREE_KEY) ?? null;
    storage?.removeItem(FREE_KEY);
    if (stored && free === stored) return stored;
    const id = makeTabId();
    storage?.setItem(ID_KEY, id);
    return id;
  } catch {
    return makeTabId();
  }
}

export type LockManagerLike = {
  request: (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => Promise<unknown>;
};

function lockManager(): LockManagerLike | null {
  try {
    const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/** One page's tab id. The module makes one for this page (TAB_ID); tests make
 * several over one fake lock manager to play two pages of a copied tab. */
export type TabIdentity = {
  /** The id this page goes by now. */
  readonly id: string;
  /** Whether this page holds its id's lock (or has nothing to hold it with). */
  readonly confirmed: boolean;
  /** Resolves with the id once it is confirmed. */
  ready: () => Promise<string>;
  /** The page goes (pagehide): it lets go of its lock and marks its id free
   * for the next page in this tab. */
  pageHide: () => void;
  /** The page is shown again (pageshow). Back from the back/forward cache, it
   * takes its id back, or a new one when another live page holds it now. */
  pageShow: (persisted: boolean) => Promise<string>;
  /** `listener(next, previous)` runs when this page moves to a new id, before
   * the new id is confirmed (so before anything sends it). */
  onRekey: (listener: (next: string, previous: string) => void) => () => void;
  /** For tests: the id as a page that holds it would have it. */
  setForTests: (id: string) => void;
};

export function createTabIdentity(storage: Storage | null, locks: LockManagerLike | null): TabIdentity {
  let id = takeTabId(storage);
  let confirmed = false;
  // Lets go of the lock this page holds (resolves the held callback's promise).
  let release: (() => void) | null = null;
  // Bumped by each claim and by pagehide: a claim that settles after a newer
  // one began, or after the page went, changes nothing (its lock goes at once).
  let generation = 0;
  let settle: ((value: string) => void) | null = null;
  let readyPromise: Promise<string> = new Promise((resolve) => { settle = resolve; });
  const listeners = new Set<(next: string, previous: string) => void>();

  const unconfirm = () => {
    confirmed = false;
    if (!settle) readyPromise = new Promise((resolve) => { settle = resolve; });
  };
  const confirm = () => {
    confirmed = true;
    const done = settle;
    settle = null;
    done?.(id);
  };

  /** True once this page holds `name`'s lock (or can't take locks at all),
   * false when another live page holds it. */
  const hold = (name: string, claim: number): Promise<boolean> => {
    if (!locks) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let answered = false;
      const answer = (value: boolean) => {
        if (answered) return;
        answered = true;
        resolve(value);
      };
      try {
        locks.request(`nebula-tab:${name}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            answer(false);
            return undefined;
          }
          // The page went, or claimed again, while this request was on its way.
          if (claim !== generation) {
            answer(true);
            return undefined;
          }
          answer(true);
          // Held until the page goes (pageHide).
          return new Promise<void>((done) => { release = done; });
        }).catch(() => answer(true));
      } catch {
        // Locks that throw are no locks: the free mark alone, as without them.
        answer(true);
      }
    });
  };

  const claim = async (): Promise<string> => {
    const mine = ++generation;
    unconfirm();
    if (await hold(id, mine)) {
      if (mine === generation) confirm();
      return id;
    }
    if (mine !== generation) return id;
    const previous = id;
    id = makeTabId();
    try { storage?.setItem(ID_KEY, id); } catch { /* No storage: fresh per load, as before. */ }
    for (const listener of [...listeners]) {
      try { listener(id, previous); } catch { /* One listener's failure doesn't stop the move. */ }
    }
    // A new id no other page has: its lock comes at once.
    await hold(id, mine);
    if (mine === generation) confirm();
    return id;
  };

  if (locks) void claim();
  else confirm();

  return {
    get id() { return id; },
    get confirmed() { return confirmed; },
    ready: () => readyPromise,
    pageHide: () => {
      try { storage?.setItem(FREE_KEY, id); } catch { /* No storage: the next page makes its own. */ }
      // Without locks there is nothing to let go of or claim again.
      if (!locks) return;
      generation += 1;
      unconfirm();
      const letGo = release;
      release = null;
      letGo?.();
    },
    pageShow: (persisted: boolean) => {
      if (!persisted) return readyPromise;
      try { storage?.removeItem(FREE_KEY); } catch { /* Nothing to take back. */ }
      return locks ? claim() : readyPromise;
    },
    onRekey: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setForTests: (next: string) => {
      generation += 1;
      id = next;
      confirm();
    },
  };
}

const page = createTabIdentity(session(), lockManager());

/** This page's id. `let`: a page back from the back/forward cache whose id
 * another live page took moves to a new one before it sends anything. Every
 * reader reads it when it sends or compares, so they all see the move. */
export let TAB_ID = page.id;
export const TAB_HEADER = 'X-Nebula-Tab';
page.onRekey((next) => { TAB_ID = next; });

/** Whether this page holds its id, so it may send it. */
export function tabIdConfirmed(): boolean {
  return page.confirmed;
}

/** Resolves with this page's id once it holds it. apiFetch and the socket's
 * hello await it before they send anything that names the tab. */
export function tabIdReady(): Promise<string> {
  return page.ready();
}

/** Runs `listener(next, previous)` when this page moves to a new id (before
 * the new id is confirmed). */
export function onTabIdRekeyed(listener: (next: string, previous: string) => void): () => void {
  return page.onRekey(listener);
}

/** For tests: the page's id as a page that holds it would have it. */
export function setTabIdForTests(id: string): void {
  page.setForTests(id);
  TAB_ID = id;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => page.pageHide());
  window.addEventListener('pageshow', (event) => {
    void page.pageShow(Boolean((event as PageTransitionEvent).persisted));
  });
}

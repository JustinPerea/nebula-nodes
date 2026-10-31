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
 * copy makes its own: two live tabs never share an id. Back from the
 * back/forward cache, the page takes its id back. Without storage (a
 * private mode that refuses it), the id is fresh per page load, as before.
 *
 * The free mark alone lets two live tabs share an id when a tab is copied
 * while it shows another page and both then come back (review 20 LOW-4 on
 * PR #199). So the page also claims its id for as long as it lives, with a
 * Web Lock named after it (`nebula-tab:<id>`): a page that finds the lock
 * held by another live page, after a short wait for a reloading page to let
 * go, makes a new id. Where Web Locks don't exist, the free mark is all
 * there is, as before. */
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

/** How long a page waits for its id's lock before it decides another live
 * page holds it. Only a page that took its id by the free mark waits at all
 * (a reload, or a page back in its tab): its old page lets go as it unloads,
 * which took over 1.5 s live under load, so the wait is generous. The
 * contrived copy that shares the mark moves to its own id at the end of it. */
export const TAB_LOCK_WAIT_MS = 10_000;

type LockManagerLike = {
  request: (name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
};

function lockManager(): LockManagerLike | null {
  try {
    const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/** Claims `id` for this page's life. Resolves true once the page holds its
 * lock, false when another live page holds it past `waitMs` (the lock is
 * then never taken), and true with no lock manager (nothing to claim with).
 * The lock is held until the page goes. */
export function claimTabId(id: string, locks: LockManagerLike | null = lockManager(),
  waitMs = TAB_LOCK_WAIT_MS): Promise<boolean> {
  if (!locks) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), waitMs) : null;
    locks.request(`nebula-tab:${id}`, abort ? { signal: abort.signal } : {}, () => {
      if (timer) clearTimeout(timer);
      resolve(true);
      // Held for as long as the page lives.
      return new Promise<never>(() => {});
    }).catch(() => {
      if (timer) clearTimeout(timer);
      resolve(false);
    });
  });
}

/** This page's id. `let`: when another live page already holds the id this
 * page took, the page moves to a new one (`claimTabId`). Every reader reads
 * it when it sends or compares, so they all see the move. */
export let TAB_ID = takeTabId();
export const TAB_HEADER = 'X-Nebula-Tab';

let claimed: string | null = null;

/** Claims this page's id; when another live page holds it, makes a new id
 * (stored for the next reload) and claims that. Returns the id the page ends
 * on. */
export async function claimOwnTabId(locks: LockManagerLike | null = lockManager(), waitMs = TAB_LOCK_WAIT_MS,
  storage: Storage | null = session()): Promise<string> {
  if (claimed === TAB_ID) return TAB_ID;
  const taking = TAB_ID;
  if (await claimTabId(taking, locks, waitMs)) {
    if (TAB_ID === taking) claimed = taking;
    return TAB_ID;
  }
  if (TAB_ID !== taking) return TAB_ID;
  const fresh = makeTabId();
  TAB_ID = fresh;
  try { storage?.setItem(ID_KEY, fresh); } catch { /* No storage: fresh per load, as before. */ }
  // A new id no other page has: its lock comes at once.
  if (await claimTabId(fresh, locks, waitMs) && TAB_ID === fresh) claimed = fresh;
  return TAB_ID;
}

/** For tests: the page's id as a fresh load would leave it. */
export function setTabIdForTests(id: string): void {
  TAB_ID = id;
  claimed = null;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  void claimOwnTabId();
  window.addEventListener('pagehide', () => {
    try { session()?.setItem(FREE_KEY, TAB_ID); } catch { /* No storage: the next page makes its own. */ }
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    try { session()?.removeItem(FREE_KEY); } catch { /* Nothing to take back. */ }
    // Back from the back/forward cache: an id this page already claimed
    // stays claimed (its lock goes only with the page), so this is a no-op
    // then, and a claim for one it never got to claim.
    void claimOwnTabId();
  });
}

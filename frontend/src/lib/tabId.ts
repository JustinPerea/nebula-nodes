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
 * private mode that refuses it), the id is fresh per page load, as before. */
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

export const TAB_ID = takeTabId();
export const TAB_HEADER = 'X-Nebula-Tab';

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    try { session()?.setItem(FREE_KEY, TAB_ID); } catch { /* No storage: the next page makes its own. */ }
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    try { session()?.removeItem(FREE_KEY); } catch { /* Nothing to take back. */ }
  });
}

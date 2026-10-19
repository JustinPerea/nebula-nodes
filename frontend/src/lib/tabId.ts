/** This tab's id. The canvas sends it on every write (`X-Nebula-Tab`, see
 * apiFetch), and the backend echoes it in the graphSync that write causes
 * (`edit.tab`). That is how a tab tells the echo of its own edit from an edit
 * made somewhere else (an agent, another window), which becomes an undo step.
 * Fresh per page load, never stored. */
function makeTabId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `tab-${random}`;
}

export const TAB_ID = makeTabId();
export const TAB_HEADER = 'X-Nebula-Tab';

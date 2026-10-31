/**
 * PR #204 round 11 (GM r18): where a person lock's line sits (components/PersonLock
 * PersonLockLine `place`). One rule: directly under the heading of what it covers. A group's
 * line under the group's heading, a whole tab's at the top of the tab, a form's or a single
 * control's right under the control it locks (a form's submit button).
 */
export type LockPlace = 'heading' | 'tab' | 'control';

export const LOCK_PLACE_ATTR = 'data-lock-place';

/** PR #204 round 11 (GM r19 1): the elements styles/disabled-buttons.css gives a person lock's one
 * disabled look. A locked control outside them would look live (lockPlacementProblems fails it). */
export const LOCK_LOOK_SELECTORS = [
  ":is(button, a, [role='button'], [role='menuitem'], [role='option'], summary)[data-person-lock]:not([data-held-pending])",
  ":is(select, input:not([type='checkbox']):not([type='radio']), textarea)[data-person-lock]:not([data-held-pending])",
  "input[type='checkbox'][data-person-lock]:not([data-held-pending])",
] as const;

const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const TAB_ROOT = '[role="tabpanel"], [data-lock-tab]';

function describes(control: Element, id: string): boolean {
  return (control.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(id);
}

/** Every lock line under `root` that breaks the rule, as "<line>: <what is wrong>". */
export function lockPlacementProblems(root: ParentNode = document): string[] {
  const problems: string[] = [];
  for (const line of root.querySelectorAll<HTMLElement>('.person-lock-line')) {
    const place = line.getAttribute(LOCK_PLACE_ATTR);
    const text = (line.textContent ?? '').trim();
    const controls = line.id ? [...document.querySelectorAll(`[aria-describedby]`)].filter((el) => describes(el, line.id)) : [];
    if (controls.length === 0) problems.push(`${text}: no control points at it (aria-describedby)`);
    const before = line.previousElementSibling;
    if (place === 'heading') {
      const heading = before && (before.matches(HEADING) ? before : before.querySelector(HEADING));
      if (!heading) problems.push(`${text}: not directly under a heading`);
      else if (controls.some((control) => before!.contains(control) && !before!.matches(HEADING))) {
        // The heading's own row may hold an action; it must not be what the line covers.
        problems.push(`${text}: under a heading row that holds what it locks`);
      }
    } else if (place === 'tab') {
      const tab = line.closest(TAB_ROOT);
      if (!tab) problems.push(`${text}: not in a tab`);
      else {
        for (let at: Element | null = line; at && at !== tab; at = at.parentElement) {
          if (at.previousElementSibling) { problems.push(`${text}: not at the top of the tab`); break; }
        }
      }
    } else if (place === 'control') {
      // Right under what it locks: the element before it is (or holds) one of its controls, or
      // it closes the row of controls it locks (a card's buttons, each before it in that row).
      const under = before && controls.some((control) => before === control || before.contains(control));
      const row = line.parentElement;
      const closesRow = !!row && controls.some((control) => row.contains(control))
        && controls.filter((control) => row.contains(control))
          .every((control) => control.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!under && !closesRow) problems.push(`${text}: not directly under the control it locks`);
    } else {
      problems.push(`${text}: no place (${LOCK_PLACE_ATTR})`);
    }
  }
  // Every locked control past the first moment points at a line on screen (none skips the rule).
  for (const control of root.querySelectorAll<HTMLElement>('[data-person-lock]:not([data-held-pending])')) {
    const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!ids.some((id) => document.getElementById(id)?.classList.contains('person-lock-line'))) {
      const name = control.getAttribute('aria-label') || (control.textContent ?? '').trim() || control.tagName.toLowerCase();
      problems.push(`${name} (${control.getAttribute('data-person-lock')}): locked with no lock line`);
    }
    if (!LOCK_LOOK_SELECTORS.some((selector) => control.matches(selector))) {
      const name = control.getAttribute('aria-label') || control.tagName.toLowerCase();
      problems.push(`${name} (${control.getAttribute('data-person-lock')}): locked, but no lock look covers a <${control.tagName.toLowerCase()}>`);
    }
  }
  return problems;
}

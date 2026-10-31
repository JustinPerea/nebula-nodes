/**
 * PR #204 round 10 (GM r15): a person-only control locks in place (aria-disabled, focusable) with
 * its line in the page (aria-describedby), never a tooltip. What a test reads from one.
 */
/** The lock line this control points at, or null. */
export function lockLine(element: Element): string | null {
  for (const id of (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
    const text = document.getElementById(id)?.textContent ?? '';
    if (/connected as you\.$/.test(text)) return text;
  }
  return null;
}

/** Whether a click does nothing: disabled, or locked in place. */
export function blocked(element: Element): boolean {
  return (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
}

/** What a control says about why it waits: its tooltip if it has one, else its lock line. A locked
 * control that still had a tooltip reads as the tooltip, so a test expecting the line fails. */
export function reasonOf(element: Element): string | null {
  return element.getAttribute('title') ?? lockLine(element);
}

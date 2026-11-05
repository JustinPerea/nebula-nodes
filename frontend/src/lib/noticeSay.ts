/**
 * The notice region's polite line (round 3l, GM r69 a): a screen reader
 * hears what a decision did without focus moving to say it. One visually
 * hidden element in the region (NoticeRegion), which is a
 * child of <body> above every dialog's backdrop, so a dialog's `inert`
 * never silences it. It is a plain `aria-live="polite"` line with no
 * `status` role: the notices in the region are its statuses.
 */
export const SAY_ATTR = 'data-notice-say';

let pending: ReturnType<typeof setTimeout> | null = null;

/** Says `text` politely. The same words twice in a row are said twice: the
 * line empties first, and the words land a moment later. */
export function sayPolitely(text: string): void {
  const line = document.querySelector<HTMLElement>(`[${SAY_ATTR}]`);
  if (!line) return;
  if (pending !== null) clearTimeout(pending);
  line.textContent = '';
  pending = setTimeout(() => {
    pending = null;
    line.textContent = text;
  }, 50);
}

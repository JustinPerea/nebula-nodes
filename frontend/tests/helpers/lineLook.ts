/**
 * PR #204 (design): a Commons line's look as the app's stylesheets give it
 * (tests/helpers/cssCascade): its ink, and that it draws no left bar.
 */
import { cascaded } from './cssCascade';
import { declIsBar } from './leftBarReader';

/** A value with its var() resolved through the element's own custom properties (one level, as
 * the sheet sets them), then the root tokens are what they are. */
function resolve(won: Map<string, { value: string }>, value: string): string {
  const own = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return own && won.get(`|${own[1]}`) ? won.get(`|${own[1]}`)!.value : value;
}
/** The line box's ink, as the cascade gives it. Design: a line has no rule down its left edge (leftBar). */
export function lineLook(box: Element) {
  const won = cascaded(box);
  return { color: resolve(won, won.get('|color')?.value ?? '') };
}
/** Whether a bar down the left edge wins on the box: a border thicker than 1px in any spelling
 * (the same reader as the stylesheet ratchet, tests/noLeftBar.ratchet), or an inset left shadow.
 * Design: it never does. */
export function leftBar(box: Element): boolean {
  const won = cascaded(box);
  return LEFT_BAR_PROPS.some((prop) => {
    const value = won.get(`|${prop}`)?.value;
    return value !== undefined && declIsBar(prop, value);
  });
}
const LEFT_BAR_PROPS = ['border-left', 'border-left-width', 'border-inline-start', 'border-inline-start-width', 'border-width', 'box-shadow'];
/** Design: the box's fill, the winner of `background` and `background-color`. */
export function lineFill(box: Element): string {
  const won = cascaded(box);
  const rank = (w?: { important: boolean; specificity: [number, number, number]; order: number }) =>
    w ? [w.important ? 1 : 0, ...w.specificity, w.order] : [-1];
  const [a, b] = [won.get('|background'), won.get('|background-color')];
  const ra = rank(a); const rb = rank(b);
  let first: typeof a = undefined;
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) { if ((ra[i] ?? -1) !== (rb[i] ?? -1)) { first = (ra[i] ?? -1) > (rb[i] ?? -1) ? a : b; break; } }
  return resolve(won, (first ?? a ?? b)?.value.replace(/\s*!important/, '').trim() ?? '');
}
export const NEUTRAL = { color: 'var(--sr-ink-light)' };

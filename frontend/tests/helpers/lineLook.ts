/**
 * PR #204 round 18 (GM r28 1): a Commons line's look as the app's stylesheets give it
 * (tests/helpers/cssCascade): its ink, and that it draws no left bar.
 */
import { cascaded } from './cssCascade';

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
/** Whether a left border thicker than 1px (a bar down the edge) wins on the box. Design: it never does. */
export function leftBar(box: Element): boolean {
  const won = cascaded(box);
  const shorthand = won.get('|border-left')?.value ?? '';
  const width = won.get('|border-left-width')?.value ?? shorthand.split(/\s+/)[0] ?? '';
  const px = /^(\d*\.?\d+)px$/.exec(width.trim());
  return px ? Number(px[1]) > 1 : /^var\(/.test(width.trim());
}
/** Round 18c (GM r30 1): the box's fill, the winner of `background` and `background-color`. */
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

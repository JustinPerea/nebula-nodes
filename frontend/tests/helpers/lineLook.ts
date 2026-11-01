/**
 * PR #204 round 18 (GM r28 1): a Commons line's look as the app's stylesheets give it
 * (tests/helpers/cssCascade): its ink, and the colour of its left rule.
 */
import { cascaded } from './cssCascade';

/** A value with its var() resolved through the element's own custom properties (one level, as
 * the sheet sets them), then the root tokens are what they are. */
function resolve(won: Map<string, { value: string }>, value: string): string {
  const own = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return own && won.get(`|${own[1]}`) ? won.get(`|${own[1]}`)!.value : value;
}
/** The line box's ink and the colour of its left rule, as the cascade gives them. */
export function lineLook(box: Element) {
  const won = cascaded(box);
  const color = resolve(won, won.get('|color')?.value ?? '');
  const shorthand = won.get('|border-left')?.value ?? '';
  const ruleColor = won.get('|border-color')?.important ? won.get('|border-color')!.value
    : /currentColor/i.test(shorthand) ? color : resolve(won, shorthand.split(/\s+/).at(-1) ?? '');
  return { color, rule: resolve(won, ruleColor) };
}
export const NEUTRAL = { color: 'var(--sr-ink-light)', rule: 'var(--sr-ink-light)' };

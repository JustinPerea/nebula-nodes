import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appRules, cascaded } from './helpers/cssCascade';
import { SwitchRow } from '../src/components/panels/settings/Switch';

/**
 * GM, PR #198 r39 item 1: a selected control is an on or chosen state, never
 * a disabled one. "A selected control must never borrow the disabled tokens,
 * or 'on' reads as 'off limits'." The checked Settings switch and the chosen
 * Remotion anchor cell keep their own look; only a control that is actually
 * locked takes the disabled look, and that look covers its selected state too.
 */

/** GM r33's disabled tokens and #200's, by name, and the r33 values a rule could spell out. */
const DISABLED_TOKEN = /--(?:sr-)?disabled-(?:fill|label|ink|edge|fill-label)\b|--(?:sr-)?disabled-opacity[\w-]*/;
/** The same values spelled out, in either rgb() syntax and as a fraction or a percentage (review 1 of PR #205, NIT-1). */
const DISABLED_VALUE = /rgba?\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(?:0?\.(?:42|55)|42%|55%)\s*\)|rgba?\(\s*255\s+255\s+255\s*\/\s*(?:0?\.(?:42|55)|42%|55%)\s*\)|rgba?\(\s*17\s*,\s*17\s*,\s*17\s*,\s*(?:0?\.62|62%)\s*\)|rgba?\(\s*17\s+17\s+17\s*\/\s*(?:0?\.62|62%)\s*\)/;
/** A selected, checked, pressed or chosen state in a selector (review 1 of
 * PR #205, NIT-1: the app's `.is-active` too, and the other spellings). */
const SELECTED = /aria-(?:pressed|checked|selected|current)|:checked|--(?:active|selected|chosen|on|checked|pressed|current)\b|\.is-(?:active|selected|checked|pressed|current|on)\b|\[data-(?:active|selected|chosen|state|checked|pressed)\b/;
/** A state that locks the control. */
const LOCKED = /:disabled|\[disabled\]|aria-disabled|data-offline-disabled|data-following-disabled|data-held-look|:is\([^)]*:disabled/;

beforeEach(() => { document.body.className = 'app-slava-restraint'; });
afterEach(() => { cleanup(); document.body.className = ''; });

const value = (element: Element, key: string) => cascaded(element).get(key)?.value ?? '';

/** A rule that gives a selected state the disabled look without a lock. */
const borrows = (rule: { selector: string; decls: Array<{ value: string }> }) => SELECTED.test(rule.selector)
  && rule.decls.some((decl) => DISABLED_TOKEN.test(decl.value) || DISABLED_VALUE.test(decl.value))
  && !LOCKED.test(rule.selector);

describe('the ratchet: a selected state never borrows a disabled token unless it is locked too', () => {
  it('every rule that names a selected state and uses a disabled token or value also requires a locked state', () => {
    const offenders = appRules().filter(borrows).map((rule) => `${rule.file}: ${rule.selector}`);
    expect(offenders).toEqual([]);
  });

  // Review 1 of PR #205 (NIT-1): the selected forms and disabled values the
  // ratchet missed, each caught; the same with a lock, and an enabled look, are not.
  it.each([
    ['.preset-library__cat.is-active', 'var(--disabled-fill)', true],
    ['.foo--checked', 'var(--sr-disabled-fill)', true],
    ['.foo--pressed', 'var(--disabled-label)', true],
    ['.foo[data-state=\'on\']', 'var(--disabled-label)', true],
    ['.foo--active', 'var(--sr-disabled-opacity-strong)', true],
    ['.foo--active', 'var(--disabled-opacity)', true],
    ['.foo--active', 'rgb(255 255 255 / 55%)', true],
    ['.foo--active', 'rgba(255, 255, 255, 55%)', true],
    ['.foo--active', 'rgba(255,255,255,.55)', true],
    ['.foo.is-active:disabled', 'var(--disabled-fill)', false],
    ['.foo[data-state=\'on\'][aria-disabled=\'true\']', 'var(--disabled-label)', false],
    ['.foo.is-active', 'var(--sr-accent)', false],
  ])('%s { %s } is caught: %s', (selector, value, caught) => {
    expect(borrows({ selector, decls: [{ value }] })).toBe(caught);
  });

  it('the locked selected marks are the reviewed ones (GM\'s image-only and chip rule, and the anchor by PR #205 r1), never the switch', () => {
    const marks = [...new Set(appRules()
      .filter((rule) => SELECTED.test(rule.selector) && LOCKED.test(rule.selector))
      .filter((rule) => rule.decls.some((decl) => DISABLED_TOKEN.test(decl.value) || DISABLED_VALUE.test(decl.value)))
      .map((rule) => `${rule.file}: ${rule.selector.replace(/:hover$/, '')}`))].sort();
    expect(marks).toEqual([
      "styles/disabled-buttons.css: :is(.cinema-shared-controls__chip--active):is(:disabled, [aria-disabled='true'])",
      "styles/disabled-buttons.css: :is(.cinema-shot-panel__variation--active):is(:disabled, [aria-disabled='true'])",
      "styles/disabled-buttons.css: :is(.project-home__cover-choice[aria-pressed='true']):is(:disabled, [aria-disabled='true'])",
      "styles/disabled-buttons.css: :is(.remotion-properties-panel__anchor-button[aria-pressed='true']):is(:disabled, [aria-disabled='true'])",
    ]);
  });
});

describe('the Settings switch', () => {
  const switchOf = (checked: boolean, disabled: boolean) => {
    const { container, unmount } = render(<SwitchRow title="Minimap" checked={checked} disabled={disabled} onChange={() => {}} />);
    return { input: container.querySelector('input.settings-switch')!, unmount };
  };

  it('checked and enabled: its own on look, no disabled token on the track or the thumb', () => {
    const { input } = switchOf(true, false);
    expect(value(input, '|background')).toBe('var(--sr-accent)');
    expect(value(input, '::before|background')).toBe('#fff');
    for (const [key, winner] of cascaded(input)) {
      expect(`${key} ${winner.value}`).not.toMatch(DISABLED_TOKEN);
      expect(`${key} ${winner.value}`).not.toMatch(DISABLED_VALUE);
    }
  });

  it('checked and locked: the disabled look covers the on state (the grey track, the grey thumb, no extra dimming)', () => {
    const { input } = switchOf(true, true);
    expect(value(input, '|background')).toMatch(/^var\(--sr-disabled-fill/);
    expect(value(input, '::before|background')).toMatch(/^var\(--disabled-label/);
    expect(value(input, '|opacity')).toBe('1');
  });

  it('locked, on and off share the disabled look; only the thumb\'s place differs', () => {
    const on = switchOf(true, true);
    const onTrack = value(on.input, '|background');
    const onThumb = value(on.input, '::before|background');
    on.unmount();
    const off = switchOf(false, true);
    expect(value(off.input, '|background')).toBe(onTrack);
    expect(value(off.input, '::before|background')).toBe(onThumb);
    expect(value(off.input, '|opacity')).toBe('1');
  });
});

describe('Remotion\'s anchor cells', () => {
  const cells = (locked: boolean) => {
    const fieldset = document.createElement('fieldset');
    fieldset.disabled = locked;
    const chosen = document.createElement('button');
    chosen.className = 'remotion-properties-panel__anchor-button';
    chosen.setAttribute('aria-pressed', 'true');
    chosen.dataset.active = 'true';
    const other = document.createElement('button');
    other.className = 'remotion-properties-panel__anchor-button';
    other.setAttribute('aria-pressed', 'false');
    fieldset.append(chosen, other);
    document.body.appendChild(fieldset);
    return { chosen, other, done: () => fieldset.remove() };
  };

  it('chosen and enabled: its own chosen look, no disabled token', () => {
    const { chosen, done } = cells(false);
    expect(value(chosen, '|background')).toBe('var(--sr-accent)');
    for (const [key, winner] of cascaded(chosen)) expect(`${key} ${winner.value}`).not.toMatch(DISABLED_TOKEN);
    done();
  });

  it('chosen and locked: the cell\'s disabled look, with the shared grey selected mark so the choice still reads (GM PR #205 r1)', () => {
    const { chosen, other, done } = cells(true);
    for (const key of ['|background', '|opacity']) expect(value(chosen, key), key).toBe(value(other, key));
    expect(value(chosen, '|background')).toBe('transparent');
    expect(value(other, '|border-color')).toMatch(/^var\(--sr-disabled-edge/);
    expect(value(chosen, '|border-color')).toMatch(/^var\(--sr-disabled-ink/);
    expect(value(chosen, '|box-shadow')).toMatch(/^inset 0 0 0 1px var\(--sr-disabled-ink/);
    expect(value(other, '|box-shadow')).toBe('');
    done();
  });
});

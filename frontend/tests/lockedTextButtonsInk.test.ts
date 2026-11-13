import { afterEach, describe, expect, it } from 'vitest';
import { cascaded } from './helpers/cssCascade';

/**
 * GM r9 item 1 of PR #203: Run History's Rerun and "Retry failed", and the
 * deferred "Run now", locked by a missing key (aria-disabled), take the
 * shared disabled label (styles/disabled-buttons.css, GM r33's tokens since
 * PR #198: a ghost's grey --disabled-label, a filled button's dark
 * --disabled-fill-label on the grey fill), and keep it while focused, the
 * focus ring drawn on top. Read from the app's real stylesheets the way the
 * browser cascades them (tests/helpers/cssCascade.ts). Before round 6 Run
 * History's buttons weren't in the shared rule, so their own sheet's enabled
 * white (--sr-ink) won.
 */

const GHOST_LABEL = /^var\(--disabled-label\b/;
const FILLED_LABEL = /^var\(--disabled-fill-label\b/;

type Winner = NonNullable<ReturnType<ReturnType<typeof cascaded>['get']>>;

function beats(a: Winner, b: Winner): boolean {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i += 1) if (a.specificity[i] !== b.specificity[i]) return a.specificity[i] > b.specificity[i];
  return a.order >= b.order;
}

/** The label colour at rest, and while focused from the keyboard (a focus rule only wins if it beats the rest one). */
function labelColours(button: HTMLElement) {
  const styles = cascaded(button);
  const rest = styles.get('|color');
  let focused = rest;
  for (const state of [':focus', ':focus-visible']) {
    const candidate = styles.get(`${state}|color`);
    if (candidate && (!focused || beats(candidate, focused))) focused = candidate;
  }
  // Run History's buttons have no ring of their own: the app-wide one,
  // `:where(body.app-slava-restraint :focus-visible)`, draws it. The helper
  // files a state inside :where() under rest, so it is read from there.
  const appRing = styles.get('|outline');
  const ring = styles.get(':focus-visible|outline') ?? styles.get(':focus|outline')
    ?? (appRing?.selector.includes(':focus-visible') ? appRing : undefined);
  return { rest: rest?.value, focused: focused?.value, ring: ring?.value };
}

function mount(html: string): HTMLElement {
  document.body.className = 'app-slava-restraint';
  document.body.innerHTML = html;
  return document.body.querySelector('button[data-subject]') as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
});

const BUTTONS: Record<string, { label: RegExp; html: string }> = {
  Rerun: { label: GHOST_LABEL, html: `<div class="panel run-history"><ul class="run-history__list"><li class="run-history__item">
    <span class="run-history__item-actions"><button type="button" data-subject class="run-history__replay"
    aria-disabled="true" data-key-locked="">Rerun</button></span></li></ul></div>` },
  'Retry failed': { label: GHOST_LABEL, html: `<div class="panel run-history"><ul class="run-history__list"><li class="run-history__item">
    <span class="run-history__item-actions"><button type="button" data-subject class="run-history__replay"
    aria-disabled="true" data-key-locked="">Retry failed</button></span></li></ul></div>` },
  'Run now': { label: FILLED_LABEL, html: `<div class="notice-region"><div class="notice-region__stack"><div class="notice-region__slot" data-notice-slot="run-later">
    <div class="proposal-bar proposal-bar--notice" role="status"><div class="proposal-bar__actions">
    <button type="button" data-subject class="proposal-bar__button proposal-bar__button--primary"
    aria-disabled="true" data-key-locked="">Run now</button></div></div></div></div></div>` },
};

describe('locked text buttons take the shared grey label, focused too (GM r9 item 1)', () => {
  for (const [name, { label, html }] of Object.entries(BUTTONS)) {
    it(`${name}: locked, its label is the shared disabled label`, () => {
      const { rest } = labelColours(mount(html));
      expect(rest, name).toMatch(label);
    });

    it(`${name}: locked and focused, the label stays grey and the focus ring is drawn`, () => {
      const { focused, ring } = labelColours(mount(html));
      expect(focused, name).toMatch(label);
      expect(ring, `${name}: a focus ring`).toBeTruthy();
      expect(ring, `${name}: a focus ring`).not.toMatch(/^(none|0)\b/);
    });
  }

  it('the same buttons unlocked keep their brighter label (the grey is the lock\'s, not the button\'s)', () => {
    for (const [name, { label, html }] of Object.entries(BUTTONS)) {
      const button = mount(html.replace(' aria-disabled="true" data-key-locked=""', ''));
      expect(labelColours(button).rest, name).not.toMatch(label);
    }
  });
});

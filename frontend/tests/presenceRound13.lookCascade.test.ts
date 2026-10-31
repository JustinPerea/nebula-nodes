/**
 * PR #204 round 13 (review 10 MEDIUM-1, LOW-4): the lock look resolved through the cascade, the
 * way the browser picks it (tests/helpers/cssCascade), not read from the rule's text.
 *
 * Round 11's lock rule tied the filled list at (0,3,0) and came later in the sheet, so every
 * locked filled button (Connect, Add, a red Delete forever confirm, Accept) turned ghost. Its
 * element part is now :where(), and its block sits above the filled list: a locked filled button
 * keeps --disabled-fill with --disabled-fill-label (GM r33), at rest, on hover and while pressed
 * from the keyboard; a ghost keeps the ghost tokens; a class in no list takes the lock's own look.
 *
 * Also (LOW-4): a locked field's edge (mutant L4), and the because line's sans face (mutant L20).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cascaded, resolvedStyle } from './helpers/cssCascade';

const css = readFileSync(join(__dirname, '../src/styles/disabled-buttons.css'), 'utf8');

/** The classes of the list rule whose comment starts with `comment` (its first `:is(` list). */
function listAfter(comment: string): string[] {
  const at = css.indexOf(comment);
  expect(at, comment).toBeGreaterThan(-1);
  const open = css.indexOf(':is(', at) + ':is('.length;
  const list = css.slice(open, css.indexOf(')', open));
  return list.split(',').map((name) => name.trim().replace(/^\./, '')).filter(Boolean);
}

const FILLED = listAfter('/* Filled buttons: the accent (orange)');
const GHOST = listAfter('/* Ghost and outline buttons: unfilled');

type Winner = NonNullable<ReturnType<ReturnType<typeof cascaded>['get']>>;
function beats(a: Winner, b: Winner): boolean {
  if (a.important !== b.important) return a.important;
  for (let i = 0; i < 3; i += 1) if (a.specificity[i] !== b.specificity[i]) return a.specificity[i] > b.specificity[i];
  return a.order >= b.order;
}

const seen = new WeakMap<Element, ReturnType<typeof cascaded>>();
/** What `prop` resolves to on `element` in `state` ('' at rest, ':hover', ':active'): the winner
 * among the rules at rest and the rules for that state, as the browser picks it. */
function look(element: Element, prop: string, state = ''): string | undefined {
  if (!seen.has(element)) seen.set(element, cascaded(element));
  const all = seen.get(element)!;
  const rest = all.get(`|${prop}`);
  const held = state ? all.get(`${state}|${prop}`) : undefined;
  if (!rest) return held?.value;
  if (!held) return rest.value;
  return beats(held, rest) ? held.value : rest.value;
}

function locked(className: string, tag = 'button'): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.setAttribute('data-person-lock', 'change this');
  element.setAttribute('aria-disabled', 'true');
  document.body.appendChild(element);
  return element;
}

beforeEach(() => { document.body.className = 'app-slava-restraint'; });
afterEach(() => { document.body.innerHTML = ''; document.body.className = ''; });

describe('the lock look through the cascade (review 10 MEDIUM-1)', () => {
  it('reads the two lists (the parse works)', () => {
    expect(FILLED).toEqual(expect.arrayContaining([
      'settings__button--primary', 'asset-trash__button--danger', 'project-home__danger', 'settings__confirm--danger',
      'proposal-bar__button--primary', 'asset-proposal__button--accept', 'agent-notes-btn--primary',
    ]));
    expect(FILLED.length).toBeGreaterThanOrEqual(27);
    expect(GHOST).toEqual(expect.arrayContaining(['selection-toolbar__button', 'proposal-bar__button']));
  });

  it('a locked .settings__button--primary (Connect, Add) keeps the grey fill with its dark label', () => {
    const button = locked('settings__button settings__button--primary');
    for (const state of ['', ':hover', ':active']) {
      expect(look(button, 'background', state), `background ${state}`).toMatch(/^var\(--disabled-fill,/);
      expect(look(button, 'border-color', state), `border ${state}`).toMatch(/^var\(--disabled-fill,/);
      expect(look(button, 'color', state), `label ${state}`).toMatch(/^var\(--disabled-fill-label,/);
    }
  });

  it('every filled class in the list, locked: --disabled-fill and --disabled-fill-label, at rest, on hover and pressed', () => {
    const wrong: string[] = [];
    for (const name of FILLED) {
      const button = locked(name);
      for (const state of ['', ':hover', ':active']) {
        const background = look(button, 'background', state);
        const label = look(button, 'color', state);
        if (!/^var\(--disabled-fill,/.test(background ?? '') || !/^var\(--disabled-fill-label,/.test(label ?? '')) {
          wrong.push(`.${name}${state}: background ${background}, label ${label}`);
        }
      }
      button.remove();
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('every ghost class, locked: no fill, the grey label and the 0.06 edge (GM r20 item 4)', () => {
    const wrong: string[] = [];
    for (const name of GHOST) {
      const button = locked(name);
      for (const state of ['', ':hover', ':active']) {
        const background = look(button, 'background', state);
        // The swatch's × keeps its dark bubble, locked or not (its own rule, GM r7 answer 1).
        if (name === 'cinema-shared-controls__swatch-remove' && background === 'rgba(0, 0, 0, 0.7)') continue;
        const label = look(button, 'color', state);
        const edge = look(button, 'border-color', state);
        if (background !== 'transparent' || !/^var\(--disabled-label,/.test(label ?? '') || !/^var\(--sr-disabled-edge,/.test(edge ?? '')) {
          wrong.push(`.${name}${state}: background ${background}, label ${label}, edge ${edge}`);
        }
      }
      button.remove();
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('a button in no list (the notice Undo, a Commons Add) takes the lock look itself', () => {
    for (const name of ['settings-notice__undo', 'commons-button commons-button--primary', 'settings__button']) {
      const button = locked(name);
      for (const state of ['', ':hover', ':active']) {
        expect(look(button, 'background', state), `${name} ${state}`).toBe('transparent');
        expect(look(button, 'color', state), `${name} ${state}`).toMatch(/^var\(--disabled-label,/);
        expect(look(button, 'border-color', state), `${name} ${state}`).toMatch(/^var\(--sr-disabled-edge,/);
        expect(look(button, 'cursor', state), `${name} ${state}`).toBe('default');
      }
      button.remove();
    }
  });

  it('the quiet choice keeps its ghost look with the filled class (its own rule after the list)', () => {
    const button = locked('canvas-undo-notice__action canvas-undo-notice__action--quiet');
    expect(look(button, 'background')).toBe('transparent');
    expect(look(button, 'color')).toMatch(/^var\(--disabled-label,/);
  });

  it('the first moment (data-held-pending) keeps the control its own look: no lock rule applies', () => {
    const button = locked('settings-notice__undo');
    button.setAttribute('data-held-pending', '');
    expect(look(button, 'background')).not.toBe('transparent');
  });

  it('a locked select keeps its value in --disabled-label with the 0.06 edge (mutant L4)', () => {
    for (const tag of ['select', 'input', 'textarea']) {
      const field = locked('', tag);
      for (const state of ['', ':hover', ':active']) {
        expect(look(field, 'color', state), `${tag} ${state}`).toMatch(/^var\(--disabled-label,/);
        expect(look(field, 'border-color', state), `${tag} ${state}`).toMatch(/^var\(--sr-disabled-edge, rgba\(255, 255, 255, 0\.06\)\)/);
      }
      field.remove();
    }
  });
});

describe('a because line is sans, inside a box that sets mono (review 10 LOW-4, mutant L20; GM r18 c)', () => {
  it('the words and their box resolve to --sr-ui, over the card error box\'s mono', () => {
    document.body.innerHTML = `<div class="model-node__error" data-line-box="">
      <span class="model-node__error-message"><span data-line-because="">Nebula couldn’t run this because …</span></span>
      <code>raw</code></div>`;
    const box = document.querySelector('.model-node__error')!;
    // The card's own box is mono (slava-restraint.css): the rule has something to win over.
    expect(cascaded(box).get('|font-family')?.selector).toMatch(/data-line-box/);
    expect(resolvedStyle(box)['|font-family']).toBe('var(--sr-ui)');
    expect(resolvedStyle(document.querySelector('[data-line-because]')!)['|font-family']).toBe('var(--sr-ui)');
    // Code inside keeps mono.
    expect(resolvedStyle(document.querySelector('code')!)['|font-family']).toBe('var(--sr-mono)');
  });

  it('the same box without a because line keeps its mono (the rule reaches only because lines)', () => {
    document.body.innerHTML = '<div class="model-node__error" data-line-box=""><span class="model-node__error-message">Run failed.</span></div>';
    expect(resolvedStyle(document.querySelector('.model-node__error')!)['|font-family']).toBe('var(--sr-mono)');
  });
});

/**
 * PR #204 round 18 (GM r28 1): "Nebula couldn’t load …" lines destroy nothing, so they are
 * neutral in colour too: the same grey rule and ink as the Commons because line, one style for
 * every such line (the Commons page, its panes, the reference detail, the Commons settings).
 * Only a load says a line in noResponseBecause's form; CommonsErrorLine marks its box
 * `data-line-neutral`, and styles/becauseLine.css draws it as it draws a because line.
 * Resolved through the app's own stylesheets (tests/helpers/cssCascade), not a copy of them.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineLook, NEUTRAL } from './helpers/lineLook';

const { CommonsErrorLine } = await import('../src/components/commons/CommonsErrorLine');
const { isNoResponseLine, noResponseBecause, notConnectedBecause } = await import('../src/lib/errorCopy');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');

/** Every load line #204 draws in the no-answer form, by where it shows. */
export const LOAD_LINES = {
  'Commons page': noResponseBecause('load the Commons'),
  'references': noResponseBecause('load the references'),
  'collections': noResponseBecause('load the collections'),
  'status': noResponseBecause('check the Commons status'),
  'Agent review': noResponseBecause('load Agent review'),
  'Blind labeling': noResponseBecause('load Blind labeling'),
  'reference detail': noResponseBecause('load this reference'),
  'Commons settings': noResponseBecause('load the Commons settings'),
};
const ERROR_TOKENS = /--sr-(?:error|danger|warning|accent)\b/;

beforeEach(() => { document.body.className = 'app-slava-restraint'; });
afterEach(() => { cleanup(); resetLinesForTests(); document.body.className = ''; });

describe('the no-answer form is a load\'s, and only it is marked neutral', () => {
  it('isNoResponseLine reads noResponseBecause\'s form, and nothing else', () => {
    for (const line of Object.values(LOAD_LINES)) expect(isNoResponseLine(line), line).toBe(true);
    expect(isNoResponseLine(notConnectedBecause('load the Commons', false))).toBe(false);
    expect(isNoResponseLine('Couldn’t load Agent review. The review set is closed.')).toBe(false);
    expect(isNoResponseLine("Nebula didn't respond. Try again.")).toBe(false);
  });
});

describe('every "Nebula couldn’t load …" line resolves to the neutral tokens (GM r28 1)', () => {
  for (const [where, line] of Object.entries(LOAD_LINES)) {
    it(where, () => {
      const view = render(<CommonsErrorLine line={line} />);
      const box = view.container.querySelector('[data-commons-line]')!;
      expect(box.hasAttribute('data-line-neutral')).toBe(true);
      const look = lineLook(box);
      expect(look).toEqual(NEUTRAL);
      expect(`${look.color} ${look.rule}`).not.toMatch(ERROR_TOKENS);
    });
  }

  it('the same look as the Commons because line (H-prompt-demoted)', () => {
    const view = render(<><CommonsErrorLine line={notConnectedBecause('load the Commons', false)} /><CommonsErrorLine line={LOAD_LINES['Commons page']} /></>);
    const [because, load] = [...view.container.querySelectorAll('[data-commons-line]')];
    expect(lineLook(load)).toEqual(lineLook(because));
  });

  it('a failure with a reason the backend wrote keeps the error look', () => {
    const view = render(<CommonsErrorLine line="Couldn’t load Agent review. The review set is closed." />);
    const box = view.container.querySelector('[data-commons-line]')!;
    expect(box.hasAttribute('data-line-neutral')).toBe(false);
    expect(lineLook(box).color).toBe('var(--sr-error)');
    expect(lineLook(box).rule).toBe('var(--sr-error)');
  });
});

describe('every Commons load line draws through CommonsErrorLine (GM r28 1: one style)', () => {
  it('no Commons screen draws a failure line state as bare LineText', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '../src/components/commons');
    const bare = readdirSync(dir).filter((name) => name.endsWith('.tsx') && !name.includes('.test.') && name !== 'CommonsErrorLine.tsx')
      .flatMap((name) => [...readFileSync(join(dir, name), 'utf8').matchAll(/<LineText text=\{(\w*[eE]rror)\}/g)].map((hit) => `${name}: ${hit[1]}`));
    expect(bare).toEqual([]);
  });
});

describe('the held status slot (GM r28 3)', () => {
  it('keeps the default status\'s place, drawn as nothing, with nothing to focus', async () => {
    const { StatusLine } = await import('../src/components/commons/CommonsView');
    const { cascaded } = await import('./helpers/cssCascade');
    const view = render(<StatusLine status={null} connecting={false} onStart={() => {}} onStop={() => {}} />);
    const slot = view.container.querySelector('.commons-status')!;
    expect(slot.hasAttribute('data-status-held')).toBe(true);
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.querySelector('button, [tabindex]')).toBeNull();
    expect(cascaded(slot).get('|visibility')?.value).toBe('hidden');
  });
});

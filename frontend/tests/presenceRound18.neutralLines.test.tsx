/**
 * PR #204 round 18 (GM r28 1): "Nebula couldn’t load …" lines destroy nothing, so they are
 * neutral in colour too: the same grey rule and ink as the Commons because line, one style for
 * every such line (the Commons page, its panes, the reference detail, the Commons settings).
 * Only a load says a line in noResponseBecause's form; CommonsErrorLine marks its box
 * `data-line-neutral`, and styles/becauseLine.css draws it as it draws a because line.
 * Resolved through the app's own stylesheets (tests/helpers/cssCascade), not a copy of them.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lineFill, lineLook, NEUTRAL } from './helpers/lineLook';

const { CommonsErrorLine } = await import('../src/components/commons/CommonsErrorLine');
const { COMMONS_OFF_COPY, isLoadLine, LOAD_BECAUSE, loadFailedLine, noResponseBecause, notConnectedBecause } = await import('../src/lib/errorCopy');
const { CommonsRequestError } = await import('../src/lib/commonsRequestError');
const { OfflineRefusal } = await import('../src/lib/backendConnection');
const { copyForStatus } = await import('../src/lib/errorCopy');
/** A Commons load's failure as lib/commonsApi throws it: the status and what the backend sent. */
const failed = (status: number, detail?: string) => new CommonsRequestError(
  status === 0 ? "Nebula's server isn't answering. Make sure it's running, then try again." : copyForStatus(status, detail), status, { detail });
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

describe('a load line, whatever its reason, and only a load line, is marked neutral (GM r29 1)', () => {
  it('isLoadLine reads a load\'s line, and not an action\'s', () => {
    for (const line of Object.values(LOAD_LINES)) expect(isLoadLine(line), line).toBe(true);
    expect(isLoadLine(notConnectedBecause('load the Commons', false))).toBe(true);
    expect(isLoadLine('Nebula couldn’t load Agent review. The review set is closed.')).toBe(true);
    expect(isLoadLine('Couldn’t save the settings. That setting isn’t available.')).toBe(false);
    expect(isLoadLine("Nebula didn't respond. Try again.")).toBe(false);
  });
  it('every reason a load can get reads as GM wrote it (GM r29 1, r30); "Try again." only where it can help', () => {
    const cases: Array<[string, number, string | undefined, string]> = [
      ['load Agent review', 503, undefined, noResponseBecause('load Agent review')],
      ['load Agent review', 408, undefined, noResponseBecause('load Agent review')],
      // GM r31: a rate limit has its own line.
      ['load Agent review', 429, undefined, 'Nebula couldn’t load Agent review because the server is busy. Try again in a moment.'],
      ['load Agent review', 502, undefined, noResponseBecause('load Agent review')],
      ['load Agent review', 500, 'Internal Server Error', 'Nebula couldn’t load Agent review because the server hit an error. Try again.'],
      ['load the Commons', 0, undefined, 'Nebula couldn’t load the Commons because the server isn’t answering. Check that Nebula is running, then try again.'],
      ['load this reference', 404, "That reference isn't there anymore. Reload to get the latest references.",
        'Nebula couldn’t load this reference because it isn’t there anymore. Reload to get the latest references.'],
      ['load this reference', 409, "That reference isn't in this held-out set. Reload to get the latest references.",
        'Nebula couldn’t load this reference because it isn’t in this held-out set. Reload to get the latest references.'],
      ['load the references', 422, "Those filters didn't work. Clear them and try again.",
        'Nebula couldn’t load the references because those filters didn’t work. Clear them and try again.'],
      ['load this image', 404, 'not found', 'Nebula couldn’t load this image because the file isn’t there anymore.'],
      ['load this video', 404, 'not found', 'Nebula couldn’t load this video because the file isn’t there anymore.'],
      ['load the Commons settings', 401, 'invalid UI session token',
        'Nebula couldn’t load the Commons settings because this window’s session ended. Reload to sign in again.'],
      ['load the Commons settings', 401, 'no UI session: open Nebula from the desktop app or use the dev link',
        'Nebula couldn’t load the Commons settings because this window’s session ended. Reload to sign in again.'],
      ['load the Commons settings', 403, 'only the human UI session can do this',
        'Nebula couldn’t load the Commons settings because this window isn’t signed in as you. Reload to sign in again.'],
      ['load the Commons settings', 403, undefined,
        'Nebula couldn’t load the Commons settings because you don’t have access to this anymore. Reload to sign in again.'],
      ['load the references', 422, undefined, 'Nebula couldn’t load the references because the server didn’t accept it. Try again.'],
      ['load Agent review', 404, 'Commons is disabled', COMMONS_OFF_COPY],
    ];
    for (const [what, status, detail, line] of cases) expect(loadFailedLine(what, failed(status, detail)), `${status} ${detail}`).toBe(line);
    for (const clause of LOAD_BECAUSE.values()) expect(clause).toMatch(/^[a-z]/);
  });
  it('no backend message ever shows: an unlisted reason says the 4xx line, its words go to the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const line = loadFailedLine('load Agent review', failed(409, 'The review set is closed.'));
      expect(line).toBe('Nebula couldn’t load Agent review because the server didn’t accept it. Try again.');
      expect(warn.mock.calls.flat().join(' ')).toContain('The review set is closed.');
    } finally { warn.mockRestore(); }
  });
  it('offline (a request refused before it was sent) says nothing', () => {
    expect(loadFailedLine('load the Commons', new OfflineRefusal('GET', '/api/commons/status'))).toBe('');
  });
  it('the Commons off line is a load line: neutral', () => {
    expect(isLoadLine(COMMONS_OFF_COPY)).toBe(true);
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

  it('a load that failed for a reason the backend wrote is neutral too (GM r29 1)', () => {
    for (const line of ['Nebula couldn’t load Agent review. The review set is closed.',
      'Nebula couldn’t load this reference because it isn’t there anymore. Reload to get the latest references.']) {
      const view = render(<CommonsErrorLine line={line} />);
      const box = view.container.querySelector('[data-commons-line]')!;
      expect(box.hasAttribute('data-line-neutral'), line).toBe(true);
      expect(lineLook(box), line).toEqual(NEUTRAL);
      view.unmount();
    }
  });

  it('an action\'s failure keeps the error look', () => {
    const view = render(<CommonsErrorLine line="Couldn’t save the settings. That setting isn’t available. Reload to get the latest settings." />);
    const box = view.container.querySelector('[data-commons-line]')!;
    expect(box.hasAttribute('data-line-neutral')).toBe(false);
    expect(lineLook(box).color).toBe('var(--sr-error)');
    expect(lineLook(box).rule).toBe('var(--sr-error)');
  });
});

describe('one look for every neutral Commons line, wherever it sits (GM r30 1)', () => {
  // Where a load's line shows: the page's row, a pane's heading (Agent review, Blind labeling,
  // which draw on a lighter fill), the settings pane, the reference detail.
  const PLACES: Array<[string, (line: JSX.Element) => JSX.Element]> = [
    ['the page row', (line) => <div className="commons-view commons-scope"><div className="commons-messages">{line}</div></div>],
    ['Agent review', (line) => <section className="commons-evaluation commons-review"><header className="evaluation-heading">{line}</header></section>],
    ['Blind labeling', (line) => <section className="commons-evaluation"><header className="evaluation-heading">{line}</header></section>],
    ['the settings', (line) => <section className="commons-settings">{line}</section>],
    ['the reference detail', (line) => <aside className="commons-detail">{line}</aside>],
  ];
  const LINES = [...Object.values(LOAD_LINES), notConnectedBecause('load the Commons', false), COMMONS_OFF_COPY];
  it('the same component, the bare rail: neutral ink and rule, no fill, in every place', () => {
    const looks = new Set<string>();
    for (const [place, wrap] of PLACES) for (const line of LINES) {
      const view = render(wrap(<CommonsErrorLine line={line} />));
      const box = view.container.querySelector('[data-commons-line]')!;
      expect(box.className, `${place}: ${line}`).toBe('commons-notice commons-notice--error');
      expect(lineFill(box), `${place}: ${line}`).toBe('transparent');
      looks.add(JSON.stringify({ ...lineLook(box), fill: lineFill(box) }));
      view.unmount();
    }
    expect([...looks]).toEqual([JSON.stringify({ ...NEUTRAL, fill: 'transparent' })]);
  });
  it('an action\'s failure keeps its filled box', () => {
    const view = render(<CommonsErrorLine line="Couldn’t save the settings. That setting isn’t available. Reload to get the latest settings." />);
    expect(lineFill(view.container.querySelector('[data-commons-line]')!)).not.toBe('transparent');
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
  // It imports the whole Commons view cold: a slow first import under load is not a failure.
  it('keeps the default status\'s place, drawn as nothing, with nothing to focus', { timeout: 30_000 }, async () => {
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

describe('the reasons mapped here are the backend\'s own words (round 18c)', () => {
  it('each detail LOAD_BECAUSE and the Commons-off line key on is in the backend, verbatim', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const backend = ['routes/commons.py', 'commons/actors.py', 'commons/evaluation.py', 'commons/person_copy.py', 'services/refusal_copy.py']
      .map((file) => readFileSync(join(__dirname, '../../backend', file), 'utf8')).join('\n');
    const { COMMONS_OFF_DETAIL } = await import('../src/lib/errorCopy');
    expect(backend).toContain(`detail="${COMMONS_OFF_DETAIL}"`);
    // Round 18d (review 14 LOW-4): the blob route's own 404, not a longer "… not found".
    expect(backend).toContain('detail="not found"');
    for (const detail of LOAD_BECAUSE.keys()) {
      // The gone line is built from its parts (refusal_copy.gone("reference", "references")).
      if (detail === 'not found') continue;
      if (detail.startsWith('That reference isn\'t there anymore')) { expect(backend).toContain("That {thing} isn't there anymore. Reload to get the latest {things}."); continue; }
      expect(backend, detail).toContain(detail);
    }
  });
});

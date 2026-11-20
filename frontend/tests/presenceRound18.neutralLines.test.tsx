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
import { cascaded } from './helpers/cssCascade';
import { leftBar, lineFill, lineLook, NEUTRAL } from './helpers/lineLook';

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
  'Commons page': noResponseBecause('load Commons'),
  'references': noResponseBecause('load the references'),
  'collections': noResponseBecause('load the collections'),
  'status': noResponseBecause('check Commons status'),
  'Agent review': noResponseBecause('load Agent review'),
  'Blind labeling': noResponseBecause('load Blind labeling'),
  'reference detail': noResponseBecause('load this reference'),
  'Commons settings': noResponseBecause('load Commons settings'),
};
const ERROR_TOKENS = /--sr-(?:error|danger|warning|accent)\b/;

beforeEach(() => { document.body.className = 'app-slava-restraint'; });
afterEach(() => { cleanup(); resetLinesForTests(); document.body.className = ''; });

describe('a load line, whatever its reason, and only a load line, is marked neutral (GM r29 1)', () => {
  it('isLoadLine reads a load\'s line, and not an action\'s', () => {
    for (const line of Object.values(LOAD_LINES)) expect(isLoadLine(line), line).toBe(true);
    expect(isLoadLine(notConnectedBecause('load Commons', false))).toBe(true);
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
      ['load Commons', 0, undefined, 'Nebula couldn’t load Commons because the server isn’t answering. Check that Nebula is running, then try again.'],
      ['load this reference', 404, "That reference isn't there anymore. Reload to get the latest references.",
        'Nebula couldn’t load this reference because it isn’t there anymore. Reload to get the latest references.'],
      ['load this reference', 409, "That reference isn't in this held-out set. Reload to get the latest references.",
        'Nebula couldn’t load this reference because it isn’t in this held-out set. Reload to get the latest references.'],
      ['load the references', 422, "Those filters didn't work. Clear them and try again.",
        'Nebula couldn’t load the references because those filters didn’t work. Clear them and try again.'],
      ['load this image', 404, 'not found', 'Nebula couldn’t load this image because the file isn’t there anymore.'],
      ['load this video', 404, 'not found', 'Nebula couldn’t load this video because the file isn’t there anymore.'],
      ['load Commons settings', 401, 'invalid UI session token',
        'Nebula couldn’t load Commons settings because this tab’s session ended. Reload to sign in again.'],
      ['load Commons settings', 401, 'no UI session: open Nebula from the desktop app or use the dev link',
        'Nebula couldn’t load Commons settings because this tab’s session ended. Reload to sign in again.'],
      ['load Commons settings', 403, 'only the human UI session can do this',
        'Nebula couldn’t load Commons settings because this tab isn’t signed in as you. Reload to sign in again.'],
      ['load Commons settings', 403, undefined,
        'Nebula couldn’t load Commons settings because you don’t have access to this anymore. Reload to sign in again.'],
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
    expect(loadFailedLine('load Commons', new OfflineRefusal('GET', '/api/commons/status'))).toBe('');
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
      expect(look.color).not.toMatch(ERROR_TOKENS);
      expect(leftBar(box)).toBe(false);
    });
  }

  it('the same look as the Commons because line (H-prompt-demoted)', () => {
    const view = render(<><CommonsErrorLine line={notConnectedBecause('load Commons', false)} /><CommonsErrorLine line={LOAD_LINES['Commons page']} /></>);
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
    expect(lineLook(box).color).toBe('var(--sr-warning)');
    expect(leftBar(box)).toBe(false);
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
  const LINES = [...Object.values(LOAD_LINES), notConnectedBecause('load Commons', false), COMMONS_OFF_COPY];
  it('the same component, a fill and no bar (design): neutral ink and the neutral notice fill, in every place', () => {
    const looks = new Set<string>();
    for (const [place, wrap] of PLACES) for (const line of LINES) {
      const view = render(wrap(<CommonsErrorLine line={line} />));
      const box = view.container.querySelector('[data-commons-line]')!;
      expect(box.className, `${place}: ${line}`).toBe('commons-notice commons-notice--error');
      expect(lineFill(box), `${place}: ${line}`).toBe('var(--sr-surface-control)');
      expect(leftBar(box), `${place}: ${line}`).toBe(false);
      looks.add(JSON.stringify({ ...lineLook(box), fill: lineFill(box) }));
      view.unmount();
    }
    expect([...looks]).toEqual([JSON.stringify({ ...NEUTRAL, fill: 'var(--sr-surface-control)' })]);
  });
  it('an action\'s failure takes the warning tint, never the accent tint (design: one tint per tone)', () => {
    const view = render(<CommonsErrorLine line="Couldn’t save the settings. That setting isn’t available. Reload to get the latest settings." />);
    const fill = lineFill(view.container.querySelector('[data-commons-line]')!);
    expect(fill).toBe('var(--sr-warning-soft)');
    expect(fill).not.toMatch(/accent|error|danger/);
  });
});

describe('design: one tint per tone, and a note is no accent fill', () => {
  const fillOf = (className: string) => {
    const box = document.createElement('div'); box.className = className; document.body.appendChild(box);
    const fill = lineFill(box); box.remove(); return fill;
  };
  it('every failure or warning fill is the warning tint (or the neutral one for a note), none the accent tint', () => {
    for (const cls of ['commons-notice commons-notice--error', 'chat-panel__notice', 'line-box', 'project-home__error']) {
      expect(fillOf(cls), cls).toBe('var(--sr-warning-soft)');
    }
    for (const cls of ['personal-agents__terms', 'inspector__notice', 'inspector__notice inspector__notice--key']) expect(fillOf(cls), cls).toMatch(/^var\(--sr-surface-control(?:-hover)?\)$/);
  });
});

/**
 * Design: "A notice is fill only, with the tone's tint: neutral fill for neutral lines and a
 * warning tint for warning lines", and "one tint per tone ... Orange is the brand accent, not a
 * status colour." Every warning box reads what the node card's run failure reads: the warning
 * text on the warning tint, no border. They read these through tokens styles/becauseLine.css
 * overrides, so a because line in the same box reads neutral.
 */
describe('design: one look for every warning notice, a fill and no edge', () => {
  const ACCENT = /--sr-(?:accent|error|danger)|#ff5a1f|rgba?\(\s*255[ ,]+(?:90|180)[ ,]/i;
  const WARNING_BOXES = [
    'model-node__error',
    'commons-notice commons-notice--error',
    'chat-panel__notice',
    'line-box',
    'project-home__error',
    'provider-recovery-status',
    'settings-alert',
    'settings-apps__warnings',
    'character-studio-view__notice character-studio-view__notice--error',
    'character-studio-view__notice character-studio-view__notice--guard',
    'moodboard-studio__notice moodboard-studio__notice--error',
    'moodboard-studio__notice moodboard-studio__notice--warn',
    'batch-node__warning',
  ];
  const DRAWN = (prop: string, value: string) => /^\|border(?!-radius)/.test(prop) && !/^(?:none|0|0px)$/.test(value.replace(/\s*!important/, '').trim());
  const boxOf = (className: string) => {
    const box = document.createElement('div'); box.className = className; box.setAttribute('data-line-box', ''); document.body.appendChild(box); return box;
  };
  it.each(WARNING_BOXES)('%s: warning text on the warning tint, no border, no accent, error or orange', (className) => {
    const box = boxOf(className);
    const won = cascaded(box);
    expect(lineLook(box).color, 'text').toBe('var(--sr-warning)');
    expect(lineFill(box), 'fill').toContain('var(--sr-warning-soft)');
    expect([...won].filter(([prop, win]) => DRAWN(prop, win.value)).map(([prop]) => prop), 'a border').toEqual([]);
    const read = [...won].filter(([prop]) => /^\|(?:color|background[\w-]*|border[\w-]*|box-shadow|outline[\w-]*|--mb-notice-fill)$/.test(prop))
      .filter(([, win]) => ACCENT.test(win.value)).map(([prop, win]) => `${prop}: ${win.value}`);
    expect(read, 'a status look that is not the warning one').toEqual([]);
    box.remove();
  });
  it.each(['inspector__notice', 'inspector__notice inspector__notice--key', 'personal-agents__terms'])('%s: a neutral note is a fill, no border', (className) => {
    const box = boxOf(className);
    expect([...cascaded(box)].filter(([prop, win]) => DRAWN(prop, win.value)).map(([prop]) => prop), 'a border').toEqual([]);
    expect(lineFill(box)).toMatch(/^var\(--sr-surface-control(?:-hover)?\)$/);
    box.remove();
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
      // The backend writes curly apostrophes; the keys match with apostrophes folded (errorCopy's foldApostrophes).
      .map((file) => readFileSync(join(__dirname, '../../backend', file), 'utf8').replace(/’/g, "'")).join('\n');
    const { COMMONS_OFF_DETAIL } = await import('../src/lib/errorCopy');
    expect(backend).toContain(`detail="${COMMONS_OFF_DETAIL.replace(/’/g, "'")}"`);
    // Round 18d (review 14 LOW-4): the blob route's own 404, not a longer "… not found".
    expect(backend).toContain('detail="not found"');
    for (const detail of LOAD_BECAUSE.keys()) {
      // The gone line is built from its parts (refusal_copy.gone("reference", "references")).
      if (detail === 'not found') continue;
      if (detail.startsWith('That reference isn\'t there anymore')) { expect(backend).toContain("That {thing} isn't there anymore. Reload to get the latest {things}."); continue; }
      expect(backend, detail).toContain(detail.replace(/’/g, "'"));
    }
  });
});

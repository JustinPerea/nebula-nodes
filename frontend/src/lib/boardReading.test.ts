import { describe, expect, it } from 'vitest';
import type { MoodboardImage } from '../types';
import {
  FAILURE_COPY, LOCKED_NO_IMAGES, LOCKED_NO_ROUTE, LOCKED_NO_ROUTE_NOT_INSTALLED, aboutPrice, citationMap, copyText,
  elapsed, failureBody, metaLine, readProposalDetail, readProposalLine, routeLine, runningLine, shortPrice, staleLine,
  staleness, type BoardReading, type BoardReadingRouteState,
} from './boardReading';

// Read the board's words (GM's surface design, 2026-10-31): each line as GM
// wrote it, and the image-set staleness and citation numbering behind them.

const image = (id: string, extra: Partial<MoodboardImage> = {}): MoodboardImage => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, ...extra });

const reading = (ids: string[], extra: Partial<BoardReading> = {}): BoardReading => ({
  id: 'rd_1', markdown: '', model: 'gemini-4-argon', modelName: 'Gemini 4 Argon', route: 'antigravity',
  at: '2026-11-01T15:40:00', by: { kind: 'person' },
  imageSet: { fingerprint: 'f', images: ids.map((id) => ({ id, hash: `h-${id}`, url: `/api/outputs/${id}.png` })) },
  citations: ids.map((id, index) => ({ imageId: id, number: index + 1, file: `tile-${id}.png` })),
  cited: [], ...extra,
});

const route = (extra: Partial<BoardReadingRouteState> = {}): BoardReadingRouteState => ({
  antigravity: { installed: true, signedIn: true }, hasKey: true, route: 'antigravity', count: 15,
  model: { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  estimate: { low: 0.02, high: 0.05, unpriced: false, unconfirmed: false }, ...extra,
});

describe('route and cost lines (GM section 5) and locks (section 7)', () => {
  it('says the subscription is free with the plan', () => {
    expect(routeLine(route())).toEqual({ locked: false,
      text: 'Sends 15 images to Google through your Antigravity sign-in. Free with your plan.' });
  });

  it('gives the key route its list price', () => {
    expect(routeLine(route({ route: 'gemini_key', antigravity: { installed: false, signedIn: false } })).text)
      .toBe('Sends 15 images to Google with your Gemini API key. About $0.05.');
  });

  it('says why the key is used when Antigravity is installed but signed out', () => {
    expect(routeLine(route({ route: 'gemini_key', antigravity: { installed: true, signedIn: false } })).text)
      .toBe('Antigravity isn’t signed in, so this uses your Gemini API key. About $0.05.');
  });

  it('locks with no route, worded by whether Antigravity is installed', () => {
    expect(routeLine(route({ route: null, hasKey: false, antigravity: { installed: true, signedIn: false } })))
      .toEqual({ locked: true, text: LOCKED_NO_ROUTE });
    expect(LOCKED_NO_ROUTE).toBe('You can read the board after you sign in to Antigravity on this Mac or add a Gemini API key in Settings.');
    expect(routeLine(route({ route: null, hasKey: false, antigravity: { installed: false, signedIn: false } })))
      .toEqual({ locked: true, text: LOCKED_NO_ROUTE_NOT_INSTALLED });
    expect(LOCKED_NO_ROUTE_NOT_INSTALLED).toBe('You can read the board after you install Antigravity and sign in, or add a Gemini API key in Settings.');
  });

  it('locks with no images, before anything else', () => {
    expect(routeLine(route({ count: 0 }))).toEqual({ locked: true, text: LOCKED_NO_IMAGES });
    expect(LOCKED_NO_IMAGES).toBe('You can read the board after you add images.');
  });

  it('counts one image in the singular', () => {
    expect(routeLine(route({ count: 1 })).text).toBe('Sends 1 image to Google through your Antigravity sign-in. Free with your plan.');
  });

  it('prices to the cent and never below one; no price, no price line', () => {
    expect(aboutPrice(0.137)).toBe('About $0.14');
    expect(aboutPrice(0.0001)).toBe('About $0.01');
    expect(aboutPrice(null)).toBeNull();
    expect(shortPrice(0.05)).toBe('~$0.05');
    expect(routeLine(route({ route: 'gemini_key', antigravity: { installed: false, signedIn: false },
      estimate: { low: null, high: null, unpriced: true, unconfirmed: false } })).text)
      .toBe('Sends 15 images to Google with your Gemini API key.');
  });
});

describe('failures (GM section 7)', () => {
  it('words each cause as GM wrote it, and anything else as the shared fallback', () => {
    expect(failureBody('timeout')).toBe('Gemini didn’t answer in time. Try again.');
    expect(failureBody('signed_out')).toBe('Antigravity signed out during the read. Sign in again, then try again.');
    expect(failureBody('plan_limit')).toBe('Your Antigravity plan has reached its limit for now. Try again later, or use your Gemini API key.');
    expect(failureBody('key_refused')).toBe('Google refused your Gemini API key. Check it in Settings, then try again.');
    for (const cause of ['write_attempt', 'other', 'no_key', null] as const) {
      expect(failureBody(cause)).toBe('Try again, or reload if it keeps happening.');
    }
    expect(Object.keys(FAILURE_COPY).sort()).toEqual(['key_refused', 'plan_limit', 'signed_out', 'timeout']);
  });
});

describe('meta and running lines', () => {
  it('says whose reading, when and of how many images', () => {
    expect(metaLine(reading(Array.from({ length: 15 }, (_, i) => `i${i}`)), 'en-US'))
      .toBe('Gemini 4 Argon’s reading · Nov 1, 3:40 PM · 15 images');
  });

  it('counts the running read in minutes and seconds', () => {
    expect(runningLine(15)).toBe('Reading 15 images · ');
    expect(elapsed(42_400)).toBe('0:42');
    expect(elapsed(61_000)).toBe('1:01');
    expect(elapsed(-5)).toBe('0:00');
  });
});

describe('staleness by image set (GM section 4)', () => {
  const read = reading(['a', 'b', 'c']);

  it('is fresh while the image set is the same, whatever else changed', () => {
    const now = [image('a', { notes: 'changed' }), image('b'), image('c')];
    expect(staleness(read, now).stale).toBe(false);
  });

  it('counts added, removed, set aside and replaced', () => {
    const now = [image('a'), image('b', { excluded: true }), image('d'), image('e'),
      image('c', { url: '/api/outputs/c-new.png' })];
    const stale = staleness(read, now);
    expect(stale).toEqual({ stale: true, added: ['d', 'e'], removed: [], setAside: ['b'], replaced: ['c'] });
    expect(staleness(read, [image('a'), image('b')]).removed).toEqual(['c']);
    // A weight of 0 is set aside too.
    expect(staleness(read, [image('a'), image('b', { weight: 0 }), image('c')]).setAside).toEqual(['b']);
  });

  it('takes the server’s word on a file replaced on disk', () => {
    expect(staleness(read, [image('a'), image('b'), image('c')], ['b']).replaced).toEqual(['b']);
  });

  it('words only the clauses that apply', () => {
    const none = { stale: true, added: [], removed: [], setAside: [], replaced: [] };
    expect(staleLine({ ...none, added: ['d', 'e'], removed: ['c'] }))
      .toBe('The board changed after this reading. 2 images were added and 1 was removed.');
    expect(staleLine({ ...none, replaced: ['c'] })).toBe('The board changed after this reading. 1 image was replaced.');
    expect(staleLine({ ...none, added: ['d'], removed: ['c', 'b'], setAside: ['a'] }))
      .toBe('The board changed after this reading. 1 image was added, 2 were removed and 1 was set aside.');
  });
});

describe('citations', () => {
  const read = reading(['a', 'b', 'c'], {
    markdown: 'Warm light in `tile-a.png` and images/tile-c.png, unlike TILE-B.PNG. And tile-zz.png.' });

  it('numbers each cited tile as the board is now', () => {
    const map = citationMap(read, [image('c'), image('a'), image('b')]);
    expect(map.get('tile-a.png')).toMatchObject({ imageId: 'a', number: 2, onBoard: true });
    expect(map.get('tile-c.png')).toMatchObject({ imageId: 'c', number: 1, onBoard: true });
  });

  it('keeps a removed tile’s number from when it was read', () => {
    const map = citationMap(read, [image('a'), image('b')]);
    expect(map.get('tile-c.png')).toMatchObject({ number: 3, onBoard: false, url: null });
  });

  it('copies the markdown with #N, saying which were removed; an unknown name stays', () => {
    expect(copyText(read, [image('a'), image('b')]))
      .toBe('Warm light in #1 and #3 (removed from the board), unlike #2. And tile-zz.png.');
  });
});

describe('the agent proposal (GM section 6)', () => {
  it('says what it reads and what it sends, at the list price', () => {
    const change = { modelName: 'Gemini 4 Argon', images: 15, cost: { high: 0.05 } };
    expect(readProposalLine(change)).toBe('Read the board with Gemini 4 Argon');
    expect(readProposalDetail(change)).toBe('Sends 15 images to Google · ~$0.05');
    expect(readProposalDetail({ ...change, cost: null })).toBe('Sends 15 images to Google');
  });
});

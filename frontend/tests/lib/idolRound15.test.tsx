// PR #203 round 15: GM r28 and r29, review 14 (copy MEDIUM-1, LOW-1).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { mergedNotReadyLine, notReadyShown, type ProposalNotReady } from '../../src/lib/canvasProposals';
import { addKeyLine, keyPhrase, KEY_NAMES } from '../../src/lib/directRoute';
import { keychainKeptLine } from '../../src/lib/settingsWrites';
import { modelKeyMissingText } from '../../src/lib/failureLines';
import { DetailsBox } from '../../src/components/canvas/DetailsBox';
import { hasMoreBelow } from '../../src/lib/hasMoreBelow';
import { NOT_READY_REASONS, reasonFor } from '../helpers/notReadyReasons';

afterEach(cleanup);

const ANTHROPIC = 'needs your Anthropic API key. Add it in Settings.';
const row = (ref: string, name: string, one: string, many?: string): ProposalNotReady => ({
  ref, nodeId: null, name, missing: `needs X (${ref})`, person: `“${name}” ${one}`,
  reason: reasonFor(`“${name}” ${one}`) ?? (many ? { one, many } : undefined),
});
const texts = (rows: ProposalNotReady[]) => notReadyShown(rows, null);

describe('different names with the same reason merge into one line (GM r28)', () => {
  it('two names, one reason: one line, the plural verb', () => {
    const { lines } = texts([row('+w', 'Writer', ANTHROPIC), row('+e', 'Editor', ANTHROPIC)]);
    expect(lines.map((line) => line.text)).toEqual(['“Writer” and “Editor” need your Anthropic API key. Add it in Settings.']);
  });

  it('three names, one reason', () => {
    const { lines } = texts([row('+a', 'A', ANTHROPIC), row('+b', 'B', ANTHROPIC), row('+c', 'C', ANTHROPIC)]);
    expect(lines.map((line) => line.text)).toEqual(['“A”, “B” and “C” need your Anthropic API key. Add it in Settings.']);
  });

  it('four or more nodes with one reason are counted, in the details', () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((name) => row(`+${name}`, name, ANTHROPIC));
    const { lines, inDetails } = texts(rows);
    expect(lines.map((line) => line.text)).toEqual(['5 nodes can’t run here yet.']);
    expect(inDetails.map((line) => line.text)).toEqual(['5 nodes need your Anthropic API key. Add it in Settings.']);
  });

  it('a same-name group joins as its own item', () => {
    const { lines } = texts([row('+c1', 'Claude', ANTHROPIC), row('+c2', 'Claude', ANTHROPIC), row('+w', 'Writer', ANTHROPIC)]);
    expect(lines.map((line) => line.text)).toEqual(['2 “Claude” nodes and “Writer” need your Anthropic API key. Add it in Settings.']);
  });

  it('two reasons side by side keep a line each, each merged', () => {
    const plan = 'needs your Krea plan. Sign in to Krea in Settings.';
    const { lines } = texts([row('+w', 'Writer', ANTHROPIC), row('+k', 'Krea 2', plan), row('+e', 'Editor', ANTHROPIC)]);
    expect(lines.map((line) => line.text)).toEqual([
      '“Writer” and “Editor” need your Anthropic API key. Add it in Settings.',
      '“Krea 2” needs your Krea plan. Sign in to Krea in Settings.',
    ]);
  });

  it('the verb agrees: "needs" for one, "need" for more', () => {
    expect(texts([row('+w', 'Writer', ANTHROPIC)]).lines[0].text).toBe('“Writer” needs your Anthropic API key. Add it in Settings.');
    expect(texts([row('+w', 'Writer', ANTHROPIC), row('+w2', 'Writer', ANTHROPIC)]).lines[0].text)
      .toBe('2 “Writer” nodes need your Anthropic API key. Add it in Settings.');
  });

  it('merges by the reason the backend sent, never by the words', () => {
    // The same words with no reason (a route's own line, an older backend): a line each.
    const bare = (ref: string, name: string): ProposalNotReady =>
      ({ ref, nodeId: null, name, missing: 'x', person: `“${name}” ${ANTHROPIC}` });
    expect(texts([bare('+w', 'Writer'), bare('+e', 'Editor')]).lines.map((line) => line.text)).toEqual([
      '“Writer” needs your Anthropic API key. Add it in Settings.', '“Editor” needs your Anthropic API key. Add it in Settings.']);
  });
});

describe('every reason the registry gives, for one node and for several (review 14, copy LOW-1)', () => {
  it.each(NOT_READY_REASONS.map((reason) => [reason.line, reason] as const))('%s', (_line, reason) => {
    const one = { ...reason, ref: '+a', nodeId: null, missing: 'x', person: reason.line, reason: { one: reason.one, many: reason.many } };
    expect(reason.line.startsWith(`“${reason.name}” `)).toBe(true);
    expect(texts([one]).lines.map((line) => line.text)).toEqual([reason.line]);
    expect(texts([one, { ...one, ref: '+b', name: 'Other' }]).lines.map((line) => line.text))
      .toEqual([`“${reason.name}” and “Other” ${reason.many}`]);
    // The plural never keeps a singular subject's words.
    expect(reason.many).not.toMatch(/^(needs|is|isn’t|has) |\bits (list|provider)\b|\bthe node’s\b|\bit doesn’t\b/);
  });

  it('the switcher and Replicate lines read GM r29’s words in both forms', () => {
    const unknown = NOT_READY_REASONS.find((reason) => reason.one.startsWith('is set to a provider that'))!;
    expect(mergedNotReadyLine(['N'], unknown)).toBe('“N” is set to a provider that isn’t in its list. Choose one in its provider switcher.');
    expect(mergedNotReadyLine(['N', 'N'], unknown))
      .toBe('2 “N” nodes are set to a provider that isn’t in their list. Choose one in each node’s provider switcher.');
    expect(NOT_READY_REASONS.some((reason) => /Add its key/.test(reason.one))).toBe(false);
  });
});

describe('the one add-key line (GM r28 item 3)', () => {
  it('says each key from the noun source, a sentence with its period', () => {
    expect(addKeyLine(['REPLICATE_API_TOKEN'])).toBe('Add your Replicate token in Settings.');
    expect(addKeyLine(['GOOGLE_VERTEX_CREDENTIALS'])).toBe('Add your Vertex AI service account key in Settings.');
    for (const key of Object.keys(KEY_NAMES)) expect(addKeyLine([key])).toBe(`Add your ${keyPhrase([key])} in Settings.`);
    expect(modelKeyMissingText('X', ['REPLICATE_API_TOKEN'])).toBe("Couldn't set up “X”. Add your Replicate token in Settings.");
  });

  it('never puts "Google ·" in front of Vertex outside the Settings row', () => {
    expect(keyPhrase(['GOOGLE_VERTEX_CREDENTIALS'])).toBe('Vertex AI service account key');
  });
});

describe('the Keychain lines say what Nebula is using now (GM r28 item 2)', () => {
  it.each([
    ['save-over', 'Nebula couldn’t save this key and is still using the one it had. Your Keychain has the new one. Try again, or remove it.',
      'Nebula couldn’t save your OpenAI API key and is still using the one it had. Your Keychain has the new one. Try again, or remove it.'],
    ['save-new', 'Nebula couldn’t save this key, but your Keychain has it. Try again, or remove it.',
      'Nebula couldn’t save your OpenAI API key, but your Keychain has it. Try again, or remove it.'],
    ['removal', 'Nebula removed this key from your Keychain but is still using it. Try again.',
      'Nebula removed your OpenAI API key from your Keychain but is still using it. Try again.'],
  ] as const)('%s, beside the row and as a notice', (kind, row, notice) => {
    expect(keychainKeptLine(kind, 'OPENAI_API_KEY', 'row')).toBe(row);
    expect(keychainKeptLine(kind, 'OPENAI_API_KEY', 'notice')).toBe(notice);
  });

  it('names a token a token as a notice', () => {
    expect(keychainKeptLine('removal', 'REPLICATE_API_TOKEN', 'notice'))
      .toBe('Nebula removed your Replicate token from your Keychain but is still using it. Try again.');
  });

  it('a newer refusal’s fix sentence replaces "Try again, or remove it." (GM r29 item 6)', () => {
    expect(keychainKeptLine('save-over', 'OPENAI_API_KEY', 'row', 'Fix “apiKeys” in ~/.nebula/settings.json, then try again.'))
      .toBe('Nebula couldn’t save this key and is still using the one it had. Your Keychain has the new one. '
        + 'Fix “apiKeys” in ~/.nebula/settings.json, then try again.');
    expect(keychainKeptLine('removal', 'OPENAI_API_KEY', 'row', 'Fix the file, then try again.'))
      .toBe('Nebula removed this key from your Keychain but is still using it. Fix the file, then try again.');
  });
});

describe('the details box (GM r28)', () => {
  it('has more below only before the end, wherever the cut falls', () => {
    expect(hasMoreBelow({ scrollTop: 0, clientHeight: 100, scrollHeight: 240 })).toBe(true);
    // A cut between two lines is still a cut: 40 px left.
    expect(hasMoreBelow({ scrollTop: 100, clientHeight: 100, scrollHeight: 240 })).toBe(true);
    expect(hasMoreBelow({ scrollTop: 140, clientHeight: 100, scrollHeight: 240 })).toBe(false);
    expect(hasMoreBelow({ scrollTop: 139.5, clientHeight: 100, scrollHeight: 240 })).toBe(false);
    expect(hasMoreBelow({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 })).toBe(false);
  });

  it('is a focusable region named "Details" whose fade follows the scroll', () => {
    render(<DetailsBox><p>line</p></DetailsBox>);
    const box = screen.getByRole('region', { name: 'Details' });
    expect(box).toHaveAttribute('tabindex', '0');
    box.focus();
    expect(box).toHaveFocus();
    let top = 0;
    Object.defineProperties(box, {
      scrollHeight: { configurable: true, get: () => 240 },
      clientHeight: { configurable: true, get: () => 100 },
      scrollTop: { configurable: true, get: () => top },
    });
    fireEvent.scroll(box);
    expect(box).toHaveAttribute('data-more', 'true');
    expect(box.querySelector('.proposal-bar__details-fade')).toHaveAttribute('aria-hidden', 'true');
    top = 140;
    fireEvent.scroll(box);
    expect(box).not.toHaveAttribute('data-more');
  });
});

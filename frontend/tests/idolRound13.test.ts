/**
 * PR #203 round 13: GM r24.
 *
 * - Item 3: the Krea mode label is "API key · API balance".
 * - Item 6: the not-ready nodes follow the shared rule: up to 3 a line each,
 *   from 4 one line that counts them ("4 nodes can’t run here yet.").
 * GM r25 item 3: every provider's notices say its own noun, the word its
 * link uses ("Replicate token saved."). Review 12, copy LOW-1: the
 * screen-reader name says the noun once ("Krea · API key").
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { notReadyShown } from '../src/lib/canvasProposals';
import { agentNameList, countsInstead, nodeNameList, quotedNames } from '../src/lib/errorCopy';
import { credentialName, credentialNoun, LINK_NOUNS, PROVIDER_KEYS } from '../src/lib/providerCatalog';
import { keyChangedLine, keyNoun } from '../src/lib/settingsWrites';
import { keyPhrase, missingKeyLine } from '../src/lib/directRoute';
import { modelKeyMissingText } from '../src/lib/failureLines';
import type { ProposalNotReady } from '../src/lib/wsClient';

const SRC = resolve(__dirname, '../src');

describe('the Krea mode label (GM r24 item 3)', () => {
  it('says "API key · API balance" in every Krea node and in Settings', () => {
    const labels = new Set(Object.values(NODE_DEFINITIONS).flatMap((definition) =>
      (definition.params ?? []).filter((param) => param.key === '_kreaAuth')
        .flatMap((param) => (param.options ?? []).map((option) => option.label))));
    expect(labels).toContain('API key · API balance');
    expect(labels).not.toContain('API token · API balance');
    const row = readFileSync(resolve(SRC, 'components/panels/settings/KreaSignInRow.tsx'), 'utf8');
    expect(row).toContain('<option value="api-token">API key · API balance</option>');
  });
});

describe('the not-ready nodes by the shared rule (GM r24 item 6)', () => {
  const rows = (count: number): ProposalNotReady[] => ['a', 'b', 'c', 'd', 'e'].slice(0, count).map((ref) => ({
    ref: `+${ref}`, nodeId: null, name: ref.toUpperCase(), missing: `needs ${ref.toUpperCase()}_KEY`,
    person: `“${ref.toUpperCase()}” needs your key. Add it in Settings.`,
  }));

  it('names up to 3, a line each, with nothing in the details', () => {
    const shown = notReadyShown(rows(3), null);
    expect(shown.lines.map((line) => line.text)).toEqual([
      '“A” needs your key. Add it in Settings.', '“B” needs your key. Add it in Settings.', '“C” needs your key. Add it in Settings.']);
    expect(shown.inDetails).toEqual([]);
  });

  it.each([4, 5])('counts %i in one line and puts every line in the details', (count) => {
    const shown = notReadyShown(rows(count), null);
    expect(shown.lines.map((line) => line.text)).toEqual([`${count} nodes can’t run here yet.`]);
    expect(shown.inDetails).toHaveLength(count);
  });

  it('counts nodes, not the lines a key lock merges', () => {
    const locked = rows(4).map((row) => ({ ...row, routeKeyLine: true as const }));
    const shown = notReadyShown(locked, 'You can accept this after you add your Hugging Face token in Settings.');
    // The Accept line stays in view beside the count (review 13, copy NIT-3).
    expect(shown.lines.map((line) => line.text)).toEqual(['4 nodes can’t run here yet.',
      'You can accept this after you add your Hugging Face token in Settings.']);
    expect(shown.inDetails.map((line) => line.text)).toEqual(['You can accept this after you add your Hugging Face token in Settings.']);
    expect(notReadyShown(locked.slice(0, 3), 'Lock line.').lines.map((line) => line.text)).toEqual(['Lock line.']);
  });

  it('is the one rule every name list reads', () => {
    expect([3, 4].map(countsInstead)).toEqual([false, true]);
    expect(nodeNameList(['A', 'B', 'C'])).toBe('“A”, “B” and “C”');
    expect(nodeNameList(['A', 'B', 'C', 'D'])).toBe('4 nodes');
    expect(agentNameList(['A', 'B', 'C', 'D'])).toBe('4 agents');
    expect(quotedNames(['A', 'B', 'C', 'D'], 'shots')).toBe('4 shots');
  });
});

describe('every provider says the word its link uses (GM r25 item 3)', () => {
  it.each(PROVIDER_KEYS.map((spec) => [spec.key, spec] as const))('%s', (key, spec) => {
    const linkWord = LINK_NOUNS[/ (keys|tokens|service accounts)$/.exec(spec.keyLink)![1]];
    // The notice and the name end in the link's word ("Krea · API key" ends in "key").
    expect(keyNoun(key).endsWith(` ${linkWord}`), keyNoun(key)).toBe(true);
    expect(keyChangedLine(key, true)).toBe(`${keyNoun(key)} saved.`);
    expect(credentialName(spec).endsWith(` ${linkWord}`), credentialName(spec)).toBe(true);
    expect(credentialNoun(spec)).toBe(linkWord);
    // Said once: never "key key", "API API" or "token key".
    expect(credentialName(spec)).not.toMatch(/\b(\w+) \1\b|key key|token key|API API/i);
    // Round 14 (GM r26 item 5): the run-failure lines say the same noun,
    // the backend's person_line.KEY_NAMES included (route_tables.json pins
    // it to KEY_NAMES here): "Add your Replicate token in Settings."
    // GM r28 item 1 (PR #203 round 15): Vertex too, no exception left.
    const phrase = keyPhrase([key])!;
    expect(phrase.endsWith(` ${linkWord}`), phrase).toBe(true);
    expect(missingKeyLine([key])).toBe(`Add your ${phrase} in Settings, then run the node again.`);
    expect(modelKeyMissingText('X', [key])).toBe(`Couldn't set up “X”. Add your ${phrase} in Settings.`);
  });

  it('says "Add your Replicate token in Settings." on a run failure and in the model picker (GM r26 item 5)', () => {
    expect(missingKeyLine(['REPLICATE_API_TOKEN'])).toBe('Add your Replicate token in Settings, then run the node again.');
    expect(modelKeyMissingText('X', ['REPLICATE_API_TOKEN'])).toBe("Couldn't set up “X”. Add your Replicate token in Settings.");
  });

  it('gives a link word one noun: tokens a token, keys and service accounts a key', () => {
    expect(LINK_NOUNS).toEqual({ keys: 'key', tokens: 'token', 'service accounts': 'key' });
    const nouns = Object.fromEntries(PROVIDER_KEYS.map((spec) => [spec.key, credentialNoun(spec)]));
    expect(Object.keys(nouns).filter((key) => nouns[key] === 'token').sort()).toEqual(['HF_TOKEN', 'REPLICATE_API_TOKEN']);
  });

  it('says "Replicate token saved." / "Replicate token removed."', () => {
    expect(keyChangedLine('REPLICATE_API_TOKEN', true)).toBe('Replicate token saved.');
    expect(keyChangedLine('REPLICATE_API_TOKEN', false)).toBe('Replicate token removed.');
    expect(keyChangedLine('HF_TOKEN', true)).toBe('Hugging Face token saved.');
    expect(keyChangedLine('FAL_KEY', true)).toBe('fal.ai key saved.');
  });

  it('names each credential once for screen readers', () => {
    const named = Object.fromEntries(PROVIDER_KEYS.map((spec) => [spec.key, credentialName(spec)]));
    expect(named).toMatchObject({
      KREA_API_TOKEN: 'Krea · API key', KREA_USAGE_KEY: 'Krea · usage key', GOOGLE_API_KEY: 'Google · Gemini API key',
      HF_TOKEN: 'Hugging Face token', REPLICATE_API_TOKEN: 'Replicate token', OPENAI_API_KEY: 'OpenAI API key',
      GOOGLE_VERTEX_CREDENTIALS: 'Google · Vertex AI service account key',
    });
  });
});

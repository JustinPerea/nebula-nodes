import { describe, expect, it } from 'vitest';
import { credentialNoun, PROVIDER_KEYS } from '../src/lib/providerCatalog';
import { credentialNounFor } from '../src/lib/credentialNoun';
import { PROVIDER_KEY_LABELS } from '../src/lib/providerReadiness';

// providerCatalog (every key's URL, notes and instructions) loads with Settings; the canvas's
// provider switcher reads lib/credentialNoun and Settings' rows read the catalog's link word.
// These hold the two together (PR #203, entry budget).
describe('the credential noun the canvas reads is the catalog\'s link word', () => {
  it.each(PROVIDER_KEYS.map((spec) => [spec.key, credentialNoun(spec)] as const))('%s is a %s', (key, noun) => {
    expect(credentialNounFor(key)).toBe(noun);
  });

  it('says "key" for a key it does not know, as the switcher always did', () => {
    expect(credentialNounFor('SOMETHING_NEW')).toBe('key');
    expect(credentialNounFor(undefined)).toBe('key');
  });

  it('every catalog key has a label the connected-rows read (Settings\' row state) and no label lacks a row', () => {
    expect(Object.keys(PROVIDER_KEY_LABELS).sort()).toEqual(PROVIDER_KEYS.map((spec) => spec.key).sort());
  });
});

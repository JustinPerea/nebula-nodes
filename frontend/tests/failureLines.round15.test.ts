import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { envKeyNames } from '../src/lib/directRoute';
import { modelKeyMissingText, modelSettingsFailedText } from '../src/lib/failureLines';

// Design, verbatim: the model
// pickers' line when the provider's key isn't set names the key to add;
// "Nebula couldn’t load the model settings for “X”." stays for when the key is
// there and reading the provider's settings failed.
describe("the model pickers' lines", () => {
  const keysOf = (id: string) => envKeyNames(NODE_DEFINITIONS[id]);
  it('OpenRouter', () => {
    expect(modelKeyMissingText('X', keysOf('openrouter-universal'))).toBe('Nebula couldn’t set up “X” because it needs an OpenRouter API key. Add one in Settings.');
  });
  it('Replicate', () => {
    expect(modelKeyMissingText('X', keysOf('replicate-universal'))).toBe('Nebula couldn’t set up “X” because it needs a Replicate token. Add one in Settings.');
  });
  it('the key there, the read failed', () => {
    expect(modelSettingsFailedText('X')).toBe("Nebula couldn’t load the model settings for “X”.");
  });
});

import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { envKeyNames } from '../src/lib/directRoute';
import { modelKeyMissingText, modelSettingsFailedText } from '../src/lib/failureLines';

// Review 14, L-F: GM - Design, round 15, item 1, verbatim. The model
// pickers' line when the provider's key isn't set names the key to add;
// "Couldn't load the model settings for “X”." stays for when the key is
// there and reading the provider's settings failed.
describe("GM round 15, item 1: the model pickers' lines", () => {
  const keysOf = (id: string) => envKeyNames(NODE_DEFINITIONS[id]);
  it('OpenRouter', () => {
    expect(modelKeyMissingText('X', keysOf('openrouter-universal'))).toBe("Couldn't set up “X”. Add your OpenRouter API key in Settings.");
  });
  it('Replicate', () => {
    expect(modelKeyMissingText('X', keysOf('replicate-universal'))).toBe("Couldn't set up “X”. Add your Replicate API key in Settings.");
  });
  it('the key there, the read failed', () => {
    expect(modelSettingsFailedText('X')).toBe("Couldn't load the model settings for “X”.");
  });
});

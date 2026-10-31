/**
 * One "the key is set" for the agent gate, the run's handler and Settings
 * (review 7 of PR #203, NIT-4). Before, a token of only a byte-order mark or
 * a zero-width space was "may bill" to the gate (Python strip keeps them),
 * a bad character to the handler, and unset in Settings (JS trim strips a
 * BOM). The backend's twin (node_route.key_text) reads the same cases.
 */
import { describe, expect, it } from 'vitest';
import shared from '../../backend/tests/fixtures/key_text_cases.json';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { isKeySet, keyBilling, keyText } from '../src/lib/directRoute';

const IDOL = NODE_DEFINITIONS['speridlabs-idol'];

describe('keyText', () => {
  it.each(shared.cases.map((row) => [JSON.stringify(row.raw), row] as const))('reads %s as the shared case says', (_name, row) => {
    expect(keyText(row.raw)).toBe(row.text);
  });

  it.each(['﻿', '​', ' ⁠﻿\n', ' '])('an invisible-only token is unset, so Idol is free (%j)', (token) => {
    expect(isKeySet({ HF_TOKEN: token }, 'HF_TOKEN')).toBe(false);
    expect(keyBilling(IDOL, {}, { HF_TOKEN: token })).toBe('free');
  });

  it('a padded token is set, so Idol may cost', () => {
    const keys = { HF_TOKEN: '﻿hf_abcdef​\n' };
    expect(isKeySet(keys, 'HF_TOKEN')).toBe(true);
    expect(keyText(keys.HF_TOKEN)).toBe('hf_abcdef');
    expect(keyBilling(IDOL, {}, keys)).toBe('mayCost');
  });
});

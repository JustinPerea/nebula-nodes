import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { paramDefaultFor, snapParamDefaults, withParamDefaults } from '../../src/lib/paramDefaults';
import type { ParamDefinition } from '../../src/types';

const CLAUDE = NODE_DEFINITIONS['claude-chat'];
const GPT = NODE_DEFINITIONS['gpt-4o-chat'];
const GEMINI = NODE_DEFINITIONS['gemini-chat'];
const param = (def: typeof CLAUDE, key: string) => def.params.find((p) => p.key === key) as ParamDefinition;
const backend = JSON.parse(readFileSync(join(__dirname, '../../../backend/data/node_definitions.json'), 'utf8')) as
  Record<string, { params: ParamDefinition[] }>;

describe('per-model defaults (defaultBy)', () => {
  it.each([
    ['claude-chat', 'max_tokens'],
    ['gpt-4o-chat', 'max_completion_tokens'],
    ['gemini-chat', 'max_tokens'],
  ])('%s.%s matches the backend definition', (id, key) => {
    const front = NODE_DEFINITIONS[id].params.find((p) => p.key === key);
    const back = backend[id].params.find((p) => p.key === key);
    expect(front?.defaultBy).toEqual(back?.defaultBy);
    expect([front?.default, front?.max]).toEqual([back?.default, back?.max]);
  });

  it('resolves the default for the selected model', () => {
    expect(paramDefaultFor(CLAUDE, param(CLAUDE, 'max_tokens'), { model: 'claude-opus-5-5' })).toBe(64000);
    expect(paramDefaultFor(CLAUDE, param(CLAUDE, 'max_tokens'), { model: 'claude-sonnet-4-6' })).toBe(4096);
    // No model: the default model, Opus 5.5, whose value is the static default.
    expect(paramDefaultFor(CLAUDE, param(CLAUDE, 'max_tokens'), {})).toBe(64000);
    expect(paramDefaultFor(GPT, param(GPT, 'max_completion_tokens'), { model: 'gpt-6-sol' })).toBe(25000);
    expect(paramDefaultFor(GEMINI, param(GEMINI, 'max_tokens'), { model: 'gemini-4-argon' })).toBe(65536);
    expect(paramDefaultFor(GEMINI, param(GEMINI, 'max_tokens'), { model: 'gemini-3.6-flash' })).toBe(8192);
  });

  it('gives a new node the default for the model it is made with, unless that value was given', () => {
    const base = { model: 'claude-opus-5-5', max_tokens: 4096, temperature: 1 };
    expect(withParamDefaults(CLAUDE, base, { model: 'claude-opus-5-5' })).toEqual({ ...base, max_tokens: 64000 });
    expect(withParamDefaults(CLAUDE, base, { model: 'claude-opus-5-5', max_tokens: 4096 })).toBe(base);
    const plain = { model: 'claude-sonnet-4-6', max_tokens: 4096 };
    expect(withParamDefaults(CLAUDE, plain, {})).toBe(plain);
  });

  it('moves an untouched value to the new model default and says so', () => {
    const before = { model: 'claude-sonnet-4-6', max_tokens: 4096 };
    const up = snapParamDefaults(CLAUDE, before, { ...before, model: 'claude-opus-5-5' });
    expect(up.params).toEqual({ model: 'claude-opus-5-5', max_tokens: 64000 });
    expect(up.notes).toEqual([{ param: 'max_tokens', text: 'Max Tokens moved to 64,000, the Claude Opus 5.5 default.' }]);
    const back = snapParamDefaults(CLAUDE, up.params, { ...up.params, model: 'claude-sonnet-4-6' });
    expect(back.params).toEqual(before);
    expect(back.notes[0].text).toBe('Max Tokens moved to 4,096, the Claude Sonnet 4.6 default.');
  });

  it('keeps an edited value and says what the new default is', () => {
    const before = { model: 'claude-sonnet-4-6', max_tokens: 10000 };
    const snap = snapParamDefaults(CLAUDE, before, { ...before, model: 'claude-fable-5-1' });
    expect(snap.params).toEqual({ model: 'claude-fable-5-1', max_tokens: 10000 });
    // The status suffix "(flagship)" isn't part of the name.
    expect(snap.notes[0].text).toBe('Max Tokens stays at 10,000, the value you set. The Claude Fable 5.1 default is 64,000.');
  });

  it('says nothing when both models share a default, or another param changed', () => {
    const before = { model: 'claude-opus-5-5', max_tokens: 64000 };
    expect(snapParamDefaults(CLAUDE, before, { ...before, model: 'claude-haiku-5-5' }))
      .toEqual({ params: { model: 'claude-haiku-5-5', max_tokens: 64000 }, notes: [] });
    const edit = { ...before, max_tokens: 500 };
    expect(snapParamDefaults(CLAUDE, before, edit)).toEqual({ params: edit, notes: [] });
    const gem = { model: 'gemini-3.6-flash', max_tokens: 8192 };
    expect(snapParamDefaults(GEMINI, gem, { ...gem, model: 'gemini-3.8-flash' }).notes).toEqual([]);
  });

  it('says nothing when the value already equals the new model default', () => {
    // A node saved before defaultBy existed: Haiku 5.5 at 4096, moving to Sonnet 4.6 (default 4096).
    const before = { model: 'claude-haiku-5-5', max_tokens: 4096 };
    expect(snapParamDefaults(CLAUDE, before, { ...before, model: 'claude-sonnet-4-6' }))
      .toEqual({ params: { model: 'claude-sonnet-4-6', max_tokens: 4096 }, notes: [] });
  });

  it('fills a missing value on a model change (a Create draft before any edit)', () => {
    // No stored model is the default model, Argon.
    const snap = snapParamDefaults(GEMINI, {}, { model: 'gemini-3.6-flash' });
    expect(snap.params).toEqual({ model: 'gemini-3.6-flash', max_tokens: 8192 });
    expect(snap.notes[0].text).toBe('Max Tokens moved to 8,192, the Gemini 3.6 Flash default.');
  });
});

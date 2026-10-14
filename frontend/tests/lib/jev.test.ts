import { describe, expect, it } from 'vitest';
import shared from '../../../backend/tests/fixtures/jev_outputs.json';
import backendCatalog from '../../../backend/data/node_definitions.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import {
  JEV_BOX, JEV_DECIDE, JEV_NODE_IDS, JEV_PICK_BEST, isJevNode, parseJevBox, parseJevNumber, parseJevOutputs,
  parseJevReport,
} from '../../src/lib/jev';

type Sample = { name: string; outputs: Record<string, unknown>; parsed: unknown };
const fixture = shared as unknown as {
  decide: Sample[]; pickBest: Sample[]; box: Sample[];
  malformed: (Sample & { definitionId: string })[];
};

describe('Jev output contract (shared fixture)', () => {
  // backend/tests/test_jev_decide.py checks the Decide handler writes these
  // exact outputs, so a format change on either side fails one of the two.
  it.each(fixture.decide.map((s) => [s.name, s] as const))('decide: %s', (_name, sample) => {
    expect(parseJevOutputs(JEV_DECIDE, sample.outputs)).toEqual(sample.parsed);
  });

  it.each(fixture.pickBest.map((s) => [s.name, s] as const))('pick best: %s', (_name, sample) => {
    expect(parseJevOutputs(JEV_PICK_BEST, sample.outputs)).toEqual(sample.parsed);
  });

  it.each(fixture.box.map((s) => [s.name, s] as const))('box: %s', (_name, sample) => {
    expect(parseJevOutputs(JEV_BOX, sample.outputs)).toEqual(sample.parsed);
  });

  it.each(fixture.malformed.map((s) => [s.name, s] as const))('malformed gives null: %s', (_name, sample) => {
    expect(parseJevOutputs(sample.definitionId, sample.outputs)).toBeNull();
  });

  it('keeps a box confidence of null as null', () => {
    const sample = fixture.box.find((s) => s.name.includes('not reported'))!;
    const result = parseJevOutputs(JEV_BOX, sample.outputs);
    expect(result?.kind === 'box' && result.box?.confidence).toBeNull();
  });
});

describe('Jev parsers never throw', () => {
  const junk: unknown[] = [null, undefined, 0, 'x', [], {}, { answer: 5 }, { pass: { value: {} } }];

  it('returns null for anything that is not a Jev result', () => {
    for (const id of [...JEV_NODE_IDS, 'nano-banana', 42]) {
      for (const outputs of junk) expect(parseJevOutputs(id, outputs)).toBeNull();
    }
  });

  it('accepts bare strings as well as port values', () => {
    const sample = fixture.decide[0];
    const bare = Object.fromEntries(Object.entries(sample.outputs).map(([port, entry]) => [port, (entry as { value: string }).value]));
    expect(parseJevOutputs(JEV_DECIDE, bare)).toEqual(sample.parsed);
  });

  it('keeps the result when only the report is unreadable', () => {
    const sample = fixture.decide[0];
    const result = parseJevOutputs(JEV_DECIDE, { ...sample.outputs, report: { type: 'Text', value: 'no fields here\noops' } });
    expect(result).toMatchObject({ kind: 'decide', report: null });
  });

  it('reads numbers, boxes and reports defensively', () => {
    expect(parseJevNumber('0.93')).toBe(0.93);
    expect(parseJevNumber('1')).toBe(1);
    for (const bad of ['1.5', '-0.1', 'NaN', '', '0.9e1', 0.5]) expect(parseJevNumber(bad)).toBeNull();
    expect(parseJevBox('null')).toBeNull();
    for (const bad of ['{', '[]', '{"top": 0.5, "bottom": 0.2, "left": 0, "right": 1}', 5]) expect(parseJevBox(bad)).toBeUndefined();
    expect(parseJevReport('Title\nModel: jev-1.14.0 (asked for jev-latest)\nInput tokens: unknown\nNote: hi')).toEqual({
      title: 'Title', fields: { Model: 'jev-1.14.0 (asked for jev-latest)', 'Input tokens': 'unknown' },
      notes: ['hi'], model: 'jev-1.14.0', inputTokens: null,
    });
    expect(parseJevReport('Title\nInput tokens: 3')).toBeNull();
  });

  it('knows the Jev node ids', () => {
    expect(isJevNode('jev-decide')).toBe(true);
    expect(isJevNode('jev-decider')).toBe(false);
  });
});

describe('Jev node definitions', () => {
  it('mirror the backend catalog exactly', () => {
    const catalog = backendCatalog as Record<string, unknown>;
    for (const id of JEV_NODE_IDS) {
      if (!(id in NODE_DEFINITIONS) && !(id in catalog)) continue; // added by a later change
      expect(NODE_DEFINITIONS[id], id).toEqual(catalog[id]);
    }
  });

  it('declare the contract ports', () => {
    const decide = NODE_DEFINITIONS[JEV_DECIDE];
    expect(decide.outputPorts.map((port) => port.id)).toEqual(['answer', 'pass', 'probability', 'confidence', 'probabilities', 'report']);
    expect(decide.outputPorts.every((port) => port.dataType === 'Text')).toBe(true);
    expect(decide.envKeyName).toBe('TYPESAFE_API_KEY');
    expect(decide.description).toMatch(/judge/i);
  });
});

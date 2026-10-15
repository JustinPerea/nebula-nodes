import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  decideMode, formatJevPercent, isCloseCall, jevRunCost, judgedImages, matchingCandidates, numberParam,
  probabilityRows, requestedAlias, upstreamPortValues, verdictLabel,
} from '../../src/lib/jevView';
import type { JevDecideResult, JevReport } from '../../src/lib/jev';

const report = (title: string, fields: Record<string, string> = {}): JevReport => ({
  title, fields: { Model: 'jev-1.14.0', 'Input tokens': '312', ...fields }, notes: [], model: 'jev-1.14.0', inputTokens: 312,
});
const decide = (patch: Partial<JevDecideResult> = {}): JevDecideResult => ({
  kind: 'decide', answer: 'yes', pass: 'true', probability: 0.9, confidence: 0.8,
  probabilities: { yes: 0.9, no: 0.1 }, report: null, ...patch,
});

describe('jevView helpers', () => {
  it('formats percents for a card', () => {
    expect(formatJevPercent(0.93)).toBe('93%');
    expect(formatJevPercent(0)).toBe('0%');
    expect(formatJevPercent(1)).toBe('100%');
    expect(formatJevPercent(0.001)).toBe('<1%');
    expect(formatJevPercent(0.999)).toBe('>99%');
    expect(formatJevPercent(Number.NaN)).toBe('');
  });

  it('reads the answer type from the report first, then params, then the keys', () => {
    expect(decideMode(decide({ report: report('Jev Decide (score)') }), { answer_type: 'choice' })).toBe('score');
    expect(decideMode(decide(), { answer_type: 'choice' })).toBe('choice');
    expect(decideMode(decide())).toBe('yes_no');
    expect(decideMode(decide({ probabilities: { a: 1 } }))).toBe('choice');
  });

  it('keeps a saved level order only when it matches the result', () => {
    const result = { probabilities: { '2': 0.5, Low: 0.2, High: 0.3 } };
    expect(probabilityRows(result, ['Low', '2', 'High']).map((r) => r.label)).toEqual(['Low', '2', 'High']);
    expect(probabilityRows(result, ['Low', 'Mid']).map((r) => r.label)).toEqual(['2', 'Low', 'High']);
  });

  it('labels verdicts', () => {
    expect(verdictLabel('true', 'yes_no')).toEqual({ tone: 'pass', label: 'Pass' });
    expect(verdictLabel('false', 'score')).toEqual({ tone: 'fail', label: 'Fail' });
    expect(verdictLabel('unsure', 'choice')).toEqual({ tone: 'unsure', label: 'Unsure' });
    expect(verdictLabel('true', 'choice', { pass_when: '  \n' })).toEqual({ tone: 'pass', label: 'Confident' });
    expect(verdictLabel('true', 'choice', { pass_when: 'A' })).toEqual({ tone: 'pass', label: 'Pass' });
  });

  it('reads params, images, aliases and cost defensively', () => {
    expect(numberParam({ t: '0.7' }, 't', 0.5)).toBe(0.7);
    expect(numberParam({ t: 'x' }, 't', 0.5)).toBe(0.5);
    expect(numberParam({ t: 3 }, 't', 0.5)).toBe(0.5);
    expect(isCloseCall(0.04, {})).toBe(true);
    expect(isCloseCall(0.6, { min_confidence: 0.7 })).toBe(true);
    expect(isCloseCall(0.81, {})).toBe(false);
    expect(judgedImages(report('t', { Images: '3 (experimental)' }))).toBe(true);
    expect(judgedImages(report('t'))).toBe(false);
    expect(requestedAlias(report('t', { Model: 'jev-1.13.0 (asked for jev-latest)' }))).toBe('jev-latest');
    expect(requestedAlias(report('t'))).toBeNull();
    expect(jevRunCost(report('t'))).toBe('$0.000013');
    expect(jevRunCost({ ...report('t'), inputTokens: null })).toBeNull();
    expect(jevRunCost(null)).toBeNull();
  });

  it('collects wired values in edge order, spreading lists and using image-input previews', () => {
    const nodes = [
      { id: 'a', position: { x: 0, y: 0 }, data: { definitionId: 'x', params: {}, outputs: { image: { type: 'Image', value: ['1.png', '2.png'] } } } },
      { id: 'b', position: { x: 0, y: 0 }, data: { definitionId: 'image-input', params: { _previewUrl: '3.png' }, outputs: {} } },
      { id: 'c', position: { x: 0, y: 0 }, data: { definitionId: 'x', params: {}, outputs: { text: { type: 'Text', value: 'no' } } } },
    ] as unknown as Node[];
    const edges = [
      { id: '1', source: 'a', sourceHandle: 'image', target: 't', targetHandle: 'candidates' },
      { id: '2', source: 'b', sourceHandle: 'image', target: 't', targetHandle: 'candidates' },
      { id: '3', source: 'c', sourceHandle: 'image', target: 't', targetHandle: 'candidates' },
      { id: '4', source: 'a', sourceHandle: 'image', target: 't', targetHandle: 'brief' },
    ] as Edge[];
    expect(upstreamPortValues('t', 'candidates', nodes, edges)).toEqual(['1.png', '2.png', '3.png']);
  });

  it('trusts wired candidates only when they line up with the result', () => {
    const result = { winner: 'b', index: 1, probabilities: { '0': 0.2, '1': 0.8 } };
    expect(matchingCandidates(['a', 'b'], result)).toEqual(['a', 'b']);
    expect(matchingCandidates(['b', 'a'], result)).toBeNull();
    expect(matchingCandidates(['a', 'b', 'c'], result)).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { PortValue } from '../src/types';
import { closeRunRecord, loadRunHistory, openRunRecord, persistRunHistory,
  recordPaperRunOutput, recordRunOutput } from '../src/lib/runHistory';

const outputs: Record<string, PortValue> = { image: { type: 'Image',
  value: { url: '/api/outputs/public-fixture.png', mimeType: 'image/png' } } };
function history() {
  return openRunRecord([], { id: 'ordinary', trigger: 'cluster', startedAt: 10, snapshot: {
    nodes: [{ id: 'model', definitionId: 'nano-banana', params: { aspect_ratio: '16:9' }, outputs: {} }], edges: [],
  } });
}

describe('immutable ordinary run outputs', () => {
  beforeEach(() => localStorage.clear());

  it('records ordinary outputs without mutating or sharing the caller object', () => {
    const initial = history();
    const event = structuredClone(outputs);
    const updated = recordRunOutput(initial, 'ordinary', 'model', event);
    expect(initial[0].resultOutputs).toBeUndefined();
    expect(updated[0].resultOutputs?.model).toEqual(outputs);
    expect(updated[0].snapshot).toBe(initial[0].snapshot);
    expect(Object.isFrozen(updated[0].resultOutputs?.model.image.value)).toBe(true);
    (event.image.value as { url: string }).url = '/api/outputs/mutated.png';
    expect(updated[0].resultOutputs?.model).toEqual(outputs);
  });

  it('persists and reloads ordinary terminal results with their frozen recipe', () => {
    const completed = closeRunRecord(recordRunOutput(history(), 'ordinary', 'model', outputs),
      'ordinary', { status: 'complete' });
    persistRunHistory(completed);
    const reloaded = loadRunHistory();
    expect(reloaded[0].resultOutputs).toEqual(completed[0].resultOutputs);
    expect(reloaded[0].snapshot).toEqual(completed[0].snapshot);
    expect(Object.isFrozen(reloaded[0].resultOutputs?.model.image.value)).toBe(true);
  });

  it.each(['complete', 'failed', 'cancelled'] as const)('rejects late writes to %s records', (status) => {
    const terminal = closeRunRecord(recordRunOutput(history(), 'ordinary', 'model', outputs), 'ordinary', { status });
    expect(recordRunOutput(terminal, 'ordinary', 'model', {})).toBe(terminal);
  });

  it('rejects unknown run IDs and node IDs outside the accepted snapshot', () => {
    const initial = history();
    expect(recordRunOutput(initial, 'other-run', 'model', outputs)).toBe(initial);
    expect(recordRunOutput(initial, 'ordinary', 'other-node', outputs)).toBe(initial);
  });

  it('retains the Paper output helper export as an alias of the general recorder', () => {
    expect(recordPaperRunOutput).toBe(recordRunOutput);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { PortValue, VariantScope } from '../src/types';
import {
  closeRunRecord, loadRunHistory, openRunRecord, persistRunHistory,
  recordRunBatchOutputs, RUN_HISTORY_STORAGE_KEY, sanitizeVariantScope,
  sanitizeVariantScopes, type RunRecord,
} from '../src/lib/runHistory';

function variant(index = 0, label = 'Blue logo'): VariantScope {
  return { index, label, lineage: [{ source_node_id: 'batch', source_label: 'Logo variants',
    index, item_label: label }] };
}

function output(label: string): Record<string, PortValue> {
  return { text: { type: 'Text', value: label } };
}

function open(id = 'current', history: RunRecord[] = []): RunRecord[] {
  return openRunRecord(history, { id, trigger: 'graph', startedAt: 1,
    snapshot: { nodes: [{ id: 'batch', definitionId: 'batch', params: {
      items: ['Blue logo', 'Red logo'],
    }, outputs: {} }], edges: [] } });
}

beforeEach(() => localStorage.clear());

describe('untrusted variant metadata', () => {
  it('copies only display attribution without retaining source objects or extra fields', () => {
    const source = { ...variant(), private_field: 'discard', lineage: [{
      ...variant().lineage[0], private_field: 'discard',
    }] };
    const clean = sanitizeVariantScope(source);
    expect(clean).toEqual(variant());
    source.label = 'changed';
    source.lineage[0].item_label = 'changed';
    expect(clean?.label).toBe('Blue logo');
    expect(clean?.lineage[0].item_label).toBe('Blue logo');
  });

  it.each([
    undefined, null, [], 'label', { ...variant(), index: -1 },
    { ...variant(), index: 0.5 }, { ...variant(), index: Number.NaN },
    { ...variant(), index: Number.MAX_SAFE_INTEGER + 1 },
    { ...variant(), index: '0' }, { ...variant(), label: 2 },
    { ...variant(), lineage: null },
    { ...variant(), lineage: [{ ...variant().lineage[0], source_node_id: '' }] },
    { ...variant(), lineage: [{ ...variant().lineage[0], source_label: null }] },
    { ...variant(), lineage: [{ ...variant().lineage[0], index: -1 }] },
    { ...variant(), lineage: [{ ...variant().lineage[0], item_label: null }] },
  ])('omits malformed scope %#', (source) => {
    expect(sanitizeVariantScope(source)).toBeUndefined();
  });

  it('rejects the whole metadata list rather than shifting result labels', () => {
    expect(sanitizeVariantScopes([variant(), null, variant(2)], 3)).toBeUndefined();
    expect(sanitizeVariantScopes([variant()], 2)).toBeUndefined();
    expect(sanitizeVariantScopes(null, 0)).toBeUndefined();
    expect(sanitizeVariantScopes([], 0)).toEqual([]);
    expect(sanitizeVariantScopes([{ index: 0, label: 'Ordinary invocation', lineage: [] }], 1))
      .toEqual([{ index: 0, label: 'Ordinary invocation', lineage: [] }]);
  });

  it.each([
    [variant(0), variant(0)],
    [variant(1), variant(0)],
    [variant(0), variant(2)],
  ])('rejects duplicate, reordered or skipped successful-output indices %#', (...metadata) => {
    expect(sanitizeVariantScopes(metadata, 2)).toBeUndefined();
  });
});

describe('immutable batch output and metadata recording', () => {
  it('replaces cumulative outputs and matching labels atomically, preserving recipe and earlier runs', () => {
    const initial = open('current', open('earlier'));
    const outputs = [output('Blue logo'), output('Red logo')];
    const scopes = [variant(), variant(1, 'Red logo')];
    const recorded = recordRunBatchOutputs(initial, 'current', 'model', outputs, scopes);
    outputs[0].text.value = 'mutated';
    scopes[0].lineage[0].item_label = 'mutated';
    expect(initial[0].batchOutputs).toBeUndefined();
    expect(initial[0].batchVariants).toBeUndefined();
    expect(recorded[0].batchOutputs?.model).toEqual([output('Blue logo'), output('Red logo')]);
    expect(recorded[0].batchVariants?.model).toEqual([variant(), variant(1, 'Red logo')]);
    expect(recorded[0].snapshot).toBe(initial[0].snapshot);
    expect(recorded[1]).toBe(initial[1]);
    expect(Object.isFrozen(recorded[0].batchOutputs?.model[0].text)).toBe(true);
    expect(Object.isFrozen(recorded[0].batchVariants?.model[0].lineage[0])).toBe(true);
  });

  it.each([undefined, null, [variant(), variant(1)], [{ ...variant(), index: -1 }]])(
    'removes obsolete labels when replacement metadata is absent or invalid %#', (metadata) => {
      let history = recordRunBatchOutputs(open(), 'current', 'model', [output('Blue logo')], [variant()]);
      history = recordRunBatchOutputs(history, 'current', 'other', [output('Other')], [variant(0, 'Other')]);
      const replaced = recordRunBatchOutputs(history, 'current', 'model', [output('New')], metadata);
      expect(replaced[0].batchOutputs?.model).toEqual([output('New')]);
      expect(replaced[0].batchVariants?.model).toBeUndefined();
      expect(replaced[0].batchVariants?.other).toEqual([variant(0, 'Other')]);
      expect(history[0].batchVariants?.model).toEqual([variant()]);
    },
  );

  it('retains a paired empty batch without fabricating item metadata', () => {
    const history = recordRunBatchOutputs(open(), 'current', 'model', [], []);
    expect(history[0].batchOutputs?.model).toEqual([]);
    expect(history[0].batchVariants?.model).toEqual([]);
    persistRunHistory(history);
    expect(loadRunHistory()[0].batchVariants?.model).toEqual([]);
  });

  it.each(['complete', 'failed', 'cancelled'] as const)(
    'reloads retained successful items and frozen attribution for a %s run', (status) => {
      let history = recordRunBatchOutputs(open(), 'current', 'model', [output('Blue logo')], [variant()]);
      history = closeRunRecord(history, 'current', { status });
      persistRunHistory(history);
      const [record] = loadRunHistory();
      expect(record.status).toBe(status);
      expect(record.batchOutputs).toEqual(history[0].batchOutputs);
      expect(record.batchVariants).toEqual(history[0].batchVariants);
      expect(Object.isFrozen(record.batchVariants?.model[0].lineage[0])).toBe(true);
      expect(record.snapshot).toEqual(history[0].snapshot);
    },
  );
});

describe('history metadata sanitation', () => {
  function storeMetadata(batchVariants: unknown) {
    const records = recordRunBatchOutputs(open(), 'current', 'model', [output('Blue logo')]);
    records[0] = { ...records[0], batchOutputs: { ...records[0].batchOutputs,
      other: [output('Other')] } };
    localStorage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1,
      records: [{ ...records[0], batchVariants }] }));
    return records[0];
  }

  it.each([null, [], 'invalid', { model: null }, { model: [variant(), variant(1)] },
    { model: [variant(1)] },
    { model: [{ ...variant(), label: null }] }, { absentNode: [variant()] }])(
    'preserves valid history when optional metadata is malformed %#', (metadata) => {
      const original = storeMetadata(metadata);
      const [record] = loadRunHistory();
      expect(record).toBeDefined();
      expect(record.batchVariants).toBeUndefined();
      expect(record.batchOutputs).toEqual(original.batchOutputs);
      expect(record.snapshot).toEqual(original.snapshot);
      const saved = JSON.parse(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)!);
      expect(saved.records[0].batchVariants).toBeUndefined();
    },
  );

  it('sanitizes invalid nodes independently and persists only metadata paired to retained outputs', () => {
    storeMetadata({ model: [variant(), variant(1)], other: [variant(0, 'Other')], orphan: [variant()] });
    const [record] = loadRunHistory();
    expect(record.batchVariants).toEqual({ other: [variant(0, 'Other')] });
    expect(record.batchOutputs?.model).toEqual([output('Blue logo')]);
    expect(JSON.parse(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)!).records[0].batchVariants)
      .toEqual(record.batchVariants);
  });

  it('continues loading legacy batches that have no attribution metadata', () => {
    const records = recordRunBatchOutputs(open(), 'current', 'model', [output('Legacy result')]);
    persistRunHistory(records);
    const [record] = loadRunHistory();
    expect(record.batchVariants).toBeUndefined();
    expect(record.batchOutputs?.model).toEqual([output('Legacy result')]);
    expect(Object.isFrozen(record.batchOutputs?.model[0].text)).toBe(true);
  });
});

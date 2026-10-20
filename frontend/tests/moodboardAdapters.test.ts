import { describe, expect, it } from 'vitest';
import handTable from '../../backend/data/moodboard_adapters.json';
import kreaTable from '../../backend/data/moodboard_adapters_krea.json';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import {
  adapterLine, adapterRoute, nodeAdapterEntry, resolveAdapterEntry, type AdapterEntry, type AdapterTable,
} from '../src/lib/moodboardAdapters';

// What GET /api/moodboard/adapters serves (services/moodboard_adapters.py
// public_table): both files' entries.
const table: AdapterTable = {
  ...(handTable.entries as unknown as AdapterTable),
  ...(kreaTable.entries as unknown as AdapterTable),
};

describe('moodboard adapter entries', () => {
  it('has an entry for every frontend node with a Moodboard input port (plan section 5.7.10 rule 1)', () => {
    const withPort = Object.values(NODE_DEFINITIONS)
      .filter((definition) => definition.inputPorts.some((port) => port.id === 'moodboard'));
    expect(withPort.length).toBeGreaterThan(0);
    for (const definition of withPort) {
      expect(definition.inputPorts.find((port) => port.id === 'moodboard')?.dataType, definition.id).toBe('Moodboard');
      expect(table[definition.id], definition.id).toBeDefined();
    }
    expect(Object.keys(table).sort()).toEqual(withPort.map((definition) => definition.id).sort());
  });

  it('resolves byModel overrides as the backend does, and a text-only result keeps its former slots out', () => {
    const banana = NODE_DEFINITIONS['nano-banana-fal-edit'];
    const old = nodeAdapterEntry(table, banana, { model: 'nano-banana' }, null);
    expect(old?.slots).toEqual([{ port: 'images', max: 3 }]);
    expect(nodeAdapterEntry(table, banana, {}, null)?.slots).toEqual([{ port: 'images', max: 14 }]);
    const entry: AdapterEntry = {
      channel: 'refs', default: 'text', slots: [{ port: 'images', max: 4 }], never: ['mask'], weight: { mode: 'select' },
      byModel: { 'model=old': { channel: 'text-only', reason: 'not yet' } },
      byRoute: { fal: { slots: [{ port: 'images', max: 2 }] } },
    };
    expect(resolveAdapterEntry(entry, { model: 'old' }, null)).toEqual({
      channel: 'text-only', never: ['mask', 'images'], reason: 'not yet' });
    expect(resolveAdapterEntry(entry, {}, 'fal').slots).toEqual([{ port: 'images', max: 2 }]);
    expect(entry.slots).toEqual([{ port: 'images', max: 4 }]);
  });

  it("names the run's route only for a node with more than one", () => {
    expect(adapterRoute(NODE_DEFINITIONS['krea-2-generate'], {}, ['moodboard'], { KREA_API_TOKEN: 'k' })).toBeNull();
    const gpt = NODE_DEFINITIONS['gpt-image-2-fal-edit'];
    expect(adapterRoute(gpt, {}, ['moodboard'], { OPENAI_API_KEY: 'k', FAL_KEY: 'k' })).toBe('openai');
    expect(adapterRoute(gpt, {}, ['moodboard'], { FAL_KEY: 'k' })).toBe('fal');
    expect(adapterRoute(gpt, {}, ['moodboard'], {})).toBeNull();
  });

  it('says what the board does on the card (plan section 5.7.8)', () => {
    const line = (id: string) => {
      const definition = NODE_DEFINITIONS[id];
      return adapterLine(nodeAdapterEntry(table, definition, {}, null), definition);
    };
    expect(line('gpt-image-2-generate')).toBe('This model takes the brief as text.');
    expect(line('fast-sdxl')).toBe('This model takes the brief as text.');
    expect(line('gpt-image-2-edit')).toBe('Board images: off · the brief goes as text');
    expect(line('nano-banana')).toBe('Board images: off · the brief goes as text');
    expect(line('krea-2-generate')).toBe('Board images: on · up to 10 to Image Style Refs');
    expect(adapterLine(null, NODE_DEFINITIONS['flux-2-pro'])).toBe('This model takes the brief as text.');
  });
});

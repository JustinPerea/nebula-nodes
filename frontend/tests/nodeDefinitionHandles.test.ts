import { describe, expect, it } from 'vitest';
import backendCatalog from '../../backend/data/node_definitions.json';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import type { PortDefinition } from '../src/types';

// The canvas draws handles and keeps run outputs from the frontend
// definitions, but saving checks them against the backend registry. If the
// two disagree on a port id or type, the canvas makes edges or outputs that
// the next autosave rejects ("Save failed · Retry").
type BackendDefinition = {
  inputPorts?: PortDefinition[];
  outputPorts?: PortDefinition[];
  displayOutputs?: PortDefinition[];
};
const backend = backendCatalog as unknown as Record<string, BackendDefinition>;
const handles = (ports: PortDefinition[] | undefined) =>
  (ports ?? []).map((port) => `${port.id}:${port.dataType}`);

describe('node definition handles', () => {
  it('declares the same ports in the frontend and the backend registry', () => {
    const mismatches: string[] = [];
    for (const [id, definition] of Object.entries(NODE_DEFINITIONS)) {
      const registry = backend[id];
      if (!registry) {
        mismatches.push(`${id}: missing from the backend registry`);
        continue;
      }
      for (const group of ['inputPorts', 'outputPorts', 'displayOutputs'] as const) {
        const frontendHandles = handles(definition[group]);
        const backendHandles = handles(registry[group]);
        if (JSON.stringify(frontendHandles) !== JSON.stringify(backendHandles)) {
          mismatches.push(`${id}.${group}: frontend [${frontendHandles}] vs backend [${backendHandles}]`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps display-only outputs off the wireable outputs', () => {
    for (const [id, definition] of Object.entries(NODE_DEFINITIONS)) {
      const wireable = new Set(definition.outputPorts.map((port) => port.id));
      const overlap = (definition.displayOutputs ?? []).filter((port) => wireable.has(port.id));
      expect(overlap, id).toEqual([]);
    }
  });

  it('declares the outputs Image Compare and Preview keep to draw their cards', () => {
    expect(NODE_DEFINITIONS['image-compare'].displayOutputs?.map((port) => port.id)).toEqual(['imageA', 'imageB']);
    expect(NODE_DEFINITIONS['image-compare'].outputPorts).toEqual([]);
    expect(NODE_DEFINITIONS.preview.displayOutputs?.map((port) => port.id)).toEqual(['input']);
  });
});

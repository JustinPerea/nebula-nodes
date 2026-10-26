/**
 * The universal-node model pickers' port rules as they were on main
 * (23f11b8e), before the backend took them over (services/universal_ports.py,
 * POST /api/graph/node/{id}/model).
 *
 * `legacyOpenRouter` and `legacyReplicate` are the bodies of graphStore's
 * `configureOpenRouterModel` and `fetchReplicateSchemaAndConfigure`, copied
 * verbatim and reduced to their inputs and outputs. This test pins that they
 * reproduce `contracts/fixtures/universal-ports/picker-cases.json`, and the
 * backend's tests/test_universal_ports.py pins that the backend produces the
 * same fixture: so the person's picker gives the same ports, params and wire
 * pruning as before. The one intended change (a Replicate model whose output
 * is a list of plain strings now has a Text `text` port, as its run names it)
 * is recorded in the fixture as `backendChanges`.
 *
 * Run with CAPTURE_UNIVERSAL_PICKER=1 to rewrite the fixture's `expected`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURE = resolve(__dirname, '../../contracts/fixtures/universal-ports/picker-cases.json');

type Port = { id: string; label: string; dataType: string; required: boolean; multiple?: boolean };
type Param = {
  key: string; label: string; type: string; required: boolean; default?: unknown;
  placeholder?: string; options?: Array<{ label: string; value: unknown }>; min?: number; max?: number;
};
type Edge = { id: string; source: string; sourceHandle: string; target: string; targetHandle: string };
type ModelRow = { id: string; input_modalities?: string[]; output_modalities?: string[] };
type Schema = { version_id: string; description: string; input_schema: unknown; output_schema: unknown };

function legacyOpenRouter(nodeId: string, params: Record<string, unknown>, edges: Edge[], modelId: string, model: ModelRow) {
  const inputModalities = model.input_modalities || ['text'];
  const outputModalities = model.output_modalities || ['text'];

  const inputPorts: Port[] = [
    { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
  ];
  if (inputModalities.includes('image')) {
    inputPorts.push({ id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true });
  }

  const outputPorts: Port[] = [];
  if (outputModalities.includes('text')) {
    outputPorts.push({ id: 'text', label: 'Text', dataType: 'Text', required: false });
  }
  if (outputModalities.includes('image')) {
    outputPorts.push({ id: 'image', label: 'Image', dataType: 'Image', required: false });
  }

  const wantsImage = outputModalities.includes('image');
  return {
    params: { ...params, model: modelId, _output_image: wantsImage },
    dynamicInputPorts: inputPorts,
    dynamicOutputPorts: outputPorts,
    keptEdgeIds: edges.filter((e) => {
      if (e.source === nodeId) {
        return outputPorts.some((p) => p.id === e.sourceHandle);
      }
      if (e.target === nodeId) {
        return inputPorts.some((p) => p.id === e.targetHandle);
      }
      return true;
    }).map((e) => e.id),
  };
}

function legacyReplicate(params: Record<string, unknown>, providerMeta: Record<string, unknown>, schema: Schema) {
  const inputProps = ((schema.input_schema as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>) ?? {};
  const requiredInputs: string[] = ((schema.input_schema as Record<string, unknown>)?.required as string[]) ?? [];
  const dynamicParams: Param[] = [];
  const inputPorts: Port[] = [];

  for (const [key, prop] of Object.entries(inputProps)) {
    const p = prop as Record<string, unknown>;
    const description = (p.description as string) ?? '';
    const isUploadable = p['x-uploadable'] === true;
    const format = (p.format as string) ?? '';

    if (isUploadable || format === 'uri') {
      inputPorts.push({
        id: key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        dataType: 'Image',
        required: requiredInputs.includes(key),
      });
      continue;
    }

    let paramType: Param['type'] = 'string';
    if (p.type === 'integer') paramType = 'integer';
    else if (p.type === 'number') paramType = 'float';
    else if (p.type === 'boolean') paramType = 'boolean';
    else if (p.enum) paramType = 'enum';

    const param: Param = {
      key,
      label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      type: paramType,
      required: requiredInputs.includes(key),
      default: p.default,
      placeholder: description.slice(0, 80),
    };

    if (p.enum) {
      param.options = (p.enum as Array<string | number>).map((v) => ({ label: String(v), value: v }));
    }
    if (p.minimum !== undefined) param.min = p.minimum as number;
    if (p.maximum !== undefined) param.max = p.maximum as number;

    dynamicParams.push(param);
  }

  const outputPorts: Port[] = [];
  const outputSchema = schema.output_schema as Record<string, unknown>;

  if (outputSchema?.type === 'string' && outputSchema?.format === 'uri') {
    outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
  } else if (outputSchema?.type === 'array') {
    outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
  } else {
    outputPorts.push({ id: 'text', label: 'Output', dataType: 'Text', required: false });
  }

  const paramDefaults: Record<string, unknown> = {};
  for (const dp of dynamicParams) {
    if (dp.default !== undefined) paramDefaults[dp.key] = dp.default;
  }

  return {
    params: { ...params, ...paramDefaults, _version_id: schema.version_id, _schema_fetched: true },
    dynamicInputPorts: inputPorts,
    dynamicOutputPorts: outputPorts,
    // JSON drops an `undefined` default, as the canvas's own state copy does.
    dynamicParams: JSON.parse(JSON.stringify(dynamicParams)) as Param[],
    providerMeta: { ...providerMeta, version_id: schema.version_id, description: schema.description },
  };
}

type Case = {
  name: string;
  definitionId: string;
  nodeId: string;
  params: Record<string, unknown>;
  providerMeta?: Record<string, unknown>;
  edges?: Edge[];
  model?: string;
  row?: ModelRow;
  schema?: Schema;
  expected?: unknown;
};

function legacyResult(item: Case) {
  if (item.definitionId === 'replicate-universal') {
    return legacyReplicate(item.params, item.providerMeta ?? {}, item.schema!);
  }
  return legacyOpenRouter(item.nodeId, item.params, item.edges ?? [], item.model!, item.row!);
}

describe('the universal pickers before the backend took them over', () => {
  it('reproduce the shared fixture', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Case[] };
    if (process.env.CAPTURE_UNIVERSAL_PICKER === '1') {
      for (const item of fixture.cases) item.expected = legacyResult(item);
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
    }
    expect(fixture.cases.length).toBeGreaterThan(8);
    for (const item of fixture.cases) {
      expect(JSON.parse(JSON.stringify(legacyResult(item))), item.name).toEqual(item.expected);
    }
  });
});

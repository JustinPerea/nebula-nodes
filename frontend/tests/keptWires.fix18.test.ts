/**
 * Round 18 of PR #199, the connection lines as a library:
 * - GM r25, 1: "It takes" lists every type the input takes, by the shared
 *   name-list join ("images and masks");
 * - GM r25, 2: "takes only one connection there", "doesn’t have that input
 *   anymore";
 * - GM r26, 3: a loop is "Couldn’t connect to “B”. It would make a loop.",
 *   and a drop the canvas refused gets its line (refusedConnectionLine);
 * - review 16 kept-ui NIT-1: "3D models" and "lists" pinned;
 * - review 16 kept-ui LOW-1: the multiple-port lookup falls back to the
 *   definition where the node's dynamic ports don't hold the handle.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { checkKeptWire, droppedConnectionsLine, refusedConnectionLine, refusedDropConnection, takesTypes, targetHandleAllowsMultiple, typeName,
  KEPT_WIRE_NO_PORT } from '../src/lib/keptWires';
import type { DroppedWire } from '../src/lib/projects';

const node = (id: string, definitionId: string, data: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label: id, params: {}, state: 'idle', outputs: {}, ...data },
}) as unknown as Node<NodeData>;
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge =>
  ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle });

describe('GM r25, 1: what an input takes, every type, by the shared join', () => {
  it('an image input takes images and masks; a text input text; Any anything', () => {
    expect(takesTypes('Image')).toBe('images and masks');
    expect(takesTypes('Mask')).toBe('masks and images');
    expect(takesTypes('Text')).toBe('text');
    expect(takesTypes('Any')).toBe('anything');
  });

  it('the refusal names masks: “It takes images and masks, not text.”', () => {
    expect(checkKeptWire({ source: 't', sourceHandle: 'text', target: 's', targetHandle: 'images' },
      [node('t', 'text-input'), node('s', 'seedream-4-5')], []))
      .toEqual({ ok: false, line: 'Couldn’t connect to “References”. It takes images and masks, not text.' });
  });

  it('review 16 NIT-1: “3D models” and “lists” as GM wrote them', () => {
    expect(typeName('Mesh')).toBe('3D models');
    expect(typeName('Array')).toBe('lists');
  });
});

describe('GM r25, 2: the two edited left-out reasons', () => {
  const wire = (kind: string, more: Partial<DroppedWire> = {}): DroppedWire => ({ kind, source: 'n1', target: 'n2',
    sourceName: 'A', targetName: 'B', ...more });
  it('“only one connection”, and “anymore” as one word', () => {
    expect(droppedConnectionsLine([wire('limit', { limit: 1 })]))
      .toBe('Nebula left out the connection from “A” to “B” because “B” takes only one connection there.');
    expect(droppedConnectionsLine([wire('limit', { limit: 10 })]))
      .toBe('Nebula left out the connection from “A” to “B” because “B” takes up to 10 connections there.');
    expect(droppedConnectionsLine([wire('port')]))
      .toBe('Nebula left out the connection from “A” to “B” because “B” doesn’t have that input anymore.');
    expect(KEPT_WIRE_NO_PORT).toBe('Couldn’t make that connection. That input or output isn’t on the node anymore.');
  });
});

describe('GM r26, 3: a loop, and a refused drop’s line', () => {
  const nodes = [node('a', 'seedream-4-5'), node('b', 'seedream-4-5'), node('t', 'text-input')];
  it('a loop: “Couldn’t connect to “References”. It would make a loop.”', () => {
    expect(checkKeptWire({ source: 'b', sourceHandle: 'image', target: 'a', targetHandle: 'images' }, nodes,
      [edge('a', 'image', 'b', 'images')])).toEqual({ ok: false, line: 'Couldn’t connect to “References”. It would make a loop.' });
  });

  it('refusedConnectionLine: the wrong kind, a loop, a missing port; nothing for a drop the rules take', () => {
    expect(refusedConnectionLine({ source: 't', sourceHandle: 'text', target: 'a', targetHandle: 'images' }, nodes, []))
      .toBe('Couldn’t connect to “References”. It takes images and masks, not text.');
    expect(refusedConnectionLine({ source: 'b', sourceHandle: 'image', target: 'a', targetHandle: 'images' }, nodes,
      [edge('a', 'image', 'b', 'images')])).toBe('Couldn’t connect to “References”. It would make a loop.');
    expect(refusedConnectionLine({ source: 't', sourceHandle: 'nope', target: 'a', targetHandle: 'images' }, nodes, []))
      .toBe(KEPT_WIRE_NO_PORT);
    expect(refusedConnectionLine({ source: 't', sourceHandle: 'text', target: 'a', targetHandle: 'prompt' }, nodes, [])).toBe('');
  });

  it('a loop that is also past a limit says the loop (the canvas refused it for the loop)', () => {
    const ten = Array.from({ length: 10 }, (_, index) => edge(`i${index}`, 'image', 'a', 'images'));
    const images = Array.from({ length: 10 }, (_, index) => node(`i${index}`, 'image-input'));
    expect(refusedConnectionLine({ source: 'b', sourceHandle: 'image', target: 'a', targetHandle: 'images' }, [...nodes, ...images],
      [...ten, edge('a', 'image', 'b', 'images')])).toBe('Couldn’t connect to “References”. It would make a loop.');
  });
});

describe('review 16 kept-ui LOW-1: the multiple-port lookup', () => {
  it('a dynamic node whose dynamic inputs don’t hold the handle answers from its definition', () => {
    const cinema = node('cin', 'cinema-scene', { isDynamic: true, dynamicInputPorts: [], dynamicOutputPorts: [] });
    expect(targetHandleAllowsMultiple(cinema, 'character_refs')).toBe(true);
  });

  it('a dynamic port still wins over the definition', () => {
    const capped = node('c', 'cinema-scene', { isDynamic: true, dynamicOutputPorts: [],
      dynamicInputPorts: [{ id: 'character_refs', label: 'Refs', dataType: 'Image', required: false }] });
    expect(targetHandleAllowsMultiple(capped, 'character_refs')).toBe(false);
  });
});

describe('GM r26, 3: the canvas’s drop end', () => {
  it('a drop on a handle the canvas refused: the connection it would have made, from either end', () => {
    expect(refusedDropConnection({ nodeId: 't', handleId: 'text', handleType: 'source' }, { isValid: false, toHandle: { nodeId: 's', id: 'images' } }))
      .toEqual({ source: 't', sourceHandle: 'text', target: 's', targetHandle: 'images' });
    expect(refusedDropConnection({ nodeId: 's', handleId: 'images', handleType: 'target' }, { isValid: false, toHandle: { nodeId: 't', id: 'text' } }))
      .toEqual({ source: 't', sourceHandle: 'text', target: 's', targetHandle: 'images' });
  });

  it('not a refusal: a valid drop, a drop on empty space', () => {
    expect(refusedDropConnection({ nodeId: 't', handleId: 'text', handleType: 'source' }, { isValid: true, toHandle: { nodeId: 's', id: 'prompt' } })).toBeNull();
    expect(refusedDropConnection({ nodeId: 't', handleId: 'text', handleType: 'source' }, { isValid: null, toHandle: null })).toBeNull();
    expect(refusedDropConnection({ nodeId: 't', handleId: 'text', handleType: 'source' }, { isValid: false, toHandle: null })).toBeNull();
  });

  it('Canvas.onConnectEnd says the refused drop’s line before anything else', () => {
    const canvas = readFileSync(resolve(__dirname, '../src/components/Canvas.tsx'), 'utf8');
    const end = canvas.slice(canvas.indexOf('const onConnectEnd'));
    expect(end).toMatch(/const refused = refusedDropConnection\(info, connectionState\);\s*if \(refused\) \{\s*useGraphStore\.getState\(\)\.sayRefusedConnection\(refused\);\s*return;/);
    expect(end.indexOf('refusedDropConnection')).toBeLessThan(end.indexOf('showConnectionPopup'));
  });
});

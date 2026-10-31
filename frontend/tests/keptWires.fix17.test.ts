/**
 * Round 17 of PR #199 (GM r23, 1 and 2; review 15 kept-wires-ui LOW-2,
 * LOW-3, NIT-2), the kept-wire rules as a library:
 * - the person's refusal is the tab's own line, from the types it knows
 *   (round 18, GM r25 and r26: every type it takes, and the loop line);
 * - the connections Save as a project left out are said in the tab's words,
 *   naming each, and from 2 on counted, naming up to 3;
 * - one predicate decides "replaced" for the kept rules and onConnect, so a
 *   port that takes several connections with a limit of 1 refuses instead;
 * - the compatibility rule is the file shared with the backend;
 * - kept connections on dynamic ports (a Cinema shot, a configured
 *   universal node's input) follow the same rules.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { PORT_DATA_TYPES } from '../src/constants/ports';
import { COMPATIBILITY, PORT_RULES, isPortCompatible, portTypesCompatible } from '../src/lib/portCompatibility';
import { checkKeptWire, droppedConnectionsLine, targetHandleAllowsMultiple } from '../src/lib/keptWires';
import type { DroppedWire } from '../src/lib/projects';

const node = (id: string, definitionId: string, data: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label: id, params: {}, state: 'idle', outputs: {}, ...data },
}) as unknown as Node<NodeData>;
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge =>
  ({ id: `${source}-${target}-${targetHandle}-${Math.random()}`, source, sourceHandle, target, targetHandle });

describe('GM r23 (1): a refused kept connection says what the input takes, in the tab’s words', () => {
  it('the wrong kind: “Couldn’t connect to “References”. It takes images and masks, not text.”', () => {
    const check = checkKeptWire({ source: 't', sourceHandle: 'text', target: 's', targetHandle: 'images' },
      [node('t', 'text-input'), node('s', 'seedream-4-5')], []);
    expect(check).toEqual({ ok: false, line: 'Couldn’t connect to “References”. It takes images and masks, not text.' });
  });

  it('a loop and a several-input limit, each in one curly-apostrophe line', () => {
    const nodes = [node('a', 'seedream-4-5'), node('b', 'seedream-4-5')];
    expect(checkKeptWire({ source: 'b', sourceHandle: 'image', target: 'a', targetHandle: 'images' }, nodes,
      [edge('a', 'image', 'b', 'images')])).toEqual({ ok: false, line: 'Couldn’t connect to “References”. It would make a loop.' });
    const ten = Array.from({ length: 10 }, (_, index) => edge(`i${index}`, 'image', 'a', 'images'));
    const images = Array.from({ length: 11 }, (_, index) => node(`i${index}`, 'image-input'));
    expect(checkKeptWire({ source: 'i10', sourceHandle: 'image', target: 'a', targetHandle: 'images' }, [...nodes, ...images], ten))
      .toEqual({ ok: false, line: 'Couldn’t connect to “References”. It takes up to 10 connections.' });
  });
});

describe('review 15 kept-wires-ui LOW-2: “replaced” is one predicate for the kept rules and onConnect', () => {
  const capped = node('c', 'fal-universal', { isDynamic: true,
    dynamicInputPorts: [{ id: 'refs', label: 'Refs', dataType: 'Image', required: false, multiple: true, maxConnections: 1 }],
    dynamicOutputPorts: [] });

  it('a port that takes several connections with a limit of 1 isn’t replaced: the second one is refused', () => {
    expect(targetHandleAllowsMultiple(capped, 'refs')).toBe(true);
    const images = [node('i1', 'image-input'), node('i2', 'image-input')];
    expect(checkKeptWire({ source: 'i1', sourceHandle: 'image', target: 'c', targetHandle: 'refs' }, [capped, ...images], []))
      .toEqual({ ok: true, duplicate: false });
    expect(checkKeptWire({ source: 'i2', sourceHandle: 'image', target: 'c', targetHandle: 'refs' }, [capped, ...images],
      [edge('i1', 'image', 'c', 'refs')])).toEqual({ ok: false, line: 'Couldn’t connect to “Refs”. It takes one connection.' });
  });

  it('a one-connection port is replaced: the new one is allowed', () => {
    const nodes = [node('s', 'seedream-4-5'), node('t1', 'text-input'), node('t2', 'text-input')];
    expect(targetHandleAllowsMultiple(nodes[0], 'prompt')).toBe(false);
    expect(checkKeptWire({ source: 't2', sourceHandle: 'text', target: 's', targetHandle: 'prompt' }, nodes,
      [edge('t1', 'text', 's', 'prompt')])).toEqual({ ok: true, duplicate: false });
  });
});

describe('review 15 kept-wires-ui LOW-3: dynamic ports (W10, W11)', () => {
  const cinema = node('cin', 'cinema-scene', { isDynamic: true, dynamicInputPorts: [],
    dynamicOutputPorts: [{ id: 'shot_abc', label: 'Shot 1', dataType: 'Image', required: false }] });
  const universal = node('u', 'replicate-universal', { isDynamic: true, dynamicOutputPorts: [],
    dynamicInputPorts: [{ id: 'input_image', label: 'Input image', dataType: 'Image', required: false }] });

  it('a Cinema shot’s output into a configured universal node’s input: drawn', () => {
    expect(checkKeptWire({ source: 'cin', sourceHandle: 'shot_abc', target: 'u', targetHandle: 'input_image' },
      [cinema, universal], [])).toEqual({ ok: true, duplicate: false });
  });

  it('the same dynamic ports hold the type rule: text into the universal node’s image input is refused', () => {
    expect(checkKeptWire({ source: 't', sourceHandle: 'text', target: 'u', targetHandle: 'input_image' },
      [node('t', 'text-input'), universal], [])).toEqual({ ok: false, line: 'Couldn’t connect to “Input image”. It takes images and masks, not text.' });
  });
});

describe('review 15 kept-wires-ui LOW-3 / GM r23 (2): one compatibility rule, shared with the backend', () => {
  it('the frontend reads the shared file: every pair of types answers the file’s rule', () => {
    const shared = JSON.parse(readFileSync(join(__dirname, '../src/lib/portRules.json'), 'utf8')) as typeof PORT_RULES;
    expect([...shared.types].sort()).toEqual([...PORT_DATA_TYPES].sort());
    const rule = (a: string, b: string) => a === shared.any || b === shared.any || a === b
      || shared.alsoCompatible.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    for (const source of PORT_DATA_TYPES) {
      for (const target of PORT_DATA_TYPES) {
        expect(isPortCompatible(source, target), `${source} → ${target}`).toBe(rule(source, target));
        expect(COMPATIBILITY[source].includes(target), `table ${source} → ${target}`).toBe(rule(source, target));
      }
    }
    // A type only one side knows: equal types fit, as the backend's rule says.
    expect(portTypesCompatible('Hologram', 'Hologram')).toBe(true);
    expect(portTypesCompatible('Hologram', 'Text')).toBe(false);
  });

  it('the kinds of left-out connections are the shared table’s, and the tab has a line for each', () => {
    expect(PORT_RULES.droppedConnectionKinds).toEqual(['loop', 'duplicate', 'missing', 'port', 'type', 'limit']);
    for (const kind of PORT_RULES.droppedConnectionKinds) {
      const line = droppedConnectionsLine([{ kind, source: 'n1', target: 'n2', sourceName: 'A', targetName: 'B',
        sourceType: 'Text', targetType: 'Image', limit: 1 } as DroppedWire]);
      expect(line, kind).toMatch(/^Nebula left out the connection from “A” to “B” because .+\.$/);
    }
  });
});

describe('GM r23 (2): the connections Save as a project left out, in the tab’s words', () => {
  const wire = (kind: string, more: Partial<DroppedWire> = {}): DroppedWire => ({ kind, source: 'n1', target: 'n2',
    sourceName: 'A', targetName: 'B', ...more });

  it('one, named, with GM’s reasons', () => {
    expect(droppedConnectionsLine([wire('loop')])).toBe('Nebula left out the connection from “A” to “B” because it connected the node to itself.');
    expect(droppedConnectionsLine([wire('duplicate')])).toBe('Nebula left out the connection from “A” to “B” because the same connection was already there.');
    expect(droppedConnectionsLine([wire('missing', { target: null, targetWas: 'local-9', targetName: null })], (id) => (id === 'local-9' ? 'B' : null)))
      .toBe('Nebula left out the connection from “A” to “B” because “B” isn’t on the canvas.');
    expect(droppedConnectionsLine([wire('type', { sourceType: 'Text', targetType: 'Image' })]))
      .toBe('Nebula left out the connection from “A” to “B” because “B” takes images and masks, not text.');
  });

  it('a missing end the tab can’t name either: the connection is named by its other end', () => {
    expect(droppedConnectionsLine([wire('missing', { target: null, targetWas: 'gone', targetName: null })]))
      .toBe('Nebula left out the connection from “A” because the node it went to isn’t on the canvas.');
  });

  it('names fall back to the tab’s own, by its id or the id it had (renumbered)', () => {
    expect(droppedConnectionsLine([wire('loop', { sourceName: null, targetName: null })],
      (id) => ({ n1: 'Hero prompt', n2: 'Seedream 4.5' } as Record<string, string>)[id] ?? null))
      .toBe('Nebula left out the connection from “Hero prompt” to “Seedream 4.5” because it connected the node to itself.');
  });

  it('from 2 on: counted, naming up to 3; from 4 the count alone', () => {
    const two = [wire('loop'), wire('duplicate', { sourceName: 'C', targetName: 'D' })];
    expect(droppedConnectionsLine(two)).toBe('Nebula left out 2 connections that couldn’t be kept: from “A” to “B” and from “C” to “D”.');
    const three = [...two, wire('type', { sourceName: 'E', targetName: 'F' })];
    expect(droppedConnectionsLine(three))
      .toBe('Nebula left out 3 connections that couldn’t be kept: from “A” to “B”, from “C” to “D” and from “E” to “F”.');
    expect(droppedConnectionsLine([...three, wire('limit')])).toBe('Nebula left out 4 connections that couldn’t be kept.');
    expect(droppedConnectionsLine([])).toBe('');
  });
});

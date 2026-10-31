/**
 * Round 19 of PR #199, the frontend's rules and lines:
 * - GM r28, 1 (review 17 drops-locks-ui LOW-1): a drop on a handle of the
 *   same kind says its own line ("Couldn’t connect two outputs. Drag from an
 *   output to an input." / "… two inputs …"), never another failure's
 *   reason (it was read as an input: "isn’t on the node anymore", a loop);
 * - review 17 drops-locks-ui NIT: the kept one-connection refusal says
 *   "only one connection";
 * - GM r27, 1: each kept control its own verb ("You can delete the note
 *   after you save it as a project.");
 * - GM r27, 3 and review 17 NIT-2: Nebula's own reopen says the lock form
 *   while it follows; the following lines use ’.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { checkKeptWire, refusedDropConnection, refusedDropLine, SAME_KIND_DROP_LINES } from '../src/lib/keptWires';
import { keptLockTitle } from '../src/lib/keptCanvas';
import { runWhileFollowingLine } from '../src/lib/canvasFollow';

const node = (id: string, definitionId: string, data: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label: id, params: {}, state: 'idle', outputs: {}, ...data },
}) as unknown as Node<NodeData>;
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge =>
  ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle });

const OUTPUTS = 'Couldn’t connect two outputs. Drag from an output to an input.';
const INPUTS = 'Couldn’t connect two inputs. Drag from an output to an input.';

describe('GM r28, 1: a drop on a handle of the same kind', () => {
  const nodes = [node('t', 'text-input'), node('t2', 'text-input'), node('s', 'seedream-4-5'), node('s2', 'seedream-4-5')];

  it('GM’s two lines, verbatim', () => {
    expect(SAME_KIND_DROP_LINES).toEqual({ source: OUTPUTS, target: INPUTS });
  });

  it('an output on an output: two outputs, never “isn’t on the node anymore”', () => {
    expect(refusedDropLine({ nodeId: 't', handleId: 'text', handleType: 'source' },
      { isValid: false, toHandle: { nodeId: 't2', id: 'text', type: 'source' } }, nodes, [])).toBe(OUTPUTS);
  });

  it('an input on an input: two inputs', () => {
    expect(refusedDropLine({ nodeId: 's', handleId: 'prompt', handleType: 'target' },
      { isValid: false, toHandle: { nodeId: 's2', id: 'prompt', type: 'target' } }, nodes, [])).toBe(INPUTS);
  });

  it('an output on an output whose id is also an input’s, with a connection back: two outputs, never a loop', () => {
    // Seedream's `image` output dropped on the other Seedream's `image` output, s → s2 already connected.
    expect(refusedDropLine({ nodeId: 's2', handleId: 'image', handleType: 'source' },
      { isValid: false, toHandle: { nodeId: 's', id: 'image', type: 'source' } }, nodes, [edge('s', 'image', 's2', 'images')]))
      .toBe(OUTPUTS);
  });

  it('a release on the handle the drag began at (a click) says nothing', () => {
    expect(refusedDropLine({ nodeId: 't', handleId: 'text', handleType: 'source' },
      { isValid: false, toHandle: { nodeId: 't', id: 'text', type: 'source' } }, nodes, [])).toBeNull();
  });

  it('a drop of the other kind still says its own reason, and a valid or empty drop nothing', () => {
    expect(refusedDropLine({ nodeId: 't', handleId: 'text', handleType: 'source' },
      { isValid: false, toHandle: { nodeId: 's', id: 'images', type: 'target' } }, nodes, []))
      .toBe('Couldn’t connect to “References”. It takes images and masks, not text.');
    expect(refusedDropLine({ nodeId: 't', handleId: 'text', handleType: 'source' },
      { isValid: true, toHandle: { nodeId: 's', id: 'prompt', type: 'target' } }, nodes, [])).toBeNull();
    expect(refusedDropLine({ nodeId: 't', handleId: 'text', handleType: 'source' }, { isValid: null, toHandle: null }, nodes, [])).toBeNull();
  });

  it('refusedDropConnection makes no connection of a same-kind drop', () => {
    expect(refusedDropConnection({ nodeId: 't', handleId: 'text', handleType: 'source' },
      { isValid: false, toHandle: { nodeId: 't2', id: 'text', type: 'source' } })).toBeNull();
    expect(refusedDropConnection({ nodeId: 's', handleId: 'prompt', handleType: 'target' },
      { isValid: false, toHandle: { nodeId: 's2', id: 'prompt', type: 'target' } })).toBeNull();
  });
});

describe('review 17 NIT: the kept one-connection refusal', () => {
  it('“It takes only one connection.”', () => {
    const capped = node('c', 'universal', { isDynamic: true,
      dynamicInputPorts: [{ id: 'refs', label: 'Refs', dataType: 'Image', multiple: true, maxConnections: 1 }], dynamicOutputPorts: [] });
    const images = [node('i1', 'image-input'), node('i2', 'image-input')];
    expect(checkKeptWire({ source: 'i2', sourceHandle: 'image', target: 'c', targetHandle: 'refs' }, [capped, ...images],
      [edge('i1', 'image', 'c', 'refs')])).toEqual({ ok: false, line: 'Couldn’t connect to “Refs”. It takes only one connection.' });
  });
});

describe('GM r27, 1: each kept control its own verb', () => {
  it('a note’s Delete, GM’s line verbatim; Rerun, Retry and Recover by their own verbs', () => {
    expect(keptLockTitle('delete-note')).toBe('You can delete the note after you save it as a project.');
    expect(keptLockTitle('rerun')).toBe('You can rerun it after you save it as a project.');
    expect(keptLockTitle('retry')).toBe('You can retry it after you save it as a project.');
    expect(keptLockTitle('recover')).toBe('You can recover it after you save it as a project.');
  });

  it('the controls ask for them', () => {
    const src = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
    expect(src('components/canvas/PinLayer.tsx')).toMatch(/aria-label="Delete note"\s*\{\.\.\.lock\.act\(\{ kept: 'delete-note' \}\)\}/);
    expect(src('components/panels/RunHistoryPanel.tsx'))
      .toContain("kept: recoveryReplayReady ? 'recover' : r.status === 'failed' ? 'retry' : 'rerun'");
    expect(src('components/panels/RunHistoryPanel.tsx')).toMatch(/kept: 'rerun', disabled: !latestSourceReady/);
    expect(src('components/nodes/ModelNode.tsx')).toMatch(/offline: 'rerun', kept: 'rerun'/);
  });
});

describe('GM r27, 3 and review 17 NIT-2: the following lines', () => {
  it('Nebula’s own reopen: the lock form', () => {
    expect(runWhileFollowingLine(null, null, 'Delta', undefined, true)).toBe('You can run the canvas when “Delta” opens.');
    expect(runWhileFollowingLine('Hero', null, 'Delta', undefined, true)).toBe('You can run “Hero” when “Delta” opens.');
    expect(runWhileFollowingLine(null, null, 'Delta', 3, true)).toBe('You can run 3 nodes when “Delta” opens.');
  });

  it('an agent’s: “Couldn’t run …” with ’', () => {
    expect(runWhileFollowingLine(null, 'Codex', 'Delta')).toBe('Couldn’t run the canvas. Codex is opening “Delta”.');
  });
});

describe('GM r28, 2: the person’s own selection isn’t in the in-app activity', () => {
  it('no app surface reads selection events (the Agent log takes agentPresence and window lines; Updates are agents’ notes)', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const root = resolve(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = resolve(dir, name);
      if (statSync(full).isDirectory()) walk(full); else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(full); } };
    walk(root);
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => /selection\.changed|canvas\/events/.test(readFileSync(file, 'utf8')))).toEqual([]);
    const log = readFileSync(resolve(root, 'store/agentLogStore.ts'), 'utf8');
    expect(log).toMatch(/if \(event\.type !== 'agentPresence'\) return;/);
  });
});

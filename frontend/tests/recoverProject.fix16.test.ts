import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverProject } from '../src/lib/projects';

/**
 * PR #199 round 16 (review 14 HIGH-1; GM r21, 3): the recover route's answer
 * carries what it changed on the way in, which the kept tab adopts:
 * `renumbered` (each tab-local node id to the copy's backend id) and
 * `droppedWires` (wires its rules left out, each with its line).
 */
afterEach(() => { vi.restoreAllMocks(); });

describe('recoverProject reads renumbered and droppedWires', () => {
  it('keeps the well-formed entries and drops the rest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      project: { id: 'copy', name: 'Alpha (recovered)' }, workspaceRevision: 'r',
      renumbered: { 'local-a': 'n2', 'local-b': 3 },
      droppedWires: [{ source: 'n1', target: 'n2', targetHandle: 'prompt', line: '“Prompt” takes one connection.' }, { bad: true }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const copy = await recoverProject('alpha', { nodes: [], edges: [] } as never, 'rid', 1, 'Alpha');
    expect(copy).toMatchObject({ id: 'copy', name: 'Alpha (recovered)', renumbered: { 'local-a': 'n2' },
      droppedWires: [{ source: 'n1', target: 'n2', targetHandle: 'prompt', line: '“Prompt” takes one connection.' }] });
    expect(copy.renumbered).not.toHaveProperty('local-b');
  });

  it('an older answer (neither field) is the project as before', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      project: { id: 'copy', name: 'Alpha (recovered)' }, workspaceRevision: 'r' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const copy = await recoverProject('alpha', { nodes: [], edges: [] } as never, 'rid', 1);
    expect(copy).toEqual({ id: 'copy', name: 'Alpha (recovered)' });
  });
});

import { describe, expect, it, vi } from 'vitest';

// PR #199 round 23 (review 21 NIT-2): a handoff's answer names the deletes
// a guard refused, each with the person's line; saveProject passes the lines
// on (projectStore says them), and nothing else.
const answer = vi.hoisted(() => ({ body: {} as unknown }));
vi.mock('../../src/lib/apiRequest', () => ({
  apiRequest: vi.fn(async () => new Response(JSON.stringify(answer.body), { status: 200 })),
}));
const { saveProject } = await import('../../src/lib/projects');

const project = { id: 'p1', name: 'Delta' };
describe('saveProject: deletesHeld', () => {
  it('passes each refused delete’s line on, and leaves malformed entries out', async () => {
    answer.body = { project, deletesHeld: [{ nodeId: 'n2', line: '“A” has a saved World Labs recovery ID.' }, { nodeId: 'n3' }, null, 'x'] };
    expect(await saveProject('p1', { nodes: [], edges: [] } as never, 'r1')).toEqual(
      { ...project, deletesHeld: ['“A” has a saved World Labs recovery ID.'] });
  });

  it('keeps deletesKept beside it, and the project itself when neither is there', async () => {
    answer.body = { project, deletesKept: ['n4'], deletesHeld: [{ nodeId: 'n2', line: 'L' }] };
    expect(await saveProject('p1', { nodes: [], edges: [] } as never, 'r1')).toEqual({ ...project, deletesKept: ['n4'], deletesHeld: ['L'] });
    answer.body = { project };
    expect(await saveProject('p1', { nodes: [], edges: [] } as never, 'r1')).toEqual(project);
  });
});

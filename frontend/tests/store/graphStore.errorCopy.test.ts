import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeSpy } from '../helpers/noticeSpy';

/**
 * error-copy round 2, item 6 (GM - Design), the canvas store: "Never
 * 'failed:', '(HTTP 503)' or status codes in the UI. Keep them in the
 * console." What reaches the person (an alert, the undo notice) is
 * "Couldn't {verb} {object}." and the reason. On 1fc3d846 these said
 * "Backend rejected node creation (HTTP 400).", "Backend rejected graph
 * clear (HTTP 409).", "Backend rejected deletion of n1 (HTTP 409)." and
 * "Refused (HTTP 400).". Only the browser's fetch is stubbed.
 */

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
// Round 3f: the alerts are canvas notices (tests/helpers/noticeSpy.ts).
const alertMock = noticeSpy();

const { useGraphStore } = await import('../../src/store/graphStore');

const NO_ANSWER = "Nebula didn't respond. Try again.";
const REFUSED = "Try again, or reload if it keeps happening.";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });

const textNode = (id: string) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Text Input', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} },
});

beforeEach(() => {
  fetchMock.mockReset();
  alertMock.mockClear();
  warn.mockClear();
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], isExecuting: false,
    backendFreshStartPending: false, undoNotice: null } as never);
});

const alerted = () => String(alertMock.mock.calls.at(-1)?.[0] ?? '');

describe('adding a node', () => {
  it('a refused create with no reason: "Couldn\'t add Text Input." and GM\'s line', async () => {
    useGraphStore.setState({ nodes: [textNode('n7')] as never });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 400 }));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(alerted()).toBe(`Couldn't add Text Input. ${REFUSED}`);
    expect(alerted()).not.toMatch(/HTTP|400/);
    // The status stays in the console.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/HTTP 400/);
  });

  it('a 503 says Nebula didn\'t respond, whatever its body said', async () => {
    useGraphStore.setState({ nodes: [textNode('n7')] as never });
    fetchMock.mockResolvedValueOnce(json({ detail: 'Paid-start safety journal unavailable' }, 503));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(alerted()).toBe(`Couldn't add Text Input. ${NO_ANSWER}`);
  });

  it('a refused fresh-canvas clear keeps the backend\'s reason, without the status', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ empty: false, nodes: [{ id: 'n9' }], edges: [] }))
      .mockResolvedValueOnce(json({ detail: 'Graph has protected provider state' }, 409));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(alerted()).toBe("Couldn't add Text Input. Graph has protected provider state");
  });

  // Round 3e (GM): the store's own lines were written for developers
  // ("Backend returned an invalid graph export response.").
  it('an export answer Nebula can\'t read says so in words', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(alerted()).toBe("Couldn't add Text Input. Nebula couldn't read the backend's answer, so the node wasn't added. "
      + 'Reload, then add it again.');
  });

  it('a refused graph export with no reason: GM\'s line', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(alerted()).toBe(`Couldn't add Text Input. ${REFUSED}`);
  });
});

describe("a person-only refusal (code person_required, GM Q116 a)", () => {
  it("adding a node says GM's line, never the agents' text", async () => {
    useGraphStore.setState({ nodes: [textNode('n7')] as never });
    fetchMock.mockResolvedValueOnce(json({ detail: 'krea-2-generate: propose the change instead with propose_change',
      code: 'person_required' }, 403));
    expect(await useGraphStore.getState().addNode('text-input', { x: 10, y: 20 })).toBeNull();
    expect(alerted()).toBe("Couldn't add Text Input. This change needs your OK, and this tab isn't connected as you. Open the link Nebula printed when it started, then try again.");
  });
});

describe('deleting a node', () => {
  it('a refused delete: "Couldn\'t delete the node." and the reason, never its id or status', async () => {
    useGraphStore.setState({ nodes: [textNode('n1')] as never });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 409 }));
    useGraphStore.getState().onNodesChange([{ type: 'remove', id: 'n1' }]);
    await vi.waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(alerted()).toBe(`Couldn't delete the node. ${REFUSED}`);
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('two refused deletes with the same reason say it once', async () => {
    useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2')] as never });
    fetchMock.mockImplementation(async () => json({ detail: 'A run is going.' }, 409));
    useGraphStore.getState().onNodesChange([{ type: 'remove', id: 'n1' }, { type: 'remove', id: 'n2' }]);
    await vi.waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(alerted()).toBe("Couldn't delete 2 nodes. A run is going.");
  });

  // Review: a node another window already removed answers 404 ("Node 'n1'
  // not found"). The person wanted it gone and it is: the canvas drops it
  // and says nothing, as an undo of an already-gone node does (restore).
  it('a delete answered 404 (already gone) takes the node off the canvas, with no alert', async () => {
    useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2')] as never });
    fetchMock.mockImplementation(async () => json({ detail: "Node 'n1' not found" }, 404));
    useGraphStore.getState().onNodesChange([{ type: 'remove', id: 'n1' }]);
    await vi.waitFor(() => expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['n2']));
    expect(alertMock).not.toHaveBeenCalled();
  });
});

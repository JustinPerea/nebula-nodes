/**
 * GM - Design, 2026-10-23 (Q116 a): "This change needs your OK, and this tab
 * isn't connected as you. Reconnect it with the link in the notice below,
 * then try again." "Use it for every person-only refusal, not just Krea
 * billing. The agents' text stays behind Details."
 *
 * A node's refused start (a billing change, an approved run, the agents'
 * spending limits, refused because this tab isn't connected as the person) is
 * shown on its card: GM's line, and the backend's words, written for agents,
 * behind the card's collapsed Details toggle (components/failure/ErrorDetails).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import { ExecutionStartRejectedError } from '../src/lib/api';
import { NodeRunError } from '../src/components/nodes/NodeError';
import { RUN_HISTORY_STORAGE_KEY } from '../src/lib/runHistory';

const GM_LINE = "This change needs your OK, and this tab isn't connected as you. Reconnect it with the link in the notice below, then try again.";
const BILLING = "n1: Changing how a Krea node is billed (_kreaAuth) is the person's call, so it needs their OK. Leave _kreaAuth as it is, and propose the change instead with propose_change (`nebula propose`); the person accepts it on the canvas.";

const krea = {
  id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Krea 2', definitionId: 'krea-2-generate', params: { _kreaAuth: 'mcp' }, state: 'idle' as const, outputs: {} },
};

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
  useGraphStore.setState({ nodes: [krea], edges: [], runHistory: [], isExecuting: false, isCancelling: false,
    providerRecoveryWarning: null, uncertainWorldLabsRunId: null, providerRecoveries: [], providerStartAmbiguities: [] });
  vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'failed' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('a run start refused because this tab is not connected as the person', () => {
  it("shows GM's line on the card, with the agents' text behind a closed Details", async () => {
    vi.spyOn(api, 'executeNode').mockRejectedValue(new ExecutionStartRejectedError(BILLING, 403,
      { heading: "Couldn't run the node.", detail: BILLING, code: 'person_required' } as never));
    await useGraphStore.getState().executeNode('n1');
    const [node] = useGraphStore.getState().nodes;
    expect(node.data.state).toBe('error');
    expect(node.data.errorPerson).toBe(GM_LINE);
    expect(node.data.error).toBe(BILLING);

    const { container } = render(<NodeRunError data={node.data} className="model-node__run-error" />);
    expect(screen.getByText(GM_LINE)).toBeTruthy();
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')?.textContent).toBe('Details');
    expect(details!.textContent).toContain(BILLING);
  });

  it('a refused start with no person_required code reads as before, with no Details', async () => {
    vi.spyOn(api, 'executeNode').mockRejectedValue(new ExecutionStartRejectedError(BILLING, 403,
      { heading: "Couldn't run the node.", detail: BILLING }));
    await useGraphStore.getState().executeNode('n1');
    const [node] = useGraphStore.getState().nodes;
    expect(node.data.error).toBe(`Couldn't run the node. ${BILLING}`);
    expect(node.data.errorPerson).toBeUndefined();
    const { container } = render(<NodeRunError data={node.data} className="model-node__run-error" />);
    expect(container.querySelector('details')).toBeNull();
  });
});

/**
 * Error copy round 3e, item 3 (GM - Design): the Paper source card. It showed
 * a Paper route's detail as is ("Paper CLI unavailable; open Paper Desktop or
 * configure NEBULA_PAPER_CLI", "Paper tool failed") and its own fallbacks
 * started "Could not". Now a route's refusal reads "Couldn't {verb} {object}."
 * over the route's `person` line (paper_routes), the specific text stays in
 * `detail.message` and the record's `lastError` for agents, and after a
 * reload the card reads the record's `lastErrorPerson`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

vi.mock('../src/lib/backend', async (original) => ({
  ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: vi.fn(),
}));
vi.mock('../src/lib/paperDesktop', () => ({ isDesktopMode: vi.fn(), openExternalUrl: vi.fn() }));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { apiFetch } from '../src/lib/backend';
import { isDesktopMode, openExternalUrl } from '../src/lib/paperDesktop';
import { refreshPaperSource, PaperSourceError, type PaperSourceRecord } from '../src/lib/paperSource';
import { PaperSourceNode } from '../src/components/nodes/PaperSourceNode';
import { useGraphStore } from '../src/store/graphStore';

const RAW = 'Paper CLI unavailable; open Paper Desktop or configure NEBULA_PAPER_CLI';
const LINE = "Paper isn't answering. Open Paper Desktop, then try again.";
const identity = { fileId: 'file-a', pageId: 'page-a', objectId: 'logo-a', fileName: 'Logo file', pageName: 'Page 1',
  objectName: 'Editable A', openUrl: 'https://app.paper.design/file-a', navigation: 'file' as const };
const exportSettings = { format: 'png' as const, scale: '2x' as const, bounds: 'object' as const, background: 'artwork' as const };
const source: PaperSourceRecord = { id: 'source-a', identity, exportSettings, snapshots: [], state: 'current', sequence: 1 };
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const INITIAL = { ...useGraphStore.getState() };

function Harness() {
  const data = useGraphStore((state) => state.nodes[0].data);
  return <ReactFlowProvider><PaperSourceNode {...{ id: 'paper-node', data, selected: false } as NodeProps} /></ReactFlowProvider>;
}
function seed(linked: PaperSourceRecord) {
  useGraphStore.setState({ nodes: [{ id: 'paper-node', type: 'paperSourceNode', position: { x: 0, y: 0 },
    data: { label: 'Paper source', definitionId: 'paper-source', params: { _paperSource: linked }, state: 'idle', outputs: {} } }], edges: [] });
}

beforeEach(() => {
  vi.mocked(isDesktopMode).mockReturnValue(false);
  useGraphStore.setState(INITIAL, true);
});
afterEach(() => {
  cleanup();
  vi.mocked(apiFetch).mockReset();
});

describe("a Paper route's refusal", () => {
  it("reads the action's heading over the route's line, and keeps the text for the console", async () => {
    const kept = { ...source, state: 'unavailable', lastError: RAW, lastErrorPerson: LINE, sequence: 2 };
    vi.mocked(apiFetch).mockResolvedValue(answer(503, { detail: { message: RAW, person: LINE, source: kept } }));
    const error = await refreshPaperSource('source-a').catch((e: unknown) => e) as PaperSourceError;
    expect(error).toBeInstanceOf(PaperSourceError);
    expect(error.message).toBe(`Couldn't refresh the source. ${LINE}`);
    expect(error.source).toMatchObject({ lastError: RAW });
    expect(JSON.stringify(error.detail)).toContain('NEBULA_PAPER_CLI');
  });

  it("an answer with no line reads GM's line for its status, never its body", async () => {
    vi.mocked(apiFetch).mockResolvedValue(answer(400, { detail: 'Paper tool failed' }));
    const error = await refreshPaperSource('source-a').catch((e: unknown) => e) as Error;
    expect(error.message).toBe("Couldn't refresh the source. That didn't work. Try again, or reload if it keeps happening.");
  });

  it('an answer the browser cannot read names the action', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('<html>', { status: 200 }));
    const error = await refreshPaperSource('source-a').catch((e: unknown) => e) as Error;
    expect(error.message).toMatch(/^Couldn't refresh the source\. /);
    expect(error.message).not.toMatch(/JSON|token|Unexpected/);
  });
});

describe('the Paper source card', () => {
  it("shows the route's line on Refresh, not the text agents read", async () => {
    seed(source);
    const kept = { ...source, state: 'unavailable', lastError: RAW, lastErrorPerson: LINE, sequence: 2 };
    vi.mocked(apiFetch).mockResolvedValue(answer(503, { detail: { message: RAW, person: LINE, source: kept } }));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`Couldn't refresh the source. ${LINE}`));
    expect(document.body.textContent).not.toContain('NEBULA_PAPER_CLI');
    // Agents still read the specific text on the record.
    expect((useGraphStore.getState().nodes[0].data.params._paperSource as PaperSourceRecord).lastError).toBe(RAW);
  });

  it("after a reload reads the record's line", () => {
    seed({ ...source, state: 'unavailable', lastError: RAW, lastErrorPerson: LINE });
    render(<Harness />);
    expect(screen.getByRole('alert')).toHaveTextContent(`Couldn't refresh the source. ${LINE}`);
    expect(document.body.textContent).not.toContain('NEBULA_PAPER_CLI');
  });

  it("a record saved before 3e reads GM's general line, its text behind Details", () => {
    seed({ ...source, state: 'unavailable', lastError: RAW });
    render(<Harness />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't refresh the source. That didn't work. Try again, or reload if it keeps happening.");
    const details = document.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('NEBULA_PAPER_CLI');
  });

  it("says Couldn't when Paper Desktop doesn't open", async () => {
    seed(source);
    vi.mocked(isDesktopMode).mockReturnValue(true);
    vi.mocked(openExternalUrl).mockRejectedValue(new Error('No protocol handler'));
    render(<Harness />);
    fireEvent.click(screen.getByRole('link', { name: 'Open in Paper' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't open Paper Desktop. Use Open source link."));
    expect(document.body.textContent).not.toMatch(/Could not|protocol handler/);
  });
});

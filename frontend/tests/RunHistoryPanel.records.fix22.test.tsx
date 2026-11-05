import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { RunHistoryPanel } from '../src/components/panels/RunHistoryPanel';
import { forgetNodeLabelsForTests } from '../src/lib/lastNodeLabels';
import { useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { useUIStore } from '../src/store/uiStore';
import type { RunRecord } from '../src/lib/runHistory';
import { frames } from './helpers/frames';

/**
 * Round 22 of PR #199 (review 20 RV LOW-2; GM r34 A1 and its addendum, A4):
 * Run History names each World Labs record by whose it is.
 * - this project's record, or one a canvas node holds the ID of: as before,
 *   the node's card title (and the removed forms);
 * - the record Nebula's open-hold verdict names: "“World” from “Alpha”",
 *   or "“World” from another project" with no project name;
 * - any other: its type when the record knows it (round 23, GM r36 item 1),
 *   else "A World Labs node from another project" (an operation ID alone).
 * The Forget ID button's name and its confirm's heading say the same. While
 * Run History is open, the held reopen's Forget ID line is the first line
 * of the safeguards section (GM r34 A4).
 *
 * LR1: Delta's n1 is a Text Input the person renamed "Delta brief"; Alpha's
 * n1 (a Text Input) has the record op-alpha-probe.
 */

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
const INITIAL_PROJECT = { ...useProjectStore.getState() };
const REOPEN_LINE = 'You can reopen “Delta” after you forget the World Labs recovery ID for “Text Input” from “Alpha” in Run History.';

const run = (id: string): RunRecord => ({ id, trigger: 'graph', status: 'complete', startedAt: Date.now(),
  snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] } });
const deltaBrief = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Delta brief', definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } };
const record = (runId: string, nodeId = 'n1', id = 'op-alpha-probe', world = false) => ({
  runId, nodeId, resumeOperationId: world ? null : id, existingWorldId: world ? id : null, durable: true });
const verdict = (over: Record<string, unknown> = {}) => ({ state: 'recovery', nodeId: 'n1', nodeName: 'Text Input',
  projectId: 'alpha', projectName: 'Alpha', count: 1, fields: [], ...over });

function setup({ records = [record('run-alpha')], hold = verdict() as Record<string, unknown> | null,
  nodes = [deltaBrief] as unknown[], history = [run('run-delta')] } = {}) {
  useGraphStore.setState({ nodes: nodes as never, runHistory: history, providerRecoveries: records });
  useProjectStore.setState({ openHold: hold as never, activeProject: { id: 'delta', name: 'Delta' } as never });
}
const rows = () => within(screen.getByRole('region', { name: 'World Labs recovery safeguards' }))
  .getAllByRole('listitem').map((item) => item.querySelector('span')?.textContent);

const clock = frames();
afterEach(() => clock.uninstall());
beforeEach(() => {
  clock.install();
  forgetNodeLabelsForTests();
  useGraphStore.setState(INITIAL_GRAPH, true);
  useUIStore.setState(INITIAL_UI, true);
  useProjectStore.setState(INITIAL_PROJECT, true);
  useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
});

describe('LR1: Alpha’s record on Delta’s canvas', () => {
  it('the verdict names it: “Text Input” from “Alpha”, in the row, the Forget ID name and the confirm’s heading', () => {
    setup();
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['“Text Input” from “Alpha” · Operation ID op-alpha-probe']);
    const forget = screen.getByRole('button', { name: 'Forget the recovery ID for “Text Input” from “Alpha”' });
    expect(forget).toHaveAccessibleDescription('“Text Input” from “Alpha” · Operation ID op-alpha-probe');
    fireEvent.click(forget);
    expect(screen.getByRole('alertdialog', { name: 'Forget the recovery ID for “Text Input” from “Alpha”?' })).toBeTruthy();
  });

  it('the verdict has the node’s name and no project name: “Text Input” from another project', () => {
    setup({ hold: verdict({ projectName: null }) });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['“Text Input” from another project · Operation ID op-alpha-probe']);
    expect(screen.getByRole('button', { name: 'Forget the recovery ID for “Text Input” from another project' })).toBeTruthy();
  });

  it('no verdict: A World Labs node from another project (never “Delta brief”)', () => {
    setup({ hold: null });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['A World Labs node from another project · Operation ID op-alpha-probe']);
    const forget = screen.getByRole('button', { name: 'Forget the recovery ID for a World Labs node from another project' });
    fireEvent.click(forget);
    expect(screen.getByRole('alertdialog', {
      name: 'Forget the recovery ID for a World Labs node from another project?' })).toBeTruthy();
  });

  it('the verdict with no node name: the placeholder', () => {
    setup({ hold: verdict({ nodeName: null }) });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['A World Labs node from another project · Operation ID op-alpha-probe']);
  });

  it('a verdict of another state, another node, or the open project names no row', () => {
    for (const hold of [verdict({ state: 'ambiguity' }), verdict({ nodeId: 'n2' }), verdict({ projectId: 'delta' })]) {
      setup({ hold });
      const { unmount } = render(<RunHistoryPanel />);
      expect(rows()).toEqual(['A World Labs node from another project · Operation ID op-alpha-probe']);
      unmount();
    }
  });

  it('the verdict names the first record the open project doesn’t own; a later one is the placeholder', () => {
    setup({ records: [record('run-delta', 'n1', 'op-delta'), record('run-alpha'), record('run-beta', 'n1', 'op-beta')] });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual([
      '“Delta brief” · Operation ID op-delta',
      '“Text Input” from “Alpha” · Operation ID op-alpha-probe',
      'A World Labs node from another project · Operation ID op-beta',
    ]);
  });

  it('a World ID record keeps its own label', () => {
    setup({ records: [record('run-alpha', 'n1', 'world-alpha', true)] });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['“Text Input” from “Alpha” · World ID world-alpha']);
  });
});

describe('this project’s records are named as before', () => {
  it('a record of Delta’s own run: the card title, even with a verdict naming n1', () => {
    setup({ records: [record('run-delta')] });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['“Delta brief” · Operation ID op-alpha-probe']);
    expect(screen.getByRole('button', { name: 'Forget the recovery ID for “Delta brief”' })).toBeTruthy();
  });

  it('a record the tab can’t place whose ID Delta’s World node holds: the card title', () => {
    const deltaWorld = { ...deltaBrief, data: { ...deltaBrief.data, label: 'Delta world', definitionId: 'worldlabs-environment',
      params: { resume_operation_id: 'op-alpha-probe' } } };
    setup({ nodes: [deltaWorld], hold: null });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['“Delta world” · Operation ID op-alpha-probe']);
  });

  it('this project’s record whose node left the canvas: the removed form', () => {
    setup({ nodes: [], records: [record('run-delta')], hold: null });
    render(<RunHistoryPanel />);
    expect(rows()).toEqual(['A removed World Labs node · Operation ID op-alpha-probe']);
  });
});

describe('GM r34 A4: the held reopen’s Forget ID line tops the safeguards while Run History is open', () => {
  it('the same words, first in the section, in its own polite status region', () => {
    setup();
    useProjectStore.setState({ heldReopenLine: { id: 'delta', line: REOPEN_LINE, place: 'runHistory' } });
    render(<RunHistoryPanel />);
    const section = screen.getByRole('region', { name: 'World Labs recovery safeguards' });
    const line = within(section).getByRole('status');
    expect(line.textContent).toBe('');
    clock.flush();
    expect(line).toHaveTextContent(REOPEN_LINE);
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(section.firstElementChild).toBe(line);
  });

  it('it follows the line, and empties when the line goes; the region stays mounted', () => {
    setup();
    render(<RunHistoryPanel />);
    const line = within(screen.getByRole('region', { name: 'World Labs recovery safeguards' })).getByRole('status');
    expect(line.textContent).toBe('');
    act(() => useProjectStore.setState({ heldReopenLine: { id: 'delta', line: REOPEN_LINE, place: 'runHistory' } }));
    clock.flush();
    expect(line).toHaveTextContent(REOPEN_LINE);
    act(() => useProjectStore.setState({ heldReopenLine: null }));
    expect(line.isConnected).toBe(true);
    expect(line.textContent).toBe('');
  });

  it('a line placed elsewhere (by Stop, in the World Labs notice) doesn’t show here', () => {
    setup();
    useProjectStore.setState({ heldReopenLine: { id: 'delta', line: REOPEN_LINE, place: 'stop' } });
    render(<RunHistoryPanel />);
    expect(screen.queryByText(REOPEN_LINE)).toBeNull();
  });

  it('with no record in this tab yet, the section still shows the line', () => {
    setup({ records: [] });
    useProjectStore.setState({ heldReopenLine: { id: 'delta', line: REOPEN_LINE, place: 'runHistory' } });
    render(<RunHistoryPanel />);
    clock.flush();
    expect(within(screen.getByRole('region', { name: 'World Labs recovery safeguards' })).getByRole('status'))
      .toHaveTextContent(REOPEN_LINE);
    expect(screen.queryByText(/These IDs prevent/)).toBeNull();
  });
});

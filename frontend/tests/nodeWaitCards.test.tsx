import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import { CANVAS_CARDS } from '../src/components/canvasTypes';
import { CinemaSceneNode } from '../src/components/nodes/CinemaSceneNode';
import { WAITING_FOR_OK } from '../src/lib/canvasProposals';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { resetDeletedSceneEditsForTests, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { ProposalView } from '../src/lib/wsClient';
import type { NodeData } from '../src/types';

/**
 * GM - Design, PR #212 round 3, item 6: every card kind that can be the
 * subject of a held (paid) run gets the header wait. The paid kinds are the
 * ones whose definition has a list price: the model and dynamic cards (and
 * the Video QC card, which draws a model card) and the Cinema scene, which
 * prices its base model. The rest are utilities that never bill (inputs,
 * notes, Batch, Paper source, Video Edit, Remotion, Character, Camera rig,
 * Reference set, Moodboard, Reroute); a new card kind has to be put on one
 * list or the other here.
 */
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

const PAID = ['model-node', 'dynamic-node', 'videoQcNode', 'cinemaSceneNode'];
const NEVER_BILLS = ['reroute-node', 'editNode', 'remotionNode', 'characterNode', 'cameraRigNode', 'referenceSetNode',
  'moodboardNode', 'paperSourceNode', 'batchNode'];
const FILES: Record<string, string> = {
  'model-node': 'ModelNode', 'dynamic-node': 'DynamicNode', videoQcNode: 'VideoQcNode', cinemaSceneNode: 'CinemaSceneNode',
  'reroute-node': 'RerouteNode', editNode: 'EditNode', remotionNode: 'RemotionNode', characterNode: 'CharacterNode',
  cameraRigNode: 'CameraRigNode', referenceSetNode: 'ReferenceSetNode', moodboardNode: 'MoodboardNode',
  paperSourceNode: 'PaperSourceNode', batchNode: 'BatchNode',
};
const source = (kind: string) => readFileSync(join(__dirname, '../src/components/nodes', `${FILES[kind]}.tsx`), 'utf8');

const BAR = 'This would pass the $5 daily total, which has $0.20 left.';
const view = (id: string, nodeIds: string[]): ProposalView => ({
  id, status: 'open', agent: { id: 'ext:Claude Code', name: 'Claude Code', color: '#c7f36b', verified: false },
  note: BAR, projectId: 'p', createdAt: 1, expiresAt: Date.now() + 600_000, nodes: [], edges: [], params: [], run: nodeIds,
  cost: { paidRuns: 1, freeRuns: 0, estimate: 0.4, upTo: false, providers: ['openai'], nodes: [], note: '' },
  references: nodeIds, reason: null, idMap: null, runNodeIds: null,
  wait: { limitUsd: 5, usedUsd: 4.8, leftUsd: 0.2, runUsd: 0.4, also: null, alsoLimitUsd: null, alsoModel: null,
    alsoFor: null, alsoPlanRuns: null, barLine: BAR, nodeIds, names: nodeIds },
});

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;
beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  useUIStore.setState({ skin: 'slava-restraint' });
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  resetDeletedSceneEditsForTests();
  vi.unstubAllGlobals();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
});

describe('which card kinds draw the header wait', () => {
  it('every canvas card kind is classified, and a paid one draws the wait', () => {
    expect([...PAID, ...NEVER_BILLS].sort()).toEqual(Object.keys(CANVAS_CARDS).sort());
    for (const kind of ['model-node', 'dynamic-node', 'cinemaSceneNode']) {
      expect(source(kind), kind).toMatch(/NodeWaitSwap/);
      expect(source(kind), kind).toMatch(/nodeWaitHeaderProps/);
    }
    // Video QC draws a model card.
    expect(source('videoQcNode')).toMatch(/<ModelNode /);
    for (const kind of NEVER_BILLS) expect(source(kind), kind).not.toMatch(/NodeWaitSwap/);
  });
});

describe('the Cinema scene\'s title row', () => {
  function scene() {
    const node: Node<NodeData> = { id: 's1', type: 'cinemaSceneNode', position: { x: 0, y: 0 },
      data: { definitionId: 'cinema-scene', label: 'Cinema Scene', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    return render(<CinemaSceneNode {...({ id: 's1', data: node.data, selected: false } as NodeProps)} />);
  }
  const title = (c: HTMLElement) => c.querySelector<HTMLElement>('.cinema-scene-node__title')!;

  it('takes the label on its right, the tint and the description, and adds no row', () => {
    const { container } = scene();
    expect(container.querySelector('.node-wait-swap')).toBeNull();
    const rowsBefore = [...container.querySelector('.cinema-scene-node')!.children].map((el) => el.className);
    act(() => useCanvasProposalsStore.getState().open(view('p_one', ['s1']), 'key'));
    expect(title(container).dataset.waiting).toBe('true');
    expect(title(container).style.getPropertyValue('--agent-color')).toBe('#c7f36b');
    const label = container.querySelector('.node-wait-swap__label')!;
    expect(title(container).contains(label)).toBe(true);
    expect(label.querySelector('.node-wait-swap__full')!.textContent).toBe(WAITING_FOR_OK);
    expect(document.getElementById(title(container).getAttribute('aria-describedby')!)!.textContent)
      .toBe(`A proposal is waiting for your OK. ${BAR}`);
    expect([...container.querySelector('.cinema-scene-node')!.children].map((el) => el.className)).toEqual(rowsBefore);
    // The title is still first in the row and truncates; the label does not.
    expect(title(container).firstElementChild!.className).toBe('cinema-scene-node__name');
  });

  it('keeps its name truncating and its padding taken back, so the card never changes size', () => {
    const css = readFileSync(join(__dirname, '../src/styles/cinema-node.css'), 'utf8');
    expect(css).toMatch(/__name \{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/__title \{[^}]*margin:\s*-4px -8px 8px;[^}]*padding:\s*4px 8px;/);
  });
});

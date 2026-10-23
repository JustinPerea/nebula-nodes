/**
 * Error copy round 3g: GM - Design's answers to round 3f's questions, and two
 * fixes (GM, verbatim, 2026-10-23).
 *
 * 1. "While a) builds, ship c) so the Delete key doesn't start asking on every
 *    delete. It asks only when a node has pins or open proposals; the
 *    toolbar, menu and Inspector paths keep the confirm until a) lands."
 * 4. "Cinema shot panel: yes, use shot wording. "Generate the shot again. If
 *    it keeps failing, Details shows what {Provider} said." With no provider:
 *    "Generate the shot again. If it keeps failing, open Details." With
 *    nothing behind Details: "Generate the shot again.""
 * 5. "Provider chip: "Auto · Black Forest Labs". If the chip can't fit it at
 *    its narrowest, keep "BFL" in the chip only, with the full name in its
 *    title and aria-label."
 * - "Readiness, answered failure: "Nebula didn't respond" is wrong when
 *   something did answer. → "Couldn't check the connections. Try again, or
 *   reload if it keeps happening.""
 *
 * The Delete key's rule reads the canvas's own pins and proposals; the same
 * cases (backend/tests/fixtures/delete_confirm_cases.json) are pinned against
 * the backend's real delete in backend/tests/test_error_copy_round3g.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import deleteCases from '../../backend/tests/fixtures/delete_confirm_cases.json';
import pricingCases from '../../backend/tests/fixtures/pricing_cases.json';
import type { CinemaSceneSpec, ModelNodeDefinition, NodeData } from '../src/types';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({ ...await original<typeof import('../src/lib/backend')>(),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { deleteLosesAttachments, type DeleteAttachments } from '../src/lib/deleteConfirm';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';
import { NodeError } from '../src/components/nodes/NodeError';
import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { ProviderSwitcher } from '../src/components/nodes/ProviderSwitcher';
import { CHIP_ROOM, CHIP_ROOM_BLOCKED, chipText, providerSwitchState, type SwitchContext } from '../src/lib/providerSwitch';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useProviderReadinessStore } from '../src/store/providerReadinessStore';
import type { PricingTable } from '../src/lib/pricing';

const initialGraph = { ...useGraphStore.getState() };
const initialUi = { ...useUIStore.getState() };
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUi, true);
  mocks.fetch.mockReset();
});

// -- GM item 1: the Delete key asks only when a delete takes something ----------

interface Case {
  name: string;
  nodes: Array<{ id: string; image?: string }>;
  pins?: Array<{ on: string | null; status: string }>;
  proposals?: Array<{ reads: string; as: string; status: string }>;
  coverPin?: string;
  covers?: Array<{ to: string | null }>;
  delete: string[];
  asks: boolean;
}

const PROJECT = 'p-open';

/** A fixture case as the canvas's stores hold it (the views the backend test
 * checks: a proposal's `references`, a cover proposal's change.cover). */
function attachmentsOf(c: Case): DeleteAttachments {
  return {
    pins: (c.pins ?? []).map((pin) => ({ anchor: pin.on ? { nodeId: pin.on } : { x: 5, y: 5 } })),
    proposals: (c.proposals ?? []).map((proposal) => ({ view: { status: proposal.status, references: [proposal.reads] } })),
    covers: (c.covers ?? []).map((cover) => ({ view: { kind: 'project', status: 'open', target: { id: PROJECT },
      change: { cover: { from: c.coverPin ?? null, to: cover.to } } } })),
    projectId: PROJECT,
    nodes: c.nodes.map((spec) => ({ id: spec.id, data: spec.image
      ? { definitionId: 'nano-banana', params: {}, outputs: { image: { type: 'Image', value: spec.image } } }
      : { definitionId: 'text-input', params: { value: 'a cat' }, outputs: {} } })),
  };
}

describe('the Delete key\'s rule agrees with the backend\'s delete', () => {
  const cases = (deleteCases as { cases: Case[] }).cases;

  it('covers pins, proposals and cover proposals', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.some((c) => c.asks) && cases.some((c) => !c.asks)).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(deleteLosesAttachments(c.delete, attachmentsOf(c))).toBe(c.asks);
  });

  it('reads an image the canvas holds at its full backend address as the same image', () => {
    const c = cases.find((item) => item.name === "a cover proposal for the node's image")!;
    const attached = attachmentsOf(c);
    const nodes = attached.nodes.map((node) => node.id === 'n1'
      ? { ...node, data: { ...node.data, outputs: { image: { type: 'Image', value: 'http://127.0.0.1:8791/api/outputs/a.png' } } } }
      : node);
    expect(deleteLosesAttachments(['n1'], { ...attached, nodes })).toBe(true);
  });

  it('a cover proposal for another project, or one closing, takes nothing from this canvas', () => {
    const c = cases.find((item) => item.name === "a cover proposal for the node's image")!;
    const attached = attachmentsOf(c);
    expect(deleteLosesAttachments(['n1'], { ...attached, projectId: 'p-other' })).toBe(false);
    expect(deleteLosesAttachments(['n1'], { ...attached, covers: attached.covers.map((entry) => ({ ...entry, closing: 'rejected' })) }))
      .toBe(false);
    expect(deleteLosesAttachments(['n1'], { ...attached, proposals: [{ view: { status: 'open', references: ['n1'] }, closing: 'accepted' }],
      covers: [] })).toBe(false);
  });
});

function textNode(id: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'hello' }, outputs: {}, state: 'idle' } };
}

describe('the toolbar keeps the confirm', () => {
  it('asks on a plain node, with GM\'s plural', () => {
    useGraphStore.setState({ nodes: [textNode('n1', true)], edges: [], isExecuting: false });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Delete selected nodes'));
    expect(confirm).toHaveBeenCalledWith('Delete this node?');
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });
});

// -- GM item 4: the shot panel's own wording ---------------------------------------

const RAW = 'FAL submit failed (500): {"detail":"upstream exploded","request_id":"req_123"}';
const SHOT_HEADING = "Couldn't generate the shot.";
const heading = (root: ParentNode) => root.querySelector('.failure-lines__heading')?.textContent ?? null;
const reason = (root: ParentNode) => root.querySelector('.failure-lines__reason')?.textContent ?? null;

describe('the Cinema shot panel says "Generate the shot again."', () => {
  it('names the provider that answered, says "open Details" without one, and stops short with nothing behind Details', () => {
    expect(nodeErrorCopy({ raw: RAW, category: 'unknown', provider: 'fal.ai', surface: 'shot' })).toEqual({
      heading: SHOT_HEADING, reason: 'Generate the shot again. If it keeps failing, Details shows what fal.ai said.', details: RAW });
    expect(nodeErrorCopy({ raw: RAW, category: 'unknown', surface: 'shot' }).reason)
      .toBe('Generate the shot again. If it keeps failing, open Details.');
    expect(nodeErrorCopy({ raw: '', category: 'unknown', surface: 'shot' }).reason).toBe('Generate the shot again.');
  });

  it('the node card keeps "Run the node again."', () => {
    expect(nodeErrorCopy({ raw: RAW, category: 'unknown', provider: 'fal.ai' })).toEqual({ heading: "Couldn't run the node.",
      reason: 'Run the node again. If it keeps failing, Details shows what fal.ai said.', details: RAW });
    expect(nodeErrorCopy({ raw: '', category: 'unknown' }).reason).toBe('Run the node again.');
  });

  function shotPanel(output: NonNullable<CinemaSceneSpec['shots'][number]['output']>) {
    const spec: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9',
      shots: [{ id: 'a', prompt: 'Logo', output }] };
    const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, data: { label: 'Scene',
      definitionId: 'cinema-scene', params: { scene: spec }, state: 'error', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false, isShotAdmissionBlocked: () => false });
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
    return render(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
  }

  it('on the panel, from the shot\'s errorProvider', () => {
    const withProvider = shotPanel({ status: 'error', error: RAW.slice(0, 40), errorCategory: 'unknown', errorRaw: RAW,
      errorProvider: 'fal.ai' });
    let error = withProvider.container.querySelector('.cinema-shot-panel__error')!;
    expect(heading(error)).toBe(SHOT_HEADING);
    expect(reason(error)).toBe('Generate the shot again. If it keeps failing, Details shows what fal.ai said.');
    cleanup();
    const without = shotPanel({ status: 'error', error: RAW.slice(0, 40), errorCategory: 'unknown', errorRaw: RAW });
    error = without.container.querySelector('.cinema-shot-panel__error')!;
    expect(reason(error)).toBe('Generate the shot again. If it keeps failing, open Details.');
  });

  it('a card\'s NodeError keeps the card wording', () => {
    const { container } = render(<NodeError raw={RAW} category="unknown" provider="fal.ai" />);
    expect(heading(container)).toBe("Couldn't run the node.");
    expect(reason(container)).toBe('Run the node again. If it keeps failing, Details shows what fal.ai said.');
  });
});

// -- GM item 5: the provider chip names the provider in full when it fits -----------

const fixture = pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable };
const TABLE = fixture.definitions.table;
const KEY = 'fixture-only';
const context = (apiKeys: Record<string, string>): SwitchContext => ({ apiKeys, kreaSignedIn: false, pricing: fixture.pricing });

describe('the provider chip', () => {
  beforeEach(() => {
    NODE_DEFINITIONS.table = TABLE;
    usePricingStore.setState({ table: fixture.pricing, loading: false });
    useUIStore.setState({ skin: 'slava-restraint' });
  });
  afterEach(() => {
    delete NODE_DEFINITIONS.table;
    usePricingStore.setState({ table: null, loading: false });
  });

  it('has room for 14 characters, 12 beside the warning glyph (measured at 10px JetBrains Mono)', () => {
    expect([CHIP_ROOM, CHIP_ROOM_BLOCKED]).toEqual([14, 12]);
    expect(chipText('Auto · fal.ai', 'Auto · fal', false)).toBe('Auto · fal.ai');
    expect(chipText('Auto · fal.ai', 'Auto · fal', true)).toBe('Auto · fal');
    expect(chipText('Auto · Black Forest Labs', 'Auto · BFL', false)).toBe('Auto · BFL');
  });

  it('keeps "BFL" in the chip only: the full name in its state for the title and aria-label', () => {
    const state = providerSwitchState(TABLE, {}, context({ BFL_API_KEY: KEY }));
    expect(state.chip).toBe('Auto · BFL');
    expect(state.chipName).toBe('Auto · Black Forest Labs');
  });

  it('uses each provider\'s full name wherever it fits (rule 9)', () => {
    expect(providerSwitchState(TABLE, { _provider: 'replicate' }, context({ REPLICATE_API_TOKEN: KEY })).chip).toBe('Replicate');
    expect(providerSwitchState(TABLE, { _provider: 'openrouter' }, context({ OPENROUTER_API_KEY: KEY })).chip).toBe('OpenRouter');
    expect(providerSwitchState(TABLE, { _provider: 'fal' }, context({ FAL_KEY: KEY })).chip).toBe('fal.ai');
    expect(providerSwitchState(TABLE, { _provider: 'bfl' }, context({ BFL_API_KEY: KEY })).chip).toBe('BFL');
    const fal = providerSwitchState(TABLE, {}, context({ FAL_KEY: KEY }));
    expect([fal.chip, fal.chipName]).toEqual(['Auto · fal.ai', 'Auto · fal.ai']);
    // Beside the warning glyph "Auto · fal.ai" has no room.
    const blocked = providerSwitchState(TABLE, { resolution: '1.5k' }, context({ FAL_KEY: KEY }));
    expect(blocked.blocked).toBe(true);
    expect([blocked.chip, blocked.chipName]).toEqual(['Auto · fal', 'Auto · fal.ai']);
  });

  it('the chip button names the provider in full', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: { BFL_API_KEY: KEY },
      kreaConnection: { status: 'disconnected' } } });
    render(<ProviderSwitcher definition={TABLE} params={{}} variant="chip" onPick={vi.fn()} />);
    const chip = screen.getByRole('button', { name: 'Provider for Fixture Route Table: Auto · Black Forest Labs' });
    expect(chip).toHaveAttribute('title', 'Runs on Auto · Black Forest Labs. Change provider');
    expect(chip).toHaveTextContent('Auto · BFL');
  });

  it('Create Studio\'s pill wraps, so it names the provider in full', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: { BFL_API_KEY: KEY },
      kreaConnection: { status: 'disconnected' } } });
    render(<ProviderSwitcher definition={TABLE} params={{}} variant="pill" onPick={vi.fn()} />);
    const pill = screen.getByRole('button', { name: 'Provider for Fixture Route Table: Auto · Black Forest Labs' });
    expect(pill).toHaveTextContent('Auto · Black Forest Labs');
  });
});

// -- GM's readiness fix ---------------------------------------------------------

const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } });

describe('the readiness line when something answered', () => {
  const ANSWERED = "Couldn't check the connections. Try again, or reload if it keeps happening.";

  it('an answered failure reads GM\'s line, never "didn\'t respond"', async () => {
    for (const status of [503, 500, 429, 404]) {
      mocks.fetch.mockResolvedValueOnce(json(status, { detail: 'internal' }));
      await useProviderReadinessStore.getState().checkConnections();
      expect(useProviderReadinessStore.getState().error).toBe(ANSWERED);
    }
  });

  it('a malformed answer reads it too', async () => {
    mocks.fetch.mockResolvedValueOnce(json(200, { providers: 'nope' }));
    await useProviderReadinessStore.getState().checkConnections();
    expect(useProviderReadinessStore.getState().error).toBe(ANSWERED);
  });

  it('no answer keeps the server line', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useProviderReadinessStore.getState().checkConnections();
    expect(useProviderReadinessStore.getState().error)
      .toBe("Couldn't check the connections. Nebula's server isn't answering. Make sure it's running, then try again.");
  });
});

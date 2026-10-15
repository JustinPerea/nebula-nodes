import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import { ProviderSwitcher } from '../../src/components/nodes/ProviderSwitcher';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { Inspector } from '../../src/components/panels/Inspector';
import { ParamPills } from '../../src/components/create-studio/ParamPills';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { useGraphStore } from '../../src/store/graphStore';
import { usePricingStore } from '../../src/store/pricingStore';
import { useProviderNoteStore } from '../../src/store/providerNoteStore';
import { useUIStore } from '../../src/store/uiStore';
import type { PricingTable } from '../../src/lib/pricing';
import type { ModelNodeDefinition, NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

/** The five-route fixture node and its prices (pricing_cases.json `table`):
 * BFL (maker), fal (no 1.5k, no 9:21, unconfirmed price), Replicate,
 * OpenRouter (no price, at most 4 images) and Krea (API balance or plan). A
 * test-only definition: no production node uses routes in this PR. */
const fixture = pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable };
const TABLE = fixture.definitions.table;
const KEY = 'fixture-only';

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  NODE_DEFINITIONS.table = TABLE;
  usePricingStore.setState({ table: fixture.pricing, loading: false });
  useUIStore.setState({ skin: 'slava-restraint' });
  useProviderNoteStore.setState({ notes: {} });
});

afterEach(() => {
  cleanup();
  delete NODE_DEFINITIONS.table;
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
  usePricingStore.setState({ table: null, loading: false });
});

function withKeys(apiKeys: Record<string, string>, kreaSignedIn = false) {
  useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys,
    kreaConnection: kreaSignedIn ? { status: 'connected' } : { status: 'disconnected' } } });
}

function Controlled({ initial = {}, variant = 'inspector', onPick }: {
  initial?: Record<string, unknown>;
  variant?: 'inspector' | 'chip' | 'pill';
  onPick?: (next: Record<string, unknown>, notes: string[]) => void;
}) {
  const [params, setParams] = useState(initial);
  return <ProviderSwitcher definition={TABLE} params={params} variant={variant} onPick={(next, notes) => {
    setParams(next);
    onPick?.(next, notes);
  }} />;
}

function row(name: RegExp | string) {
  return screen.getByRole('menuitemradio', { name });
}

describe('ProviderSwitcher rows', () => {
  it('lists Auto and every route with key state, price and block note', () => {
    withKeys({ BFL_API_KEY: KEY });
    render(<Controlled initial={{ aspect_ratio: '9:21' }} />);
    const menu = screen.getByRole('menu', { name: 'Provider' });
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios.map((item) => item.querySelector('.provider-switcher__label')?.textContent)).toEqual([
      'Auto · runs on Black Forest Labs', 'Black Forest Labs', 'fal.ai', 'Replicate', 'OpenRouter',
      'Krea · API balance', 'Krea · plan',
    ]);
    expect(row(/^Auto/)).toHaveAttribute('aria-checked', 'true');
    // Key state: BFL's key is set, the others offer to add theirs.
    const bfl = row(/^Black Forest Labs/).closest('[data-provider-row]') as HTMLElement;
    expect(within(bfl).getByText('Key set')).toBeVisible();
    expect(within(bfl).getByText('$0.03')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Add a fal.ai key in Settings' })).toHaveTextContent('Add key →');
    expect(screen.getByRole('menuitem', { name: 'Sign in to Krea in Settings' })).toHaveTextContent('Sign in');
    // fal can't take 9:21: a block note, and no price.
    const fal = row(/^fal\.ai/);
    expect(fal).toHaveTextContent("Doesn't take 9:21");
    expect(fal.querySelector('.provider-switcher__price')).toHaveTextContent('-');
  });

  it('marks an unconfirmed price with *', () => {
    withKeys({ FAL_KEY: KEY });
    render(<Controlled />);
    expect(row(/^fal\.ai/).querySelector('.provider-switcher__price')).toHaveTextContent('$0.035*');
    expect(row(/^OpenRouter/).querySelector('.provider-switcher__price')).toHaveTextContent('-');
  });

  it('opens Settings at the provider from "Add key →" and at Krea from "Sign in"', () => {
    withKeys({});
    const open = vi.spyOn(useUIStore.getState(), 'openProviderSetup');
    useUIStore.setState({ openProviderSetup: open });
    render(<Controlled />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a Replicate key in Settings' }));
    expect(open).toHaveBeenLastCalledWith({ kind: 'api-key', key: 'REPLICATE_API_TOKEN' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign in to Krea in Settings' }));
    expect(open).toHaveBeenLastCalledWith({ kind: 'krea-mcp' });
  });
});

describe('ProviderSwitcher picks', () => {
  it('a switch writes _provider and snaps the values the new route lacks, with a note', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    const onPick = vi.fn();
    render(<Controlled initial={{ resolution: '1.5k', grounding: true }} onPick={onPick} />);
    fireEvent.click(row(/^fal\.ai/));
    expect(onPick).toHaveBeenCalledWith({ resolution: '2k', grounding: true, _provider: 'fal' },
      ["1.5k isn't on fal.ai: set to 2k"]);
    expect(row(/^fal\.ai/)).toHaveAttribute('aria-checked', 'true');
  });

  it('Krea shows two rows, and each writes both billing params', () => {
    withKeys({ KREA_API_TOKEN: KEY }, true);
    const onPick = vi.fn();
    render(<Controlled onPick={onPick} />);
    fireEvent.click(row(/^Krea · plan/));
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ _provider: 'krea', _kreaAuth: 'mcp' }), []);
    expect(row(/^Krea · plan/)).toHaveAttribute('aria-checked', 'true');
    expect(row(/^Krea · API balance/)).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(row(/^Krea · API balance/));
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ _provider: 'krea', _kreaAuth: 'api-token' }), []);
  });

  it('stops Auto on a value its route lacks and offers the routes that take it, one click each', () => {
    withKeys({ FAL_KEY: KEY, REPLICATE_API_TOKEN: KEY });
    const onPick = vi.fn();
    render(<Controlled initial={{ resolution: '1.5k' }} onPick={onPick} />);
    expect(row(/^Auto/)).toHaveTextContent("Auto · can't run: 1.5k isn't on fal.ai");
    expect(screen.getByRole('status')).toHaveTextContent("Fixture Route Table can't run on fal.ai");
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Replicate' }));
    expect(onPick).toHaveBeenCalledWith({ resolution: '1.5k', _provider: 'replicate' }, []);
  });

  it('keeps every value when the route changes without a click (keys removed), and flags the stop', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    const onPick = vi.fn();
    const params = { resolution: '1.5k' };
    const { rerender } = render(<ProviderSwitcher definition={TABLE} params={params} variant="chip" onPick={onPick} />);
    const chip = screen.getByRole('button', { name: /^Provider for Fixture Route Table: Auto · BFL$/ });
    expect(chip).not.toHaveClass('model-node__provider-chip--blocked');
    // The BFL key goes away: Auto now lands on fal, which lacks 1.5k.
    act(() => withKeys({ FAL_KEY: KEY }));
    rerender(<ProviderSwitcher definition={TABLE} params={params} variant="chip" onPick={onPick} />);
    expect(onPick).not.toHaveBeenCalled();
    expect(params).toEqual({ resolution: '1.5k' });
    const blocked = screen.getByRole('button', { name: /^Provider for Fixture Route Table: Auto · fal\. Can't run/ });
    expect(blocked).toHaveClass('model-node__provider-chip--blocked');
    expect(blocked).toHaveTextContent('⚠');
  });
});

describe('ProviderSwitcher keyboard', () => {
  it('opens from the chip on the checked row, moves with the arrows and closes on Escape with focus back', () => {
    withKeys({ BFL_API_KEY: KEY });
    render(<Controlled variant="chip" initial={{ _provider: 'fal' }} />);
    const chip = screen.getByRole('button', { name: /^Provider for Fixture Route Table: fal/ });
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Provider for Fixture Route Table' });
    expect(document.activeElement).toBe(row(/^fal\.ai/));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    // The next item in the menu: fal's own "Add key →".
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Add a fal.ai key in Settings' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row(/^Replicate/));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(row(/^Auto/));
    // Up from the top wraps to the last item: the one-click switch fal's stop offers.
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Switch to Black Forest Labs' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('opens on ArrowDown and closes after a pick, returning focus', () => {
    withKeys({ BFL_API_KEY: KEY });
    render(<Controlled variant="pill" />);
    const pill = screen.getByRole('button', { name: /^Provider for Fixture Route Table/ });
    fireEvent.keyDown(pill, { key: 'ArrowDown' });
    fireEvent.click(row(/^Black Forest Labs/));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(pill);
    expect(pill).toHaveTextContent('BFL');
  });

  it('keeps one row in the tab order when the menu is in place', () => {
    withKeys({ BFL_API_KEY: KEY });
    render(<Controlled initial={{ _provider: 'replicate' }} />);
    const tabbable = screen.getAllByRole('menuitemradio').filter((item) => item.tabIndex === 0);
    expect(tabbable).toEqual([row(/^Replicate/)]);
  });
});

function selectTableNode(params: Record<string, unknown>) {
  useGraphStore.setState({
    nodes: [{ id: 'n1', position: { x: 0, y: 0 },
      data: { definitionId: 'table', label: 'Fixture', params, outputs: {}, state: 'idle' } }],
    edges: [],
  });
  useUIStore.setState({ selectedNodeId: 'n1' });
}

function optionValues(select: HTMLElement): string[] {
  return [...select.querySelectorAll('option')].filter((option) => !option.disabled).map((option) => option.value);
}

describe('Inspector and pills show only the route options', () => {
  it('the Inspector puts Provider first and lists the chosen route options only', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    selectTableNode({ _provider: 'fal', aspect_ratio: '9:21' });
    render(<Inspector embedded />);
    const section = document.querySelector('[data-inspector-provider]');
    const firstParam = document.querySelector('[data-inspector-param]');
    expect(section).not.toBeNull();
    expect(section!.compareDocumentPosition(firstParam!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(optionValues(screen.getByLabelText('Resolution'))).toEqual(['768sq', '1k', '2k', '4k']);
    // A saved value fal doesn't take stays, marked, until the person changes it.
    expect(screen.getByRole('option', { name: '9:21 (not on fal.ai)' })).toBeDisabled();
    // fal has no grounding; the generic Krea connection select never shows.
    expect(document.querySelector('[data-inspector-param="grounding"]')).toBeNull();
    expect(document.querySelector('[data-inspector-param="_kreaAuth"]')).toBeNull();
  });

  it('under Auto it shows the route Auto takes, and a switch in the Inspector snaps and notes on the card', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    selectTableNode({ resolution: '1.5k', safety_tolerance: 6 });
    render(<Inspector embedded />);
    expect(optionValues(screen.getByLabelText('Resolution'))).toContain('1.5k');
    expect(screen.getByLabelText('Safety tolerance')).toHaveAttribute('max', '4');
    expect(document.querySelector('[data-inspector-param="grounding"]')).not.toBeNull();
    fireEvent.click(row(/^fal\.ai/));
    const params = useGraphStore.getState().nodes[0].data.params;
    expect(params).toMatchObject({ _provider: 'fal', resolution: '2k', safety_tolerance: 6 });
    expect(useProviderNoteStore.getState().notes.n1).toBe("1.5k isn't on fal.ai: set to 2k");
    expect(optionValues(screen.getByLabelText('Resolution'))).toEqual(['768sq', '1k', '2k', '4k']);
    expect(screen.getByLabelText('Safety tolerance')).toHaveAttribute('max', '6');
  });

  it('Create pills lead with the provider pill and show the route options', () => {
    withKeys({ FAL_KEY: KEY });
    function Pills() {
      const [params, setParams] = useState<Record<string, unknown>>({ resolution: '1.5k' });
      return <ParamPills def={TABLE} params={params} onChange={setParams} />;
    }
    render(<Pills />);
    const pills = document.querySelector('.param-pills')!;
    expect(pills.firstElementChild).toHaveAccessibleName(/^Provider for Fixture Route Table: Auto · fal\. Can't run/);
    const resolution = screen.getByTitle('Resolution').querySelector('select')!;
    expect(optionValues(resolution)).toEqual(['768sq', '1k', '2k', '4k']);
    expect(screen.getByRole('option', { name: '1.5k (not on fal.ai)' })).toBeDisabled();
    fireEvent.click(pills.firstElementChild!);
    fireEvent.click(row(/^fal\.ai/));
    expect(screen.getByRole('status')).toHaveTextContent("1.5k isn't on fal.ai: set to 2k");
    expect((screen.getByTitle('Resolution').querySelector('select') as HTMLSelectElement).value).toBe('2k');
  });
});

describe('the card', () => {
  function renderCard(params: Record<string, unknown>) {
    const node: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'table', label: 'Fixture', params, state: 'idle', outputs: {}, keyStatus: 'missing' } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    return render(<ModelNode {...({ id: 'n1', data: node.data, selected: false } as NodeProps)} />);
  }

  it('shows the provider chip in place of the missing-key badge, and the switch note until dismissed', () => {
    withKeys({ FAL_KEY: KEY });
    renderCard({ _provider: 'replicate' });
    const chip = screen.getByRole('button', { name: /^Provider for Fixture Route Table: Rep\. Can't run/ });
    expect(chip).toHaveClass('model-node__provider-chip--blocked');
    expect(document.querySelector('.model-node__badge--warning')).toBeNull();
    act(() => useProviderNoteStore.getState().show('n1', ["1.5k isn't on fal.ai: set to 2k"]));
    expect(screen.getByText("1.5k isn't on fal.ai: set to 2k")).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss provider note' }));
    expect(screen.queryByText("1.5k isn't on fal.ai: set to 2k")).toBeNull();
  });

  it('a pick from the chip writes the node and leaves the note on the card', () => {
    withKeys({ FAL_KEY: KEY, BFL_API_KEY: KEY });
    renderCard({ resolution: '1.5k' });
    fireEvent.click(screen.getByRole('button', { name: /^Provider for Fixture Route Table: Auto · BFL$/ }));
    fireEvent.click(row(/^fal\.ai/));
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ _provider: 'fal', resolution: '2k' });
    expect(useProviderNoteStore.getState().notes.n1).toBe("1.5k isn't on fal.ai: set to 2k");
  });

  it('legacy dual-route nodes get no switcher', () => {
    withKeys({});
    const node: Node<NodeData> = { id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'nano-banana-fal', label: 'Nano', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    render(<ModelNode {...({ id: 'n2', data: node.data, selected: false } as NodeProps)} />);
    expect(document.querySelector('.model-node__provider-chip')).toBeNull();
  });
});

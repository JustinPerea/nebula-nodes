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
    expect(screen.getByRole('menuitem', { name: 'Add key for fal.ai in Settings' })).toHaveTextContent('Add key →');
    expect(screen.getByRole('menuitem', { name: 'Sign in to Krea in Settings' })).toHaveTextContent('Sign in');
    // fal can't take 9:21: a block note, and no price.
    const fal = row(/^fal\.ai/);
    // Round 3f (GM): the setting by its label, in quotes, with the option's label.
    expect(fal).toHaveTextContent("Doesn't take “Aspect ratio” set to 9:21.");
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add key for Replicate in Settings' }));
    expect(open).toHaveBeenLastCalledWith({ kind: 'api-key', key: 'REPLICATE_API_TOKEN' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign in to Krea in Settings' }));
    expect(open).toHaveBeenLastCalledWith({ kind: 'krea-mcp' });
  });
});

describe('ProviderSwitcher on Idol\'s keyed Space route (GM PR #203 r1 and r4)', () => {
  const IDOL = NODE_DEFINITIONS['speridlabs-idol'];
  const renderIdol = () => render(<ProviderSwitcher definition={IDOL} params={{}} variant="inspector" onPick={vi.fn()} />);

  it('shows the standard "Add key →" without the token, naming the Hugging Face token, and GM\'s row note', () => {
    withKeys({});
    const open = vi.spyOn(useUIStore.getState(), 'openProviderSetup');
    useUIStore.setState({ openProviderSetup: open });
    renderIdol();
    const space = row(/^Speridlabs/).closest('[data-provider-row]') as HTMLElement;
    const add = within(space).getByRole('menuitem', { name: 'Add key for Hugging Face in Settings' });
    expect(add).toHaveTextContent('Add key →');
    expect(within(space).queryByText(/Optional|Connected/)).toBeNull();
    expect(row(/^Speridlabs/)).toHaveTextContent('Free with a Hugging Face token.');
    fireEvent.click(add);
    expect(open).toHaveBeenLastCalledWith({ kind: 'api-key', key: 'HF_TOKEN' });
  });

  it('names the lock reason on the card chip, never prefixed with "Can\'t run" (GM r6 item 2)', () => {
    withKeys({});
    render(<ProviderSwitcher definition={IDOL} params={{}} variant="chip" onPick={vi.fn()} />);
    const chip = screen.getByRole('button', { name: /^Provider for Idol:/ });
    expect(chip).toHaveAccessibleName(
      'Provider for Idol: Auto. You can run Idol after you add your Hugging Face token in Settings.');
    expect(chip.getAttribute('aria-label')).not.toMatch(/can't run/i);
  });

  it('shows the green dot and "Connected" with the token', () => {
    withKeys({ HF_TOKEN: KEY });
    renderIdol();
    const space = row(/^Speridlabs/).closest('[data-provider-row]') as HTMLElement;
    const cell = space.querySelector('.provider-switcher__key--connected');
    expect(cell).toHaveTextContent(/^Connected$/);
    expect(cell?.querySelector('.provider-switcher__dot')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('ProviderSwitcher picks', () => {
  it('a switch writes _provider and snaps the values the new route lacks, with a note', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    const onPick = vi.fn();
    render(<Controlled initial={{ resolution: '1.5k', grounding: true }} onPick={onPick} />);
    fireEvent.click(row(/^fal\.ai/));
    // Grounding is BFL's own setting, saved on: fal doesn't offer it, so the
    // click turns it off with a note (rule H, PR 5).
    expect(onPick).toHaveBeenCalledWith({ resolution: '2k', grounding: false, _provider: 'fal', _kreaAuth: 'api-token' },
      ["1.5k isn't on fal.ai: set to 2k", "Grounding isn't on fal.ai: turned off"]);
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
    expect(row(/^Auto/)).toHaveTextContent("Auto · can't run: fal.ai doesn't take “Resolution” set to 1.5k");
    expect(screen.getByRole('status')).toHaveTextContent("Fixture Route Table can't run on fal.ai");
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Replicate' }));
    expect(onPick).toHaveBeenCalledWith({ resolution: '1.5k', _provider: 'replicate', _kreaAuth: 'api-token' }, []);
  });

  it('a one-click switch to Krea bills the API balance it was offered on, even after the plan row', () => {
    // Krea · plan, then fal, then fal's key removed: Krea is offered on its API token.
    withKeys({ KREA_API_TOKEN: KEY }, true);
    const onPick = vi.fn();
    render(<Controlled initial={{ _provider: 'fal', _kreaAuth: 'mcp' }} onPick={onPick} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch to Krea' }));
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ _provider: 'krea', _kreaAuth: 'api-token' }), []);
    expect(row(/^Krea · API balance/)).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps every value when the route changes without a click (keys removed), and flags the stop', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    const onPick = vi.fn();
    const params = { resolution: '1.5k' };
    const { rerender } = render(<ProviderSwitcher definition={TABLE} params={params} variant="chip" onPick={onPick} />);
    const chip = screen.getByRole('button', { name: /^Provider for Fixture Route Table: Auto · Black Forest Labs$/ });
    expect(chip).not.toHaveClass('model-node__provider-chip--blocked');
    // The BFL key goes away: Auto now lands on fal, which lacks 1.5k.
    act(() => withKeys({ FAL_KEY: KEY }));
    rerender(<ProviderSwitcher definition={TABLE} params={params} variant="chip" onPick={onPick} />);
    expect(onPick).not.toHaveBeenCalled();
    expect(params).toEqual({ resolution: '1.5k' });
    const blocked = screen.getByRole('button', { name: /^Provider for Fixture Route Table: Auto · fal\.ai\. (?!Can't run)\S/ });
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
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Add key for fal.ai in Settings' }));
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

  it('closes on Tab and Shift+Tab with focus back on the chip, not past the portalled menu', () => {
    withKeys({ BFL_API_KEY: KEY });
    render(<Controlled variant="chip" />);
    const chip = screen.getByRole('button', { name: /^Provider for Fixture Route Table/ });
    for (const shiftKey of [false, true]) {
      fireEvent.click(chip);
      const menu = screen.getByRole('menu', { name: 'Provider for Fixture Route Table' });
      expect(fireEvent.keyDown(menu, { key: 'Tab', shiftKey })).toBe(false); // default prevented
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(chip);
    }
  });

  it('opens on ArrowDown and closes after a pick, returning focus', () => {
    withKeys({ BFL_API_KEY: KEY });
    render(<Controlled variant="pill" />);
    const pill = screen.getByRole('button', { name: /^Provider for Fixture Route Table/ });
    fireEvent.keyDown(pill, { key: 'ArrowDown' });
    fireEvent.click(row(/^Black Forest Labs/));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(pill);
    // Round 3g: the pill wraps, so it names the provider in full.
    expect(pill).toHaveTextContent('Black Forest Labs');
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
    expect(pills.firstElementChild).toHaveAccessibleName(/^Provider for Fixture Route Table: Auto · fal\.ai\. (?!Can't run)\S/);
    const resolution = screen.getByTitle('Resolution').querySelector('select')!;
    expect(optionValues(resolution)).toEqual(['768sq', '1k', '2k', '4k']);
    expect(screen.getByRole('option', { name: '1.5k (not on fal.ai)' })).toBeDisabled();
    fireEvent.click(pills.firstElementChild!);
    fireEvent.click(row(/^fal\.ai/));
    expect(screen.getByRole('status')).toHaveTextContent("1.5k isn't on fal.ai: set to 2k");
    expect((screen.getByTitle('Resolution').querySelector('select') as HTMLSelectElement).value).toBe('2k');
  });
});

/** A real route-table node from the registry, selected in the Inspector. */
function selectNode(definitionId: string, params: Record<string, unknown>) {
  useGraphStore.setState({
    nodes: [{ id: 'n1', position: { x: 0, y: 0 },
      data: { definitionId, label: definitionId, params, outputs: {}, state: 'idle' } }],
    edges: [],
  });
  useUIStore.setState({ selectedNodeId: 'n1' });
}

function inspectorParam(key: string): Element | null {
  return document.querySelector(`[data-inspector-param="${key}"]`);
}

describe('hidden settings: a provider shows only what it offers (PR 5)', () => {
  it('FLUX.2 on fal shows Safety under Pro; picking Klein 9B hides it and puts Safety 5 back to 2 with the note', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    selectNode('flux-2-pro', { _provider: 'fal', model: 'pro', safety_tolerance: '5' });
    render(<Inspector embedded />);
    expect(inspectorParam('safety_tolerance')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'klein-9b' } });
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ model: 'klein-9b', safety_tolerance: '2' });
    expect(useProviderNoteStore.getState().notes.n1).toBe("Safety 5 (Permissive) isn't on fal.ai with FLUX.2 [klein] 9B: back to 2");
    expect(inspectorParam('safety_tolerance')).toBeNull();
    // Nothing stops: the switcher has no stop line.
    expect(document.querySelector('.provider-switcher__stop')).toBeNull();
  });

  it('an edit that hides nothing another provider would use writes no note (Flash: no route offers Safety with it)', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    selectNode('flux-2-pro', { _provider: 'fal', model: 'pro', safety_tolerance: '5' });
    render(<Inspector embedded />);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'flash' } });
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ model: 'flash', safety_tolerance: '5' });
    expect(useProviderNoteStore.getState().notes.n1).toBeUndefined();
    expect(inspectorParam('safety_tolerance')).toBeNull();
  });

  it('FLUX 3 Image Klein on OpenRouter has no Seed row; BFL has one', () => {
    withKeys({ BFL_API_KEY: KEY, OPENROUTER_API_KEY: KEY });
    selectNode('flux-3-image-klein', { _provider: 'openrouter' });
    render(<Inspector embedded />);
    expect(inspectorParam('seed')).toBeNull();
    fireEvent.click(row(/^Black Forest Labs/));
    expect(inspectorParam('seed')).not.toBeNull();
  });

  it('FLUX 3 Video on fal hides Resolution while Draft is on', () => {
    withKeys({ FAL_KEY: KEY });
    selectNode('flux-3-video', { _provider: 'fal', draft: false });
    render(<Inspector embedded />);
    expect(inspectorParam('resolution')).not.toBeNull();
    fireEvent.click(within(inspectorParam('draft') as HTMLElement).getByRole('checkbox'));
    expect(useGraphStore.getState().nodes[0].data.params.draft).toBe(true);
    expect(inspectorParam('resolution')).toBeNull();
  });

  it('Krea 3 on fal hides Negative prompt under Jam', () => {
    withKeys({ FAL_KEY: KEY });
    selectNode('krea-3', { _provider: 'fal', model: 'berry' });
    render(<Inspector embedded />);
    expect(inspectorParam('negative_prompt')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'jam' } });
    expect(inspectorParam('negative_prompt')).toBeNull();
  });

  it('a stop without a click (a new key moved Auto) shows the hidden note, the Auto reason, the reset row and the switch row', () => {
    // Reasoning level is fal.ai's own setting. With only a fal key it ran
    // there; a Krea token now moves Auto to Krea, which doesn't offer it.
    withKeys({ FAL_KEY: KEY, KREA_API_TOKEN: KEY });
    selectNode('krea-3', { reasoning_level: 'medium' });
    render(<Inspector embedded />);
    const menu = within(document.querySelector('[data-inspector-provider]') as HTMLElement).getByRole('menu');
    expect(within(menu).getAllByRole('menuitemradio')[0]).toHaveTextContent("Auto · can't run: Krea doesn't take “Reasoning level”");
    expect(row(/^Krea · API balance/)).toHaveTextContent("Doesn't take “Reasoning level”.");
    const reset = within(menu).getByRole('menuitem', { name: 'Set Reasoning level back to Low' });
    expect(within(menu).getByRole('menuitem', { name: 'Switch to fal.ai' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent("Krea 3 can't run on Krea with “Reasoning level” set to Medium. Set “Reasoning level” back to Low, or switch provider.");
    fireEvent.click(reset);
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ reasoning_level: 'low' });
    expect(document.querySelector('.provider-switcher__stop')).toBeNull();
  });

  // The Inspector's bug (GM - Design, 2026-10-23): a floating panel beside a
  // node low on the canvas must stay above the bottom bar. The chip's popover
  // flipped up only when it ran off the window, so just above the bar it
  // opened down over the bar.
  it('the chip popover flips above the chip rather than over the bottom bar', () => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 800);
    const bar = document.createElement('div');
    bar.setAttribute('data-bottom-bar', '');
    document.body.append(bar);
    const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-bottom-bar')) return new DOMRect(395, 729, 490, 47);
      if (this.classList.contains('provider-switcher__popover')) return new DOMRect(0, 0, 300, 200);
      if (this.classList.contains('model-node__provider-chip')) return new DOMRect(600, 536, 120, 24);
      return new DOMRect();
    });
    try {
      withKeys({ FAL_KEY: KEY });
      const node: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
        data: { definitionId: 'flux-2-pro', label: 'FLUX.2', params: {}, state: 'idle', outputs: {} } };
      useGraphStore.setState({ nodes: [node], edges: [] });
      render(<ModelNode {...({ id: 'n1', data: node.data, selected: false } as NodeProps)} />);
      fireEvent.click(screen.getByRole('button', { name: /^Provider for FLUX\.2/ }));
      const popover = document.querySelector<HTMLElement>('.provider-switcher__popover')!;
      expect(popover.classList.contains('provider-switcher__popover--above')).toBe(true);
      expect(parseFloat(popover.style.top) + 200).toBeLessThanOrEqual(536);
    } finally {
      rects.mockRestore();
      bar.remove();
      vi.unstubAllGlobals();
    }
  });

  // Review 9, M-1's path for popovers: the chip's popover is portalled from
  // inside the node card, so its keys bubble (React) to React Flow's node,
  // which moved the node on ArrowLeft/ArrowRight and selected it on Enter or
  // Space from a menu item. React Flow ignores keys from inside `.nokey`.
  it("the chip popover's keys never reach React Flow's node (nokey)", () => {
    withKeys({ FAL_KEY: KEY });
    const node: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'flux-2-pro', label: 'FLUX.2', params: {}, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    render(<ModelNode {...({ id: 'n1', data: node.data, selected: false } as NodeProps)} />);
    fireEvent.click(screen.getByRole('button', { name: /^Provider for FLUX\.2/ }));
    expect(document.querySelector('.provider-switcher__popover')?.closest('.nokey')).not.toBeNull();
  });

  it('the chip popover offers the same reset row, and it writes the node', () => {
    withKeys({ FAL_KEY: KEY });
    const node: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'flux-2-pro', label: 'FLUX.2', params: { model: 'klein-9b', safety_tolerance: '5' }, state: 'idle', outputs: {} } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    render(<ModelNode {...({ id: 'n1', data: node.data, selected: false } as NodeProps)} />);
    fireEvent.click(screen.getByRole('button', { name: /^Provider for FLUX\.2: Auto · fal\.ai\. (?!Can't run)\S/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set Safety back to 2' }));
    expect(useGraphStore.getState().nodes[0].data.params).toMatchObject({ model: 'klein-9b', safety_tolerance: '2' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Create pills hide what the shown provider hides and snap on an edit, with the note', () => {
    withKeys({ BFL_API_KEY: KEY, FAL_KEY: KEY });
    const changes: Record<string, unknown>[] = [];
    function Pills() {
      const [params, setParams] = useState<Record<string, unknown>>({ _provider: 'fal', model: 'pro', safety_tolerance: '5' });
      return <ParamPills def={NODE_DEFINITIONS['flux-2-pro']} params={params} onChange={(next) => { changes.push(next); setParams(next); }} />;
    }
    render(<Pills />);
    expect(screen.getByTitle('Safety')).toBeVisible();
    fireEvent.change(screen.getByTitle('Model').querySelector('select')!, { target: { value: 'klein-9b' } });
    expect(changes.at(-1)).toEqual({ _provider: 'fal', model: 'klein-9b', safety_tolerance: '2' });
    expect(screen.queryByTitle('Safety')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent("Safety 5 (Permissive) isn't on fal.ai with FLUX.2 [klein] 9B: back to 2");
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
    const chip = screen.getByRole('button', { name: /^Provider for Fixture Route Table: Replicate\. (?!Can't run)\S/ });
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
    fireEvent.click(screen.getByRole('button', { name: /^Provider for Fixture Route Table: Auto · Black Forest Labs$/ }));
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

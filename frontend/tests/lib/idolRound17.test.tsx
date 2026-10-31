// PR #203 round 17: GM r32. The card's route lines quote the node's name,
// a refused run's card heading is the Agent log's "Nebula couldn’t start the
// run.", two actions take a comma when the fix lists options, the switcher's
// notes are curly, every switcher button's accessible name starts with its
// visible text as one run, and Krea's sign-in line names who can take the run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import shippedTable from '../../../backend/data/model_pricing.json';
import { NodeRunError } from '../../src/components/nodes/NodeError';
import { ProviderSwitcher } from '../../src/components/nodes/ProviderSwitcher';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { routeAction, routeSwitch, routeUnavailable } from '../../src/lib/directRoute';
import { RUN_NODE_HEADING, RUN_NOT_STARTED_HEADING } from '../../src/lib/nodeErrorCopy';
import type { PricingTable } from '../../src/lib/pricing';
import { providerSwitchState } from '../../src/lib/providerSwitch';
import { validationReadings } from '../../src/lib/validationCopy';
import { useGraphStore } from '../../src/store/graphStore';
import { usePricingStore } from '../../src/store/pricingStore';
import { useUIStore } from '../../src/store/uiStore';
import type { ExecutionEvent } from '../../src/lib/wsClient';
import type { ModelNodeDefinition, NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

const fixture = pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable };
const TABLE = fixture.definitions.table;
const KEY = 'fixture-only';
const pricing = { ...shippedTable, nodes: { ...shippedTable.nodes, ...fixture.pricing.nodes } } as unknown as PricingTable;

let previousUi: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousUi = useUIStore.getState();
  NODE_DEFINITIONS.table = TABLE;
  usePricingStore.setState({ table: fixture.pricing, loading: false });
  useUIStore.setState({ skin: 'slava-restraint', settingsCache: { ...useUIStore.getState().settingsCache, loaded: true,
    apiKeys: {}, kreaConnection: { status: 'disconnected' } } });
});

afterEach(() => {
  cleanup();
  delete NODE_DEFINITIONS.table;
  useUIStore.setState(previousUi, true);
  usePricingStore.setState({ table: null, loading: false });
});

describe('the card quotes the node’s name (GM r32)', () => {
  it('a route’s missing key, as the card and the switcher say it', () => {
    const flux3 = NODE_DEFINITIONS['flux-3-image'];
    const stop = routeUnavailable(flux3, { _provider: 'replicate' }, { FAL_KEY: KEY });
    expect(stop?.message).toBe('“FLUX 3 Image” is set to Replicate, which needs your Replicate token. '
      + 'Add it in Settings or switch to fal.ai.');
  });

  it('every route-table node’s stop line opens with its quoted name or a route’s own line', () => {
    let seen = 0;
    for (const definition of Object.values(NODE_DEFINITIONS)) {
      if (!routeSwitch(definition)) continue;
      const stop = routeUnavailable(definition, { _provider: 'xyz' }, {});
      expect(stop?.message, definition.id).toBe(`“${definition.displayName}” is set to a provider that isn’t in its list. `
        + 'Choose one in its provider switcher.');
      seen += 1;
    }
    expect(seen).toBeGreaterThan(5);
  });
});

describe('two actions take a comma when the fix lists options (GM r32 item 1)', () => {
  const pick = (options: string[]) => ({ text: `Pick ${options.length === 1 ? options[0]
    : `${options.slice(0, -1).join(', ')} or ${options.at(-1)}`}`, options: options.length });

  it.each([
    [['1K'], 'Pick 1K or switch to fal.ai.', 'Pick 1K.'],
    [['1K', '2K'], 'Pick 1K or 2K, or switch to fal.ai.', 'Pick 1K or 2K.'],
    [['1K', '2K', '4K'], 'Pick 1K, 2K or 4K, or switch to fal.ai.', 'Pick 1K, 2K or 4K.'],
  ])('%j', (options, withSwitch, alone) => {
    expect(routeAction(pick(options), ['fal.ai'], [], null)).toBe(withSwitch);
    expect(routeAction(pick(options), [], [], null)).toBe(alone);
  });

  it('two providers to switch to, and a fix with no options', () => {
    expect(routeAction({ text: 'Pick 1K, 2K or 4K', options: 3 }, ['fal.ai', 'Replicate'], [], null))
      .toBe('Pick 1K, 2K or 4K, or switch to fal.ai or Replicate.');
    expect(routeAction('Turn “Raw” off', ['fal.ai'], [], null)).toBe('Turn “Raw” off or switch to fal.ai.');
    expect(routeAction('Add it in Settings', ['fal.ai'], [], null)).toBe('Add it in Settings or switch to fal.ai.');
  });

  it('a provider whose key isn’t added keeps its comma whatever the fix', () => {
    expect(routeAction({ text: 'Pick 1K or 2K', options: 2 }, [], ['fal.ai'], 'fal.ai API key'))
      .toBe('Pick 1K or 2K, or add your fal.ai API key in Settings and switch to fal.ai.');
    expect(routeAction('Turn “Raw” off', [], ['fal.ai'], 'fal.ai API key'))
      .toBe('Turn “Raw” off, or add your fal.ai API key in Settings and switch to fal.ai.');
  });

  it('a real stop: four resolutions and one provider', () => {
    const stop = routeUnavailable(NODE_DEFINITIONS['flux-3-image'], { _provider: 'fal', resolution: '1.5K' },
      { FAL_KEY: KEY, REPLICATE_API_TOKEN: KEY });
    expect(stop?.message).toMatch(/^“FLUX 3 Image” can’t run on fal\.ai with “Resolution” set to 1\.5K\. Pick [^.]+ or 4K, or switch to Replicate\.$/);
  });
});

describe('the switcher’s notes are curly, with the same words (GM r32 item 2)', () => {
  it('no row note, Auto label or stop line holds a straight apostrophe', () => {
    let notes = 0;
    for (const definition of [TABLE, ...Object.values(NODE_DEFINITIONS).filter((d) => routeSwitch(d))]) {
      for (const params of [{}, { resolution: '1.5k' }, { safety_tolerance: 6 }, { _provider: 'fal', resolution: '1.5K' }]) {
        const state = providerSwitchState(definition, params, { apiKeys: { FAL_KEY: KEY }, kreaSignedIn: false, pricing });
        for (const text of [...state.rows.flatMap((row) => [row.label, row.block ?? '']), state.message ?? '']) {
          expect(text, definition.id).not.toMatch(/'/);
          if (/’/.test(text)) notes += 1;
        }
      }
    }
    expect(notes).toBeGreaterThan(3);
  });

  it('the fixture’s notes word for word', () => {
    const state = providerSwitchState(TABLE, { resolution: '1.5k' }, { apiKeys: { FAL_KEY: KEY }, kreaSignedIn: false, pricing: fixture.pricing });
    expect(state.rows.find((row) => row.id === 'fal')?.block).toBe('Doesn’t take “Resolution” set to 1.5k.');
    expect(state.rows[0].label).toBe('Auto · fal.ai doesn’t take “Resolution” set to 1.5k');
  });
});

describe('Krea’s sign-in line names who can take the run (GM r32 item 4)', () => {
  const krea3 = () => NODE_DEFINITIONS['krea-3'];
  const plan = { _provider: 'krea', _kreaAuth: 'mcp' };

  it('a provider with its key set: named', () => {
    const state = providerSwitchState(krea3(), plan, { apiKeys: { FAL_KEY: KEY }, kreaSignedIn: false, pricing });
    expect(state.message).toBe(`“${krea3().displayName}” runs on your Krea plan. Sign in to Krea in Settings, or switch to fal.ai.`);
  });

  it('none: "or choose another provider"', () => {
    const state = providerSwitchState(krea3(), plan, { apiKeys: {}, kreaSignedIn: false, pricing });
    expect(state.message).toBe(`“${krea3().displayName}” runs on your Krea plan. Sign in to Krea in Settings, or choose another provider.`);
  });

  it('the Krea API key alone is the same route, not another provider', () => {
    const state = providerSwitchState(krea3(), plan, { apiKeys: { KREA_API_TOKEN: KEY }, kreaSignedIn: false, pricing });
    expect(state.message).toMatch(/or choose another provider\.$/);
  });
});

/** The visible text, one run: each text part not under aria-hidden, in order, spaces collapsed. */
function visibleRun(element: HTMLElement): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('every switcher button’s name starts with its visible text as one run (GM r32 item 3)', () => {
  const definitions = () => [TABLE, ...Object.values(NODE_DEFINITIONS).filter((d) => routeSwitch(d) && d.id !== 'table')];

  it.each(['inspector', 'chip', 'pill'] as const)('%s', (variant) => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, apiKeys: { FAL_KEY: KEY } } });
    let checked = 0;
    let triggers = 0;
    for (const definition of definitions()) {
      for (const params of [{}, { resolution: '1.5k' }]) {
        const view = render(<ProviderSwitcher definition={definition} params={params} variant={variant} onPick={vi.fn()} />);
        const opener = view.container.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
        if (opener) {
          const run = visibleRun(opener);
          expect(opener, `${definition.id} ${variant}`).toHaveAccessibleName(new RegExp(`^${escape(run)}`));
          // What the trigger doesn't show is its description.
          expect(opener).toHaveAccessibleDescription(new RegExp(`^Provider for “${escape(definition.displayName)}”: `));
          triggers += 1;
          fireEvent.click(opener);
        }
        const buttons = new Set([
          ...view.container.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
          ...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]'),
        ]);
        for (const button of buttons) {
          const run = visibleRun(button);
          if (!run) continue;
          expect(button, `${definition.id} ${variant}: “${run}”`).toHaveAccessibleName(new RegExp(`^${escape(run)}`));
          checked += 1;
        }
        view.unmount();
      }
    }
    expect(checked).toBeGreaterThan(20);
    if (variant !== 'inspector') expect(triggers).toBeGreaterThan(5);
  });

  it('the pill: "Provider" and the provider, one run', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, apiKeys: { BFL_API_KEY: KEY } } });
    render(<ProviderSwitcher definition={TABLE} params={{}} variant="pill" onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Provider Auto · Black Forest Labs' }))
      .toHaveAccessibleDescription('Provider for “Fixture Route Table”: Auto · Black Forest Labs');
  });
});

describe('one heading over a refused run: "Nebula couldn’t start the run." (GM r32)', () => {
  const line = '“FLUX 3 Image” is set to Replicate, which needs your Replicate token. Add it in Settings or switch to fal.ai.';

  it('the pre-call check’s reading says it refused the run', () => {
    const { byNode, global } = validationReadings([
      { nodeId: 'n1', portId: '', message: 'route unavailable', person: line },
      { nodeId: '', portId: '', message: 'unlined' },
    ]);
    expect(byNode.get('n1')).toEqual({ error: 'route unavailable', errorPerson: line, errorNotStarted: true });
    expect(global).toEqual({ error: 'unlined', errorCategory: 'unknown', errorNotStarted: true });
  });

  it('the card: the heading over the line; a run that started keeps its own', () => {
    const data = { state: 'error', error: 'route unavailable', errorPerson: line } as const;
    const refused = render(<NodeRunError data={{ ...data, errorNotStarted: true }} className="x" />);
    expect(refused.container).toHaveTextContent(`${RUN_NOT_STARTED_HEADING} ${line}`);
    refused.unmount();
    const failed = render(<NodeRunError data={data} className="x" />);
    expect(failed.container).toHaveTextContent(`${RUN_NODE_HEADING} ${line}`);
    expect(RUN_NOT_STARTED_HEADING).toBe('Nebula couldn’t start the run.');
  });

  it('an agent’s refused run marks the card, and a later run error clears it', () => {
    const node = (id: string): Node<NodeData> => ({ id, type: 'model-node', position: { x: 0, y: 0 },
      data: { label: id, definitionId: 'flux-3-image', params: {}, state: 'idle', outputs: {} } });
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [node('n1')], edges: [] });
    const send = (event: Record<string, unknown>) => useGraphStore.getState().handleExecutionEvent(event as unknown as ExecutionEvent);
    send({ type: 'validationError', runId: 'cli_run_9', errors: [{ nodeId: 'n1', portId: '', message: 'route unavailable', person: line }] });
    const data = () => useGraphStore.getState().nodes[0].data;
    expect(data()).toMatchObject({ state: 'error', errorPerson: line, errorNotStarted: true });
    send({ type: 'error', runId: 'cli_run_10', nodeId: 'n1', error: 'Provider said no', category: 'unknown' });
    expect(data().state).toBe('error');
    expect(data().errorNotStarted).toBeUndefined();
  });
});

describe('a route’s missing key names another provider only when its key is set (GM r33 item 4)', () => {
  const flux2 = NODE_DEFINITIONS['flux-2-pro'];
  const line = '“FLUX.2” is set to Black Forest Labs, which needs your Black Forest Labs API key. Add it in Settings';
  it.each([
    ['no key set anywhere', {}, `${line}.`],
    ['a key no other route takes', { REPLICATE_API_TOKEN: KEY }, `${line}.`],
    ['fal.ai’s key set', { FAL_KEY: KEY }, `${line} or switch to fal.ai.`],
  ])('%s', (_case, keys, expected) => {
    expect(routeUnavailable(flux2, { _provider: 'bfl' }, keys)?.message).toBe(expected);
  });
});

describe('the size and retired clauses read curly (review 16, N1)', () => {
  // The generator walks only the registry's route tables, where neither rule
  // is set today: a fixture route pins both.
  const fixtureRoute = (rule: 'size' | 'retires', value: unknown): ModelNodeDefinition => {
    const base = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions['routes-image'];
    const definition = JSON.parse(JSON.stringify(base)) as ModelNodeDefinition;
    for (const route of definition.routes ?? []) {
      if (route.id === 'bfl') (route as { rules?: Record<string, unknown> }).rules = { ...(route.rules ?? {}), [rule]: value };
    }
    return definition;
  };
  it.each([
    ['size', { param: 'aspect_ratio', unsupported: ['9:21'] }, { aspect_ratio: '9:21' },
      ', because it can’t render this “Aspect ratio” exactly. '],
    ['retires', { on: '2000-01-01' }, {}, ', because the maker retired this model on 2000-01-01. '],
  ] as const)('%s', (rule, value, params, why) => {
    const line = routeUnavailable(fixtureRoute(rule, value), { _provider: 'bfl', ...params },
      { BFL_API_KEY: KEY, FAL_KEY: KEY })?.message ?? '';
    expect(line.startsWith(`“Fixture Image” can’t run on Black Forest Labs${why}`), line).toBe(true);
    expect(line).not.toContain("'");
  });
});

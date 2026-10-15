import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import switchCases from '../../../backend/tests/fixtures/switch_cases.json';
import clientDefinitions from '../../../backend/tests/fixtures/route_client_definitions.json';
import { Inspector } from '../../src/components/panels/Inspector';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { allParamDefinitions } from '../../src/lib/directRoute';
import { providerSwitchState, type SwitchContext } from '../../src/lib/providerSwitch';
import { useGraphStore } from '../../src/store/graphStore';
import { usePricingStore } from '../../src/store/pricingStore';
import { useProviderNoteStore } from '../../src/store/providerNoteStore';
import { useUIStore } from '../../src/store/uiStore';
import type { ModelNodeDefinition } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));

/**
 * PR 2's two halves joined (backend/tests/fixtures/switch_cases.json): a
 * person's click in the Inspector's provider switcher, on the fixture nodes
 * of route_client_definitions.json or the registry's route-table nodes, writes each case's `writes` to the node
 * in the graph store, and the switcher then shows its `switcher` state. The
 * backend half (test_route_clients.py test_switch_cases_*) saves the same
 * values and checks the router sends them to the right client.
 */

type Params = Record<string, unknown>;
interface SwitchView { chip: string; blocked: boolean; alternatives: string[] }
interface SwitchCase {
  name: string;
  definition: string;
  saved: Params;
  keys: string[];
  kreaSignedIn?: boolean;
  wired: Record<string, unknown>;
  click: string | null;
  switcher: SwitchView & { before: SwitchView; notes: string[] };
  writes: Params;
}

const CASES = (switchCases as unknown as { cases: SwitchCase[] }).cases;
const DEFINITIONS = (clientDefinitions as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions;
const KEY = 'fixture-only';

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  Object.assign(NODE_DEFINITIONS, DEFINITIONS);
  // No prices for the fixtures: a loaded empty table, so nothing is fetched.
  usePricingStore.setState({ table: { currencies: {}, nodes: {} }, loading: false });
  useUIStore.setState({ skin: 'slava-restraint' });
  useProviderNoteStore.setState({ notes: {} });
});

afterEach(() => {
  cleanup();
  for (const id of Object.keys(DEFINITIONS)) delete NODE_DEFINITIONS[id];
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
  usePricingStore.setState({ table: null, loading: false });
});

/** Every param's default, as addNode seeds them (graphStore buildDefaultParams). */
function defaults(definition: ModelNodeDefinition): Params {
  return Object.fromEntries(allParamDefinitions(definition)
    .filter((param) => param.default !== undefined).map((param) => [param.key, param.default]));
}

function view(definition: ModelNodeDefinition, params: Params, context: SwitchContext): SwitchView {
  const state = providerSwitchState(definition, params, context);
  return { chip: state.chip, blocked: state.blocked, alternatives: state.alternatives.map((a) => a.routeId) };
}

describe('switch_cases.json: a switcher click writes what the backend run expects', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    // A fixture node, else a real route-table node (PR 3).
    const definition = DEFINITIONS[c.definition] ?? NODE_DEFINITIONS[c.definition];
    const apiKeys = Object.fromEntries(c.keys.map((key) => [key, KEY]));
    const wired = new Map(Object.keys(c.wired).map((port) => [port, 1]));
    const context: SwitchContext = { apiKeys, kreaSignedIn: Boolean(c.kreaSignedIn), wired };
    useUIStore.setState({ selectedNodeId: 'n1', settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys,
      kreaConnection: c.kreaSignedIn ? { status: 'connected' } : { status: 'disconnected' } } });
    const before = { ...defaults(definition), ...c.saved };
    useGraphStore.setState({
      nodes: [{ id: 'n1', position: { x: 0, y: 0 },
        data: { definitionId: c.definition, label: 'Fixture', params: before, outputs: {}, state: 'idle' } }],
      edges: Object.keys(c.wired).map((port) => ({ id: `e-${port}`, source: 'up', target: 'n1', targetHandle: port })),
    });
    expect(view(definition, before, context)).toEqual(c.switcher.before);

    render(<Inspector embedded />);
    const menu = within(document.querySelector('[data-inspector-provider]') as HTMLElement).getByRole('menu');
    if (c.click?.startsWith('alternative:')) {
      const routeId = c.click.slice('alternative:'.length);
      const label = providerSwitchState(definition, before, context).alternatives.find((a) => a.routeId === routeId)!.label;
      fireEvent.click(within(menu).getByRole('menuitem', { name: `Switch to ${label}` }));
    } else if (c.click) {
      const index = providerSwitchState(definition, before, context).rows.findIndex((row) => row.id === c.click);
      expect(index).toBeGreaterThanOrEqual(0);
      fireEvent.click(within(menu).getAllByRole('menuitemradio')[index]);
    }

    const after = useGraphStore.getState().nodes[0].data.params;
    expect(after).toEqual({ ...before, ...c.writes });
    expect(useProviderNoteStore.getState().notes.n1 ?? '').toBe(c.switcher.notes.join('. '));
    const { chip, blocked, alternatives } = c.switcher;
    expect(view(definition, after, context)).toEqual({ chip, blocked, alternatives });
    if (c.switcher.blocked) expect(screen.getByRole('status')).toHaveTextContent(/can't run on/);
  });
});

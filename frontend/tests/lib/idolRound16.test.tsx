// PR #203 round 16: GM r30 item 3. The switcher's setup button shows the
// provider's button noun ("Add token →" for Replicate), its accessible name
// starts with that label, and the one add-key line is its description.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import pricingCases from '../../../backend/tests/fixtures/pricing_cases.json';
import { ProviderSwitcher } from '../../src/components/nodes/ProviderSwitcher';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { addKeyLine, routeSwitch } from '../../src/lib/directRoute';
import { PROVIDER_KEY_SPECS } from '../../src/lib/providerCatalog';
import { setupButtonWords } from '../../src/lib/providerSwitch';
import { keychainUnknownLine, unreadableSettingsLine } from '../../src/lib/settingsWrites';
import { RequestFailedError } from '../../src/lib/errorCopy';
import type { PricingTable } from '../../src/lib/pricing';
import { usePricingStore } from '../../src/store/pricingStore';
import { useUIStore } from '../../src/store/uiStore';
import type { ModelNodeDefinition } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

const fixture = pricingCases as unknown as { definitions: Record<string, ModelNodeDefinition>; pricing: PricingTable };
const TABLE = fixture.definitions.table;

/** Every provider's button noun, by hand: the link says "tokens" for
 * Replicate and Hugging Face, "keys" (or Google Cloud's "service accounts",
 * a key) for the rest. */
const TOKEN_KEYS = new Set(['REPLICATE_API_TOKEN', 'HF_TOKEN']);

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

describe('every provider\'s setup button words (GM r30 item 3)', () => {
  it('covers every provider in Settings', () => {
    expect(Object.keys(PROVIDER_KEY_SPECS).length).toBeGreaterThan(20);
    expect([...TOKEN_KEYS].every((key) => key in PROVIDER_KEY_SPECS)).toBe(true);
  });

  it.each(Object.keys(PROVIDER_KEY_SPECS))('%s: the label is its noun and the description its one line', (key) => {
    const words = setupButtonWords({ keyState: 'missing', setup: { kind: 'api-key', key }, label: 'Row' });
    expect(words.label).toBe(TOKEN_KEYS.has(key) ? 'Add token' : 'Add key');
    expect(words.description).toBe(addKeyLine([key]));
  });

  it('pins the lines GM named', () => {
    const words = (key: string) => setupButtonWords({ keyState: 'missing', setup: { kind: 'api-key', key }, label: 'Row' });
    expect(words('REPLICATE_API_TOKEN')).toEqual({ label: 'Add token', description: 'Add your Replicate token in Settings.' });
    expect(words('HF_TOKEN')).toEqual({ label: 'Add token', description: 'Add your Hugging Face token in Settings.' });
    expect(words('FAL_KEY')).toEqual({ label: 'Add key', description: 'Add your fal.ai API key in Settings.' });
    expect(words('GOOGLE_VERTEX_CREDENTIALS').label).toBe('Add key');
  });

  it('a Krea plan row signs in', () => {
    expect(setupButtonWords({ keyState: 'sign-in', setup: { kind: 'krea-mcp' }, label: 'Krea · plan' }))
      .toEqual({ label: 'Sign in', description: 'Sign in to Krea in Settings.' });
  });
});

describe('the rendered setup buttons (GM r30 item 3)', () => {
  it('Replicate\'s row shows "Add token →", is named "Add token" and described by its line', () => {
    render(<ProviderSwitcher definition={TABLE} params={{}} variant="inspector" onPick={vi.fn()} />);
    const replicate = screen.getByRole('menuitemradio', { name: /^Replicate/ }).closest('[data-provider-row]') as HTMLElement;
    const button = within(replicate).getByRole('menuitem', { name: 'Add token' });
    expect(button).toHaveTextContent('Add token →');
    expect(button).toHaveAccessibleName('Add token');
    expect(button).toHaveAccessibleDescription('Add your Replicate token in Settings.');
    // No switcher says "Add key" for a token.
    expect(within(replicate).queryByRole('menuitem', { name: /Add key/ })).toBeNull();
  });

  const SWITCHERS = () => Object.values(NODE_DEFINITIONS).filter((definition) => routeSwitch(definition));

  it('every switcher\'s setup button: the noun of the key it opens, its line as the description', () => {
    const open = vi.fn();
    useUIStore.setState({ openProviderSetup: open });
    const definitions = SWITCHERS();
    expect(definitions.length).toBeGreaterThan(1);
    let seen = 0;
    for (const definition of definitions) {
      const view = render(<ProviderSwitcher definition={definition} params={{}} variant="inspector" onPick={vi.fn()} />);
      for (const button of view.container.querySelectorAll<HTMLElement>('.provider-switcher__setup')) {
        fireEvent.click(button);
        const target = open.mock.lastCall?.[0] as { kind: string; key?: string };
        if (target.kind === 'krea-mcp') {
          expect(button).toHaveAccessibleName('Sign in');
          expect(button).toHaveAccessibleDescription('Sign in to Krea in Settings.');
          continue;
        }
        const label = TOKEN_KEYS.has(target.key!) ? 'Add token' : 'Add key';
        expect(button, `${definition.id} ${target.key}`).toHaveTextContent(`${label} →`);
        expect(button, `${definition.id} ${target.key}`).toHaveAccessibleName(label);
        expect(button, `${definition.id} ${target.key}`).toHaveAccessibleDescription(addKeyLine([target.key!])!);
        seen += 1;
      }
      view.unmount();
    }
    expect(seen).toBeGreaterThan(5);
  });
});

/** What a sighted person reads on the control, piece by piece: each text
 * part that isn't decorative (aria-hidden), spaces collapsed. */
function visibleParts(element: HTMLElement): string[] {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('[aria-hidden="true"]')) continue;
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  return parts;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The accessible name holds every visible part, in the order shown. */
const inOrder = (parts: readonly string[]) => new RegExp(parts.map(escape).join('[\\s\\S]*'));

describe('WCAG 2.5.3 Label in Name: every switcher button\'s name holds its visible label', () => {
  const variants = ['inspector', 'chip', 'pill'] as const;
  const definitions = () => [TABLE, ...Object.values(NODE_DEFINITIONS).filter((definition) => routeSwitch(definition)
    && definition.id !== 'table')];

  it.each(variants)('%s', (variant) => {
    let checked = 0;
    let setups = 0;
    for (const definition of definitions()) {
      const view = render(<ProviderSwitcher definition={definition} params={{}} variant={variant} onPick={vi.fn()} />);
      const opener = view.container.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
      if (opener) fireEvent.click(opener);
      const buttons = new Set([
        ...view.container.querySelectorAll<HTMLElement>('button'),
        ...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menu"] [role^="menuitem"]'),
      ]);
      for (const button of buttons) {
        const parts = visibleParts(button.querySelector<HTMLElement>('.provider-switcher__label') ?? button);
        if (!parts.length) continue;
        expect(button, `${definition.id} ${variant}: “${parts.join(' ')}”`).toHaveAccessibleName(inOrder(parts));
        // A setup button's name starts with its whole visible label (GM r30 item 3).
        if (button.classList.contains('provider-switcher__setup')) {
          expect(button).toHaveAccessibleName(new RegExp(`^${escape(parts.join(' '))}`));
          setups += 1;
        }
        checked += 1;
      }
      view.unmount();
    }
    expect(checked).toBeGreaterThan(10);
    expect(setups).toBeGreaterThan(0);
  });
});

describe('the Keychain line when Nebula didn’t answer (GM r31 item 5)', () => {
  it('beside the row says “this key”; as a notice it names the key', () => {
    expect(keychainUnknownLine('removal', 'REPLICATE_API_TOKEN', 'notice'))
      .toBe('Nebula didn’t respond, so your Replicate token may not be removed. Remove it again to be sure.');
    expect(keychainUnknownLine('removal', 'REPLICATE_API_TOKEN', 'row'))
      .toBe('Nebula didn’t respond, so this key may not be removed. Remove it again to be sure.');
    expect(keychainUnknownLine('save', 'OPENAI_API_KEY', 'notice'))
      .toBe('Nebula didn’t respond, so your OpenAI API key may not be saved. Save it again to be sure.');
    expect(keychainUnknownLine('save', 'OPENAI_API_KEY', 'row'))
      .toBe('Nebula didn’t respond, so this key may not be saved. Save it again to be sure.');
  });
});

describe('the settings folder refusals reach the panel as the backend says them (GM r31 items 1 and 2)', () => {
  const FOLDER = 'Nothing was saved because Nebula isn’t allowed to change ~/.nebula. Check the folder’s permissions, then try again.';
  const NOT_A_FOLDER = 'Nothing was saved because ~/.nebula is a file, and Nebula needs a folder there. '
    + 'Move or rename that file, then try again.';
  it.each([['settings_unwritable', FOLDER], ['settings_not_a_folder', NOT_A_FOLDER]])('%s', (code, line) => {
    const error = new RequestFailedError('Couldn’t save the settings.', 409, { detail: line, code });
    expect(unreadableSettingsLine(error)).toBe(line);
  });
});

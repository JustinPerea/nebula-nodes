// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRules, resolvedStyle } from './helpers/cssCascade';

// Design: a search field that sits bare inside a visible box (a shell) never draws
// its own ring or native box. The shell takes the focus ring, so the ring follows
// the shell's shape. Each field is rendered in its real component, so a broad
// ancestor rule (`.project-home input:focus-visible`) is matched the way the app
// matches it. A field that is itself the box is not listed here.

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/backend', async (original) => ({
  ...(await original<typeof import('../src/lib/backend')>()),
  apiFetch: () => new Promise<Response>(() => {}),
  backendAssetUrlSync: (url: string) => url,
}));
vi.mock('../src/lib/createPresets', () => ({ fetchPresets: vi.fn(async () => []) }));
vi.mock('../src/lib/kreaConnection', async (original) => ({
  ...(await original<typeof import('../src/lib/kreaConnection')>()),
  getKreaConnection: vi.fn(async () => ({ status: 'disconnected' })),
}));

import { ModelPicker } from '../src/components/create-studio/ModelPicker';
import { PresetLibrary } from '../src/components/create-studio/PresetLibrary';
import { ProjectHome } from '../src/components/projects/ProjectHome';
import { ProvidersTab } from '../src/components/panels/settings/ProvidersTab';
import { useSettingsDraftStore } from '../src/store/settingsDraftStore';

type Saved = NonNullable<ReturnType<typeof useSettingsDraftStore.getState>['saved']>;
const SAVED = { apiKeys: {}, routing: {}, kreaConnectionMode: 'mcp', outputPath: '/out', exportFolder: '/exports',
  zoomTelemetryEnabled: false, agentSpend: { sessionUsd: 5, models: {} } } as unknown as Saved;
const initialDraft = useSettingsDraftStore.getState();

const SETTINGS_SRC = readFileSync(join(__dirname, '../src/components/panels/Settings.tsx'), 'utf8');

/**
 * Settings mounts ProvidersTab through a lazy tab and a loaded store, which jsdom can't
 * settle here, so the tab is wrapped in the ancestor chain Settings.tsx renders. The
 * source assertion below fails if that chain changes, so this wrapper can't drift.
 */
function SettingsChain({ children }: { children: React.ReactNode }) {
  return (
    <div role="dialog" aria-label="Settings" className="panel panel--settings workspace-dock-panel">
      <div className="panel__body settings__body">
        <div role="tabpanel" className="settings__tabpanel">
          <fieldset className="settings__fieldset">{children}</fieldset>
        </div>
      </div>
    </div>
  );
}

const project = { id: 'p1', name: 'Alpha', createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:00Z' };

const SHELLS: Array<{ shell: string; name: string; mount: () => void }> = [
  { shell: 'model-picker__search', name: 'model picker', mount: () => { render(<ModelPicker value={null} onSelect={vi.fn()} onClose={vi.fn()} />); } },
  { shell: 'preset-library__search', name: 'styles (presets)', mount: () => { render(<PresetLibrary onApply={vi.fn()} onSaveCurrent={vi.fn()} onClose={vi.fn()} reloadKey={0} />); } },
  { shell: 'settings-search', name: 'settings', mount: () => { render(<SettingsChain><ProvidersTab saved={SAVED} /></SettingsChain>); } },
  { shell: 'project-home__search', name: 'project home', mount: () => {
    render(<ProjectHome {...({ projects: [project], loading: false, busy: false, error: null,
      onCreate: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRetry: vi.fn() } as never)} />);
  } },
];

beforeEach(() => {
  document.body.className = 'app-slava-restraint';
  useSettingsDraftStore.setState({ ...initialDraft, saved: SAVED, keyDrafts: {}, fieldDrafts: {}, openRow: null, pending: {}, errors: {} });
});
afterEach(() => { cleanup(); document.body.className = ''; useSettingsDraftStore.setState(initialDraft, true); });

describe('search shells carry the focus ring', () => {
  for (const { shell, name, mount } of SHELLS) {
    it(`${name}: the input draws no ring and the shell does`, () => {
      mount();
      const shellEl = document.querySelector(`.${shell}`) as HTMLElement;
      expect(shellEl, `${name} shell .${shell} not rendered`).not.toBeNull();
      const input = shellEl.querySelector('input') as HTMLInputElement;
      expect(input, `${name} input not rendered inside the shell`).not.toBeNull();
      const own = resolvedStyle(input)[':focus-visible|outline'];
      expect(own === undefined || /^(none|0)\b/.test(own), `${name} input ring: ${own}`).toBe(true);
      // The base rule clears the outline too, so a click or a later rule can't paint a native box.
      expect(resolvedStyle(input)['|outline'], `${name} input outline at rest`).toMatch(/^none\b/);
      const rules = appRules().filter((r) => r.base.includes(`.${shell}`) && r.decls.some((d) => d.prop === 'outline'));
      const ring = rules.filter((r) => /:has\(\s*input:focus-visible\s*\)|:focus-within/.test(r.selector)
        && r.decls.some((d) => d.prop === 'outline' && d.value.includes('--sr-focus-outline')));
      expect(ring.length, `${name} shell has no ring rule`).toBeGreaterThan(0);
    });
  }

  it('project home: an input that is not the search field keeps its own ring', () => {
    SHELLS[3].mount();
    const root = document.querySelector('.project-home') as HTMLElement;
    const other = document.createElement('input');
    root.appendChild(other);
    expect(resolvedStyle(other)[':focus-visible|outline']).toMatch(/--sr-focus-outline/);
  });

  it('Settings.tsx still nests ProvidersTab in the chain the wrapper builds', () => {
    const at = (needle: string) => { const i = SETTINGS_SRC.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const positions = [at('panel panel--settings workspace-dock-panel'), at('panel__body settings__body'), at('className="settings__tabpanel"'), at('className="settings__fieldset"'), at('<ProvidersTab')];
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('every search field in the list is the first input of its shell in the real component', () => {
    for (const { shell, mount } of SHELLS) {
      mount();
      expect(screen.queryAllByRole('searchbox').length + screen.queryAllByRole('textbox').length).toBeGreaterThan(0);
      expect(document.querySelector(`.${shell} > input`), shell).not.toBeNull();
      cleanup();
    }
  });
});

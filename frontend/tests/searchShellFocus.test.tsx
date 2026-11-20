// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRules, parseRules, resolvedStyle } from './helpers/cssCascade';
import { componentSources, discoverSearch } from './helpers/searchShells';

// Design: a search field that sits bare inside a visible box (a shell) never draws
// its own ring or native box. The shell takes the focus ring, so the ring follows
// the shell's shape. Each field is rendered in its real component, so a broad
// ancestor rule (`.project-home input:focus-visible`) is matched the way the app
// matches it. A field that is itself the box is not listed in SHELLS.
//
// Finding new shells: tests/helpers/searchShells.ts reads every component under src/
// and reports each search field by two rules.
//   1. A wrapper element, not an input, whose class has "search" in it and which holds
//      an input is a shell.
//   2. An input that is type="search", has role searchbox, or has a placeholder or
//      aria-label starting "Search": when its direct parent has "search" in its class
//      or a class that gives it a border or a fill at rest, that parent is a shell.
//      Otherwise the input is reported as a field of its own.
// Every shell or field found must be in SHELLS (checked below) or in SELF_BOX (fields
// that are the box themselves, each with a reason). A new one in neither fails with
// its name, so adding a search box means choosing here how it takes focus.

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

/** Search fields that are the box themselves, or sit in a surface the field fills; each draws its own ring. */
const SELF_BOX: Record<string, string> = {
  'connection-popup__search': 'the input has its own border and its own focus-visible rule',
  'panel__search': 'the node library field is an input with its own border and focus rule',
  'assets-panel__search': 'the assets field is an input with its own border and focus-visible rule',
  'command-palette__panel': 'the dialog surface; its input fills it with a bottom hairline and rings itself (inset)',
  'CommonsFilters.tsx: calm grid, warm serif…': 'a Commons filter input in a plain label; the input is the box',
  'CommonsEvaluation.tsx: Search keywords': 'a Commons evaluation keyword input; the input is the box',
  'CommonsReview.tsx: Search keywords': 'a Commons review keyword input; the input is the box',
};

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
      // The ring rule has to reach the element the component renders, not only exist in the CSS.
      const reaches = ring.filter((r) => {
        const stateless = r.selector.replace(/:focus-visible/g, '').replace(/:focus-within/g, '');
        try { return shellEl.matches(stateless); } catch { return false; }
      });
      expect(reaches.length, `${name}: no ring rule matches the rendered .${shell}: ${ring.map((r) => r.selector).join(' | ')}`).toBeGreaterThan(0);
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

  it('each listed shell renders exactly one input, as its direct child', () => {
    for (const { shell, mount } of SHELLS) {
      mount();
      const shellEl = document.querySelector(`.${shell}`) as HTMLElement;
      expect(shellEl.querySelectorAll('input').length, `${shell} inputs`).toBe(1);
      expect(shellEl.querySelector(':scope > input'), `${shell} input is not a direct child`).not.toBeNull();
      cleanup();
    }
  });

  it('every search shell or field in the components is in SHELLS or SELF_BOX', () => {
    const known = new Set([...SHELLS.map((s) => s.shell), ...Object.keys(SELF_BOX)]);
    const missing = discoverSearch(componentSources(join(__dirname, '../src')), appRules()).filter((f) => !known.has(f.id));
    expect(missing.map((f) => `${f.id} (${f.kind}, ${f.file})`), 'search fields found that are in neither SHELLS nor SELF_BOX').toEqual([]);
  });

  it('every SELF_BOX entry is still found, so the list cannot go stale', () => {
    const ids = new Set(discoverSearch(componentSources(join(__dirname, '../src')), appRules()).map((f) => f.id));
    expect(Object.keys(SELF_BOX).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('discovery flags a new shell that is in neither list', () => {
    const css = '.foo__box { border: 1px solid #333; border-radius: 6px; } .foo__box input { border: 0; background: transparent; }';
    const sources = [
      { file: 'fake/Foo.tsx', text: 'export const A = () => <div className="foo__search"><input value="" /></div>;' },
      { file: 'fake/Bar.tsx', text: 'export const B = () => <div className="foo__box"><input type="search" /></div>;' },
      { file: 'fake/Baz.tsx', text: 'export const C = () => <input placeholder="Search things" />;' },
      { file: 'fake/Quiet.tsx', text: 'export const D = () => <div className="foo__row"><input type="text" /></div>;' },
    ];
    const found = discoverSearch(sources, parseRules(css)).map((f) => `${f.kind}:${f.id}`);
    expect(found).toEqual(['shell:foo__search', 'shell:foo__box', 'field:Baz.tsx: Search things']);
  });
});

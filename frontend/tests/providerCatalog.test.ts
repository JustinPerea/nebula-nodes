import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { PROVIDER_KEY_LABELS } from '../src/lib/providerReadiness';
import { PROVIDER_KEYS, nodesForKey, providerMatches, unlockCount, unlockNames, unlockSummary } from '../src/lib/providerCatalog';

const keys = PROVIDER_KEYS.map((spec) => spec.key);

describe('provider catalog', () => {
  it('lists exactly the keys the backend accepts', () => {
    // backend/main.py's _CREDENTIAL_PROVIDER_ALLOWLIST aliases this catalog.
    const source = readFileSync(resolve(__dirname, '../../backend/services/credential_catalog.py'), 'utf8');
    const block = source.match(/CREDENTIAL_PROVIDERS: frozenset\[str\] = frozenset\(\{([\s\S]*?)\}\)/)?.[1] ?? '';
    const allowed = [...block.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1]);
    expect(allowed.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual([...allowed].sort());
  });

  it('covers every key a node can ask for, and every key has a readiness label', () => {
    const asked = new Set(Object.values(NODE_DEFINITIONS).flatMap((node) => (Array.isArray(node.envKeyName) ? node.envKeyName : [node.envKeyName]))
      .filter((key): key is string => !!key));
    for (const key of asked) expect(keys, `${key} is used by a node but missing from Settings`).toContain(key);
    for (const key of keys) expect(PROVIDER_KEY_LABELS[key], key).toBeTruthy();
  });

  it('says plainly where BytePlus is sold and what it needs before a run', () => {
    // BytePlus Service Specific Terms: "The BytePlus Model Services are not
    // available in the United States." Models need activating first.
    const byteplus = PROVIDER_KEYS.find((spec) => spec.key === 'BYTEPLUS_API_KEY');
    expect(byteplus?.caveat).toMatch(/doesn't offer its model services in the United States/);
    expect(byteplus?.caveat).toMatch(/activate each model/);
    expect(byteplus?.caveat).toMatch(/USD 30/);
    expect(nodesForKey('BYTEPLUS_API_KEY').map((node) => node.id)).toContain('seedream-4-5');
  });

  it('offers the Black Forest Labs key for the FLUX 3 nodes it is the maker route of', () => {
    const bfl = PROVIDER_KEYS.find((spec) => spec.key === 'BFL_API_KEY')!;
    expect(bfl).toMatchObject({ label: 'Black Forest Labs', url: 'https://dashboard.bfl.ai' });
    expect(nodesForKey('BFL_API_KEY').map((node) => node.id).sort()).toEqual([
      'flux-3-image', 'flux-3-image-klein', 'flux-3-video', 'flux-video-edit', 'flux-video-upscale',
    ]);
    expect(unlockSummary(bfl, 'add')).toMatch(/^5 nodes: /);
    expect(PROVIDER_KEY_LABELS.BFL_API_KEY).toBe('Black Forest Labs');
  });

  it('highlights only real nodes that use the row\'s own key', () => {
    for (const spec of PROVIDER_KEYS) {
      const ids = new Set(nodesForKey(spec.key).map((node) => node.id));
      for (const id of spec.highlights ?? []) expect(ids.has(id), `${spec.key} highlights ${id}`).toBe(true);
    }
  });

  it('writes summaries people can read', () => {
    for (const spec of PROVIDER_KEYS) {
      const summary = unlockSummary(spec, 'add');
      expect(summary, spec.key).toBeTruthy();
      // A trimmed brand never leaves a bare version number ("Krea 2" stays "Krea 2").
      for (const name of unlockNames(spec)) expect(name, `${spec.key}: ${name}`).not.toMatch(/^\d/);
    }
    const fal = PROVIDER_KEYS.find((spec) => spec.key === 'FAL_KEY')!;
    expect(unlockSummary(fal, 'add')).toMatch(new RegExp(`^${unlockCount(fal)} nodes: Kling V3, FLUX 2 Pro`));
    expect(unlockSummary(fal, 'connected')).toMatch(/^Kling V3, FLUX 2 Pro, .* \+\d+$/);
  });

  it('finds providers by the models they run', () => {
    const matching = (query: string) => PROVIDER_KEYS.filter((spec) => providerMatches(spec, query)).map((spec) => spec.key);
    expect(matching('Veo')).toEqual(expect.arrayContaining(['GOOGLE_API_KEY', 'GOOGLE_VERTEX_CREDENTIALS', 'FAL_KEY']));
    expect(matching('Veo')).not.toContain('ANTHROPIC_API_KEY');
    expect(matching('hailuo')).toContain('MINIMAX_API_KEY');
    expect(matching('')).toHaveLength(PROVIDER_KEYS.length);
  });
});

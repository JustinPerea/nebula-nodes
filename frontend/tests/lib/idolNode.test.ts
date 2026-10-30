import { describe, expect, it } from 'vitest';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { isKeylessRoute, routeUnavailable, selectRoute } from '../../src/lib/directRoute';
import { nodeKeyStatus } from '../../src/lib/kreaConnection';
import { nodesForKey, PROVIDER_KEY_SPECS, unlockSummary } from '../../src/lib/providerCatalog';
import { modelReadiness, type ProviderHealthState } from '../../src/lib/providerReadiness';
import { providerKeyWarnings, providerSwitchState } from '../../src/lib/providerSwitch';
import { forwardInThree, upAxisToThreeRotation } from '../../src/lib/worldTransform';
import { previewSplat } from '../../src/lib/worldV2Splat';
import type { ModelNodeDefinition } from '../../src/types';
import type { WorldValueV2 } from '../../src/types/spatial';
import { worldV2Fixture } from '../fixtures/spatialValues';

const IDOL = NODE_DEFINITIONS['speridlabs-idol'];
const KEYLESS = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions['routes-keyless'];
const TOKEN = 'fixture-only';
const HEALTH: ProviderHealthState = { providers: {}, checkedAt: null, loading: false, error: null };

describe('the Idol node runs without a key (a keyless route)', () => {
  it('is one maker route on the Space, keyless, with the token optional', () => {
    expect(IDOL.envKeyName).toEqual([]);
    expect(IDOL.routes?.map((route) => [route.id, route.provider, route.maker, route.keys, route.optionalKeys]))
      .toEqual([['hf-space', 'speridlabs', true, [], ['HF_TOKEN']]]);
    expect(isKeylessRoute(IDOL.routes![0])).toBe(true);
    expect(IDOL.outputPorts.map((port) => [port.id, port.dataType])).toEqual([['world', 'World']]);
    expect(IDOL.inputPorts.map((port) => [port.id, port.dataType, port.required])).toEqual([['image', 'Image', true]]);
  });

  it('routes like the backend: anonymous without a token, on the token with one', () => {
    expect(selectRoute(IDOL, {}, {})).toMatchObject({ kind: 'direct', routeId: 'hf-space', key: null });
    expect(selectRoute(IDOL, {}, { HF_TOKEN: TOKEN })).toMatchObject({ routeId: 'hf-space', key: 'HF_TOKEN' });
    expect(routeUnavailable(IDOL, {}, {})).toBeNull();
  });

  it('never shows the card\'s missing-key mark', () => {
    expect(nodeKeyStatus(IDOL, {}, { apiKeys: {}, loaded: true })).toBeUndefined();
  });

  it('reads as needing no key, with the token offered in Settings', () => {
    const anonymous = modelReadiness(IDOL, {}, { apiKeys: {}, loaded: true }, HEALTH);
    expect(anonymous).toMatchObject({ label: 'No key needed', tone: 'neutral',
      setupTarget: { kind: 'api-key', key: 'HF_TOKEN' } });
    expect(anonymous.detail).toBe(
      'Runs without a key on a small shared daily allowance. Add a Hugging Face token in Settings to use your own.');
    const signedIn = modelReadiness(IDOL, {}, { apiKeys: { HF_TOKEN: TOKEN }, loaded: true }, HEALTH);
    expect(signedIn.label).toBe('Configured · not checked');
    expect(signedIn.detail).toMatch(/^Runs on your own Hugging Face allowance\./);
  });

  it('switcher: the Space row offers an optional key, never "Add key"', () => {
    const anonymous = providerSwitchState(IDOL, {}, { apiKeys: {}, kreaSignedIn: false });
    expect(anonymous.rows.map((row) => [row.id, row.label, row.keyState])).toEqual([
      ['auto', 'Auto · runs on Speridlabs', null],
      ['hf-space', 'Speridlabs', 'optional'],
    ]);
    expect(anonymous.rows[1].setup).toEqual({ kind: 'api-key', key: 'HF_TOKEN' });
    expect(anonymous.blocked).toBe(false);
    const signedIn = providerSwitchState(IDOL, {}, { apiKeys: { HF_TOKEN: TOKEN }, kreaSignedIn: false });
    expect(signedIn.rows[1].keyState).toBe('set');
  });

  it('switcher: a keyed route beside a keyless one still needs its key', () => {
    const state = providerSwitchState(KEYLESS, { _provider: 'fal' }, { apiKeys: {}, kreaSignedIn: false });
    expect(state.rows.map((row) => [row.id, row.keyState])).toEqual([
      ['auto', null], ['hf-space', 'optional'], ['fal', 'missing'],
    ]);
    expect(state.blocked).toBe(true);
    expect(state.alternatives.map((alternative) => alternative.routeId)).toEqual(['hf-space']);
  });

  it('warns about no key on Auto or on the keyless route', () => {
    const nodes = [
      { id: 'a', data: { definitionId: 'speridlabs-idol', params: { _provider: 'auto' } } },
      { id: 'b', data: { definitionId: 'speridlabs-idol', params: { _provider: 'hf-space' } } },
      { id: 'c', data: { definitionId: 'routes-keyless', params: { _provider: 'fal' } } },
    ];
    expect(providerKeyWarnings(nodes, { 'speridlabs-idol': IDOL, 'routes-keyless': KEYLESS }, {})).toEqual([
      '"Fixture Keyless" (c) is set to fal.ai, which you have no key for.',
    ]);
  });

  it('Settings lists Idol under the Hugging Face token', () => {
    expect(nodesForKey('HF_TOKEN').map((node) => node.id)).toEqual(['speridlabs-idol']);
    expect(unlockSummary(PROVIDER_KEY_SPECS.HF_TOKEN, 'add')).toBe('Optional: your own daily GPU time for Idol');
  });
});

describe('a World v2 splat in the preview', () => {
  const idolWorld = (uri: string, format: 'ply' | 'spz' = 'ply') => ({
    ...worldV2Fixture,
    assets: { splats: [{ id: 'splat', format, asset: { id: 'splat-ply', uri, mediaType: 'application/octet-stream' },
      pointCount: 262144 }] },
  }) as unknown as WorldValueV2;

  it('prefers an SPZ, takes a PLY, and refuses an unsafe URL', () => {
    expect(previewSplat(idolWorld('/api/outputs/run/idol.ply'))?.format).toBe('ply');
    expect(previewSplat(idolWorld('https://example.com/idol.ply'))).toBeNull();
    const both = idolWorld('/api/outputs/run/idol.ply');
    both.assets.splats = [...both.assets.splats,
      { ...both.assets.splats[0], id: 'spz', format: 'spz', asset: { ...both.assets.splats[0].asset, uri: '/api/outputs/run/w.spz' } }];
    expect(previewSplat(both)?.id).toBe('spz');
  });

  it('turns each up axis to Three\'s +Y up', () => {
    expect(upAxisToThreeRotation('y')).toEqual([0, 0, 0]);
    expect(upAxisToThreeRotation('-y')).toEqual([Math.PI, 0, 0]);
    // Idol: -Y up, +Z forward. Turned 180 degrees about X, the face points at -Z.
    expect(forwardInThree('-y', 'z')).toEqual([0, 0, -1]);
    expect(forwardInThree('y', 'z')).toEqual([0, 0, 1]);
    // Z-up (Blender's frame), -Y forward, faces +Z in Three.
    expect(forwardInThree('z', '-y')).toEqual([0, 0, 1]);
    expect(forwardInThree('x', 'z')).toEqual([0, 0, 1]);
  });
});

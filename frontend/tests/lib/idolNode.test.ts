import { describe, expect, it } from 'vitest';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { isKeylessRoute, routeMissingKeyLine, routeUnavailable, selectRoute } from '../../src/lib/directRoute';
import { nodesForKey, PROVIDER_KEY_SPECS, unlockSummary } from '../../src/lib/providerCatalog';
import { modelReadiness, type ProviderHealthState } from '../../src/lib/providerReadiness';
import { providerSwitchState } from '../../src/lib/providerSwitch';
import { nodesKeyLockReason, routeKeyLockReason } from '../../src/lib/runKeyLock';
import { forwardInThree, upAxisToThreeRotation } from '../../src/lib/worldTransform';
import { previewSplat } from '../../src/lib/worldV2Splat';
import type { ModelNodeDefinition } from '../../src/types';
import type { WorldValueV2 } from '../../src/types/spatial';
import { worldV2Fixture } from '../fixtures/spatialValues';

const IDOL = NODE_DEFINITIONS['speridlabs-idol'];
const KEYLESS = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions['routes-keyless'];
const TOKEN = 'fixture-only';
const HEALTH: ProviderHealthState = { providers: {}, checkedAt: null, loading: false, error: null };

const NEEDS_TOKEN = 'You can run Idol after you add your Hugging Face token in Settings.';

describe('the Idol node needs a Hugging Face token (GM, PR #203 r4)', () => {
  it('is one maker route on the Space, keyed on the token', () => {
    expect(IDOL.envKeyName).toEqual(['HF_TOKEN']);
    expect(IDOL.directKeyName).toEqual(['HF_TOKEN']);
    expect(IDOL.routes?.map((route) => [route.id, route.provider, route.maker, route.keys, route.optionalKeys]))
      .toEqual([['hf-space', 'speridlabs', true, ['HF_TOKEN'], undefined]]);
    expect(isKeylessRoute(IDOL.routes![0])).toBe(false);
    expect(IDOL.routes![0].missingKeyLine).toBe(NEEDS_TOKEN);
    expect(IDOL.outputPorts.map((port) => [port.id, port.dataType])).toEqual([['world', 'World']]);
    expect(IDOL.inputPorts.map((port) => [port.id, port.dataType, port.required])).toEqual([['image', 'Image', true]]);
    // Every "without a key" and "no key needed" is gone (GM r4).
    expect(IDOL.description).not.toMatch(/without a (key|token)|no key needed|optional/i);
  });

  it('routes like the backend: refused in GM\'s words without a token, on the token with one', () => {
    for (const params of [{}, { _provider: 'auto' }, { _provider: 'hf-space' }]) {
      expect(selectRoute(IDOL, params, {})).toMatchObject({ kind: 'unset', missing: ['HF_TOKEN'] });
      expect(routeUnavailable(IDOL, params, {})?.message).toBe(NEEDS_TOKEN);
      expect(routeKeyLockReason(IDOL, params, {})).toBe(NEEDS_TOKEN);
    }
    expect(selectRoute(IDOL, {}, { HF_TOKEN: TOKEN })).toMatchObject({ routeId: 'hf-space', key: 'HF_TOKEN' });
    expect(routeUnavailable(IDOL, {}, { HF_TOKEN: TOKEN })).toBeNull();
    expect(routeKeyLockReason(IDOL, {}, { HF_TOKEN: TOKEN })).toBeNull();
  });

  it('locks Run only for a node whose route has its own line, and only once Settings load', () => {
    const nodes = [
      { id: 'a', data: { definitionId: 'speridlabs-idol', params: {} } },
      { id: 'b', data: { definitionId: 'flux-3-image-klein', params: {} } },
    ];
    expect(nodesKeyLockReason(nodes, ['a'], { loaded: true, apiKeys: {} })).toBe(NEEDS_TOKEN);
    expect(nodesKeyLockReason(nodes, ['b', 'a'], { loaded: true, apiKeys: {} })).toBe(NEEDS_TOKEN);
    // Another node with no key keeps its own refusal at run time, unlocked.
    expect(nodesKeyLockReason(nodes, ['b'], { loaded: true, apiKeys: {} })).toBeNull();
    expect(nodesKeyLockReason(nodes, ['a'], { loaded: false, apiKeys: {} })).toBeNull();
    expect(nodesKeyLockReason(nodes, ['a'], { loaded: true, apiKeys: { HF_TOKEN: TOKEN } })).toBeNull();
  });

  it('uses the route\'s own line only for a missing key alone, and on Auto only when every route has one', () => {
    const unset = { kind: 'unset' as const, provider: null, key: null, routeId: null, missing: ['HF_TOKEN'] };
    expect(routeMissingKeyLine(IDOL, unset)).toBe(NEEDS_TOKEN);
    // Something else stops the route too: its own line doesn't hide that.
    expect(routeMissingKeyLine(IDOL, { ...unset, routeId: 'hf-space', block: { reason: 'unsupported', param: 'mode', on: null } }))
      .toBeNull();
    expect(routeMissingKeyLine(IDOL, { ...unset, missing: [] })).toBeNull();
    // A second route with no line of its own: Auto with no key keeps the
    // generic "add a key or choose another provider".
    const twoRoutes: ModelNodeDefinition = { ...IDOL, routes: [IDOL.routes![0],
      { ...IDOL.routes![0], missingKeyLine: undefined, id: 'fal', provider: 'fal', keys: ['FAL_KEY'], handler: 'fal' }] };
    expect(routeMissingKeyLine(twoRoutes, unset)).toBeNull();
    expect(routeMissingKeyLine(twoRoutes, { ...unset, routeId: 'hf-space' })).toBe(NEEDS_TOKEN);
    expect(routeMissingKeyLine(twoRoutes, { ...unset, routeId: 'fal' })).toBeNull();
  });

  it('reads in GM\'s words without the token, and only "Runs on your own Hugging Face allowance." with it', () => {
    const anonymous = modelReadiness(IDOL, {}, { apiKeys: {}, loaded: true }, HEALTH);
    expect(anonymous).toEqual({ label: 'Needed', tone: 'warning',
      setupTarget: { kind: 'api-key', key: 'HF_TOKEN' }, connectionLabel: 'Hugging Face token',
      detail: 'Add your Hugging Face token in Settings to run Idol. A free Hugging Face account gives a few runs a day.' });
    const signedIn = modelReadiness(IDOL, {}, { apiKeys: { HF_TOKEN: TOKEN }, loaded: true }, HEALTH);
    // GM r3: the specific line replaces the generic one, never both; the
    // label waits for the wording batch.
    expect(signedIn).toEqual({ label: 'Configured · not checked', tone: 'neutral',
      setupTarget: { kind: 'api-key', key: 'HF_TOKEN' }, connectionLabel: 'Hugging Face token',
      detail: 'Runs on your own Hugging Face allowance.' });
    expect(modelReadiness(IDOL, {}, { apiKeys: {}, loaded: false }, HEALTH).label).toBe('Connection not loaded');
  });

  it('switcher: "Add key →" without the token, the green "Connected" with it, and GM\'s row note', () => {
    const anonymous = providerSwitchState(IDOL, {}, { apiKeys: {}, kreaSignedIn: false });
    expect(anonymous.rows.map((row) => [row.id, row.keyState])).toEqual([
      ['auto', null], ['hf-space', 'missing'],
    ]);
    expect(anonymous.rows[1].label).toBe('Speridlabs');
    expect(anonymous.rows[1].info).toBe('Free with a Hugging Face token. A free account gives a few runs a day.');
    expect(anonymous.rows[1].setup).toEqual({ kind: 'api-key', key: 'HF_TOKEN' });
    const signedIn = providerSwitchState(IDOL, {}, { apiKeys: { HF_TOKEN: TOKEN }, kreaSignedIn: false });
    expect(signedIn.rows[1].keyState).toBe('connected');
  });

  it('switcher: a keyed route beside a keyless one still needs its key', () => {
    const state = providerSwitchState(KEYLESS, { _provider: 'fal' }, { apiKeys: {}, kreaSignedIn: false });
    expect(state.rows.map((row) => [row.id, row.keyState])).toEqual([
      ['auto', null], ['hf-space', 'none'], ['fal', 'missing'],
    ]);
    expect(state.blocked).toBe(true);
    expect(state.alternatives.map((alternative) => alternative.routeId)).toEqual(['hf-space']);
  });

  it('a keyless Space route still reads as its free allowance', () => {
    const keyless = modelReadiness(KEYLESS, { _provider: 'hf-space' }, { apiKeys: {}, loaded: true }, HEALTH);
    expect(keyless).toMatchObject({ label: 'Free daily allowance', tone: 'neutral', connectionNote: 'Optional' });
    expect(routeKeyLockReason(KEYLESS, { _provider: 'hf-space' }, {})).toBeNull();
  });

  it('Settings lists Idol under the Hugging Face token, as needed', () => {
    expect(nodesForKey('HF_TOKEN').map((node) => node.id)).toEqual(['speridlabs-idol']);
    expect(unlockSummary(PROVIDER_KEY_SPECS.HF_TOKEN, 'add')).toBe('Needed to run Idol.');
    expect(PROVIDER_KEY_SPECS.HF_TOKEN).toMatchObject({ label: 'Hugging Face', credential: 'token',
      caveat: 'Idol runs on your Hugging Face allowance. With Hugging Face PRO, time past your allowance uses '
        + 'your prepaid Hugging Face credits.' });
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
    // Idol: -Y up, +X forward (its value's forwardAxis). Turned 180 degrees
    // about X, +X stays +X.
    expect(forwardInThree('-y', 'x')).toEqual([1, 0, 0]);
    expect(forwardInThree('-y', 'z')).toEqual([0, 0, -1]);
    expect(forwardInThree('y', 'z')).toEqual([0, 0, 1]);
    // Z-up (Blender's frame), -Y forward, faces +Z in Three.
    expect(forwardInThree('z', '-y')).toEqual([0, 0, 1]);
    expect(forwardInThree('x', 'z')).toEqual([0, 0, 1]);
  });
});

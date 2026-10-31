import { describe, expect, it } from 'vitest';
import routeCases from '../../../backend/tests/fixtures/route_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { isKeylessRoute, keyBilling, routeMissingKeyLine, routeUnavailable, selectRoute } from '../../src/lib/directRoute';
import { nodesForKey, PROVIDER_KEY_SPECS } from '../../src/lib/providerCatalog';
import { modelReadiness, type ProviderHealthState } from '../../src/lib/providerReadiness';
import { providerSwitchState } from '../../src/lib/providerSwitch';
import { nodesKeyLockReason, routeKeyLockReason } from '../../src/lib/runKeyLock';
import { forwardInThree, upAxisToThreeRotation } from '../../src/lib/worldTransform';
import { previewSplat } from '../../src/lib/worldV2Splat';
import type { ModelNodeDefinition } from '../../src/types';
import type { WorldValueV2 } from '../../src/types/spatial';
import { worldV2Fixture } from '../fixtures/spatialValues';
import { KEYED_LINE, keyIdolInEachTest } from '../helpers/keyedSpace';

const IDOL = NODE_DEFINITIONS['speridlabs-idol'];
const KEYLESS = (routeCases as unknown as { definitions: Record<string, ModelNodeDefinition> }).definitions['routes-keyless'];
const TOKEN = 'fixture-only';
const HEALTH: ProviderHealthState = { providers: {}, checkedAt: null, loading: false, error: null };

describe('the Idol node runs free without a token, and on the person\'s allowance with one (PR #203 round 7, GM r12)', () => {
  it('is one keyless maker route on the Space, the token optional, may bill with it', () => {
    expect(IDOL.envKeyName).toEqual([]);
    expect(IDOL.directKeyName).toEqual([]);
    expect(IDOL.routes?.map((route) => [route.id, route.provider, route.maker, route.keys, route.optionalKeys, route.mayBillWithKey]))
      .toEqual([['hf-space', 'speridlabs', true, [], ['HF_TOKEN'], true]]);
    expect(isKeylessRoute(IDOL.routes![0])).toBe(true);
    expect(IDOL.routes![0].missingKeyLine).toBeUndefined();
    expect(IDOL.outputPorts.map((port) => [port.id, port.dataType])).toEqual([['world', 'World']]);
    expect(IDOL.inputPorts.map((port) => [port.id, port.dataType, port.required])).toEqual([['image', 'Image', true]]);
    // GM r12 item 4, word for word.
    expect(IDOL.description).toBe('Turns one image into a 3D Gaussian splat you can explore. Made by Speridlabs, it runs '
      + 'free on Hugging Face. Add your Hugging Face token to use your own allowance.');
  });

  it('routes like the backend: anonymous without a token, on the token with one, never locked', () => {
    for (const params of [{}, { _provider: 'auto' }, { _provider: 'hf-space' }]) {
      expect(selectRoute(IDOL, params, {})).toMatchObject({ kind: 'direct', routeId: 'hf-space', key: null });
      expect(routeUnavailable(IDOL, params, {})).toBeNull();
      expect(routeKeyLockReason(IDOL, params, {})).toBeNull();
      expect(keyBilling(IDOL, params, {})).toBe('free');
      expect(keyBilling(IDOL, params, { HF_TOKEN: TOKEN })).toBe('mayCost');
    }
    expect(selectRoute(IDOL, {}, { HF_TOKEN: TOKEN })).toMatchObject({ routeId: 'hf-space', key: 'HF_TOKEN' });
    // The whitespace-only token is no token (the backend's is_set).
    expect(keyBilling(IDOL, {}, { HF_TOKEN: '   ' })).toBe('free');
    // A node without the flag is counted as before.
    expect(keyBilling(NODE_DEFINITIONS['flux-3-image-klein'], {}, {})).toBeNull();
  });

  it('locks no Run for Idol, with or without the token', () => {
    const nodes = [{ id: 'a', data: { definitionId: 'speridlabs-idol', params: {} } }];
    expect(nodesKeyLockReason(nodes, ['a'], { loaded: true, apiKeys: {} })).toBeNull();
    expect(nodesKeyLockReason(nodes, ['a'], { loaded: true, apiKeys: { HF_TOKEN: TOKEN } })).toBeNull();
  });

  it('reads "Hugging Face · Free" without the token and "Hugging Face token · Saved" with it, in GM\'s r12 words', () => {
    const anonymous = modelReadiness(IDOL, {}, { apiKeys: {}, loaded: true }, HEALTH);
    expect(anonymous).toEqual({ label: 'Free', tone: 'neutral',
      setupTarget: { kind: 'api-key', key: 'HF_TOKEN' }, connectionLabel: 'Hugging Face',
      detail: 'Idol runs free on Hugging Face’s shared GPUs, which can be busy. Add your Hugging Face token in Settings '
        + 'to use your own allowance.' });
    const signedIn = modelReadiness(IDOL, {}, { apiKeys: { HF_TOKEN: TOKEN }, loaded: true }, HEALTH);
    expect(signedIn).toEqual({ label: 'Saved', tone: 'neutral',
      setupTarget: { kind: 'api-key', key: 'HF_TOKEN' }, connectionLabel: 'Hugging Face token',
      detail: 'Idol uses your Hugging Face allowance.' });
    // No allowance numbers and no run counts anywhere (GM r12).
    for (const line of [anonymous?.detail, signedIn?.detail]) expect(line).not.toMatch(/\d/);
  });

  it('switcher: "Free on Hugging Face." and "Auto · free" without the token; "Uses your Hugging Face allowance." and "Auto" with it', () => {
    const anonymous = providerSwitchState(IDOL, {}, { apiKeys: {}, kreaSignedIn: false });
    expect(anonymous.rows.map((row) => [row.id, row.label, row.keyState])).toEqual([
      ['auto', 'Auto · free', null], ['hf-space', 'Speridlabs', 'none'],
    ]);
    expect(anonymous.rows[1].info).toBe('Free on Hugging Face.');
    expect(anonymous.rows[1].setup).toEqual({ kind: 'api-key', key: 'HF_TOKEN' });
    expect(anonymous.blocked).toBe(false);
    const signedIn = providerSwitchState(IDOL, {}, { apiKeys: { HF_TOKEN: TOKEN }, kreaSignedIn: false });
    expect(signedIn.rows.map((row) => [row.id, row.label, row.keyState])).toEqual([
      ['auto', 'Auto', null], ['hf-space', 'Speridlabs', 'connected'],
    ]);
    expect(signedIn.rows[1].info).toBe('Uses your Hugging Face allowance.');
  });

  it('switcher: a keyed route beside a keyless one still needs its key', () => {
    const state = providerSwitchState(KEYLESS, { _provider: 'fal' }, { apiKeys: {}, kreaSignedIn: false });
    expect(state.rows.map((row) => [row.id, row.keyState])).toEqual([
      ['auto', null], ['hf-space', 'none'], ['fal', 'missing'],
    ]);
    expect(state.blocked).toBe(true);
    expect(state.alternatives.map((alternative) => alternative.routeId)).toEqual(['hf-space']);
  });

  it('Settings lists Idol under the Hugging Face token, as optional, with GM\'s r11 lines and r12 helper', () => {
    expect(nodesForKey('HF_TOKEN').map((node) => node.id)).toEqual(['speridlabs-idol']);
    expect(PROVIDER_KEY_SPECS.HF_TOKEN).toMatchObject({ label: 'Hugging Face', keyLink: 'Open Hugging Face tokens',
      note: 'Optional. Gives Idol your own Hugging Face allowance.',
      instruction: 'Create a fine-grained token in your Hugging Face settings and give it no repository access. '
        + 'Nebula uses it only for Idol’s GPU time on Hugging Face.',
      keyLink: 'Open Hugging Face tokens', url: 'https://huggingface.co/settings/tokens',
      caveat: 'With your token, Idol runs on your Hugging Face allowance. With Hugging Face PRO, time past your '
        + 'allowance uses your prepaid Hugging Face credits.' });
  });
});

describe('the keyed-route machinery that stays for other nodes (on Idol made keyed for the test)', () => {
  keyIdolInEachTest();

  it('locks Run in the route\'s own words only for a node whose route has a line, and only once Settings load', () => {
    const keyed = NODE_DEFINITIONS['speridlabs-idol'];
    for (const params of [{}, { _provider: 'auto' }, { _provider: 'hf-space' }]) {
      expect(selectRoute(keyed, params, {})).toMatchObject({ kind: 'unset', missing: ['HF_TOKEN'] });
      expect(routeUnavailable(keyed, params, {})?.message).toBe(KEYED_LINE);
      expect(routeKeyLockReason(keyed, params, {})).toBe(KEYED_LINE);
    }
    const nodes = [
      { id: 'a', data: { definitionId: 'speridlabs-idol', params: {} } },
      { id: 'b', data: { definitionId: 'flux-3-image-klein', params: {} } },
    ];
    expect(nodesKeyLockReason(nodes, ['b', 'a'], { loaded: true, apiKeys: {} })).toBe(KEYED_LINE);
    expect(nodesKeyLockReason(nodes, ['b'], { loaded: true, apiKeys: {} })).toBeNull();
    expect(nodesKeyLockReason(nodes, ['a'], { loaded: false, apiKeys: {} })).toBeNull();
    expect(nodesKeyLockReason(nodes, ['a'], { loaded: true, apiKeys: { HF_TOKEN: TOKEN } })).toBeNull();
    // A keyed Space route says what is needed (GM r5 item 1).
    expect(modelReadiness(keyed, {}, { apiKeys: {}, loaded: true }, HEALTH)).toMatchObject({
      label: 'Needed', connectionLabel: 'Hugging Face token' });
  });

  it('uses the route\'s own line only for a missing key alone, and on Auto only when every route has one', () => {
    const keyed = NODE_DEFINITIONS['speridlabs-idol'];
    const unset = { kind: 'unset' as const, provider: null, key: null, routeId: null, missing: ['HF_TOKEN'] };
    expect(routeMissingKeyLine(keyed, unset)).toBe(KEYED_LINE);
    expect(routeMissingKeyLine(keyed, { ...unset, routeId: 'hf-space', block: { reason: 'unsupported', param: 'mode', on: null } }))
      .toBeNull();
    expect(routeMissingKeyLine(keyed, { ...unset, missing: [] })).toBeNull();
    const twoRoutes: ModelNodeDefinition = { ...keyed, routes: [keyed.routes![0],
      { ...keyed.routes![0], missingKeyLine: undefined, id: 'fal', provider: 'fal', keys: ['FAL_KEY'], handler: 'fal' }] };
    expect(routeMissingKeyLine(twoRoutes, unset)).toBeNull();
    expect(routeMissingKeyLine(twoRoutes, { ...unset, routeId: 'hf-space' })).toBe(KEYED_LINE);
    expect(routeMissingKeyLine(twoRoutes, { ...unset, routeId: 'fal' })).toBeNull();
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

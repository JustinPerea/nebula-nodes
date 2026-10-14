import { describe, expect, it } from 'vitest';
import backendCatalog from '../../../backend/data/node_definitions.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { nodeKeyStatus, type CredentialReadiness } from '../../src/lib/kreaConnection';
import {
  cinemaSceneBase, isLocalRun, keysNeeded, missingKeyTitle, modelChoice, paramCallsProvider,
} from '../../src/lib/nodeKeys';

const cinema = NODE_DEFINITIONS['cinema-scene'];
const qc = NODE_DEFINITIONS['qc-frame-review'];
const keys = (apiKeys: Record<string, string>): CredentialReadiness => ({ loaded: true, apiKeys });
const scene = (model: unknown) => ({ scene: { base: { model }, shots: [] } });

describe('local nodes that call a provider', () => {
  it('reads the same providerVia as the backend catalog', () => {
    // The canvas reads providerVia from the TS definitions and the backend
    // (readiness, pricing, agent surfaces) from node_definitions.json; the
    // backend parity tests pin only the JSON copy, so the two must not drift.
    const catalog = backendCatalog as Record<string, { providerVia?: unknown }>;
    const declared = (defs: Record<string, { providerVia?: unknown }>) =>
      Object.fromEntries(Object.entries(defs).flatMap(([id, d]) => (d.providerVia ? [[id, d.providerVia]] : [])));
    expect(declared(NODE_DEFINITIONS)).toEqual(declared(catalog));
    expect(Object.values(NODE_DEFINITIONS).filter((d) => d.providerVia).length).toBeGreaterThan(0);
  });

  it('badges a cinema scene by the key its base model needs', () => {
    expect(nodeKeyStatus(cinema, scene('seedream-4-5'), keys({}))).toBe('missing');
    expect(nodeKeyStatus(cinema, {}, keys({}))).toBe('missing');
    expect(nodeKeyStatus(cinema, scene('seedream-4-5'), keys({ FAL_KEY: '***f' }))).toBeUndefined();
    expect(nodeKeyStatus(cinema, scene('nano-banana'), keys({ GOOGLE_API_KEY: '***g' }))).toBeUndefined();
    expect(nodeKeyStatus(cinema, scene('seedream-4-5'), keys({ GOOGLE_API_KEY: '***g' }))).toBe('missing');
    // A scene that can't be read, or a base the handler refuses: fail closed.
    expect(nodeKeyStatus(cinema, { scene: 'text' }, keys({ FAL_KEY: '***f' }))).toBe('missing');
    expect(nodeKeyStatus(cinema, scene('world-labs'), keys({ FAL_KEY: '***f' }))).toBe('missing');
    expect(missingKeyTitle(cinema, scene('seedream-4-5'))).toBe('Needs FAL_KEY for base seedream-4-5');
  });

  it('badges a QC node only in a mode that calls a vision model', () => {
    expect(nodeKeyStatus(qc, { mode: 'heuristic' }, keys({}))).toBeUndefined();
    expect(nodeKeyStatus(qc, {}, keys({}))).toBeUndefined();
    expect(nodeKeyStatus(qc, { mode: 'vision-llm' }, keys({}))).toBe('missing');
    expect(nodeKeyStatus(qc, { mode: 'vision-llm' }, keys({ OPENAI_API_KEY: '***o' }))).toBeUndefined();
    expect(missingKeyTitle(qc, { mode: 'vision-llm' }))
      .toBe('Needs ANTHROPIC_API_KEY or OPENAI_API_KEY or GOOGLE_API_KEY for mode vision-llm');
    expect(nodeKeyStatus(qc, { mode: 'vision-llm' }, { loaded: false, apiKeys: {} })).toBeUndefined();
  });

  it('badges a QC node in Jev mode on the TypeSafe key alone', () => {
    expect(nodeKeyStatus(qc, { mode: 'jev' }, keys({}))).toBe('missing');
    expect(nodeKeyStatus(qc, { mode: 'jev' }, keys({ OPENAI_API_KEY: '***o' }))).toBe('missing');
    expect(nodeKeyStatus(qc, { mode: 'jev' }, keys({ TYPESAFE_API_KEY: '***t' }))).toBeUndefined();
    expect(nodeKeyStatus(qc, { mode: 'vision-llm' }, keys({ TYPESAFE_API_KEY: '***t' }))).toBe('missing');
    expect(missingKeyTitle(qc, { mode: 'jev' })).toBe('Needs TYPESAFE_API_KEY for mode jev');
  });

  it('reads the QC mode exactly like the handler: only heuristic and opencv run locally', () => {
    for (const [params, calls] of [
      [{}, false], [{ mode: 'heuristic' }, false], [{ mode: 'opencv' }, false], [{ mode: 'vision-llm' }, true],
      [{ mode: '' }, true], [{ mode: null }, true], [{ mode: 'Heuristic' }, true], [{ mode: 'bogus' }, true],
    ] as Array<[Record<string, unknown>, boolean]>) {
      expect(paramCallsProvider(qc, params), JSON.stringify(params)).toBe(calls);
      expect(isLocalRun(qc, params)).toBe(!calls);
      expect(keysNeeded(qc, params)?.length).toBe(calls ? 1 : 0);
    }
    expect(isLocalRun(NODE_DEFINITIONS['text-input'], {})).toBe(true);
    expect(isLocalRun(cinema, {})).toBe(false);
  });

  it('picks the base model the way the backend readiness and guard do', () => {
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{}, 'seedream-4-5'], [{ scene: {} }, 'seedream-4-5'], [scene(''), 'seedream-4-5'], [scene(null), 'seedream-4-5'],
      [scene(' FLUX-1-dev '), 'seedream-4-5'], [scene('Nano-Banana'), 'nano-banana'], [scene('flux-kontext'), 'flux-kontext'],
      [scene('worldlabs-environment'), null], [scene(5), null], [{ scene: 'text' }, null],
      [{ scene: { base: 'nano-banana' } }, null],
    ];
    for (const [params, expected] of cases) expect(modelChoice(cinema, params), JSON.stringify(params)).toBe(expected);
  });

  it('prices exactly the definition’s base models, each one its own definition', () => {
    const via = cinema.providerVia;
    expect(via?.kind).toBe('model');
    if (via?.kind !== 'model') return;
    for (const model of via.models) {
      expect(NODE_DEFINITIONS[model], model).toBeDefined();
      expect(cinemaSceneBase({ scene: { base: { model }, shots: [{}] } })?.model).toBe(model);
    }
    for (const fallback of via.fallbackFor) {
      expect(cinemaSceneBase({ scene: { base: { model: fallback }, shots: [] } })?.model).toBe(via.default);
    }
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { PROVIDER_KEY_LABELS } from '../src/lib/providerReadiness';
import { PROVIDER_KEYS, nodesForKey, providerMatches, summarizeUnlocked, unlockCount, unlockNames, unlockSummary } from '../src/lib/providerCatalog';

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

  it('offers the Black Forest Labs key for the FLUX 3 and FLUX.2 nodes it is the maker route of', () => {
    const bfl = PROVIDER_KEYS.find((spec) => spec.key === 'BFL_API_KEY')!;
    expect(bfl).toMatchObject({ label: 'Black Forest Labs', url: 'https://dashboard.bfl.ai' });
    expect(nodesForKey('BFL_API_KEY').map((node) => node.id).sort()).toEqual([
      'flux-2-pro', 'flux-3-image', 'flux-3-image-klein', 'flux-3-video', 'flux-video-edit', 'flux-video-upscale',
    ]);
    expect(unlockSummary(bfl)).toMatch(/^6 nodes, including /);
    expect(PROVIDER_KEY_LABELS.BFL_API_KEY).toBe('Black Forest Labs');
  });

  it('leads each row with a real node of the row\'s own key, by its full card name (design)', () => {
    const cards = new Set(Object.values(NODE_DEFINITIONS).map((node) => node.displayName));
    for (const spec of PROVIDER_KEYS) {
      if (!spec.lead) continue;
      const ids = new Set(nodesForKey(spec.key).map((node) => node.id));
      expect(ids.has(spec.lead), `${spec.key} leads with ${spec.lead}`).toBe(true);
      expect(spec.countOnly, `${spec.key} has a lead and says the count alone`).toBeFalsy();
      expect(cards.has(NODE_DEFINITIONS[spec.lead].displayName)).toBe(true);
    }
  });

  it('fails when a row names a card that does not exist', () => {
    const cards = new Set(Object.values(NODE_DEFINITIONS).map((node) => node.displayName));
    for (const spec of PROVIDER_KEYS) {
      const said = /^\d+ nodes, including (.+)$/.exec(unlockSummary(spec))?.[1];
      if (said) expect(cards.has(said), `${spec.key} says "${said}", which is no card`).toBe(true);
    }
  });

  it('says each row as design ruled it', () => {
    const said = Object.fromEntries(PROVIDER_KEYS.map((spec) => [spec.key, unlockSummary(spec)]));
    expect(said).toMatchObject({
      OPENAI_API_KEY: expect.stringMatching(/^\d+ nodes, including GPT Image 2\.5$/),
      ANTHROPIC_API_KEY: 'Claude',
      GOOGLE_API_KEY: expect.stringMatching(/^\d+ nodes, including Nano Banana$/),
      GOOGLE_VERTEX_CREDENTIALS: '4 nodes, including Veo 3.1',
      OPENROUTER_API_KEY: '4 nodes',
      REPLICATE_API_TOKEN: '6 nodes',
      FAL_KEY: expect.stringMatching(/^\d+ nodes, including Kling V3$/),
      MESHY_API_KEY: expect.stringMatching(/^\d+ nodes, including Meshy 6 Text-to-3D$/),
      RUNWAY_API_KEY: expect.stringMatching(/^\d+ nodes, including Runway Video$/),
      ELEVENLABS_API_KEY: expect.stringMatching(/^\d+ nodes, including ElevenLabs TTS$/),
      MINIMAX_API_KEY: '7 nodes',
      XAI_API_KEY: expect.stringMatching(/^\d+ nodes, including Grok Imagine Video$/),
      HIGGSFIELD_API_KEY: 'Image-to-video with DoP, Kling 2.1 and Seedance',
      QUIVER_API_KEY: 'Arrow Generate and Arrow Vectorize',
      KREA_API_TOKEN: expect.stringMatching(/^\d+ nodes, including Krea 2$/),
      KREA_USAGE_KEY: 'Workspace spend reporting on enterprise plans',
      IDEOGRAM_API_KEY: expect.stringMatching(/^\d+ nodes, including Ideogram 4$/),
      TYPESAFE_API_KEY: 'Typed decisions with Jev',
      WORLDLABS_API_KEY: 'Environment and Export',
      BFL_API_KEY: '6 nodes, including FLUX 3 Image',
      HF_TOKEN: 'Optional. Lets Idol use your own allowance.',
      BYTEPLUS_API_KEY: expect.stringMatching(/^\d+ nodes, including Seedream 4\.5$/),
    });
    expect(PROVIDER_KEYS.find((spec) => spec.key === 'TYPESAFE_API_KEY')?.noteTitle).toBe('Typed judge, classify and pick-best decisions');
  });

  it('writes summaries people can read', () => {
    for (const spec of PROVIDER_KEYS) {
      const summary = unlockSummary(spec);
      expect(summary, spec.key).toBeTruthy();
      // A trimmed brand never leaves a bare version number ("Krea 2" stays "Krea 2").
      for (const name of unlockNames(spec)) expect(name, `${spec.key}: ${name}`).not.toMatch(/^\d/);
    }
    const fal = PROVIDER_KEYS.find((spec) => spec.key === 'FAL_KEY')!;
    expect(unlockSummary(fal)).toMatch(new RegExp(`^${unlockCount(fal)} nodes, including Kling V3$`));
  });

  it('lists the names alone up to three nodes, then the count and one name (design r164)', () => {
    const names = ['Nano Banana', 'Veo 3.1', 'Lyria 3', 'Imagen 4', 'Gemini'];
    expect(summarizeUnlocked(names.slice(0, 1))).toBe('Nano Banana');
    expect(summarizeUnlocked(names.slice(0, 2))).toBe('Nano Banana and Veo 3.1');
    expect(summarizeUnlocked(names.slice(0, 3))).toBe('Nano Banana, Veo 3.1 and Lyria 3');
    expect(summarizeUnlocked(names.slice(0, 4), names[0])).toBe('4 nodes, including Nano Banana');
    expect(summarizeUnlocked(names.slice(0, 4))).toBe('4 nodes');
    const fifteen = Array.from({ length: 15 }, (_, i) => (i < 3 ? names[i] : `Node ${i}`));
    expect(summarizeUnlocked(fifteen, names[0])).toBe('15 nodes, including Nano Banana');
    for (const count of [1, 2, 3, 4, 15]) {
      const said = summarizeUnlocked(Array.from({ length: count }, (_, i) => `Name ${i}`));
      expect(said).not.toMatch(/[:…]/);
    }
  });

  it('finds providers by the models they run', () => {
    const matching = (query: string) => PROVIDER_KEYS.filter((spec) => providerMatches(spec, query)).map((spec) => spec.key);
    expect(matching('Veo')).toEqual(expect.arrayContaining(['GOOGLE_API_KEY', 'GOOGLE_VERTEX_CREDENTIALS', 'FAL_KEY']));
    expect(matching('Veo')).not.toContain('ANTHROPIC_API_KEY');
    expect(matching('hailuo')).toContain('MINIMAX_API_KEY');
    expect(matching('')).toHaveLength(PROVIDER_KEYS.length);
  });
});

import { describe, expect, it } from 'vitest';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';

/**
 * The lines the Idol and Cinema handlers raise for the person (backend/handlers/speridlabs_idol.py and
 * cinema_scene.py), as a card shows them through the real framing: "Nebula couldn’t run the node because …"
 * on a node card, "Nebula couldn’t generate the shot because …" on the Cinema shot panel (design).
 * backend/tests/test_speridlabs_idol.py and test_cinema_art_direction.py pin the same raised text.
 */
const card = (person: string) => nodeErrorCopy({ raw: 'raw text for Details', category: 'unknown', person, providerText: true }).reason;
const shot = (person: string) => nodeErrorCopy({ raw: 'raw text for Details', category: 'unknown', person, surface: 'shot' }).reason;

describe('Idol lines on the node card', () => {
  const RUN = 'Nebula couldn’t run the node because ';
  it.each([
    ['5 anonymous free GPU time', 'Hugging Face’s free GPU time for Idol is used up for now. Try again later, or add your Hugging Face token in Settings to use your own allowance.',
      `${RUN}Hugging Face’s free GPU time for Idol is used up for now. Try again later, or add your Hugging Face token in Settings to use your own allowance.`],
    ['6 own allowance', 'Your Hugging Face GPU allowance is used up for now. Try again later, or raise it on Hugging Face.',
      `${RUN}your Hugging Face GPU allowance is used up for now. Try again later, or raise it on Hugging Face.`],
    ['7 token not applied', 'It ran without your Hugging Face token and hit the free allowance. Check your token in Settings, then try again.',
      `${RUN}it ran without your Hugging Face token and hit the free allowance. Check your token in Settings, then try again.`],
    ['8 duration, signed in', 'It needs more GPU time per run than your Hugging Face account allows. Raise your allowance on Hugging Face, then try again.',
      `${RUN}it needs more GPU time per run than your Hugging Face account allows. Raise your allowance on Hugging Face, then try again.`],
    ['8 duration, free', 'It needs more GPU time per run than the free allowance gives. Add your Hugging Face token in Settings, then try again.',
      `${RUN}it needs more GPU time per run than the free allowance gives. Add your Hugging Face token in Settings, then try again.`],
    ['9 token refused', 'Hugging Face rejected your token. Check your Hugging Face token in Settings.',
      `${RUN}Hugging Face rejected your token. Check your Hugging Face token in Settings.`],
    ['10 bad character', 'The token has a character Hugging Face tokens can’t have. Copy it again from Hugging Face, then paste it in Settings.',
      `${RUN}the token has a character Hugging Face tokens can’t have. Copy it again from Hugging Face, then paste it in Settings.`],
    ['11 Space missing', 'Idol isn’t on Hugging Face anymore. Use another 3D node.',
      `${RUN}Idol isn’t on Hugging Face anymore. Use another 3D node.`],
    ['12 down', 'Idol isn’t running on Hugging Face right now. Try again later.',
      `${RUN}Idol isn’t running on Hugging Face right now. Try again later.`],
    ['12 starting', 'Idol is still starting on Hugging Face. Try again in a few minutes.',
      `${RUN}Idol is still starting on Hugging Face. Try again in a few minutes.`],
    ['12 no GPU', 'Hugging Face has no free GPU for Idol right now. Try again in a few minutes.',
      `${RUN}Hugging Face has no free GPU for Idol right now. Try again in a few minutes.`],
    ['13 changed', 'Idol changed on Hugging Face and this version of Nebula can’t run it. Update Nebula, then try again.',
      `${RUN}Idol changed on Hugging Face and this version of Nebula can’t run it. Update Nebula, then try again.`],
    ['14 no image', 'It needs an image. Connect one, then run it again.',
      `${RUN}it needs an image. Connect one, then run it again.`],
  ])('%s', (_name, raised, shown) => {
    expect(card(raised)).toBe(shown);
  });
});

describe('Cinema lines on the shot panel', () => {
  const SHOT = 'Nebula couldn’t generate the shot because ';
  it('4 reference cap', () => {
    expect(shot('Seedream 4.5 takes up to 10 reference images and this shot has 12. Remove some, or choose another base model. Nothing was sent.'))
      .toBe(`${SHOT}Seedream 4.5 takes up to 10 reference images and this shot has 12. Remove some, or choose another base model. Nothing was sent.`);
    expect(shot('FLUX Kontext takes up to 1 reference image and this shot has 2. Remove some, or choose another base model. Nothing was sent.'))
      .toBe(`${SHOT}FLUX Kontext takes up to 1 reference image and this shot has 2. Remove some, or choose another base model. Nothing was sent.`);
    expect(shot('The base model takes up to 3 reference images and this shot has 4. Remove some, or choose another base model. Nothing was sent.'))
      .toBe(`${SHOT}the base model takes up to 3 reference images and this shot has 4. Remove some, or choose another base model. Nothing was sent.`);
  });
  it('5 aspect ratio', () => {
    expect(shot('The aspect ratio isn’t written as width:height. Use positive numbers, like 16:9.'))
      .toBe(`${SHOT}the aspect ratio isn’t written as width:height. Use positive numbers, like 16:9.`);
    expect(shot('That aspect ratio is too wide or too tall for Cinema Seedream. Choose a less extreme one.'))
      .toBe(`${SHOT}that aspect ratio is too wide or too tall for Cinema Seedream. Choose a less extreme one.`);
  });
  it('5 never reads "because" followed by a capital letter', () => {
    for (const line of ['The aspect ratio isn’t written as width:height. Use positive numbers, like 16:9.',
      'That aspect ratio is too wide or too tall for Cinema Seedream. Choose a less extreme one.']) {
      expect(shot(line)).not.toMatch(/ because \p{Lu}/u);
    }
  });
});

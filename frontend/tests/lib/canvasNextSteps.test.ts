// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compatibleSteps, currentMediaSource } from '../../src/lib/canvasNextSteps';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import type { ModelNodeDefinition, NodeData, PortDataType, PortDefinition } from '../../src/types';

const port = (id: string, dataType: PortDataType): PortDefinition => ({ id, label: id, dataType, required: false });
function definition(id: string, category: ModelNodeDefinition['category'], inputs: PortDefinition[], outputs: PortDefinition[]): ModelNodeDefinition {
  return { ...NODE_DEFINITIONS['nano-banana'], id, displayName: id, category, inputPorts: inputs, outputPorts: outputs };
}
function data(outputs: NodeData['outputs'], state: NodeData['state'] = 'complete'): NodeData {
  return { label: 'Result', definitionId: 'fixture', params: {}, state, outputs };
}

describe('currentMediaSource', () => {
  it.each(['Image', 'Video'] as const)('uses the canonical completed %s output and its actual port', (type) => {
    const def = definition('media-result', 'image-gen', [], [port('text', 'Text'), port('artwork', type)]);
    const outputs: NodeData['outputs'] = { text: { type: 'Text', value: 'caption' }, artwork: { type, value: '/outputs/current.png' } };
    expect(currentMediaSource(def, data(outputs))).toEqual({ handleId: 'artwork', dataType: type, value: '/outputs/current.png' });
  });

  it('rejects an older artifact being displayed in the batch preview', () => {
    const def = definition('image-result', 'image-gen', [], [port('image', 'Image')]);
    const live = data({ image: { type: 'Image', value: '/outputs/latest.png' } });
    expect(currentMediaSource(def, live, { image: { type: 'Image', value: '/outputs/earlier.png' } })).toBeNull();
    expect(currentMediaSource(def, live, {})).toBeNull();
  });

  it.each(['idle', 'queued', 'executing', 'error'] as const)('does not offer a next step from a %s node with old outputs', (state) => {
    const def = definition('image-result', 'image-gen', [], [port('image', 'Image')]);
    expect(currentMediaSource(def, data({ image: { type: 'Image', value: '/outputs/result.png' } }, state))).toBeNull();
  });

  it('rejects missing, empty, structured, and mismatched media output values', () => {
    const def = definition('image-result', 'image-gen', [], [port('image', 'Image')]);
    for (const outputs of [ {}, { image: { type: 'Image' as const, value: '' } },
      { image: { type: 'Image' as const, value: '  \n ' } },
      { image: { type: 'Image' as const, value: { url: '/outputs/result.png' } } },
      { image: { type: 'Video' as const, value: '/outputs/result.mp4' } } ]) {
      expect(currentMediaSource(def, data(outputs))).toBeNull();
    }
    const text = definition('text-result', 'text-gen', [], [port('text', 'Text')]);
    expect(currentMediaSource(text, data({ text: { type: 'Text', value: 'A prompt' } }))).toBeNull();
  });

  it('rejects a displayed port type that no longer matches its canonical output', () => {
    const def = definition('video-result', 'video-gen', [], [port('video', 'Video')]);
    const live = data({ video: { type: 'Video', value: '/outputs/latest.mp4' } });
    expect(currentMediaSource(def, live, { video: { type: 'Image', value: '/outputs/latest.mp4' } })).toBeNull();
  });
});

describe('compatibleSteps', () => {
  it('prefers the exact artwork port over earlier Mask or Any inputs', () => {
    const def = definition('image-editor', 'image-gen', [port('mask', 'Mask'), port('fallback', 'Any'), port('image', 'Image')], [port('image', 'Image')]);
    expect(compatibleSteps([def], 'Image', 'source')).toEqual([{ definition: def, matchingPortId: 'image', matchingPortLabel: 'image' }]);
  });

  it('returns each model once even when it has several compatible image inputs', () => {
    const def = definition('many-reference-editor', 'image-gen', [port('image', 'Image'), port('reference', 'Image'), port('mask', 'Mask')], [port('image', 'Image')]);
    const steps = compatibleSteps([def], 'Image', 'source');
    expect(steps).toHaveLength(1);
    expect(steps[0].definition.id).toBe('many-reference-editor');
    expect(steps[0].matchingPortId).toBe('image');
  });

  it('filters edit-image to image generation or transform nodes with real image inputs and outputs', () => {
    const edit = definition('edit', 'image-gen', [port('image', 'Image')], [port('image', 'Image')]);
    const transform = definition('upscale', 'transform', [port('image', 'Image')], [port('image', 'Image')]);
    const generate = definition('text-to-image', 'image-gen', [port('prompt', 'Text')], [port('image', 'Image')]);
    const utility = definition('preview', 'utility', [port('image', 'Image')], [port('image', 'Image')]);
    const masked = definition('mask-only', 'image-gen', [port('mask', 'Mask')], [port('image', 'Image')]);
    const any = definition('universal-image', 'image-gen', [port('input', 'Any')], [port('image', 'Image')]);
    const video = definition('video', 'video-gen', [port('image', 'Image')], [port('video', 'Video')]);
    expect(compatibleSteps([edit, transform, generate, utility, masked, any, video], 'Image', 'source', 'edit-image')
      .map((step) => step.definition.id)).toEqual(['edit', 'upscale']);
  });

  it('filters image-to-video to video generation models with typed image inputs and video outputs', () => {
    const video = definition('image-to-video', 'video-gen', [port('prompt', 'Text'), port('start-image', 'Image')], [port('video', 'Video')]);
    const textVideo = definition('text-to-video', 'video-gen', [port('prompt', 'Text')], [port('video', 'Video')]);
    const maskVideo = definition('mask-video', 'video-gen', [port('mask', 'Mask')], [port('video', 'Video')]);
    const anyVideo = definition('any-video', 'video-gen', [port('input', 'Any')], [port('video', 'Video')]);
    const image = definition('image', 'image-gen', [port('image', 'Image')], [port('image', 'Image')]);
    const editor = definition('video-editor', 'transform', [port('image', 'Image')], [port('video', 'Video')]);
    const noVideo = definition('no-video', 'video-gen', [port('image', 'Image')], [port('text', 'Text')]);
    const steps = compatibleSteps([video, textVideo, maskVideo, anyVideo, image, editor, noVideo], 'Image', 'source', 'image-to-video');
    expect(steps.map((step) => step.definition.id)).toEqual(['image-to-video']);
    expect(steps[0].matchingPortId).toBe('start-image');
  });

  it('keeps broader Mask/Any compatibility in All and respects the selected output type', () => {
    const mask = definition('mask', 'transform', [port('mask', 'Mask')], [port('image', 'Image')]);
    const any = definition('any', 'utility', [port('input', 'Any')], []);
    const video = definition('video-edit', 'transform', [port('video', 'Video')], [port('video', 'Video')]);
    expect(compatibleSteps([mask, any, video], 'Image', 'source').map((step) => step.definition.id)).toEqual(['mask', 'any']);
    expect(compatibleSteps([mask, any, video], 'Video', 'source').map((step) => step.definition.id)).toEqual(['any', 'video-edit']);
  });

  it('uses output ports for upstream connections and does not apply downstream intents', () => {
    const source = definition('source', 'image-gen', [], [port('fallback', 'Any'), port('image', 'Image')]);
    expect(compatibleSteps([source], 'Image', 'target')[0].matchingPortId).toBe('image');
    expect(compatibleSteps([source], 'Image', 'target', 'edit-image')).toEqual([]);
    expect(compatibleSteps([source], 'Image', 'target', 'image-to-video')).toEqual([]);
    expect(compatibleSteps([source], 'Video', 'source', 'image-to-video')).toEqual([]);
  });
});

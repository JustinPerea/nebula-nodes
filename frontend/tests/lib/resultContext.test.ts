import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData, PortValue } from '../../src/types';
import type { RunRecord, RunSnapshotEdge, RunSnapshotNode } from '../../src/lib/runHistory';
import { resultContextForNode } from '../../src/lib/resultContext';

const artwork: Record<string, PortValue> = { image: { type: 'Image', value: '/api/outputs/saved.png' } };
const snapshotNode = (id: string, definitionId: string, params: Record<string, unknown> = {},
  outputs: Record<string, unknown> = {}): RunSnapshotNode => ({ id, definitionId, params, outputs });
const edge = (source: string, sourceHandle: string, targetHandle = 'prompt', target = 'model'): RunSnapshotEdge =>
  ({ id: `${source}-${targetHandle}`, source, sourceHandle, target, targetHandle });
function node(outputs = artwork, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id: 'model', type: 'model-node', position: { x: 0, y: 0 }, data: {
    label: 'A mutable custom label', definitionId: 'nano-banana', params, state: 'complete', outputs,
    _createOrigin: { sessionId: 'session', genId: 'original', ts: 123, prompt: 'Old group prompt' },
  } };
}
function run(patch: Partial<RunRecord> = {}): RunRecord {
  return { id: 'saved', trigger: 'cluster', startedAt: 500, status: 'complete',
    snapshot: { nodes: [snapshotNode('prompt', 'text-input', { value: 'Saved logo' }),
      snapshotNode('model', 'nano-banana', { aspect_ratio: '16:9', _variant: 'nonce' })],
    edges: [edge('prompt', 'text')] }, resultOutputs: { model: artwork }, ...patch };
}

describe('resultContextForNode', () => {
  it('uses immutable saved settings and the actual prompt, not edited Canvas data or origin tags', () => {
    const context = resultContextForNode(node(artwork, { aspect_ratio: '1:1' }), [run()]);
    expect(context).toMatchObject({ modelName: 'Nano Banana', definitionId: 'nano-banana', prompt: 'Saved logo',
      timestamp: 500, runId: 'saved', provenance: 'saved-run', params: { aspect_ratio: '16:9' }, refs: [] });
    expect(context.reusableDraft).toMatchObject({ modelId: 'nano-banana', prompt: 'Saved logo',
      quantity: 1, params: { aspect_ratio: '16:9' }, refs: [], uploads: [] });
    expect(context.params).not.toHaveProperty('_variant');
  });

  it('chooses the newest matching terminal node result even when another node failed or cancellation followed', () => {
    const history = [run({ id: 'newest', startedAt: 900, status: 'cancelled' }),
      run({ id: 'running', startedAt: 1000, status: 'running' }),
      run({ id: 'older', startedAt: 400, status: 'failed' })];
    expect(resultContextForNode(node(), history).runId).toBe('newest');
    expect(history.map((record) => record.id)).toEqual(['newest', 'running', 'older']);
  });

  it('does not confuse pre-run snapshot outputs or stale tags with a saved result', () => {
    const history = [run({ snapshot: { nodes: [snapshotNode('model', 'nano-banana', {}, artwork)], edges: [] },
      resultOutputs: { model: { image: { type: 'Image', value: '/api/outputs/different.png' } } } })];
    const context = resultContextForNode(node(artwork, { model: 'gemini-3-pro-image', _variant: 'runtime' }), history);
    expect(context.provenance).toBe('unrecorded');
    expect(context.params).toEqual({ model: 'gemini-3-pro-image' });
    expect(context.modelName).toContain('Nano Banana Pro');
    expect(context.prompt).toBe('');
    expect(context.timestamp).toBeUndefined();
    expect(context.reusableDraft).toBeUndefined();
    expect(context.reuseUnavailableReason).toContain('no matching saved run');
  });

  it('matches object key ordering and loopback asset origin changes without collapsing remote URLs or text', () => {
    const savedOutputs: Record<string, PortValue> = {
      image: { type: 'Image', value: { url: 'http://localhost:8000/api/outputs/first.png', mimeType: 'image/png' } },
      text: { type: 'Text', value: 'http://localhost:8000/api/outputs/source' },
    };
    const current: Record<string, PortValue> = {
      text: { value: 'http://localhost:8000/api/outputs/source', type: 'Text' },
      image: { value: { mimeType: 'image/png', url: '/api/outputs/first.png' }, type: 'Image' },
    };
    expect(resultContextForNode(node(current), [run({ resultOutputs: { model: savedOutputs } })]).runId).toBe('saved');
    expect(resultContextForNode(node({ ...current, text: { type: 'Text', value: 'http://localhost:8001/api/outputs/source' } }),
      [run({ resultOutputs: { model: savedOutputs } })]).provenance).toBe('unrecorded');
    expect(resultContextForNode(node({ image: { type: 'Image', value: 'https://provider.test/api/outputs/first.png' } }),
      [run({ resultOutputs: { model: { image: { type: 'Image', value: '/api/outputs/first.png' } } } })]).provenance)
      .toBe('unrecorded');
  });

  it('gives distinct identities to replacement outputs and keeps earlier contexts independent', () => {
    const live = node();
    const first = resultContextForNode(live, [run()]);
    live.data.outputs = { image: { type: 'Image', value: '/api/outputs/new.png' } };
    const second = resultContextForNode(live, [run()]);
    expect(second.key).not.toBe(first.key);
    expect(first.provenance).toBe('saved-run');
    expect(second.provenance).toBe('unrecorded');
  });

  it('traces a frozen reroute and flattens typed image arrays while retaining remote query strings', () => {
    const saved = run({ snapshot: { nodes: [snapshotNode('prompt', 'text-input', { value: 'Frozen prompt' }),
      snapshotNode('wire', 'reroute'), snapshotNode('uploaded', 'image-input', { filePath: 'http://127.0.0.1:8000/api/outputs/upload.png' }),
      snapshotNode('generated', 'other-model'), snapshotNode('model', 'nano-banana', { prompt: 'Parameter fallback' })],
    edges: [edge('prompt', 'text', 'input', 'wire'), edge('wire', 'output'),
      edge('uploaded', 'image', 'images'), edge('generated', 'images', 'images')] },
    resultOutputs: { model: artwork, generated: { images: { type: 'Image',
      value: ['/api/outputs/ref-a.png', 'https://provider.test/api/outputs/ref-b.png?signature=public-fixture'] } } } });
    const context = resultContextForNode(node(), [saved]);
    expect(context.prompt).toBe('Frozen prompt');
    expect(context.refs).toEqual(['/api/outputs/upload.png', '/api/outputs/ref-a.png',
      'https://provider.test/api/outputs/ref-b.png?signature=public-fixture']);
    expect(context.reusableDraft?.refs.map((ref) => ref.filePath)).toEqual(context.refs);
  });

  it('uses frozen upstream execution outputs ahead of stale pre-run generated outputs', () => {
    const saved = run({ snapshot: { nodes: [snapshotNode('text-model', 'claude-chat', {},
      { text: { type: 'Text', value: 'Before this run' } }), snapshotNode('model', 'nano-banana')],
    edges: [edge('text-model', 'text')] },
    resultOutputs: { model: artwork, 'text-model': { text: { type: 'Text', value: 'Actually generated' } } } });
    expect(resultContextForNode(node(), [saved]).reusableDraft?.prompt).toBe('Actually generated');
  });

  it('pins Krea billing mode including legacy API billing instead of adopting a current account preference', () => {
    for (const [savedMode, expected] of [['mcp', 'mcp'], [undefined, 'api-token']] as const) {
      const saved = run({ snapshot: { nodes: [snapshotNode('model', 'krea-image-openai-gpt-image-2',
        { prompt: 'Param-only prompt', ...(savedMode ? { _kreaAuth: savedMode } : {}), _variant: 'private', _jobId: 'runtime',
          size: '1024x1024' })], edges: [] } });
      const context = resultContextForNode(node(), [saved]);
      expect(context.definitionId).toBe('krea-image-openai-gpt-image-2');
      expect(context.reusableDraft?.params).toEqual({ prompt: 'Param-only prompt', _kreaAuth: expected, size: '1024x1024' });
      expect(context.prompt).toBe('Param-only prompt');
    }
  });

  it('does not share nested params, source refs or draft objects with saved history', () => {
    const original = run();
    original.snapshot.nodes[1].params.custom = { palette: ['red', 'blue'] };
    const before = JSON.stringify(original);
    const context = resultContextForNode(node(), [original]);
    (context.reusableDraft?.params.custom as { palette: string[] }).palette[0] = 'green';
    expect(context.params.custom).toEqual({ palette: ['red', 'blue'] });
    expect(JSON.stringify(original)).toBe(before);
  });

  it('disables reuse of connected additional ports even when the model is normally Create eligible', () => {
    const saved = run({ snapshot: { nodes: [snapshotNode('prompt', 'text-input', { value: 'Animate' }),
      snapshotNode('start', 'image-input', { filePath: '/api/outputs/start.png' }),
      snapshotNode('end', 'image-input', { filePath: '/api/outputs/end.png' }), snapshotNode('model', 'kling-v2-1')],
    edges: [edge('prompt', 'text'), edge('start', 'image', 'image'), edge('end', 'image', 'tail_image')] } });
    const context = resultContextForNode(node(), [saved]);
    expect(context.provenance).toBe('saved-run');
    expect(context.refs).toEqual(['/api/outputs/start.png', '/api/outputs/end.png']);
    expect(context.inputs).toEqual([
      { label: 'Prompt', type: 'Text', value: 'Animate', resolved: true },
      { label: 'Image', type: 'Image', value: '/api/outputs/start.png', resolved: true },
      { label: 'End Frame', type: 'Image', value: '/api/outputs/end.png', resolved: true },
    ]);
    expect(context.reusableDraft).toBeUndefined();
    expect(context.reuseUnavailableReason).toContain('End Frame');
  });

  it('disables reuse of an unresolved optional input rather than silently dropping it', () => {
    const saved = run();
    saved.snapshot.edges.push(edge('missing', 'image', 'images'));
    const context = resultContextForNode(node(), [saved]);
    expect(context.inputs?.at(-1)).toEqual({ label: 'Images', type: 'Image', value: null, resolved: false });
    expect(context.refs).toEqual([]);
    expect(context.reusableDraft).toBeUndefined();
    expect(context.reuseUnavailableReason).toContain('saved image input');
  });

  it('keeps additional Text input context separate from the primary prompt', () => {
    const saved = run({ snapshot: { nodes: [snapshotNode('prompt', 'text-input', { value: 'Primary prompt' }),
      snapshotNode('previous', 'text-input', { value: 'Saved previous interaction' }),
      snapshotNode('model', 'gemini-omni-flash')],
    edges: [edge('prompt', 'text'), edge('previous', 'text', 'previous_interaction_id')] } });
    const context = resultContextForNode(node(), [saved]);
    expect(context.prompt).toBe('Primary prompt');
    expect(context.inputs?.at(-1)).toEqual({ label: 'Previous Interaction', type: 'Text',
      value: 'Saved previous interaction', resolved: true });
    expect(context.reusableDraft).toBeUndefined();
    expect(context.reuseUnavailableReason).toContain('Previous Interaction');
  });

  it('retains structured additional inputs in an independent deeply frozen metadata snapshot', () => {
    const multiPrompt = [{ prompt: 'Move left', duration: 2 }, { prompt: 'Move right', duration: 3 }];
    const saved = run({ snapshot: { nodes: [snapshotNode('prompt', 'text-input', { value: 'Animate logo' }),
      snapshotNode('segments', 'array-builder'), snapshotNode('model', 'krea-video-kling-kling-3-0')],
    edges: [edge('prompt', 'text'), edge('segments', 'array', 'multi_prompt')] },
    resultOutputs: { model: artwork, segments: { array: { type: 'Any', value: multiPrompt } } } });
    const context = resultContextForNode(node(), [saved]);
    expect(context.inputs?.at(-1)).toEqual({ label: 'Multi prompt', type: 'Any', value: multiPrompt, resolved: true });
    expect(Object.isFrozen(context.inputs)).toBe(true);
    expect(Object.isFrozen(context.inputs?.at(-1)?.value)).toBe(true);
    multiPrompt[0].prompt = 'Changed later';
    expect(context.inputs?.at(-1)?.value).toEqual([{ prompt: 'Move left', duration: 2 }, { prompt: 'Move right', duration: 3 }]);
    expect(context.reusableDraft).toBeUndefined();
  });

  it('rejects SVG and structured data as an Image draft reference', () => {
    for (const value of [{ type: 'SVG', value: '/api/outputs/logo.svg' },
      { type: 'Image', value: { image: '/api/outputs/logo.png' } }] as PortValue[]) {
      const saved = run();
      saved.snapshot.nodes.push(snapshotNode('source', 'unknown'));
      saved.snapshot.edges.push(edge('source', 'out', 'images'));
      saved.resultOutputs!.source = { out: value };
      expect(resultContextForNode(node(), [saved]).reusableDraft).toBeUndefined();
    }
  });

  it('disables Canvas-only models and missing catalog models while retaining their saved context', () => {
    for (const definitionId of ['worldlabs-environment', 'removed-provider-model']) {
      const saved = run({ snapshot: { nodes: [snapshotNode('model', definitionId, { prompt: 'Saved context' })], edges: [] } });
      const context = resultContextForNode(node(), [saved]);
      expect(context.provenance).toBe('saved-run');
      expect(context.prompt).toBe('Saved context');
      expect(context.reusableDraft).toBeUndefined();
      expect(context.reuseUnavailableReason).toBeTruthy();
    }
  });

  it('does not infer a specific invocation from a multi-item iterator batch', () => {
    const saved = run({ batchOutputs: { model: [artwork, artwork] } });
    expect(resultContextForNode(node(), [saved]).reuseUnavailableReason).toContain('batch');
    expect(resultContextForNode(node(), [saved]).reusableDraft).toBeUndefined();
  });

  it('handles legacy metadata-only entries and empty output nodes without manufacturing provenance', () => {
    const metadataOnly = { id: 'legacy', status: 'complete', startedAt: 10 } as RunRecord;
    expect(resultContextForNode(node(), [metadataOnly]).provenance).toBe('unrecorded');
    expect(resultContextForNode(node({}), [run({ resultOutputs: { model: {} } })]).provenance).toBe('unrecorded');
  });
});

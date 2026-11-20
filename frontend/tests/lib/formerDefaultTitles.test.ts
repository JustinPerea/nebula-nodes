/**
 * A node saved before the copy sweep carries a Title Case default label
 * ("Video Edit"). It is still the default title, not a name the person chose. The table is pinned to the backend's through
 * contracts/fixtures/former-default-titles.json (backend/tests/test_former_default_titles.py).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { FORMER_DEFAULT_TITLES, isFormerDefaultTitle, withCurrentDefaultLabels } from '../../src/lib/formerDefaultTitles';
import { useGraphStore } from '../../src/store/graphStore';
import { isDefaultTitle, nodeTitle, canvasTitle } from '../../src/lib/directRoute';

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../../../contracts/fixtures/former-default-titles.json'), 'utf8')).titles as Record<string, string>;

describe('former default titles', () => {
  it('the table equals the shared fixture the backend is pinned to', () => {
    expect(FORMER_DEFAULT_TITLES).toEqual(FIXTURE);
  });

  it.each(Object.entries(FIXTURE))('%s: "%s" is the default title, not a rename', (id, old) => {
    const definition = NODE_DEFINITIONS[id];
    expect(old).not.toBe(definition.displayName);
    expect(isFormerDefaultTitle(id, old)).toBe(true);
    expect(isDefaultTitle(definition, old)).toBe(true);
    expect(nodeTitle(definition, old)).toBe(canvasTitle(definition));
    expect(isDefaultTitle(definition, 'My own name')).toBe(false);
  });

  it('a node labelled "Video Edit" is not reported as renamed', () => {
    expect(isDefaultTitle(NODE_DEFINITIONS['video-edit'], 'Video Edit')).toBe(true);
  });

  it("another node's old name is still a name", () => {
    expect(isDefaultTitle(NODE_DEFINITIONS['video-edit'], 'Camera Rig')).toBe(false);
    expect(isFormerDefaultTitle(undefined, 'Video Edit')).toBe(false);
    expect(isFormerDefaultTitle('video-edit', '')).toBe(false);
  });
});

// Design: a saved canvas shows the new default name where it holds the old default, and keeps a name the person changed.
describe('a loaded canvas takes the new default name', () => {
  const node = (id: string, definitionId: string, label: string) => ({
    id, type: 'model', position: { x: 0, y: 0 }, data: { definitionId, label, params: {} },
  }) as never;

  it('maps "Remotion Composition" to "Remotion composition", leaves "My comp", and leaves another definition’s "Video Edit"', () => {
    const [mapped, kept, other] = withCurrentDefaultLabels(
      [node('a', 'remotion-node', 'Remotion Composition'), node('b', 'remotion-node', 'My comp'), node('c', 'camera-rig', 'Video Edit')],
      (id) => NODE_DEFINITIONS[id]?.displayName,
    ) as unknown as Array<{ data: { label: string } }>;
    expect(mapped.data.label).toBe('Remotion composition');
    expect(kept.data.label).toBe('My comp');
    expect(other.data.label).toBe('Video Edit');
  });

  it.each(Object.entries(FIXTURE))('loadGraph and loadProjectGraph map %s "%s" to the definition name', (id, old) => {
    useGraphStore.getState().loadGraph([node('n1', id, old), node('n2', id, 'Mine')], []);
    expect(useGraphStore.getState().nodes.map((n) => n.data.label)).toEqual([NODE_DEFINITIONS[id].displayName, 'Mine']);
    useGraphStore.getState().loadProjectGraph([node('n1', id, old), node('n2', 'video-edit', 'Camera Rig')], [], []);
    expect(useGraphStore.getState().nodes.map((n) => n.data.label)).toEqual([NODE_DEFINITIONS[id].displayName, 'Camera Rig']);
  });
});

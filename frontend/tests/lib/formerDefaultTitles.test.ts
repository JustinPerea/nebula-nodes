/**
 * A node saved before the copy sweep carries a Title Case default label
 * ("Video Edit"). It is still the default title, not a name the person chose
 * (final review LOW-4). The table is pinned to the backend's through
 * contracts/fixtures/former-default-titles.json (backend/tests/test_former_default_titles.py).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { FORMER_DEFAULT_TITLES, isFormerDefaultTitle } from '../../src/lib/formerDefaultTitles';
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

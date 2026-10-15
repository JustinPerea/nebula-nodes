import { describe, expect, it } from 'vitest';
import shared from '../../../backend/tests/fixtures/maker_size_cases.json';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { definitionSnap, definitionStartShapeNote, nearestChoice, sizeNote } from '../../src/lib/makerSizes';

type SizeCase = { nodeId: string; width: number; height: number; value: string; note: string | null };
type StartShapeCase = { nodeId: string; params: Record<string, unknown>; wired: string[]; note: string | null };

describe('maker sizes (cases shared with backend services/maker_sizes.py)', () => {
  for (const testCase of (shared as { cases: SizeCase[] }).cases) {
    it(`${testCase.nodeId} ${testCase.width}x${testCase.height}`, () => {
      const snap = definitionSnap(NODE_DEFINITIONS[testCase.nodeId], { width: testCase.width, height: testCase.height });
      expect(snap?.value).toBe(testCase.value);
      expect(sizeNote(snap)).toBe(testCase.note);
    });
  }

  it('reads the lists from directRoute.snap on exactly the nodes the backend snaps', () => {
    const snapped = Object.values(NODE_DEFINITIONS).filter((definition) => definition.directRoute?.snap).map((d) => d.id).sort();
    expect(snapped).toEqual([...new Set((shared as { cases: SizeCase[] }).cases.map((c) => c.nodeId))].sort());
    expect(NODE_DEFINITIONS['krea-image-ideogram-ideogram-3'].directRoute?.snap?.choices).toHaveLength(69);
  });

  it('keeps the shape, then the nearest pixel count', () => {
    const ratios = NODE_DEFINITIONS['krea-image-runway-gen-4-image'].directRoute!.snap!.choices;
    expect(nearestChoice(1024, 1024, ratios, ':')).toBe('1024:1024');
    expect(nearestChoice(700, 700, ratios, ':')).toBe('720:720');
  });

  it('uses Krea defaults when no size is saved, and skips unusable sizes', () => {
    const ideogram3 = NODE_DEFINITIONS['krea-image-ideogram-ideogram-3'];
    expect(definitionSnap(ideogram3, {})?.value).toBe('1024x1024');
    expect(sizeNote(definitionSnap(ideogram3, {}))).toBeNull();
    expect(definitionSnap(ideogram3, { width: 'wide', height: 1024 })).toBeNull();
    expect(definitionSnap(NODE_DEFINITIONS['krea-image-google-nano-banana-pro'], {})).toBeNull();
  });

  for (const testCase of (shared as unknown as { startShapeCases: StartShapeCase[] }).startShapeCases) {
    it(`${testCase.nodeId} start shape ${JSON.stringify(testCase.params)} wired ${testCase.wired.join(',')}`, () => {
      expect(definitionStartShapeNote(NODE_DEFINITIONS[testCase.nodeId], testCase.params, testCase.wired)).toBe(testCase.note);
    });
  }
});

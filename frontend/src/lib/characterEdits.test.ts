import { describe, expect, it } from 'vitest';
import type { Character } from '../types';
import { changedFields, conflictNote, editorLabel, rebaseCharacterDraft, type CheckedCharacterDraft } from './characterEdits';

const saved = (patch: Partial<Character> = {}): Character => ({
  id: 'c1', name: 'Nari', version: 1, subjectType: 'human', referenceViews: ['/a', '/b', '/c'],
  frozenTraitString: 'silver hair', seed: 1, consistencyStrength: 0.8, thumbnail: '/a', createdAt: '', updatedAt: '',
  ...patch,
});
const fields = (c: Character) => ({ name: c.name, subjectType: c.subjectType, referenceViews: c.referenceViews,
  frozenTraitString: c.frozenTraitString, seed: c.seed, consistencyStrength: c.consistencyStrength });
const drafted = (c: Character, patch: Partial<CheckedCharacterDraft> = {}): CheckedCharacterDraft =>
  ({ ...fields(c), base: fields(c), version: c.version, ...patch });

describe('characterEdits', () => {
  it('sends only what the person changed, the name trimmed; nothing when they changed it back', () => {
    const draft = drafted(saved(), { name: '  Nari Vale ', seed: 4 });
    expect(changedFields(draft)).toEqual({ name: 'Nari Vale', seed: 4 });
    expect(changedFields(drafted(saved(), { name: 'Nari  ' }))).toEqual({});
  });

  it('takes every field the person left alone, keeps theirs, and names a field both changed', () => {
    const draft = drafted(saved(), { frozenTraitString: 'mine', seed: 9 });
    const { draft: next, conflicts } = rebaseCharacterDraft(draft, saved({ version: 2, frozenTraitString: 'theirs',
      name: 'Renamed', referenceViews: ['/b', '/a', '/c'] }));
    expect(next).toMatchObject({ name: 'Renamed', frozenTraitString: 'mine', seed: 9, version: 2,
      referenceViews: ['/b', '/a', '/c'] });
    expect(next.base).toMatchObject({ frozenTraitString: 'theirs', seed: 1 });
    expect(conflicts).toEqual([{ field: 'frozenTraitString', mine: 'mine', theirs: 'theirs' }]);
    // The next save sends the person's two fields.
    expect(changedFields(next)).toEqual({ frozenTraitString: 'mine', seed: 9 });
  });

  it("after a save, what it sent isn't a conflict with itself, even if typed on since", () => {
    const draft = drafted(saved(), { name: 'Nari Va' });
    const { draft: next, conflicts } = rebaseCharacterDraft({ ...draft, name: 'Nari Vale' },
      saved({ version: 2, name: 'Nari Va' }), { asSent: { name: 'Nari Va' } });
    expect(conflicts).toEqual([]);
    expect(next.name).toBe('Nari Vale');
    expect(changedFields(next)).toEqual({ name: 'Nari Vale' });
  });

  it('an edit made while a save was out, back to the value last read, is kept when the save lands', () => {
    // Review of the live Studio: the person typed "Mira" (sent), then put
    // "Nari" back before the answer came. The base still said "Nari", so the
    // rebase read the field as untouched and took the saved "Mira".
    const draft = drafted(saved());
    const { draft: next, conflicts } = rebaseCharacterDraft(draft, saved({ version: 2, name: 'Mira' }),
      { asSent: { name: 'Mira' } });
    expect(conflicts).toEqual([]);
    expect(next.name).toBe('Nari');
    expect(changedFields(next)).toEqual({ name: 'Nari' });
  });

  it('a draft kept from before there was a base keeps its edits only when dirty', () => {
    const legacy = { ...fields(saved()), name: 'Mine' } as CheckedCharacterDraft;
    expect(rebaseCharacterDraft(legacy, saved({ version: 3, name: 'Theirs' }), { dirty: true }).draft.name).toBe('Mine');
    expect(rebaseCharacterDraft(legacy, saved({ version: 3, name: 'Theirs' })).draft.name).toBe('Theirs');
  });

  it('says who changed what', () => {
    expect(editorLabel({ kind: 'agent', name: 'Claude Code' })).toBe('Claude Code');
    expect(editorLabel({ kind: 'person' })).toBe('Another tab');
    expect(editorLabel(null)).toBe('Someone else');
    expect(conflictNote([{ field: 'name', mine: 1, theirs: 2 }], 'Claude'))
      .toBe('Claude also changed the name while you were editing it. Yours is kept.');
    expect(conflictNote([{ field: 'name', mine: 1, theirs: 2 }, { field: 'seed', mine: 1, theirs: 2 },
      { field: 'frozenTraitString', mine: 1, theirs: 2 }], 'Another tab'))
      .toBe('Another tab also changed the name, the seed and the frozen trait string while you were editing them. '
        + 'Yours are kept.');
  });
});

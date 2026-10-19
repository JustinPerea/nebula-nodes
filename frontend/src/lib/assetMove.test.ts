import { describe, expect, it } from 'vitest';
import { moveChoices } from './assetMove';
import { NO_PROJECT_OPEN } from './currentProject';

const open = { id: 'pB', name: 'Shoot B' };

describe('moveChoices', () => {
  it('a Global asset can move into the open project', () => {
    expect(moveChoices(null, open)).toEqual([
      { id: 'project', label: 'Move to Shoot B', target: 'pB', disabled: false }]);
  });
  it('one in the open project can move to Global', () => {
    expect(moveChoices('pB', open)).toEqual([{ id: 'global', label: 'Move to Global', target: null, disabled: false }]);
  });
  it("another project's can go either way", () => {
    expect(moveChoices('pA', open).map((choice) => [choice.label, choice.target])).toEqual([
      ['Move to Global', null], ['Move to Shoot B', 'pB']]);
  });
  it('with no project open, only the project choice is off, and says why', () => {
    expect(moveChoices(undefined, null)).toEqual([
      { id: 'project', label: 'Move to a project', target: null, disabled: true, reason: NO_PROJECT_OPEN }]);
    expect(moveChoices('pA', null).map((choice) => choice.disabled)).toEqual([false, true]);
  });
});

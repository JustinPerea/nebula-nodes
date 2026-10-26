// Nebula says connected, never wired (GM - Design, 2026-10-25). The node
// descriptions a person reads in the library and an agent reads in
// describe_node: the TypeSafe Jev gates name their ports in curly quotes, and
// no description says wired.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CharacterTestPanel } from '../src/components/character-studio/CharacterTestPanel';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { ROW_NAMES } from '../src/lib/savePausedCopy';

const WIRED = /\b(wired|wiring|unwired)\b/i;

describe('node descriptions say connected', () => {
  it('names the Jev gates’ ports in quotes', () => {
    expect(NODE_DEFINITIONS['jev-decide'].description).toContain(
      'Also a gate: whatever is connected to “Through” comes out of “On Pass” or “On Fail”',
    );
    expect(NODE_DEFINITIONS['jev-box'].description).toContain(
      'no crop, and the nodes connected to “Crop”, “Mask” or “Annotated” are skipped.',
    );
  });

  it('never says wired', () => {
    const wired = Object.values(NODE_DEFINITIONS)
      .filter((definition) => WIRED.test(definition.description ?? ''))
      .map((definition) => definition.id);
    expect(wired).toEqual([]);
  });
});

// Second pass (GM - Design's ruling): the verb is "connect" and the noun
// "connection(s)" in everything a person reads.
const WIRE = /\b(wire|wires|wired|wiring|unwired)\b/i;

describe('the canvas says connect and connection', () => {
  it('no input placeholder says wire', () => {
    const placeholders = Object.values(NODE_DEFINITIONS).flatMap((definition) =>
      (definition.params ?? []).map((param) => ({ id: `${definition.id}.${param.key}`, text: param.placeholder ?? '' })));
    expect(placeholders.filter((row) => WIRE.test(row.text)).map((row) => row.id)).toEqual([]);
    expect(placeholders.filter((row) => row.text === 'Or connect a style / moodboard')).not.toEqual([]);
    expect(placeholders.filter((row) => row.text === 'Or connect a Krea 3D job')).not.toEqual([]);
  });

  it('project size names the connections row', () => {
    expect(ROW_NAMES.wires).toBe('Connections');
  });

  it('the Character test panel says connect it', () => {
    render(<CharacterTestPanel characterId={null} draft={{} as never} thumbnail="" canTest={false} />);
    expect(screen.getByText(/Drop this Character on the canvas, connect it to a base-edit or Cinema\s+Scene node/))
      .toBeTruthy();
  });
});

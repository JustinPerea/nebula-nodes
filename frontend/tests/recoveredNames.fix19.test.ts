/**
 * Round 19 of PR #199 (GM r27 2; the rule is GM r29 2's since round 20). The
 * tab's names (lib/recoveredNames: the fallback a recovered copy shows when
 * Nebula's answer had no name) follow the backend's rule; both sides read
 * the same cases (backend/tests/data/copy_name_cases.json), with the source
 * and the cases' taken names in the list, as the backend's test does.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUT_SPACES, NAME_LIMIT, duplicateName, recoveredCanvasName, recoveredCopyFallbackName } from '../src/lib/recoveredNames';

interface NameCase { source: string; family: 'copy' | 'recovered' | 'canvas'; taken: string[]; expect: string }
const CASES = JSON.parse(readFileSync(resolve(__dirname, '../../backend/tests/data/copy_name_cases.json'), 'utf8')) as NameCase[];

const made = ({ source, family, taken }: NameCase) => {
  const names = source ? [source, ...taken] : taken;
  if (family === 'copy') return duplicateName(source, names);
  if (family === 'recovered') return recoveredCopyFallbackName(source, names);
  return recoveredCanvasName(names);
};

describe('GM r27 2: the tab names copies as Nebula does (the shared cases)', () => {
  it('reads every case', () => {
    expect(CASES.length).toBeGreaterThan(30);
  });

  it.each(CASES.map((c) => [`${c.family}: “${c.source}” with ${c.taken.length} taken`, c] as const))('%s', (_, c) => {
    const got = made(c);
    expect(got).toBe(c.expect);
    // Nebula's word with its space is never doubled; "Recovered\u2028X" is
    // another name, and gets it (the shared cases' unicode rows).
    if (c.source === 'Recovered' || c.source.startsWith('Recovered ')) {
      expect(got.startsWith(`Recovered ${c.source}`)).toBe(false);
    }
    expect(got).not.toContain('copy copy');
  });
});

describe('the kept Save’s fallback', () => {
  it('the kept Save passes the tab’s names in use (the list and Recently deleted)', () => {
    const src = readFileSync(resolve(__dirname, '../src/store/projectStore.ts'), 'utf8');
    expect(src).toContain('recoveredCopyFallbackName(kept.sourceName, namesInUse())');
    expect(src).toMatch(/\[\.\.\.projects\.map\(\(project\) => project\.name\), \.\.\.trash\.map\(\(entry\) => entry\.name\)\]/);
  });
});

describe('review 18 LOW-1 and LOW-2: the cut agrees with the backend on every character', () => {
  const python = readFileSync(resolve(__dirname, '../../backend/services/project_store.py'), 'utf8');
  it('the same spaces go at a cut (CUT_SPACES), and the same limit', () => {
    const literal = /^CUT_SPACES = "([^"]+)"$/m.exec(python)![1];
    const theirs = literal.split('\\u').filter(Boolean).map((hex) => String.fromCodePoint(parseInt(hex, 16)));
    expect([...CUT_SPACES].sort()).toEqual(theirs.sort());
    expect(Number(/^NAME_LIMIT = (\d+)$/m.exec(python)![1])).toBe(NAME_LIMIT);
  });

  it('each of them goes at the end of a cut stem; any other character stays', () => {
    for (const space of CUT_SPACES) {
      const name = duplicateName(`${'a'.repeat(114)}${space}${space}bbbbbb`);
      expect(name).toBe(`${'a'.repeat(114)} copy`);
    }
    expect(duplicateName(`${'a'.repeat(114)}\u200bbbbbbb`)).toBe(`${'a'.repeat(114)}\u200b copy`);
  });
});

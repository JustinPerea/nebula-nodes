/**
 * Round 19 of PR #199, GM r27 2: copy names number only after "copy". The
 * tab's names (lib/recoveredNames: the fallback a recovered copy shows when
 * Nebula's answer had no name) follow the backend's rule; both sides read
 * the same cases (backend/tests/data/copy_name_cases.json), with the source
 * and the cases' taken names in the list, as the backend's test does.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { duplicateName, recoveredCanvasName, recoveredCopyFallbackName, recoveredSourceName } from '../src/lib/recoveredNames';

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
    expect(CASES.filter((c) => c.family === 'recovered' && c.source === 'Shot 7').map((c) => c.expect).slice(0, 3))
      .toEqual(['Recovered Shot 7 copy', 'Recovered Shot 7 copy 2', 'Recovered Shot 7 copy 3']);
  });

  it.each(CASES.map((c) => [`${c.family}: “${c.source}” with ${c.taken.length} taken`, c] as const))('%s', (_, c) => {
    const got = made(c);
    expect(got).toBe(c.expect);
    expect(got.startsWith('Recovered Recovered')).toBe(false);
    expect(got).not.toContain('copy copy');
  });
});

describe('the fallback with nothing taken, and the source it names', () => {
  it('“Shot 7” is recovered as “Recovered Shot 7 copy”; “Recovered Alpha copy 2” as “… copy 3”', () => {
    expect(recoveredCopyFallbackName('Shot 7')).toBe('Recovered Shot 7 copy');
    expect(recoveredCopyFallbackName('Recovered Alpha copy 2')).toBe('Recovered Alpha copy 3');
    expect(recoveredCopyFallbackName('Shot 7 (recovered)')).toBe('Recovered Shot 7 copy');
    // “1” and “01” are never Nebula’s numbers (it starts at 2): they are the name’s own.
    expect(recoveredCopyFallbackName('Recovered Delta 1')).toBe('Recovered Delta 1 copy');
    expect(recoveredCopyFallbackName('Recovered Delta 01')).toBe('Recovered Delta 01 copy');
  });

  it('“Recovered Shot 7 copy” and “… copy 2” were made from “Shot 7”', () => {
    expect(recoveredSourceName('Recovered Shot 7 copy')).toBe('Shot 7');
    expect(recoveredSourceName('Recovered Shot 7 copy 2')).toBe('Shot 7');
    expect(recoveredSourceName('Recovered Delta 3')).toBe('Delta');
  });

  it('the kept Save passes the tab’s names in use (the list and Recently deleted)', () => {
    const src = readFileSync(resolve(__dirname, '../src/store/projectStore.ts'), 'utf8');
    expect(src).toContain('recoveredCopyFallbackName(kept.sourceName, namesInUse())');
    expect(src).toMatch(/\[\.\.\.projects\.map\(\(project\) => project\.name\), \.\.\.trash\.map\(\(entry\) => entry\.name\)\]/);
  });
});

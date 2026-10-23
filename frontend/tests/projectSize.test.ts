/**
 * Q118 (Justin, 2026-10-23, option a): "A project over 16 MiB still can't be
 * saved, so the canvas says so, and you remove what you don't need until it
 * saves."
 *
 * One measure: "project size" is exactly the bytes the backend's save check
 * counts (json.dumps(snapshot, allow_nan=False, ensure_ascii=False), UTF-8)
 * of the snapshot the canvas sends. The cases and their numbers are shared
 * with the backend's test (backend/tests/fixtures/project_size_cases.json,
 * written from plain json.dumps), so the two measures can't drift apart,
 * non-ASCII text, escapes and float spellings included.
 *
 * Display (GM writes "MB" and "16 MB"): MiB values labelled MB with one
 * decimal. Over the limit a size rounds up, so it never reads as the limit;
 * at or under it rounds down. {over} rounds up, so it is never 0.0 while
 * still over.
 */
import { describe, expect, it } from 'vitest';
import shared from '../../backend/tests/fixtures/project_size_cases.json';
import {
  PROJECT_SAVE_LIMIT_BYTES, displaySize, jsonBytes, overBy, projectSizeBreakdown, projectSizeBytes, rowSize,
} from '../src/lib/projectSize';

const MIB = 1024 * 1024;

describe('the measure is the backend save check, byte for byte', () => {
  it('has the same limit: 16 MiB', () => {
    expect(PROJECT_SAVE_LIMIT_BYTES).toBe(16 * MIB);
    expect(shared.limitBytes).toBe(PROJECT_SAVE_LIMIT_BYTES);
  });

  for (const testCase of shared.cases) {
    it(`${testCase.name}: the same size and the same rows`, () => {
      expect(projectSizeBytes(testCase.snapshot)).toBe(testCase.bytes);
      expect(jsonBytes(testCase.snapshot)).toBe(testCase.bytes);
      const { bytes, rows } = projectSizeBreakdown(testCase.snapshot);
      expect(bytes).toBe(testCase.bytes);
      expect(rows.map((row) => {
        const picked: Record<string, unknown> = { kind: row.kind };
        if (row.kind === 'node') { picked.nodeId = row.nodeId; picked.part = row.part; }
        if ('count' in row) picked.count = row.count;
        picked.bytes = row.bytes;
        return picked;
      })).toEqual(testCase.rows);
      expect(rows.reduce((sum, row) => sum + row.bytes, 0)).toBe(testCase.bytes);
    });
  }

  it("counts Python's spacing, UTF-8 and its float spelling", () => {
    // json.dumps writes ", " and ": ": {"a": [1, 2]} is 13 bytes.
    expect(jsonBytes({ a: [1, 2] })).toBe(13);
    expect(jsonBytes('é')).toBe(4);
    expect(jsonBytes('😀')).toBe(6);
    // Python writes 1e-07 where JavaScript writes 1e-7.
    expect(jsonBytes(1e-7)).toBe(5);
    expect(jsonBytes(1e21)).toBe(5);
    // Python writes floats under 1e-4 with an exponent; JavaScript doesn't until 1e-7.
    expect(jsonBytes(0.00001)).toBe(5);
    expect(jsonBytes(0.000012345)).toBe(10);
    expect(jsonBytes(-2.5e-6)).toBe(8);
    expect(jsonBytes(0.0001)).toBe(6);
    expect(jsonBytes({ 'a,b': 'c:d' })).toBe(14);
    expect(jsonBytes('a\nb\u0001')).toBe(12);
  });

  it('accepts the JSON text the caller already made, without stringifying again', () => {
    const snapshot = shared.cases[0].snapshot;
    expect(projectSizeBytes(snapshot, JSON.stringify(snapshot))).toBe(shared.cases[0].bytes);
  });
});

describe('sizes as GM writes them', () => {
  it('one decimal, MiB as "MB"; over the limit rounds up, at or under rounds down', () => {
    expect(displaySize(PROJECT_SAVE_LIMIT_BYTES)).toBe('16.0');
    expect(displaySize(PROJECT_SAVE_LIMIT_BYTES + 1)).toBe('16.1');
    expect(displaySize(Math.round(16.31 * MIB))).toBe('16.4');
    expect(displaySize(Math.round(15.99 * MIB))).toBe('15.9');
    expect(displaySize(Math.round(2.25 * MIB))).toBe('2.2');
  });

  it('{over} is never 0.0 while over, and matches the size it is taken from', () => {
    expect(overBy(PROJECT_SAVE_LIMIT_BYTES + 1)).toBe('0.1');
    expect(overBy(Math.round(16.31 * MIB))).toBe('0.4');
    expect(overBy(PROJECT_SAVE_LIMIT_BYTES + 3 * MIB)).toBe('3.0');
    expect(overBy(PROJECT_SAVE_LIMIT_BYTES)).toBe('0.0');
  });

  it('a row rounds to the nearest tenth', () => {
    expect(rowSize(Math.round(4.14 * MIB))).toBe('4.1');
    expect(rowSize(Math.round(4.16 * MIB))).toBe('4.2');
    expect(rowSize(10)).toBe('0.0');
  });

  it("a row's size is the agents' tool's for the same bytes (shared rowSizes, halves up)", () => {
    const cases = (shared as unknown as { rowSizes: Array<{ bytes: number; size: string }> }).rowSizes;
    expect(cases.length).toBeGreaterThan(5);
    for (const { bytes, size } of cases) expect(`${rowSize(bytes)} MB`).toBe(size);
  });
});

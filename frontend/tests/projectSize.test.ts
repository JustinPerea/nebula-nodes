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
  PROJECT_SAVE_LIMIT_BYTES, TOP_ROWS, displaySize, jsonBytes, listedRowCount, overBy, projectNameForFile, projectSizeBreakdown,
  projectSizeBytes, rowSize,
} from '../src/lib/projectSize';
import { smallerLine } from '../src/lib/savePausedCopy';

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

describe('which rows the panel lists', () => {
  // GM - Design (#182): "Rows under 0.1 MB: don't show them. "0.0 MB" tells
  // nobody anything. Fold them into the "{n} smaller items, {size} MB in all"
  // line, and show that line even if all the rows would be tiny."
  const rows = (...sizes: number[]) => sizes.map((bytes) => ({ kind: 'project' as const, bytes }));
  it('lists rows of 0.1 MB and up, largest first, at most ten', () => {
    expect(listedRowCount(rows(Math.ceil(MIB / 10), Math.floor(MIB / 10)))).toBe(1);
    expect(listedRowCount(rows(...Array.from({ length: 12 }, () => MIB)))).toBe(TOP_ROWS);
    expect(listedRowCount(rows(500, 20))).toBe(0);
  });
  it("is the agents' tool's count for the same rows (shared listedRows)", () => {
    const cases = (shared as unknown as { listedRows: Array<{ bytes: number[]; listed: number }> }).listedRows;
    expect(cases.length).toBeGreaterThan(2);
    for (const { bytes, listed } of cases) expect(listedRowCount(rows(...bytes))).toBe(listed);
  });
});

describe('the smaller line', () => {
  it('says its size, unless that rounds to 0.0 (GM, #182)', () => {
    expect(smallerLine(5, '1.3')).toBe('5 smaller items, 1.3 MB in all');
    expect(smallerLine(1, '0.2')).toBe('1 smaller item, 0.2 MB in all');
    expect(smallerLine(14, '0.0')).toBe('14 smaller items');
  });
});

describe("the new project's name for a file over the limit (Q120)", () => {
  it('is the file name without its graph extension', () => {
    expect(projectNameForFile('Big campaign.nebula')).toBe('Big campaign');
    expect(projectNameForFile('Big campaign.nebula.zip')).toBe('Big campaign');
    expect(projectNameForFile('export.JSON')).toBe('export');
    expect(projectNameForFile('bundle.zip')).toBe('bundle');
    expect(projectNameForFile('  spaced.nebula  ')).toBe('spaced');
    expect(projectNameForFile('notes.v2.nebula')).toBe('notes.v2');
  });

  it("fits the backend's name rule: 1 to 120 characters, no control characters", () => {
    expect(projectNameForFile(`${'a'.repeat(200)}.nebula`)).toBe('a'.repeat(120));
    expect(projectNameForFile('tab\there.nebula')).toBe('tab here');
  });

  it('is the default name when the file gives none', () => {
    expect(projectNameForFile(undefined)).toBe('Untitled project');
    expect(projectNameForFile('.nebula')).toBe('Untitled project');
    expect(projectNameForFile('   ')).toBe('Untitled project');
  });
});

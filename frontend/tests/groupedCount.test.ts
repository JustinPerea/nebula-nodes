import { describe, expect, it } from 'vitest';
import { countNoun, groupedCount } from '../src/lib/groupedCount';
import { deletedNoticeText } from '../src/lib/deleteNotice';
import { scanSummaryText } from '../src/lib/commonsFormat';

describe('counts of things are written with the locale\'s grouping', () => {
  it('groups thousands and leaves small counts alone', () => {
    expect(groupedCount(0)).toBe('0');
    expect(groupedCount(999)).toBe('999');
    expect(groupedCount(1248)).toBe('1,248');
    expect(groupedCount(3102)).toBe('3,102');
    expect(groupedCount(1234567)).toBe('1,234,567');
  });

  it('reads a value that is not a finite number as it is', () => {
    expect(groupedCount('∞')).toBe('∞');
    expect(groupedCount(Number.NaN)).toBe('NaN');
  });

  it('pairs the count with its noun, one or many', () => {
    expect(countNoun(1, 'node')).toBe('1 node');
    expect(countNoun(1248, 'node')).toBe('1,248 nodes');
    expect(countNoun(2, 'stale item')).toBe('2 stale items');
    expect(countNoun(1, 'child', 'children')).toBe('1 child');
    expect(countNoun(1500, 'child', 'children')).toBe('1,500 children');
  });

  it('is used where counts can be large: delete notices and the folder scan line', () => {
    expect(deletedNoticeText(1248)).toBe('Deleted 1,248 nodes.');
    expect(scanSummaryText({ added: 1200, changed: 3 })).toBe('1,200 added · 3 changed');
  });
});

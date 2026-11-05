import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failureCopy, failureText } from '../src/lib/errorCopy';
import { OfflineRefusal } from '../src/lib/backendConnection';

/**
 * #210 round 6t (review 12 live MEDIUM-1, GM r113 1): offline, the deleted
 * board line's Restore left an empty red alert (`<div role="alert"><span
 * class="failure-lines"><span class="failure-lines__reason"></span></span>`)
 * that stayed after reconnect. Two rules keep it from coming back:
 * - no line or alert mounts with nothing to say: every failure the Studio
 *   shows goes through its FailureLine, which renders nothing when the
 *   failure's text is empty (a write refused while offline: the banner is
 *   the reason);
 * - every button on a Studio notice line follows the offline convention
 *   (GM r90.3): aria-disabled with the offline mark, so a press only pulses
 *   the banner.
 */
const STUDIO = readFileSync(resolve(__dirname, '../src/components/moodboard-studio/MoodboardStudioView.tsx'), 'utf8');

describe('no Studio line mounts with empty text (GM r113 1)', () => {
  it('failureText is empty for a write refused while offline, and for an empty copy', () => {
    expect(failureText(failureCopy(new OfflineRefusal('POST', '/api/trash/moodboard/t1/restore')))).toBe('');
    expect(failureText({ heading: '', reason: '' })).toBe('');
    expect(failureText({ heading: ' ', reason: ' ' })).toBe('');
    expect(failureText('')).toBe('');
    expect(failureText(null)).toBe('');
    expect(failureText({ heading: "Couldn't restore the board.", reason: 'Nebula didn’t respond. Try again.' }))
      .toBe("Couldn't restore the board. Nebula didn’t respond. Try again.");
  });

  it('the Studio renders FailureLines only inside FailureLine, which renders nothing for empty text', () => {
    const uses = [...STUDIO.matchAll(/<FailureLines\b/g)].map((match) => match.index!);
    expect(uses).toHaveLength(1);
    const start = STUDIO.indexOf('function FailureLine(');
    const end = STUDIO.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(uses[0]).toBeGreaterThan(start);
    expect(uses[0]).toBeLessThan(end);
    expect(STUDIO.slice(start, end)).toMatch(/if \(!failure \|\| !failureText\(failure, retry\)\) return null;/);
  });

  it('every button on a Studio notice line is aria-disabled with the offline mark while offline (GM r90.3)', () => {
    const buttons = [...STUDIO.matchAll(/<button\b[^>]*?moodboard-studio__notice-action[\s\S]*?>/g)].map((match) => match[0]);
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const tag of buttons) {
      expect(tag, tag).toContain('aria-disabled={offline || undefined}');
      expect(tag, tag).toContain('{...offlineMark(offline)}');
    }
  });
});

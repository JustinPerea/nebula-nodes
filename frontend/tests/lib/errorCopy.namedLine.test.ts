import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RequestFailedError, headedLine, isNamedLine, oneLine } from '../../src/lib/errorCopy';
import { deleteRefusalText } from '../../src/lib/worldLabsWaiting';

/**
 * GM, PR #198 r5 item 3: "one line only, the backend's named line …. Never
 * put the generic "Couldn't delete the node." in front of it. Rule: when a
 * specific line exists, the generic one never shows as well."
 */

const NAMED = "Couldn't delete “Agent scene”. “Shot 2” is still running. Stop the run first.";

describe('the rule', () => {
  it('a named reason alone, under a generic heading or one with the same failure', () => {
    expect(isNamedLine(NAMED)).toBe(true);
    expect(isNamedLine('Stop the run first.')).toBe(false);
    expect(headedLine("Couldn't delete the node.", NAMED)).toBe(NAMED);
    expect(headedLine("Couldn't delete 2 nodes.", NAMED)).toBe(NAMED);
    expect(headedLine("Couldn't delete “Agent scene”.", NAMED)).toBe(NAMED);
    expect(oneLine({ heading: "Couldn't delete the node.", reason: NAMED })).toBe(NAMED);
  });

  it('a heading that names something the reason doesn\'t stays', () => {
    expect(headedLine("Couldn't run “Hero still”.", "Couldn't reach Krea.")).toBe("Couldn't run “Hero still”. Couldn't reach Krea.");
    expect(headedLine("Couldn't delete the node.", 'It is locked.')).toBe("Couldn't delete the node. It is locked.");
    expect(headedLine('', NAMED)).toBe(NAMED);
    expect(headedLine("Couldn't delete the node.", '')).toBe("Couldn't delete the node.");
  });

  it('a refused request\'s own message follows it', () => {
    expect(new RequestFailedError("Couldn't delete the node.", 409, { detail: NAMED }).message).toBe(NAMED);
  });

  it('the canvas\'s delete refusals', () => {
    expect(deleteRefusalText("Couldn't delete the node.", 1, [NAMED])).toBe(NAMED);
    expect(deleteRefusalText("Couldn't delete 2 nodes.", 2, [NAMED, NAMED])).toBe(NAMED);
  });
});

/** Every place that writes a heading and a reason into one line goes
 * through headedLine (oneLine, failureMessage, …), so the rule holds there.
 * These are the few that build one by hand, each for a reason of its own. */
const HAND_BUILT: Record<string, string> = {
  // headedLine itself: the one place the rule is applied.
  'lib/errorCopy.ts': '`${heading} ${reason}`',
  // GM's own World Labs lines: the reason is a fixed tail, never a named line.
  'lib/worldLabsWaiting.ts': '`${heading} ${WORLD_LABS_NEEDS_CHECK}` : `${heading} It${RECOVERY_ID_FORGET_TAIL}`',
  // The fixed fallback after a heading.
  'store/graphStore.ts': '`${heading} ${REFUSED_FALLBACK_COPY}`',
  // The Agent log's raw form (agents read the raw text).
  'store/graphStore.ts#log': '`${heading} ${err.raw}`',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) ? [path] : [];
  });
}

describe('ratchet: no new hand-built "heading reason" lines', () => {
  it('only the known ones', () => {
    const root = join(__dirname, '../../src');
    const found: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/`\$\{heading\} \$\{[^`]*`/g)) found.push(`${relative(root, file)}: ${match[0]}`);
    }
    const known = Object.values(HAND_BUILT).join('\n');
    const unknown = found.filter((entry) => !known.includes(entry.split(': ').slice(1).join(': ')));
    expect(unknown).toEqual([]);
  });
});

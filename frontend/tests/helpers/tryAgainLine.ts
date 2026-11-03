import { expect } from 'vitest';

/**
 * GM r23 on #208 (the house form, as #204's close lines): a line shown with
 * a [Try again] button ends in "Try again.", which says what the button
 * beside it does. One shared assert, for any PR's ratchet row.
 */
export const TRY_AGAIN_LINE_END = 'Try again.';

/** True when ``line`` ends in the house "Try again." (after a sentence). */
export function endsInTryAgain(line: string): boolean {
  return /(^|[.!?…]\s)Try again\.$/.test(line.trim());
}

/** Fails, naming the line, unless it ends in "Try again.". */
export function expectTryAgainLine(line: string, where = 'a line with Try again'): void {
  expect(endsInTryAgain(line), `${where}: ${JSON.stringify(line)} must end in "${TRY_AGAIN_LINE_END}"`).toBe(true);
}

/**
 * Every [Try again] button under ``root`` (by its label) and the line shown
 * with it (``lineFor``), each ending in "Try again.". Returns the lines, and
 * fails when there is no such button (a check that saw nothing).
 */
export function expectEveryTryAgainLine(root: ParentNode, lineFor: (button: HTMLButtonElement) => string | null | undefined,
  label = 'Try again'): string[] {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === label);
  expect(buttons.length, 'no Try again button to check').toBeGreaterThan(0);
  return buttons.map((button) => {
    const line = lineFor(button) ?? '';
    expectTryAgainLine(line);
    return line;
  });
}

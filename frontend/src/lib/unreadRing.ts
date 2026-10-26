/**
 * The Updates chip's unread ring is drawn in the newest unread author's colour
 * (agentNotes.css). Author colours come from agents (any #RRGGBB), so the ring
 * gets GM's floor: at least 3:1 against the header, the focus ring's bar. A
 * colour under it is drawn as a lighter tint of itself (mixed toward white),
 * never another colour. The author dots in the chip stay as they are.
 */

type RGB = [number, number, number];

/** The header as drawn: --sr-glass rgba(22, 22, 24, 0.66) over --sr-canvas #000 (tests/agentNotesRing.test.ts checks it against the tokens). */
export const HEADER_BACKDROP: RGB = [14.52, 14.52, 15.84];

const FLOOR = 3;

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (colour: RGB) => (Math.max(luminance(colour), luminance(HEADER_BACKDROP)) + 0.05)
  / (Math.min(luminance(colour), luminance(HEADER_BACKDROP)) + 0.05);

const tint = (colour: RGB, share: number): RGB => colour.map((c) => Math.round(c + (255 - c) * share)) as RGB;

export function unreadRingColor(colour: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  const rgb = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16)) as RGB;
  if (contrast(rgb) >= FLOOR) return colour;
  // The smallest step toward white that clears the floor (white clears it).
  let share = 0.01;
  while (share < 1 && contrast(tint(rgb, share)) < FLOOR) share += 0.01;
  return `#${tint(rgb, Math.min(share, 1)).map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

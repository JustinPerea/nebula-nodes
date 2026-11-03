/** What Extract from reference says when an image gives no colours, apart
 *  from the extraction itself so the Inspector can load that only when
 *  Extract is used (round 8b: the entry bundle doesn't grow).
 *
 *  When nothing comes out it says why, when it knows (GM - Design,
 *  2026-10-24): "If the two cases can't be told apart, use only the
 *  heading. Don't guess the reason." */
import { quoted } from './quoted';

/** Why an image gave no colours: the browser couldn't decode it, no pixel
 * is opaque enough to count (clear or faint alike, GM r5 on #208), or
 * something else (no 2d context, a canvas error, no pixels at all). */
export type PaletteFailure = 'decode' | 'transparent' | 'other';

/** GM's copy: a heading naming the file, then the reason on its own line for
 * the two cases Nebula can tell; the heading alone for the rest. */
const REASONS: Partial<Record<PaletteFailure, string>> = {
  decode: "Nebula can't read this image. Try a PNG or JPEG.",
  transparent: 'This image is too transparent to pull colors from.',
};

export function paletteNotice(fileName: string, reason: PaletteFailure): string {
  const heading = `Couldn't find colors in ${quoted(fileName)}.`;
  const line = REASONS[reason];
  return line ? `${heading}\n${line}` : heading;
}

/** The status line once a palette lands (GM r18 4 on #208): the real count. */
export function paletteStatus(count: number): string {
  return `Extracted ${count} ${count === 1 ? 'color' : 'colors'}.`;
}

/** When Extract can't run at all: its own code (the chunk from Nebula's
 *  server) didn't load. GM r20 on #208, neutral, the because form, beside
 *  Try again. A worker that can't load or start says nothing: the page
 *  works the palette out instead. */
export const PALETTE_CANT_RUN = 'Nebula couldn’t extract the colors because the server isn’t answering.';

/**
 * The header's wait label, full or short (GM - Design, PR #212 round 6, item 2):
 * "When the full label would cut the title to fewer than 8 characters,
 * ellipsis included, the label shortens to 'Waiting'." The accessible
 * description and the tooltip keep "Waiting for your OK".
 *
 * The decision is made from the room the title would have with the FULL label
 * beside it, measured in layout pixels (never the zoom's), against the title's
 * own text. It does not read how wide the label is now, so showing the short
 * label cannot move the answer: no feedback loop. Coming back to the full
 * label needs WAIT_HYSTERESIS_PX more room than going to the short one, so a
 * title edge sitting on the threshold (a node being resized, a name being
 * typed) does not flicker between the two.
 */
import { WAITING_FOR_OK } from './canvasProposals';

export const WAIT_SHORT_LABEL = 'Waiting';
/** The fewest characters of the title, ellipsis included, the full label may leave. */
export const WAIT_MIN_TITLE_CHARS = 8;
/** Extra room the full label needs to return once the short one is shown. */
export const WAIT_HYSTERESIS_PX = 6;

export type TextWidth = (text: string) => number;

/**
 * How many characters of `text` show in `room` px, the ellipsis counted, when
 * the title truncates; Infinity when all of it fits.
 */
export function titleCharsShown(text: string, room: number, width: TextWidth): number {
  if (width(text) <= room) return Infinity;
  const chars = Array.from(text);
  for (let keep = chars.length - 1; keep >= 0; keep--) {
    if (width(`${chars.slice(0, keep).join('')}…`) <= room) return keep + 1;
  }
  return 0;
}

/** Whether the label shortens: the full one would leave the title fewer than WAIT_MIN_TITLE_CHARS. */
export function waitLabelIsShort(text: string, roomWithFullLabel: number, width: TextWidth, wasShort: boolean): boolean {
  const room = wasShort ? roomWithFullLabel - WAIT_HYSTERESIS_PX : roomWithFullLabel;
  return titleCharsShown(text, room, width) < WAIT_MIN_TITLE_CHARS;
}

let canvas: CanvasRenderingContext2D | null | undefined;
function context(): CanvasRenderingContext2D | null {
  if (canvas === undefined) {
    try { canvas = document.createElement('canvas').getContext('2d'); } catch { canvas = null; }
  }
  return canvas ?? null;
}

/** Text width in CSS px in the font, size, weight and letter spacing of `el`. */
function widthIn(el: HTMLElement): TextWidth | null {
  const ctx = context();
  if (!ctx) return null;
  const style = getComputedStyle(el);
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const spacing = Number.parseFloat(style.letterSpacing) || 0;
  return (text) => ctx.measureText(text).width + spacing * Array.from(text).length;
}

export const WAIT_TITLE_SELECTOR = ':scope > .model-node__label, :scope > .cinema-scene-node__name';

/** What the decision needs, read from the header the swap sits in. */
export interface WaitHeaderMeasure {
  text: string;
  roomWithFullLabel: number;
  width: TextWidth;
}

/**
 * Reads the title's text and the room it would have beside the FULL label.
 * Positions come from the rects, divided by the zoom (the rect-to-layout
 * ratio of the header), so the answer is the same at every zoom. Null when
 * the header has no title this can measure (the card keeps the full label).
 */
export function measureWaitHeader(swap: HTMLElement): WaitHeaderMeasure | null {
  const header = swap.parentElement;
  const title = header?.querySelector<HTMLElement>(WAIT_TITLE_SELECTOR);
  const full = swap.querySelector<HTMLElement>('.node-wait-swap__full');
  if (!header || !title || !full) return null;
  const zoom = header.getBoundingClientRect().width / header.offsetWidth;
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  const titleWidth = widthIn(title);
  const labelWidth = widthIn(full);
  if (!titleWidth || !labelWidth) return null;
  const layout = (el: Element) => el.getBoundingClientRect().width / zoom;
  const gap = Number.parseFloat(getComputedStyle(header).columnGap) || 0;
  // What sits between the title and the swap (a badge, a batch tag) keeps its width.
  let between = 0;
  let steps = 1;
  for (let el = title.nextElementSibling; el && el !== swap; el = el.nextElementSibling) {
    between += layout(el);
    steps += 1;
  }
  const rest = swap.querySelector<HTMLElement>('.node-wait-swap__rest');
  const cellFull = Math.max(rest ? layout(rest) : 0, labelWidth(WAITING_FOR_OK));
  const cellNow = layout(swap);
  const titleToSwap = (swap.getBoundingClientRect().left - title.getBoundingClientRect().left) / zoom;
  const text = title instanceof HTMLInputElement ? title.value : (title.textContent ?? '');
  return { text, roomWithFullLabel: titleToSwap - gap * steps - between - (cellFull - cellNow), width: titleWidth };
}

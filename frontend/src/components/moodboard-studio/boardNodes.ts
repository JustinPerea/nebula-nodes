import { createContext } from 'react';
import type { Node } from '@xyflow/react';
import type { MoodboardImage, MoodboardPlacement } from '../../types';
import { isSetAside } from './steering';

/** What a card on the Board view draws (BoardCardNode). */
export interface BoardCardData extends Record<string, unknown> {
  imageId: string;
  url: string;
  /** Its board number: its place in `images` + 1 (plan C7). */
  number: number;
  setAside: boolean;
}

export type BoardCardNodeType = Node<BoardCardData, 'card'>;

/** Wider than this on screen (css px), a card shows the file itself; narrower, the 512 px thumbnail. */
export const BOARD_THUMB_MAX_CSS_PX = 480;

/** The narrowest card width (board px) that is wider than
 *  `BOARD_THUMB_MAX_CSS_PX` on screen at `zoom`, among the board's card
 *  `widths` (ascending); Infinity when none is. It changes only when a zoom
 *  crosses one of those widths, so the cards (which read it from
 *  `BoardWideContext`) re-render only then, not on every zoom frame. */
export function wideFrom(widths: readonly number[], zoom: number): number {
  for (const width of widths) if (width * zoom > BOARD_THUMB_MAX_CSS_PX) return width;
  return Number.POSITIVE_INFINITY;
}

/** `wideFrom` for the board as it is now: a card at least this wide shows its file. */
export const BoardWideContext = createContext<number>(Number.POSITIVE_INFINITY);

/** A card the server hasn't placed yet (an image dropped a moment ago): drawn, never moved. */
export const isProvisionalCard = (placementId: string) => placementId.startsWith('new-');

/**
 * The Board view's React Flow nodes: one per card (placement), at the
 * position and size the server saved, in board order, so React Flow draws
 * later numbers on top as the List does. `moving` holds positions of cards
 * being dragged or nudged with the arrow keys, until the move is sent.
 *
 * Built through a cache so a card that didn't change keeps its node object:
 * React Flow then skips it (its `checkEquality`), and a drag over a
 * 300-card board re-renders only the cards that move. The size is given as
 * `measured` too, so React Flow never waits to measure a card before
 * fitting the view or culling what is off screen.
 */
export function createBoardNodeBuilder() {
  // Per card: what its node was built from. Compared field by field (no
  // string keys): this runs on every pointer move of a drag.
  interface Built { card: MoodboardPlacement; image: MoodboardImage; index: number; x: number; y: number;
    selected: boolean; node: BoardCardNodeType }
  let cache = new Map<string, Built>();
  return function build(images: MoodboardImage[], selected: ReadonlySet<string>,
    moving: Readonly<Record<string, { x: number; y: number }>>): BoardCardNodeType[] {
    const next = new Map<string, Built>();
    const nodes: BoardCardNodeType[] = [];
    images.forEach((image, index) => {
      for (const card of image.placements ?? []) {
        const at = moving[card.id];
        const x = at ? at.x : card.x;
        const y = at ? at.y : card.y;
        const isSelected = selected.has(card.id);
        const cached = cache.get(card.id);
        let node: BoardCardNodeType;
        if (cached && cached.card === card && cached.image === image && cached.index === index && cached.x === x
          && cached.y === y && cached.selected === isSelected) {
          node = cached.node;
        } else {
          const setAside = isSetAside(image);
          node = {
            id: card.id,
            type: 'card',
            position: { x, y },
            width: card.w,
            height: card.h,
            measured: { width: card.w, height: card.h },
            selected: isSelected,
            draggable: !isProvisionalCard(card.id),
            ariaLabel: `Reference #${index + 1}${setAside ? ', set aside' : ''}`,
            data: { imageId: image.id, url: image.url, number: index + 1, setAside },
          };
        }
        next.set(card.id, { card, image, index, x, y, selected: isSelected, node });
        nodes.push(node);
      }
    });
    cache = next;
    return nodes;
  };
}

/** The image ids of the selected cards, in board order, each once. */
export function selectedImageIds(images: MoodboardImage[], selected: readonly string[]): string[] {
  if (selected.length === 0) return [];
  const cards = new Set(selected);
  return images.filter((image) => image.placements?.some((card) => cards.has(card.id))).map((image) => image.id);
}

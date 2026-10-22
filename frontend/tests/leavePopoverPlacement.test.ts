import { describe, expect, it } from 'vitest';
import { placeOutside } from '../src/components/asset-move/anchoredPopover';

/**
 * GM (commons-leave): asked from the Updates corner, the leave popover opens
 * to the left of the Updates list or card, so the list stays readable while
 * the person decides; with no room there it falls back to the usual place.
 */
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const view = { width: 1280, height: 800 };
const panel = { width: 280, height: 120 };

describe('placeOutside', () => {
  it('puts the panel left of the container, level with the clicked control', () => {
    const list = rect(860, 56, 400, 600);
    const button = rect(1100, 300, 120, 28);
    expect(placeOutside(button, list, panel, view)).toEqual({ left: 860 - 6 - 280, top: 300 });
  });

  it('keeps it on screen vertically', () => {
    const list = rect(860, 56, 400, 740);
    const button = rect(1100, 760, 120, 28);
    expect(placeOutside(button, list, panel, view)).toEqual({ left: 574, top: 800 - 8 - 120 });
  });

  it('gives up (null) when the left side has no room', () => {
    const list = rect(200, 56, 400, 600);
    expect(placeOutside(rect(300, 300, 120, 28), list, panel, view)).toBeNull();
  });
});

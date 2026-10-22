import { useRef, useState } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAnchoredPopover } from '../src/components/asset-move/anchoredPopover';

/**
 * Review of commons-leave round 2: a failure landing in an open leave popover
 * makes it taller and wider, so it is placed again for that opening (its
 * `revision`), not left where its old size put it (the gap to the Updates
 * list shrank from 6 to 2 px at 1280).
 */
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

const sizes = { panel: { width: 316, height: 78 } };
const placed: Array<{ left: number; top: number } | null> = [];

function Probe({ revision }: { revision: number }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const position = useAnchoredPopover(anchor, panel, () => {}, 'auto', 280, list, revision);
  placed.push(position);
  return (
    <div>
      <div ref={setList} data-testid="list" />
      <button ref={anchor} type="button">Show</button>
      <div ref={panel} />
    </div>
  );
}

afterEach(() => { cleanup(); placed.length = 0; });

describe('useAnchoredPopover', () => {
  it('places the panel again when its revision changes, at its new size', () => {
    const proto = HTMLElement.prototype;
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (this.tagName === 'BUTTON') return rect(1000, 200, 120, 28);
      if (this.dataset.testid === 'list') return rect(894.8, 56, 380, 600);
      return rect(0, 0, sizes.panel.width, sizes.panel.height);
    };
    try {
      const { rerender } = render(<Probe revision={1} />);
      rerender(<Probe revision={1} />);
      const first = placed.at(-1);
      expect(first).toEqual({ left: 894.8 - 6 - 316, top: 200 });
      sizes.panel = { width: 320, height: 112 };
      rerender(<Probe revision={2} />);
      rerender(<Probe revision={2} />);
      expect(placed.at(-1)).toEqual({ left: 894.8 - 6 - 320, top: 200 });
    } finally {
      proto.getBoundingClientRect = original;
      sizes.panel = { width: 316, height: 78 };
    }
  });
});

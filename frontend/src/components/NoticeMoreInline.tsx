import { useState } from 'react';
import { useNoticeMore, toggleNoticeMore } from '../lib/noticeMore';
import { MORE_SLOT_ATTR, SHOW_LESS, moreLabel } from '../lib/noticeStackPlace';

/**
 * GM - Design, PR #216 r8: whenever an Undo notice and the fold both show,
 * the fold rides in the Undo notice's own row: "Moved “Hero shot” · Undo ·
 * 3 more". "3 more" is a trailing text button that opens the stack (the
 * region's own toggle); opened, it reads "Show less". The notice puts this
 * right after its Undo, so the keyboard goes name, Undo, "3 more". Its mark
 * tells the region this notice can carry it (lib/noticeStackPlace.ts).
 */
export function NoticeMoreInline() {
  const [mark, setMark] = useState<HTMLSpanElement | null>(null);
  const { host, count, expanded } = useNoticeMore();
  const mine = host !== null && mark !== null && host.contains(mark);
  return (
    <>
      <span ref={setMark} hidden {...{ [MORE_SLOT_ATTR]: '' }} />
      {mine && (
        <>
          <span className="canvas-undo-notice__more-dot" aria-hidden="true">·</span>
          <button
            type="button"
            className="canvas-undo-notice__more-button"
            aria-expanded={expanded}
            aria-label={expanded ? undefined : moreLabel(count)}
            onClick={toggleNoticeMore}
          >
            {expanded ? SHOW_LESS : `${count} more`}
          </button>
        </>
      )}
    </>
  );
}

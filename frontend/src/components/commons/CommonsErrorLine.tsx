import { useLayoutEffect, useRef } from 'react';
import { isBecauseLine } from '../../lib/notConnectedLine';
import { isLoadLine, retryStem } from '../../lib/errorCopy';
import { LineText } from '../LineText';
import { FOCUS_LINE_ATTR } from '../../lib/lineAttrs';
import { useOfflineFirstBecause } from '../../hooks/useOfflineFirstBecause';
import { useBackendOffline } from '../../lib/useBackendOffline';

/** Round 18f (GM r35 4): a load line's "Try again". Once a read succeeds its line goes, and focus
 * on it goes to the page's heading "Commons" rather than dropping to the page (GM r19 2's rule).
 * Round 18h (GM r38 3b, review 16 NIT-1): when the read fails again for another reason, the new
 * line (the page row keys its lines by their words, so it is a new element) has its own Try
 * again: focus goes there, and to the heading only when the new line has none. */
function RetryButton({ onRetry }: { onRetry: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = ref.current;
    // Runs while the button is still in the page, as its line goes.
    return () => {
      if (!button || document.activeElement !== button) return;
      const heading = button.closest('.commons-view')?.querySelector<HTMLElement>('[data-workspace-heading]')
        ?? document.querySelector<HTMLElement>('.commons-view [data-workspace-heading]');
      // The row the line sat in (the page row, or a pane's), and the buttons there now: a new one
      // after the commit is the new line's.
      const row = button.closest<HTMLElement>('.commons-messages') ?? button.closest('[data-line-box]')?.parentElement ?? null;
      const before = new Set(row ? row.querySelectorAll('.commons-retry') : []);
      queueMicrotask(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const next = row?.isConnected
          ? [...row.querySelectorAll<HTMLElement>('.commons-retry')].find((each) => !before.has(each)) : undefined;
        const target = next ?? heading;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, []);
  return <button ref={ref} type="button" className="commons-retry" onClick={onRetry}>Try again</button>;
}

/**
 * A Commons screen's failure line (GM r12 (2), PR #204 round 9). A refusal because this tab
 * isn't connected as the person destroys nothing, so it is a status, not an alert. Its colour is
 * the error look's token for every line: a because line takes the neutral ink from the one shared
 * sheet every surface uses (styles/becauseLine.css, GM r14 (4)), not from a class chosen here.
 * Its words register (components/LineText), so a because line sends the general notice away
 * while it shows.
 */
export function CommonsErrorLine({ line: given, className = '', as: Tag = 'p', onRetry }: {
  line: string | null | undefined; className?: string;
  /** Round 18: `span` where a block can't go (inside a tile or a phrase). */
  as?: 'p' | 'span';
  /** Round 18f (GM r35 4): how a load reads again. A load's line that ends "Try again." ends in a
   * "Try again" button that does it (retryStem). Never an action's: that would send it again. */
  onRetry?: () => void;
}) {
  const line = useOfflineFirstBecause(given);
  const offline = useBackendOffline();
  if (!line) return null;
  // Round 18d (review 14 live LOW-1, GM r23 3: offline comes first): a load's line hides beside
  // "Nebula is offline", which says what is wrong, as the page row's do; it shows again online.
  if (offline && isLoadLine(line)) return null;
  // A not-connected refusal (a because line, the general words, or a dev setup's line).
  const person = isBecauseLine(line);
  // Round 18 (GM r28 1): a load that got no answer destroys nothing either: neutral, in the same
  // one style as a because line (styles/becauseLine.css `data-line-neutral`). Round 18b (GM r29
  // 1): a load that failed for any reason (errorCopy isLoadLine).
  // Round 18c (GM r30 1): and a because line, so the two share one look, the bare rail.
  const neutral = person || isLoadLine(line);
  const stem = onRetry ? retryStem(line) : null;
  return (
    <Tag className={`commons-notice commons-notice--error${className ? ` ${className}` : ''}`}
      role={person ? 'status' : 'alert'} data-commons-line={person ? 'not-connected' : 'error'}
      // Round 11 (GM r18 c): the rail and fill make it a box, the shared one (styles/becauseLine.css):
      // neutral and in the sans face with a because line, the warning look for any other failure.
      data-line-box=""
      {...(neutral ? { 'data-line-neutral': '' } : {})}
      // Round 11 (GM r19 2): a not-connected line can take focus when a demote removes the control.
      {...(person ? { tabIndex: -1, [FOCUS_LINE_ATTR]: '' } : {})}>
      {stem === null ? <LineText text={line} /> : (
        <LineText text={line}>
          <span className="commons-notice__text">
            {stem} <RetryButton onRetry={onRetry!} />.
          </span>
        </LineText>
      )}
    </Tag>
  );
}

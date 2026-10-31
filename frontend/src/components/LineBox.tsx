import { LineText } from './LineText';
import { FOCUS_LINE_ATTR } from '../hooks/useFocusHandover';
import '../styles/becauseLine.css';

/**
 * PR #204 round 11 (GM r18 c): the shared box for a section's own line, the one that stands in
 * for what the section couldn't load or do ("Nebula couldn’t load your agents because…"). It is
 * the same box a canvas card's error and the Projects error draw (`data-line-box`): a because
 * line inside makes it neutral (styles/becauseLine.css), any other failure keeps the warning
 * look, and its words are in the sans face (mono is for ids and code).
 *
 * tests/presenceRound11.heldLoad.test.tsx fails a because line on a held tab's screens that
 * isn't in such a box.
 */
export function LineBox({ text, className, role = 'alert' }: { text: string | null | undefined; className?: string; role?: 'alert' | 'status' }) {
  if (!text) return null;
  return (
    // tabIndex -1: when a demote removes the control that had focus, focus moves here
    // (hooks/useFocusHandover, GM r19 2).
    <div className={`line-box${className ? ` ${className}` : ''}`} role={role} data-line-box="" tabIndex={-1} {...{ [FOCUS_LINE_ATTR]: '' }}>
      <LineText text={text} />
    </div>
  );
}

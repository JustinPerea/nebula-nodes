import { isBecauseLine } from '../../lib/notConnectedLine';
import { LineText } from '../LineText';

/**
 * A Commons screen's failure line (GM r12 (2), PR #204 round 9). A refusal because this tab
 * isn't connected as the person destroys nothing, so it is a status, not an alert. Its colour is
 * the error look's token for every line: a because line takes the neutral ink from the one shared
 * sheet every surface uses (styles/becauseLine.css, GM r14 (4)), not from a class chosen here.
 * Its words register (components/LineText), so a because line sends the general notice away
 * while it shows.
 */
export function CommonsErrorLine({ line, className = '' }: { line: string | null | undefined; className?: string }) {
  if (!line) return null;
  // A not-connected refusal (a because line, the general words, or a dev setup's line).
  const person = isBecauseLine(line);
  return (
    <p className={`commons-notice commons-notice--error${className ? ` ${className}` : ''}`}
      role={person ? 'status' : 'alert'} data-commons-line={person ? 'not-connected' : 'error'}>
      <LineText text={line} />
    </p>
  );
}

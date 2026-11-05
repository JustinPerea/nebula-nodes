import { inDesktopShell } from './personSession';
import { runFinishesLine } from './runLock';
import { UNLOCK_LABEL } from './worldLabsWaiting';
import type { OpenHold, ReopenHold } from './reopenHold';

/**
 * The table of lines for a held reopen (GM r30 to r33 on PR #199). Loaded
 * when a hold first arrives (store/projectStore loadReopenHoldLines), not
 * with the entry chunk: a verdict is read and placed without it
 * (lib/reopenHold), and nothing says a line before it is here.
 */
const quoted = (name: string) => `“${name}”`;
function fieldList(fields: string[]): string {
  const names = (fields.length > 0 ? fields : ['Resume Operation ID']).map(quoted);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** GM r32 (item 8): a node of the project being reopened is "its"; another
 * project's adds "from “Alpha”". `null` when Nebula couldn't tell whose it
 * is: then the line names the node only (the "for" form holds for any). */
function whose(hold: OpenHold, openId: string): 'its' | 'other' | 'unknown' {
  if (hold.projectId === openId) return 'its';
  return hold.projectId && hold.projectName ? 'other' : 'unknown';
}
/** " for “World” from “Alpha”", " for “World”", or "". */
function forNode(hold: OpenHold, openId: string): string {
  const node = hold.nodeName ? ` for ${quoted(hold.nodeName)}` : '';
  return whose(hold, openId) === 'other' ? `${node} from ${quoted(hold.projectName ?? '')}` : node;
}

/** The lock-shape line for each hold (GM r30 item 2, r31 item 1, r32 item 1),
 * under the card on Projects and on the canvas. `project` is the project's
 * name, `openId` its id. */
export function reopenHoldLine(project: string, openId: string, hold: ReopenHold,
  desktop: boolean = inDesktopShell()): string {
  const reopen = `You can reopen ${quoted(project)}`;
  switch (hold.state) {
    case 'run':
    case 'tabRun':
      return runFinishesLine(`reopen ${quoted(project)}`);
    case 'active':
      return `${reopen} when World Labs confirms the new run.`;
    case 'uncertain':
      return `${reopen} after you check its World Labs run in Marble and press “${UNLOCK_LABEL}”.`;
    case 'ambiguity':
      return whose(hold, openId) === 'its'
        ? `${reopen} after you check its World Labs run in Marble and press “${UNLOCK_LABEL}”.`
        : `${reopen} after you check the World Labs run${forNode(hold, openId)} in Marble and press “${UNLOCK_LABEL}”.`;
    case 'recovery':
      return hold.count >= 2
        ? `${reopen} after you forget ${hold.count} World Labs recovery IDs in Run History.`
        : `${reopen} after you forget the World Labs recovery ID${forNode(hold, openId)} in Run History.`;
    case 'params':
      return `${reopen} after you check the World Labs run${forNode(hold, openId)} in Marble and clear its ${fieldList(hold.fields)}.`;
    case 'bootstrap':
      return `Nebula couldn’t save its World Labs safeguards. ${reopen} after you ${desktop ? 'quit Nebula and open it again' : 'restart Nebula'}.`;
  }
}

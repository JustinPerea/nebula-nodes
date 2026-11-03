import { middleTruncate } from './fileName';
import { quoted } from './quoted';

/** The words of an upload into a file param in the Inspector (GM r46 on
 *  #222). A name is cut in the middle so its extension stays. */

/** The file row while the upload is on its way, in place of the file's name. */
export const uploadingLabel = (name: string) => `Uploading ${quoted(middleTruncate(name))}…`;

/** Under the file row, once, when the person is back on the node: the
 *  project (or the graph) changed before the upload landed (Q1). */
export const uploadProjectChangedLine = (name: string) =>
  `Nebula couldn’t add ${quoted(middleTruncate(name))} because the project changed before it finished uploading. Choose the file again.`;

/** Under the file's name when Nebula has no preview of it (Q2): neutral,
 *  nothing failed. */
export const NO_PREVIEW = 'No preview';

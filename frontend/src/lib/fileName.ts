/** File names as cards show them (GM - Design, drop follow-ups, 2026-10-24). */

/** How many characters of a file name fit on one line of a 200-240px card. */
export const CARD_FILE_NAME_CHARS = 28;

/** An extension longer than this (dot included) is treated as part of the name. */
const MAX_EXTENSION_CHARS = 8;

/** `name` in at most `max` characters, cut in the middle so the extension
 * stays: "quarterly-report-final-version-2026.pdf" at 18 is
 * "quarterly-rep….pdf". A name without an extension (or with one too long
 * to be one) keeps its start and its last third. */
export function middleTruncate(name: string, max: number = CARD_FILE_NAME_CHARS): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const room = Math.max(1, max - 1);
  const dot = chars.lastIndexOf('.');
  const extension = dot > 0 ? chars.slice(dot) : [];
  const keepsExtension = extension.length > 1
    && extension.length <= MAX_EXTENSION_CHARS
    && extension.length < room;
  const tail = keepsExtension ? extension : chars.slice(chars.length - Math.floor(room / 3));
  const head = chars.slice(0, room - tail.length);
  return `${head.join('')}…${tail.join('')}`;
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** A stored upload: its content hash, then its extension. */
const STORED_UPLOAD = /^[0-9a-f]{64}\.[a-z0-9]+$/i;

/** The name of the file an input node holds: the name it was uploaded with
 * (`_fileName`, kept by /api/uploads and the Inspector for that stored file),
 * else the file's own name unless that is a stored hash. Null when there is
 * no file or no name worth showing. backend/services/input_file_name.py
 * reads `_fileName` the same way. */
export function inputFileName(params: Record<string, unknown>): string | null {
  const path = typeof params.filePath === 'string' ? params.filePath : '';
  if (!path) return null;
  const file = basename(path);
  const kept = params._fileName;
  if (kept && typeof kept === 'object') {
    const { file: keptFile, name } = kept as { file?: unknown; name?: unknown };
    if (keptFile === file && typeof name === 'string' && name) return name;
  }
  return STORED_UPLOAD.test(file) ? null : file;
}

/** The `_fileName` param for a file stored at `filePath`, sent as `name`. */
export function fileNameParam(filePath: string, name: string): { file: string; name: string } | null {
  const shown = basename(name).trim();
  return shown ? { file: basename(filePath), name: shown } : null;
}

/**
 * A project's size, the one way Nebula measures it (Q118).
 *
 * "Project size" is exactly the bytes the backend's save check counts
 * (backend/services/project_size.py, main._stage_project_snapshot): the
 * snapshot the canvas sends as Python's `json.dumps(snapshot,
 * allow_nan=False, ensure_ascii=False)` writes it, in UTF-8. That is the
 * canvas's own JSON plus Python's spacing (", " and ": ") and its float
 * spelling (1e-07 where JavaScript writes 1e-7, 1e-05 for 0.00001), so this
 * counts from JSON.stringify's text in one pass, with no second copy of a
 * 20 MB string. backend/tests/fixtures/project_size_cases.json pins both
 * sides to the same numbers (tests/projectSize.test.ts and the backend's
 * test_project_size.py).
 *
 * The breakdown (what takes the space, largest first) is the backend's,
 * row for row: the panel computes it from the tab's own snapshot because a
 * paused tab's edits never reached the backend.
 *
 * Sizes are shown as GM writes them: MiB labelled "MB", one decimal.
 */

export const MIB = 1024 * 1024;
/** The backend's MAX_PROJECT_BYTES: 16 MiB, "16 MB" in GM's lines. */
export const PROJECT_SAVE_LIMIT_BYTES = 16 * MIB;
/** How many rows the panel lists before "{n} smaller items, …". */
export const TOP_ROWS = 10;

/** Which part of a node takes most of its space (project_size.py PARTS). */
export type SizePart = 'text' | 'outputs' | 'embedded' | 'node';
const PARTS: SizePart[] = ['text', 'outputs', 'embedded', 'node'];
const STORED_OUTPUTS = ['outputs', 'batchOutputs', 'batchVariants'] as const;

export type ProjectSizeRow =
  | { kind: 'node'; nodeId: string; definitionId: string | null; label: string | null; part: SizePart; bytes: number }
  | { kind: 'runHistory' | 'wires'; count: number; bytes: number }
  | { kind: 'createDraft' | 'project'; bytes: number };

/** The same digits JavaScript writes, in the form Python's float repr takes:
 * fixed from 1e-4 up to 1e16, otherwise an exponent of at least two digits.
 * Returns how many more bytes Python's spelling takes (it can be fewer). */
function pythonNumberExtra(token: string): number {
  // An integer (no "." or exponent) is written the same way by both.
  if (!/[.eE]/.test(token)) return 0;
  const value = Number(token);
  if (!Number.isFinite(value)) return 0;
  const [mantissa, exponentText] = value.toExponential().split('e');
  const exponent = Number(exponentText);
  if (exponent >= -4 && exponent < 16) return 0;
  const python = `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  return python.length - token.length;
}

/** The bytes the backend counts for this JSON text (JSON.stringify's, no
 * spacing): its UTF-8 length, one more byte for each ", " and ": " Python
 * writes, and the difference in each float's spelling. */
export function jsonTextBytes(text: string): number {
  let bytes = 0;
  let inString = false;
  const length = text.length;
  for (let index = 0; index < length; index += 1) {
    const code = text.charCodeAt(index);
    if (inString) {
      if (code === 0x22) inString = false;
      // An escape: the backslash and the ASCII character after it (a \u
      // escape's four hex digits follow as plain characters).
      else if (code === 0x5c) { bytes += 2; index += 1; continue; }
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      // A surrogate pair is one 4-byte character: 2 for each half.
      else if (code >= 0xd800 && code <= 0xdfff) bytes += 2;
      else bytes += 3;
      continue;
    }
    if (code === 0x22) { inString = true; bytes += 1; continue; }
    if (code === 0x2c || code === 0x3a) { bytes += 2; continue; }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      let end = index + 1;
      while (end < length) {
        const next = text.charCodeAt(end);
        if ((next >= 0x30 && next <= 0x39) || next === 0x2e || next === 0x65 || next === 0x45 || next === 0x2b || next === 0x2d) end += 1;
        else break;
      }
      const token = text.slice(index, end);
      bytes += token.length + pythonNumberExtra(token);
      index = end - 1;
      continue;
    }
    bytes += 1;
  }
  return bytes;
}

/** The bytes the backend's save check counts for `value`. */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : jsonTextBytes(text);
}

/** A project's size: its snapshot as the save check measures it. Pass the
 * JSON text the caller already made (the autosave's fingerprint) to skip a
 * second stringify. */
export function projectSizeBytes(snapshot: unknown, text?: string): number {
  return text === undefined ? jsonBytes(snapshot) : jsonTextBytes(text);
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function dataUrlBytes(value: unknown): number {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (current.startsWith('data:')) total += jsonBytes(current);
    } else if (Array.isArray(current)) stack.push(...current);
    else if (isObject(current)) stack.push(...Object.values(current));
  }
  return total;
}

/** A node entry's bytes and how they split between its parts
 * (project_size.py node_parts). */
export function nodeParts(node: Json): { bytes: number; parts: Record<SizePart, number> } {
  const bytes = jsonBytes(node);
  const data = isObject(node.data) ? node.data : {};
  const params = data.params;
  const hasParams = params !== undefined && params !== null;
  const embedded = hasParams ? dataUrlBytes(params) : 0;
  const text = hasParams ? jsonBytes(params) - embedded : 0;
  const outputs = STORED_OUTPUTS.reduce((sum, key) => sum + (key in data ? jsonBytes(data[key]) : 0), 0);
  return { bytes, parts: { text, outputs, embedded, node: bytes - text - outputs - embedded } };
}

function largestPart(parts: Record<SizePart, number>): SizePart {
  // A tie goes to the earlier part in PARTS, as the backend's does.
  return PARTS.reduce((best, part) => (parts[part] > parts[best] ? part : best), PARTS[0]);
}

/** The project's size and every row, largest first (ties keep the
 * snapshot's order); every byte is in a row (project_size.py breakdown). */
export function projectSizeBreakdown(snapshot: unknown): { bytes: number; rows: ProjectSizeRow[] } {
  const total = jsonBytes(snapshot);
  const source = isObject(snapshot) ? snapshot : {};
  const rows: ProjectSizeRow[] = [];
  for (const node of Array.isArray(source.nodes) ? source.nodes : []) {
    if (!isObject(node)) continue;
    const { bytes, parts } = nodeParts(node);
    const data = isObject(node.data) ? node.data : {};
    rows.push({ kind: 'node', nodeId: String(node.id), part: largestPart(parts), bytes,
      definitionId: typeof data.definitionId === 'string' ? data.definitionId : null,
      label: typeof data.label === 'string' ? data.label : null });
  }
  const history = source.runHistory;
  if (Array.isArray(history) && history.length) rows.push({ kind: 'runHistory', count: history.length, bytes: jsonBytes(history) });
  const edges = source.edges;
  if (Array.isArray(edges) && edges.length) rows.push({ kind: 'wires', count: edges.length, bytes: jsonBytes(edges) });
  if (source.createDraft !== undefined && source.createDraft !== null) rows.push({ kind: 'createDraft', bytes: jsonBytes(source.createDraft) });
  rows.push({ kind: 'project', bytes: total - rows.reduce((sum, row) => sum + row.bytes, 0) });
  rows.sort((a, b) => b.bytes - a.bytes);
  return { bytes: total, rows };
}

/** A project's size as GM writes it, without " MB": one decimal, rounded up
 * while over the limit (so it never reads as the limit or under) and down at
 * or under it. */
export function displaySize(bytes: number, limit = PROJECT_SAVE_LIMIT_BYTES): string {
  const tenths = (bytes / MIB) * 10;
  return ((bytes > limit ? Math.ceil(tenths) : Math.floor(tenths)) / 10).toFixed(1);
}

/** {over}: how much smaller it must get, rounded up, so it never reads 0.0
 * while still over. */
export function overBy(bytes: number, limit = PROJECT_SAVE_LIMIT_BYTES): string {
  return (Math.ceil((Math.max(0, bytes - limit) / MIB) * 10) / 10).toFixed(1);
}

/** How many of the rows (largest first) the panel lists: those of 0.1 MB
 * and up, at most TOP_ROWS. The rest go in "{n} smaller items, {size} MB in
 * all" (GM - Design, #182: "Rows under 0.1 MB: don't show them. "0.0 MB"
 * tells nobody anything."). services/project_size.py listed_count. */
export function listedRowCount(rows: ReadonlyArray<{ bytes: number }>): number {
  let count = 0;
  while (count < rows.length && count < TOP_ROWS && rows[count].bytes * 10 >= MIB) count += 1;
  return count;
}

/** A row's size: the nearest tenth of a MB. */
export function rowSize(bytes: number): string {
  return (Math.round((bytes / MIB) * 10) / 10).toFixed(1);
}

/** The longest project name the backend takes (services/project_store.py
 * project_name, in code points). */
const PROJECT_NAME_MAX = 120;

/** The new project's name for a Load graph file over the limit (Q120,
 * Justin: "Files over the limit open as a new project named after the
 * file."): the file's name without its graph extension, fitted to the
 * backend's name rule, or the default name when that leaves nothing. */
export function projectNameForFile(fileName: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const base = (fileName ?? '').trim().replace(/\.(nebula\.zip|nebula|json|zip)$/i, '').replace(/[\u0000-\u001f]/g, ' ');
  const name = Array.from(base.trim()).slice(0, PROJECT_NAME_MAX).join('').trim();
  return name || 'Untitled project';
}

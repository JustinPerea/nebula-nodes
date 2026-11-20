/**
 * A failure heading that names a thing names it in “ ” (design): "Couldn’t upload “Bob's photo.png”.". The line
 * Nebula builds from a heading (becauseLine, failedWhat) reads the action out of it, and an unquoted name breaks that
 * reading: a name with ". " in it ("scan 2. final.png") ends the sentence early, and an apostrophe in a file name
 * ("Bob's photo.png") is curled into a different name. So every template in the source that opens "Couldn’t …" and
 * has a slot for a name quotes the slot: `quoted(name)`, a literal “${name}”, or a helper that quotes
 * (quotedNames, nodeNameList). A slot that holds a fixed word or a number is named below, with what it holds.
 *
 * This reads the source with the TypeScript parser, as the other ratchets here do; tests under src are not source.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Helpers whose result is already quoted names. */
const QUOTING_HELPERS = new Set(['quoted', 'quotedNames', 'nodeNameList']);

/**
 * The slots that hold no name a person or an agent typed. Keyed by the slot's source text; `file` is where it is read,
 * `holds` says what it holds.
 */
const ALLOWED: { file: string; slot: string; holds: string }[] = [
  { file: 'lib/cinemaScene.ts', slot: 'action', holds: 'a fixed verb phrase the scene refusals pass in ("delete the scene")' },
  { file: 'lib/cinemaScene.ts', slot: 'text', holds: 'the shots as a count or a quoted list ("2 shots", "“Shot 2”")' },
  { file: 'lib/cinemaScene.ts', slot: "several ? 'are' : 'is'", holds: 'a fixed verb' },
  { file: 'lib/cinemaScene.ts', slot: 'end', holds: 'a fixed closing sentence (STOP_FIRST or WAIT_FOR_IT)' },
  { file: 'lib/canvasFileDrop.ts', slot: 'failures.length', holds: 'a count' },
  { file: 'lib/canvasFileDrop.ts', slot: 'total', holds: 'a count' },
  { file: 'lib/providerReadiness.ts', slot: 'provider', holds: 'a provider’s catalog name ("Krea"), not typed by anyone' },
  { file: 'lib/savingCutOff.ts', slot: 'changes.length', holds: 'a count' },
  { file: 'lib/savingCutOff.ts', slot: 'settingsOnOneNode(settings.map((save) => save.setting!))', holds: 'quoted setting names or a count' },
  { file: 'lib/studioBoundary.ts', slot: 'subject', holds: 'a quoted node label or the studio’s own noun' },
  { file: 'lib/studioBoundary.ts', slot: 'where', holds: 'a fixed place phrase ("in Moodboard Studio")' },
  { file: 'lib/studioBoundary.ts', slot: 'nodeId', holds: 'a node id (Agent log line: ids are the point)' },
  { file: 'lib/studioBoundary.ts', slot: 'what', holds: 'a fixed sentence' },
  { file: 'lib/studioBoundary.ts', slot: 'errorText(error)', holds: 'the error’s own text (Agent log line, not shown on a card)' },
  { file: 'lib/studioBoundary.ts', slot: 'STUDIO_PLACE[studio]', holds: 'a fixed place phrase' },
  { file: 'hooks/useAssetDelete.ts', slot: 'NOUN[kind]', holds: 'a fixed noun ("character", "moodboard")' },
  { file: 'lib/trash.ts', slot: 'NOUN[kind]', holds: 'a fixed noun' },
  { file: 'lib/assetProposals.ts', slot: 'verb', holds: 'accept or reject' },
  { file: 'store/assetProposalsStore.ts', slot: 'verb', holds: 'accept or reject' },
  { file: 'store/graphStore.ts', slot: "want ? 'make' : 'remove'", holds: 'a fixed verb' },
  { file: 'store/graphStore.ts', slot: 'groupedCount(count)', holds: 'a count' },
  { file: 'store/graphStore.ts', slot: 'action', holds: 'a fixed verb the caller passes ("run", "change")' },
  { file: 'store/graphStore.ts', slot: 'what', holds: 'a count of settings or quoted setting names' },
  { file: 'store/graphStore.ts', slot: 'nodeId', holds: 'a node id (an Agent log line: ids are the point)' },
  { file: 'store/graphStore.ts', slot: 'status', holds: 'an HTTP status number (an Agent log line)' },
  { file: 'store/graphStore.ts', slot: 'code', holds: 'the backend’s error code (an Agent log line)' },
  { file: 'store/graphStore.ts', slot: "detail || 'No detail.'", holds: 'the backend’s detail (an Agent log line, never a card)' },
  { file: 'store/projectFlows.ts', slot: 'groupedCount(deletesHeld.length)', holds: 'a count' },
  { file: 'store/projectFlows.ts', slot: 'what', holds: 'a fixed action phrase' },
  { file: 'lib/errorCopy.ts', slot: 'what', holds: 'an action already read from a heading (failedWhat)' },
  { file: 'lib/errorCopy.ts', slot: 'detail', holds: 'the backend’s detail in a console line, not a person’s line' },
];

const unwrap = (expression: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
  || ts.isAsExpression(expression) ? unwrap(expression.expression) : expression);

function slotIsSafe(file: string, expression: ts.Expression, before: string, after: string, source: ts.SourceFile): boolean {
  // A literal “${…}” around the slot.
  if (before.endsWith('“') && after.startsWith('”')) return true;
  const slot = unwrap(expression);
  if (ts.isStringLiteral(slot) || ts.isNoSubstitutionTemplateLiteral(slot)) return true;
  if (ts.isCallExpression(slot) && ts.isIdentifier(slot.expression) && QUOTING_HELPERS.has(slot.expression.text)) return true;
  if (ts.isTemplateExpression(slot)) return unsafeSlots(file, slot, source).length === 0;
  if (ts.isConditionalExpression(slot)) {
    return slotIsSafe(file, slot.whenTrue, '', '', source) && slotIsSafe(file, slot.whenFalse, '', '', source);
  }
  const text = slot.getText(source);
  return ALLOWED.some((entry) => entry.file === file && entry.slot === text);
}

/** The slots of a template that are not quoted and not on the list. */
function unsafeSlots(file: string, template: ts.TemplateExpression, source: ts.SourceFile): string[] {
  return template.templateSpans.flatMap((span, index) => {
    const before = index === 0 ? template.head.text : template.templateSpans[index - 1].literal.text;
    return slotIsSafe(file, span.expression, before, span.literal.text, source) ? [] : [span.expression.getText(source)];
  });
}

/** Every template of the form "Couldn’t …${…}…" in the source: its file, its text and its unquoted slots. */
export function headingTemplates(): { file: string; text: string; unsafe: string[] }[] {
  const found: { file: string; text: string; unsafe: string[] }[] = [];
  for (const path of walk(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!/Couldn['’]t /.test(text)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const file = relative(SRC, path);
    const visit = (node: ts.Node) => {
      // The agent cursor's `line` tag quotes every name it is given (nodeNameList), whatever the slot holds.
      const tagged = !!node.parent && ts.isTaggedTemplateExpression(node.parent) && ts.isIdentifier(node.parent.tag) && node.parent.tag.text === 'line';
      if (ts.isTemplateExpression(node) && /^Couldn['’]t /.test(node.head.text) && !tagged) {
        found.push({ file, text: node.getText(source), unsafe: unsafeSlots(file, node, source) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('a heading’s names are quoted', () => {
  it('finds the heading templates (the scan is not empty)', () => {
    expect(headingTemplates().length).toBeGreaterThan(20);
  });

  it('every “Couldn’t …” template quotes the names it interpolates, or the slot is on the list of fixed words', () => {
    const unquoted = headingTemplates().filter((site) => site.unsafe.length > 0)
      .map((site) => `${site.file}: ${site.text} (${site.unsafe.join(', ')})`);
    expect(unquoted).toEqual([]);
  });

  it('every entry of the list is still a slot in the file it names (none stale)', () => {
    const slots = new Map<string, Set<string>>();
    for (const path of walk(SRC)) {
      const text = readFileSync(path, 'utf8');
      if (!/Couldn['’]t /.test(text)) continue;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const file = relative(SRC, path);
      const visit = (node: ts.Node) => {
        if (ts.isTemplateExpression(node)) {
          for (const span of node.templateSpans) {
            slots.set(file, (slots.get(file) ?? new Set()).add(unwrap(span.expression).getText(source)));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(ALLOWED.filter((entry) => !slots.get(entry.file)?.has(entry.slot)).map((entry) => `${entry.file}: ${entry.slot}`)).toEqual([]);
  });
});

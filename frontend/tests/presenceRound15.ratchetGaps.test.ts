/**
 * PR #204 round 15 (review 12 NIT-5): two blind spots in the line ratchets, closed.
 *
 * 1. presenceRound6.ratchet's because rule passes a retry block when any one line it shows is in
 *    the because form, so a load's own line could lose the form while the page line beside it
 *    kept it (mutant X21). Here: in a function that retries on the promote, every line variable
 *    worded from a failure (`line`, `page`, `…Line`) says a refusal for this tab in the because
 *    form: its initializer branches on isPersonRefusal(…) to notConnectedBecause(…) (or a helper
 *    in that form).
 * 2. presenceRound9.commons reads set*Error and failureMessage calls, and pageLoadLines (exported
 *    for its tests) takes any line text, so a screen could draw its own words through it unseen.
 *    Here: only components/commons/useCommonsLine.ts uses it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}
const sources = () => walk(SRC).map((path) => ({ name: relative(SRC, path), text: readFileSync(path, 'utf8') }));

const BECAUSE = /^(?:notConnectedBecause|markReadRefusedCopy|generateRefusedCopy)$/;
const WORDED = /\b(?:failureMessage|failureUnder|failureCopy|noResponseBecause)\(/;
const LINE_NAME = /^(?:line|page|\w+Line)$/;

const calleeName = (call: ts.CallExpression) => {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
};

/** The because form: a because call, or `isPersonRefusal(…) [&& …] ? <because> : …`. */
function saysBecause(expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isCallExpression(e)) return BECAUSE.test(calleeName(e));
  if (ts.isConditionalExpression(e) && /^\(?isPersonRefusal\(/.test(e.condition.getText())) return saysBecause(e.whenTrue);
  return false;
}

const FUNCTION = (node: ts.Node) => ts.isArrowFunction(node) || ts.isFunctionDeclaration(node)
  || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);

/** Line variables worded from a failure, in functions that retry on the promote, without the
 * because form. */
export function refusalLinesWithoutBecause(files: { name: string; text: string }[]): string[] {
  const bad: string[] = [];
  for (const { name, text } of files) {
    if (!text.includes('retryOnPromote(')) continue;
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (FUNCTION(node) && /\bretryOnPromote\(/.test(node.getText(source))) {
        const check = (inner: ts.Node) => {
          if (inner !== node && FUNCTION(inner)) return; // a nested function is checked on its own
          if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name) && LINE_NAME.test(inner.name.text)
            && inner.initializer && WORDED.test(inner.initializer.getText(source)) && !saysBecause(inner.initializer)) {
            bad.push(`${name}: ${inner.getText(source).slice(0, 120)}`);
          }
          ts.forEachChild(inner, check);
        };
        ts.forEachChild(node, check);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return bad;
}

/** Files other than the hook that use pageLoadLines. */
export function pageLoadLinesOutsideTheHook(files: { name: string; text: string }[]): string[] {
  return files.filter(({ name, text }) => name !== join('components', 'commons', 'useCommonsLine.ts') && /\bpageLoadLines\b/.test(text))
    .map(({ name }) => name);
}

describe('review 12 NIT-5: the because rule reads each line, not one per block', () => {
  it('every refusal line in a retrying function says why in the because form', () => {
    expect(refusalLinesWithoutBecause(sources())).toEqual([]);
  });

  it('catches a load\'s own line without the form beside a page line with it (mutant X21)', () => {
    const probe = (body: string) => refusalLinesWithoutBecause([{ name: 'P.ts', text: `const show = (error, heading) => { ${body} retryOnPromote(error, k, r); };` }]);
    expect(probe('const line = failureMessage(error, heading); const page = isPersonRefusal(error) ? notConnectedBecause(\'load the Commons\') : failureUnder(error, H);')).toHaveLength(1);
    expect(probe('const line = isPersonRefusal(error) && what ? failureMessage(error, heading) : failureMessage(error, heading);')).toHaveLength(1);
    expect(probe('const line = isPersonRefusal(error) && what ? notConnectedBecause(what) : noResponse && what ? noResponseBecause(what) : failureMessage(error, heading);')).toHaveLength(0);
    expect(probe('const shownLine = isPersonRefusal(error) ? notConnectedBecause(\'x\') : failureMessage(error, heading);')).toHaveLength(0);
    expect(probe('const count = failureMessage(error, heading).length;')).toHaveLength(0);
  });

  it('the hook\'s own two lines are read (it isn\'t skipped)', () => {
    const hook = sources().find(({ name }) => name.endsWith(join('commons', 'useCommonsLine.ts')))!;
    const broken = hook.text.replace('const line = isPersonRefusal(error) && what ? notConnectedBecause(what)\n      : what ? loadFailedLine',
      'const line = isPersonRefusal(error) && what ? failureMessage(error, heading)\n      : what ? loadFailedLine');
    expect(broken).not.toBe(hook.text);
    expect(refusalLinesWithoutBecause([{ name: hook.name, text: broken }])).toHaveLength(1);
  });
});

describe('review 12 NIT-5: pageLoadLines is the hook\'s', () => {
  it('no other source uses it, so no screen draws its own words through it', () => {
    expect(pageLoadLinesOutsideTheHook(sources())).toEqual([]);
  });

  it('catches a screen that does', () => {
    expect(pageLoadLinesOutsideTheHook([{ name: join('components', 'commons', 'CommonsView.tsx'), text: 'const shown = pageLoadLines([{ line: text, page: text, person: false }]);' }])).toHaveLength(1);
  });
});

describe('review 12 NIT-6: curly apostrophes in the lines this PR wrote', () => {
  // The headings this PR wrote that render as written (no request heading of the same words on
  // main to disagree with). The rest wait for the wording batch with their lib/api.ts twins.
  const LINES: Array<[string, string]> = [
    ['store/agentNotesStore.ts', 'Couldn’t mark the notes read.'],
    ['store/agentNotesStore.ts', 'Couldn’t dismiss the note.'],
    ['components/agent-notes/AgentNotesCorner.tsx', 'Couldn’t update the note.'],
    ['components/panels/settings/ConnectedApps.tsx', 'Couldn’t update the connected apps.'],
    ['components/panels/settings/PersonalAgentsSection.tsx', 'Couldn’t update your agents.'],
  ];
  it.each(LINES)('%s: "%s"', (file, line) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(text).toContain(`"${line}"`);
    expect(text).not.toContain(`"${line.replace('’', "'")}"`);
  });
});

// Round 17 (review 13 NIT-3): the line surfaces in the first load name their attributes from
// lib/lineAttrs, so hooks/useFocusHandover (the reader) loads only with the screens that hand
// focus over, and lib/lockPlacement (the rule's check) with nothing in the app at all.
describe('the line attributes keep their readers out of the first load', () => {
  const importsOf = (text: string) => [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]);
  it('only the screens that call useFocusHandover import it', () => {
    const users = sources().filter(({ text }) => importsOf(text).some((from) => from.endsWith('/useFocusHandover')))
      .map(({ name }) => name).sort();
    expect(users).toEqual(['components/commons/CommonsView.tsx', 'components/panels/settings/AgentSpendSection.tsx',
      'components/panels/settings/PersonalAgentsSection.tsx']);
    for (const name of users) expect(sources().find((file) => file.name === name)!.text, name).toMatch(/\buseFocusHandover\(/);
  });
  it('nothing in the app imports lib/lockPlacement', () => {
    expect(sources().filter(({ text }) => importsOf(text).some((from) => from.endsWith('/lockPlacement'))).map(({ name }) => name)).toEqual([]);
  });
});

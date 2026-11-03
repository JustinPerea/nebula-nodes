// fix/ci-flakes-rename-fix16: a fake backend's "deleted" flag flips when the
// DELETE arrives, before it answers. Until the answer the product drops an
// Undo ("Nothing was undone. Your last change was still saving.", GM r18
// option (c)) and holds a sync that brings the node back, so a test that
// waits on the flag and then presses Undo (or restores from another window)
// races the answer. graphStore.fix16 "nothing unsaved" lost that race on a
// busy CI runner (run 41591009433, attempt 1), and the scene edit it left
// aside failed the next test too; graphStore.fix18 "asked again (the
// person's delete and Undo): Codex's edit to another field…" lost it on #219
// (Undo dropped, its waitFor timed out at 3 s). A fixed sleep between the
// delete and the Undo is the same race with a deadline (PR #221 review 1
// MEDIUM-2: fix24 and fix21stops A2 failed with the answer stalled 350 ms).
// Tests wait on helpers/deleteLanded.ts instead.
//
// The check, read from each test file's syntax tree (review 1 LOW-2), so
// comments and strings never count as code:
// - Flag: a waitFor (vi.waitFor, RTL's waitFor, any receiver) whose callback,
//   expression or block, reads a `deleted` property (`x.deleted`,
//   `x['deleted']`) other than inside `expect(<read>)` asserting it false
//   (toBe(false), toEqual(false), toStrictEqual(false), toBeFalsy(),
//   not.toBe(true), not.toBeTruthy()). So toBe(true), toBeTruthy(),
//   toEqual(true), `if (!x.deleted) throw …` and `expect(x.deleted === true)`
//   are all caught.
// - Sleep: in one block, a statement that deletes (deleteNode, deleteNodes,
//   deleteSelected), then an awaited fixed sleep (`await sleep(…)`, `await
//   wait(…)`, `await new Promise(… setTimeout …)`), then an `.undo()` call,
//   with no deleteLanded and no wait on the "Deleted the node." notice
//   between the delete and the Undo. The notice is set in the same
//   synchronous call that ends the delete's hold; graphStore.fix16 "the
//   delete's hold has ended by the time anything can act on its notice" pins
//   that, so a notice wait counts as the delete landing.
// - Opt-out: a comment `delete-landed-ratchet: off, <reason>` (at least 10
//   characters), for a test that presses Undo during the delete on purpose.
//
// Known gaps: a sleep before Undo split across blocks or helper functions,
// and a flag read through a local variable (`const s = h.state; … s.deleted`
// counts; `const d = h.state.deleted` outside the callback doesn't).
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { allTestFiles, calleeName, isFunctionLike, mayHold, optedOut, parse, some, unwrap } from './helpers/ratchetSource';

const DELETES = new Set(['deleteNode', 'deleteNodes', 'deleteSelected']);
const SLEEPS = new Set(['sleep', 'wait', 'delay', 'pause']);
const TOKENS = ['deleted', 'deleteNode', 'deleteSelected'];
const FALSE_MATCHERS = new Set(['toBeFalsy']);
const VALUE_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

const isDeletedRead = (node: ts.Node) => (ts.isPropertyAccessExpression(node) && node.name.text === 'deleted')
  || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'deleted');

/** Whether a `deleted` read sits in `expect(read)` asserting false. */
function assertsFalse(read: ts.Node): boolean {
  let arg: ts.Node = read;
  while (ts.isParenthesizedExpression(arg.parent) || ts.isNonNullExpression(arg.parent) || ts.isAsExpression(arg.parent)) arg = arg.parent;
  const call = arg.parent;
  if (!call || !ts.isCallExpression(call) || calleeName(call) !== 'expect' || call.arguments[0] !== arg) return false;
  let access = call.parent;
  let negated = false;
  if (access && ts.isPropertyAccessExpression(access) && access.name.text === 'not') { negated = true; access = access.parent; }
  if (!access || !ts.isPropertyAccessExpression(access) || !ts.isCallExpression(access.parent)) return false;
  const matcher = access.name.text;
  const value = access.parent.arguments[0];
  let wantsTrue: boolean | null = null;
  if (FALSE_MATCHERS.has(matcher)) wantsTrue = false;
  else if (matcher === 'toBeTruthy') wantsTrue = true;
  else if (VALUE_MATCHERS.has(matcher) && value && (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)) {
    wantsTrue = value.kind === ts.SyntaxKind.TrueKeyword;
  }
  if (wantsTrue === null) return false;
  return negated ? wantsTrue : !wantsTrue;
}

const isSleep = (statement: ts.Statement) => {
  if (!ts.isExpressionStatement(statement)) return false;
  const awaited = unwrap(statement.expression);
  if (!ts.isAwaitExpression(awaited)) return false;
  const target = unwrap(awaited.expression);
  if (ts.isCallExpression(target) && SLEEPS.has(calleeName(target))) return true;
  return ts.isNewExpression(target) && some(target, (node) => ts.isCallExpression(node) && calleeName(node) === 'setTimeout');
};
const callsAny = (node: ts.Node, names: Set<string>) => some(node, (n) => ts.isCallExpression(n) && names.has(calleeName(n)));
const waitsForLanding = (node: ts.Node) => some(node, (n) => (ts.isCallExpression(n) && calleeName(n) === 'deleteLanded')
  || (ts.isStringLiteralLike(n) && n.text.includes('Deleted the node.')));
const UNDO = new Set(['undo']);

function readFile(source: string, fileName?: string) {
  const file = parse(source, fileName);
  let flagWaits = 0;
  let sleeps = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && calleeName(node) === 'waitFor') {
      const callback = node.arguments[0];
      if (isFunctionLike(callback) && some(callback.body, (read) => isDeletedRead(read) && !assertsFalse(read))) flagWaits += 1;
    }
    const statements = ts.isBlock(node) || ts.isSourceFile(node) ? node.statements : null;
    if (statements) {
      statements.forEach((statement, i) => {
        if (!callsAny(statement, DELETES)) return;
        let slept = false;
        for (const later of statements.slice(i + 1)) {
          if (waitsForLanding(later)) return;
          if (callsAny(later, UNDO)) { if (slept) sleeps += 1; return; }
          if (isSleep(later)) slept = true;
        }
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // The opt-out is read last: it walks every comment, and most files never need it.
  if (flagWaits + sleeps > 0 && optedOut(file, 'delete-landed-ratchet')) return { flagWaits: 0, sleeps: 0 };
  return { flagWaits, sleeps };
}

const racing = (source: string, fileName?: string) => {
  if (!mayHold(source, TOKENS)) return false;
  const { flagWaits, sleeps } = readFile(source, fileName);
  return flagWaits + sleeps > 0;
};

const H = "const h = { state: { deleted: false } };\n";
const DEL = "useGraphStore.getState().deleteNode('n1');";
const UNDO_CALL = 'useGraphStore.getState().undo();';

describe('the ratchet reads the forms (mutation cases: each must be caught)', () => {
  const caught: Array<[string, string]> = [
    ['the flag wait the harnesses used', `${H}await vi.waitFor(() => expect(h.state.deleted).toBe(true), { timeout: 3000, interval: 5 });`],
    ['a flag on a map entry', "await vi.waitFor(() => expect(h.scenes.get('n7')!.deleted).toBe(true), { timeout: 2000 });"],
    // Review 1 LOW-2: equivalent forms.
    ['a block body', `${H}await vi.waitFor(() => { expect(h.state.deleted).toBe(true); });`],
    ['toBeTruthy', `${H}await vi.waitFor(() => expect(h.state.deleted).toBeTruthy());`],
    ['toEqual(true)', `${H}await vi.waitFor(() => expect(h.state.deleted).toEqual(true));`],
    ['not.toBe(false)', `${H}await vi.waitFor(() => expect(h.state.deleted).not.toBe(false));`],
    ['not.toBeFalsy()', `${H}await vi.waitFor(() => expect(h.state.deleted).not.toBeFalsy());`],
    ['a thrown condition', `${H}await vi.waitFor(() => { if (!h.state.deleted) throw new Error('not yet'); });`],
    ['a comparison inside expect', `${H}await vi.waitFor(() => expect(h.state.deleted === true).toBe(true));`],
    ['an element access', `${H}await vi.waitFor(() => expect(h.state['deleted']).toBe(true));`],
    ['RTL waitFor', `${H}await waitFor(() => expect(h.state.deleted).toBe(true));`],
    ['a function expression', `${H}await vi.waitFor(function () { expect(h.state.deleted).toBe(true); });`],
    // Review 1 MEDIUM-2: a fixed sleep between the delete and its Undo.
    ['sleep then Undo', `${DEL}\nawait sleep(300);\n${UNDO_CALL}`],
    ['sleep, release, sleep, Undo', `${DEL}\nawait sleep(60);\nrelease();\nawait sleep(100);\n${UNDO_CALL}`],
    ['a setTimeout promise then Undo', `${DEL}\nawait new Promise((r) => setTimeout(r, 100));\n${UNDO_CALL}`],
    ['deleteNodes then sleep then Undo', `useGraphStore.getState().deleteNodes(['n1']);\nawait sleep(50);\n${UNDO_CALL}`],
    ['deleteSelected then sleep then Undo', `useGraphStore.getState().deleteSelected();\nawait sleep(50);\n${UNDO_CALL}`],
    ['deleteLanded only in a comment', `${DEL}\n// await deleteLanded(useGraphStore);\nawait sleep(300);\n${UNDO_CALL}`],
    ['an opt-out with no reason', `// delete-landed-ratchet: off\n${DEL}\nawait sleep(300);\n${UNDO_CALL}`],
  ];
  it.each(caught)('%s', (_, source) => {
    expect(racing(source)).toBe(true);
  });
  it('the prefilter lets every caught form through', () => {
    expect(caught.filter(([, source]) => !mayHold(source, TOKENS)).map(([name]) => name)).toEqual([]);
    expect(mayHold("import { render } from '@testing-library/react';", TOKENS)).toBe(false);
  });

  const passes: Array<[string, string]> = [
    ['a plain check after the answer', `${H}expect(h.state.deleted).toBe(true);`],
    ['a wait for the node to come back', `${H}await vi.waitFor(() => expect(h.state.deleted).toBe(false));`],
    ['toBeFalsy', `${H}await vi.waitFor(() => { expect(h.state.deleted).toBeFalsy(); });`],
    ['not.toBe(true)', `${H}await vi.waitFor(() => expect(h.state.deleted).not.toBe(true));`],
    ['the flag wait only in a comment', `${H}// await vi.waitFor(() => expect(h.state.deleted).toBe(true));`],
    ['the flag wait only in a string', `${H}const s = 'vi.waitFor(() => expect(h.state.deleted).toBe(true))';`],
    ['deleteLanded then Undo', `${DEL}\nawait deleteLanded(useGraphStore);\n${UNDO_CALL}`],
    ['sleep, deleteLanded, Undo', `${DEL}\nawait sleep(60);\nrelease();\nawait deleteLanded(useGraphStore);\n${UNDO_CALL}`],
    ['a wait on the notice', `${DEL}\nawait sleep(5);\nawait vi.waitFor(() => expect(notice()).toBe('Deleted the node.'));\n${UNDO_CALL}`],
    ['Undo pressed at once, during the delete (on purpose)', `${DEL}\n${UNDO_CALL}`],
    ['a sleep after the Undo', `${DEL}\nawait deleteLanded(useGraphStore);\n${UNDO_CALL}\nawait sleep(50);`],
    ['an opt-out with a reason', `// delete-landed-ratchet: off, presses Undo while the delete is held on purpose\n${DEL}\nawait sleep(300);\n${UNDO_CALL}`],
  ];
  it.each(passes)('passes: %s', (_, source) => {
    expect(racing(source)).toBe(false);
  });
});

describe('tests wait for a delete’s answer, not the fake backend’s flag or a fixed sleep', () => {
  // Sized from measurement: see the PR notes (the scan's time locally and under load).
  it('no test file waits on a deleted flag or sleeps between a delete and its Undo (use deleteLanded)', { timeout: 20_000 }, () => {
    const files = allTestFiles();
    expect(files.length).toBeGreaterThan(100);
    const found = files.filter((path) => path !== __filename && racing(readFileSync(path, 'utf8'), path))
      .map((path) => relative(join(__dirname, '..'), path));
    expect(found).toEqual([]);
  });
});

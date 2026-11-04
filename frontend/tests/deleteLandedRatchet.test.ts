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
// - Flag: a waitFor or waitUntil (vi's, RTL's, any receiver) whose
//   callback, expression or block, reads a `deleted` property (`x.deleted`,
//   `x['deleted']`) other than inside `expect(<read>)` asserting it false
//   (toBe(false), toEqual(false), toStrictEqual(false), toBeFalsy(),
//   not.toBe(true), not.toBeTruthy()); in a waitUntil, `!x.deleted` and
//   `x.deleted === false` wait for false too. A `{ deleted: true }` in the
//   callback (toMatchObject, objectContaining) counts as a read of true
//   (PR #221 review 2 LOW-1). So toBe(true), toBeTruthy(), toEqual(true),
//   `if (!x.deleted) throw …`, `expect(x.deleted === true)` and
//   `waitUntil(() => x.deleted)` are all caught.
// - Wait before Undo (review 2 LOW-1 inverted it: it names what makes a wait
//   safe, not the waits that aren't): in one block, a delete, then any wait,
//   then an Undo, with no landing between the delete and the Undo.
//   - A delete: deleteNode, deleteNodes, deleteSelected, or the Delete or
//     Backspace key (`{ key: 'Delete' }` in fireEvent, `{Delete}` in
//     user-event's keyboard).
//   - An Undo: `.undo()`, Cmd or Ctrl+Z (`{ key: 'z', metaKey: true }`,
//     `{Meta>}z{/Meta}`), or a click on an Undo button (a click whose
//     argument names "Undo", /undo/i or an undo… variable).
//   - A wait: any await (a sleep, act() with a sleep or a setTimeout, a
//     waitFor on the card leaving the canvas, which it does before the
//     answer, a user-event call), or a fake-timer advance.
//   - A landing: an awaited deleteLanded, an awaited waitFor or waitUntil
//     whose callback expects "Deleted the node." (a matcher's value, not
//     under `.not`, or one side of `===`), or an awaited findBy… of it. The
//     notice is set in the same synchronous call that ends the delete's
//     hold; graphStore.fix16 "the delete's hold has ended by the time
//     anything can act on its notice" pins that, so a notice wait counts as
//     the delete landing. The text anywhere else is no landing.
//   Positions, not statements, decide the order, so `await act(async () => {
//   deleteNode(…); await sleep(300); })` and then an Undo counts. A function
//   under the block that it doesn't run in place (a test's body, a table
//   row's arrow) is skipped; act() callbacks are read in place.
// - Opt-outs: a comment `delete-landed-ratchet: off, <reason>` (at least 10
//   characters) waives both rules, for a test that presses Undo during the
//   delete on purpose; `delete-landed-wait: off, <reason>` waives only the
//   wait rule, for a file whose fake answers each DELETE at once or only
//   when the test releases it by hand, so its waits (settle(): a fixed count
//   of timer turns) race no clock (heldUndo.round12-16, lateRestoreCount,
//   noticeFollowsStacks, undoRestoresDeletes).
//
// Known gaps: a delete, wait or Undo inside a helper function the test calls
// (deleteAndWait-style helpers must use deleteLanded themselves), or split
// across blocks; a flag read through a local variable (`const s = h.state;
// … s.deleted` counts; `const d = h.state.deleted` outside the callback
// doesn't).
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { allTestFiles, calleeName, isFunctionLike, mayHold, optedOut, parse, rootName, some, unwrap } from './helpers/ratchetSource';

const DELETES = new Set(['deleteNode', 'deleteNodes', 'deleteSelected']);
/** A test's wait for something (vi.waitFor, RTL's waitFor, vi.waitUntil), any receiver. */
const WAITS = new Set(['waitFor', 'waitUntil']);
/** Fake-timer advances: run timers (a stalled answer's included) without an await. */
const TIMER_ADVANCES = new Set(['advanceTimersByTime', 'advanceTimersByTimeAsync', 'advanceTimersToNextTimer', 'advanceTimersToNextTimerAsync',
  'runAllTimers', 'runAllTimersAsync', 'runOnlyPendingTimers', 'runOnlyPendingTimersAsync', 'runToLastAsync', 'tick', 'tickAsync']);
const NOTICE = 'Deleted the node.';
// The prefilter: a flag read, a delete by the store, or a Delete key.
const TOKENS = ['deleted', 'deleteNode', 'deleteSelected', 'Delete', 'Backspace'];
const FALSE_MATCHERS = new Set(['toBeFalsy']);
const VALUE_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual']);

const isDeletedRead = (node: ts.Node) => (ts.isPropertyAccessExpression(node) && node.name.text === 'deleted')
  || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'deleted');

/** Climbs past parentheses, `!`, `as` and the like to what holds a value. */
const outer = (node: ts.Node): ts.Node => {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isAsExpression(at.parent)) at = at.parent;
  return at;
};

/** Whether a `deleted` read sits in `expect(read)` asserting false. */
function assertsFalse(read: ts.Node): boolean {
  const arg = outer(read);
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

/** In a waitUntil (truthy ends it), whether a read waits for false: `!x.deleted`, `x.deleted === false`. */
function untilFalse(read: ts.Node): boolean {
  const at = outer(read);
  const parent = at.parent;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(parent.operatorToken.kind)) {
    const other = parent.left === at ? parent.right : parent.left;
    return other.kind === ts.SyntaxKind.FalseKeyword;
  }
  return assertsFalse(read);
}

/** `{ deleted: true }` (toMatchObject, objectContaining): the flag by shape (review 2 LOW-1). */
const isDeletedTrue = (node: ts.Node) => ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
  && node.name.text === 'deleted' && node.initializer.kind === ts.SyntaxKind.TrueKeyword;

const isAwaited = (node: ts.Node) => ts.isAwaitExpression(outer(node).parent);

/** The matcher call `expect(…).[not.]matcher(<here>)` an argument sits in, and whether `.not` negates it. */
function matcherOf(node: ts.Node): { negated: boolean } | null {
  for (let at: ts.Node = node; at.parent && !ts.isSourceFile(at.parent) && !isFunctionLike(at.parent); at = at.parent) {
    const call = at.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(at as ts.Expression)) continue;
    const callee = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || rootName(callee) !== 'expect') continue;
    let chain: ts.Expression = callee.expression;
    let negated = false;
    while (ts.isPropertyAccessExpression(chain)) { if (chain.name.text === 'not') negated = true; chain = chain.expression; }
    return { negated };
  }
  return null;
}

/** The notice text as what a wait expects: a matcher's (not negated) value, or one side of `===`. */
function expectsNotice(literal: ts.Node): boolean {
  if (!ts.isStringLiteralLike(literal) || literal.text !== NOTICE) return false;
  const at = outer(literal);
  if (ts.isBinaryExpression(at.parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(at.parent.operatorToken.kind)) return true;
  const matcher = matcherOf(literal);
  return !!matcher && !matcher.negated;
}

/**
 * The delete has landed: an awaited deleteLanded, an awaited waitFor or
 * waitUntil whose callback expects the notice, or an awaited findBy… of the
 * notice. Review 2 LOW-1: the notice text anywhere else (a negated matcher,
 * a plain expect, a string) is no landing.
 */
function isLanding(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !isAwaited(node)) return false;
  const name = calleeName(node);
  if (name === 'deleteLanded') return true;
  if (WAITS.has(name)) {
    const callback = node.arguments[0];
    return isFunctionLike(callback) && some(callback.body, expectsNotice);
  }
  if (/^find(All)?By/.test(name)) {
    return node.arguments.some((arg) => (ts.isStringLiteralLike(arg) && arg.text === NOTICE)
      || (ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer) && p.initializer.text === NOTICE)));
  }
  return false;
}

const keyIs = (object: ts.ObjectLiteralExpression, prop: string, values: readonly string[]) => object.properties.some((p) => ts.isPropertyAssignment(p)
  && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === prop && ts.isStringLiteralLike(p.initializer) && values.includes(p.initializer.text));
const flagIs = (object: ts.ObjectLiteralExpression, props: readonly string[]) => object.properties.some((p) => ts.isPropertyAssignment(p)
  && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && props.includes(p.name.text) && p.initializer.kind === ts.SyntaxKind.TrueKeyword);

/** A delete: the store's (deleteNode, deleteNodes, deleteSelected), or the Delete or Backspace key (fireEvent, user-event). */
function isDelete(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) return DELETES.has(calleeName(node));
  if (ts.isObjectLiteralExpression(node)) return keyIs(node, 'key', ['Delete', 'Backspace']) || keyIs(node, 'code', ['Delete', 'Backspace']);
  return ts.isStringLiteralLike(node) && /\{(Delete|Backspace)\}/.test(node.text) && ts.isCallExpression(node.parent)
    && ['keyboard', 'type'].includes(calleeName(node.parent));
}

const UNDO_TEXT = /^\s*undo\s*$/i;
/** An Undo: the store's `.undo()`, Cmd or Ctrl+Z (fireEvent, user-event), or a click on an Undo button. */
function isUndo(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name === 'undo') return true;
    if (name === 'click') {
      return node.arguments.some((arg) => some(arg, (n) => (ts.isStringLiteralLike(n) && UNDO_TEXT.test(n.text))
        || (ts.isRegularExpressionLiteral(n) && /undo/i.test(n.text)) || (ts.isIdentifier(n) && /undo/i.test(n.text))))
        || (ts.isPropertyAccessExpression(unwrap(node.expression)) && /undo/i.test(unwrap((unwrap(node.expression) as ts.PropertyAccessExpression).expression).getText()));
    }
    return false;
  }
  if (ts.isObjectLiteralExpression(node)) return (keyIs(node, 'key', ['z', 'Z']) || keyIs(node, 'code', ['KeyZ'])) && flagIs(node, ['metaKey', 'ctrlKey']);
  return ts.isStringLiteralLike(node) && /\{(Meta|Control)>\}\s*z/i.test(node.text);
}

/** Something that lets the delete's answer arrive: any await, or a fake-timer advance. */
const isWait = (node: ts.Node) => ts.isAwaitExpression(node) || (ts.isCallExpression(node) && TIMER_ADVANCES.has(calleeName(node)));

/**
 * A function the block runs as it goes: an act() callback. Any other
 * function under a statement (a test's body, a table row's arrow, a helper
 * declared there) runs on its own time, so what it holds isn't in this
 * block's order.
 */
const runsInline = (fn: ts.Node) => ts.isCallExpression(fn.parent) && calleeName(fn.parent) === 'act'
  && fn.parent.arguments.includes(fn as ts.Expression);
const opaque = (node: ts.Node) => (ts.isFunctionLike(node) && !(isFunctionLike(node) && runsInline(node))) || ts.isClassLike(node);

/** The first node in `root`, in source order, at or after `from`, that matches, outside any function the block doesn't run inline. */
function first(root: ts.Node, from: number, test: (node: ts.Node) => boolean): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node) => {
    if (found || node.end <= from || opaque(node)) return;
    if (node.getStart() >= from && test(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}
const within = (root: ts.Node, from: number, to: number, test: (node: ts.Node) => boolean) =>
  first(root, from, (node) => node.end <= to && test(node)) !== null;

/**
 * From a delete at statement i of a block: whether an Undo follows with a
 * wait between them and no landing (review 2 LOW-1: the rule names what
 * makes a wait safe, not the waits that aren't). Positions, not statements,
 * so `await act(async () => { del(); await sleep(300); })` then Undo counts.
 */
function racesFrom(statements: readonly ts.Statement[], i: number): boolean {
  const del = first(statements[i], 0, isDelete);
  if (!del) return false;
  const from = del.end;
  let waited = false;
  for (const statement of statements.slice(i)) {
    const undo = first(statement, from, isUndo);
    const to = undo ? undo.getStart() : Number.POSITIVE_INFINITY;
    if (within(statement, from, to, isLanding)) return false;
    if (within(statement, from, to, isWait)) waited = true;
    if (undo) return waited;
  }
  return false;
}

function readFile(source: string, fileName?: string) {
  const file = parse(source, fileName);
  let flagWaits = 0;
  let sleeps = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && WAITS.has(calleeName(node))) {
      const callback = node.arguments[0];
      const until = calleeName(node) === 'waitUntil';
      if (isFunctionLike(callback) && some(callback.body, (n) => (isDeletedRead(n) && !(until ? untilFalse(n) : assertsFalse(n)))
        || (isDeletedTrue(n) && !matcherOf(n)?.negated))) flagWaits += 1;
    }
    const statements = ts.isBlock(node) || ts.isSourceFile(node) ? node.statements : null;
    if (statements) {
      statements.forEach((_, i) => { if (racesFrom(statements, i)) sleeps += 1; });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // The opt-outs are read last: they walk every comment, and most files never need them.
  if (flagWaits + sleeps > 0 && optedOut(file, 'delete-landed-ratchet')) return { flagWaits: 0, sleeps: 0 };
  if (sleeps > 0 && optedOut(file, 'delete-landed-wait')) return { flagWaits, sleeps: 0 };
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
    // Review 2 LOW-1: the planted forms that were missed.
    ['a sleep inside act()', `${DEL}\nawait act(async () => { await sleep(300); });\n${UNDO_CALL}`],
    ['act() around a setTimeout promise', `${DEL}\nawait act(() => new Promise((r) => setTimeout(r, 300)));\n${UNDO_CALL}`],
    ['the delete and the sleep in one act(), Undo after', `await act(async () => { ${DEL} await sleep(300); });\n${UNDO_CALL}`],
    ['the sleep and the Undo in one act()', `${DEL}\nawait act(async () => { await sleep(300); ${UNDO_CALL} });`],
    ['a wait for the card to leave (it leaves before the answer)', `${DEL}\nawait vi.waitFor(() => expect(useGraphStore.getState().nodes).toHaveLength(0));\n${UNDO_CALL}`],
    ['vi.waitUntil on the flag', `${H}await vi.waitUntil(() => h.state.deleted);`],
    ['vi.waitUntil on an element access', `${H}await vi.waitUntil(() => h.state['deleted'] === true);`],
    ['toMatchObject({ deleted: true })', `${H}vi.waitFor(() => expect(h.state).toMatchObject({ deleted: true }));`],
    ['objectContaining({ deleted: true })', `${H}await waitFor(() => expect(h.state).toEqual(expect.objectContaining({ deleted: true })));`],
    ['the notice under .not taken as a landing', `${DEL}\nawait sleep(300);\nexpect(toast()?.text).not.toBe('Deleted the node.');\n${UNDO_CALL}`],
    ['a wait for the notice to be gone', `${DEL}\nawait vi.waitFor(() => expect(toast()?.text).not.toBe('Deleted the node.'));\n${UNDO_CALL}`],
    ['the notice in a plain expect after a sleep', `${DEL}\nawait sleep(300);\nexpect(toast()?.text).toBe('Deleted the node.');\n${UNDO_CALL}`],
    ['the notice only in a string', `${DEL}\nawait sleep(300);\nconst why = 'Deleted the node.';\n${UNDO_CALL}`],
    ['the Delete key, a sleep, Cmd+Z (fireEvent)', "fireEvent.keyDown(canvas, { key: 'Delete' });\nawait sleep(300);\nfireEvent.keyDown(window, { key: 'z', metaKey: true });"],
    ['Backspace, a sleep, Ctrl+Z', "fireEvent.keyDown(canvas, { key: 'Backspace' });\nawait sleep(300);\nfireEvent.keyDown(window, { key: 'z', ctrlKey: true });"],
    ['user-event Delete, a sleep, Cmd+Z', "await user.keyboard('{Delete}');\nawait sleep(300);\nawait user.keyboard('{Meta>}z{/Meta}');"],
    ['a sleep, then the Undo button (fireEvent)', `${DEL}\nawait sleep(300);\nfireEvent.click(screen.getByRole('button', { name: 'Undo' }));`],
    ['a sleep, then the Undo button (user-event, a regex)', `${DEL}\nawait sleep(300);\nawait user.click(screen.getByRole('button', { name: /undo/i }));`],
    ['a sleep, then an Undo button variable', `${DEL}\nconst undoButton = screen.getByText('Undo');\nawait sleep(300);\nfireEvent.click(undoButton);`],
    ['a user-event wait between (any await)', `${DEL}\nawait user.click(screen.getByText('Brief'));\n${UNDO_CALL}`],
    ['fake timers advanced async', `${DEL}\nawait vi.advanceTimersByTimeAsync(300);\n${UNDO_CALL}`],
    ['fake timers advanced with no await', `${DEL}\nvi.advanceTimersByTime(300);\n${UNDO_CALL}`],
    ['the wait-only opt-out keeps the flag rule', `// delete-landed-wait: off, the fake answers each DELETE at once here\n${H}await vi.waitFor(() => expect(h.state.deleted).toBe(true));`],
    ['a unicode escape in the delete', `useGraphStore.getState().delete\\u004eode('n1');\nawait sleep(300);\n${UNDO_CALL}`],
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
    ['the wait-only opt-out with a reason', `// delete-landed-wait: off, the fake answers each DELETE at once, with no timer\n${DEL}\nawait settle();\n${UNDO_CALL}`],
    ['vi.waitUntil for the node to come back', `${H}await vi.waitUntil(() => !h.state.deleted);`],
    ['vi.waitUntil on the flag being false', `${H}await vi.waitUntil(() => h.state.deleted === false);`],
    ['toMatchObject({ deleted: true }) outside a wait', `${H}expect(h.state).toMatchObject({ deleted: true });`],
    ['a findByText of the notice', `${DEL}\nawait sleep(5);\nawait screen.findByText('Deleted the node.');\n${UNDO_CALL}`],
    ['a waitUntil on the notice', `${DEL}\nawait vi.waitUntil(() => toast()?.text === 'Deleted the node.');\n${UNDO_CALL}`],
    ['a waitFor on the notice by shape', `${DEL}\nawait vi.waitFor(() => expect(notice()).toMatchObject({ text: 'Deleted the node.', offer: 'undo' }));\n${UNDO_CALL}`],
    ['deleteLanded inside act()', `${DEL}\nawait act(async () => { await deleteLanded(useGraphStore); });\n${UNDO_CALL}`],
    ['the Delete key, deleteLanded, Cmd+Z', "fireEvent.keyDown(canvas, { key: 'Delete' });\nawait deleteLanded(useGraphStore);\nfireEvent.keyDown(window, { key: 'z', metaKey: true });"],
    ['a delete in one test, the Undo in another', `it('a', async () => { ${DEL} await sleep(20); });\nit('b', () => { ${UNDO_CALL} });`],
    ['a delete in a table row, run by the test', `it.each([['x', () => ${DEL}]])('%s', async (_, remove) => { remove(); });\nawait sleep(5);\n${UNDO_CALL}`],
    ['Cmd+Z with no delete before it', `await sleep(300);\nfireEvent.keyDown(window, { key: 'z', metaKey: true });`],
    ['a sleep, then a button that isn’t Undo', `${DEL}\nawait sleep(300);\nfireEvent.click(screen.getByRole('button', { name: 'Redo' }));`],
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

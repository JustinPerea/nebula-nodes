import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RequestFailedError, headedLine, isNamedLine, oneLine } from '../../src/lib/errorCopy';
import { deleteRefusalText } from '../../src/lib/worldLabsWaiting';

/**
 * GM, PR #198 r5 item 3: "one line only, the backend's named line …. Never
 * put the generic "Couldn’t delete the node." in front of it. Rule: when a
 * specific line exists, the generic one never shows as well."
 */

const NAMED = "Couldn’t delete “Agent scene”. “Shot 2” is still running. Stop the run first.";

describe('the rule', () => {
  it('a named reason alone, under a generic heading or one with the same failure', () => {
    expect(isNamedLine(NAMED)).toBe(true);
    expect(isNamedLine('Stop the run first.')).toBe(false);
    expect(headedLine("Couldn’t delete the node.", NAMED)).toBe(NAMED);
    expect(headedLine("Couldn’t delete 2 nodes.", NAMED)).toBe(NAMED);
    expect(headedLine("Couldn’t delete “Agent scene”.", NAMED)).toBe(NAMED);
    expect(oneLine({ heading: "Couldn’t delete the node.", reason: NAMED })).toBe(NAMED);
  });

  it('a heading that names something the reason doesn\'t stays', () => {
    expect(headedLine("Couldn't run “Hero still”.", "Couldn't reach Krea.")).toBe("Couldn't run “Hero still”. Couldn't reach Krea.");
    expect(headedLine("Couldn’t delete the node.", 'It is locked.')).toBe("Couldn’t delete the node. It is locked.");
    expect(headedLine('', NAMED)).toBe(NAMED);
    expect(headedLine("Couldn’t delete the node.", '')).toBe("Couldn’t delete the node.");
  });

  it('a refused request\'s own message follows it', () => {
    expect(new RequestFailedError("Couldn’t delete the node.", 409, { detail: NAMED }).message).toBe(NAMED);
  });

  it('the canvas\'s delete refusals', () => {
    expect(deleteRefusalText("Couldn’t delete the node.", 1, [NAMED])).toBe(NAMED);
    expect(deleteRefusalText("Couldn’t delete 2 nodes.", 2, [NAMED, NAMED])).toBe(NAMED);
  });
});

/**
 * The ratchet (review 5, L4): every place that writes a heading and a reason
 * into one line goes through headedLine (oneLine, failureMessage, …), so the
 * rule holds there. It finds, across src/:
 * - a template literal where a failure sentence ("Couldn't …", "Can't …",
 *   "Cannot …", "Nebula couldn't …", "Nebula can't …", ending in ".") is
 *   followed by an interpolation, or `${heading} ${…}`;
 * - a string literal holding such a sentence joined to more with `+`;
 * - such a literal inside `[…].join(' ')`.
 * Each hand-built line below is reviewed: the text it matched, and why it
 * can't double (its tail is fixed copy, or never a line of its own).
 */
const HAND_BUILT: { file: string; text: string; why: string }[] = [
  { file: 'lib/errorCopy.ts', text: '`${heading} ${reason}`', why: 'headedLine itself: the one place the rule is applied' },
  { file: 'lib/errorCopy.ts', text: '`Nebula couldn’t ${what} because this window isn’t connected as you. ${fix}`',
    why: "GM's because form (PR #204 r6) in the desktop window: the tail is one of its two fixed sentences" },
  { file: 'lib/errorCopy.ts', text: '`${GENERATE_HEADING} ${CLUSTER_NOT_ADDED} ${personRequiredCopy(desktop, reason)}`',
    why: "GM's Generate refusal, nodes not added (PR #204 r8, GM r10 3; heading GM r12 2): two fixed sentences, then personRequiredCopy's fixed sentences" },
  { file: 'lib/worldLabsWaiting.ts', text: '`${heading} ${WORLD_LABS_NEEDS_CHECK}`',
    why: "GM's own World Labs line: the tail is a fixed sentence, never a named line" },
  { file: 'lib/settingsWrites.ts', text: "`Nebula couldn’t save ${it}, but your Keychain has it. ${fix || 'Try again, or remove it.'}`",
    why: "GM's Keychain line (PR #203 r28 item 2, r29 item 6): the tail is GM's fixed sentence or the backend's fix sentence, never a named line" },
  { file: 'lib/worldLabsWaiting.ts', text: '`${heading} It${RECOVERY_ID_FORGET_TAIL}`',
    why: "GM's own World Labs line: the tail is a fixed sentence" },
  { file: 'lib/worldLabsWaiting.ts', text: '`Couldn\'t delete them. ${waiting} waiting on World Labs. Check Marble, then ${then}`',
    why: "GM's own World Labs line: the interpolations are its fixed words" },
  // GM r39 item 2's "Couldn’t …. You can …" run-lock lines are gone: PR #205 r1 answer 2 made
  // the key-press refusals the lock line alone (lib/cinemaScene runLockedLine), no heading.
  { file: 'store/graphStore.ts', text: '`${heading} ${REFUSED_FALLBACK_COPY}`', why: 'the fixed fallback after a heading' },
  { file: 'store/graphStore.ts', text: '`${heading} ${err.raw}`', why: "the Agent log's raw form (agents read the raw text)" },
  { file: 'lib/cinemaScene.ts', text: '`Couldn’t delete “${scene}”. ${text} ${several ? \'are\' : \'is\'} still running. ${shots.stoppable ? STOP_FIRST : WAIT_FOR_IT}`',
    why: "GM's own scene line: the interpolations are names and its fixed words" },
  // PR #195's lines, reviewed in the merge with #198: each tail is GM's own
  // fixed "is opening" or "isn't answering" sentence, never a failure line.
  { file: 'lib/canvasFollow.ts', text: '`Couldn\'t run ${what}. ${followingReason({ agent, projectName: project })}`',
    why: 'GM\'s following line (#195 round 21): the tail is "<agent> is opening “<project>”."' },
  { file: 'lib/canvasFollow.ts', text: '`${CREATE_WHILE_FOLLOWING_HEADING} ${followingReason(switching)}`',
    why: 'GM\'s following line for Create: the tail is the same fixed "is opening" sentence' },
  { file: 'lib/deleteCopy.ts', text: '`Couldn\'t delete ${nodeNameList(names)}. ${DELETE_NO_ANSWER_REASON}`',
    why: 'GM\'s no-answer delete line (#195; #200\'s form since the merge): the tail is a fixed sentence' },
  { file: 'components/canvas/PinComposer.tsx', text: '`${headingText} ${targetNode}`',
    why: 'PR #200\'s note composer: an accessible name (the heading and the node id when two cards share a title), never a failure line' },
  { file: 'lib/canvasFileDrop.ts', text: '`Couldn\'t add ${quoted(failure.name)}. ${DROP_TYPES_LINE}`', why: 'the tail is a fixed sentence' },
  { file: 'store/providerReadinessStore.ts', text: '`${CHECK_HEADING} ${REFUSED_FALLBACK_COPY}`', why: 'the fixed fallback after a heading' },
  { file: 'lib/studioBoundary.ts', text: '`Couldn’t open ${subject}. ${damaged ? STUDIO_DAMAGED : STUDIO_NEUTRAL}`', why: 'the tail is one of two fixed sentences' },
  { file: 'lib/studioBoundary.ts', text: '`Couldn’t show ${label ? `“${label}”` : \'this node\'}. ${damaged ? CARD_DAMAGED : CARD_NEUTRAL}`',
    why: 'the tail is one of two fixed sentences' },
  { file: 'lib/studioBoundary.ts', text: '`Couldn’t open ${label ? `“${label}”` : \'a node\'}${where}, node ${nodeId}. ${what}`',
    why: 'Agent log: the tail is a field sentence ("scene.base is missing.")' },
  { file: 'lib/studioBoundary.ts', text: '`Couldn’t draw ${label ? `“${label}”` : \'a node\'}, node ${nodeId}. ${errorText(error)}`',
    why: "Agent log: the tail is the error's own message, for agents" },
  { file: 'lib/studioBoundary.ts', text: '`Couldn’t open ${label ? `“${label}”` : \'a node\'} in ${STUDIO_PLACE[studio]}, node ${nodeId}. ${errorText(error)}`',
    why: "Agent log: the tail is the error's own message, for agents" },
  // Round 5's whole-save refusals (GM r7 item 1, lib/sceneSaveCopy.ts): GM's
  // heading over one of GM's own fixed suffixes, never a backend line (the
  // backend's lines go through headedLine in sceneRefusal).
  // GM r32 answer 2: the "other" stop line, GM's heading over the reason the
  // single line already had (copyForAnswer's), merged for several scenes.
  { file: 'lib/sceneSaveCopy.ts', text: "`Nebula couldn’t save your changes to ${quotedNames(scenes, 'scenes')}. ${reason}`",
    why: "GM's heading over the line's own reason (GM r32 answer 2)" },
  // PR #198 fix round 8 (GM r11 answer 3): the stopped-after-8 line. Round 19
  // (GM r28 item 2): the state slot's merged line, with GM's subject-and-comma fix.
  { file: 'lib/sceneSaveCopy.ts', text: '`Nebula couldn’t save your changes to ${names}. ${KEPT_UNTIL_NEXT_CHANGE}`', why: "GM's own line over GM's fixed suffix (GM r28 item 2)" },
  // GM r29 Q1 (round 20): the retrying line, the same form in the present tense.
  { file: 'lib/sceneSaveCopy.ts', text: '`Nebula couldn’t save your changes to ${names}. ${KEPT_AND_TRYING}`', why: "GM's own line over GM's fixed suffix (GM r29 Q1)" },
  // PR #210 (review 10 NIT-5, round 6l): the board save lines are built around a constant opening.
  { file: 'components/moodboard-studio/boardSaveLine.ts', text: '`${NOT_SAVED_OPENING}${line.cause}. ${line.step}`',
    why: "GM r16's board save lines: the cause and the step are GM's fixed pairs (SAVE_LINES), never a server line" },
  // PR #210 round 6t (GM r113 2): a replayed save that failed on a board the person isn't on, named, under the Restore's confirmation.
  { file: 'components/moodboard-studio/boardSaveLine.ts', text: '`Nebula couldn’t save your change to ${what} because ${line.cause}. ${line.step}`',
    why: "GM r113 2's exact line: the board's quoted name over one of GM r16's fixed cause and step pairs (SAVE_LINES), never a server line" },
  { file: 'components/moodboard-studio/boardSaveLine.ts',
    text: "`${LOST_ADD_OPENING}${what} because the board hadn’t loaded. ${names.length > 1 ? 'Add them again.' : 'Add it again.'}`",
    why: "GM r16 7a's lost add line: the names are quoted file names, the tail one of two fixed steps" },
  // Seen once constant openings were read (round 6l): two older lines, each a fixed heading over a fixed tail.
  { file: 'lib/cinemaMotion.ts', text: '`${UNCONFIRMED} ${NO_RESPONSE_SHORT_COPY}`',
    why: 'the fixed "Couldn\'t confirm the video connection." over the fixed "Nebula didn\'t respond."' },
  { file: 'lib/graphFile.ts', text: '`${SAVE_GRAPH} ${graphSizeLine(blob.size, GRAPH_BUNDLE_MAX_IMPORT_BYTES)}`',
    why: 'the fixed "Couldn\'t save the graph." over graphSizeLine\'s fixed size sentences, never a line of its own' },
    // The Agent log's raw save line: agents read the backend's own detail,
    // with the status and code (GM #198 r12 answer 1, round 13).
  { file: 'store/graphStore.ts', text: "`Couldn’t save “${label}”, node ${nodeId}: HTTP ${status}${code ? ` ${code}` : ''}. ${detail || 'No detail.'}`",
    why: "the Agent log's raw form (agents read the raw text, the status and the code)" },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) ? [path] : [];
  });
}

/** A failure sentence that a reason could follow. */
const FAILURE = String.raw`(?:Nebula )?(?:Couldn['’]t|couldn['’]t|Can['’]t|can['’]t|Cannot) `;
/** Text any hit holds: a failure sentence's opening, or a heading slot. */
const MAY_HIT = /[Cc]ouldn['’]t|[Cc]an['’]t|Cannot|heading/i;
/** Placeholder for an interpolation inside a template's text. */
const SLOT = '\u0000';

/** The hand-built "heading reason" lines in `text`, as their source, read
 * with the TypeScript parser (as scripts/check-inline-styles.mjs reads
 * components), so regex literals and comments can't hide one. */
function handBuilt(text: string): string[] {
  const file = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // A sentence that opens the text, follows another or follows a slot ("${name} can't …").
  const sentenceThenSlot = new RegExp(`(?<=^|[.!?]\\s|${SLOT}\\s?)${FAILURE}[^.${SLOT}]*(?:${SLOT}[^.${SLOT}]*)*\\.\\s+${SLOT}`);
  const failureSentence = new RegExp(`^${FAILURE}[^]*\\.\\s*$`);
  const isFailureLiteral = (node: ts.Node) => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && new RegExp(`^${FAILURE}`).test(node.text);
  // Review 10 NIT-5 (round 6l): a line built around a constant opening (`${NOT_SAVED_OPENING}${cause}. ${step}`)
  // is read with the opening's text in place, so it is seen like a literal one: a string constant
  // declared at the file's top level, opening the template, stands for its text. (A constant later
  // in the line stays a slot: a fixed tail, such as `${RUN_LOCK_REASON}`, is what the reviewed entries name.)
  const constants = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer;
      if (ts.isIdentifier(declaration.name) && value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
        constants.set(declaration.name.text, value.text);
      }
    }
  }
  const slotOf = (node: ts.TemplateExpression, index: number) => {
    const { expression } = node.templateSpans[index];
    return index === 0 && node.head.text === '' && ts.isIdentifier(expression) ? constants.get(expression.text) ?? SLOT : SLOT;
  };
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node)) {
      const shape = node.head.text + node.templateSpans.map((span, index) => slotOf(node, index) + span.literal.text).join('');
      const first = node.templateSpans[0];
      const headingFirst = node.head.text === '' && /heading/i.test(first.expression.getText(file)) && /^ \S/.test(first.literal.text + (node.templateSpans[1] ? SLOT : ''));
      if (sentenceThenSlot.test(shape) || headingFirst) hits.push(node.getText(file));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && (ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left)) && failureSentence.test(node.left.text)) {
      // A failure sentence in a string literal, joined to more with `+`.
      hits.push(node.getText(file));
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'join' && ts.isArrayLiteralExpression(node.expression.expression)
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === ' '
      && node.expression.expression.elements.some(isFailureLiteral)) {
      // Such a literal inside `[…].join(' ')`.
      hits.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

describe('ratchet: no new hand-built "heading reason" lines', () => {
  it('the scanner sees each spelling the review named', () => {
    expect(handBuilt('const a = `Couldn’t connect the video node. ${shortReason(x)}`;')).toHaveLength(1);
    expect(handBuilt('const a = `Couldn\'t ${action} that. ${reason}`;')).toHaveLength(1);
    expect(handBuilt('const a = `${heading} ${why}`;')).toHaveLength(1);
    expect(handBuilt('const a = `${addHeading(name)} ${why}`;')).toHaveLength(1);
    expect(handBuilt("const a = \"Couldn’t save the board. \" + reason;")).toHaveLength(1);
    expect(handBuilt("const a = [\"Couldn’t save the board.\", reason].join(' ');")).toHaveLength(1);
    expect(handBuilt('const a = `Nebula can\'t read ${name}. ${tail}`;')).toHaveLength(1);
    // A constant opening (review 10 NIT-5): seen as its text.
    expect(handBuilt('const OPENING = \'Nebula couldn’t save the board because \';\nconst a = `${OPENING}${cause}. ${step}`;')).toHaveLength(1);
    expect(handBuilt('const OPENING = \'Nebula couldn’t add \';\nconst a = `${OPENING}${what} because it failed. ${tail}`;')).toHaveLength(1);
    expect(handBuilt('const OPENING = \'Kept \';\nconst a = `${OPENING}${what}. ${tail}`;')).toHaveLength(0);
    // Not a heading-plus-reason: an interpolation inside the one sentence.
    expect(handBuilt('const a = `Couldn\'t upload ${name}.`;')).toHaveLength(0);
    expect(handBuilt('const a = `Couldn’t save ${what} for “${node}”.${tail}`;')).toHaveLength(0);
  });

  // Review 23 NIT-2: it parses source files with the TypeScript parser
  // (about 0.5 s alone, dominated by graphStore.ts) and once passed vitest's
  // 5 s default under the full suite's parallel load: its own 30 s bound.
  // Every hit holds a failure word or a `heading` slot, so a file whose
  // text has neither is skipped unparsed (the same hits, a little faster).
  it('only the reviewed ones', { timeout: 30_000 }, () => {
    const root = join(__dirname, '../../src');
    const unknown: string[] = [];
    for (const file of sources(root)) {
      const name = relative(root, file);
      const text = readFileSync(file, 'utf8');
      if (!MAY_HIT.test(text)) continue;
      for (const hit of handBuilt(text)) {
        if (!HAND_BUILT.some((entry) => entry.file === name && entry.text === hit)) unknown.push(`${name}: ${hit}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('every reviewed entry is still there (none stale)', () => {
    const root = join(__dirname, '../../src');
    const stale = HAND_BUILT.filter((entry) => !handBuilt(readFileSync(join(root, entry.file), 'utf8')).includes(entry.text));
    expect(stale.map((entry) => `${entry.file}: ${entry.text}`)).toEqual([]);
  });
});

/**
 * #210 round 6m (GM r53 Q1): person copy uses the curly apostrophe (’), never
 * the straight one ("Couldn't" slipped through on the Restore project line).
 * The house lines GM writes are curly; most older lines are straight still,
 * so this is a ratchet: each source file's count of straight apostrophes in
 * person copy is pinned in `straightApostrophes.baseline.json` and may only
 * go down (lower the count when you fix one; a file not listed has none).
 *
 * Person copy, read with the TypeScript parser across src/: string literals,
 * template text and JSX text where a straight apostrophe sits inside a word
 * ("couldn't", "board's"). Exempt by surface:
 * - tests (`*.test.*`, src/test/), which aren't shown;
 * - code: module specifiers, console calls (the console is for developers),
 *   and RegExp sources (a pattern may match either apostrophe), and comments;
 * - `backendText("…")`: the backend's exact words, kept to match a response and never shown
 *   (lib/backendText.ts; tests/lib/backendText.guard.test.ts allows it only as a key of errorCopy's
 *   match tables and checks each against the backend).
 */
const BASELINE_PATH = join(__dirname, 'straightApostrophes.baseline.json');
const STRAIGHT_IN_WORD = /[A-Za-z]'[A-Za-z]/;
/** A possessive or contraction right after an interpolation: `${name}'s` (review 11 NIT-2). */
const STRAIGHT_AFTER_SLOT = /^'[a-z]/;

/** The person copy in `text` that holds a straight apostrophe inside a word, as the literal's text. */
function straightApostrophes(text: string): string[] {
  const file = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const isCodeCall = (node: ts.Node) => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && (callee.text === 'RegExp' || callee.text === 'backendText')) return true;
    if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) return true;
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console';
  };
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (isCodeCall(node)) return;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      ts.forEachChild(node, (child) => { if (child !== node.moduleSpecifier) visit(child); });
      return;
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) && STRAIGHT_IN_WORD.test(node.text)) {
      hits.push(node.text);
    } else if ((ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && STRAIGHT_AFTER_SLOT.test(node.text)) {
      hits.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

/** Each src/ file's count of straight apostrophes in person copy (files with none left out). */
function straightCounts(): Record<string, number> {
  const root = join(__dirname, '../../src');
  const counts: Record<string, number> = {};
  for (const path of sources(root)) {
    const name = relative(root, path);
    if (name.startsWith('test/') || name.endsWith('.d.ts')) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes("'")) continue;
    const found = straightApostrophes(text).length;
    if (found) counts[name] = found;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

describe('ratchet: no new straight apostrophe in person copy (GM r53)', () => {
  it('the scanner sees person copy, and skips code and comments', () => {
    expect(straightApostrophes("const a = \"Couldn't restore the project.\";")).toHaveLength(1);
    expect(straightApostrophes("const a = 'Nebula couldn\\'t restore it.';")).toHaveLength(1);
    expect(straightApostrophes('const a = `The board\'s ${name} is gone.`;')).toHaveLength(1);
    expect(straightApostrophes('const a = `${name} isn\'t answering.`;')).toHaveLength(1);
    // Right after an interpolation (review 11 NIT-2): `${name}'s images`, and in the middle of a template.
    expect(straightApostrophes('const a = `${name}\'s images`;')).toHaveLength(1);
    expect(straightApostrophes('const a = `${a} and ${name}\'s ${b}`;')).toHaveLength(1);
    expect(straightApostrophes('const a = `[data-id=\'${id}\']`;')).toHaveLength(0);
    expect(straightApostrophes("const a = <p>Deleted boards aren't kept.</p>;")).toHaveLength(1);
    expect(straightApostrophes('const a = <button aria-label="Don\'t save">x</button>;')).toHaveLength(1);
    // Curly is the house form.
    expect(straightApostrophes('const a = "Nebula couldn’t restore “Shore”.";')).toHaveLength(0);
    // Code: a comment, a pattern, the console, a module, a quote that isn't inside a word.
    expect(straightApostrophes("// the board's line\n/* it's */ const a = 1;")).toHaveLength(0);
    expect(straightApostrophes("const a = new RegExp(\"couldn't\");")).toHaveLength(0);
    expect(straightApostrophes("const a = backendText(\"couldn't\");")).toHaveLength(0);
    expect(straightApostrophes("console.warn(\"couldn't parse\");")).toHaveLength(0);
    expect(straightApostrophes("import x from \"./it's\";")).toHaveLength(0);
    expect(straightApostrophes("const a = \"[data-id='x']\";")).toHaveLength(0);
  });

  it('each file holds no more straight apostrophes in person copy than its pinned count (and a fixed one lowers it)',
    { timeout: 30_000 }, () => {
      const counts = straightCounts();
      if (process.env.NEBULA_WRITE_APOSTROPHE_BASELINE === '1') writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
      const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>;
      const root = join(__dirname, '../../src');
      const over = Object.entries(counts).filter(([name, count]) => count > (baseline[name] ?? 0))
        .map(([name, count]) => `${name}: ${count} (pinned ${baseline[name] ?? 0}): ${straightApostrophes(readFileSync(join(root, name), 'utf8')).join(' | ')}`);
      expect(over, 'new straight apostrophes in person copy: use ’').toEqual([]);
      const under = Object.entries(baseline).filter(([name, count]) => (counts[name] ?? 0) < count)
        .map(([name, count]) => `${name}: ${counts[name] ?? 0} (pinned ${count}): lower its count`);
      expect(under).toEqual([]);
    });
});

/**
 * #210 round 6o (GM r74): a title or aria-label never holds a colon ("“Coast”:
 * “Rivers”" slipped into the Restore project lines' titles; GM's form is
 * "“Rivers” and “Tide” in “Coast”"). Across src/components/moodboard-studio/,
 * read with the TypeScript parser, the text that can reach a title or an
 * aria-label is:
 * - a JSX `title`, `aria-label` or `ariaLabel` attribute's value;
 * - an object property of those names (`{ text, title: … }`, React Flow's
 *   `ariaLabel`), and `setAttribute('title' | 'aria-label', …)`'s value;
 * - a variable the file declares with that name or passes as such a value
 *   (`{ text, title }`, `title={label}`), read through its initializer.
 * Every string literal and template text in that value counts (a ternary's
 * own `:` is syntax, not text). Older hits are listed below, each reviewed;
 * a new one fails, and a listed one that's gone fails too (drop it).
 */
const COLON_NAMES = new Set(['title', 'aria-label', 'ariaLabel']);
const COLON_REVIEWED: { file: string; text: string; why: string }[] = [
  { file: 'MoodboardBrief.tsx', text: ': pick', why: 'the color field\'s picker, "<label>: pick" (round 6, before GM r74); for GM to reword' },
  { file: 'MoodboardBrief.tsx', text: ': hex', why: 'the color field\'s hex input, "<label>: hex" (round 6, before GM r74); for GM to reword' },
  { file: 'MoodboardListView.tsx', text: 'Open the board on this image. Nothing moves: no image changes number.',
    why: "GM's cover button title (before GM r74); for GM to reword" },
];

/** The literal text holding a colon in each title or aria-label value in `text`. */
function colonsInLabels(text: string): string[] {
  const file = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nameOf = (name: ts.Node) => (ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined);
  const values: ts.Node[] = [];
  const collect = (node: ts.Node) => {
    let value: ts.Node | undefined;
    if (ts.isJsxAttribute(node) && COLON_NAMES.has(node.name.getText(file))) value = node.initializer;
    else if (ts.isPropertyAssignment(node) && COLON_NAMES.has(nameOf(node.name) ?? '')) value = node.initializer;
    else if (ts.isShorthandPropertyAssignment(node) && COLON_NAMES.has(node.name.text)) value = node.name;
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setAttribute'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0]) && COLON_NAMES.has(node.arguments[0].text)) value = node.arguments[1];
    // A DOM property set by assignment: `el.title = …`, `el.ariaLabel = …` (review 11 NIT-1).
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && COLON_NAMES.has(node.left.name.text)) value = node.right;
    // A variable named title or aria-label is read even when it is passed on some other way.
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && COLON_NAMES.has(node.name.text) && node.initializer) value = node.initializer;
    if (value) values.push(value);
    ts.forEachChild(node, collect);
  };
  collect(file);
  /** What a name stands for: the initializer of the variable it names in its own scope (none for a parameter). */
  const declarationOf = (id: ts.Identifier): ts.Expression | undefined => {
    for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === id.text)) return undefined;
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const found = statement.declarationList.declarations.find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === id.text);
        if (found) return found.initializer;
      }
    }
    return undefined;
  };
  const hits: string[] = [];
  const seen = new Set<ts.Node>();
  const read = (node: ts.Node) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      if (node.text.includes(':')) hits.push(node.text);
      return;
    }
    // `line.title` is checked where its title is written, a function where it is called: neither is read here.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      // A chained call reads the call it chains on (`names.map(…).join()`).
      if (ts.isPropertyAccessExpression(node.expression) && ts.isCallExpression(node.expression.expression)) read(node.expression.expression);
      // A callback passed inline is read too (review 11 NIT-1, live LOW-2: `names.map((name) => \`Board: ${name}\`)`):
      // its expression body, or what its own returns give (a function nested inside it is its own).
      node.arguments.forEach((argument) => {
        if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) {
          read(argument);
          return;
        }
        if (!ts.isBlock(argument.body)) {
          read(argument.body);
          return;
        }
        const returns = (inner: ts.Node) => {
          if (ts.isFunctionLike(inner)) return;
          if (ts.isReturnStatement(inner) && inner.expression) read(inner.expression);
          ts.forEachChild(inner, returns);
        };
        ts.forEachChild(argument.body, returns);
      });
      return;
    }
    if (ts.isIdentifier(node)) {
      const initializer = declarationOf(node);
      if (initializer) read(initializer);
      return;
    }
    ts.forEachChild(node, read);
  };
  values.forEach(read);
  return hits;
}

function moodboardStudioSources(): { name: string; text: string }[] {
  const root = join(__dirname, '../../src/components/moodboard-studio');
  return sources(root).map((path) => ({ name: relative(root, path), text: readFileSync(path, 'utf8') }));
}

describe('ratchet: no colon in a title or aria-label in the Moodboard Studio (GM r74)', () => {
  it('the scanner sees each place a title or aria-label is written', () => {
    expect(colonsInLabels('const a = <div title="Board: Rivers" />;')).toEqual(['Board: Rivers']);
    expect(colonsInLabels('const a = <div aria-label={`${label}: pick`} />;')).toEqual([': pick']);
    expect(colonsInLabels('const a = <Card ariaLabel={on ? \'Shown: yes\' : \'Hidden\'} />;')).toEqual(['Shown: yes']);
    // The colon round 6n wrote: an object property.
    expect(colonsInLabels('function f() { return { text, title: `${title}: ${kept.title}` }; }')).toEqual([': ']);
    expect(colonsInLabels("const a = { 'aria-label': 'Close: now' };")).toEqual(['Close: now']);
    expect(colonsInLabels("el.setAttribute('title', `${a}: ${b}`);")).toEqual([': ']);
    // Through a variable: the shorthand `{ title }`, an attribute's name, a constant.
    expect(colonsInLabels('const title = `${a}: ${b}`;\nconst x = { text, title };')).toEqual([': ']);
    expect(colonsInLabels('const label = `${a}: ${b}`;\nconst x = <p title={label} />;')).toEqual([': ']);
    expect(colonsInLabels("const SEP = ': ';\nconst x = { title: a + SEP + b };")).toEqual([': ']);
    // Not a title: the text, other attributes, a ternary's own colon, another object's `title` read.
    expect(colonsInLabels('const a = <p title={on ? \'Shown\' : \'Hidden\'}>Note: this</p>;')).toEqual([]);
    expect(colonsInLabels("const a = { text: 'Note: this', title: 'Shown' };")).toEqual([]);
    expect(colonsInLabels("const a = <p data-x='a:b' className='x:y' title={line.title} />;")).toEqual([]);
    expect(colonsInLabels("const label = 'Note: this';\nconst a = <p>{label}</p>;")).toEqual([]);
    // A name is read in its own scope; a parameter, a function's body and another `label` aren't.
    expect(colonsInLabels("const x = <p title={reason('add: images')} />;")).toEqual(['add: images']);
    expect(colonsInLabels("const f = () => 'a: b';\nconst x = <p title={f()} />;")).toEqual([]);
    expect(colonsInLabels("const label = 'x: y';\nfunction f(label) { return <p title={label} />; }")).toEqual([]);
    expect(colonsInLabels("function a() { const label = 'x: y'; return label; }\nfunction b() { const label = 'ok'; return <p title={label} />; }"))
      .toEqual([]);
    expect(colonsInLabels("function b() { const label = 'x: y'; return <p title={label} />; }")).toEqual(['x: y']);
    expect(colonsInLabels("const line = { text: 'Note: this', title: 'Shown' };\nconst x = <p title={line.title} />;")).toEqual([]);
    // GM r74's form passes.
    expect(colonsInLabels('function f() { return { text, title: `${kept.title} in ${title}` }; }')).toEqual([]);
    // Review 11 NIT-1: an inline callback inside a title value, and the DOM property forms.
    expect(colonsInLabels('function f(names) { return { title: joinWithAnd(names.map((name) => `Board: “${name}”`)) }; }')).toEqual(['Board: “']);
    expect(colonsInLabels('const t = { title: names.map(function (name) { return `${name}: x`; }).join() };')).toEqual([': x']);
    expect(colonsInLabels("const t = { title: names.map((name) => { const f = () => 'a: b'; return name; }) };")).toEqual([]);
    expect(colonsInLabels("el.title = 'x: y';")).toEqual(['x: y']);
    expect(colonsInLabels('el.ariaLabel = `${a}: b`;')).toEqual([': b']);
    expect(colonsInLabels("el.textContent = 'x: y';")).toEqual([]);
  });

  it('only the reviewed ones (a new colon fails), and none stale', () => {
    const files = moodboardStudioSources();
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap(({ name, text }) => colonsInLabels(text).map((hit) => ({ file: name, text: hit })));
    const unknown = found.filter((hit) => !COLON_REVIEWED.some((entry) => entry.file === hit.file && entry.text === hit.text));
    expect(unknown.map((hit) => `${hit.file}: ${JSON.stringify(hit.text)}`), 'a colon in a title or aria-label: say it in words (GM r74)').toEqual([]);
    const stale = COLON_REVIEWED.filter((entry) => !found.some((hit) => hit.file === entry.file && hit.text === entry.text));
    expect(stale.map((entry) => `${entry.file}: ${entry.text}`)).toEqual([]);
  });
});

/**
 * #210 round 6q (GM r95.5): a person line that counts boards says
 * "moodboards" ("Restored “Coast”. Your changes to 4 moodboards are saved.",
 * "Delete all 4 moodboards for good?"), never "4 boards". Across src/ (not
 * tests), read with the TypeScript parser, the person copy (string literals,
 * template text, JSX text; never a comment, a pattern, the console or a
 * module) counts boards when:
 * - its text holds a number then "boards" ("4 boards");
 * - its text right after an interpolation starts with "boards" or is "board"
 *   before another (`${n} boards`, `${n} board${s}`), or JSX text after an
 *   expression does (`{n} boards`);
 * - it is the bare noun "boards", which a line could put after a count
 *   (`${n} ${noun}`): each such literal is reviewed below as not a count; a
 *   new one fails, and a listed one that's gone fails too (drop it).
 */
const BOARDS_REVIEWED: { file: string; text: string; why: string }[] = [
  { file: 'components/asset-trash/AssetTrash.tsx', text: 'boards',
    why: 'NOUNS.moodboard.many: "Recently deleted boards" and "Deleted boards stay here …" (GM\'s words), no count; the count reads `counted`' },
  { file: 'components/moodboard-studio/MoodboardStudioView.tsx', text: 'boards', why: 'a Restore confirmation\'s slot key, not copy' },
];

/** The person copy in `text` that counts boards, as the literal's text. */
function countedBoards(text: string): string[] {
  const file = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const isCodeCall = (node: ts.Node) => {
    if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'RegExp') return true;
    if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) return true;
    return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'console';
  };
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (isCodeCall(node)) return;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      ts.forEachChild(node, (child) => { if (child !== node.moduleSpecifier) visit(child); });
      return;
    }
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
    if (literal) {
      const afterSlot = ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      const jsxAfterExpression = ts.isJsxText(node) && (() => {
        const siblings = (node.parent as ts.JsxElement | ts.JsxFragment).children;
        const at = siblings ? siblings.indexOf(node) : -1;
        return at > 0 && ts.isJsxExpression(siblings[at - 1]);
      })();
      const counts = /\d\s+boards\b/i.test(node.text)
        || ((afterSlot || jsxAfterExpression) && /^\s*boards\b/i.test(node.text))
        || (ts.isTemplateMiddle(node) && /^\s*board$/i.test(node.text))
        || ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^\s*boards\s*$/i.test(node.text));
      if (counts) hits.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

describe('ratchet: a person line counts "moodboards", never "boards" (#210 round 6q, GM r95.5)', () => {
  it('the scanner sees each way a line could count boards', () => {
    expect(countedBoards('const a = `Restored ${what}. Your changes to ${n} boards are saved.`;')).toEqual([' boards are saved.']);
    expect(countedBoards("const a = 'Your changes to 4 boards are saved.';")).toEqual(['Your changes to 4 boards are saved.']);
    expect(countedBoards('const a = `${n} board${n === 1 ? \'\' : \'s\'}`;')).toEqual([' board']);
    expect(countedBoards('const a = <p>{count} boards</p>;')).toEqual([' boards']);
    expect(countedBoards("const NOUN = { many: 'boards' };")).toEqual(['boards']);
    // The noun `namedBoards` took before round 6q (its default), planted back: found.
    expect(countedBoards("function namedBoards(names, noun = 'boards') { return `${names.length} ${noun}`; }")).toEqual(['boards']);
    // Not a count: "moodboards", a board's own words, a comment, a pattern, a module.
    expect(countedBoards('const a = `Restored ${what}. Your changes to ${n} moodboards are saved.`;')).toEqual([]);
    expect(countedBoards("const a = 'Deleted boards stay here until you delete them for good.';")).toEqual([]);
    expect(countedBoards('const a = <p>Deleted {noun} stay here</p>;')).toEqual([]);
    expect(countedBoards('const a = `${who} changed ${what} after you removed them, so they’re still on their boards.`;')).toEqual([]);
    expect(countedBoards('// "4 boards"\n/* 4 boards */ const a = 1;')).toEqual([]);
    expect(countedBoards("const a = new RegExp('4 boards');")).toEqual([]);
    expect(countedBoards("import x from './4 boards';")).toEqual([]);
  });

  it('none in src/ but the reviewed ones (a new one fails), and none stale', { timeout: 30_000 }, () => {
    const root = join(__dirname, '../../src');
    const files = sources(root).filter((path) => !path.endsWith('.d.ts'));
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return /boards?\b/i.test(text) ? countedBoards(text).map((hit) => ({ file: relative(root, path), text: hit })) : [];
    });
    const unknown = found.filter((hit) => !BOARDS_REVIEWED.some((entry) => entry.file === hit.file && entry.text === hit.text));
    expect(unknown.map((hit) => `${hit.file}: ${JSON.stringify(hit.text)}`), 'a line that counts boards: say "moodboards"').toEqual([]);
    const stale = BOARDS_REVIEWED.filter((entry) => !found.some((hit) => hit.file === entry.file && hit.text === entry.text));
    expect(stale.map((entry) => `${entry.file}: ${entry.text}`)).toEqual([]);
  });
});

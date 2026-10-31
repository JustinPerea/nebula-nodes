import { readdirSync, readFileSync, statSync } from 'node:fs';
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
  { file: 'lib/worldLabsWaiting.ts', text: '`${heading} ${WORLD_LABS_NEEDS_CHECK}`',
    why: "GM's own World Labs line: the tail is a fixed sentence, never a named line" },
  { file: 'lib/settingsWrites.ts', text: "`Nebula couldn’t save ${it}, but your Keychain has it. ${fix || 'Try again, or remove it.'}`",
    why: "GM's Keychain line (PR #203 r28 item 2, r29 item 6): the tail is GM's fixed sentence or the backend's fix sentence, never a named line" },
  { file: 'lib/worldLabsWaiting.ts', text: '`${heading} It${RECOVERY_ID_FORGET_TAIL}`',
    why: "GM's own World Labs line: the tail is a fixed sentence" },
  { file: 'lib/worldLabsWaiting.ts', text: '`Couldn\'t delete them. ${waiting} waiting on World Labs. Check Marble, then ${then}`',
    why: "GM's own World Labs line: the interpolations are its fixed words" },
  { file: 'lib/cinemaScene.ts', text: '`Couldn’t ${action}. ${RUN_LOCK_REASON}`', why: 'GM\'s run-lock line: the tail is a fixed sentence' },
  { file: 'lib/cinemaScene.ts', text: '`Couldn’t delete ${what}. ${RUN_LOCK_REASON}`', why: 'GM\'s run-lock line: the tail is a fixed sentence' },
  { file: 'lib/cinemaScene.ts', text: '`Couldn’t delete ${count === 1 ? \'the connection\' : `${count} connections`}. ${RUN_LOCK_REASON}`',
    why: 'GM\'s run-lock line for wires: the tail is a fixed sentence' },
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
  { file: 'lib/directRoute.ts', text: '`${name} can\'t run on ${providerLabel(spec.provider)}${whyPerson(definition, spec, block, params)}. ${fix}${also}`',
    why: 'GM\'s direct-route line: the tail is its own fixed "fix" sentences' },
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
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node)) {
      const shape = node.head.text + node.templateSpans.map((span) => SLOT + span.literal.text).join('');
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

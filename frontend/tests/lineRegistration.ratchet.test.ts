/**
 * PR #204 round 9 (review 7 MEDIUM-1): the one-notice rule reads registrations, not the page's
 * text. A line counts only if the surface renders it through a component that registers it
 * (components/LineText, or FailureLines, CommonsErrorLine, CommonsPageLines and LineBox, which render through it). So this
 * ratchet takes the place of the old scan's "every surface counts":
 *
 * 1. From the trace: every `// clears-on-promote:` site (the lines tests/clearsOnPromote.ratchet
 *    ties to each gated route, through tests/personGatedCallers) is in HOLDERS, with the place
 *    its line renders, and each of those places hands it to a registering component. The Commons
 *    (whose refusals come from lib/commonsApi and lib/commonsChatAuthority, outside the gate's
 *    routes) are in HOLDERS too. A new site fails until it says where its line shows.
 * 2. Structurally, everywhere: no JSX text child reads an error, a refusal, a failure, a notice
 *    or a problem, or calls a sentence helper. Those go through a registering component, so a
 *    line the trace doesn't reach yet still registers. A child that can never hold a line is in
 *    EXEMPT with why.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir = SRC, ext = /\.(ts|tsx)$/): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path, ext);
    return ext.test(name) && !name.includes('.test.') ? [path] : [];
  });
}

/** The components that register what they're handed, and the prop that holds the line. */
export const REGISTERS: Record<string, string> = { LineText: 'text', FailureLines: 'failure', CommonsErrorLine: 'line', LineBox: 'text',
  // Round 12 (GM r20 1): the Commons' page-lines row, which hands its line to CommonsErrorLine.
  CommonsPageLines: 'line' };

const SAYS = /(?:error|refus|fail|notice|problem)/i;
/** Helpers whose call is a sentence (a refusal, a failure, a not-connected line). */
const SENTENCES = /^(?:notConnectedBecause|personRequiredCopy|personLockLine|connectAgentLockCopy|heldProposalLine|heldQuestionsLine|generateStartFailedCopy|personRequiredMessage|markReadRefusedCopy|generateRefusedCopy|commonsNotConnectedCopy|failureMessage|failureCopy|failureUnder|copyForAnswer|copyForStatus|oneLine|shortLine|shortReason|noticeText)$/;

/** The parts of a child expression whose value lands as text: through `&&`, `||`, `??`, `? :` and parentheses. */
function textLeaves(expression: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression)) return textLeaves(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...textLeaves(expression.whenTrue), ...textLeaves(expression.whenFalse)];
  if (ts.isBinaryExpression(expression)) {
    const op = expression.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return textLeaves(expression.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...textLeaves(expression.left), ...textLeaves(expression.right)];
  }
  return [expression];
}

/** Whether a leaf can be a line: it reads a failure-named value or calls a sentence helper. JSX
 * is checked where it is, a literal is the screen's own words, and a `.map(...)` lays out
 * elements (its own children are checked). */
function mayBeLine(leaf: ts.Expression): boolean {
  if (ts.isJsxElement(leaf) || ts.isJsxSelfClosingElement(leaf) || ts.isJsxFragment(leaf)) return false;
  if (ts.isStringLiteralLike(leaf) || ts.isNumericLiteral(leaf)) return false;
  if (ts.isCallExpression(leaf) && ts.isPropertyAccessExpression(leaf.expression) && /^(?:map|flatMap)$/.test(leaf.expression.name.text)) return false;
  let found = false;
  const walk = (node: ts.Node) => {
    if (found || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return;
    if (ts.isIdentifier(node) && (SAYS.test(node.text) || SENTENCES.test(node.text))) found = true;
    else if (ts.isPrivateIdentifier(node) && SAYS.test(node.text)) found = true;
    else ts.forEachChild(node, walk);
  };
  walk(leaf);
  return found;
}

export interface Finding { file: string; line: number; text: string }

/** Every JSX text child (and `dangerouslySetInnerHTML`) that can show a line without registering it. */
export function unregisteredLines(files: { path: string; text: string }[]): Finding[] {
  const found: Finding[] = [];
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const visit = (node: ts.Node) => {
      // A registering component's children lay out the words it registers from its own prop.
      const inRegistering = !!node.parent && ts.isJsxElement(node.parent) && ts.isIdentifier(node.parent.openingElement.tagName)
        && node.parent.openingElement.tagName.text in REGISTERS;
      if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && !inRegistering) {
        for (const leaf of textLeaves(node.expression)) {
          if (mayBeLine(leaf)) found.push({ file: path, line: at(leaf), text: leaf.getText(source) });
        }
      }
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'dangerouslySetInnerHTML') {
        found.push({ file: path, line: at(node), text: node.getText(source) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** The expressions handed to registering components in a file, as source text. */
export function registeredExpressions(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handed: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text in REGISTERS) {
      const prop = REGISTERS[node.tagName.text];
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === prop && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          handed.push(attr.initializer.expression.getText(source));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return handed;
}

interface Shows { file: string; expr: string }

/** The Commons: their refusals (lib/commonsApi sessionLost, lib/commonsChatAuthority) show here. */
const COMMONS: Shows[] = [
  { file: 'components/commons/CommonsView.tsx', expr: 'shownError' },
  { file: 'components/commons/CommonsCloseBatch.tsx', expr: 'error' },
  { file: 'components/commons/CommonsEvaluation.tsx', expr: 'error' },
  { file: 'components/commons/CommonsDetail.tsx', expr: 'error' },
  { file: 'components/commons/CommonsSettings.tsx', expr: 'error' },
  { file: 'components/commons/CommonsReview.tsx', expr: 'error' },
  { file: 'components/commons/CommonsEvaluation.tsx', expr: 'imageError' },
  { file: 'components/commons/CommonsMedia.tsx', expr: 'error' },
];

/**
 * Each site that keeps a line (its `// clears-on-promote:` marker), and where that line shows:
 * the file, and the expression it hands a registering component there. `[]` with a reason for a
 * site that holds no line of its own.
 */
const HOLDERS: Record<string, Shows[] | { none: string }> = {
  banner: { none: 'the general notice itself (PersonRequiredBanner), which never registers' },
  'create.enhance': [{ file: 'components/create-studio/CreateComposer.tsx', expr: 'enhanceError' }],
  'create.style-retry': { none: 'a retry: its line is the style line below, through notify (graph.notify)' },
  'chat.codex-login': [{ file: 'components/panels/ChatPanel.tsx', expr: 'codexLoginError || codexLoginState?.message' }],
  'chat.codex-login-check': [{ file: 'components/panels/ChatPanel.tsx', expr: 'codexLoginError || codexLoginState?.message' }],
  'chat.transcript': [{ file: 'components/panels/ChatPanel.tsx', expr: 'part.text' }],
  'chat.clear-canvas': [{ file: 'components/panels/ChatPanel.tsx', expr: 'notice' }],
  'chat.session': [{ file: 'components/panels/ChatPanel.tsx', expr: 'notice' }],
  'settings.agent-warning': [{ file: 'components/panels/PersonalAgentWarning.tsx', expr: 'error' }],
  'settings.apps': [{ file: 'components/panels/settings/ConnectedApps.tsx', expr: 'error' }],
  'settings.spend-load': [{ file: 'components/panels/settings/AgentSpendSection.tsx', expr: 'error' }],
  'settings.spend-load-retry': { none: 'a retry: its line is settings.spend-load' },
  // Round 10 (GM r17 item 6): a demoted tab shows the never-connected line in the same place.
  'settings.agents-load': [{ file: 'components/panels/settings/PersonalAgentsSection.tsx', expr: 'shownError' }],
  'settings.agents-load-retry': { none: 'a retry: its line is settings.agents-load' },
  'settings.agents': [{ file: 'components/panels/settings/PersonalAgentsSection.tsx', expr: 'shownError' }],
  // useSettingsDraftStore errors[id], by the row that wrote it.
  'settings.write': [
    { file: 'components/panels/settings/KeyRow.tsx', expr: 'error' },
    { file: 'components/panels/settings/StorageTab.tsx', expr: 'telemetryError' },
    { file: 'components/panels/settings/PreferencesTab.tsx', expr: 'costError' },
  ],
  // Round 10 (GM r17 item 5): a favorite the server refused no longer drops silently.
  'inspector.favorite': [{ file: 'components/panels/Inspector.tsx', expr: 'favoriteError' }],
  'krea.connection': [{ file: 'components/panels/settings/KreaSignInRow.tsx', expr: 'problem' }],
  'krea.plans': [{ file: 'components/panels/settings/KreaSignInRow.tsx', expr: 'error' }],
  'studio.save-board': [{ file: 'components/moodboard-studio/MoodboardStudioView.tsx', expr: 'saveError' }],
  'studio.undo-redo': [{ file: 'components/moodboard-studio/MoodboardStudioView.tsx', expr: 'saveError' }],
  'studio.brief': [{ file: 'components/moodboard-studio/MoodboardStudioView.tsx', expr: 'saveError' }],
  'studio.draft': [
    { file: 'components/moodboard-studio/MoodboardStudioView.tsx', expr: 'saveError' },
    { file: 'components/character-studio/CharacterStudioView.tsx', expr: 'saveError' },
  ],
  // AgentNotesCorner hands useAgentNotesStore's error to the list.
  'notes.corner': [{ file: 'components/agent-notes/AgentNotesList.tsx', expr: 'error' }],
  'notes.read': [{ file: 'components/agent-notes/AgentNotesList.tsx', expr: 'error' }],
  'notes.read-retry': { none: 'a retry: its line is notes.read' },
  'notes.dismiss': [{ file: 'components/agent-notes/AgentNotesList.tsx', expr: 'error' }],
  trash: [{ file: 'components/asset-trash/AssetTrash.tsx', expr: 'error' }],
  'pins.add': [{ file: 'components/canvas/PinComposer.tsx', expr: 'errorLeave.shown' }],
  'pins.remove': [{ file: 'components/canvas/PinComposer.tsx', expr: 'errorLeave.shown' }],
  'pins.refusal': [{ file: 'components/canvas/PinComposer.tsx', expr: 'errorLeave.shown' }],
  'asset-proposals.decide': [{ file: 'components/proposals/AssetProposalStrip.tsx', expr: 'error' }],
  'questions.answer': [{ file: 'components/agent-notes/AgentQuestionsForm.tsx', expr: 'error' }],
  'questions.dismiss': [{ file: 'components/agent-notes/AgentQuestionsForm.tsx', expr: 'error' }],
  'canvas-proposals.refusal': [{ file: 'components/canvas/ProposalBar.tsx', expr: 'errorLeave.shown' }],
  'canvas-proposals.accept': [{ file: 'components/canvas/ProposalBar.tsx', expr: 'errorLeave.shown' }],
  'canvas-proposals.reject': [{ file: 'components/canvas/ProposalBar.tsx', expr: 'errorLeave.shown' }],
  'project.error': [
    { file: 'components/projects/ProjectHome.tsx', expr: 'shortLine(error!)' },
    { file: 'components/projects/ProjectHome.tsx', expr: 'error' },
  ],
  'project.load-retry': { none: 'a retry: its line is project.error' },
  'project.save': [{ file: 'components/create-studio/ResultCard.tsx', expr: 'saveError' }],
  'project.save-retry': { none: 'a retry: its line is project.save' },
  'graph.refusal': [
    { file: 'components/nodes/NodeError.tsx', expr: 'copy.reason' },
    { file: 'components/canvas/CanvasUndoNotice.tsx', expr: 'shown.text' },
  ],
  'graph.notify': [
    { file: 'components/canvas/CanvasUndoNotice.tsx', expr: 'shown.text' },
    { file: 'components/canvas/CanvasMessageNotice.tsx', expr: 'shown.text' },
  ],
  'graph.undo-refusal': [{ file: 'components/canvas/CanvasUndoNotice.tsx', expr: 'shown.text' }],
  'graph.run-start': [{ file: 'components/nodes/NodeError.tsx', expr: 'copy.reason' }],
  'graph.shot-start': [{ file: 'components/nodes/NodeError.tsx', expr: 'copy.reason' }],
  'cinema.scene-save-retry': { none: 'a retry: its line is the scene save\'s notify (graph.notify)' },
  // Round 9: the Commons' lines clear on the promote (components/commons/useCommonsLine).
  'commons.line': COMMONS,
  'commons.reload-retry': { none: 'a retry: the load runs again; its line is commons.line' },
};


/** Text children that read a failure-named value but can never hold a not-connected line. */
const EXEMPT: Record<string, string> = {
  'components/moodboard-studio/MoodboardStudioView.tsx: notices': 'a block of elements, each line in it a FailureLines',
};

const markerSites = (): string[] => {
  const sites = new Set<string>();
  for (const path of sourceFiles()) {
    for (const match of readFileSync(path, 'utf8').matchAll(/\/\/ clears-on-promote: ([\w.-]+)/g)) sites.add(match[1]);
  }
  return [...sites].sort();
};

const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('PR #204 round 9: every line that can be not-connected registers itself', () => {
  it('every site the trace keeps a line for says where it shows, and only those', () => {
    const sites = markerSites();
    expect(sites.length).toBeGreaterThan(40);
    expect(sites).toEqual(Object.keys(HOLDERS).sort());
  });

  it('each of those places hands its line to a registering component', () => {
    const wrong: string[] = [];
    const places = Object.values(HOLDERS).flatMap((shows) => (Array.isArray(shows) ? shows : []));
    for (const { file, expr } of places) {
      if (!registeredExpressions(file, read(file)).includes(expr)) wrong.push(`${file}: ${expr}`);
    }
    expect(wrong).toEqual([]);
  });

  it('no JSX text child shows an error, refusal, failure, notice or problem without registering it', () => {
    const files = sourceFiles(SRC, /\.tsx$/).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));
    const found = unregisteredLines(files).map((f) => `${f.file}: ${f.text}`).filter((key) => !(key in EXEMPT));
    expect(found).toEqual([]);
    // Every exemption still matches something.
    const all = new Set(unregisteredLines(files).map((f) => `${f.file}: ${f.text}`));
    expect(Object.keys(EXEMPT).filter((key) => !all.has(key))).toEqual([]);
  });

  it('the registering components render through LineText', () => {
    for (const file of ['components/failure/FailureLines.tsx', 'components/commons/CommonsErrorLine.tsx', 'components/commons/CommonsPageLines.tsx', 'components/LineBox.tsx']) {
      expect(registeredExpressions(file, read(file)).length, file).toBeGreaterThan(0);
    }
    // Round 10 (review 8 MEDIUM-3): registered once, its words updated in place.
    expect(read('components/LineText.tsx')).toMatch(/registerLine\(element, words\)/);
    expect(read('components/LineText.tsx')).toMatch(/registration\.current\?\.update\(words\)/);
  });

  it('catches each way a line can skip it', () => {
    const probe = (text: string) => unregisteredLines([{ path: 'probe.tsx', text }]).map((f) => f.text);
    expect(probe('const A = () => <p>{error}</p>;')).toEqual(['error']);
    expect(probe('const A = () => <p>{shown && shortLine(shown)}</p>;')).toEqual(['shortLine(shown)']);
    expect(probe('const A = () => <p>{a ? load.failure : "x"}</p>;')).toEqual(['load.failure']);
    expect(probe('const A = () => <p>{state.notice ?? "Loading…"}</p>;')).toEqual(['state.notice']);
    expect(probe('const A = () => <p>{personRequiredCopy()}</p>;')).toEqual(['personRequiredCopy()']);
    expect(probe('const A = () => <>{problem}</>;')).toEqual(['problem']);
    expect(probe('const A = () => <p dangerouslySetInnerHTML={{ __html: x }} />;')).toHaveLength(1);
    expect(probe('const A = () => <p><LineText text={error} /><FailureLines failure={saveError} /></p>;')).toEqual([]);
    expect(probe('const A = () => <p title={error}>{"Couldn\'t."}</p>;')).toEqual([]);
    expect(probe('const A = () => <LineText text={shown.text}>{noticeText(shown.text, mono)}</LineText>;')).toEqual([]);
    expect(probe('const A = () => <span>{noticeText(shown.text, mono)}</span>;')).toEqual(['noticeText(shown.text, mono)']);
  });

  it('round 10 (review 8 LOW-1, M22): every helper that words a not-connected line is one the scan follows', () => {
    // Each helper of lib/errorCopy (and the lock helpers) whose words can say "connected as you".
    const helpers = ['notConnectedBecause', 'personRequiredCopy', 'personRequiredMessage', 'markReadRefusedCopy',
      'generateRefusedCopy', 'generateStartFailedCopy', 'commonsNotConnectedCopy', 'personLockLine', 'connectAgentLockCopy',
      'heldProposalLine', 'heldQuestionsLine'];
    for (const name of helpers) {
      const probe = unregisteredLines([{ path: 'probe.tsx', text: `const A = () => <p>{${name}('x')}</p>;` }]).map((f) => f.text);
      expect(probe, name).toEqual([`${name}('x')`]);
    }
  });
});

/**
 * What the backend-text tripwire (tests/backendTextCurl.test.tsx) reads from the source with the TypeScript
 * compiler: every place under src that reads one of the backend's message fields, every call of a helper that
 * hands back a backend detail string, and every read of an agent's own words inside a call or element that curls.
 */
import { join, relative } from 'node:path';
import ts from 'typescript';

export const SRC = join(__dirname, '..', '..', 'src');
const rel = (name: string) => relative(SRC, name).split('\\').join('/');

/**
 * The backend's message fields, as "file: Interface.member" (the interface that declares it; a member of an inline
 * shape counts under the interface around it): the typed fields in lib/wsClient.ts, lib/api.ts, lib/runHistory.ts,
 * types/index.ts, lib/commonsTypes.ts, lib/commonsReviewTypes.ts, lib/settingsNotice.ts, lib/agentNotes.ts, lib/jev.ts, and
 * RequestFailedError's reason, detail and fix. An agent's own words are here too, so a new reader of one is decided on.
 */
export const BACKEND_FIELDS: Record<string, string[]> = {
  'lib/wsClient.ts': ['AgentPresenceEvent.log', 'AgentPresenceEvent.say', 'ProposalNotReady.missing', 'ProposalNotReady.person', 'ProposalView.plan', 'ProposalView.note',
    'ProposalWait.barLine', 'ProposalWait.line', 'ExecutionEvent.notes', 'ExecutionEvent.reason', 'ExecutionEvent.error', 'ExecutionEvent.friendly', 'ExecutionEvent.person',
    'ExecutionEvent.message', 'ExecutionEvent.warning'],
  'lib/api.ts': ['ExecutionValidationError.message', 'ExecutionValidationError.person', 'OutsideSpend.reason', 'AgentSetup.where', 'AgentSetup.steps', 'AgentSetup.warnings',
    'PersonalAgent.note', 'PersonalAgent.billing', 'PersonalAgent.blocked', 'PersonalAgent.message', 'PersonalAgent.termsNote', 'PersonalAgentJob.message',
    'ChatModelCatalog.error', 'ChatModelCatalog.message', 'CodexStatus.message', 'CodexChatGPTLoginState.message', 'ClaudeStatus.message'],
  'lib/runHistory.ts': ['RunRecord.statusNote', 'RunRecord.skippedNodes', 'ProviderRecoveryCheckpoint.warning', 'ProviderStartAmbiguity.message'],
  'types/index.ts': ['NodeData.runNotes', 'NodeData.error', 'NodeData.errorFriendly', 'NodeData.errorPerson', 'NodeData.skipReason', 'CinemaShot.error', 'CinemaShot.errorFriendly',
    'CinemaShot.errorPerson', 'MoodboardAnalysis.summary', 'MoodboardClash.reason', 'MoodboardClash.reasons'],
  'lib/commonsTypes.ts': ['SearchRow.summary', 'Borrowing.reason', 'ReadField.why', 'EffectiveFields.summary', 'EffectiveFields.composition_notes', 'AssetDetail.last_error', 'FolderLink.error'],
  'lib/commonsReviewTypes.ts': ['Explained.why', 'ReviewItem.summary', 'ReviewItem.composition_notes', 'ReviewItem.error'],
  'lib/settingsNotice.ts': ['SettingsNotice.line'],
  'lib/agentNotes.ts': ['AgentNote.text', 'AgentNote.outcome', 'AgentNotePart.text'],
  'lib/jev.ts': ['JevReport.notes'],
  'lib/errorCopy.ts': ['RequestFailedError.reason', 'RequestFailedError.detail', 'RequestFailedError.fix'],
};

/** Helpers that return the backend's detail string (or a line built from it), by name; each is declared in lib/errorCopy.ts. */
export const DETAIL_HELPERS = ['readDetail', 'readRefusal', 'detailText', 'copyForStatus', 'copyForAnswer', 'failureDetails'] as const;

/** The key a call of a detail helper reads under, next to "Interface.member" for a field. */
export const callKey = (name: string) => `call:${name}`;

/** Functions and elements that curl what they are given or what they hold (by name and declaring file). */
export const CURLERS: Record<string, string[]> = {
  becauseLine: ['lib/errorCopy.ts'],
  oneLine: ['lib/errorCopy.ts'],
  curlApostrophes: ['lib/errorCopy.ts'],
  LineText: ['components/LineText.tsx'],
  FailureLines: ['components/failure/FailureLines.tsx'],
};

/** The property names an agent's own words are read under in the agent files. */
export const AGENT_FIELDS = new Set(['note', 'say', 'text', 'status', 'reason', 'outcome', 'label']);

let built: { program: ts.Program; checker: ts.TypeChecker } | null = null;
export function appProgram() {
  if (built) return built;
  const config = ts.getParsedCommandLineOfConfigFile(join(SRC, '..', 'tsconfig.app.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const program = ts.createProgram(config!.fileNames.filter((name) => !/\.test\.tsx?$/.test(name)), config!.options);
  built = { program, checker: program.getTypeChecker() };
  return built;
}

const ownerName = (declaration: ts.Node): string => {
  for (let node: ts.Node | undefined = declaration.parent; node; node = node.parent) {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text;
  }
  return '?';
};

/** The symbol an identifier names, through an import's alias. */
function resolved(checker: ts.TypeChecker, id: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(id);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Whether an identifier is one of CURLERS, by its name and the file that declares it. */
export function isCurlerIdentifier(checker: ts.TypeChecker, id: ts.Identifier): boolean {
  const files = CURLERS[id.text];
  if (!files) return false;
  return (resolved(checker, id)?.declarations ?? []).some((declaration) => files.includes(rel(declaration.getSourceFile().fileName)));
}

/**
 * Every file under src that reads one of `fields` ("file: Interface.member", the interface that declares the member;
 * a member of an inline shape counts under the interface around it), or calls a DETAIL_HELPERS helper:
 * file to the set of "Interface.member" and "call:helper" it reads.
 */
export function readersOfBackendFields(fields: Record<string, string[]>): Map<string, Set<string>> {
  const { program, checker } = appProgram();
  const wanted = new Set(Object.entries(fields).flatMap(([file, members]) => members.map((member) => `${file}: ${member}`)));
  const found = new Map<string, Set<string>>();
  const add = (file: string, key: string) => found.set(file, (found.get(file) ?? new Set()).add(key));
  const note = (symbol: ts.Symbol | undefined, from: ts.SourceFile) => {
    for (const declaration of symbol?.declarations ?? []) {
      const key = `${rel(declaration.getSourceFile().fileName)}: ${ownerName(declaration)}.${symbol!.name}`;
      if (wanted.has(key)) add(rel(from.fileName), key.split(': ')[1]);
    }
  };
  const isWrite = (node: ts.Node) => ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !source.fileName.startsWith(SRC)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && !isWrite(node)) note(checker.getSymbolAtLocation(node.name), source);
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && !isWrite(node)) note(checker.getTypeAtLocation(node.expression).getProperty(node.argumentExpression.text), source);
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) note(checker.getTypeAtLocation(node.parent).getProperty(name.text), source);
      } else if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        if (ts.isIdentifier(callee) && (DETAIL_HELPERS as readonly string[]).includes(callee.text)
          && (resolved(checker, callee)?.declarations ?? []).some((declaration) => rel(declaration.getSourceFile().fileName) === 'lib/errorCopy.ts')) add(rel(source.fileName), callKey(callee.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * The reads of an agent's own words (a property named in AGENT_FIELDS) that sit inside a call or an element that curls:
 * an argument of becauseLine, oneLine or curlApostrophes, or anything inside a LineText or FailureLines. Each is returned
 * as its source text with its line. `isCurler` says whether an identifier is one of CURLERS.
 */
export function curledAgentReads(source: ts.SourceFile, isCurler: (id: ts.Identifier) => boolean): string[] {
  const out: string[] = [];
  const insideCurler = (read: ts.Node): boolean => {
    for (let child: ts.Node = read, node: ts.Node | undefined = read.parent; node; child = node, node = node.parent) {
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
        const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
        if (ts.isIdentifier(tag) && isCurler(tag)) return true;
      }
      if (ts.isCallExpression(node) && node.expression !== child && ts.isIdentifier(node.expression) && isCurler(node.expression)) return true;
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && AGENT_FIELDS.has(node.name.text) && insideCurler(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      out.push(`${rel(source.fileName)}:${line} ${node.getText()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

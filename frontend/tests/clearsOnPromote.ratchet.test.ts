import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callersOf, gatedRoutes, socketRefusalGaps } from './personGatedCallers';

/**
 * GM, PR #204 round 3 (2026-10-30): "on promote, every line whose only reason
 * was 'this tab isn't connected as you' clears at once, wherever it sits", and
 * "a ratchet test or a single 'clears on promote' flag on those lines would
 * keep the next one from sticking". Round 4 (review 2 MEDIUM) widens it to
 * every form of the person gate and checks each call site, not each file:
 *
 * 1. Every backend function behind the person gate is in GATED: whatever
 *    calls `require_person(` in backend/main.py or backend/routes/, a
 *    `Depends(person_only)` route in backend/routes/, whatever calls
 *    `_person_only_refusal(` (person_required for a tab, plain for an agent),
 *    and whatever calls `stop_refusal(`. Each names the registrations that
 *    clear its refusal's lines (SITES), or why it shows none.
 * 2. A registration is a call into lib/clearsOnPromote (or a wrapper of one)
 *    with `// clears-on-promote: <site>` on its line. Every call has one,
 *    every marker sits on a call, every marker is claimed. So deleting any
 *    one registration fails here, whatever else its file still registers.
 * 3. Any frontend file that recognises the person gate's refusal goes
 *    through the mechanism too, or is a classifier listed in CLASSIFIERS.
 * 4. Nothing clears on the promote by its own listener.
 *
 * Round 5 (review 3 MEDIUM-1: Create's two lines had slipped through every list) adds the half
 * that needs no hand-kept map to start from (tests/personGatedCallers.ts):
 *
 * 5. Every backend route behind the gate is found, and every frontend function that sends one
 *    (by its path, through lib/ helpers, to the first store action or component) either keeps
 *    its line with the mechanism (a marked call in its body, or a call to a same-file function
 *    that has one) or is in CALLERS: the registrations that clear its line, or why it shows
 *    none. A new gated call that shows a line fails here until it registers or is declared.
 * 6. Exactly one retry on the promote per kind of request (RETRIES): Save and mark-read share
 *    `retryOnPromote`, and nothing else retries on its own.
 */

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const BACKEND = join(ROOT, '../backend');

const walk = (dir: string, ext: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'tests' ? [] : walk(path, ext);
  return ext.test(name) && !/\.test\./.test(name) ? [path] : [];
});
const rel = (path: string) => relative(SRC, path);
const sourceFiles = () => walk(SRC, /\.(ts|tsx)$/);

/** The top-level Python functions whose bodies have a line matching `call`, by name. */
function callers(file: string, call: RegExp, prefix = ''): string[] {
  const names = new Set<string>();
  let current: string | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const def = /^(?:async )?def ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line);
    if (def) current = def[1];
    else if (/^\S/.test(line) && !line.startsWith('#') && !line.startsWith('@') && !line.startsWith(')')) current = null;
    if (current && !def && call.test(line) && !/^\s*#/.test(line) && !/^\s*(from|import) /.test(line)) names.add(`${prefix}${current}`);
  }
  return [...names];
}

/** Routes behind `Depends(person_only)`: the function under each such decorator. */
function personOnlyRoutes(file: string, prefix: string): string[] {
  const names: string[] = [];
  let decorated = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^@.*Depends\(person_only\)/.test(line)) decorated = true;
    const def = /^(?:async )?def ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line);
    if (def) {
      if (decorated) names.push(`${prefix}${def[1]}`);
      decorated = false;
    }
  }
  return names;
}

/** Every backend function behind the person gate, in its four forms. */
function gatedFunctions(): string[] {
  const main = join(BACKEND, 'main.py');
  const routes = walk(join(BACKEND, 'routes'), /\.py$/);
  const found = new Set<string>([
    ...callers(main, /\brequire_person\(/),
    ...callers(main, /\b_person_only_refusal\(/),
    ...callers(main, /\bstop_refusal\(/),
    ...routes.flatMap((file) => {
      const prefix = `${file.split('/').pop()!.replace(/\.py$/, '')}.`;
      return [...callers(file, /\brequire_person\(/, prefix), ...personOnlyRoutes(file, prefix)];
    }),
  ]);
  return [...found].sort();
}

/** Every registration, by its marker: the file it is in. */
const SITES: Record<string, string> = {
  banner: 'components/PersonRequiredBanner.tsx',
  'create.enhance': 'components/create-studio/CreateComposer.tsx',
  'chat.codex-login': 'components/panels/ChatPanel.tsx',
  'chat.codex-login-check': 'components/panels/ChatPanel.tsx',
  'chat.transcript': 'components/panels/ChatPanel.tsx',
  'chat.clear-canvas': 'components/panels/ChatPanel.tsx',
  'chat.session': 'components/panels/ChatPanel.tsx',
  'commons.line': 'components/commons/useCommonsLine.ts',
  'commons.reload-retry': 'components/commons/useCommonsLine.ts',
  'settings.agent-warning': 'components/panels/PersonalAgentWarning.tsx',
  'settings.apps': 'components/panels/settings/ConnectedApps.tsx',
  'settings.spend-load': 'components/panels/settings/AgentSpendSection.tsx',
  'settings.agents-load': 'components/panels/settings/PersonalAgentsSection.tsx',
  'settings.spend-load-retry': 'components/panels/settings/AgentSpendSection.tsx',
  'settings.agents-load-retry': 'components/panels/settings/PersonalAgentsSection.tsx',
  'settings.agents': 'components/panels/settings/PersonalAgentsSection.tsx',
  'settings.write': 'lib/settingsWrites.ts',
  'krea.connection': 'components/panels/settings/useKreaConnection.ts',
  'krea.plans': 'components/panels/settings/KreaSignInRow.tsx',
  'studio.save-board': 'components/moodboard-studio/MoodboardStudioView.tsx',
  'studio.undo-redo': 'components/moodboard-studio/MoodboardStudioView.tsx',
  'studio.brief': 'components/moodboard-studio/MoodboardStudioView.tsx',
  'studio.draft': 'store/assetStudioDraftStore.ts',
  'notes.corner': 'components/agent-notes/AgentNotesCorner.tsx',
  'notes.read': 'store/agentNotesStore.ts',
  'notes.read-retry': 'store/agentNotesStore.ts',
  'notes.dismiss': 'store/agentNotesStore.ts',
  trash: 'components/asset-trash/AssetTrash.tsx',
  'pins.add': 'store/canvasPinsStore.ts',
  'pins.remove': 'store/canvasPinsStore.ts',
  'pins.refusal': 'store/canvasPinsStore.ts',
  'asset-proposals.decide': 'store/assetProposalsStore.ts',
  'questions.answer': 'store/agentQuestionsStore.ts',
  'questions.dismiss': 'store/agentQuestionsStore.ts',
  'canvas-proposals.refusal': 'store/canvasProposalsStore.ts',
  'canvas-proposals.accept': 'store/canvasProposalsStore.ts',
  'canvas-proposals.reject': 'store/canvasProposalsStore.ts',
  'project.error': 'store/projectStore.ts',
  'project.save': 'store/projectStore.ts',
  'project.save-retry': 'store/projectStore.ts',
  'project.load-retry': 'store/projectStore.ts',
  'create.style-retry': 'components/create-studio/CreateView.tsx',
  'graph.refusal': 'store/graphStore.ts',
  'graph.notify': 'store/graphStore.ts',
  'graph.run-start': 'store/graphStore.ts',
  'graph.shot-start': 'store/graphStore.ts',
  // Round 7 (review 5 MEDIUM-1): Undo's and Redo's refusal line, and a scene save's retry.
  'graph.undo-refusal': 'store/graphStore.ts',
  'cinema.scene-save-retry': 'store/graphStore.ts',
};

const NO_LINE = (why: string) => ({ none: why });
type Surface = string[] | { none: string };

/** Each gated backend function: the registrations that clear its refusal's lines. */
const GATED: Record<string, Surface> = {
  list_personal_agents: ['settings.agents-load', 'settings.agents-load-retry'],
  create_personal_agent: ['settings.agents'],
  update_personal_agent: ['settings.agents'],
  delete_personal_agent: ['settings.agents'],
  install_antigravity: ['settings.agents'],
  remove_antigravity: ['settings.agents'],
  sign_in_antigravity: ['settings.agents'],
  cancel_antigravity_sign_in: ['settings.agents'],
  sign_out_antigravity: ['settings.agents'],
  acknowledge_personal_agent_warning: ['settings.agent-warning'],
  list_agent_apps: ['settings.spend-load', 'settings.spend-load-retry'],
  create_agent_app: ['settings.apps'],
  update_agent_app: ['settings.apps'],
  revoke_agent_app: ['settings.apps'],
  create_canvas_pin: ['pins.add', 'pins.refusal'],
  delete_canvas_pin: ['pins.remove', 'pins.refusal'],
  read_canvas_agent_notes: ['notes.read', 'notes.read-retry'],
  dismiss_canvas_agent_note: ['notes.dismiss', 'notes.corner'],
  read_board_agent_notes: ['notes.read', 'notes.read-retry'],
  dismiss_board_agent_note: ['notes.dismiss', 'notes.corner'],
  _decidable_proposal: ['canvas-proposals.accept', 'canvas-proposals.reject', 'canvas-proposals.refusal'],
  release_run_approval: NO_LINE('lib/canvasProposals releaseApproval swallows every failure: the approval expires on its own'),
  _answerable_questions: ['questions.answer', 'questions.dismiss'],
  _decidable_asset_proposal: ['asset-proposals.decide'],
  start_codex_chatgpt_login: ['chat.codex-login', 'chat.codex-login-check'],
  update_settings: ['settings.write'],
  remove_settings_api_key: ['settings.write'],
  credentials_update: ['settings.write'],
  configure_universal_node: ['graph.notify', 'graph.refusal'],
  _set_project_cover: ['project.error'],
  purge_trashed_project: ['project.error'],
  empty_project_trash: ['project.error'],
  enhance_prompt_route: ['create.enhance'],
  _refuse_override_change: ['studio.save-board', 'studio.undo-redo', 'studio.brief', 'studio.draft'],
  purge_trashed: ['trash'],
  empty_trash: ['trash'],
  // routes/krea_connector.py: the Krea account is the person's (round 4, review 2 MEDIUM).
  'krea_connector.person_only': NO_LINE('the dependency itself: the four routes that use it are listed by name'),
  'krea_connector.connect': ['krea.connection'],
  'krea_connector.check': ['krea.connection'],
  'krea_connector.disconnect': ['krea.connection'],
  'krea_connector.trial': ['krea.plans'],
  // _person_only_refusal: person_required for a tab that isn't the person.
  _check_run_approval: ['graph.run-start', 'graph.refusal'],
  _require_spend_approval: ['graph.run-start', 'graph.shot-start', 'graph.refusal'],
  // Create's Save style (POST /api/presets, _check_style_write) and Generate (POST
  // /api/graph/cluster) answer with it too (review 3 MEDIUM-1, round 5).
  _refuse_agent_billing_change: ['project.save', 'project.save-retry', 'project.load-retry', 'project.error', 'graph.notify', 'graph.run-start',
    'graph.refusal', 'graph.undo-refusal', 'cinema.scene-save-retry', 'create.style-retry'],
  _refuse_graph_over_save_limit_on_its_own: ['graph.notify', 'graph.refusal', 'graph.undo-refusal'],
  _refuse_agent_growth_past_save_limit: ['graph.notify', 'graph.refusal', 'graph.undo-refusal', 'cinema.scene-save-retry'],
  _reader_spend_hold: NO_LINE('POST /api/moodboards/{id}/read: no tab calls it (agents and the CLI only)'),
  // stop_refusal
  _refuse_stopping_the_persons_run: NO_LINE('a refused Stop shows no line: graphStore requestTrackedCancellation keeps the intent and asks again; only an offline Stop says so'),
};

/** Registrations not for one gated function: why each is there. */
const OTHER_SITES: Record<string, string> = {
  banner: 'the person-gate banner itself (PersonRequiredBanner)',
  'chat.transcript': 'the chat socket\'s own person_required refusal (/ws/chat), by its code',
  'chat.session': 'a chat turn with no person token for the Commons (commonsChatAuthority)',
  // PR #204 round 9: the Commons' own refusal (lib/commonsApi sessionLost: no person token, or a
  // 401 with a forgotten one), outside the gate's routes. Every Commons screen's line goes through
  // useCommonsLine (tests/presenceRound9.commons pins that structurally).
  'commons.line': 'every Commons screen\'s failure line, through useCommonsLine',
  'commons.reload-retry': 'a Commons load refused for this tab runs again on the promote (useCommonsLine)',
  'chat.clear-canvas': 'Clear canvas from the chat: DELETE /api/graph has no gate form today; a person_required answer still clears',
};

const REGISTRATION = /\b(?:clearLineOnPromote|clearSetterOnPromote|clearsOnPromote|retryOnPromote|clearsOnPromoteIf|clearRefusalOnPromote|clearRefusedOnPromote|clearPinRefusalOnPromote)\(|\.clearOnPromote\(/;
const DEFINITION = /^\s*(?:export\s+)?(?:async\s+)?function\s|^\s*const\s+\w+\s*=\s*\(|^\s*\w+\s*:\s*\(|^\s*clearOnPromote:\s/;
const MARKER = /\/\/ clears-on-promote: ([\w.-]+)/;

/** Every marker in src: site → where. */
function markers(): Map<string, { file: string; line: string }[]> {
  const found = new Map<string, { file: string; line: string }[]>();
  for (const path of sourceFiles()) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const marker = MARKER.exec(line);
      if (marker) found.set(marker[1], [...(found.get(marker[1]) ?? []), { file: rel(path), line }]);
    }
  }
  return found;
}

/** Files that recognise the person gate's refusal but keep no line of their own. */
const CLASSIFIERS: Record<string, string> = {
  'lib/errorCopy.ts': 'defines the code and GM\'s line; returns copy, keeps none',
  'lib/personSession.ts': 'the gate itself: the hold and the banner line (the banner registers in PersonRequiredBanner)',
  'lib/clearsOnPromote.ts': 'the mechanism',
  'lib/backend.ts': 'reports a refusal to the banner; keeps no line',
  'lib/wsClient.ts': 'reports the socket\'s personRequired frame to the banner; keeps no line',
  'lib/canvasPins.ts': 'words a pin refusal; canvasPinsStore keeps the line and registers it',
  'lib/commonsChatAuthority.ts': 'throws the session failure; ChatPanel keeps the line and registers it',
  'lib/notConnectedLine.ts': 'reads whether the page already shows a not-connected line (GM r8 1); keeps none',
};

/** `onPersonPromoted(` outside the mechanism: work on the promote that isn't a line. */
const PROMOTE_LISTENERS: Record<string, string> = {
  'lib/clearsOnPromote.ts': 'the sweep',
  'lib/personSession.ts': 'defines it',
  'store/canvasProposalsStore.ts': 'releases approvals dismissed while the gate held (a request, not a line)',
};

/** Round 5: what a route the trace can't find by its path is (none may be left unexplained). */
const COMPOSED: Record<string, string[]> = {
  // lib/agentNotes builds the path from base(surface): both surfaces go through these two.
  'POST /api/canvas/agent-notes/read': ['lib/agentNotes.ts#markAgentNotesRead'],
  'POST /api/moodboards/{moodboard_id}/agent-notes/read': ['lib/agentNotes.ts#markAgentNotesRead'],
  'POST /api/canvas/agent-notes/{note_id}/dismiss': ['lib/agentNotes.ts#dismissAgentNote'],
  'POST /api/moodboards/{moodboard_id}/agent-notes/{note_id}/dismiss': ['lib/agentNotes.ts#dismissAgentNote'],
};
const NO_FRONTEND: Record<string, string> = {
  'POST /api/graph/apply': 'an agent\'s edit (edit_canvas, `nebula apply`); no tab sends it',
  'POST /api/graph/apply/undo': 'an agent\'s undo of its own apply; no tab sends it',
  'POST /api/graph/run': 'the CLI\'s and MCP\'s run; a tab runs through /api/execute',
  'POST /api/quick': 'the CLI\'s one-shot generate; no tab sends it',
  'POST /api/moodboards/{moodboard_id}/read': 'an agent reading a board (spend hold); no tab sends it',
  'PUT /api/presets/{preset_id}': 'no tab edits a style in place: Create saves a new one (POST) or deletes it',
};

/**
 * Round 8 (review 6 gates LOW-5): a socket whose person-only refusals come back as frames
 * (`{ code: "person_required", ref }`), not as answers to a request, so no catch or `!res.ok`
 * branch is there to trace. Its sender reads the code where the frame arrives, and these tests
 * pin what it does with it (the refused answer goes back, the line clears by its own ref).
 * Round 9: the sender is read structurally (socketRefusalGaps): it opens a WebSocket to the
 * route, and its message handler's branch on the code makes a marked registration call.
 */
const SOCKETS: Record<string, { file: string; tests: string[] }> = {
  'WS /ws/chat': { file: 'components/panels/ChatPanel.tsx', tests: ['presenceRound7.chat.test.tsx'] },
};

type Caller = string[] | { none: string };

/** Round 5: each function that sends a gated route but doesn't keep its line with the mechanism
 * in its own file. Keys are `file#function`; a lib/ key also stops the trace there. */
const CALLERS: Record<string, Caller> = {
  // Its line is kept by what it hands the failure to.
  'components/GraphFileActions.tsx#importGraph': ['graph.notify'], // showNotice → graphStore notify, which reads GM's line
  // Round 7: acceptWarning throws on (no catch); ChatPanel hands it to PersonalAgentWarning's
  // onAccept, whose catch registers the line.
  'components/panels/ChatPanel.tsx#ChatPanel': ['settings.agent-warning'],
  // No line.
  'lib/runCostConfirm.ts#applySavedRunCostConfirm': NO_LINE('a quiet migration of the run cost threshold: a failure logs and tries again on the next read of settings'),
  'lib/canvasProposals.ts#releaseApproval': NO_LINE('releaseApproval swallows every failure: the approval expires on its own'),
  'components/panels/ChatPanel.tsx#load': NO_LINE('a failed read of the agents falls back to an empty list; the Settings tab shows the refusal'),
  'components/panels/Inspector.tsx#renderUniversalModelControl': NO_LINE('a favourite\'s star: a failed save is ignored (.catch(() => undefined))'),
  // Round 6 (review 4 LOW-4, MEDIUM-1): cancelWithinTimeLimit throws on to its two callers.
  'store/graphStore.ts#fencePaidUnknownRun': NO_LINE('the 404 rule\'s Stop for a paid World Labs start: a refusal logs; the Stop stays on the run and the person\'s own Stop sends it again'),
  // Round 7: the trace reads these itself now (OfflineRefusal and describeSaves only name a path).
  // Round 7: its refusal is settled first, then the save registers its retry (in its finally).
  'store/graphStore.ts#flushCinemaScenePersistence': ['cinema.scene-save-retry'],
  'store/graphStore.ts#renameNode': NO_LINE('a refused rename puts the old name back, with no line of its own (the banner says why)'),
  'store/graphStore.ts#sendRestoredWire': NO_LINE('Keep mine\'s wire put back: a refused one stays off the card and the info line names its shot (shotBackWithoutLine), what came back, not why'),
  'store/projectStore.ts#keepReplacedCanvasAsCopy': NO_LINE('.catch(() => null): a copy not made; the held edits\' screen offers it again'),
  // GM r7 (2): the load screens retry on the promote (showNotConnectedLoad in each catch).
  // The handoff save after an agent's switch: a refusal becomes a recovered copy (recoverPendingWork,
  // which throws on), whose refusal lands in this function's outer catch (GM r7 2).
  'store/projectStore.ts#followProjectSwitch': ['project.load-retry'],
};

/** Round 5, GM r5 (1): the requests that retry on the promote, through `retryOnPromote` only. */
const RETRIES: Record<string, string> = {
  'notes.read-retry': 'store/agentNotesStore.ts',
  'project.save-retry': 'store/projectStore.ts',
  'project.load-retry': 'store/projectStore.ts',
  'create.style-retry': 'components/create-studio/CreateView.tsx',
  'settings.spend-load-retry': 'components/panels/settings/AgentSpendSection.tsx',
  'settings.agents-load-retry': 'components/panels/settings/PersonalAgentsSection.tsx',
  'cinema.scene-save-retry': 'store/graphStore.ts',
  'commons.reload-retry': 'components/commons/useCommonsLine.ts',
};

const usesMechanism = (source: string) => /from '[./]*(?:lib\/)?clearsOnPromote'/.test(source)
  || /from '\.\/clearsOnPromote'/.test(source) || /\.clearOnPromote\(/.test(source);

const RECOGNISES = /PERSON_REQUIRED_CODE|['"]person_required['"]|personRequiredCopy\(|reportPersonRequired\(|saysPersonRequired\(|isPersonRefusal\(/;

describe('GM, PR #204: a line whose only reason was this tab clears on the promote', () => {
  it('every backend function behind the person gate, in all four forms, is listed, and only those', () => {
    const found = gatedFunctions();
    expect(found.length).toBeGreaterThan(40);
    expect(found).toEqual(Object.keys(GATED).sort());
  });

  it('each listed registration is there, once, in its file, on a call into the mechanism', () => {
    const found = markers();
    const wrong: string[] = [];
    for (const [site, file] of Object.entries(SITES)) {
      const at = found.get(site) ?? [];
      if (at.length !== 1) wrong.push(`${site}: ${at.length} markers`);
      else if (at[0].file !== file) wrong.push(`${site}: in ${at[0].file}, not ${file}`);
      else if (!REGISTRATION.test(at[0].line)) wrong.push(`${site}: its line registers nothing`);
    }
    expect(wrong).toEqual([]);
  });

  it('every gated function names its registrations (or why it shows no line), and every registration is claimed', () => {
    const claimed = new Set<string>(Object.keys(OTHER_SITES));
    for (const [name, surface] of Object.entries(GATED)) {
      if (!Array.isArray(surface)) {
        expect(surface.none.length, name).toBeGreaterThan(10);
        continue;
      }
      expect(surface.length, name).toBeGreaterThan(0);
      for (const site of surface) {
        expect(site in SITES, `${name}: ${site}`).toBe(true);
        claimed.add(site);
      }
    }
    expect(Object.keys(SITES).filter((site) => !claimed.has(site))).toEqual([]);
    expect([...markers().keys()].filter((site) => !(site in SITES))).toEqual([]);
  });

  it('every call into the mechanism outside it carries its marker', () => {
    const bare: string[] = [];
    for (const path of sourceFiles()) {
      if (rel(path) === 'lib/clearsOnPromote.ts') continue;
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (REGISTRATION.test(line) && !DEFINITION.test(line) && !MARKER.test(line)) bare.push(`${rel(path)}:${index + 1}`);
      });
    }
    expect(bare).toEqual([]);
  });

  it('a file that recognises the person gate\'s refusal goes through the mechanism, or keeps no line', () => {
    const missing = sourceFiles().filter((path) => {
      const source = readFileSync(path, 'utf8');
      return RECOGNISES.test(source) && !usesMechanism(source) && !(rel(path) in CLASSIFIERS);
    }).map(rel);
    expect(missing).toEqual([]);
  });

  it('nothing clears on the promote by its own listener', () => {
    const own = sourceFiles().filter((path) => /\bonPersonPromoted\(/.test(readFileSync(path, 'utf8')))
      .map(rel).filter((file) => !(file in PROMOTE_LISTENERS));
    expect(own).toEqual([]);
  });

  it('round 5: every gated route is found from the frontend, or listed as composed or agent-only', { timeout: 30_000 }, () => {
    const routes = gatedRoutes();
    expect(routes.length).toBeGreaterThan(50);
    const keys = routes.map((route) => `${route.method} ${route.path}`);
    const wrong: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      const byPath = callersOf(route).size;
      if (key in SOCKETS) {
        const { file, tests } = SOCKETS[key];
        // Round 9 (review 7 NIT-2): read from the syntax tree, not the text.
        for (const gap of socketRefusalGaps(file, route.path)) wrong.push(`${key}: ${file} ${gap}`);
        for (const test of tests) {
          if (!readFileSync(join(__dirname, test), 'utf8').includes('person_required')) wrong.push(`${key}: ${test} doesn't pin the refusal`);
        }
      }
      else if (key in NO_FRONTEND) { if (byPath > 0 || key in COMPOSED) wrong.push(`${key}: listed as agent-only, but sent from the frontend`); }
      else if (key in COMPOSED) { if (byPath > 0) wrong.push(`${key}: composed, but found by its path`); }
      else if (byPath === 0) wrong.push(`${key}: no frontend caller found, and not listed`);
    }
    for (const key of [...Object.keys(COMPOSED), ...Object.keys(NO_FRONTEND), ...Object.keys(SOCKETS)]) if (!keys.includes(key)) wrong.push(`${key}: listed, but not gated`);
    expect(wrong).toEqual([]);
  });

  it('round 5: every frontend caller of a gated route keeps its line with the mechanism, or is in CALLERS', { timeout: 30_000 }, () => {
    const stops = new Set(Object.keys(CALLERS).filter((key) => key.startsWith('lib/')));
    const undeclared = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const route of gatedRoutes()) {
      const starts = COMPOSED[`${route.method} ${route.path}`] ?? [];
      for (const [id, unit] of callersOf(route, starts, stops)) {
        seen.add(id);
        // Round 6 (review 4 MEDIUM-1): the catch on this call registers (outcomeAt), not just the function.
        if (unit.outcome === 'keeps' && !(id in CALLERS)) continue;
        if (!(id in CALLERS)) undeclared.set(id, [...(undeclared.get(id) ?? []), `${route.method} ${route.path}`]);
      }
    }
    expect(Object.fromEntries(undeclared)).toEqual({});
    // Every declaration is a caller the trace finds (a stale one fails), and says something.
    expect(Object.keys(CALLERS).filter((id) => !seen.has(id))).toEqual([]);
    for (const [id, caller] of Object.entries(CALLERS)) {
      if (Array.isArray(caller)) {
        expect(caller.length, id).toBeGreaterThan(0);
        for (const site of caller) expect(site in SITES, `${id}: ${site}`).toBe(true);
      } else {
        expect(caller.none.length, id).toBeGreaterThan(20);
      }
    }
  });

  it('round 5: the requests that retry on the promote go through retryOnPromote, and are listed', () => {
    const found = markers();
    const retries = [...found].filter(([, at]) => at.some((where) => /\bretryOnPromote\(/.test(where.line))).map(([site]) => site).sort();
    expect(retries).toEqual(Object.keys(RETRIES).sort());
    for (const [site, file] of Object.entries(RETRIES)) expect(found.get(site)?.[0]?.file, site).toBe(file);
    // Nothing else retries a refused request on the promote by its own means.
    const own = sourceFiles().filter((path) => rel(path) !== 'lib/clearsOnPromote.ts'
      && /onPersonPromoted\([^)]*\)[\s\S]{0,400}\b(?:retry|retrySave|save)\(/.test(readFileSync(path, 'utf8'))).map(rel);
    expect(own).toEqual([]);
  });
});

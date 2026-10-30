import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  'settings.agent-warning': 'components/panels/PersonalAgentWarning.tsx',
  'settings.apps': 'components/panels/settings/ConnectedApps.tsx',
  'settings.spend-load': 'components/panels/settings/AgentSpendSection.tsx',
  'settings.agents-load': 'components/panels/settings/PersonalAgentsSection.tsx',
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
  'graph.refusal': 'store/graphStore.ts',
  'graph.notify': 'store/graphStore.ts',
  'graph.run-start': 'store/graphStore.ts',
  'graph.shot-start': 'store/graphStore.ts',
};

const NO_LINE = (why: string) => ({ none: why });
type Surface = string[] | { none: string };

/** Each gated backend function: the registrations that clear its refusal's lines. */
const GATED: Record<string, Surface> = {
  list_personal_agents: ['settings.agents-load'],
  create_personal_agent: ['settings.agents'],
  update_personal_agent: ['settings.agents'],
  delete_personal_agent: ['settings.agents'],
  install_antigravity: ['settings.agents'],
  remove_antigravity: ['settings.agents'],
  sign_in_antigravity: ['settings.agents'],
  cancel_antigravity_sign_in: ['settings.agents'],
  sign_out_antigravity: ['settings.agents'],
  acknowledge_personal_agent_warning: ['settings.agent-warning'],
  list_agent_apps: ['settings.spend-load'],
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
  _refuse_agent_billing_change: ['project.save', 'project.error', 'graph.notify', 'graph.run-start', 'graph.refusal'],
  _refuse_graph_over_save_limit_on_its_own: ['graph.notify', 'graph.refusal'],
  _refuse_agent_growth_past_save_limit: ['graph.notify', 'graph.refusal'],
  _reader_spend_hold: NO_LINE('POST /api/moodboards/{id}/read: no tab calls it (agents and the CLI only)'),
  // stop_refusal
  _refuse_stopping_the_persons_run: NO_LINE('a refused Stop shows no line: graphStore requestTrackedCancellation keeps the intent and asks again; only an offline Stop says so'),
};

/** Registrations not for one gated function: why each is there. */
const OTHER_SITES: Record<string, string> = {
  banner: 'the person-gate banner itself (PersonRequiredBanner)',
  'chat.transcript': 'the chat socket\'s own person_required refusal (/ws/chat), by its code',
  'chat.session': 'a chat turn with no person token for the Commons (commonsChatAuthority)',
  'chat.clear-canvas': 'Clear canvas from the chat: DELETE /api/graph has no gate form today; a person_required answer still clears',
};

const REGISTRATION = /\b(?:clearLineOnPromote|clearSetterOnPromote|clearsOnPromote|retryOnPromote|clearsOnPromoteIf|clearRefusalOnPromote|clearPinRefusalOnPromote)\(|\.clearOnPromote\(/;
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
};

/** `onPersonPromoted(` outside the mechanism: work on the promote that isn't a line. */
const PROMOTE_LISTENERS: Record<string, string> = {
  'lib/clearsOnPromote.ts': 'the sweep',
  'lib/personSession.ts': 'defines it',
  'store/canvasProposalsStore.ts': 'releases approvals dismissed while the gate held (a request, not a line)',
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
});

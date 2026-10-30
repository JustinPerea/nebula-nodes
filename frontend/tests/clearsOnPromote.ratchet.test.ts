import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM, PR #204 round 3 (2026-10-30): "on promote, every line whose only reason
 * was 'this tab isn't connected as you' clears at once, wherever it sits", and
 * "a ratchet test or a single 'clears on promote' flag on those lines would
 * keep the next one from sticking". Both, here:
 *
 * 1. Every backend function that asks the person gate (`require_person(` in
 *    backend/main.py: a route, or a helper routes share) is in GATED below,
 *    with the frontend files that show its refusal. Each of those files goes
 *    through the one mechanism (lib/clearsOnPromote). A new gated function
 *    fails here until someone says where its refusal shows; a function that
 *    stops asking fails here until its entry goes.
 * 2. Any frontend file that recognises the person gate's refusal (its code,
 *    GM's line for it, or reports it) goes through the mechanism too, or is a
 *    classifier listed in CLASSIFIERS with why it keeps no line.
 * 3. Nothing clears on the promote by its own listener: `onPersonPromoted(`
 *    is lib/clearsOnPromote's, plus PROMOTE_LISTENERS (work that isn't a line).
 */

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const MAIN = join(ROOT, '../backend/main.py');

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
});
const rel = (path: string) => relative(SRC, path);

/** The backend functions that call require_person, by name (the function each call sits in). */
function gatedFunctions(): string[] {
  const lines = readFileSync(MAIN, 'utf8').split('\n');
  const names = new Set<string>();
  let current: string | null = null;
  for (const line of lines) {
    const def = /^(?:async )?def ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line);
    if (def) current = def[1];
    else if (/^\S/.test(line) && !line.startsWith('#') && !line.startsWith('@') && !line.startsWith(')')) current = null;
    if (current && /^\s+.*\brequire_person\(/.test(line) && !/^\s*#/.test(line)) names.add(current);
  }
  return [...names].sort();
}

const NO_LINE = (why: string) => ({ none: why });
type Surface = string[] | { none: string };

/** Each gated backend function: the frontend files that show its refusal (all through lib/clearsOnPromote). */
const GATED: Record<string, Surface> = {
  list_personal_agents: ['components/panels/settings/PersonalAgentsSection.tsx'],
  create_personal_agent: ['components/panels/settings/PersonalAgentsSection.tsx'],
  update_personal_agent: ['components/panels/settings/PersonalAgentsSection.tsx'],
  delete_personal_agent: ['components/panels/settings/PersonalAgentsSection.tsx'],
  install_antigravity: ['components/panels/settings/PersonalAgentsSection.tsx'],
  remove_antigravity: ['components/panels/settings/PersonalAgentsSection.tsx'],
  sign_in_antigravity: ['components/panels/settings/PersonalAgentsSection.tsx'],
  cancel_antigravity_sign_in: ['components/panels/settings/PersonalAgentsSection.tsx'],
  sign_out_antigravity: ['components/panels/settings/PersonalAgentsSection.tsx'],
  acknowledge_personal_agent_warning: ['components/panels/PersonalAgentWarning.tsx'],
  list_agent_apps: ['components/panels/settings/AgentSpendSection.tsx'],
  create_agent_app: ['components/panels/settings/ConnectedApps.tsx'],
  update_agent_app: ['components/panels/settings/ConnectedApps.tsx'],
  revoke_agent_app: ['components/panels/settings/ConnectedApps.tsx'],
  create_canvas_pin: ['store/canvasPinsStore.ts'],
  delete_canvas_pin: ['store/canvasPinsStore.ts'],
  read_canvas_agent_notes: ['store/agentNotesStore.ts'],
  dismiss_canvas_agent_note: ['store/agentNotesStore.ts', 'components/agent-notes/AgentNotesCorner.tsx'],
  read_board_agent_notes: ['store/agentNotesStore.ts'],
  dismiss_board_agent_note: ['store/agentNotesStore.ts', 'components/agent-notes/AgentNotesCorner.tsx'],
  _decidable_proposal: ['store/canvasProposalsStore.ts'],
  release_run_approval: NO_LINE('lib/canvasProposals releaseApproval swallows every failure: the approval expires on its own'),
  _answerable_questions: ['store/agentQuestionsStore.ts'],
  _decidable_asset_proposal: ['store/assetProposalsStore.ts'],
  start_codex_chatgpt_login: ['components/panels/ChatPanel.tsx'],
  update_settings: ['lib/settingsWrites.ts'],
  remove_settings_api_key: ['lib/settingsWrites.ts'],
  credentials_update: ['lib/settingsWrites.ts'],
  configure_universal_node: ['store/graphStore.ts'],
  _set_project_cover: ['store/projectStore.ts'],
  purge_trashed_project: ['store/projectStore.ts'],
  empty_project_trash: ['store/projectStore.ts'],
  enhance_prompt_route: ['components/create-studio/CreateComposer.tsx'],
  _refuse_override_change: ['components/moodboard-studio/MoodboardStudioView.tsx', 'store/assetStudioDraftStore.ts'],
  purge_trashed: ['components/asset-trash/AssetTrash.tsx'],
  empty_trash: ['components/asset-trash/AssetTrash.tsx'],
};

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

/** Imports the mechanism, or calls a store action that is it (assetStudioDraftStore.clearOnPromote). */
const usesMechanism = (source: string) => /from '[./]*(?:lib\/)?clearsOnPromote'/.test(source)
  || /from '\.\/clearsOnPromote'/.test(source) || /\.clearOnPromote\(/.test(source);

const RECOGNISES = /PERSON_REQUIRED_CODE|['"]person_required['"]|personRequiredCopy\(|reportPersonRequired\(|saysPersonRequired\(|isPersonRefusal\(/;

describe('GM, PR #204 round 3: a line whose only reason was this tab clears on the promote', () => {
  it('every backend function that asks the person gate is listed, and only those', () => {
    const found = gatedFunctions();
    expect(found.length).toBeGreaterThan(20);
    expect(found).toEqual(Object.keys(GATED).sort());
  });

  it('each gated function\'s surfaces go through lib/clearsOnPromote', () => {
    const missing: string[] = [];
    for (const [name, surface] of Object.entries(GATED)) {
      if (!Array.isArray(surface)) {
        expect(surface.none.length, name).toBeGreaterThan(10);
        continue;
      }
      for (const file of surface) {
        const source = readFileSync(join(SRC, file), 'utf8');
        if (!usesMechanism(source)) missing.push(`${name}: ${file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a file that recognises the person gate\'s refusal goes through the mechanism, or keeps no line', () => {
    const missing = walk(SRC).filter((path) => {
      const source = readFileSync(path, 'utf8');
      return RECOGNISES.test(source) && !usesMechanism(source) && !(rel(path) in CLASSIFIERS);
    }).map(rel);
    expect(missing).toEqual([]);
  });

  it('nothing clears on the promote by its own listener', () => {
    const own = walk(SRC).filter((path) => /\bonPersonPromoted\(/.test(readFileSync(path, 'utf8')))
      .map(rel).filter((file) => !(file in PROMOTE_LISTENERS));
    expect(own).toEqual([]);
  });
});

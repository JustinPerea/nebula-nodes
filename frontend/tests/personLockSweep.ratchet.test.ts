/**
 * PR #204 round 10 (GM r15, r17): every control that sends a route only the person may use locks
 * through the one lock (src/hooks/usePersonLock + components/PersonLock): aria-disabled, its line
 * "You can <verb> when this tab is connected as you." under it, no tooltip, unlocked on the
 * promote. The route set is personGateRoutes.py's `personOnly` (require_person, person_only, the
 * Commons' human_dep, reached unconditionally), never a hand list. Each function that sends one
 * (tests/personGatedCallers callersOf) is mapped here to the component that holds its control and
 * the verb it locks with; a new caller with no entry fails, and so does an entry nothing sends.
 * A read the person alone may make (the agent apps and personal agents lists, and the Commons)
 * switches to the never-connected view on a demote instead (GM r17 item 6): those name the hook.
 *
 * Round 11 (review 9 lock-sweep LOW-3): controls, not files. From each locked entry's sends
 * (callersOf's points) the trace walks to every JSX handler that reaches them
 * (personGatedCallers lockReach: through callers, props handed to components, a hook's returned
 * members), and each must hold a lock: `<lock>.guard(…)` around the call, an early
 * `if (<lock>.locked) return` (or `!<lock>.locked`) on the way, work held for the promote, or the
 * element's `{...<lock>.control()}`. A second control that reaches a locked sender unlocked fails,
 * whatever file it is in.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { type ControlSite, callersOf, lockReach, personOnlyRoutes, SRC } from './personGatedCallers';
import { notConnectedKind } from '../src/lib/notConnectedLine';
import { personLockLine } from '../src/lib/errorCopy';

type Entry =
  | { lock: string; in: string[] }
  | { demoted: string }
  | { not: string };

const SETTINGS = 'components/panels/settings/';
/** A unit (`file#name` under src/) that sends a person-only route, and what holds its control. */
const CALLERS: Record<string, Entry> = {
  [`${SETTINGS}AgentSpendSection.tsx#reload`]: { demoted: `${SETTINGS}AgentSpendSection.tsx` },
  [`${SETTINGS}ConnectedApps.tsx#create`]: { lock: 'connect an agent', in: [`${SETTINGS}ConnectedApps.tsx`] },
  [`${SETTINGS}ConnectedApps.tsx#ConnectedApps`]: { lock: 'change connected agents', in: [`${SETTINGS}ConnectedApps.tsx`] },
  'components/panels/ChatPanel.tsx#handleStartCodexChatGPTLogin': { lock: 'sign in to Codex', in: ['components/panels/ChatPanel.tsx'] },
  'components/panels/ChatPanel.tsx#ChatPanel': { lock: 'use your agents', in: ['components/panels/PersonalAgentWarning.tsx'] },
  'components/panels/ChatPanel.tsx#load': { not: 'the chat reads its agent list on open; a refusal leaves the picker empty (no control sends it)' },
  'store/assetProposalsStore.ts#decide': { lock: 'review this', in: ['components/proposals/AssetProposalStrip.tsx'] },
  'store/canvasProposalsStore.ts#accept': { lock: 'review this', in: ['components/canvas/ProposalBar.tsx'] },
  'store/canvasProposalsStore.ts#reject': { lock: 'review this', in: ['components/canvas/ProposalBar.tsx'] },
  'store/canvasProposalsStore.ts#dismissDeferred': { lock: 'dismiss this', in: ['components/canvas/DeferredRunNotice.tsx'] },
  'components/canvas/DeferredRunNotice.tsx#DeferredRunNotice': { lock: 'dismiss this', in: ['components/canvas/DeferredRunNotice.tsx'] },
  'store/canvasPinsStore.ts#submit': { lock: 'send notes', in: ['components/canvas/PinComposer.tsx'] },
  'store/canvasPinsStore.ts#remove': { lock: 'delete notes', in: ['components/canvas/PinLayer.tsx'] },
  'store/agentQuestionsStore.ts#send': { lock: 'answer this', in: ['components/agent-notes/AgentQuestionsForm.tsx'] },
  'store/agentQuestionsStore.ts#dismiss': { lock: 'answer this', in: ['components/agent-notes/AgentQuestionsForm.tsx'] },
  'lib/settingsWrites.ts#saveKey': { lock: 'change provider settings', in: [`${SETTINGS}ProvidersTab.tsx`] },
  'lib/settingsWrites.ts#removeKey': { lock: 'change provider settings', in: [`${SETTINGS}ProvidersTab.tsx`] },
  'lib/settingsWrites.ts#saveField': {
    lock: '', in: [`${SETTINGS}AgentSpendSection.tsx`, `${SETTINGS}StorageTab.tsx`, `${SETTINGS}ProvidersTab.tsx`],
  },
  'lib/settingsWrites.ts#saveRunCostConfirm': { lock: 'change this', in: [`${SETTINGS}PreferencesTab.tsx`] },
  'components/create-studio/CreateComposer.tsx#handleEnhance': { lock: 'enhance prompts', in: ['components/create-studio/CreateComposer.tsx'] },
  'store/graphStore.ts#configureOpenRouterModel': { lock: 'change the model', in: ['components/panels/Inspector.tsx'] },
  'store/graphStore.ts#fetchReplicateSchemaAndConfigure': { lock: 'change the model', in: ['components/panels/Inspector.tsx'] },
  'store/graphStore.ts#pushNodeParams': { not: 'sends PUT /api/graph/node/{id} (gated only by the canvas checks); the tracer reads the shared path' },
  'components/panels/Inspector.tsx#renderUniversalModelControl': { lock: 'save favorites', in: ['components/panels/Inspector.tsx'] },
  [`${SETTINGS}useKreaConnection.ts#disconnect`]: { lock: 'change provider settings', in: [`${SETTINGS}ProvidersTab.tsx`] },
  [`${SETTINGS}useKreaConnection.ts#signIn`]: { lock: 'change provider settings', in: [`${SETTINGS}ProvidersTab.tsx`] },
  [`${SETTINGS}useKreaConnection.ts#check`]: { lock: 'change provider settings', in: [`${SETTINGS}ProvidersTab.tsx`] },
  [`${SETTINGS}KreaSignInRow.tsx#KreaPlans`]: { lock: 'start a trial', in: [`${SETTINGS}KreaSignInRow.tsx`] },
  [`${SETTINGS}PersonalAgentsSection.tsx#load`]: { demoted: `${SETTINGS}PersonalAgentsSection.tsx` },
  [`${SETTINGS}PersonalAgentsSection.tsx#addCustom`]: { lock: 'add an agent', in: [`${SETTINGS}PersonalAgentsSection.tsx`] },
  [`${SETTINGS}PersonalAgentsSection.tsx#PersonalAgentsSection`]: { lock: 'change your agents', in: [`${SETTINGS}PersonalAgentsSection.tsx`] },
  [`${SETTINGS}PersonalAgentsSection.tsx#KeyOption`]: { lock: 'change your agents', in: [`${SETTINGS}PersonalAgentsSection.tsx`] },
  [`${SETTINGS}PersonalAgentsSection.tsx#DownloadAndSignIn`]: { lock: 'change your agents', in: [`${SETTINGS}PersonalAgentsSection.tsx`] },
  'store/projectStore.ts#remove': { not: 'sends DELETE /api/projects/{id} (moves it to Recently deleted, open to every tab); the tracer matches {project_id}' },
  'store/projectStore.ts#purge': { lock: 'delete projects for good', in: ['components/projects/ProjectHome.tsx'] },
  'store/projectStore.ts#emptyTrashOf': { lock: 'delete projects for good', in: ['components/projects/ProjectHome.tsx'] },
  'components/asset-trash/AssetTrash.tsx#RecentlyDeletedAssets': { lock: 'delete items for good', in: ['components/asset-trash/AssetTrash.tsx'] },
  // Round 11 (review 9 MEDIUM-2, LOW-7): these reach PUT /api/settings only through
  // lib/runCostConfirm's run-cost carry-over after a settings read, which now runs only on a tab
  // connected as the person (lib/personWork whenPerson) and waits for the promote otherwise. No
  // control sends it.
  'App.tsx#App': { not: 'the run-cost carry-over after the settings read on load (lib/runCostConfirm): sent only from a tab connected as the person (lib/personWork whenPerson), else it waits for the promote' },
  'App.tsx#handleSettingsSaved': { not: 'the run-cost carry-over after the read that follows a save (lib/runCostConfirm): sent only from a tab connected as the person (lib/personWork whenPerson), else it waits for the promote' },
  'components/panels/Settings.tsx#Settings': { not: 'the run-cost carry-over after the read on open (lib/runCostConfirm): sent only from a tab connected as the person (lib/personWork whenPerson), else it waits for the promote' },
  // Round 11 (review 9 LOW-2): lib/agentNotes' composed paths trace now (they were UNTRACED).
  'store/agentNotesStore.ts#dismiss': { lock: 'dismiss updates', in: ['components/agent-notes/AgentNoteCard.tsx'] },
  // Round 13 (review 10 MEDIUM-1): markRead and markReadIds send through sendRead, which sends
  // nothing on a tab that isn't connected as the person (one read per list waits for the promote).
  'store/agentNotesStore.ts#sendRead': { not: 'marks Updates read when the person opens or reads them (the corner, a card): opening and reading stay live; on a tab not connected as the person nothing is sent and one read per list waits for the promote (lib/personWork whenPerson); a refusal of one sent says markReadRefusedCopy' },
};

/** Round 11: controls lockReach reaches that send nothing person-only, by `file attribute={handler}`
 * (no line number), with why. One that no longer reaches a locked sender fails. */
const NOT_SENDING: Record<string, string> = {
  'components/PromptDialog.tsx onKeyDown': 'its only call of onDone is Escape\'s onDone(null), which PinComposer reads as cancel',
  'components/PromptDialog.tsx onClick={() => onDone(null)}': 'Cancel: PinComposer reads onDone(null) as cancel; only Send note sends the note',
};
const siteKey = (site: ControlSite) => `${site.file} ${site.attribute}${site.attribute === 'onKeyDown' && site.file === 'components/PromptDialog.tsx' ? '' : `=${site.handler}`}`;

/** saveField's hosts each lock with their own verb. */
const SAVE_FIELD_VERBS: Record<string, string> = {
  [`${SETTINGS}AgentSpendSection.tsx`]: 'change limits',
  [`${SETTINGS}StorageTab.tsx`]: 'change storage settings',
  // Round 11 (GM r18 a): the Krea sign-in row locks with the providers' one lock (its `lock` prop).
  [`${SETTINGS}ProvidersTab.tsx`]: 'change provider settings',
};


const source = (file: string) => readFileSync(join(SRC, file), 'utf8');
/** The text of every string and template part a file writes (comments left out). */
function writtenTexts(text: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return out;
}
const rel = (key: string) => key.replace(/^.*\/src\//, '');
const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

function checkEntry(entry: Entry, where: string, problems: string[]) {
  if ('not' in entry) return;
  if ('demoted' in entry) {
    // Round 11: usePersonView also reads only on a tab connected as the person (useReadAsPerson).
    if (!/use(?:DemotedView|PersonView)\(\)/.test(source(entry.demoted))) problems.push(`${where}: ${entry.demoted} doesn't switch on a demote (useDemotedView or usePersonView)`);
    return;
  }
  for (const host of entry.in) {
    const verb = entry.lock || SAVE_FIELD_VERBS[host];
    const text = source(host);
    if (!verb) { problems.push(`${where}: no verb for ${host}`); continue; }
    if (!text.includes(`usePersonLock('${verb}'`) && !text.includes(`usePersonLock(verb ?? `)) {
      problems.push(`${where}: ${host} doesn't lock with usePersonLock('${verb}')`);
    }
    if (!/<PersonLockLine\b|footer=\{/.test(text)) problems.push(`${where}: ${host} renders no lock line`);
    if (notConnectedKind(personLockLine(verb)) !== 'lock') problems.push(`${where}: "${personLockLine(verb)}" doesn't read as a lock`);
  }
}

/** Round 11: every control that reaches a locked entry's sends holds a lock (lockReach), and
 * every send is reached from a control or held behind a lock on the way. */
function checkControls(caller: string, points: { file: string; node: ts.Node }[], problems: string[], used: Set<string>) {
  const reach = lockReach(points);
  for (const site of reach.sites) {
    if (site.locked) continue;
    const key = siteKey(site);
    if (key in NOT_SENDING) { used.add(key); continue; }
    problems.push(`${caller}: ${site.file}:${site.line} <${site.tag} ${site.attribute}> reaches it with no lock (via ${[...site.via].reverse().join(' > ') || 'itself'})`);
  }
  for (const end of reach.open) problems.push(`${caller}: sent from ${end.at} with no control or lock on the way (via ${[...end.via].reverse().join(' > ') || 'itself'})`);
  if (reach.sites.length === 0 && reach.held.length === 0 && reach.open.length === 0) problems.push(`${caller}: no control reaches it`);
}

const COMMONS = '/api/commons';
const routes = personOnlyRoutes();

describe('person-only controls lock (PR #204 round 10)', () => {
  it('reads the person-only routes from the backend, Commons included', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.some((r) => r.path.startsWith(COMMONS))).toBe(true);
    // Conditional routes stay live (GM r17 item 7): a spend limit, an approval, a pinned cover.
    for (const live of ['POST /api/execute', 'PUT /api/projects/{project_id}/cover', 'PUT /api/moodboards/{moodboard_id}']) {
      expect(routes.map(key)).not.toContain(live);
    }
    // Round 11 (review 9 NIT-2): the asset trash's Empty validates its filters first (an `if` that
    // only raises), then require_person: person-only.
    for (const personOnly of ['POST /api/trash/empty', 'DELETE /api/trash/{kind}/{item_id}', 'POST /api/projects/trash/empty']) {
      expect(routes.map(key)).toContain(personOnly);
    }
  });

  it('every caller of a person-only route is mapped to its lock, and every entry is still a caller', { timeout: 30_000 }, () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const points = new Map<string, { file: string; node: ts.Node }[]>();
    for (const route of routes) {
      if (route.path.startsWith(COMMONS)) continue;
      const callers = [...callersOf(route)].map(([id, unit]) => [rel(id), unit] as const);
      if (callers.length === 0) { problems.push(`${key(route)}: no caller found`); continue; }
      for (const [caller, unit] of callers) {
        seen.add(caller);
        const entry = CALLERS[caller];
        if (!entry) { problems.push(`${key(route)}: ${caller} sends it and has no lock entry`); continue; }
        checkEntry(entry, `${key(route)} via ${caller}`, problems);
        if ('lock' in entry) points.set(caller, [...(points.get(caller) ?? []), ...(unit.points ?? [unit.node]).map((node) => ({ file: unit.file, node }))]);
      }
    }
    for (const caller of Object.keys(CALLERS)) if (!seen.has(caller)) problems.push(`${caller}: in CALLERS but sends no person-only route`);
    // Round 11 (LOW-3): the controls themselves.
    const used = new Set<string>();
    for (const [caller, at] of points) checkControls(caller, at, problems, used);
    for (const site of Object.keys(NOT_SENDING)) if (!used.has(site)) problems.push(`${site}: in NOT_SENDING but no longer reaches a locked sender unlocked`);
    expect([...new Set(problems)]).toEqual([]);
  });

  it('the Commons: every person-only route goes through commonsApi, which holds them all on a demote', () => {
    const api = source('lib/commonsApi.ts');
    // The one sender, and its first statement answers as with no token while a demote holds
    // (round 11: the session's own settled demote too; round 13: any settled hold, promoted on
    // this page or not). Comments may sit above it.
    expect(api).toMatch(/async function send\([^)]*\): Promise<Response> \{\n(?:\s*\/\/.*\n)*\s+if \(commonsCallsHeld\(\) \|\| personHeldSettled\(\)\) throw sessionLost\(heading, sentAt\);/);
    const view = source('components/commons/CommonsView.tsx');
    // The view holds the calls while it renders demoted (round 11: the parts that matter, not
    // their adjacency), and its data starts again on the demote and the promote's epoch. Round 13
    // (review 10 MEDIUM-2): the body takes the view and empties its data (the controls stay), and
    // the panes that load their own are keyed on it.
    const viewFn = view.slice(view.indexOf('= useDemotedView();') - 40);
    expect(viewFn).toMatch(/^[^]*?const \{ demoted, epoch \} = useDemotedView\(\);\n(?:\s*\/\/.*\n)*\s*holdCommonsCalls\(demoted\);/);
    expect(viewFn).toMatch(/const view = demoted \? 'demoted' : `live-\$\{epoch\}`;/);
    expect(viewFn).toMatch(/<CommonsViewBody view=\{view\}/);
    for (const pane of ['CommonsReview', 'CommonsEvaluation', 'CommonsSettings']) expect(viewFn).toContain(`<${pane} key={view}`);
    expect(viewFn).toContain('key={`${view}:${selectedId}`}');
    const commons = routes.filter((r) => r.path.startsWith(COMMONS));
    const missing = commons.filter((r) => {
      const tail = r.path.slice(COMMONS.length).replace(/\{[^}]+\}/g, '${').split('${')[0];
      return !api.includes(`'${tail}`) && !api.includes(`\`${tail}`);
    });
    expect(missing.map(key)).toEqual([]);
    // Nothing else sends to the Commons: elsewhere its path names only a blob, loaded through
    // commonsApi.blob (the same send).
    const others: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(name) || /\.test\./.test(name) || full.endsWith('lib/commonsApi.ts')) continue;
        // Round 11: the strings and templates it writes, not its comments.
        if (writtenTexts(readFileSync(full, 'utf8')).some((text) => /\/api\/commons(?!\/blobs\/)/.test(text))) others.push(rel(full));
      }
    };
    walk(SRC);
    expect(others).toEqual([]);
  });
});

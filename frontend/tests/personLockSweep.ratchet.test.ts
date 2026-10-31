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
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callersOf, personOnlyRoutes, SRC } from './personGatedCallers';
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
  'lib/settingsWrites.ts#saveKey': { lock: 'change keys', in: [`${SETTINGS}ProvidersTab.tsx`] },
  'lib/settingsWrites.ts#removeKey': { lock: 'change keys', in: [`${SETTINGS}ProvidersTab.tsx`] },
  'lib/settingsWrites.ts#saveField': {
    lock: '', in: [`${SETTINGS}AgentSpendSection.tsx`, `${SETTINGS}StorageTab.tsx`, `${SETTINGS}KreaSignInRow.tsx`],
  },
  'lib/settingsWrites.ts#saveRunCostConfirm': { lock: 'change preferences', in: [`${SETTINGS}PreferencesTab.tsx`] },
  'components/create-studio/CreateComposer.tsx#handleEnhance': { lock: 'enhance prompts', in: ['components/create-studio/CreateComposer.tsx'] },
  'store/graphStore.ts#configureOpenRouterModel': { lock: 'change the model', in: ['components/panels/Inspector.tsx'] },
  'store/graphStore.ts#fetchReplicateSchemaAndConfigure': { lock: 'change the model', in: ['components/panels/Inspector.tsx'] },
  'store/graphStore.ts#pushNodeParams': { not: 'sends PUT /api/graph/node/{id} (gated only by the canvas checks); the tracer reads the shared path' },
  'components/panels/Inspector.tsx#renderUniversalModelControl': { lock: 'save favorites', in: ['components/panels/Inspector.tsx'] },
  [`${SETTINGS}useKreaConnection.ts#disconnect`]: { lock: 'change the Krea sign-in', in: [`${SETTINGS}KreaSignInRow.tsx`] },
  [`${SETTINGS}useKreaConnection.ts#signIn`]: { lock: 'change the Krea sign-in', in: [`${SETTINGS}KreaSignInRow.tsx`] },
  [`${SETTINGS}useKreaConnection.ts#check`]: { lock: 'change the Krea sign-in', in: [`${SETTINGS}KreaSignInRow.tsx`] },
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
  'App.tsx#App': { not: 'reads settings (GET /api/settings, open to every tab); the tracer reads the shared path' },
  'App.tsx#handleSettingsSaved': { not: 'reads settings again after a save (GET); the tracer reads the shared path' },
  'components/panels/Settings.tsx#Settings': { not: 'reads settings on open (GET); the tracer reads the shared path' },
};

/** saveField's hosts each lock with their own verb. */
const SAVE_FIELD_VERBS: Record<string, string> = {
  [`${SETTINGS}AgentSpendSection.tsx`]: 'change limits',
  [`${SETTINGS}StorageTab.tsx`]: 'change storage settings',
  [`${SETTINGS}KreaSignInRow.tsx`]: 'change the Krea sign-in',
};

/** Person-only routes the tracer can't follow to a caller (a path built from a helper), with the
 * file that sends them and what holds the control. Fails once the tracer reads them. */
const UNTRACED: Record<string, { sender: string; tail: string; entry: Entry }> = {
  'POST /api/canvas/agent-notes/{note_id}/dismiss': {
    sender: 'lib/agentNotes.ts', tail: '/dismiss`', entry: { lock: 'dismiss updates', in: ['components/agent-notes/AgentNoteCard.tsx'] },
  },
  'POST /api/moodboards/{moodboard_id}/agent-notes/{note_id}/dismiss': {
    sender: 'lib/agentNotes.ts', tail: '/dismiss`', entry: { lock: 'dismiss updates', in: ['components/agent-notes/AgentNoteCard.tsx'] },
  },
  'POST /api/canvas/agent-notes/read': {
    sender: 'lib/agentNotes.ts', tail: '/read`', entry: { not: 'read on open, no control; a refusal says markReadRefusedCopy' },
  },
  'POST /api/moodboards/{moodboard_id}/agent-notes/read': {
    sender: 'lib/agentNotes.ts', tail: '/read`', entry: { not: 'read on open, no control; a refusal says markReadRefusedCopy' },
  },
};

const source = (file: string) => readFileSync(join(SRC, file), 'utf8');
const rel = (key: string) => key.replace(/^.*\/src\//, '');
const key = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

function checkEntry(entry: Entry, where: string, problems: string[]) {
  if ('not' in entry) return;
  if ('demoted' in entry) {
    if (!/useDemotedView\(\)/.test(source(entry.demoted))) problems.push(`${where}: ${entry.demoted} doesn't switch on a demote (useDemotedView)`);
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
  });

  it('every caller of a person-only route is mapped to its lock, and every entry is still a caller', { timeout: 30_000 }, () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      if (route.path.startsWith(COMMONS)) continue;
      const callers = [...callersOf(route).keys()].map(rel);
      const untraced = UNTRACED[key(route)];
      if (callers.length === 0) {
        if (!untraced) { problems.push(`${key(route)}: no caller found and not in UNTRACED`); continue; }
        if (!source(untraced.sender).includes(untraced.tail)) problems.push(`${key(route)}: ${untraced.sender} no longer sends ${untraced.tail}`);
        checkEntry(untraced.entry, key(route), problems);
        continue;
      }
      if (untraced) problems.push(`${key(route)}: the tracer reads it now; move it from UNTRACED to CALLERS`);
      for (const caller of callers) {
        seen.add(caller);
        const entry = CALLERS[caller];
        if (!entry) { problems.push(`${key(route)}: ${caller} sends it and has no lock entry`); continue; }
        checkEntry(entry, `${key(route)} via ${caller}`, problems);
      }
    }
    for (const caller of Object.keys(CALLERS)) if (!seen.has(caller)) problems.push(`${caller}: in CALLERS but sends no person-only route`);
    expect(problems).toEqual([]);
  });

  it('the Commons: every person-only route goes through commonsApi, which holds them all on a demote', () => {
    const api = source('lib/commonsApi.ts');
    // The one sender, and its first statement answers as with no token while a demote holds.
    expect(api).toMatch(/async function send\([^)]*\): Promise<Response> \{\n\s+if \(commonsCallsHeld\(\)\) throw sessionLost\(heading, sentAt\);/);
    const view = source('components/commons/CommonsView.tsx');
    expect(view).toMatch(/const \{ demoted, epoch \} = useDemotedView\(\);\n(?:\s*\/\/.*\n)*\s*holdCommonsCalls\(demoted\);\n\s*return <CommonsViewBody key=\{demoted \? 'demoted' : `live-\$\{epoch\}`\} \/>;/);
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
        const text = readFileSync(full, 'utf8');
        if (/\/api\/commons(?!\/blobs\/)/.test(text)) others.push(rel(full));
      }
    };
    walk(SRC);
    expect(others).toEqual([]);
  });
});

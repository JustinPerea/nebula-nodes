/**
 * Design: curly apostrophes are for prose a person reads in the app. Backend text arrives as the
 * backend wrote it (straight), and the frontend curls it where it renders. Raw Details views, code,
 * paths, ids, commands and an agent's own words stay as they came.
 *
 * Two checks live here.
 *
 * 1. The render-path table (RENDER_PATHS): every place the app shows a backend message, rendered (or,
 *    for a pure function, called) with a straight-apostrophe fixture. A `curl` row must show
 *    "Krea’s key doesn’t work" and keep a quoted name, a path and a code span byte for byte; a `raw` row
 *    (Details, code) and an `agent` row (an agent's own words) must show the fixture unchanged.
 * 2. The tripwire: a file that reads one of the backend's message fields and is not in the table fails,
 *    so a new render path cannot arrive uncurled. Add the path to RENDER_PATHS (curled, or marked raw
 *    with why), or, if the file only passes the field on, to PASSES_ON with a one-line reason.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor as eventually } from '@testing-library/react';
import { vi } from 'vitest';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { LineText } from '../src/components/LineText';
import { ErrorDetails } from '../src/components/failure/ErrorDetails';
import { NodeError } from '../src/components/nodes/NodeError';
import { SkippedBadge } from '../src/components/nodes/SkippedBadge';
import { AgentLogEntryRow } from '../src/components/panels/AgentLogEntryRow';
import { agentActionEntry } from '../src/store/agentLogStore';
import { PERSON_REQUIRED_COPY, RequestFailedError, becauseLine, curlApostrophes, foldApostrophes, notConnectedBecause } from '../src/lib/errorCopy';
import { agentStatusTitle, chatErrorLine } from '../src/lib/chatErrorLine';
import { chatUploadChipError } from '../src/lib/chatUploadCopy';
import { dropNoticeText } from '../src/lib/canvasFileDrop';
import { skippedLabel } from '../src/lib/gating';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';
import { keychainKeptLine, unreadableSettingsLine, SETTINGS_REFUSAL_CODES } from '../src/lib/settingsWrites';
import { noticeParts } from '../src/lib/settingsNotice';
import { skippedLines } from '../src/lib/moodboardEdits';
import { notReadyLine, notReadyWarning, proposalPlan } from '../src/lib/canvasProposalsBar';
import { proposalHoldLine, withHoldLine } from '../src/lib/ledgerHold';
import { waitDescription, waitFor } from '../src/lib/nodeWait';
import { resetLinesForTests, registerLine, registeredLines } from '../src/lib/notConnectedLine';
import { stateLabel } from '../src/lib/agentNotesView';
import type { AgentNote } from '../src/lib/agentNotes';
import type { AgentPresenceEvent, ProposalNotReady, ProposalView } from '../src/lib/wsClient';


// The few paths that load their words over the network are given them here.
const net = vi.hoisted(() => ({ personalAgents: vi.fn(), settingsNotice: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  fetchPersonalAgents: (...args: unknown[]) => net.personalAgents(...args),
}));
vi.mock('../src/lib/settingsNotice', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/settingsNotice')>(),
  getSettingsNotice: (...args: unknown[]) => net.settingsNotice(...args),
}));
vi.mock('../src/lib/commonsApi', () => ({ commonsApi: { blob: () => new Promise(() => {}) }, commonsEvaluationApi: {}, commonsReviewApi: {} }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { ProviderRecoveryStatus } = await import('../src/components/ProviderRecoveryStatus');
const { RunHistoryPanel } = await import('../src/components/panels/RunHistoryPanel');
const { ChatModelPicker } = await import('../src/components/panels/ChatModelPicker');
const { AssistantBubble } = await import('../src/components/panels/ChatPanel');
const { LastRunNotes } = await import('../src/components/panels/Inspector');
const { SetupPanel, ConnectedApps } = await import('../src/components/panels/settings/ConnectedApps');
const { PersonalAgentsSection } = await import('../src/components/panels/settings/PersonalAgentsSection');
const { SettingsTopNotice } = await import('../src/components/panels/settings/SettingsTopNotice');
const { JevNotes } = await import('../src/components/panels/JevResultDetails');
const { BriefPanel } = await import('../src/components/moodboard-studio/MoodboardBrief');
const { BoardSwatches } = await import('../src/components/moodboard-studio/MoodboardColors');
const { BoardUndoToast } = await import('../src/components/moodboard-studio/BoardUndoToast');
const { AnalysisSummary } = await import('../src/components/moodboard-studio/MoodboardStudioView');
const { FolderRow } = await import('../src/components/commons/CommonsSettings');
const { ReviewForm } = await import('../src/components/commons/CommonsReview');
const { CommonsGrid } = await import('../src/components/commons/CommonsGrid');
const { FidelityBadge } = await import('../src/components/commons/CommonsDetail');
const { NoteText } = await import('../src/components/agent-notes/AgentNoteParts');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
afterEach(() => { cleanup(); resetLinesForTests(); useGraphStore.setState(INITIAL_GRAPH, true); useUIStore.setState(INITIAL_UI, true); });

/** What the backend sent. */
export const FIXTURE = "Krea's key doesn't work";
/** A fixture with a quoted name, a path, a file name and a code span that must not change. */
export const KEEP = ['“Bob\'s file”', '/Users/me/Krea\'s/key.json', "Bob's_notes.txt", '`don\'t_touch`'];
export const FIXTURE_WITH_CODE = `${FIXTURE} in ${KEEP.join(' and ')}`;

type Mode = 'curl' | 'raw' | 'agent';
interface Row {
  /** Where the words show, and which of them. */
  id: string;
  mode: Mode;
  /** The files that read the backend field for this row (the tripwire's table). */
  files: string[];
  /** Renders or calls the path with `text` as the backend's words; returns what shows. */
  show: (text: string) => string | Promise<string>;
  /** What the path can carry unchanged (default: all of KEEP); a path that builds a sentence out of the text may not carry a file name's dot. */
  keep?: string[];
  /** Straight-apostrophe words the row shows on purpose (a path it adds itself). */
  straight?: string[];
}

const shown = (element: React.ReactElement) => render(element).container.textContent ?? '';

const AGENT_FILES: Array<[string, string]> = [
  ['proposal note', 'components/canvas/ProposalBar.tsx'],
  ['cursor say pill', 'components/agent-cursor/AgentCursorField.tsx'],
  ['roster status', 'components/agent-notes/AgentRoster.tsx'],
  ['question cards', 'components/agent-notes/AgentQuestionsForm.tsx'],
  ['person thread rows', 'components/panels/MessageBox.tsx'],
  ['asset proposal note and edit reason', 'components/proposals/AssetProposalStrip.tsx'],
];
const SRC = join(__dirname, '..', 'src');
const proposalState = (wait: Record<string, unknown> | undefined) => ({
  proposals: {
    p1: { closing: false, view: { id: 'p1', createdAt: 1, agent: { id: 'a', name: 'Agent', color: '#fff', verified: true }, wait } },
  },
}) as unknown as Parameters<typeof waitFor>[0];

const notReadyRow = (over: Partial<ProposalNotReady>): ProposalNotReady =>
  ({ ref: 'n1', nodeId: null, name: 'Krea', missing: 'needs a key', ...over }) as ProposalNotReady;

const nebulaNote = (source: 'agent' | 'nebula', text: string): AgentNote => ({
  id: 'n', source, text, parts: [{ text }], actions: [], refs: [], outcome: text,
}) as unknown as AgentNote;

const presence = (over: Partial<AgentPresenceEvent>): AgentPresenceEvent => ({
  type: 'agentPresence', agent: { id: 'a', name: 'Agent', color: '#336699', verified: true }, action: 'move', say: '', at: 1, ...over,
}) as AgentPresenceEvent;

const logRow = (event: Partial<AgentPresenceEvent>) => {
  const entry = agentActionEntry(presence(event), 1);
  if (!entry) throw new Error('no entry');
  return shown(<ul><AgentLogEntryRow entry={{ ...entry, id: 'e' }} /></ul>);
};

async function sceneLine(detail: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { sceneRefusal } = await import('../src/store/graphStore');
  const response = new Response(JSON.stringify({ detail, ...extra }), { status: 409 });
  const answer = await sceneRefusal('n1', response) as { line?: string };
  return answer.line ?? '';
}


const record = (over: Record<string, unknown>) => ({ id: 'r1', status: 'complete', trigger: 'graph', startedAt: Date.now(),
  snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: {}, outputs: {} }], edges: [] }, ...over });
function historyText(over: Record<string, unknown>): string {
  useGraphStore.setState({ runHistory: [record(over)] as never, isExecuting: false });
  useUIStore.setState((state) => ({ panels: { ...state.panels, history: { ...state.panels.history, visible: true } } }));
  return shown(<RunHistoryPanel />);
}

const personalAgent = (over: Record<string, unknown>) => ({
  id: 'x', kind: 'preset', displayName: 'Gemini', color: '#336699', enabled: true, command: 'gemini', args: [], status: 'ready', resolvedPath: '/bin/gemini',
  note: 'n', startable: true,
  keyOption: { enabled: false, keySaved: true, billing: FIXTURE_TEXT.current, blocked: FIXTURE_TEXT.current },
  install: { state: 'downloading', version: '1', sizeBytes: 10, message: FIXTURE_TEXT.current, source: null, job: { state: 'running', message: FIXTURE_TEXT.current, receivedBytes: 1, totalBytes: 2 } },
  signIn: { state: 'waiting', job: { state: 'running', message: FIXTURE_TEXT.current } },
  ...over,
}) as never;
const FIXTURE_TEXT = { current: FIXTURE };

function pickerText(over: Record<string, unknown>): string {
  render(<ChatModelPicker agent="claude" model={null} effort={null} catalog={null} loading={false} error={null} disabled={false}
    onAgentChange={() => {}} onModelChange={() => {}} onEffortChange={() => {}} onRetry={() => {}} {...over as object} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose chat model' }));
  return screen.getByRole('dialog', { name: 'Chat model settings' }).textContent ?? '';
}

const clashBrief = (t: string) => ({
  styleBrief: 'Brief.', generatedStyleBrief: 'Brief.', negativePrompt: '', avoid: [], avoidPrompt: '', direction: '',
  pinnedColors: { include: [], exclude: [] }, palette: [], accents: [], override: { active: false, stale: false }, needsAnalysis: false,
  leftOut: [{ hex: '#ff0000', role: 'palette', level: 'conflict', reason: t, reasons: [t], why: 'check', foundBy: ['words'] }],
}) as never;

const setup = (t: string) => ({ client: 'c', label: 'Client', kind: 'json', format: 'json', where: t, snippet: t, steps: [t],
  alternative: { format: 'json', where: t, snippet: t }, tokenFile: '/Users/me/token', cli: t, warnings: [t] }) as never;

const gridRow = { id: 'ast_1', membership_id: 'mem_1', collection_id: 'col_1', collection: 'Open refs', summary: 'x', role: 'neutral', media: 'image',
  made_by: 'unknown', analysis_state: 'ready', in_inbox: false, comment_count: 0, matched: [], score: 1, blob_key: 'a.png', also_in: [] } as never;

/** A graded reference whose model-read words are `t` (or `Krea's key doesn't work`), or one with `over`. */
function reviewText(over: Record<string, unknown>, t = FIXTURE): string {
  const labels = { tags: { type_style: 'none' }, axes: { quiet_loud: 0.25 }, palette_roles: { '0': 'accent' }, keywords: [], no_keywords: true, flagged: false };
  const item = { position: 0, image_sha256: 'x', width: 40, height: 32, status: 'ready', revision: 1, palette: [{ index: 0, hex: '#ff0000', share: 1 }],
    reviewed_labels: null, reviewer: null, reviewed_at: null, error: null,
    proposal: { model: 'm', prompt_version: 'p', labels, fields: { summary: { value: t, why: t }, composition_notes: { value: t, why: t },
      type_style: { value: 'none', why: t }, axes: { quiet_loud: { value: 0.25, why: t } } } }, ...over };
  const batch = { mode: 'assisted_review', independent_ground_truth: false, manifest_hash: 'x', state: 'open', batch_revision: 1, closed_at: null, close_hash: null,
    model: 'm', fields: { type_style: ['none', 'serif'] }, axes: ['quiet_loud'], roles: ['accent'], keywords: ['geometric_type'], call_budget: 0, attempts: 1, items: [item] };
  return shown(<ReviewForm batch={batch as never} item={item as never} dirty={false} saving={false} generating={false} onDirty={() => {}}
    onAccept={async () => ({}) as never} draftRef={{ current: null }} statusLineId="s" onDiscarded={() => {}} />);
}

export const RENDER_PATHS: Row[] = [
  // Request-failure lines
  { id: 'LineText', mode: 'curl', files: ['components/LineText.tsx'], show: (t) => shown(<LineText text={t} />) },
  { id: 'LineText string children', mode: 'curl', files: ['components/LineText.tsx'], show: (t) => shown(<LineText text="x">{t}</LineText>) },
  { id: 'becauseLine, no heading', mode: 'curl', files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: '', reason: t }) },
  { id: 'becauseLine, heading not "Couldn’t x."', mode: 'curl', files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: 'Save failed', reason: t }) },
  { id: 'becauseLine, unreadable heading in a named reason', mode: 'curl', files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: '', reason: `Couldn't read ${t}` }), keep: KEEP.filter((kept) => !kept.includes('.')) },
  { id: 'becauseLine, a sentence reason (already curled)', mode: 'curl', files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: 'Couldn’t save the project.', reason: t }) },
  { id: 'chat image chip error', mode: 'curl', files: ['lib/chatUploadCopy.ts'], show: (t) => chatUploadChipError(400, t) },
  { id: 'dropped-files reasons', mode: 'curl', files: ['lib/canvasFileDrop.ts'],
    show: (t) => dropNoticeText([{ kind: 'upload', name: 'a.png', line: 'x', reason: t }, { kind: 'upload', name: 'b.png', line: 'x', reason: t }], 2) ?? '' },
  { id: 'scene-save refusal, a rendering stop', mode: 'curl', files: ['store/graphStore.ts'],
    show: (t) => sceneLine(`Couldn't save the scene because ${t}.`, { rendering: { shotIds: ['s1'] } }) },
  { id: 'scene-save refusal, kept', mode: 'curl', files: ['store/graphStore.ts'], show: (t) => sceneLine(`Couldn't save the scene because ${t}.`) },
  { id: 'settings-file refusal', mode: 'curl', files: ['lib/settingsWrites.ts'],
    show: (t) => unreadableSettingsLine(new RequestFailedError('Couldn’t save.', 409, { detail: t, code: SETTINGS_REFUSAL_CODES[0] })) ?? '' },
  { id: 'keychain-kept fix sentence', mode: 'curl', files: ['lib/settingsWrites.ts', 'lib/errorCopy.ts'],
    show: (t) => `${keychainKeptLine('removal', 'openai', 'row', t)}|${keychainKeptLine('save-over', 'openai', 'row', t)}|${keychainKeptLine('save-new', 'openai', 'row', t)}` },
  { id: 'asset proposal accept refusal (rendered through LineText)', mode: 'curl', files: ['store/assetProposalsStore.ts', 'components/proposals/AssetProposalStrip.tsx'], show: (t) => shown(<LineText text={`Nebula couldn’t accept this because ${t}`} />) },
  // Node run state
  { id: 'waiting stop', mode: 'curl', files: ['lib/nodeErrorCopy.ts'], show: (t) => nodeErrorCopy({ category: 'waiting', person: t }).reason },
  { id: 'run failure (already curled)', mode: 'curl', files: ['lib/nodeErrorCopy.ts', 'components/nodes/NodeError.tsx', 'components/nodes/ModelNode.tsx', 'components/nodes/DynamicNode.tsx', 'components/nodes/BatchNode.tsx',
    'components/cinema-studio/CinemaShotPanel.tsx', 'components/create-studio/ResultCard.tsx'], show: (t) => nodeErrorCopy({ category: 'unknown', person: t }).reason },
  { id: 'NodeError, rendered', mode: 'curl', files: ['components/nodes/NodeError.tsx'], show: (t) => shown(<NodeError category="unknown" person={t} />) },
  { id: 'NodeError, a waiting stop, rendered', mode: 'curl', files: ['components/nodes/NodeError.tsx'], show: (t) => shown(<NodeError category="waiting" person={t} />) },
  { id: 'ErrorDetails, the raw words behind a project error', mode: 'raw', files: ['components/projects/ProjectHome.tsx', 'components/failure/ErrorDetails.tsx'], show: (t) => shown(<ErrorDetails raw={t} />) },
  { id: 'NodeError raw Details, rendered', mode: 'raw', files: ['components/nodes/NodeError.tsx'], show: (t) => shown(<NodeError category="unknown" raw={t} person="It stopped." providerText />) },
  { id: 'NodeError raw Details', mode: 'raw', files: ['lib/nodeErrorCopy.ts'], show: (t) => nodeErrorCopy({ category: 'unknown', raw: t, person: 'It stopped.', providerText: true }).details ?? '' },
  { id: 'skipped label', mode: 'curl', files: ['lib/gating.ts'], show: (t) => skippedLabel(t) },
  { id: 'skipped badge title and aria-label', mode: 'curl', files: ['components/nodes/SkippedBadge.tsx', 'components/nodes/ModelNode.tsx', 'components/nodes/DynamicNode.tsx'],
    show: (t) => { const badge = render(<SkippedBadge reason={t} />).container.firstElementChild!; return `${badge.getAttribute('title')}|${badge.getAttribute('aria-label')}`; } },
  { id: 'wait description', mode: 'curl', files: ['lib/nodeWait.ts'],
    show: (t) => waitDescription(waitFor(proposalState({ barLine: t, nodeIds: ['n1'], names: [] }), 'n1')!) },
  // Proposals
  { id: 'plan line', mode: 'curl', files: ['lib/canvasProposalsBar.ts'], show: (t) => proposalPlan({ plan: t } as ProposalView) },
  { id: 'can’t run here, the person line', mode: 'curl', files: ['lib/canvasProposalsBar.ts'], show: (t) => notReadyLine(notReadyRow({ person: t })) },
  { id: 'can’t run here, the missing words', mode: 'curl', files: ['lib/canvasProposalsBar.ts'], show: (t) => notReadyLine(notReadyRow({ missing: t })) },
  { id: 'ghost-card warning', mode: 'curl', files: ['lib/canvasProposalsBar.ts'], show: (t) => notReadyWarning(notReadyRow({ person: t })) ?? '' },
  { id: 'hold line', mode: 'curl', files: ['lib/ledgerHold.ts'],
    show: (t) => withHoldLine('Note.', proposalHoldLine({ until: 4_000_000_000, line: t }, 1000)) },
  // Chat panel
  { id: 'chat error line, whole', mode: 'curl', files: ['lib/chatErrorLine.ts'], show: (t) => chatErrorLine({ message: `${t}.`, source: 'system', agentName: 'Claude' }).text },
  { id: 'chat error line, because', mode: 'curl', files: ['lib/chatErrorLine.ts'], show: (t) => chatErrorLine({ message: `claude: ${t}`, agentName: 'Claude' }).text },
  { id: 'chat error Details', mode: 'raw', files: ['lib/chatErrorLine.ts'], show: (t) => chatErrorLine({ message: `${t}\nmore`, agentName: 'Claude' }).details ?? '' },
  // Settings
  { id: 'settings top notice', mode: 'curl', files: ['lib/settingsNotice.ts'],
    straight: ["/Users/me/Krea's/settings.json"],
    show: (t) => { const parts = noticeParts({ line: `${t} /Users/me/Krea's/settings.json ${t}`, path: "/Users/me/Krea's/settings.json" } as never); return `${parts.before}${parts.path}${parts.after}`; } },
  // Agent surfaces: Nebula's own words are curled, an agent's own are not
  { id: 'agent log: the backend’s log field', mode: 'curl', files: ['store/agentLogStore.ts', 'components/panels/AgentLogEntryRow.tsx'], show: (t) => logRow({ say: 'ok', log: t }) },
  { id: 'agent log: the agent’s say', mode: 'agent', files: ['store/agentLogStore.ts', 'components/panels/AgentLogEntryRow.tsx'], show: (t) => logRow({ say: t }) },
  { id: 'Updates card outcome, source nebula', mode: 'curl', files: ['lib/agentNotesView.ts'], show: (t) => stateLabel(nebulaNote('nebula', t)) ?? '' },
  { id: 'Updates card outcome, source agent', mode: 'agent', files: ['lib/agentNotesView.ts'], show: (t) => stateLabel(nebulaNote('agent', t)) ?? '' },

  // Provider hold box
  { id: 'provider hold box', mode: 'curl', files: ['components/ProviderRecoveryStatus.tsx'],
    show: (t) => { useGraphStore.setState({ providerRecoveryWarning: t }); return shown(<ProviderRecoveryStatus />); } },
  // Run history
  { id: 'run history status note', mode: 'curl', files: ['components/panels/RunHistoryPanel.tsx', 'lib/runHistory.ts'], show: (t) => historyText({ statusNote: t }) },
  { id: 'run history skipped-nodes tooltip', mode: 'curl', files: ['components/panels/RunHistoryPanel.tsx'],
    show: (t) => { historyText({ skippedNodes: { n1: t } }); return document.querySelector('.run-history__skipped')?.getAttribute('title') ?? ''; }, keep: KEEP },
  // Chat panel
  { id: 'model picker unavailable line', mode: 'curl', files: ['components/panels/ChatModelPicker.tsx', 'lib/api.ts'], show: (t) => pickerText({ error: t }) },
  { id: 'agent status hover title', mode: 'curl', files: ['components/panels/ChatPanel.tsx', 'lib/api.ts'], show: (t) => agentStatusTitle(t, 'a session') ?? '' },
  { id: 'model picker, a personal agent’s note', mode: 'curl', files: ['components/panels/ChatModelPicker.tsx'],
    show: (t) => pickerText({ agent: 'personal:x', personalAgents: [{ ...personalAgent({ note: t }) }] }) },
  { id: 'Inspector last-run notes', mode: 'curl', files: ['components/panels/Inspector.tsx'], show: (t) => shown(<LastRunNotes notes={[t]} />) },
  // Moodboard and Commons
  { id: 'undo toast kept lines', mode: 'curl', files: ['components/moodboard-studio/MoodboardStudioView.tsx', 'components/moodboard-studio/BoardUndoToast.tsx'],
    show: (t) => shown(<BoardUndoToast toast={{ id: 1, text: 'Removed', skipped: skippedLines({ applied: [{ skipped: [{ message: t }] }] } as never), action: { label: 'Undo', run: () => {} } }} onDismiss={() => {}} />) },
  { id: 'colour clash reasons', mode: 'curl', files: ['components/moodboard-studio/MoodboardBrief.tsx'],
    show: (t) => { const { container } = render(<BriefPanel brief={clashBrief(t)} override={null} saving={false} busy={false} onEdit={() => {}} onKeep={() => {}} onRegenerate={() => {}} />);
      return [...container.querySelectorAll('.moodboard-clash__reason')].map((node) => node.textContent).join('|'); } },
  { id: 'swatch tooltips for a colour left out of the brief', mode: 'curl', files: ['components/moodboard-studio/MoodboardColors.tsx'],
    show: (t) => { const { container } = render(<BoardSwatches label="Palette" role="dominant" analysis={{ palette: ['#ff0000'], accents: [] } as never}
      leftOut={[{ hex: '#ff0000', role: 'palette', level: 'conflict', reason: t, reasons: [t], why: 'check', foundBy: ['words'] }]} />);
      return container.querySelector('[role="listitem"]')?.getAttribute('title') ?? ''; } },
  { id: 'Commons folder device error', mode: 'curl', files: ['components/commons/CommonsSettings.tsx'],
    show: (t) => shown(<ul><FolderRow link={{ id: 'l', path: '/refs', ignores: [], last_scan_at: null, last_scan_summary: null, device_states: [{ path: '/refs', state: 'error', error: t }] }} run={async () => true} /></ul>) },
  { id: 'Commons grade slot error', mode: 'curl', files: ['components/commons/CommonsReview.tsx'], show: (t) => reviewText({ proposal: null, status: 'failed', error: t }) },
  { id: 'borrowing fidelity title', mode: 'curl', files: ['components/commons/CommonsDetail.tsx'],
    show: (t) => render(<FidelityBadge fidelity={{ status: 'failed', reason: t }} />).container.firstElementChild?.getAttribute('title') ?? '' },
  { id: 'Commons analysis failure Details', mode: 'raw', files: ['components/commons/CommonsDetail.tsx'], show: (t) => t },
  // Settings
  { id: 'settings top notice (rendered)', mode: 'curl', files: ['components/panels/settings/SettingsTopNotice.tsx'], straight: ["/Users/me/Krea's/settings.json"],
    show: async (t) => { net.settingsNotice.mockResolvedValue({ kind: 'restored', line: `${t} /Users/me/Krea's/settings.json`, path: "/Users/me/Krea's/settings.json" });
      const { container } = render(<SettingsTopNotice visible />); await eventually(() => expect(container.querySelector('.settings-top-notice__line')).not.toBeNull());
      return container.querySelector('.settings-top-notice__line')?.textContent ?? ''; } },
  { id: 'Connect your agent: why a checkout can’t be pointed at', mode: 'curl', files: ['components/panels/settings/ConnectedApps.tsx', 'lib/api.ts'],
    show: (t) => shown(<ConnectedApps view={{ outside: { spentUsd: 0, kreaPlanRuns: 0 }, apps: [], connect: { clients: [{ id: 'c', label: 'C' }], available: false, reason: t } }} loadError={null} onChanged={() => {}} />) },
  { id: 'setup panel steps, warnings and where', mode: 'curl', files: ['components/panels/settings/ConnectedApps.tsx'],
    show: (t) => { const { container } = render(<SetupPanel name="App" setup={setup(t)} onDone={() => {}} onError={() => {}} />);
      return ['.settings-apps__steps', '.settings-pref__description', '.settings-apps__warnings'].flatMap((css) => [...container.querySelectorAll(css)].map((node) => node.textContent)).join('|'); } },
  { id: 'setup panel code, command and path', mode: 'raw', files: ['components/panels/settings/ConnectedApps.tsx'],
    show: (t) => { const { container } = render(<SetupPanel name="App" setup={setup(t)} onDone={() => {}} onError={() => {}} />);
      return [...container.querySelectorAll('pre')].map((node) => node.textContent).join('|'); } },
  { id: 'personal agents: key option, install and sign-in lines, notes', mode: 'curl', files: ['components/panels/settings/PersonalAgentsSection.tsx', 'lib/api.ts'],
    show: async (t) => { net.personalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [personalAgent({ note: t, termsNote: t })] });
      const { container } = render(<PersonalAgentsSection />); await eventually(() => expect(container.querySelector('.personal-agents__terms')).not.toBeNull());
      return [...container.querySelectorAll('.personal-agents__terms, .personal-agents__fine, .personal-agents__progress, .settings-row__error, .settings-pref__description')].map((node) => node.textContent).join('|'); } },
  // Agent-written and model-read words
  { id: 'moodboard analysis summary', mode: 'curl', files: ['components/moodboard-studio/MoodboardStudioView.tsx'], show: (t) => shown(<AnalysisSummary text={t} />) },
  { id: 'Commons read fields: summary, notes, why', mode: 'curl', files: ['components/commons/CommonsReview.tsx'], show: (t) => reviewText({}, t) },
  { id: 'Commons grid caption', mode: 'curl', files: ['components/commons/CommonsGrid.tsx'],
    show: (t) => { const { container } = render(<CommonsGrid rows={[{ ...gridRow, summary: t }]} selectedId={null} loading={false} emptyHint="" onOpen={() => {}} onDropFiles={() => {}} />);
      const tile = container.querySelector('[data-commons-tile]')!; return `${tile.textContent}|${tile.getAttribute('title')}|${tile.getAttribute('aria-label')}`; } },
  { id: 'Jev judge notes', mode: 'curl', files: ['components/panels/JevResultDetails.tsx'], show: (t) => shown(<JevNotes notes={[t]} />) },
  { id: 'Updates card text, source nebula', mode: 'curl', files: ['components/agent-notes/AgentNoteParts.tsx'], show: (t) => shown(<NoteText note={nebulaNote('nebula', t)} />) },
  { id: 'Updates card text, source agent', mode: 'agent', files: ['components/agent-notes/AgentNoteParts.tsx'], show: (t) => shown(<NoteText note={nebulaNote('agent', t)} />) },
  { id: 'chat assistant text', mode: 'agent', files: ['components/panels/ChatPanel.tsx'],
    show: (t) => shown(<AssistantBubble message={{ role: 'assistant', id: 'm', streaming: false, parts: [{ kind: 'text', text: t }] } as never} agentName="Claude" onPermission={() => {}} />) },
  // An agent's own words, in files too large to mount here: the file never curls them (its source calls no curlApostrophes).
  ...AGENT_FILES.map(([id, file]): Row => ({ id, mode: 'agent', files: [file], show: (t) => (readFileSync(join(SRC, file), 'utf8').includes('curlApostrophes') ? 'CURLED IN SOURCE' : t) })),
  { id: 'chat system line (through LineText)', mode: 'curl', files: ['components/panels/ChatPanel.tsx'],
    show: (t) => shown(<AssistantBubble message={{ role: 'assistant', id: 'm', streaming: false, parts: [{ kind: 'system', text: t, because: false }] } as never} agentName="Claude" onPermission={() => {}} />) },
];

describe('the render-path table: backend text is curled where it renders', () => {
  const rows = RENDER_PATHS.filter((row) => row.mode === 'curl');
  it.each(rows.map((row) => [row.id, row] as const))('%s', async (_id, row) => {
    const out = await row.show(FIXTURE);
    const said = out.toLowerCase();
    expect(said, row.id).toContain('krea’s');
    expect(said, row.id).toContain('doesn’t');
    expect((row.straight ?? []).reduce((left, word) => left.split(word).join(''), out), row.id).not.toMatch(/\p{L}'\p{L}/u);
  });

  it.each(rows.map((row) => [row.id, row] as const))('%s keeps a quoted name, a path, a file name and a code span as they were', async (_id, row) => {
    const out = await row.show(FIXTURE_WITH_CODE);
    expect(out.toLowerCase(), row.id).toContain('krea’s key doesn’t work');
    // A code span is drawn without its backticks by LineText, so compare its inside.
    for (const kept of row.keep ?? KEEP) expect(out, `${row.id}: ${kept}`).toContain(kept.replace(/^`|`$/g, ''));
  });

  it.each(RENDER_PATHS.filter((row) => row.mode !== 'curl').map((row) => [row.id, row] as const))('%s stays as it came', async (_id, row) => {
    const out = await row.show(FIXTURE);
    expect(out, row.id).toContain(FIXTURE);
  });

  it('curlApostrophes is idempotent on a line that is already curled', () => {
    expect(curlApostrophes(curlApostrophes(FIXTURE))).toBe('Krea’s key doesn’t work');
  });
});

describe('a registered line is matched on either apostrophe', () => {
  it('a curled line matches a straight registration, and the reverse', () => {
    for (const words of [PERSON_REQUIRED_COPY, foldApostrophes(PERSON_REQUIRED_COPY)]) {
      resetLinesForTests();
      const element = document.createElement('p');
      document.body.append(element);
      const held = registerLine(element, words);
      expect([...registeredLines().values()].map((line) => line.kind)).toEqual(['fix']);
      held();
      element.remove();
    }
    expect(notConnectedBecause('save it', false)).toContain('connected as you');
  });

  it('LineText registers a straight line the same as a curled one', () => {
    for (const words of [PERSON_REQUIRED_COPY, foldApostrophes(PERSON_REQUIRED_COPY)]) {
      resetLinesForTests();
      const { container, unmount } = render(<p><LineText text={words} /></p>);
      expect([...registeredLines().values()].map((line) => line.kind), words).toEqual(['fix']);
      expect(container.textContent).toContain('isn’t connected');
      unmount();
    }
  });
});

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

/**
 * Files that read a backend field only to pass it on, store it or build a request's failure from it, and so draw
 * nothing themselves: what they hand on reaches the screen through a row of RENDER_PATHS. Each has its reason.
 */
export const PASSES_ON: Record<string, string> = {
  'lib/projects.ts': 'wraps a RequestFailedError in the project store\'s own error, keeping its reason and detail; the line is built by becauseLine and drawn through LineText',
  'lib/assetProposals.ts': 'wraps a RequestFailedError in the asset proposal error, keeping its reason and detail; the line is drawn through LineText',
  'lib/canvasProposals.ts': 'wraps a RequestFailedError in the proposal error; reads a not-ready row\'s words only to decide which rows to keep',
  'lib/validationCopy.ts': 'builds the failure reason from a run\'s validation errors; the line is drawn through becauseLine and LineText',
  'store/projectFlows.ts': 'drops a node\'s error when it stores a snapshot of the node; nothing is drawn',
  'store/personThreadStore.ts': 'keeps the agent\'s says and log lines for the thread; the rows that draw them are the agent log and person thread rows',
  'store/agentPresenceStore.ts': 'keeps the agent\'s say for its cursor; the row that draws it is the cursor say pill',
  'store/agentQuestionsStore.ts': 'reads a refusal\'s detail only to tell that a question was already answered; draws nothing',
  'store/canvasPinsStore.ts': 'compares a refusal\'s words with a stale-canvas marker; draws nothing',
  'components/moodboard-studio/boardSaveLine.ts': 'reads a refusal\'s detail and reason to choose between Nebula\'s own save lines; draws none of it',
};

const tableFiles = () => new Set(RENDER_PATHS.flatMap((row) => row.files));

/** Every file under src that reads one of BACKEND_FIELDS (a property read the type checker resolves to the declaration), with the field. */
let readers: Map<string, Set<string>> | null = null;
function readersOfBackendFields(): Map<string, Set<string>> {
  if (readers) return readers;
  const config = ts.getParsedCommandLineOfConfigFile(join(__dirname, '..', 'tsconfig.app.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const program = ts.createProgram(config!.fileNames.filter((name) => !/\.test\.tsx?$/.test(name)), config!.options);
  const checker = program.getTypeChecker();
  const wanted = new Set(Object.entries(BACKEND_FIELDS).flatMap(([file, members]) => members.map((member) => `${file}: ${member}`)));
  const owner = (declaration: ts.Node): string => {
    for (let node: ts.Node | undefined = declaration.parent; node; node = node.parent) {
      if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text;
    }
    return '?';
  };
  const found = new Map<string, Set<string>>();
  const note = (symbol: ts.Symbol | undefined, from: ts.SourceFile) => {
    for (const declaration of symbol?.declarations ?? []) {
      const where = relative(SRC, declaration.getSourceFile().fileName).split('\\').join('/');
      const key = `${where}: ${owner(declaration)}.${symbol!.name}`;
      if (!wanted.has(key)) continue;
      const file = relative(SRC, from.fileName).split('\\').join('/');
      found.set(file, (found.get(file) ?? new Set()).add(key));
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
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  readers = found;
  return found;
}

describe('the tripwire: a file that reads a backend message field is in the table', () => {
  it('names every reader of a backend field, so a new render path joins the table (curled, or marked raw) or says why it only passes the text on', { timeout: 120_000 }, () => {
    const reading = readersOfBackendFields();
    const known = tableFiles();
    const unlisted = [...reading].filter(([file]) => !known.has(file) && !(file in PASSES_ON)).map(([file, fields]) => `${file} reads ${[...fields].map((field) => field.split(': ')[1]).join(', ')}`);
    expect(unlisted, 'Add the render path to RENDER_PATHS in tests/backendTextCurl.test.tsx (curled, or marked raw with why), or to PASSES_ON with a one-line reason').toEqual([]);
  });

  it('PASSES_ON lists only files that still read a backend field, and each says why', { timeout: 120_000 }, () => {
    const reading = readersOfBackendFields();
    expect(Object.keys(PASSES_ON).filter((file) => !reading.has(file)), 'a file that no longer reads a field leaves PASSES_ON').toEqual([]);
    for (const [file, why] of Object.entries(PASSES_ON)) expect(why.length, file).toBeGreaterThan(10);
  });
});

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
 * 2. The tripwire, keyed on file and field: each row lists the backend fields it covers (`fields`) and the files
 *    that read them (`files`); a file that reads one of the backend's message fields, or calls a helper that hands back
 *    a backend detail string, passes only if a row names that file and that field, or PASSES_ON does (with its reason).
 *    A new render path therefore joins the table (curled, or marked raw with why), and a new read of another field in a
 *    listed file fails too. Agent files get a second check: the agent's own words are never read inside a LineText,
 *    becauseLine, oneLine, FailureLines or curlApostrophes (an AST check), and two of them are mounted.
 */
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor as eventually } from '@testing-library/react';
import { vi } from 'vitest';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LineText } from '../src/components/LineText';
import { ErrorDetails } from '../src/components/failure/ErrorDetails';
import { NodeError } from '../src/components/nodes/NodeError';
import { SkippedBadge } from '../src/components/nodes/SkippedBadge';
import { AgentLogEntryRow } from '../src/components/panels/AgentLogEntryRow';
import { agentActionEntry } from '../src/store/agentLogStore';
import { noteActivity, usePersonThreadStore } from '../src/store/personThreadStore';
import { messageStatus } from '../src/lib/personThreadBox';
import { commonsProposal, coverProposal } from '../src/test/assetProposalFixtures';
import { AGENT_FIELDS, BACKEND_FIELDS, SRC, appProgram, callKey, curledAgentReads, isCurlerIdentifier, readersOfBackendFields } from './helpers/backendFieldReads';
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
const net = vi.hoisted(() => ({ personalAgents: vi.fn(), settingsNotice: vi.fn(), acceptProposal: vi.fn(), commonsAsset: vi.fn() }));
vi.mock('../src/lib/assetProposals', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/assetProposals')>(),
  acceptAssetProposal: (...args: unknown[]) => net.acceptProposal(...args),
}));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  fetchPersonalAgents: (...args: unknown[]) => net.personalAgents(...args),
}));
vi.mock('../src/lib/settingsNotice', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/settingsNotice')>(),
  getSettingsNotice: (...args: unknown[]) => net.settingsNotice(...args),
}));
vi.mock('../src/lib/commonsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/commonsApi')>();
  return { ...original, commonsApi: { ...original.commonsApi, blob: () => new Promise(() => {}), asset: (...args: unknown[]) => net.commonsAsset(...args) } };
});
// The media draws as an image so a test can read the alt text it is given.
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: ({ alt }: { alt?: string }) => <img alt={alt ?? ''} data-commons-media="" /> }));

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
const { FidelityBadge, CommonsDetail } = await import('../src/components/commons/CommonsDetail');
const { AssetProposalStrip } = await import('../src/components/proposals/AssetProposalStrip');
const { CanvasUndoNotice } = await import('../src/components/canvas/CanvasUndoNotice');
const { CommonsErrorLine } = await import('../src/components/commons/CommonsErrorLine');
const { AgentQuestionsForm } = await import('../src/components/agent-notes/AgentQuestionsForm');
const { useAssetProposalsStore } = await import('../src/store/assetProposalsStore');
const { useAgentQuestionsStore } = await import('../src/store/agentQuestionsStore');
const { AssetProposalError } = await import('../src/lib/assetProposals');
const { NoteText } = await import('../src/components/agent-notes/AgentNoteParts');
const { useGraphStore } = await import('../src/store/graphStore');
const { useUIStore } = await import('../src/store/uiStore');

// The agent rows that are not mounted (the proposal note and others) check the source through the compiler's program, which
// takes a couple of seconds to build the first time. Build it once here, with its own timeout, so no row pays for it
// against the 5 s default (the first row to ask used to).
beforeAll(() => { appProgram(); }, 120_000);

const INITIAL_GRAPH = { ...useGraphStore.getState() };
const INITIAL_UI = { ...useUIStore.getState() };
afterEach(() => {
  cleanup(); resetLinesForTests(); useGraphStore.setState(INITIAL_GRAPH, true); useUIStore.setState(INITIAL_UI, true);
  useAssetProposalsStore.getState().clear(); useAgentQuestionsStore.getState().reset(); usePersonThreadStore.setState({ activity: {}, rows: [] });
});

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
  /** The files that read the backend fields for this row (the tripwire's table). */
  files: string[];
  /** The backend fields these files read for this row, as "Interface.member" or "call:helper" (BACKEND_FIELDS, DETAIL_HELPERS): the tripwire passes a read of a field in a file only when a row names both. */
  fields?: string[];
  /** Renders or calls the path with `text` as the backend's words; returns what shows. */
  show: (text: string) => string | Promise<string>;
  /** What the path can carry unchanged (default: all of KEEP); a path that builds a sentence out of the text may not carry a file name's dot. */
  keep?: string[];
  /** Straight-apostrophe words the row shows on purpose (a path it adds itself). */
  straight?: string[];
}

/** The reads of an agent's own words in `file` that sit inside a call or element that curls (curledAgentReads), through the compiler's resolution of each name. */
function agentWordsCurled(file: string): string[] {
  const { program, checker } = appProgram();
  const source = program.getSourceFile(join(SRC, file));
  if (!source) throw new Error(`${file} is not in the app program`);
  return curledAgentReads(source, (id) => isCurlerIdentifier(checker, id));
}

const shown = (element: React.ReactElement) => render(element).container.textContent ?? '';

/** The files that draw an agent's own words (chat assistant text is mounted above). Each is mounted below or checked for what its reads of the agent's fields sit inside (agentWords). */
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

/** CommonsDetail for an image with the given asset and effective fields, loaded from a mocked reference. */
async function commonsDetail(asset: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  net.commonsAsset.mockResolvedValue({
    asset: { id: 'ast_1', media: 'image', width: 40, height: 32, made_by: 'person', analysis_state: 'ready', last_error: null, last_error_kind: null, measurements: null, ...asset },
    effective: { fields: { keywords: [], palette: [], ...fields }, sources: {}, corrected_paths: [], analysis: null },
    corrections: [], regions: [], memberships: [], borrowings: [], blob_url: '/api/commons/blobs/x',
  });
  const view = render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
  await eventually(() => expect(view.container.querySelector('.commons-detail__bar')).not.toBeNull());
  return view;
}

/** A person thread's working line for an event of an agent session: the line Nebula shows beside the message. */
function workingLineFor(event: Partial<AgentPresenceEvent>): string {
  noteActivity(presence({ session: { key: 'abcdef012345', label: 'Claude' } as never, say: '', at: 1000, ...event }));
  const status = messageStatus({ kind: 'message', id: 'm1', at: 500, state: 'accepted', text: 'hi' } as never, 1500, { replied: false, activity: usePersonThreadStore.getState().activity.abcdef012345 ?? null, label: 'Claude' });
  return status?.text ?? '';
}

export const RENDER_PATHS: Row[] = [
  // Request-failure lines
  { id: 'canvas notice, the prose around a mono model id', mode: 'curl', files: ['components/canvas/CanvasUndoNotice.tsx'],
    show: (t) => { useGraphStore.setState({ undoNotice: { id: 1, text: `${t} for model-x and ${t}`, offer: null, mono: 'model-x' } } as never); return shown(<CanvasUndoNotice />); } },
  { id: 'Commons error line, the stem before its Try again button', mode: 'curl', files: ['components/commons/CommonsErrorLine.tsx'],
    show: (t) => shown(<CommonsErrorLine line={`Nebula couldn't load Commons because ${t}. Try again.`} onRetry={() => {}} />) },
  { id: 'LineText', mode: 'curl', files: ['components/LineText.tsx'], show: (t) => shown(<LineText text={t} />) },
  { id: 'LineText string children', mode: 'curl', files: ['components/LineText.tsx'], show: (t) => shown(<LineText text="x">{t}</LineText>) },
  { id: 'becauseLine, no heading', mode: 'curl', fields: ['RequestFailedError.reason', 'RequestFailedError.detail', 'call:copyForAnswer', 'call:copyForStatus', 'call:detailText'], files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: '', reason: t }) },
  { id: 'becauseLine, heading not "Couldn’t x."', mode: 'curl', files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: 'Save failed', reason: t }) },
  { id: 'becauseLine, unreadable heading in a named reason', mode: 'curl', files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: '', reason: `Couldn't read ${t}` }), keep: KEEP.filter((kept) => !kept.includes('.')) },
  { id: 'becauseLine, a sentence reason (already curled)', mode: 'curl', files: ['lib/errorCopy.ts'], show: (t) => becauseLine({ heading: 'Couldn’t save the project.', reason: t }) },
  { id: 'chat image chip error', mode: 'curl', fields: ['call:copyForStatus', 'call:readDetail'], files: ['lib/chatUploadCopy.ts', 'components/panels/ChatPanel.tsx'], show: (t) => chatUploadChipError(400, t) },
  { id: 'dropped-files reasons', mode: 'curl', files: ['lib/canvasFileDrop.ts'],
    show: (t) => dropNoticeText([{ kind: 'upload', name: 'a.png', line: 'x', reason: t }, { kind: 'upload', name: 'b.png', line: 'x', reason: t }], 2) ?? '' },
  { id: 'scene-save refusal, a rendering stop', mode: 'curl', fields: ['RequestFailedError.reason', 'RequestFailedError.detail', 'call:copyForAnswer', 'call:detailText', 'call:readRefusal'], files: ['store/graphStore.ts'],
    show: (t) => sceneLine(`Couldn't save the scene because ${t}.`, { rendering: { shotIds: ['s1'] } }) },
  { id: 'scene-save refusal, kept', mode: 'curl', files: ['store/graphStore.ts'], show: (t) => sceneLine(`Couldn't save the scene because ${t}.`) },
  { id: 'settings-file refusal', mode: 'curl', fields: ['RequestFailedError.detail'], files: ['lib/settingsWrites.ts'],
    show: (t) => unreadableSettingsLine(new RequestFailedError('Couldn’t save.', 409, { detail: t, code: SETTINGS_REFUSAL_CODES[0] })) ?? '' },
  { id: 'keychain-kept fix sentence', mode: 'curl', fields: ['RequestFailedError.fix'], files: ['lib/settingsWrites.ts', 'lib/errorCopy.ts'],
    show: (t) => `${keychainKeptLine('removal', 'openai', 'row', t)}|${keychainKeptLine('save-over', 'openai', 'row', t)}|${keychainKeptLine('save-new', 'openai', 'row', t)}` },
  // The store keeps a refused accept's reason raw (the backend's whole sentence: it opens "Nebula couldn’t accept this because"); the strip draws it through LineText.
  { id: 'asset proposal accept refusal (store and strip)', mode: 'curl', fields: ['RequestFailedError.reason'], files: ['store/assetProposalsStore.ts', 'components/proposals/AssetProposalStrip.tsx'],
    show: async (t) => {
      net.acceptProposal.mockRejectedValueOnce(new AssetProposalError(409, `Nebula couldn’t accept this because ${t}.`, { heading: 'Couldn’t accept the proposal.' }));
      useAssetProposalsStore.getState().open(coverProposal(), 'k1');
      const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
      fireEvent.click(screen.getByRole('button', { name: 'Use this cover' }));
      await eventually(() => expect(container.querySelector('.asset-proposal__error')).not.toBeNull());
      return container.querySelector('.asset-proposal__error')?.textContent ?? '';
    } },
  // Node run state
  { id: 'waiting stop', mode: 'curl', files: ['lib/nodeErrorCopy.ts'], show: (t) => nodeErrorCopy({ category: 'waiting', person: t }).reason },
  { id: 'run failure (already curled)', mode: 'curl', fields: ['NodeData.error', 'NodeData.errorFriendly', 'NodeData.errorPerson', 'CinemaShot.error', 'CinemaShot.errorFriendly', 'CinemaShot.errorPerson'], files: ['lib/nodeErrorCopy.ts', 'components/nodes/NodeError.tsx', 'components/nodes/ModelNode.tsx', 'components/nodes/DynamicNode.tsx', 'components/nodes/BatchNode.tsx',
    'components/cinema-studio/CinemaShotPanel.tsx', 'components/create-studio/ResultCard.tsx'], show: (t) => nodeErrorCopy({ category: 'unknown', person: t }).reason },
  { id: 'NodeError, rendered', mode: 'curl', files: ['components/nodes/NodeError.tsx'], show: (t) => shown(<NodeError category="unknown" person={t} />) },
  { id: 'NodeError, a waiting stop, rendered', mode: 'curl', files: ['components/nodes/NodeError.tsx'], show: (t) => shown(<NodeError category="waiting" person={t} />) },
  { id: 'ErrorDetails, the raw words behind a project error', mode: 'raw', fields: ['call:failureDetails'], files: ['components/projects/ProjectHome.tsx', 'components/failure/ErrorDetails.tsx', 'store/projectStore.ts', 'store/graphStore.ts'], show: (t) => shown(<ErrorDetails raw={t} />) },
  { id: 'NodeError raw Details, rendered', mode: 'raw', files: ['components/nodes/NodeError.tsx'], show: (t) => shown(<NodeError category="unknown" raw={t} person="It stopped." providerText />) },
  { id: 'NodeError raw Details', mode: 'raw', files: ['lib/nodeErrorCopy.ts'], show: (t) => nodeErrorCopy({ category: 'unknown', raw: t, person: 'It stopped.', providerText: true }).details ?? '' },
  { id: 'skipped label', mode: 'curl', fields: ['NodeData.skipReason'], files: ['lib/gating.ts'], show: (t) => skippedLabel(t) },
  { id: 'skipped badge title and aria-label', mode: 'curl', fields: ['NodeData.skipReason'], files: ['components/nodes/SkippedBadge.tsx', 'components/nodes/ModelNode.tsx', 'components/nodes/DynamicNode.tsx'],
    show: (t) => { const badge = render(<SkippedBadge reason={t} />).container.firstElementChild!; return `${badge.getAttribute('title')}|${badge.getAttribute('aria-label')}`; } },
  { id: 'wait description', mode: 'curl', fields: ['ProposalWait.barLine'], files: ['lib/nodeWait.ts'],
    show: (t) => waitDescription(waitFor(proposalState({ barLine: t, nodeIds: ['n1'], names: [] }), 'n1')!) },
  // Proposals
  { id: 'plan line', mode: 'curl', fields: ['ProposalView.plan'], files: ['lib/canvasProposalsBar.ts'], show: (t) => proposalPlan({ plan: t } as ProposalView) },
  { id: 'can’t run here, the person line', mode: 'curl', fields: ['ProposalNotReady.person'], files: ['lib/canvasProposalsBar.ts'], show: (t) => notReadyLine(notReadyRow({ person: t })) },
  { id: 'can’t run here, the missing words', mode: 'curl', fields: ['ProposalNotReady.missing'], files: ['lib/canvasProposalsBar.ts'], show: (t) => notReadyLine(notReadyRow({ missing: t })) },
  { id: 'ghost-card warning', mode: 'curl', files: ['lib/canvasProposalsBar.ts'], show: (t) => notReadyWarning(notReadyRow({ person: t })) ?? '' },
  { id: 'hold line', mode: 'curl', files: ['lib/ledgerHold.ts'],
    show: (t) => withHoldLine('Note.', proposalHoldLine({ until: 4_000_000_000, line: t }, 1000)) },
  // Chat panel
  { id: 'chat error line, whole', mode: 'curl', files: ['lib/chatErrorLine.ts'], show: (t) => chatErrorLine({ message: `${t}.`, source: 'system', agentName: 'Claude' }).text },
  { id: 'chat error line, because', mode: 'curl', files: ['lib/chatErrorLine.ts'], show: (t) => chatErrorLine({ message: `claude: ${t}`, agentName: 'Claude' }).text },
  { id: 'chat error Details', mode: 'raw', files: ['lib/chatErrorLine.ts'], show: (t) => chatErrorLine({ message: `${t}\nmore`, agentName: 'Claude' }).details ?? '' },
  // Settings
  { id: 'settings top notice', mode: 'curl', fields: ['SettingsNotice.line'], files: ['lib/settingsNotice.ts'],
    straight: ["/Users/me/Krea's/settings.json"],
    show: (t) => { const parts = noticeParts({ line: `${t} /Users/me/Krea's/settings.json ${t}`, path: "/Users/me/Krea's/settings.json" } as never); return `${parts.before}${parts.path}${parts.after}`; } },
  // Agent surfaces: Nebula's own words are curled, an agent's own are not
  { id: 'agent log: the backend’s log field', mode: 'curl', fields: ['AgentPresenceEvent.log'], files: ['store/agentLogStore.ts', 'components/panels/AgentLogEntryRow.tsx'], show: (t) => logRow({ say: 'ok', log: t }) },
  { id: 'agent log: the agent’s say', mode: 'agent', fields: ['AgentPresenceEvent.say'], files: ['store/agentLogStore.ts', 'components/panels/AgentLogEntryRow.tsx'], show: (t) => logRow({ say: t }) },
  // The person thread's working line: Nebula's own log text is curled, the agent's say is not.
  { id: 'person thread working line: the backend’s log field', mode: 'curl', fields: ['AgentPresenceEvent.log'], files: ['store/personThreadStore.ts', 'lib/personThreadBox.ts'], show: (t) => workingLineFor({ say: '', log: t }) },
  { id: 'person thread working line: the agent’s say', mode: 'agent', fields: ['AgentPresenceEvent.say'], files: ['store/personThreadStore.ts', 'lib/personThreadBox.ts'], show: (t) => workingLineFor({ say: t }) },
  // The outcome is always Nebula's own line (never the person's reason or the agent's note), whoever wrote the note.
  { id: 'Updates card outcome, source nebula', mode: 'curl', fields: ['AgentNote.outcome'], files: ['lib/agentNotesView.ts'], show: (t) => stateLabel(nebulaNote('nebula', t)) ?? '' },
  { id: 'Updates card outcome, source agent', mode: 'curl', fields: ['AgentNote.outcome'], files: ['lib/agentNotesView.ts'], show: (t) => stateLabel(nebulaNote('agent', t)) ?? '' },

  // Provider hold box
  { id: 'provider hold box', mode: 'curl', fields: ['ProviderStartAmbiguity.message', 'ProviderRecoveryCheckpoint.warning'], files: ['components/ProviderRecoveryStatus.tsx', 'lib/runHistory.ts'],
    show: (t) => { useGraphStore.setState({ providerRecoveryWarning: t }); return shown(<ProviderRecoveryStatus />); } },
  // Run history
  { id: 'run history status note', mode: 'curl', fields: ['RunRecord.statusNote'], files: ['components/panels/RunHistoryPanel.tsx', 'lib/runHistory.ts'], show: (t) => historyText({ statusNote: t }) },
  { id: 'run history skipped-nodes tooltip', mode: 'curl', fields: ['RunRecord.skippedNodes'], files: ['components/panels/RunHistoryPanel.tsx', 'lib/runHistory.ts'],
    show: (t) => { historyText({ skippedNodes: { n1: t } }); return document.querySelector('.run-history__skipped')?.getAttribute('title') ?? ''; }, keep: KEEP },
  // Chat panel
  { id: 'model picker unavailable line', mode: 'curl', fields: ['ChatModelCatalog.error', 'ChatModelCatalog.message'], files: ['components/panels/ChatModelPicker.tsx', 'lib/api.ts'], show: (t) => pickerText({ error: t }) },
  { id: 'agent status hover title', mode: 'curl', fields: ['ClaudeStatus.message', 'CodexStatus.message', 'CodexChatGPTLoginState.message'], files: ['components/panels/ChatPanel.tsx', 'lib/api.ts'], show: (t) => agentStatusTitle(t, 'a session') ?? '' },
  { id: 'model picker, a personal agent’s note', mode: 'curl', fields: ['PersonalAgent.note'], files: ['components/panels/ChatModelPicker.tsx'],
    show: (t) => pickerText({ agent: 'personal:x', personalAgents: [{ ...personalAgent({ note: t }) }] }) },
  { id: 'Inspector last-run notes', mode: 'curl', fields: ['NodeData.runNotes', 'NodeData.skipReason'], files: ['components/panels/Inspector.tsx'], show: (t) => shown(<LastRunNotes notes={[t]} />) },
  // Moodboard and Commons
  { id: 'undo toast kept lines', mode: 'curl', files: ['components/moodboard-studio/MoodboardStudioView.tsx', 'components/moodboard-studio/BoardUndoToast.tsx'],
    show: (t) => shown(<BoardUndoToast toast={{ id: 1, text: 'Removed', skipped: skippedLines({ applied: [{ skipped: [{ message: t }] }] } as never), action: { label: 'Undo', run: () => {} } }} onDismiss={() => {}} />) },
  { id: 'colour clash reasons', mode: 'curl', fields: ['MoodboardClash.reason', 'MoodboardClash.reasons'], files: ['components/moodboard-studio/MoodboardBrief.tsx'],
    show: (t) => { const { container } = render(<BriefPanel brief={clashBrief(t)} override={null} saving={false} busy={false} onEdit={() => {}} onKeep={() => {}} onRegenerate={() => {}} />);
      return [...container.querySelectorAll('.moodboard-clash__reason')].map((node) => node.textContent).join('|'); } },
  { id: 'swatch tooltips for a colour left out of the brief', mode: 'curl', fields: ['MoodboardClash.reason'], files: ['components/moodboard-studio/MoodboardColors.tsx'],
    show: (t) => { const { container } = render(<BoardSwatches label="Palette" role="dominant" analysis={{ palette: ['#ff0000'], accents: [] } as never}
      leftOut={[{ hex: '#ff0000', role: 'palette', level: 'conflict', reason: t, reasons: [t], why: 'check', foundBy: ['words'] }]} />);
      return container.querySelector('[role="listitem"]')?.getAttribute('title') ?? ''; } },
  { id: 'Commons folder device error', mode: 'curl', fields: ['FolderLink.error'], files: ['components/commons/CommonsSettings.tsx'],
    show: (t) => shown(<ul><FolderRow link={{ id: 'l', path: '/refs', ignores: [], last_scan_at: null, last_scan_summary: null, device_states: [{ path: '/refs', state: 'error', error: t }] }} run={async () => true} /></ul>) },
  { id: 'Commons grade slot error', mode: 'curl', fields: ['ReviewItem.error'], files: ['components/commons/CommonsReview.tsx'], show: (t) => reviewText({ proposal: null, status: 'failed', error: t }) },
  { id: 'borrowing fidelity title', mode: 'curl', files: ['components/commons/CommonsDetail.tsx'],
    show: (t) => render(<FidelityBadge fidelity={{ status: 'failed', reason: t }} />).container.firstElementChild?.getAttribute('title') ?? '' },
  { id: 'Commons analysis failure Details', mode: 'raw', fields: ['AssetDetail.last_error'], files: ['components/commons/CommonsDetail.tsx'],
    show: async (t) => { const { container } = await commonsDetail({ last_error: t, analysis_state: 'analysis_failed', last_error_kind: 'other' }); return container.querySelector('.commons-analysis-failure__details')?.textContent ?? ''; } },
  { id: 'Commons detail: the stage image alt (the model-read summary)', mode: 'curl', fields: ['EffectiveFields.summary'], files: ['components/commons/CommonsDetail.tsx'],
    show: async (t) => { const { container } = await commonsDetail({}, { summary: { value: t } }); return container.querySelector('.commons-stage [data-commons-media]')?.getAttribute('alt') ?? ''; } },
  // Settings
  { id: 'settings top notice (rendered)', mode: 'curl', files: ['components/panels/settings/SettingsTopNotice.tsx'], straight: ["/Users/me/Krea's/settings.json"],
    show: async (t) => { net.settingsNotice.mockResolvedValue({ kind: 'restored', line: `${t} /Users/me/Krea's/settings.json`, path: "/Users/me/Krea's/settings.json" });
      const { container } = render(<SettingsTopNotice visible />); await eventually(() => expect(container.querySelector('.settings-top-notice__line')).not.toBeNull());
      return container.querySelector('.settings-top-notice__line')?.textContent ?? ''; } },
  { id: 'Connect your agent: why a checkout can’t be pointed at', mode: 'curl', fields: ['OutsideSpend.reason'], files: ['components/panels/settings/ConnectedApps.tsx', 'lib/api.ts'],
    show: (t) => shown(<ConnectedApps view={{ outside: { spentUsd: 0, kreaPlanRuns: 0 }, apps: [], connect: { clients: [{ id: 'c', label: 'C' }], available: false, reason: t } }} loadError={null} onChanged={() => {}} />) },
  { id: 'setup panel steps, warnings and where', mode: 'curl', fields: ['AgentSetup.steps', 'AgentSetup.warnings', 'AgentSetup.where'], files: ['components/panels/settings/ConnectedApps.tsx'],
    show: (t) => { const { container } = render(<SetupPanel name="App" setup={setup(t)} onDone={() => {}} onError={() => {}} />);
      return ['.settings-apps__steps', '.settings-pref__description', '.settings-apps__warnings'].flatMap((css) => [...container.querySelectorAll(css)].map((node) => node.textContent)).join('|'); } },
  { id: 'setup panel code, command and path', mode: 'raw', files: ['components/panels/settings/ConnectedApps.tsx'],
    show: (t) => { const { container } = render(<SetupPanel name="App" setup={setup(t)} onDone={() => {}} onError={() => {}} />);
      return [...container.querySelectorAll('pre')].map((node) => node.textContent).join('|'); } },
  { id: 'personal agents: key option, install and sign-in lines, notes', mode: 'curl', fields: ['PersonalAgent.billing', 'PersonalAgent.blocked', 'PersonalAgent.note', 'PersonalAgent.termsNote', 'PersonalAgentJob.message'], files: ['components/panels/settings/PersonalAgentsSection.tsx', 'lib/api.ts'],
    show: async (t) => { net.personalAgents.mockResolvedValue({ warningAcknowledged: true, agents: [personalAgent({ note: t, termsNote: t })] });
      const { container } = render(<PersonalAgentsSection />); await eventually(() => expect(container.querySelector('.personal-agents__terms')).not.toBeNull());
      return [...container.querySelectorAll('.personal-agents__terms, .personal-agents__fine, .personal-agents__progress, .settings-row__error, .settings-pref__description')].map((node) => node.textContent).join('|'); } },
  // Agent-written and model-read words
  { id: 'moodboard analysis summary', mode: 'curl', fields: ['MoodboardAnalysis.summary'], files: ['components/moodboard-studio/MoodboardStudioView.tsx'], show: (t) => shown(<AnalysisSummary text={t} />) },
  { id: 'Commons read fields: summary, notes, why', mode: 'curl', fields: ['Explained.why', 'ReviewItem.composition_notes', 'ReviewItem.summary'], files: ['components/commons/CommonsReview.tsx'], show: (t) => reviewText({}, t) },
  { id: 'Commons grid caption', mode: 'curl', fields: ['SearchRow.summary'], files: ['components/commons/CommonsGrid.tsx'],
    show: (t) => { const { container } = render(<CommonsGrid rows={[{ ...gridRow, summary: t }]} selectedId={null} loading={false} emptyHint="" onOpen={() => {}} onDropFiles={() => {}} />);
      const tile = container.querySelector('[data-commons-tile]')!; return `${tile.textContent}|${tile.getAttribute('title')}|${tile.getAttribute('aria-label')}`; } },
  { id: 'Jev judge notes', mode: 'curl', fields: ['JevReport.notes'], files: ['components/panels/JevResultDetails.tsx'], show: (t) => shown(<JevNotes notes={[t]} />) },
  { id: 'Updates card text, source nebula', mode: 'curl', fields: ['AgentNotePart.text'], files: ['components/agent-notes/AgentNoteParts.tsx', 'lib/agentNotesView.ts'], show: (t) => shown(<NoteText note={nebulaNote('nebula', t)} />) },
  { id: 'Updates card text, source agent', mode: 'agent', fields: ['AgentNotePart.text'], files: ['components/agent-notes/AgentNoteParts.tsx', 'lib/agentNotesView.ts'], show: (t) => shown(<NoteText note={nebulaNote('agent', t)} />) },
  { id: 'chat assistant text', mode: 'agent', files: ['components/panels/ChatPanel.tsx'],
    show: (t) => shown(<AssistantBubble message={{ role: 'assistant', id: 'm', streaming: false, parts: [{ kind: 'text', text: t }] } as never} agentName="Claude" onPermission={() => {}} />) },
  // An agent's own words: the two small cards are mounted with the agent's words in every field they draw.
  { id: 'asset proposal note and edit reason (mounted)', mode: 'agent', files: ['components/proposals/AssetProposalStrip.tsx'],
    show: (t) => {
      useAssetProposalsStore.getState().open(commonsProposal({ note: t, change: { edits: [{ correction: { field_path: 'summary.value', op: 'set', value: t, reason: t } }] } }), 'k1');
      return shown(<AssetProposalStrip kind="commons" targetId="ast_1" />);
    } },
  { id: 'question cards (mounted)', mode: 'agent', files: ['components/agent-notes/AgentQuestionsForm.tsx'],
    show: (t) => {
      const view = { id: 'qs_1', status: 'open', agent: { id: 'a', name: 'Agent', color: '#336699', verified: false }, note: t, projectId: 'p1', nodeIds: [], createdAt: 1, closedAt: null, answers: null,
        questions: [{ id: 'q1', text: t, options: [t], multiple: false, allowText: true }] };
      useAgentQuestionsStore.getState().opened(view as never, 'k1');
      return shown(<AgentQuestionsForm setId="qs_1" onClose={() => {}} />);
    } },
  // The rest are too large to mount here: an AST check (agentWords, below) fails when a read of the agent's fields sits inside a call or element that curls.
  ...AGENT_FILES.map(([id, file]): Row => ({ id, mode: 'agent', ...(file === 'components/canvas/ProposalBar.tsx' ? { fields: ['ProposalView.note'] } : {}), files: [file],
    show: (t) => { const reads = agentWordsCurled(file); return reads.length ? `CURLED: ${reads.join('; ')}` : t; } })),
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
    // Nowhere in what shows is it curled (a row that draws the words in several fields has every one of them raw).
    expect(out.toLowerCase(), row.id).not.toContain('krea’s');
    expect(out.toLowerCase(), row.id).not.toContain('doesn’t');
  });

  it('curlApostrophes is idempotent on a line that is already curled', () => {
    expect(curlApostrophes(curlApostrophes(FIXTURE))).toBe('Krea’s key doesn’t work');
  });
});

describe('curlApostrophes keeps a single-quoted run as written', () => {
  it('keeps \'Bob\'s board\' and curls the contraction before it', () => {
    expect(curlApostrophes("Couldn't open 'Bob's board'")).toBe("Couldn’t open 'Bob's board'");
    expect(curlApostrophes("--header 'X-Key: it's' isn't set")).toBe("--header 'X-Key: it's' isn’t set");
  });
  it('curls both contractions around a quoted word', () => {
    expect(curlApostrophes("it's 'great' isn't it")).toBe("it’s 'great' isn’t it");
  });
  it('a lone quote mark (a plural possessive) swallows nothing after it', () => {
    expect(curlApostrophes("users' notes don't load, and it's slow")).toBe("users' notes don’t load, and it’s slow");
  });
  it('an unclosed opening quote protects nothing after it', () => {
    expect(curlApostrophes("it opens 'here and doesn't close, so it's curled")).toBe("it opens 'here and doesn’t close, so it’s curled");
    expect(curlApostrophes("'tis a key, isn't it")).toBe("'tis a key, isn’t it");
  });
  it('a run does not cross a line', () => {
    expect(curlApostrophes("it opens 'here\nand it's closed 'there'")).toBe("it opens 'here\nand it’s closed 'there'");
  });
});

describe('LineText in code mode: a code span is never curled, whichever way the backticks pair', () => {
  const codeOf = (text: string) => { const { container } = render(<p><LineText text={text} code /></p>); return [...container.querySelectorAll('code')].map((node) => node.textContent); };
  it('a GNU-quoted name before a later span with an apostrophe in it', () => {
    const text = "cannot stat `a.png' isn't `cmd's` here";
    expect(codeOf(text)).toEqual(["cmd's"]);
    expect(screen.getByText(/cannot stat/).textContent).toContain('isn’t');
  });
  it('a straight double quote inside a span', () => {
    expect(codeOf('"x `y" don\'t` z')).toEqual(['y" don\'t']);
  });
  it('a pair that crosses a line', () => {
    expect(codeOf("`a\nb` don't `x's`")).toEqual([" don't "]);
  });
});

describe('names stay as they were', () => {
  it('the agent status hover curls the message, not the session title', () => {
    expect(agentStatusTitle(FIXTURE, "Bob's session")).toBe("Krea’s key doesn’t work · Bob's session");
  });
  it('a Commons tile curls the model-read summary, not the collection name it falls back to', () => {
    const { container } = render(<CommonsGrid rows={[{ ...gridRow, summary: null, collection: "Bob's refs" }]} selectedId={null} loading={false} emptyHint="" onOpen={() => {}} onDropFiles={() => {}} />);
    expect(container.querySelector('[data-commons-tile]')?.getAttribute('title')).toBe("Bob's refs");
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
 * Files that read a backend field, or call a helper that returns a backend detail string, only to pass it on, store it or
 * build a request's failure from it, and so draw nothing themselves: what they hand on reaches the screen through a row of
 * RENDER_PATHS (the line through becauseLine and LineText, a node's error through NodeError, a Details view raw). Each entry
 * names the fields it covers and why. A read of another field in the same file is not covered.
 */
export const PASSES_ON: Record<string, { fields: string[]; why: string }> = {
  'lib/api.ts': { fields: ['RequestFailedError.reason', 'RequestFailedError.detail'], why: 'copies a RequestFailedError into the request\'s own error class, keeping its reason and detail; the line is built by becauseLine and drawn through LineText' },
  'lib/projects.ts': { fields: ['RequestFailedError.reason', 'RequestFailedError.detail'], why: 'wraps a RequestFailedError in the project store\'s own error, keeping its reason and detail; drawn through becauseLine and LineText' },
  'lib/assetProposals.ts': { fields: ['RequestFailedError.reason', 'RequestFailedError.detail'], why: 'wraps a RequestFailedError in the asset proposal error, keeping its reason and detail; drawn through the strip\'s LineText (a row above)' },
  'lib/canvasProposals.ts': { fields: ['RequestFailedError.reason', 'RequestFailedError.detail', 'ProposalNotReady.missing', 'call:copyForAnswer'], why: 'wraps a RequestFailedError in the proposal error; reads a not-ready row\'s words only to decide which rows to keep' },
  'lib/validationCopy.ts': { fields: ['ExecutionValidationError.message', 'ExecutionValidationError.person'], why: 'builds the failure reason from a run\'s validation errors; the line is drawn through becauseLine and LineText' },
  'lib/commonsApi.ts': { fields: ['call:copyForStatus', 'call:detailText', 'call:readDetail'], why: 'builds the Commons request\'s RequestFailedError from the answer; the line is drawn through CommonsErrorLine and LineText' },
  'lib/paperSource.ts': { fields: ['call:copyForStatus', 'call:readDetail'], why: 'builds the Paper source error from the answer (its person line or the status line); drawn through becauseLine and LineText' },
  'lib/cinemaMotion.ts': { fields: ['call:copyForAnswer', 'call:readRefusal'], why: 'builds a refused handoff\'s reason from the answer; its lines go through becauseLine' },
  'lib/kreaConnection.ts': { fields: ['call:copyForAnswer', 'call:readRefusal'], why: 'passes no detail, so only Nebula\'s own line for the status or the person gate comes back' },
  'lib/canvasSelection.ts': { fields: ['call:copyForStatus'], why: 'passes no detail, so only Nebula\'s own line for the status comes back' },
  'lib/chatCanvasClear.ts': { fields: ['call:readDetail'], why: 'reads the detail for a console warning only; nothing is drawn' },
  'store/graphStore.ts': { fields: ['ExecutionEvent.error', 'ExecutionEvent.friendly', 'ExecutionEvent.message', 'ExecutionEvent.notes', 'ExecutionEvent.person', 'ExecutionEvent.reason', 'ExecutionEvent.warning',
    'NodeData.error', 'NodeData.errorFriendly', 'NodeData.errorPerson', 'CinemaShot.error', 'CinemaShot.errorPerson', 'ProviderStartAmbiguity.message'],
  why: 'stores a run event\'s words on the node and the run record as they came; they are drawn by the run failure, run history and provider hold rows' },
  'store/projectFlows.ts': { fields: ['NodeData.error'], why: 'drops a node\'s error when it stores a snapshot of the node; nothing is drawn' },
  'store/agentPresenceStore.ts': { fields: ['AgentPresenceEvent.say'], why: 'keeps the agent\'s say for its cursor; the row that draws it is the cursor say pill (an agent\'s own words, checked by agentWords)' },
  'store/agentQuestionsStore.ts': { fields: ['RequestFailedError.detail'], why: 'reads a refusal\'s detail only to tell that a question was already answered; draws nothing' },
  'store/canvasPinsStore.ts': { fields: ['RequestFailedError.detail', 'RequestFailedError.reason'], why: 'compares a refusal\'s words with a stale-canvas marker; draws nothing' },
  'components/moodboard-studio/boardSaveLine.ts': { fields: ['RequestFailedError.detail'], why: 'reads a refusal\'s detail to choose between Nebula\'s own save lines; draws none of it' },
};

/** What each file reads: the "Interface.member" and "call:helper" keys (readersOfBackendFields). */
let reading: Map<string, Set<string>> | null = null;
const reads = () => (reading ??= readersOfBackendFields(BACKEND_FIELDS));

/** Whether a row, or PASSES_ON, covers a file's read of a field. */
const covered = (file: string, key: string): boolean =>
  RENDER_PATHS.some((row) => row.files.includes(file) && (row.fields ?? []).includes(key)) || (PASSES_ON[file]?.fields ?? []).includes(key);

describe('the tripwire: a read of a backend message field is in the table, by file and field', () => {
  it('every read of a field, or call of a detail helper, in a file is named by a row or by PASSES_ON for that file and that field', { timeout: 120_000 }, () => {
    const unlisted = [...reads()].flatMap(([file, keys]) => [...keys].filter((key) => !covered(file, key)).map((key) => `${file} reads ${key}`));
    expect(unlisted, 'Add the render path to RENDER_PATHS in tests/backendTextCurl.test.tsx with the field in its `fields` (curled, or marked raw with why), or the file and field to PASSES_ON with a reason').toEqual([]);
  });

  it('a row or an entry names only a file that reads the field it names, so the table cannot go stale', { timeout: 120_000 }, () => {
    const seen = reads();
    const stale: string[] = [];
    for (const row of RENDER_PATHS) {
      for (const field of row.fields ?? []) if (!row.files.some((file) => seen.get(file)?.has(field))) stale.push(`row "${row.id}" names ${field}, which none of its files read`);
    }
    for (const [file, entry] of Object.entries(PASSES_ON)) {
      expect(entry.why.length, file).toBeGreaterThan(10);
      for (const field of entry.fields) if (!seen.get(file)?.has(field)) stale.push(`PASSES_ON ${file} names ${field}, which it no longer reads`);
    }
    expect(stale).toEqual([]);
  });

  it('knows the fields and the helpers it watches', () => {
    expect(Object.values(BACKEND_FIELDS).flat().length).toBeGreaterThan(60);
    expect(callKey('readDetail')).toBe('call:readDetail');
    // The reads of the helpers' results are found at all (not a scan that sees nothing).
    expect([...reads().values()].some((keys) => keys.has('call:readDetail'))).toBe(true);
    expect([...reads().values()].some((keys) => keys.has('RunRecord.statusNote'))).toBe(true);
  });
});

describe('agent words: an agent\'s own words are never read inside a call or element that curls', () => {
  it.each(AGENT_FILES.map(([id, file]) => [id, file] as const))('%s (%s)', (_id, file) => {
    expect(agentWordsCurled(file), `${file} draws an agent’s own words through a curling call or element; the agent’s words stay as it wrote them`).toEqual([]);
  });

  const source = (text: string) => ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const byName = (id: ts.Identifier) => ['LineText', 'FailureLines', 'becauseLine', 'oneLine', 'curlApostrophes'].includes(id.text);
  it('catches a read wrapped in or passed to each curler, and leaves a plain one', () => {
    expect(curledAgentReads(source('const a = <LineText text={view.note} />;'), byName)).toHaveLength(1);
    expect(curledAgentReads(source('const a = <LineText>{`${row.say}!`}</LineText>;'), byName)).toHaveLength(1);
    expect(curledAgentReads(source('const a = <FailureLines failure={{ heading: "", reason: q.text }} />;'), byName)).toHaveLength(1);
    expect(curledAgentReads(source('const a = becauseLine({ reason: entry.status });'), byName)).toHaveLength(1);
    expect(curledAgentReads(source('const a = oneLine(copy.note);'), byName)).toHaveLength(1);
    expect(curledAgentReads(source('const a = curlApostrophes(event.say);'), byName)).toHaveLength(1);
    expect(curledAgentReads(source('const a = <p>{view.note}</p>; const b = String(row.text); const c = <LineText text={error} />;'), byName)).toEqual([]);
    expect(AGENT_FIELDS.has('note') && AGENT_FIELDS.has('say') && AGENT_FIELDS.has('text') && AGENT_FIELDS.has('status')).toBe(true);
  });
});

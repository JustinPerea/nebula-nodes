import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBackendBaseUrl } from '../../src/lib/backend';

/**
 * error-copy round 2, item 6 (GM - Design): every request in the app names
 * its action and says the reason, never a status code: "Couldn't {verb}
 * {object}." then the reason line; one-line surfaces (alerts, toasts,
 * status text) get "Couldn't {verb} {object}. {reason}" in one string,
 * which is the error's message. "Never 'failed:', '(HTTP 503)' or status
 * codes in the UI. Keep them in the console." Headings are GM's where GM gave
 * one ("Couldn't cancel the run.", "Couldn't start the shot.", "Couldn't
 * check Codex status.", "Couldn't load the 3D preview.", "Couldn't load the
 * world.", "Couldn't download the world.", "Couldn't restore the asset."),
 * the rest to GM's pattern. On 1fc3d846 each of these said "<Action> failed:
 * 503" or "(503)". Only the browser's fetch is stubbed.
 */

const LOST = "Nebula's server isn't answering. Make sure it's running, then try again.";
const NO_ANSWER = "Nebula didn't respond. Try again.";
const REFUSED = "Try again, or reload if it keeps happening.";

const api = await import('../../src/lib/api');
const renderJobs = await import('../../src/lib/renderJobs');
const projects = await import('../../src/lib/projects');
const pins = await import('../../src/lib/canvasPins');
const notes = await import('../../src/lib/agentNotes');
const assetProposals = await import('../../src/lib/assetProposals');
const canvasProposals = await import('../../src/lib/canvasProposals');
const createFiles = await import('../../src/lib/createFiles');
const presets = await import('../../src/lib/createPresets');
const enhance = await import('../../src/lib/enhancePrompt');
const transcode = await import('../../src/lib/createTranscode');
const upload = await import('../../src/lib/uploadReference');
const worldSplat = await import('../../src/lib/worldSplat');
const worldDownload = await import('../../src/lib/worldDownload');

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'ref.png', { type: 'image/png' });

const calls: Array<[string, () => Promise<unknown>]> = [
  ["Couldn't check the run.", () => api.getExecutionStatus('r1')],
  ["Couldn't cancel the run.", () => api.cancelExecution('r1')],
  // Round 3 (GM): "Name the action with the label the person clicked." The
  // status bar's "I've checked Marble" unlocks a node; Run History's
  // "Forget ID" forgets the node's "World Labs recovery safeguard" (labels
  // since round 13 of PR #114).
  ["Couldn't unlock the node.", () => api.acknowledgeProviderStartAmbiguity('video' as never, 'n1', 'r1')],
  ["Couldn't forget the recovery safeguard.", () => api.deleteProviderRecovery('r1', 'n1', { resumeOperationId: 'op1' } as never)],
  // GM, round 3, verbatim: "Couldn't keep your brief." -> "Couldn't save your brief."
  ["Couldn't save your brief.", () => api.keepMoodboardBriefOverride('b1')],
  ["Couldn't start the run.", () => api.executeGraph([], [])],
  ["Couldn't run the node.", () => api.executeNode([], [], 'n1')],
  ["Couldn't start the shot.", () => api.generateCinemaShot([], [], 'n1', 's1')],
  ["Couldn't use that variation.", () => api.promoteCinemaShotVariation('n1', 's1', 0)],
  ["Couldn't load your API keys.", () => api.getSettings()],
  ["Couldn't save your settings.", () => api.updateSettings({})],
  ["Couldn't load the connected apps.", () => api.getOutsideSpend()],
  ["Couldn't create the app token.", () => api.createConnectedApp('x', null)],
  ["Couldn't revoke the app.", () => api.revokeConnectedApp('a1')],
  ["Couldn't load your agents.", () => api.fetchPersonalAgents()],
  ["Couldn't start the download.", () => api.antigravityAction('install')],
  ["Couldn't remove the API key.", () => api.deleteSettingsApiKey('openai')],
  ["Couldn't save the API key.", () => api.updateCredential('openai', '')],
  ["Couldn't load the OpenRouter models.", () => api.fetchOpenRouterModels()],
  ["Couldn't load the Nous models.", () => api.fetchNousModels()],
  ["Couldn't check Claude status.", () => api.fetchClaudeStatus()],
  ["Couldn't check Codex status.", () => api.fetchCodexStatus()],
  ["Couldn't start the ChatGPT sign-in.", () => api.startCodexChatGPTLogin()],
  ["Couldn't check the ChatGPT sign-in.", () => api.fetchCodexChatGPTLoginState()],
  ["Couldn't load the Quiver models.", () => api.fetchQuiverModels()],
  ["Couldn't load the canvas.", () => api.fetchCLIGraph()],
  ["Couldn't load the Replicate schema.", () => api.fetchReplicateSchema('o', 'm')],
  ["Couldn't load the characters.", () => api.fetchCharacters('global')],
  ["Couldn't create the character.", () => api.createCharacter({} as never)],
  ["Couldn't delete the character.", () => api.deleteCharacter('c1')],
  ["Couldn't export the video.", () => renderJobs.startVideoExport({ sourceUrl: '/a.mp4', clips: [], format: 'mp4', resolution: 'source', quality: 'high' })],
  ["Couldn't start the render.", () => renderJobs.startRemotionRender({} as never)],
  ["Couldn't check the render.", () => renderJobs.getRenderJob('j1')],
  ["Couldn't cancel the render.", () => renderJobs.cancelRenderJob('j1')],
  ["Couldn't load your projects.", () => projects.listProjects()],
  ["Couldn't open the project.", () => projects.openProject('p1', 'rev')],
  ["Couldn't rename the project.", () => projects.renameProject('p1', 'x')],
  ["Couldn't load the notes.", () => pins.fetchPins()],
  ["Couldn't save the note.", () => pins.createPin('x', { nodeId: 'n1' })],
  ["Couldn't delete the note.", () => pins.deletePin('p1')],
  ["Couldn't load the updates.", () => notes.fetchAgentNotes({ kind: 'canvas', projectId: null } as never)],
  // GM, round 3, verbatim.
  ["Couldn't mark the updates as read.", () => notes.markAgentNotesRead({ kind: 'canvas', projectId: null } as never)],
  ["Couldn't dismiss the update.", () => notes.dismissAgentNote({ kind: 'canvas', projectId: null } as never, 'u1')],
  ["Couldn't accept the proposal.", () => assetProposals.acceptAssetProposal('a1', 'k')],
  ["Couldn't reject the proposal.", () => assetProposals.rejectAssetProposal('a1', 'k')],
  ["Couldn't load the proposals.", () => assetProposals.listAssetProposals()],
  ["Couldn't accept the proposal.", () => canvasProposals.acceptProposal('p1', 'k', {})],
  ["Couldn't reject the proposal.", () => canvasProposals.rejectProposal('p1', 'k')],
  ["Couldn't show the file in Finder.", () => createFiles.revealInFinder('/api/outputs/a.png')],
  ["Couldn't save the output.", () => createFiles.saveToFolder('/api/outputs/a.png')],
  ["Couldn't load the styles.", () => presets.fetchPresets('global')],
  ["Couldn't save the style.", () => presets.createPreset({} as never)],
  ["Couldn't delete the style.", () => presets.deletePreset('s1')],
  ["Couldn't enhance the prompt.", () => enhance.enhancePrompt('a cat')],
  ["Couldn't convert the image.", () => transcode.downloadTranscoded('/api/outputs/a.png', 'jpg')],
  ["Couldn't upload ref.png.", () => upload.uploadReference(png())],
];

beforeAll(async () => { await getBackendBaseUrl(); });
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const reject = async (call: () => Promise<unknown>) => {
  try { await call(); } catch (error) { return error as Error & { status?: number; heading?: string; reason?: string }; }
  throw new Error('expected the call to fail');
};

describe('every request names its action and says the reason, never the status', () => {
  it.each(calls)('%s after a 503 (whatever its body says)', async (heading, call) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Internal Server Error' }), {
      status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json' } })));
    const error = await reject(call);
    expect(error.message).toBe(`${heading} ${NO_ANSWER}`);
    expect(error.status).toBe(503);
  });

  it.each(calls)('%s with no answer', async (heading, call) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await reject(call)).message).toBe(`${heading} ${LOST}`);
  });

  it.each(calls)('%s refused with the backend\'s reason, and with none', async (heading, call) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'That name is taken.' }), {
      status: 409, headers: { 'content-type': 'application/json' } })));
    expect((await reject(call)).message).toBe(`${heading} That name is taken.`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })));
    expect((await reject(call)).message).toBe(`${heading} ${REFUSED}`);
  });
});

describe('direct asset fetches (not apiFetch): GM\'s headings', () => {
  it('the world preview: "Couldn\'t load the world."', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    expect((await reject(() => worldSplat.fetchWorldSplatBytes('/api/outputs/w.spz'))).message)
      .toBe(`Couldn't load the world. ${NO_ANSWER}`);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await reject(() => worldSplat.fetchWorldSplatBytes('/api/outputs/w.spz'))).message)
      .toBe(`Couldn't load the world. ${LOST}`);
  });

  it('the world download: "Couldn\'t download the world."', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    expect((await reject(() => worldDownload.downloadWorldAsset('/api/outputs/w.spz', 'w.spz'))).message)
      .toBe(`Couldn't download the world. ${REFUSED}`);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect((await reject(() => worldDownload.downloadWorldAsset('/api/outputs/w.spz', 'w.spz'))).message)
      .toBe(`Couldn't download the world. ${LOST}`);
  });
});

describe('the chat image chip (one short line under the file name)', () => {
  it('a refused upload shows the backend\'s reason or GM\'s line, never "Upload failed (503)"', async () => {
    const { chatUploadChipError } = await import('../../src/lib/chatUploadCopy');
    expect(chatUploadChipError(413, undefined)).toBe('Image > 20MB');
    expect(chatUploadChipError(415, undefined)).toBe('Not an image');
    expect(chatUploadChipError(503, 'Internal Server Error')).toBe(NO_ANSWER);
    expect(chatUploadChipError(400, undefined)).toBe(REFUSED);
    expect(chatUploadChipError(400, 'That image is empty.')).toBe('That image is empty.');
    expect(chatUploadChipError(422, [{ loc: ['body', 'file'], msg: 'field required' }])).toBe(REFUSED);
  });
});

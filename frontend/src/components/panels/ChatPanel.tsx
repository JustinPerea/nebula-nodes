import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { refuseEditWhileFollowing } from '../../lib/canvasFollow';
import { refuseCanvasEdit, useCanvasLock } from '../../lib/canvasLock';
import { canvasReplacements, lastCanvasReplacement, replacedSinceWrittenLine, subscribeCanvasReplaced } from '../../lib/canvasReplaced';
import { useProjectStore } from '../../store/projectStore';
import { ArrowUp, ChevronDown, ChevronRight, ExternalLink, LogIn, Square, X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { usePanelFocus } from '../../hooks/usePanelFocus';
import '../../styles/panels.css';
import {
  fetchClaudeStatus,
  fetchCodexChatGPTLoginState,
  fetchCodexStatus,
  fetchChatModels,
  chatAuthUsesProviderBilling,
  startCodexChatGPTLogin,
  fetchPersonalAgents,
  acknowledgePersonalAgentWarning,
  isPersonalAgent,
  parsePersonalSessionOptions,
  type ChatAgentId,
  type PersonalAgentList,
  type PersonalSessionOption,
  type ClaudeStatus,
  type CodexChatGPTLoginState,
  type CodexStatus,
  type ChatModelCatalog,
  type ChatProvider,
} from '../../lib/api';
import { ChatModelPicker } from './ChatModelPicker';
import { PermissionCard, type PermissionRequestPart, type PermissionStatus } from './PermissionCard';
import { PersonalAgentWarning } from './PersonalAgentWarning';
import { PERSONAL_AGENTS_CHANGED_EVENT } from '../../lib/personalAgentsEvents';
import { CHAT_SEND_EVENT, type ChatSendDetail } from '../../lib/chatSend';
import { claimIntent } from '../../lib/heldIntents';
import { clearCanvasFromChat } from '../../lib/chatCanvasClear';
import '../../styles/personal-agents.css';
import { apiFetch, backendAssetUrlSync, backendWebSocketUrl, personTokenForSocket } from '../../lib/backend';
import { DEFAULT_BACKEND_PORT, devProxyPort } from '../../lib/devBackendPort';
import { clearRefusedOnPromote, clearSetterOnPromote, clearsOnPromote } from '../../lib/clearsOnPromote';
import { CONNECTION_LOST_COPY, NO_ANSWER_STATUS, PERSON_REQUIRED_CODE, isBackendUnreachable, personRefusalSentAt, personRequiredCopy, readDetail, requestError, warnFailure, failureMessage, failureCopy, oneLine } from '../../lib/errorCopy';
import { ErrorDetails } from '../failure/ErrorDetails';
import { chatUploadChipError } from '../../lib/chatUploadCopy';
import { refuseEditWhileOffline } from '../../lib/backendConnection';
import { chatAuthority } from '../../lib/commonsChatAuthority';
import {
  CHAT_CLEARED_CANVAS, CHAT_CLEARED_CANVAS_KEPT, CHAT_CLEARED_CANVAS_UNCONFIRMED,
} from '../../lib/chatClear';
import { onPersonConnected, personPromotions, reportPersonRequired } from '../../lib/personSession';
import { normalizeAgentEventSource } from '../../lib/agentEvents';
import {
  chatCancellationDisconnectNotice,
  chatCancellationNotice,
  transitionChatCancellation,
  type ChatCancellationEvent,
  type ChatCancellationState,
} from '../../lib/chatCancellation';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';

type ChatAgent = ChatAgentId;
type ModelSelection = { model: string | null; effort: string | null };
const NO_MODEL: ModelSelection = { model: null, effort: null };
const PERSONAL_AGENT_RE = /^personal:[a-z0-9-]{1,32}$/;
// /clear's canvas clear refused (a run going): GM's line, with the refusal
// under Clear's heading as the notice (lib/chatClear.ts has the lines).
const CLEAR_CANVAS = "Couldn't clear the canvas.";
type ChatSelection = { agent: ChatAgent; claude: ModelSelection; codex: ModelSelection };
const CHAT_SELECTION_KEY = 'nebula:chat-selection';

function loadChatSelection(): ChatSelection {
  const empty: ChatSelection = { agent: 'claude', claude: { model: null, effort: null }, codex: { model: null, effort: null } };
  try {
    const saved = JSON.parse(window.localStorage.getItem(CHAT_SELECTION_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return empty;
    const pick = (value: unknown): ModelSelection => {
      if (!value || typeof value !== 'object') return { model: null, effort: null };
      const row = value as Record<string, unknown>;
      return {
        model: typeof row.model === 'string' && row.model.length <= 256 ? row.model : null,
        effort: typeof row.effort === 'string' && row.effort.length <= 32 ? row.effort : null,
      };
    };
    const agent: ChatAgent = saved.agent === 'codex' ? 'codex'
      : typeof saved.agent === 'string' && PERSONAL_AGENT_RE.test(saved.agent) ? saved.agent as ChatAgent : 'claude';
    return { agent, claude: pick(saved.claude), codex: pick(saved.codex) };
  } catch { return empty; }
}

// A dev frontend pinned with VITE_NEBULA_BACKEND_PORT names its own backend's
// port here, so an unreachable-backend hint never points at the default 8000.
function chatBackendPort(): number {
  try {
    return devProxyPort({ port: import.meta.env.VITE_NEBULA_BACKEND_PORT as string | undefined });
  } catch {
    return DEFAULT_BACKEND_PORT;
  }
}
const CHAT_BACKEND_PORT = chatBackendPort();
const BACKEND_START_COMMAND = `backend/.venv/bin/python backend/devserver.py --port ${CHAT_BACKEND_PORT} --open`;
const CHAT_PANEL_RESIZE_CURSORS: Record<string, string> = {
  l: 'ew-resize',
  r: 'ew-resize',
  t: 'ns-resize',
  b: 'ns-resize',
  tl: 'nwse-resize',
  br: 'nwse-resize',
  tr: 'nesw-resize',
  bl: 'nesw-resize',
};

/** Whether a failed status check means the Nebula backend itself is down.
 * Read from the error's kind and status, never its words (typeerror2,
 * 2026-10-24): no answer (isBackendUnreachable: a ConnectionLostError or an
 * AbortError nobody asked for), any error that carries the no-answer status
 * (a Commons call's), or a gateway's 502/503/504 with no reason of the
 * backend's (the Vite proxy for a stopped backend). A refusal whose reason
 * says "network" is the backend answering. */
function isBackendUnavailableError(error: unknown): boolean {
  if (!error) return false;
  if (isBackendUnreachable(error)) return true;
  return (error as { status?: unknown }).status === NO_ANSWER_STATUS;
}

type ToolCall = {
  kind: 'tool';
  toolUseId: string;
  tool: string;
  input: unknown;
  result?: string;
  isError?: boolean;
};

type TextChunk = {
  kind: 'text';
  text: string;
};

type SystemLine = {
  kind: 'system';
  text: string;
  tone?: 'neutral' | 'error' | 'success';
  /** Text behind a collapsed Details toggle under the line: a person-only
   * refusal's own words, written for agents (GM, Q116 a). */
  details?: string;
  /** Its only reason was this tab not being connected as the person: it goes
   * when the tab is promoted (GM, #204 r3; lib/clearsOnPromote). */
  personGate?: true;
};

/** The transcript without its lines that said only "this tab isn't connected as you" (GM, #204 r3);
 * a message left with nothing to say goes too. */
function withoutPersonGateLines(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.parts.some((part) => part.kind === 'system' && part.personGate)) {
      kept.push(message);
      continue;
    }
    changed = true;
    const parts = message.parts.filter((part) => !(part.kind === 'system' && part.personGate));
    if (parts.length) kept.push({ ...message, parts });
  }
  return changed ? kept : messages;
}

type ThoughtChunk = {
  kind: 'thought';
  text: string;
};

type PlanPart = {
  kind: 'plan';
  entries: Array<{ content: string; priority: string; status: string }>;
};

type MessagePart = TextChunk | ToolCall | SystemLine | ThoughtChunk | PlanPart | PermissionRequestPart;

const PERMISSION_OUTCOMES = new Set(['allowed', 'denied', 'timed_out', 'cancelled']);

type ChatMessage =
  | {
      role: 'user';
      text: string;
      id: string;
      images?: Array<{ nodeId: string; thumbUrl: string }>;
    }
  | {
      role: 'assistant';
      parts: MessagePart[];
      id: string;
      streaming: boolean;
      // When the user sends a message via the Enhance button, this holds the
      // id of the text-input node so we can render "Apply to this node"
      // buttons next to any code blocks in the reply.
      enhanceTargetId?: string;
      /** The canvas that id belongs to (canvasReplacements() when Enhance
       * was pressed). Node ids start again at n1 after a clear or a load, so
       * Apply goes once the canvas is replaced (follow-up to PR #195). */
      enhanceCanvas?: number;
    }
  | {
      role: 'system';
      id: string;
      text: string;
    }
  | {
      role: 'thinking';
      id: string;
      lines: string[];
      collapsed: boolean;
      startedAt: number;
      completed: boolean;
    };

type PendingImage =
  | {
      id: string;
      status: 'uploading';
      thumbUrl: string;
      label?: string;
    }
  | {
      id: string;
      status: 'ready';
      nodeId: string;
      thumbUrl: string;
      label?: string;
    }
  | {
      id: string;
      status: 'error';
      error: string;
      thumbUrl?: string;
      label?: string;
    };

// Splits streamed text into alternating prose and fenced-code segments. Only
// closed fences match, so a half-streamed block still renders as text until it
// lands. Strips a single leading language hint (```ts, ```plaintext, etc).
function parseTextWithCodeBlocks(text: string): Array<{ kind: 'prose' | 'code'; content: string }> {
  const segments: Array<{ kind: 'prose' | 'code'; content: string }> = [];
  const regex = /```([\s\S]*?)```/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) segments.push({ kind: 'prose', content: text.slice(lastIndex, m.index) });
    const raw = m[1].replace(/^[a-zA-Z0-9_-]*\n/, '');
    segments.push({ kind: 'code', content: raw.trim() });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) segments.push({ kind: 'prose', content: text.slice(lastIndex) });
  return segments;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Walk the messages list, marking any not-yet-completed thinking bubble as
// completed. Called whenever a non-thinking event arrives (text /
// done / error) so the next batch of thinking events starts a fresh bubble
// on the next turn instead of appending to this turn's finished stream.
// Does NOT collapse — collapse happens once at turn end via the done handler,
// because collapsing mid-turn caused bubbles to flash-and-fold in interleaved
// thinking/text streams. A past turn's worth of craft notes should stay
// readable while the agent is still working.
function markThinkingCompleted(msgs: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = msgs.map((m) => {
    if (m.role === 'thinking' && !m.completed) {
      changed = true;
      return { ...m, completed: true };
    }
    return m;
  });
  return changed ? next : msgs;
}

// Collapse every completed thinking bubble in one pass. Called only on `done`
// so the final response anchors the eye after the turn wraps, but nothing
// collapses mid-stream.
function collapseAllThinking(msgs: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = msgs.map((m) => {
    if (m.role === 'thinking' && !m.collapsed) {
      changed = true;
      return { ...m, collapsed: true, completed: true };
    }
    return m;
  });
  return changed ? next : msgs;
}

function formatToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function AssistantBubble({ message, agentName, onPermission }: {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  agentName: string;
  onPermission: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  // Apply writes the canvas: it takes the canvas lock (disabled, marked,
  // GM's tooltip while following; offline too). Once the canvas its node id
  // was read on is replaced (that id may name another node now) it stays,
  // disabled, and its tooltip says why (fix round 1 of PR #200, GM answer 4:
  // never remove an action without saying why).
  const lock = useCanvasLock();
  const canvasNow = useSyncExternalStore(subscribeCanvasReplaced, canvasReplacements, canvasReplacements);
  const projectName = useProjectStore((state) => state.activeProject?.name ?? null);
  const replacedSince = Boolean(message.enhanceTargetId) && message.enhanceCanvas !== canvasNow;
  const applyTitle = replacedSince ? replacedSinceWrittenLine(lastCanvasReplacement(), projectName)
    : 'Paste this into the text-input node that triggered Enhance';

  const applyToTarget = (content: string) => {
    if (!message.enhanceTargetId || message.enhanceCanvas !== canvasReplacements()) return;
    if (refuseCanvasEdit()) return;
    const { nodes, updateNodeData } = useGraphStore.getState();
    const target = nodes.find((n) => n.id === message.enhanceTargetId);
    if (!target) return;
    updateNodeData(target.id, {
      params: { ...(target.data as { params?: Record<string, unknown> }).params, value: content },
    });
  };

  // Compact label for the Apply button. For cli nodes we reference them as @n2;
  // for frontend-only UUIDs we just say "text-input" to avoid leaking a UUID.
  const applyLabel = message.enhanceTargetId
    ? /^n\d+$/.test(message.enhanceTargetId)
      ? `Apply to @${message.enhanceTargetId}`
      : 'Apply to text-input'
    : 'Apply';

  return (
    <div className="chat__bubble chat__bubble--assistant" data-chat-message-role="assistant">
      {message.parts.map((part, idx) => {
        if (part.kind === 'text') {
          const segments = parseTextWithCodeBlocks(part.text);
          return (
            <div key={idx} className="chat__text">
              {segments.map((seg, i) =>
                seg.kind === 'prose' ? (
                  <span key={i}>{seg.content}</span>
                ) : (
                  <div key={i} className="chat__codeblock">
                    <pre className="chat__codeblock-body">{seg.content}</pre>
                    {message.enhanceTargetId && (
                      <button
                        type="button"
                        className="chat__codeblock-apply"
                        onClick={() => applyToTarget(seg.content)}
                        // Offline: when it works again (review 2 N-6), unless
                        // the canvas it was written for has gone for good.
                        {...lock.act({ disabled: replacedSince, title: applyTitle, offline: replacedSince ? undefined : true })}
                      >
                        {applyLabel}
                      </button>
                    )}
                  </div>
                ),
              )}
            </div>
          );
        }
        if (part.kind === 'thought') {
          return (
            <details key={idx} className="chat__thought" data-chat-part="thought">
              <summary>Thinking</summary>
              <p className="chat__thought-body">{part.text}</p>
            </details>
          );
        }
        if (part.kind === 'plan') {
          return (
            <ol key={idx} className="chat__plan" aria-label="Plan" data-chat-part="plan">
              {part.entries.map((entry, i) => (
                <li key={i} data-plan-status={entry.status} data-plan-priority={entry.priority}>{entry.content}</li>
              ))}
            </ol>
          );
        }
        if (part.kind === 'permission') {
          return <PermissionCard key={part.requestId} part={part} agentName={agentName} onDecision={onPermission} />;
        }
        if (part.kind === 'system') {
          const tone = part.tone ?? 'neutral';
          return (
            <div
              key={idx}
              className={`chat__system chat__system--${tone}`}
              data-chat-system-tone={tone}
            >
              {part.details ? <><span>{part.text}</span><ErrorDetails raw={part.details} className="chat__system-details" /></> : part.text}
            </div>
          );
        }
        const isOpen = expandedTools[part.toolUseId] ?? false;
        const ToolDisclosureIcon = isOpen ? ChevronDown : ChevronRight;
        return (
          <div
            key={part.toolUseId || idx}
            className={`chat__tool ${part.isError ? 'chat__tool--error' : ''}`}
          >
            <button
              className="chat__tool-header"
              onClick={() =>
                setExpandedTools((s) => ({ ...s, [part.toolUseId]: !isOpen }))
              }
            >
              <ToolDisclosureIcon
                className="chat__tool-icon"
                size={10}
                strokeWidth={2}
                aria-hidden="true"
                focusable="false"
              />
              <span className="chat__tool-name">{part.tool || 'tool'}</span>
              {part.result === undefined && (
                <span className="chat__tool-status">running…</span>
              )}
            </button>
            {isOpen && (
              <div className="chat__tool-body">
                {part.input !== undefined && (
                  <pre className="chat__tool-input">{formatToolInput(part.input)}</pre>
                )}
                {part.result !== undefined && (
                  <pre className="chat__tool-output">{part.result}</pre>
                )}
              </div>
            )}
          </div>
        );
      })}
      {message.streaming && <span className="chat__cursor">▊</span>}
    </div>
  );
}

function insertAtCaret(target: HTMLTextAreaElement, token: string): void {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? target.value.length;
  const before = target.value.slice(0, start);
  const after = target.value.slice(end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const insert = `${needsLeadingSpace ? ' ' : ''}${token}${needsTrailingSpace ? ' ' : ''}`;
  const next = before + insert + after;
  // Fire the React onChange via a synthetic input event so state stays in sync.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  nativeSetter?.call(target, next);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  requestAnimationFrame(() => {
    const caret = before.length + insert.length;
    target.focus();
    target.setSelectionRange(caret, caret);
  });
}

export function ChatPanel() {
  // Offline is read-only (round 15 of PR #114): Send is disabled.
  const offline = useBackendOffline();
  const commonsEnabled = useUIStore((s) => s.commonsEnabled);
  const visible = useUIStore((s) => s.panels.chat.visible);
  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);
  const width = useUIStore((s) => s.panels.chat.width) ?? 300;
  const height = useUIStore((s) => s.panels.chat.height);
  const left = useUIStore((s) => s.panels.chat.left);
  const top = useUIStore((s) => s.panels.chat.top);
  const setChatWidth = useUIStore((s) => s.setChatWidth);
  const setChatHeight = useUIStore((s) => s.setChatHeight);
  const setChatPosition = useUIStore((s) => s.setChatPosition);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const chatResized = useUIStore((s) => s.chatResized);
  // Default sizing is CSS-driven (clamp + viewport units) so chat width
  // matches the agent log next to it. Once the user resizes, chatResized
  // flips and inline width/height take over.
  const useCssSizing = !chatResized;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [selection, setSelection] = useState<ChatSelection>(loadChatSelection);
  const agent = selection.agent;
  const personal = isPersonalAgent(agent);
  // Nebula's own runners have a model catalog; a personal agent picks its own model.
  const providerAgent: ChatProvider | null = personal ? null : agent as ChatProvider;
  const providerSelection = providerAgent ? selection[providerAgent] : NO_MODEL;
  const [personalAgents, setPersonalAgents] = useState<PersonalAgentList | null>(null);
  const [warningFor, setWarningFor] = useState<string | null>(null);
  const personalAgent = personal
    ? personalAgents?.agents.find((item) => `personal:${item.id}` === agent && item.status === 'ready') ?? null : null;
  const agentDisplayName = personalAgent?.displayName ?? (agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : 'Your agent');
  const [modelCatalog, setModelCatalog] = useState<ChatModelCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const activeCatalog = modelCatalog?.agent === agent ? modelCatalog : null;
  const model = personal ? null : providerSelection.model ?? activeCatalog?.models.find((item) => item.isDefault)?.id ?? null;
  const effort = providerSelection.effort;
  const selectedModel = activeCatalog?.models.find((item) => item.id === model);
  const selectionIssue = personal
    ? personalAgents && !personalAgent ? 'This agent is off or unavailable. Choose another in the picker.' : null
    : activeCatalog?.status !== 'ready'
    ? 'Load the available models before sending.'
    : !selectedModel
      ? providerSelection.model === null
        ? 'Choose an available model to continue.'
        : 'Your saved model is no longer available. Choose a model to continue.'
      : effort !== null && !selectedModel.supportedEfforts.some((item) => item.id === effort)
        ? 'Your saved effort is unavailable for this model. Choose an effort to continue.'
        : null;
  const [brand, setBrand] = useState('');
  const [authorizing, setAuthorizing] = useState(false);
  const authorityPendingRef = useRef(false);
  const chatPanelRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  usePanelFocus(visible && shouldRender, chatPanelRef,
    () => useUIStore.getState().togglePanel('chat'), { initialFocus: 'textarea' });

  // Auto-grow the textarea as the user types so the full prompt is visible
  // (instead of scrolling inside a fixed 2-row box). Capped at 200px so a
  // very long prompt doesn't push into the AGENT LOG area below.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [claudeStatusError, setClaudeStatusError] = useState<string | null>(null);
  const [claudeBackendOffline, setClaudeBackendOffline] = useState(false);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [codexStatusError, setCodexStatusError] = useState<string | null>(null);
  const [codexBackendOffline, setCodexBackendOffline] = useState(false);
  const [codexLoginState, setCodexLoginState] = useState<CodexChatGPTLoginState | null>(null);
  const [codexLoginError, setCodexLoginError] = useState<string | null>(null);
  const [codexLoginBusy, setCodexLoginBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The models (or thinking levels) a personal agent offers for its session.
  const [personalOptions, setPersonalOptions] = useState<PersonalSessionOption[]>([]);
  useEffect(() => { if (!sessionId) setPersonalOptions([]); }, [sessionId]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelState, setCancelState] = useState<ChatCancellationState>('idle');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(CHAT_SELECTION_KEY, JSON.stringify(selection)); }
    catch { /* Browsing without persistent storage still works. */ }
  }, [selection]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const load = () => {
      fetchPersonalAgents()
        .then((list) => { if (!cancelled) setPersonalAgents(list); })
        .catch(() => { if (!cancelled) setPersonalAgents((current) => current ?? { warningAcknowledged: false, agents: [] }); });
    };
    load();
    window.addEventListener(PERSONAL_AGENTS_CHANGED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(PERSONAL_AGENTS_CHANGED_EVENT, load); };
  }, [visible]);

  useEffect(() => {
    if (!visible || !providerAgent) return;
    const catalogAgent = providerAgent;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCatalogLoading(true);
      setCatalogError(null);
      fetchChatModels(catalogAgent, catalogRefresh > 0)
        .then((catalog) => { if (!cancelled) setModelCatalog(catalog); })
        .catch((error: unknown) => {
          if (!cancelled) {
            setModelCatalog(null);
            setCatalogError(failureMessage(error, "Couldn't load the models."));
          }
        })
        .finally(() => { if (!cancelled) setCatalogLoading(false); });
    });
    return () => { cancelled = true; };
  }, [providerAgent, visible, catalogRefresh, claudeStatus?.loggedIn, codexStatus?.loggedIn, codexStatus?.mode]);

  const handleModelChange = useCallback((next: string) => {
    if (!providerAgent || busy || authorityPendingRef.current || !activeCatalog?.models.some((item) => item.id === next)) return;
    const nextModel = activeCatalog.models.find((item) => item.id === next)!;
    setSelection((current) => ({ ...current, [providerAgent]: {
      model: next,
      effort: current[providerAgent].effort !== null && nextModel.supportedEfforts.some((item) => item.id === current[providerAgent].effort)
        ? current[providerAgent].effort : null,
    } }));
  }, [providerAgent, activeCatalog, busy]);

  const handleEffortChange = useCallback((next: string | null) => {
    if (!providerAgent || busy || authorityPendingRef.current || (next !== null && !selectedModel?.supportedEfforts.some((item) => item.id === next))) return;
    setSelection((current) => ({ ...current, [providerAgent]: { ...current[providerAgent], effort: next } }));
  }, [providerAgent, selectedModel, busy]);

  useEffect(() => {
    if (agent !== 'claude') return;
    let cancelled = false;
    let retryTimer: number | null = null;

    const refresh = () => {
      if (cancelled) return;
      setClaudeStatusError(null);
      setClaudeBackendOffline(false);
      fetchClaudeStatus()
        .then((status) => {
          if (cancelled) return;
          setClaudeStatus(status);
          if (!status.installed || !status.loggedIn) {
            retryTimer = window.setTimeout(refresh, 5000);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setClaudeStatus(null);
          setClaudeStatusError(failureMessage(err, "Couldn't check Claude status."));
          setClaudeBackendOffline(isBackendUnavailableError(err));
          retryTimer = window.setTimeout(refresh, 3000);
        });
    };

    refresh();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [agent]);

  useEffect(() => {
    if (agent !== 'codex') return;
    let cancelled = false;
    let retryTimer: number | null = null;

    const refresh = () => {
      if (cancelled) return;
      setCodexStatusError(null);
      setCodexBackendOffline(false);
      fetchCodexStatus()
        .then((status) => {
          if (cancelled) return;
          setCodexStatus(status);
          if (!status.installed || !status.loggedIn || status.mode !== 'chatgpt') {
            retryTimer = window.setTimeout(refresh, 5000);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setCodexStatus(null);
          setCodexStatusError(failureMessage(err, "Couldn't check Codex status."));
          setCodexBackendOffline(isBackendUnavailableError(err));
          retryTimer = window.setTimeout(refresh, 3000);
        });
    };

    refresh();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [agent]);

  const handleStartCodexChatGPTLogin = useCallback(async (deviceAuth = false) => {
    setCodexLoginBusy(true);
    setCodexLoginError(null);
    try {
      const state = await startCodexChatGPTLogin(deviceAuth);
      setCodexLoginState(state);
      setNotice(deviceAuth ? 'Codex device login started.' : 'ChatGPT account login started.');
    } catch (err) {
      const line = failureMessage(err, "Couldn't start the ChatGPT sign-in.");
      setCodexLoginError(line);
      clearSetterOnPromote(err, setCodexLoginError, line, null); // clears-on-promote: chat.codex-login (GM, #204 r3)
    } finally {
      setCodexLoginBusy(false);
    }
  }, []);

  useEffect(() => {
    if (agent !== 'codex' || !codexLoginState?.running) return;
    let cancelled = false;
    let retryTimer: number | null = null;

    const poll = async () => {
      try {
        const [loginState, status] = await Promise.all([
          fetchCodexChatGPTLoginState(),
          fetchCodexStatus(),
        ]);
        if (cancelled) return;
        setCodexLoginState(loginState);
        setCodexStatus(status);
        setCodexStatusError(null);
        setCodexBackendOffline(false);
        if (!loginState.running && status.loggedIn && status.mode === 'chatgpt') {
          setCatalogRefresh((value) => value + 1);
        } else {
          retryTimer = window.setTimeout(poll, 1500);
        }
      } catch (err) {
        if (cancelled) return;
        const line = failureMessage(err, "Couldn't check the ChatGPT sign-in.");
        setCodexLoginError(line);
        clearSetterOnPromote(err, setCodexLoginError, line, null); // clears-on-promote: chat.codex-login-check (GM, #204 r3)
        retryTimer = window.setTimeout(poll, 2500);
      }
    };

    retryTimer = window.setTimeout(poll, 800);
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [agent, codexLoginState?.running]);

  const claudeStatusLabel = useMemo(() => {
    if (claudeBackendOffline) return 'Nebula backend offline';
    if (claudeStatusError) return 'Claude status unavailable';
    if (!claudeStatus) return 'Checking Claude…';
    if (!claudeStatus.installed) return 'Claude not installed';
    if (!claudeStatus.loggedIn) return 'Claude login needed';
    if (activeCatalog?.agent === 'claude' && chatAuthUsesProviderBilling(activeCatalog.auth.mode)) return /api|bearer/i.test(activeCatalog.auth.mode || '') ? 'Claude Code · API billing' : 'Claude Code · Provider billing';
    if (claudeStatus.subscriptionType) return `Claude · ${claudeStatus.subscriptionType}`;
    if (claudeStatus.authMethod) return `Claude · ${claudeStatus.authMethod}`;
    return 'Claude logged in';
  }, [claudeStatus, claudeStatusError, claudeBackendOffline, activeCatalog]);

  const codexStatusLabel = useMemo(() => {
    if (codexBackendOffline) return 'Nebula backend offline';
    if (codexStatusError) return 'Codex status unavailable';
    if (!codexStatus) return 'Checking Codex…';
    if (!codexStatus.installed) return 'Codex not installed';
    if (!codexStatus.loggedIn) return 'Codex login needed';
    if (codexStatus.mode === 'chatgpt') return 'Codex · ChatGPT';
    if (codexStatus.mode === 'api') return 'Codex · API billing';
    if (codexStatus.mode === 'access_token') return 'Codex · access token';
    return 'Codex logged in';
  }, [codexStatus, codexStatusError, codexBackendOffline]);

  const agentConnectHint = useMemo(() => {
    if (agent === 'claude') {
      const backendUnavailable = claudeBackendOffline;
      const needsConnection = Boolean(claudeStatusError || !claudeStatus?.installed || !claudeStatus?.loggedIn);
      if (backendUnavailable) {
        return {
          agent: 'claude' as const,
          open: true,
          title: 'Start Nebula backend',
          status: 'Backend offline',
          detail: `Claude may already be logged in, but Nebula cannot reach FastAPI on port ${CHAT_BACKEND_PORT}.`,
          canStartLogin: false,
          commands: [BACKEND_START_COMMAND],
        };
      }
      return {
        agent: 'claude' as const,
        open: needsConnection,
        title: needsConnection ? 'Connect Claude' : 'Claude connected',
        status: claudeStatusLabel,
        detail: activeCatalog?.agent === 'claude' && chatAuthUsesProviderBilling(activeCatalog.auth.mode)
          ? 'Claude Code is using provider billing. Check its authentication settings to use your subscription login.'
          : 'Uses your existing Claude Code login on this machine.',
        canStartLogin: false,
        commands: [
          'claude auth login --claudeai',
          'claude auth login --console',
          'claude auth status',
        ],
      };
    }
    if (agent === 'codex') {
      const backendUnavailable = codexBackendOffline;
      const needsConnection = Boolean(
        codexStatusError ||
        !codexStatus?.installed ||
        !codexStatus?.loggedIn ||
        codexStatus.mode !== 'chatgpt',
      );
      if (backendUnavailable) {
        return {
          agent: 'codex' as const,
          open: true,
          title: 'Start Nebula backend',
          status: 'Backend offline',
          detail: `Codex may already be logged in, but Nebula cannot reach FastAPI on port ${CHAT_BACKEND_PORT}.`,
          canStartLogin: false,
          commands: [BACKEND_START_COMMAND],
        };
      }
      const detail = codexStatus?.mode === 'api'
        ? 'Codex is using API billing. Switch to ChatGPT account login for subscription access.'
        : "Sign in through Codex's local ChatGPT OAuth flow. Nebula starts it and keeps checking status.";
      return {
        agent: 'codex' as const,
        open: needsConnection,
        title: needsConnection ? 'Connect ChatGPT Account' : 'ChatGPT account connected',
        status: codexStatusLabel,
        detail,
        canStartLogin: true,
        commands: [
          'codex login',
          'codex login --device-auth',
          'codex login status',
        ],
      };
    }
    return null;
  }, [agent, claudeStatus, claudeStatusError, claudeBackendOffline, claudeStatusLabel, codexStatus, codexStatusError, codexBackendOffline, codexStatusLabel, activeCatalog]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // Switch the active agent. Each agent has its own session thread, so we
  // clear sessionId on change — the next turn starts fresh on the new agent.
  // Set once wsRef exists (below): tells the backend to end a personal
  // agent's session, which kills its process tree and revokes its token.
  const closePersonalSessionRef = useRef<(id: string) => void>(() => {});

  const handleAgentChange = useCallback(
    (next: ChatAgent) => {
      if (next === agent || busy || authorityPendingRef.current) return;

      if (personal && sessionId) closePersonalSessionRef.current(sessionId);
      setSelection((current) => ({ ...current, agent: next }));
      setSessionId(null);
      const nextName = next === 'claude' ? 'Claude Code' : next === 'codex' ? 'Codex'
        : personalAgents?.agents.find((item) => `personal:${item.id}` === next)?.displayName ?? 'your agent';
      setNotice(`Next message starts a new ${nextName} conversation. Earlier messages stay here.`);
    },
    [agent, busy, personal, sessionId, personalAgents],
  );

  const changeBrand = useCallback((next: string) => {
    if (busy || authorityPendingRef.current) return;
    setBrand(next);
    if (next.trim() !== brand.trim()) {
      setSessionId(null);
      setNotice('Brand changed. Your next message starts a new conversation.');
    }
  }, [brand, busy]);

  const wsRef = useRef<WebSocket | null>(null);
  // Review 4 NIT-2 (round 6): the promote count the latest message on the chat socket went out
  // under, so its person_required error is stamped like apiFetch's answers.
  const sentUnder = useRef(personPromotions());
  useEffect(() => {
    closePersonalSessionRef.current = (id: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      void personTokenForSocket(ws.url).then((personToken) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'close_session', sessionId: id, ...(personToken ? { personToken } : {}) }));
      });
    };
  }, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const cancelStateRef = useRef<ChatCancellationState>('idle');
  const applyCancellationEvent = useCallback((event: ChatCancellationEvent) => {
    const transition = transitionChatCancellation(cancelStateRef.current, event);
    cancelStateRef.current = transition.state;
    busyRef.current = transition.busy;
    setCancelState(transition.state);
    setBusy(transition.busy);
    return transition;
  }, []);

  // Holds the text-input node id for the next outgoing message, set by the
  // Enhance button just before send. Cleared when the message leaves so it
  // only attaches to the one assistant response it triggered.
  const pendingEnhanceTargetRef = useRef<{ id: string; canvas: number } | null>(null);

  const uploadFile = useCallback(
    async (file: File, chipId: string) => {
      // Round 20 (M1): no node is added to a canvas that's about to go away;
      // the chip goes, as the drop did nothing.
      if (refuseEditWhileFollowing()) {
        setPendingImages((prev) => {
          const prior = prev.find((p) => p.id === chipId);
          if (prior && prior.status === 'uploading' && prior.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(prior.thumbUrl);
          return prev.filter((p) => p.id !== chipId);
        });
        return;
      }
      const form = new FormData();
      form.append('file', file);
      form.append('create_node', 'true');
      // Offline is read-only (GM, round 14 of PR #114): nothing is sent.
      if (refuseEditWhileOffline()) {
        setPendingImages((prev) => prev.filter((p) => p.id !== chipId));
        return;
      }
      // The upload adds a node to the canvas: one undo step, taken before the
      // backend's graphSync can add it, owning only that node (round 14 of PR
      // #114: an agent's node its echo brings isn't this step's).
      const undoStep = useGraphStore.getState().beginUndoStep();
      // The node the upload adds, which comes with its echo (review 11, L-2).
      let arrives: string[] = [];
      try {
        const resp = await apiFetch('/api/uploads', { method: 'POST', body: form });
        if (!resp.ok) {
          const detail = await readDetail(resp);
          warnFailure("Couldn't upload the image.", resp.status, detail);
          const errMsg = chatUploadChipError(resp.status, detail);
          setPendingImages((prev) => {
            const prior = prev.find((p) => p.id === chipId);
            // URL.revokeObjectURL is idempotent — safe inside a StrictMode-
            // double-invoked updater.
            if (prior && prior.status === 'uploading' && prior.thumbUrl.startsWith('blob:')) {
              URL.revokeObjectURL(prior.thumbUrl);
            }
            return prev.map((p) =>
              p.id === chipId
                ? { id: chipId, status: 'error', error: errMsg, label: file.name }
                : p,
            );
          });
          return;
        }
        const body = (await resp.json()) as {
          nodeId: string;
          url: string;
          thumbUrl: string;
          filename: string;
        };
        if (typeof body.nodeId === 'string' && body.nodeId) arrives = [body.nodeId];
        setPendingImages((prev) => {
          const prior = prev.find((p) => p.id === chipId);
          // URL.revokeObjectURL is idempotent — safe inside a StrictMode-
          // double-invoked updater.
          if (prior && prior.status === 'uploading' && prior.thumbUrl.startsWith('blob:')) {
            URL.revokeObjectURL(prior.thumbUrl);
          }
          return prev.map((p) =>
            p.id === chipId
              ? {
                  id: chipId,
                  status: 'ready',
                  nodeId: body.nodeId,
                  thumbUrl: backendAssetUrlSync(body.thumbUrl),
                  label: body.filename,
                }
              : p,
          );
        });
        // Edge case: if the user closed the chat panel while upload was in
        // flight, .chat-panel__textarea is unmounted and the marker insertion
        // is a no-op. The chip still transitions to ready so reopening the
        // panel shows a ready chip without a marker — user can re-type or
        // remove. Task 9 surfaces the attachment in the message-log
        // thumbnail row, so nothing is truly lost.
        const textarea = document.querySelector<HTMLTextAreaElement>('.chat-panel__textarea');
        if (textarea) insertAtCaret(textarea, `@${body.nodeId}`);
      } catch {
        setPendingImages((prev) => {
          const prior = prev.find((p) => p.id === chipId);
          // URL.revokeObjectURL is idempotent — safe inside a StrictMode-
          // double-invoked updater.
          if (prior && prior.status === 'uploading' && prior.thumbUrl.startsWith('blob:')) {
            URL.revokeObjectURL(prior.thumbUrl);
          }
          return prev.map((p) =>
            p.id === chipId
              ? { id: chipId, status: 'error', error: 'Network error', label: file.name }
              : p,
          );
        });
      } finally {
        // The step was cancelled, or it settles once its node is on the canvas:
        // an undo pressed meanwhile then acts (review 10, L-2; review 11, L-2).
        useGraphStore.getState().endUndoStep(undoStep, { arrives });
      }
    },
    [],
  );

  // Remove a chip and strip the first matching `@nX` marker from the textarea.
  // If the chip never reached `ready` (no nodeId), just drops the chip — there's
  // no marker to strip.
  const removeChip = useCallback((id: string) => {
    setPendingImages((prev) => {
      const chip = prev.find((p) => p.id === id);
      if (chip && chip.status === 'ready') {
        const token = `@${chip.nodeId}`;
        setInput((curr) => {
          const idx = curr.indexOf(token);
          if (idx === -1) return curr;
          // Strip the token plus one trailing space if present, so we don't
          // leave a dangling double-space.
          const endIdx = idx + token.length + (curr[idx + token.length] === ' ' ? 1 : 0);
          return curr.slice(0, idx) + curr.slice(endIdx);
        });
      }
      if (chip && chip.status === 'uploading' && chip.thumbUrl.startsWith('blob:')) {
        URL.revokeObjectURL(chip.thumbUrl);
      }
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const upsertAssistant = useCallback(
    (updater: (msg: Extract<ChatMessage, { role: 'assistant' }>) => Extract<ChatMessage, { role: 'assistant' }>) => {
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.role === 'assistant') {
            next[i] = updater(m);
            return next;
          }
        }
        return prev;
      });
    },
    [],
  );

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | null = null;
    let reconnectNow = false;

    const scheduleReconnect = () => {
      if (cancelled || retryTimer) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, 3000);
    };

    const connect = () => {
      backendWebSocketUrl('/ws/chat')
        .then((url) => {
          if (cancelled) return;
          const socket = new WebSocket(url);
          ws = socket;
          wsRef.current = socket;

          socket.onopen = () => setConnected(true);
          socket.onclose = () => {
            if (cancelled) return;
            if (wsRef.current === socket) wsRef.current = null;
            setConnected(false);
            const disconnectNotice = chatCancellationDisconnectNotice(cancelStateRef.current);
            applyCancellationEvent({ type: 'disconnect' });
            if (disconnectNotice) {
              upsertAssistant((msg) => ({
                ...msg,
                parts: [...msg.parts, { kind: 'system', ...disconnectNotice }],
                streaming: false,
              }));
            }
            if (reconnectNow && ws === socket) {
              reconnectNow = false;
              connect();
              return;
            }
            scheduleReconnect();
          };
          socket.onerror = () => {
            setConnected(false);
            socket.close();
          };

          socket.onmessage = (ev) => {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(ev.data);
            } catch {
              return;
            }

          const type = event.type;
          if (type === 'session') {
            setSessionId(String(event.sessionId));
            setPersonalOptions(parsePersonalSessionOptions(event.options));
            return;
          }
          if (type === 'personal_options') {
            setPersonalOptions(parsePersonalSessionOptions(event.options));
            if (event.error) setNotice(String(event.error));
            return;
          }
          if (type === 'thinking') {
            // Route thinking stream into the Agent Log instead of cluttering
            // the chat. AgentLog listens for nebula:agent-log-entry events.
            const line = String(event.text ?? '').trim();
            if (line) {
              window.dispatchEvent(
                new CustomEvent('nebula:agent-log-entry', {
                  detail: {
                    source: normalizeAgentEventSource(event.source),
                    message: line,
                  },
                }),
              );
            }
            return;
          }
          if (type === 'text') {
            const text = String(event.text ?? '');
            setMessages((prev) => markThinkingCompleted(prev));
            upsertAssistant((msg) => {
              const parts = [...msg.parts];
              const last = parts[parts.length - 1];
              if (last && last.kind === 'text') {
                parts[parts.length - 1] = { kind: 'text', text: last.text + text };
              } else {
                parts.push({ kind: 'text', text });
              }
              return { ...msg, parts };
            });
            return;
          }
          if (type === 'thought') {
            const text = String(event.text ?? '');
            upsertAssistant((msg) => {
              const parts = [...msg.parts];
              const last = parts[parts.length - 1];
              if (last && last.kind === 'thought') parts[parts.length - 1] = { kind: 'thought', text: last.text + text };
              else parts.push({ kind: 'thought', text });
              return { ...msg, parts };
            });
            return;
          }
          if (type === 'plan') {
            const entries = Array.isArray(event.entries) ? (event.entries as Array<Record<string, unknown>>).map((entry) => ({
              content: String(entry.content ?? ''), priority: String(entry.priority ?? 'medium'), status: String(entry.status ?? 'pending'),
            })) : [];
            // A plan update replaces the whole plan.
            upsertAssistant((msg) => {
              const index = msg.parts.findIndex((part) => part.kind === 'plan');
              const parts = [...msg.parts];
              if (index >= 0) parts[index] = { kind: 'plan', entries };
              else parts.push({ kind: 'plan', entries });
              return { ...msg, parts };
            });
            return;
          }
          if (type === 'permission_request') {
            const part: PermissionRequestPart = {
              kind: 'permission',
              requestId: String(event.requestId ?? ''),
              title: String(event.title ?? 'The agent wants to use a tool'),
              toolKind: String(event.kind ?? 'other'),
              input: event.input,
              canAllow: Boolean(event.canAllow),
              timeoutSeconds: Number(event.timeoutSeconds) > 0 ? Number(event.timeoutSeconds) : 120,
              receivedAt: Date.now(),
              status: 'pending',
            };
            upsertAssistant((msg) => ({ ...msg, parts: [...msg.parts, part] }));
            return;
          }
          if (type === 'permission_resolved') {
            const requestId = String(event.requestId ?? '');
            const outcome = String(event.outcome ?? '');
            if (!PERMISSION_OUTCOMES.has(outcome)) return;
            upsertAssistant((msg) => ({
              ...msg,
              parts: msg.parts.map((part) => part.kind === 'permission' && part.requestId === requestId
                ? { ...part, status: outcome as PermissionStatus } : part),
            }));
            return;
          }
          if (type === 'system') {
            const text = String(event.text ?? '');
            if (text) upsertAssistant((msg) => ({ ...msg, parts: [...msg.parts, { kind: 'system', text }] }));
            return;
          }
          if (type === 'session_closed') {
            return;
          }
          if (type === 'tool_use') {
            const toolUseId = String(event.toolUseId ?? '');
            const tool = String(event.tool ?? '');
            const input = event.input;
            upsertAssistant((msg) => ({
              ...msg,
              parts: [...msg.parts, { kind: 'tool', toolUseId, tool, input }],
            }));
            return;
          }
          if (type === 'tool_result') {
            const toolUseId = String(event.toolUseId ?? '');
            const content = String(event.content ?? '');
            const isError = Boolean(event.isError);
            upsertAssistant((msg) => {
              const parts = msg.parts.map((p) =>
                p.kind === 'tool' && p.toolUseId === toolUseId
                  ? { ...p, result: content, isError }
                  : p,
              );
              return { ...msg, parts };
            });
            return;
          }
          if (type === 'result') {
            upsertAssistant((msg) => ({ ...msg, streaming: false }));
            return;
          }
          if (type === 'error') {
            const errText = String(event.message ?? 'unknown error');
            // A person-only refusal says GM's line, by its code; the backend's
            // words, written for agents, go behind Details (Q116 a).
            const personRequired = event.code === PERSON_REQUIRED_CODE;
            if (personRequired) {
              // One stamp and one check (review 4 NIT-2): an answer to what went out before the
              // promote is the old state's; it holds nothing, and its line goes at once.
              const refusal = personRefusalSentAt(sentUnder.current);
              if (!refusal.sentBeforePromote) reportPersonRequired();
              clearRefusedOnPromote(refusal, () => setMessages((prev) => withoutPersonGateLines(prev))); // clears-on-promote: chat.transcript
            }
            // The personal agent stopped (crash, idle timeout, closed): the next send starts a new one.
            if (event.code === 'personal_session_ended') setSessionId(null);
            if (event.code === 'personal_agent_warning_required') {
              setPersonalAgents((current) => current ? { ...current, warningAcknowledged: false } : current);
            }
            if (['model_unsupported', 'effort_unsupported', 'model_required', 'auth_required'].includes(String(event.code))) {
              setCatalogRefresh((value) => value + 1);
            }
            setMessages((prev) => markThinkingCompleted(prev));
            upsertAssistant((msg) => ({
              ...msg,
              parts: [
                ...msg.parts.map((p) =>
                  p.kind === 'tool' && p.result === undefined
                    ? { ...p, result: '(stream ended before this tool returned)', isError: true }
                    : p,
                ),
                personRequired
                  ? { kind: 'system', text: personRequiredCopy(), tone: 'error', details: errText, personGate: true }
                  : { kind: 'system', text: `Warning: ${errText}`, tone: 'error' },
              ],
              streaming: false,
            }));
            return;
          }
          if (type === 'cancellation') {
            const cancellationStatus = String(event.status ?? 'failed');
            if (cancellationStatus === 'requested') {
              const notice = chatCancellationNotice('requested');
              applyCancellationEvent({ type: 'request' });
              upsertAssistant((msg) => ({
                ...msg,
                parts: [...msg.parts, {
                  kind: 'system',
                  ...notice,
                }],
              }));
              return;
            }
            if (cancellationStatus === 'confirmed') {
              const notice = chatCancellationNotice('confirmed');
              applyCancellationEvent({ type: 'confirmed' });
              setMessages((prev) => collapseAllThinking(prev));
              upsertAssistant((msg) => ({
                ...msg,
                parts: [
                  ...msg.parts.map((p) =>
                    p.kind === 'tool' && p.result === undefined
                      ? { ...p, result: '(cancelled before this tool returned)', isError: true }
                      : p,
                  ),
                  { kind: 'system', ...notice },
                ],
                streaming: false,
              }));
              return;
            }
            const active = Boolean(event.active);
            // The backend's text is for the console; the person reads GM's line.
            console.warn('[nebula] chat stop failed:', event.message);
            const notice = chatCancellationNotice('failed');
            applyCancellationEvent({ type: 'failed', active });
            upsertAssistant((msg) => ({
              ...msg,
              parts: [...msg.parts, {
                kind: 'system',
                ...notice,
              }],
              streaming: active,
            }));
            return;
          }
          if (type === 'done') {
            const transition = applyCancellationEvent({ type: 'done' });
            if (!transition.busy) {
              setMessages((prev) => collapseAllThinking(prev));
            }
            upsertAssistant((msg) => ({
              ...msg,
              streaming: false,
              // Any tool still marked running at stream end gets flagged so the UI
              // doesn't dangle with a permanent "running..." indicator.
              parts: msg.parts.map((p) =>
                p.kind === 'tool' && p.result === undefined
                  ? { ...p, result: '(no result returned)', isError: true }
                  : p,
              ),
            }));
            return;
          }
          };
        })
        .catch(() => {
          if (cancelled) return;
          setConnected(false);
          applyCancellationEvent({ type: 'disconnect' });
          scheduleReconnect();
        });
    };

    connect();

    // A person link pasted into this open tab pins the backend that issued it.
    // A chat socket opened before that (on the dev proxy, say) can never carry
    // the token, so every send would be refused: reconnect it to the pinned
    // backend right away, the way the canvas socket does.
    const stopListening = onPersonConnected(() => {
      const socket = ws;
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
      void personTokenForSocket(socket.url).then((token) => {
        if (cancelled || ws !== socket || token) return;
        reconnectNow = true;
        socket.close();
      });
    });

    return () => {
      cancelled = true;
      stopListening();
      if (retryTimer) window.clearTimeout(retryTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, [visible, upsertAssistant, applyCancellationEvent]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Other components (e.g. the text-input node's Enhance button) can dispatch
  // `nebula:chat-send` with a pre-composed message. We open the panel if it's
  // closed, drop the message into the input, and auto-send when the socket is
  // ready and not already streaming. If busy, the user can hit Send themselves.
  // The panel is a deferred chunk: a send that came before it arrived was held
  // by its wrapper (DeferredPanels.tsx, which also opened the panel) and is
  // handed over here, where the panel takes the event over (lib/heldIntents.ts).
  const sendRef = useRef<() => void>(() => {});
  useEffect(() => {
    function onChatSend(e: Event) {
      receive((e as CustomEvent<ChatSendDetail | undefined>).detail);
    }
    function receive(detail: ChatSendDetail | undefined) {
      const msg = String(detail?.message ?? '').trim();
      if (!msg) return;
      if (!useUIStore.getState().panels.chat.visible) {
        useUIStore.getState().togglePanel('chat');
      }
      setInput(msg);
      // Remember which node triggered this so the Apply button knows where to
      // paste the reply's code blocks. Cleared inside send() once attached.
      pendingEnhanceTargetRef.current = detail?.sourceNodeId
        ? { id: detail.sourceNodeId, canvas: canvasReplacements() } : null;
      // Defer so the input state and possibly the WS connection settle first.
      setTimeout(() => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN && !busyRef.current) {
          sendRef.current();
        }
      }, 120);
    }
    window.addEventListener(CHAT_SEND_EVENT, onChatSend);
    const claim = claimIntent<ChatSendDetail>('chat-send');
    if (claim.held) receive(claim.held);
    return () => {
      claim.release();
      window.removeEventListener(CHAT_SEND_EVENT, onChatSend);
    };
  }, []);

  // DEV-only window bridge for scripted UI capture (the nebula-nodes-visuals
  // skill's capture template). Lets capture runs inject pre-recorded user +
  // assistant messages directly into the chat panel
  // for deterministic narration, bypassing the real LLM. The bridge mirrors
  // the message shapes the WS event stream produces, so rendering is identical
  // to a real conversation. Functional setMessages keeps closures correct
  // without retriggering the effect on every message.
  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env?.DEV) return;
    (window as unknown as { __nebulaChat?: unknown }).__nebulaChat = {
      // setInput lets the driver clear (or pre-fill) the textarea after a fake
      // type-then-pretend-send beat — without it the textarea still shows the
      // typed prompt after pushUser injects the user bubble, which reads as a
      // bug to viewers.
      setInput: (text: string) => setInput(text),
      pushUser: (text: string, opts?: { images?: Array<{ nodeId: string; thumbUrl: string }> }) => {
        const id = newId();
        setMessages((prev) => [
          ...prev,
          { role: 'user', text, id, images: opts?.images },
        ]);
        return id;
      },
      pushAssistant: (text: string, opts?: { streaming?: boolean }) => {
        const id = newId();
        const parts = text ? [{ kind: 'text' as const, text }] : [];
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', id, streaming: !!opts?.streaming, parts },
        ]);
        return id;
      },
      appendAssistant: (id: string, text: string) => {
        if (!text) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== id || m.role !== 'assistant') return m;
            const parts = [...m.parts];
            const last = parts[parts.length - 1];
            if (last && last.kind === 'text') {
              parts[parts.length - 1] = { kind: 'text', text: last.text + text };
            } else {
              parts.push({ kind: 'text', text });
            }
            return { ...m, parts };
          }),
        );
      },
      endAssistant: (id: string) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id && m.role === 'assistant' ? { ...m, streaming: false } : m,
          ),
        );
      },
      pushAssistantSystem: (text: string, opts?: { tone?: 'neutral' | 'error' | 'success'; streaming?: boolean }) => {
        const id = newId();
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            id,
            streaming: !!opts?.streaming,
            parts: [{ kind: 'system', text, tone: opts?.tone ?? 'neutral' }],
          },
        ]);
        return id;
      },
      setBusy: (next: boolean) => setBusy(next),
      setNotice: (text: string | null) => setNotice(text),
      setPendingImages: (chips: PendingImage[]) => setPendingImages(chips),
      pushThinking: (lines: string[]) => {
        const id = newId();
        setMessages((prev) => [
          ...prev,
          {
            role: 'thinking',
            id,
            lines: [...lines],
            collapsed: false,
            startedAt: Date.now(),
            completed: false,
          },
        ]);
        return id;
      },
      appendThinkingLine: (id: string, line: string) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id && m.role === 'thinking'
              ? { ...m, lines: [...m.lines, line] }
              : m,
          ),
        );
      },
      endThinking: (id: string) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id && m.role === 'thinking'
              ? { ...m, completed: true, collapsed: true }
              : m,
          ),
        );
      },
      clear: () => setMessages([]),
    };
  }, []);

  const send = useCallback(async () => {
    const raw = input.trim();
    if (!raw) return;

    if (busyRef.current || authorityPendingRef.current) return;
    // Commands and selections never start a model turn.
    if (raw.startsWith('/model ')) {
      const name = raw.slice(7).trim().toLowerCase();
      const match = activeCatalog?.models.find((item) => item.id.toLowerCase() === name || item.label.toLowerCase() === name);
      if (activeCatalog?.status !== 'ready' || !match) {
        setNotice('Choose an available model from the model picker.');
        return;
      }
      handleModelChange(match.id);
      setNotice(`Next message uses ${match.label}.`);
      setInput('');
      return;
    }
    // Offline is read-only (round 15 of PR #114): a message isn't sent (its
    // turn would edit the canvas); it stays typed and the banner pulses.
    if (refuseEditWhileOffline()) return;
    if (raw === '/clear') {
      // Offline is read-only (GM, round 14 of PR #114): the clear is refused
      // whole, chat and canvas, and the banner pulses; the command stays typed.
      // Following an agent's switch the same (the canvas lock, follow-up to
      // PR #195): the project bar pulses.
      if (refuseCanvasEdit()) return;
      if (personal && sessionId) closePersonalSessionRef.current(sessionId);
      setSessionId(null);
      // Also wipe Nebula's graph, under one undo step (lib/chatCanvasClear.ts).
      // The chat clears now, as before; the line comes with the canvas
      // clear's answer, appended, so a message sent meanwhile stays (round
      // 12 of PR #114: it used to replace the list when the answer came).
      setMessages([]);
      const said = (text: string) => setMessages((prev) => [
        ...prev, { role: 'assistant', id: newId(), streaming: false, parts: [{ kind: 'system', text }] },
      ]);
      setInput('');
      // The session is this tab's own and always clears; the canvas clear is
      // the backend's and can be refused (a run going: round 11 of PR #114)
      // or go unanswered (bounded), so the line says only what is known (GM).
      // A refusal also shows under Clear's heading.
      const outcome = await clearCanvasFromChat({
        onRefused: async (response) => {
          const refused = await requestError(CLEAR_CANVAS, response);
          const line = failureMessage(refused, CLEAR_CANVAS);
          setNotice(line);
          clearSetterOnPromote(refused, setNotice, line, null); // clears-on-promote: chat.clear-canvas (GM, #204 r3)
        },
      });
      said(outcome === 'cleared' ? CHAT_CLEARED_CANVAS
        : outcome === 'refused' ? CHAT_CLEARED_CANVAS_KEPT : CHAT_CLEARED_CANVAS_UNCONFIRMED);
      return;
    }

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (busyRef.current || authorityPendingRef.current) return;
    if (personal) {
      if (selectionIssue) { setNotice(selectionIssue); return; }
      // The one-time notice comes before Nebula starts any personal agent.
      if (!personalAgents?.warningAcknowledged) { setWarningFor(agent); return; }
    } else if (catalogLoading || selectionIssue) { setNotice(selectionIssue || 'Models are loading.'); return; }
    // Every turn carries the person token (the backend starts none without it).
    let authority: Awaited<ReturnType<typeof chatAuthority>> = {};
    authorityPendingRef.current = true;
    if (commonsEnabled) setAuthorizing(true);
    try { authority = await chatAuthority(ws.url, commonsEnabled, brand); }
    // The session line on its own (a FailureNotice with no heading, GM round 2).
    catch (error) {
      // No person token for the turn: its only reason is this tab, so it goes on the promote (GM, #204 r3).
      const line = oneLine(failureCopy(error));
      setNotice(line);
      reportPersonRequired();
      clearsOnPromote(() => setNotice((now) => (now === line ? null : now))); // clears-on-promote: chat.session
      return;
    }
    finally { authorityPendingRef.current = false; if (commonsEnabled) setAuthorizing(false); }
    if (busyRef.current || ws.readyState !== WebSocket.OPEN || useUIStore.getState().commonsEnabled !== commonsEnabled) return;

    const enhanceTarget = pendingEnhanceTargetRef.current;
    pendingEnhanceTargetRef.current = null;
    // Stash thumbs for the user-message bubble history rendering (Task 9
    // will make the bubble actually render them).
    const attachedImages = pendingImages
      .filter((p): p is Extract<PendingImage, { status: 'ready' }> => p.status === 'ready')
      .map((p) => ({ nodeId: p.nodeId, thumbUrl: p.thumbUrl }));
    const submittedImageIds = new Set(pendingImages.map((image) => image.id));
    setPendingImages((current) => current.filter((image) => !submittedImageIds.has(image.id)));
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        text: raw,
        id: newId(),
        images: attachedImages.length ? attachedImages : undefined,
      },
      { role: 'assistant', id: newId(), streaming: true, parts: [],
        enhanceTargetId: enhanceTarget?.id, enhanceCanvas: enhanceTarget?.canvas },
    ]);
    applyCancellationEvent({ type: 'send' });
    setInput((current) => current.trim() === raw ? '' : current);

    sentUnder.current = personPromotions();
    ws.send(
      JSON.stringify({
        type: 'send',
        message: raw,
        selectedNodeIds: useGraphStore.getState().nodes
          .filter((node) => node.selected)
          .map((node) => node.id),
        sessionId,
        ...authority,
        ...(personal ? {} : { model, effort }),
        agent,
      }),
    );
  }, [
    personal,
    personalAgents,
    input,
    model,
    effort,
    activeCatalog,
    catalogLoading,
    selectionIssue,
    sessionId,
    pendingImages,
    commonsEnabled,
    brand,
    agent,
    handleModelChange,
    applyCancellationEvent,
  ]);

  // Keep sendRef pointing at the latest `send` so the chat-send event listener
  // always calls the current closure (input/model/sessionId are captured fresh).
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const choosePersonalOption = useCallback((configId: string, value: string) => {
    // Round 16 (L5): an agent option (its model or mode) changes what the
    // agent may do, so offline it's refused like an edit (the banner pulses).
    if (refuseEditWhileOffline()) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) return;
    setPersonalOptions((current) => current.map((option) => option.id === configId ? { ...option, current: value } : option));
    void personTokenForSocket(ws.url).then((personToken) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      sentUnder.current = personPromotions();
      ws.send(JSON.stringify({ type: 'personal_option', sessionId, configId, value,
        ...(personToken ? { personToken } : {}) }));
    });
  }, [sessionId]);

  const answerPermission = useCallback((requestId: string, decision: 'allow' | 'deny') => {
    // Round 16 (L5): "Allow once" lets the agent act while the person's own
    // edits are blocked, so offline it's refused and the request stays
    // pending until Nebula answers. Deny only reduces, so it always goes.
    if (decision === 'allow' && refuseEditWhileOffline()) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    upsertAssistant((msg) => ({
      ...msg,
      parts: msg.parts.map((part) => part.kind === 'permission' && part.requestId === requestId && part.status === 'pending'
        ? { ...part, status: 'sent' } : part),
    }));
    void personTokenForSocket(ws.url).then((personToken) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      sentUnder.current = personPromotions();
      ws.send(JSON.stringify({ type: 'permission', requestId, decision, ...(personToken ? { personToken } : {}) }));
    });
  }, [upsertAssistant]);

  // After the person accepts the notice, send what they typed once the
  // acknowledged state has rendered (send reads it).
  const sendAfterWarningRef = useRef(false);
  const acceptWarning = useCallback(async () => {
    await acknowledgePersonalAgentWarning();
    sendAfterWarningRef.current = true;
    setPersonalAgents((current) => current ? { ...current, warningAcknowledged: true } : current);
    setWarningFor(null);
  }, []);
  useEffect(() => {
    if (!sendAfterWarningRef.current || !personalAgents?.warningAcknowledged) return;
    sendAfterWarningRef.current = false;
    sendRef.current();
  }, [personalAgents?.warningAcknowledged, send]);

  const cancel = useCallback(() => {
    const ws = wsRef.current;
    if (cancelStateRef.current === 'requested') return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const notice = chatCancellationNotice('failed', CONNECTION_LOST_COPY);
      applyCancellationEvent({ type: 'failed', active: false });
      upsertAssistant((msg) => ({
        ...msg,
        parts: [...msg.parts, {
          kind: 'system',
          ...notice,
        }],
        streaming: false,
      }));
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'cancel' }));
      applyCancellationEvent({ type: 'request' });
    } catch (error) {
      console.warn('[nebula] chat stop could not be sent:', error);
      const notice = chatCancellationNotice('failed', CONNECTION_LOST_COPY);
      applyCancellationEvent({ type: 'failed', active: false });
      upsertAssistant((msg) => ({
        ...msg,
        parts: [...msg.parts, {
          kind: 'system',
          ...notice,
        }],
        streaming: false,
      }));
    }
  }, [upsertAssistant, applyCancellationEvent]);

  const status = useMemo(() => {
    if (!connected) return 'disconnected';
    if (cancelState === 'requested') return 'cancelling…';
    if (cancelState === 'failed') return 'cancel failed';
    if (busy) return 'thinking…';
    return 'ready';
  }, [connected, busy, cancelState]);

  // Generic drag-to-resize helper. The `edges` string encodes which panel
  // edges the user is dragging: any combination of 'l', 'r', 't', 'b'. We
  // compute the new width/height and, when top or left is in play, the new
  // panel position so the grabbed edge stays glued to the cursor in both
  // anchoring modes (top-right default vs. top-left after drag).
  const MIN_W = 260;
  const MAX_W = 720;
  const MIN_H = 240;
  const MAX_H = 2000;
  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, edgesStr: string) => {
      e.preventDefault();
      e.stopPropagation();
      const panel = (e.currentTarget.parentElement as HTMLElement) ?? null;
      const rect = panel?.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = rect?.width ?? width;
      const startH = rect?.height ?? 400;
      const startLeft = rect?.left ?? 0;
      const startTop = rect?.top ?? 0;
      const hasL = edgesStr.includes('l');
      const hasR = edgesStr.includes('r');
      const hasT = edgesStr.includes('t');
      const hasB = edgesStr.includes('b');
      const wasLeftAnchored = left != null && top != null;

      // Any top/right manipulation forces the panel into left-anchored mode so
      // we have both coordinates to move. The default top-right-anchored layout
      // only lets the left and bottom edges resize without a position change.
      const needsAnchor = hasT || hasR || hasL;
      if (needsAnchor && !wasLeftAnchored) {
        setChatPosition(startLeft, startTop);
      }

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let newW = startW;
        let newH = startH;
        if (hasL) newW = startW - dx;
        if (hasR) newW = startW + dx;
        if (hasT) newH = startH - dy;
        if (hasB) newH = startH + dy;

        // Clamp before computing position so when width/height hit limits, the
        // opposite edge stops tracking instead of drifting off the clamped panel.
        const clampedW = Math.max(MIN_W, Math.min(MAX_W, newW));
        const clampedH = Math.max(MIN_H, Math.min(MAX_H, newH));

        setChatWidth(clampedW);
        setChatHeight(clampedH);

        if (wasLeftAnchored || needsAnchor) {
          let newLeft = startLeft;
          let newTop = startTop;
          if (hasL) newLeft = startLeft + (startW - clampedW);
          if (hasT) newTop = startTop + (startH - clampedH);
          setChatPosition(newLeft, newTop);
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = CHAT_PANEL_RESIZE_CURSORS[edgesStr] ?? 'move';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, left, top, setChatWidth, setChatHeight, setChatPosition],
  );

  const startPanelDrag = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const blockedTarget = target.closest(
        [
          '.chat-panel__resize-handle',
          '.chat-panel__input',
          '.chat-panel__agent-selector',
          '.chat-panel__tone-toggle',
          '.chat-panel__meta',
          '.chat-panel__model-picker',
          '.chat-model-picker',
          '.panel__close',
          'button',
          'input',
          'textarea',
          'select',
          'a',
          '[role="button"]',
        ].join(', '),
      );
      if (blockedTarget) return;
      e.preventDefault();
      const panel = e.currentTarget;
      const rect = panel?.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = rect?.left ?? left ?? 0;
      const startTop = rect?.top ?? top ?? 0;
      const startW = rect?.width ?? width;
      const startH = rect?.height ?? height ?? 400;
      const clampLeft = (nextLeft: number) => Math.max(-startW + 40, Math.min(window.innerWidth - 40, nextLeft));
      const clampTop = (nextTop: number) => Math.max(0, Math.min(window.innerHeight - 40, nextTop));
      const applyFreePosition = (nextLeft: number, nextTop: number) => {
        const clampedLeft = clampLeft(nextLeft);
        const clampedTop = clampTop(nextTop);
        panel.classList.add('chat-panel--free');
        panel.style.setProperty('--chat-panel-left', `${clampedLeft}px`);
        panel.style.setProperty('--chat-panel-top', `${clampedTop}px`);
        panel.style.setProperty('--chat-panel-width', `${startW}px`);
        panel.style.setProperty('--chat-panel-height', `${startH}px`);
        setChatPosition(clampedLeft, clampedTop);
      };

      // Default chat layout is top/right/bottom anchored. The first drag needs
      // to freeze the rendered box size so subsequent left/top coordinates move
      // the panel instead of stretching it.
      setChatWidth(startW);
      setChatHeight(startH);
      applyFreePosition(startLeft, startTop);

      const onMove = (ev: MouseEvent) => {
        applyFreePosition(
          startLeft + (ev.clientX - startX),
          startTop + (ev.clientY - startY),
        );
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [height, left, top, width, setChatHeight, setChatPosition, setChatWidth],
  );

  if (!shouldRender) return null;

  // Compose inline style based on which anchors the user has set.
  // - Default: top-right anchored, stretched from top to bottom.
  // - After height set: top-right anchored, explicit height.
  // - After drag: top-left anchored at user's position.
  // - In experiment layouts, skip width/height until the user has resized so
  //   CSS clamp drives sizing (matching agent log width).
  const freePanelVars: React.CSSProperties = left != null && top != null
    ? ({
        ['--chat-panel-left' as never]: `${left}px`,
        ['--chat-panel-top' as never]: `${top}px`,
        ['--chat-panel-width' as never]: `${width}px`,
        ...(height ? { ['--chat-panel-height' as never]: `${height}px` } : {}),
      } as React.CSSProperties)
    : {};
  const panelStyle: React.CSSProperties = useCssSizing
    ? {
        ...(left != null && top != null
          ? { left, top, right: 'auto' }
          : {}),
        ...freePanelVars,
      }
    : {
        width,
        ...(height ? { height, bottom: 'auto' } : {}),
        ...(left != null && top != null
          ? { left, top, right: 'auto', bottom: height ? 'auto' : 'auto' }
          : {}),
        ...freePanelVars,
      };
  const isFreePositioned = left != null && top != null;

  return (
    <div
      ref={chatPanelRef}
      role="dialog"
      aria-label="Chat"
      className={`chat-panel chat-panel--agent-${personal ? 'personal' : agent}${isFreePositioned ? ' chat-panel--free' : ''}${exiting ? ' chat-panel--exiting' : ''}`}
      style={panelStyle}
      onMouseDown={startPanelDrag}
      data-chat-agent={agent}
      data-chat-busy={busy ? 'true' : 'false'}
      data-chat-cancel-state={cancelState}
      data-chat-connected={connected ? 'true' : 'false'}
      data-chat-message-count={messages.length}
      data-chat-pending-image-count={pendingImages.length}
    >
      {/* Edges */}
      <div className="chat-panel__resize-handle chat-panel__resize-handle--left" onMouseDown={(e) => startResize(e, 'l')} title="Drag to resize width" />
      <div className="chat-panel__resize-handle chat-panel__resize-handle--right" onMouseDown={(e) => startResize(e, 'r')} title="Drag to resize width" />
      <div className="chat-panel__resize-handle chat-panel__resize-handle--top" onMouseDown={(e) => startResize(e, 't')} title="Drag to resize height" />
      <div className="chat-panel__resize-handle chat-panel__resize-handle--bottom" onMouseDown={(e) => startResize(e, 'b')} title="Drag to resize height" />
      {/* Corners */}
      <div className="chat-panel__resize-handle chat-panel__resize-handle--tl" onMouseDown={(e) => startResize(e, 'tl')} title="Drag to resize" />
      <div className="chat-panel__resize-handle chat-panel__resize-handle--tr" onMouseDown={(e) => startResize(e, 'tr')} title="Drag to resize" />
      <div className="chat-panel__resize-handle chat-panel__resize-handle--bl" onMouseDown={(e) => startResize(e, 'bl')} title="Drag to resize" />
      <div className="chat-panel__resize-handle chat-panel__resize-handle--br" onMouseDown={(e) => startResize(e, 'br')} title="Drag to resize" />
      <div className="chat-panel__header" title="Drag to move">
        <div>
          <div className="chat-panel__title">Chat</div>
          <ChatModelPicker
            agent={agent} personalAgents={personalAgents?.agents ?? []} model={providerSelection.model} effort={effort}
            catalog={activeCatalog} loading={catalogLoading} error={catalogError}
            disabled={busy || authorizing}
            onAgentChange={handleAgentChange} onModelChange={handleModelChange}
            onEffortChange={handleEffortChange} onRetry={() => setCatalogRefresh((value) => value + 1)}
          />
          {commonsEnabled && <label className="chat-panel__brand" onMouseDown={(event) => event.stopPropagation()}>
            Brand
            <input aria-label="Chat brand" value={brand} onChange={(event) => changeBrand(event.target.value)}
              disabled={busy || authorizing} placeholder="Unbranded" maxLength={128}
              title="Changing brand starts a new conversation with separate reference downloads." />
          </label>}
          {commonsEnabled && <p className="chat-panel__scope-hint">Private reference chats: Claude or Codex.</p>}
          <div className="chat-panel__meta" onMouseDown={(e) => e.stopPropagation()}>
            {personal ? (
              <span data-chat-personal-agent={personalAgent?.id ?? ''}>
                <span className="chat-panel__personal-dot" style={{ background: personalAgent?.color ?? '#888' }} aria-hidden="true" />
                {agentDisplayName} · your agent
              </span>
            ) : (
              <span title={agent === 'claude' ? claudeStatus?.message || claudeStatusError || undefined : codexStatus?.message || codexStatusError || undefined}>
                {agent === 'claude' ? claudeStatusLabel : codexStatusLabel}
              </span>
            )}
            <span> · {status}</span>
            {sessionId && (
              <span className="chat-panel__session" title={sessionId}>
                · {sessionId.slice(0, 8)}
              </span>
            )}
          </div>
          {personal && personalOptions.length > 0 && (
            // The models (or thinking levels) the agent offers, on their own row
            // so they never split the status line above.
            <div className="chat-panel__personal-options" onMouseDown={(e) => e.stopPropagation()}>
              {personalOptions.map((option) => (
                <select key={option.id} className="chat-panel__personal-option" value={option.current ?? ''}
                  aria-label={`${option.name} for this conversation`} disabled={busy || offline} {...offlineMark(offline)}
                  title={`${option.name}: ${agentDisplayName} offers these for this conversation`}
                  onChange={(event) => choosePersonalOption(option.id, event.target.value)}>
                  {option.current === null && <option value="" disabled>{option.name}</option>}
                  {option.options.map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}
                </select>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="panel__header-action panel__close"
          onClick={() => togglePanel('chat')}
          aria-label="Close chat panel"
          title="Close"
        >
          <X
            className="panel__close-icon"
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>

      <div className="chat-panel__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat__empty" data-chat-empty="true">
            No messages
          </div>
        )}
        {messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div
                key={m.id}
                className="chat__bubble chat__bubble--user"
                data-chat-message-role="user"
              >
                {m.images && m.images.length > 0 && (
                  <div className="chat__bubble-thumbs">
                    {m.images.map((img) => (
                      <img
                        key={img.nodeId}
                        src={img.thumbUrl}
                        alt=""
                        className="chat__bubble-thumb"
                        data-chat-image-node-id={img.nodeId}
                        loading="lazy"
                      />
                    ))}
                  </div>
                )}
                <div className="chat__bubble-text">{m.text}</div>
              </div>
            );
          }
          if (m.role === 'system') {
            return (
              <div key={m.id} className="chat-panel__system-line" data-chat-message-role="system">
                {m.text}
              </div>
            );
          }
          // Thinking events are routed to the Agent Log, not rendered in chat.
          if (m.role === 'thinking') return null;
          return <AssistantBubble key={m.id} message={m} agentName={agentDisplayName} onPermission={answerPermission} />;
        })}
      </div>

      {warningFor && (
        <PersonalAgentWarning agentName={agentDisplayName} onAccept={acceptWarning} onCancel={() => setWarningFor(null)} />
      )}
      <div className="chat-panel__input">
        {agentConnectHint && (
          <details
            key={agentConnectHint.agent}
            className="chat-panel__connect"
            open={agentConnectHint.open}
            data-chat-agent-connect={agentConnectHint.agent}
          >
            <summary className="chat-panel__connect-summary">
              <span>{agentConnectHint.title}</span>
              <span className="chat-panel__connect-status">{agentConnectHint.status}</span>
            </summary>
            <div className="chat-panel__connect-body">
              <div>{agentConnectHint.detail}</div>
              {agentConnectHint.agent === 'codex' && agentConnectHint.canStartLogin && (
                <>
                  <div className="chat-panel__connect-actions">
                    <button
                      type="button"
                      className="chat-panel__connect-btn chat-panel__connect-btn--primary"
                      onClick={() => handleStartCodexChatGPTLogin(false)}
                      disabled={codexLoginBusy || codexLoginState?.running}
                    >
                      <LogIn
                        className="chat-panel__connect-btn-icon"
                        size={13}
                        strokeWidth={2}
                        aria-hidden="true"
                        focusable="false"
                      />
                      {codexLoginState?.running ? 'Opening ChatGPT...' : 'Connect ChatGPT Account'}
                    </button>
                    <button
                      type="button"
                      className="chat-panel__connect-btn"
                      onClick={() => handleStartCodexChatGPTLogin(true)}
                      disabled={codexLoginBusy || codexLoginState?.running}
                    >
                      Device Code
                    </button>
                  </div>
                  {(codexLoginState || codexLoginError) && (
                    <div className="chat-panel__connect-progress">
                      {codexLoginError || codexLoginState?.message}
                      {codexLoginState?.authUrl && (
                        <a
                          className="chat-panel__connect-link"
                          href={codexLoginState.authUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open ChatGPT login
                          <ExternalLink
                            className="chat-panel__connect-link-icon"
                            size={12}
                            strokeWidth={2}
                            aria-hidden="true"
                            focusable="false"
                          />
                        </a>
                      )}
                      {codexLoginState?.deviceCode && (
                        <code className="chat-panel__connect-code">{codexLoginState.deviceCode}</code>
                      )}
                    </div>
                  )}
                </>
              )}
              <div className="chat-panel__connect-commands">
                {agentConnectHint.commands.map((command) => (
                  <code key={command}>{command}</code>
                ))}
              </div>
            </div>
          </details>
        )}
        {notice && <div className="chat-panel__notice" data-chat-notice="true">{notice}</div>}
        {pendingImages.length > 0 && (
          <div className="chat-panel__chips">
            {pendingImages.map((chip) => (
              <div
                key={chip.id}
                className={`chat-panel__chip chat-panel__chip--${chip.status}`}
                title={chip.label}
                data-chat-chip-status={chip.status}
              >
                {chip.status === 'uploading' && (
                  <>
                    {chip.thumbUrl && (
                      <img src={chip.thumbUrl} alt="" className="chat-panel__chip-thumb" />
                    )}
                    <div className="chat-panel__chip-spinner" />
                  </>
                )}
                {chip.status === 'ready' && (
                  <>
                    <img src={chip.thumbUrl} alt="" className="chat-panel__chip-thumb" />
                    <div className="chat-panel__chip-label">@{chip.nodeId}</div>
                  </>
                )}
                {chip.status === 'error' && (
                  <div className="chat-panel__chip-error">{chip.error}</div>
                )}
                <button
                  type="button"
                  className="chat-panel__chip-close chat-panel__chip-remove"
                  onClick={() => removeChip(chip.id)}
                  aria-label="Remove image"
                >
                  <X
                    className="chat-panel__chip-close-icon"
                    size={10}
                    strokeWidth={2}
                    aria-hidden="true"
                    focusable="false"
                  />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-panel__input-row">
          <textarea
            ref={textareaRef}
            className="chat-panel__textarea"
            placeholder={connected ? 'Message…' : 'Connecting…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onDragOver={(e) => {
              const types = e.dataTransfer.types;
              const accepts =
                types.includes('application/nebula-image-ref') ||
                types.includes('application/nebula-node-ref') ||
                (e.dataTransfer.files && e.dataTransfer.files.length > 0 &&
                 Array.from(e.dataTransfer.items).some(
                   (it) => it.kind === 'file' && it.type.startsWith('image/'),
                 ));
              if (accepts) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={(e) => {
              // Branch 1: canvas-node image (new feature — creates a chip).
              const imageRefRaw = e.dataTransfer.getData('application/nebula-image-ref');
              if (imageRefRaw) {
                e.preventDefault();
                try {
                  const parsed = JSON.parse(imageRefRaw) as { nodeId: string; url: string };
                  setPendingImages((prev) => {
                    // Only count chips that carry or will carry an attachment
                    // against the 4-image cap. Error chips stay visible as a
                    // reminder but don't lock the user out.
                    const activeCount = prev.filter((p) => p.status !== 'error').length;
                    if (activeCount >= 4) {
                      setNotice('4 images max per message — remove one to add another.');
                      return prev;
                    }
                    if (prev.some((p) => p.status === 'ready' && p.nodeId === parsed.nodeId)) {
                      return prev;
                    }
                    return [
                      ...prev,
                      {
                        id: newId(),
                        status: 'ready',
                        nodeId: parsed.nodeId,
                        thumbUrl: parsed.url,
                      },
                    ];
                  });
                  insertAtCaret(e.currentTarget, `@${parsed.nodeId}`);
                } catch {
                  /* malformed payload; ignore */
                }
                return;
              }

              // Branch 2: OS file drop — upload, create node, attach chip.
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files);
                const imageFiles = files.filter((f) => f.type.startsWith('image/'));
                if (imageFiles.length === 0) {
                  setNotice(`Skipped: ${files.length} not an image.`);
                  return;
                }

                // Compute chips OUTSIDE the state updater so React StrictMode's
                // double-invocation of the updater doesn't double-fire uploads.
                // The 4-cap re-check inside the updater keeps us correct under
                // coalesced updates and guarantees stored chips never exceed 4.
                // Error chips don't count against the cap — they're reminders,
                // not reservations.
                const activeCountNow = pendingImages.filter((p) => p.status !== 'error').length;
                const roomLeft = Math.max(0, 4 - activeCountNow);
                const accepted = imageFiles.slice(0, roomLeft);
                const rejectedForLimit = imageFiles.length - accepted.length;
                const rejectedForNonImage = files.length - imageFiles.length;
                if (rejectedForLimit > 0 || rejectedForNonImage > 0) {
                  const parts: string[] = [];
                  if (rejectedForLimit > 0) {
                    parts.push(`${rejectedForLimit} over the 4-image limit`);
                  }
                  if (rejectedForNonImage > 0) {
                    parts.push(`${rejectedForNonImage} not an image`);
                  }
                  setNotice(`Skipped: ${parts.join(', ')}.`);
                }
                if (accepted.length === 0) return;
                const newChips: PendingImage[] = accepted.map((f) => ({
                  id: newId(),
                  status: 'uploading',
                  thumbUrl: URL.createObjectURL(f),
                  label: f.name,
                }));

                // Pure updater — no side effects.
                setPendingImages((prev) => {
                  const activeInPrev = prev.filter((p) => p.status !== 'error').length;
                  const available = Math.max(0, 4 - activeInPrev);
                  // If another drop landed between our closure read and this
                  // reducer run, honour the current cap by admitting only as
                  // many as fit. Revoke any chips we drop on the floor so we
                  // don't leak object URLs.
                  if (available < newChips.length) {
                    for (let i = available; i < newChips.length; i++) {
                      const chip = newChips[i];
                      if (chip?.thumbUrl) URL.revokeObjectURL(chip.thumbUrl);
                    }
                  }
                  return [...prev, ...newChips.slice(0, available)];
                });

                // Fire uploads AFTER the pure state update. Side effects live
                // outside the reducer.
                accepted.slice(0, newChips.length).forEach((f, i) => {
                  void uploadFile(f, newChips[i].id);
                });
                return;
              }

              // Branch 3: existing @nX text-ref drop (unchanged behavior, now
              // using the shared insertAtCaret helper).
              const token =
                e.dataTransfer.getData('application/nebula-node-ref') ||
                e.dataTransfer.getData('text/plain');
              if (!token) return;
              e.preventDefault();
              insertAtCaret(e.currentTarget, token);
            }}
            rows={1}
            disabled={!connected}
          />
          {busy ? (
            <button
              type="button"
              className="chat-panel__send chat-panel__send--stop"
              onClick={cancel}
              disabled={cancelState === 'requested'}
              aria-label={cancelState === 'requested' ? 'Cancellation requested' : 'Stop response'}
              title={cancelState === 'requested' ? 'Waiting for backend cancellation' : 'Stop response'}
            >
              <Square
                className="chat-panel__send-icon"
                size={13}
                strokeWidth={2}
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              />
            </button>
          ) : (
            <button
              type="button"
              className="chat-panel__send chat-panel__send--submit"
              onClick={send}
              aria-label="Send message"
              title={selectionIssue || (catalogLoading ? 'Models are loading.' : 'Send message')}
              {...offlineMark(offline)}
              disabled={
                offline || !connected || authorizing || (!personal && catalogLoading) || Boolean(selectionIssue) ||
                !input.trim() ||
                pendingImages.some((p) => p.status === 'uploading')
              }
            >
              <ArrowUp
                className="chat-panel__send-icon"
                size={17}
                strokeWidth={2}
                aria-hidden="true"
                focusable="false"
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

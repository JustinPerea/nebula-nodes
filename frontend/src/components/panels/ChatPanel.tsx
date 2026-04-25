import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/panels.css';
import '../../styles/hermes.css';
import { fetchNousModels, type NousModel } from '../../lib/api';

// Daedalus mode palette. Persisted so the user's choice survives reloads.
type HermesTone = 'verdant' | 'obsidian';
const HERMES_TONE_KEY = 'nebula:hermes-tone';
function loadHermesTone(): HermesTone {
  try {
    const v = window.localStorage.getItem(HERMES_TONE_KEY);
    return v === 'obsidian' ? 'obsidian' : 'verdant';
  } catch {
    return 'verdant';
  }
}

// Daedalus model picker — separate from Claude's `model` state because the
// frontend chat panel reuses the same WS for both agents and we want each
// agent to remember its own pick. localStorage-backed.
const DAEDALUS_MODEL_KEY = 'nebula:daedalus-model';
const DAEDALUS_PROVIDER_KEY = 'nebula:daedalus-provider';
const DEFAULT_DAEDALUS_MODEL = 'moonshotai/kimi-k2.6';
// Default to OpenRouter — works out-of-the-box with the user's existing
// Hermes setup. Only flips to "nous" once the user actively picks a model
// from the Nous catalog (which means they've authed via `hermes-daedalus
// model`). This keeps fresh users from hitting a 401 on their first turn.
type DaedalusProvider = 'openrouter' | 'nous';
function loadDaedalusModel(): string {
  try {
    return window.localStorage.getItem(DAEDALUS_MODEL_KEY) || DEFAULT_DAEDALUS_MODEL;
  } catch {
    return DEFAULT_DAEDALUS_MODEL;
  }
}
function loadDaedalusProvider(): DaedalusProvider {
  try {
    const v = window.localStorage.getItem(DAEDALUS_PROVIDER_KEY);
    return v === 'nous' ? 'nous' : 'openrouter';
  } catch {
    return 'openrouter';
  }
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
};

type MessagePart = TextChunk | ToolCall | SystemLine;

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
    }
  | {
      role: 'approval';
      id: string;
      summary: string;
      plan: string;
      cost: string;
      responded?: boolean;
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

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Walk the messages list, marking any not-yet-completed thinking bubble as
// completed. Called whenever a non-thinking event arrives (text / approval /
// done / error) so the next batch of thinking events starts a fresh bubble
// on the next turn instead of appending to this turn's finished stream.
// Does NOT collapse — collapse happens once at turn end via the done handler,
// because collapsing mid-turn caused bubbles to flash-and-fold in interleaved
// thinking/text streams. A past turn's worth of craft notes should stay
// readable while Daedalus is still working.
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

function AssistantBubble({ message }: { message: Extract<ChatMessage, { role: 'assistant' }> }) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});

  const applyToTarget = (content: string) => {
    if (!message.enhanceTargetId) return;
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
    <div className="chat__bubble chat__bubble--assistant">
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
                        title="Paste this into the text-input node that triggered Enhance"
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
        if (part.kind === 'system') {
          return (
            <div key={idx} className="chat__system">
              {part.text}
            </div>
          );
        }
        const isOpen = expandedTools[part.toolUseId] ?? false;
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
              <span className="chat__tool-icon">{isOpen ? '▾' : '▸'}</span>
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
  const visible = useUIStore((s) => s.panels.chat.visible);
  const width = useUIStore((s) => s.panels.chat.width) ?? 300;
  const height = useUIStore((s) => s.panels.chat.height);
  const left = useUIStore((s) => s.panels.chat.left);
  const top = useUIStore((s) => s.panels.chat.top);
  const setChatWidth = useUIStore((s) => s.setChatWidth);
  const setChatHeight = useUIStore((s) => s.setChatHeight);
  const setChatPosition = useUIStore((s) => s.setChatPosition);
  const togglePanel = useUIStore((s) => s.togglePanel);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [agent, setAgent] = useState<'claude' | 'daedalus'>('claude');
  const [autonomy, setAutonomy] = useState<'auto' | 'step'>('auto');
  const [hermesTone, setHermesTone] = useState<HermesTone>(loadHermesTone);

  // Drive the Hermes skin off the selected agent. While Daedalus is active,
  // .app-hermes + the current tone class live on <body> so CSS scoped under
  // them can reskin every panel (chat, toolbar, node library) in lockstep.
  // When Claude is selected we strip both classes — zero leakage.
  useEffect(() => {
    const body = document.body;
    if (agent === 'daedalus') {
      body.classList.add('app-hermes');
      body.classList.toggle('tone-verdant', hermesTone === 'verdant');
      body.classList.toggle('tone-obsidian', hermesTone === 'obsidian');
    } else {
      body.classList.remove('app-hermes', 'tone-verdant', 'tone-obsidian');
    }
    return () => {
      body.classList.remove('app-hermes', 'tone-verdant', 'tone-obsidian');
    };
  }, [agent, hermesTone]);

  const changeHermesTone = useCallback((next: HermesTone) => {
    setHermesTone(next);
    try { window.localStorage.setItem(HERMES_TONE_KEY, next); } catch {}
  }, []);

  // Daedalus model picker state
  const [daedalusModel, setDaedalusModel] = useState<string>(loadDaedalusModel);
  const [daedalusProvider, setDaedalusProvider] = useState<DaedalusProvider>(loadDaedalusProvider);
  const [daedalusModelPickerOpen, setDaedalusModelPickerOpen] = useState(false);
  const [nousModels, setNousModels] = useState<NousModel[]>([]);
  const [nousModelsLoading, setNousModelsLoading] = useState(false);
  const [nousModelsError, setNousModelsError] = useState<string | null>(null);
  const [daedalusModelSearch, setDaedalusModelSearch] = useState('');

  const changeDaedalusModel = useCallback((modelId: string, fromProvider: DaedalusProvider = 'nous') => {
    setDaedalusModel(modelId);
    setDaedalusProvider(fromProvider);
    try {
      window.localStorage.setItem(DAEDALUS_MODEL_KEY, modelId);
      window.localStorage.setItem(DAEDALUS_PROVIDER_KEY, fromProvider);
    } catch {}
    setDaedalusModelPickerOpen(false);
  }, []);

  // Lazy-load Nous models on first picker open, then cache. Use a ref-flag
  // (instead of state-derived guards) because a failed fetch leaves
  // `loading=false` and `models.length=0`, which would otherwise re-trigger
  // the effect on every render and create an infinite retry loop.
  const nousModelsFetchedRef = useRef(false);
  useEffect(() => {
    // Trigger fetch when EITHER the picker opens OR the user is sitting on
    // a Nous-pinned Daedalus session — the latter so the smart-default
    // validator below can run on first paint without waiting for the user
    // to open the picker.
    const shouldFetch =
      daedalusModelPickerOpen || (agent === 'daedalus' && daedalusProvider === 'nous');
    if (!shouldFetch || nousModelsFetchedRef.current) return;
    nousModelsFetchedRef.current = true;
    setNousModelsLoading(true);
    setNousModelsError(null);
    fetchNousModels()
      .then((data) => setNousModels(data.models))
      .catch((err: unknown) => {
        // Reset the ref so the user can retry by closing + reopening the
        // picker after running `hermes auth`.
        nousModelsFetchedRef.current = false;
        setNousModelsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setNousModelsLoading(false));
  }, [daedalusModelPickerOpen, agent, daedalusProvider]);

  // Daedalus is a text-out chat agent. Drop models whose only output is
  // speech / image / something else — they'd accept a turn but return
  // nothing the chat panel knows how to render.
  const chatCapableNousModels = useMemo(
    () => nousModels.filter((m) => (m.output_modalities ?? ['text']).includes('text')),
    [nousModels],
  );

  const filteredDaedalusModels = useMemo(() => {
    let list = chatCapableNousModels;
    if (daedalusModelSearch.trim()) {
      const q = daedalusModelSearch.toLowerCase();
      list = list.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      );
    }
    return list.slice(0, 80);
  }, [chatCapableNousModels, daedalusModelSearch]);

  // Smart default: once the Nous catalog loads, validate the persisted
  // daedalusModel still exists on the current provider. If the user is
  // pinned to nous but the model is gone (e.g. retired, or a stale TTS
  // pick), quietly swap to the first chat-capable Nous model. We only
  // do this for Nous-pinned users — OpenRouter users keep their pick
  // regardless because we don't have an OpenRouter catalog to validate
  // against here.
  useEffect(() => {
    if (daedalusProvider !== 'nous') return;
    if (chatCapableNousModels.length === 0) return;
    const current = chatCapableNousModels.find((m) => m.id === daedalusModel);
    if (current) return;
    const fallback = chatCapableNousModels[0];
    setDaedalusModel(fallback.id);
    try { window.localStorage.setItem(DAEDALUS_MODEL_KEY, fallback.id); } catch {}
  }, [daedalusProvider, chatCapableNousModels, daedalusModel]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // Switch the active agent. Each agent has its own session thread, so we
  // clear sessionId on change — the next turn starts fresh on the new agent.
  const handleAgentChange = useCallback(
    (next: 'claude' | 'daedalus') => {
      if (next === agent) return;
      setAgent(next);
      setSessionId(null);
    },
    [agent],
  );

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  // Ref callback that scrolls the thinking-body to its bottom on every
  // re-render. Combined with `key={lines.length}` on the body element, this
  // fires each time a new line arrives so the newest entry stays visible.
  const thinkingBodyRef = useCallback((el: HTMLDivElement | null) => {
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const toggleThinkingCollapsed = useCallback((id: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.role === 'thinking' && m.id === id ? { ...m, collapsed: !m.collapsed } : m,
      ),
    );
  }, []);
  // Holds the text-input node id for the next outgoing message, set by the
  // Enhance button just before send. Cleared when the message leaves so it
  // only attaches to the one assistant response it triggered.
  const pendingEnhanceTargetRef = useRef<string | null>(null);

  const uploadFile = useCallback(
    async (file: File, chipId: string) => {
      const form = new FormData();
      form.append('file', file);
      form.append('create_node', 'true');
      try {
        const resp = await fetch(
          `http://${window.location.hostname}:8000/api/uploads`,
          { method: 'POST', body: form },
        );
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          const errMsg =
            resp.status === 413
              ? 'Image > 20MB'
              : resp.status === 415
              ? 'Not an image'
              : (detail || `Upload failed (${resp.status})`);
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
                  thumbUrl: body.thumbUrl,
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
      } catch (err) {
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

    const ws = new WebSocket(`ws://${window.location.hostname}:8000/ws/chat`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setBusy(false);
    };
    ws.onerror = () => setConnected(false);

    ws.onmessage = (ev) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(ev.data);
      } catch {
        return;
      }

      const type = event.type;
      if (type === 'session') {
        setSessionId(String(event.sessionId));
        return;
      }
      if (type === 'thinking') {
        const line = String(event.text ?? '');
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'thinking' && !last.completed) {
            const updated = { ...last, lines: [...last.lines, line] };
            return [...prev.slice(0, -1), updated];
          }
          return [
            ...prev,
            {
              id: newId(),
              role: 'thinking',
              lines: [line],
              collapsed: false,
              startedAt: Date.now(),
              completed: false,
            },
          ];
        });
        return;
      }
      if (type === 'approval_request') {
        setMessages((prev) => [
          ...markThinkingCompleted(prev),
          {
            id: newId(),
            role: 'approval',
            summary: String(event.summary ?? ''),
            plan: String(event.plan ?? ''),
            cost: String(event.cost ?? ''),
          },
        ]);
        return;
      }
      if (type === 'learning_saved') {
        setMessages((prev) => [
          ...markThinkingCompleted(prev),
          {
            id: newId(),
            role: 'system',
            text: `→ Saved learning: ${String(event.topic ?? '')}`,
          },
        ]);
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
        setMessages((prev) => markThinkingCompleted(prev));
        upsertAssistant((msg) => ({
          ...msg,
          parts: [
            ...msg.parts.map((p) =>
              p.kind === 'tool' && p.result === undefined
                ? { ...p, result: '(stream ended before this tool returned)', isError: true }
                : p,
            ),
            { kind: 'system', text: `\u26A0 ${errText}` },
          ],
          streaming: false,
        }));
        return;
      }
      if (type === 'done') {
        setBusy(false);
        setMessages((prev) => collapseAllThinking(prev));
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

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [visible, upsertAssistant]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Other components (e.g. the text-input node's Enhance button) can dispatch
  // `nebula:chat-send` with a pre-composed message. We open the panel if it's
  // closed, drop the message into the input, and auto-send when the socket is
  // ready and not already streaming. If busy, the user can hit Send themselves.
  const sendRef = useRef<() => void>(() => {});
  useEffect(() => {
    function onChatSend(e: Event) {
      const detail = (e as CustomEvent<{ message?: string; sourceNodeId?: string }>).detail;
      const msg = String(detail?.message ?? '').trim();
      if (!msg) return;
      if (!useUIStore.getState().panels.chat.visible) {
        useUIStore.getState().togglePanel('chat');
      }
      setInput(msg);
      // Remember which node triggered this so the Apply button knows where to
      // paste the reply's code blocks. Cleared inside send() once attached.
      pendingEnhanceTargetRef.current = detail?.sourceNodeId ?? null;
      // Defer so the input state and possibly the WS connection settle first.
      setTimeout(() => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN && !busyRef.current) {
          sendRef.current();
        }
      }, 120);
    }
    window.addEventListener('nebula:chat-send', onChatSend);
    return () => window.removeEventListener('nebula:chat-send', onChatSend);
  }, []);

  const send = useCallback(() => {
    const raw = input.trim();
    if (!raw) return;

    // Client-side command interception.
    if (raw.startsWith('/model ')) {
      // Preserve case for Daedalus models (some Hermes / Nous IDs are case-sensitive).
      const rawName = raw.slice(7).trim();
      let resolved: string;
      if (agent === 'daedalus') {
        resolved = rawName;
        changeDaedalusModel(resolved);
      } else {
        const lower = rawName.toLowerCase();
        resolved = MODEL_ALIASES[lower] ?? lower;
        setModel(resolved);
      }
      setMessages((prev) => [
        ...prev,
        { role: 'user', text: raw, id: newId() },
        {
          role: 'assistant',
          id: newId(),
          streaming: false,
          parts: [{ kind: 'system', text: `Model set to: ${resolved}` }],
        },
      ]);
      setInput('');
      return;
    }
    if (raw === '/clear') {
      setSessionId(null);
      // Also wipe cli_graph on the backend so Claude starts with a clean canvas,
      // not whatever nodes accumulated from prior sessions. graphSync handles the
      // frontend side — cli-origin nodes drop out, library-dragged work survives.
      fetch(`http://${window.location.hostname}:8000/api/graph`, { method: 'DELETE' }).catch(() => {});
      setMessages([
        {
          role: 'assistant',
          id: newId(),
          streaming: false,
          parts: [{ kind: 'system', text: 'Session cleared. Next message starts a fresh conversation with an empty canvas.' }],
        },
      ]);
      setInput('');
      return;
    }

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (busyRef.current) return;

    const enhanceTargetId = pendingEnhanceTargetRef.current ?? undefined;
    pendingEnhanceTargetRef.current = null;
    // Stash thumbs for the user-message bubble history rendering (Task 9
    // will make the bubble actually render them).
    const attachedImages = pendingImages
      .filter((p): p is Extract<PendingImage, { status: 'ready' }> => p.status === 'ready')
      .map((p) => ({ nodeId: p.nodeId, thumbUrl: p.thumbUrl }));
    setPendingImages([]);
    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        text: raw,
        id: newId(),
        images: attachedImages.length ? attachedImages : undefined,
      },
      { role: 'assistant', id: newId(), streaming: true, parts: [], enhanceTargetId },
    ]);
    setBusy(true);
    setInput('');

    ws.send(
      JSON.stringify({
        type: 'send',
        message: raw,
        sessionId,
        model: agent === 'daedalus' ? daedalusModel : model,
        agent,
        autonomy,
        // Provider is only meaningful for Daedalus turns. Backend treats
        // null as "use default" (currently `nous`). Sending `openrouter`
        // explicitly is the fresh-user fallback path.
        provider: agent === 'daedalus' ? daedalusProvider : null,
      }),
    );
  }, [input, model, daedalusModel, daedalusProvider, sessionId, pendingImages, agent, autonomy]);

  // Keep sendRef pointing at the latest `send` so the chat-send event listener
  // always calls the current closure (input/model/sessionId are captured fresh).
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // Sends a new turn whose text starts with 'APPROVED:' or 'REJECTED:'.
  // Daedalus's SKILL.md tells the agent to recognize these prefixes and
  // either proceed with the paused plan or pivot. Mirrors the WS-send flow
  // in `send()` — appends user + assistant placeholder, flips busy, posts
  // the JSON envelope with agent/autonomy/sessionId/model.
  const handleApprovalResponse = useCallback(
    (response: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (busyRef.current) return;
      setMessages((prev) => {
        // Mark the most recent approval message as responded so its
        // Approve/Reject buttons disable + dim during streaming.
        let markedLatest = false;
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i -= 1) {
          const msg = updated[i];
          if (msg.role === 'approval' && !msg.responded && !markedLatest) {
            updated[i] = { ...msg, responded: true };
            markedLatest = true;
            break;
          }
        }
        return [
          ...updated,
          { role: 'user', text: response, id: newId() },
          { role: 'assistant', id: newId(), streaming: true, parts: [] },
        ];
      });
      setBusy(true);
      ws.send(
        JSON.stringify({
          type: 'send',
          message: response,
          sessionId,
          model: agent === 'daedalus' ? daedalusModel : model,
          agent,
          autonomy,
          provider: agent === 'daedalus' ? daedalusProvider : null,
        }),
      );
    },
    [sessionId, model, daedalusModel, daedalusProvider, agent, autonomy],
  );

  const cancel = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cancel' }));
    }
    setBusy(false);
    upsertAssistant((msg) => ({
      ...msg,
      parts: [...msg.parts, { kind: 'system', text: 'Cancelled.' }],
      streaming: false,
    }));
  }, [upsertAssistant]);

  const status = useMemo(() => {
    if (!connected) return 'disconnected';
    if (busy) return 'thinking…';
    return 'ready';
  }, [connected, busy]);

  // Generic drag-to-resize helper. The `edges` string encodes which panel
  // edges the user is dragging: any combination of 'l', 'r', 't', 'b'. We
  // compute the new width/height and, when top or left is in play, the new
  // panel position so the grabbed edge stays glued to the cursor in both
  // anchoring modes (top-right default vs. top-left after drag).
  const MIN_W = 260;
  const MAX_W = 720;
  const MIN_H = 240;
  const MAX_H = 2000;
  const CURSOR_FOR: Record<string, string> = {
    l: 'ew-resize', r: 'ew-resize', t: 'ns-resize', b: 'ns-resize',
    tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize',
  };
  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, edgesStr: string) => {
      e.preventDefault();
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
      document.body.style.cursor = CURSOR_FOR[edgesStr] ?? 'move';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, left, top, setChatWidth, setChatHeight, setChatPosition],
  );

  const startPanelDrag = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Don't hijack clicks on the close button or other header children.
      if ((e.target as HTMLElement).closest('.panel__close')) return;
      e.preventDefault();
      const panel = e.currentTarget.parentElement as HTMLElement | null;
      const rect = panel?.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = rect?.left ?? left ?? 0;
      const startTop = rect?.top ?? top ?? 0;
      const onMove = (ev: MouseEvent) => {
        setChatPosition(
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
    [left, top, setChatPosition],
  );

  if (!visible) return null;

  // Compose inline style based on which anchors the user has set.
  // - Default: top-right anchored, stretched from top to bottom.
  // - After height set: top-right anchored, explicit height.
  // - After drag: top-left anchored at user's position.
  const panelStyle: React.CSSProperties = {
    width,
    ...(height ? { height, bottom: 'auto' } : {}),
    ...(left != null && top != null
      ? { left, top, right: 'auto', bottom: height ? 'auto' : 'auto' }
      : {}),
  };

  return (
    <div className={`chat-panel chat-panel--agent-${agent}`} style={panelStyle}>
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
      <div className="chat-panel__header" onMouseDown={startPanelDrag} title="Drag to move">
        <div>
          <div className="chat-panel__title">Chat</div>
          <div
            className="chat-panel__agent-selector"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={
                agent === 'claude'
                  ? 'chat-panel__agent-btn--active'
                  : 'chat-panel__agent-btn'
              }
              onClick={() => handleAgentChange('claude')}
            >
              Claude
            </button>
            <button
              type="button"
              className={
                agent === 'daedalus'
                  ? 'chat-panel__agent-btn--active'
                  : 'chat-panel__agent-btn'
              }
              onClick={() => handleAgentChange('daedalus')}
            >
              Daedalus
            </button>
          </div>
          {agent === 'daedalus' && (
            <div
              className="chat-panel__autonomy-toggle"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={
                  autonomy === 'auto'
                    ? 'chat-panel__autonomy-btn--active'
                    : 'chat-panel__autonomy-btn'
                }
                onClick={() => setAutonomy('auto')}
                title="Auto-pilot: Daedalus runs the full pipeline"
              >
                Auto ▶
              </button>
              <button
                type="button"
                className={
                  autonomy === 'step'
                    ? 'chat-panel__autonomy-btn--active'
                    : 'chat-panel__autonomy-btn'
                }
                onClick={() => setAutonomy('step')}
                title="Step Approval: Daedalus pauses before expensive operations"
              >
                Step ⏸
              </button>
            </div>
          )}
          {agent === 'daedalus' && (
            <div
              className="chat-panel__tone-toggle"
              onMouseDown={(e) => e.stopPropagation()}
              title="Daedalus palette: Verdant (deep green-black) or Obsidian (pure black + muted gold)"
            >
              <button
                type="button"
                className={
                  hermesTone === 'verdant'
                    ? 'chat-panel__tone-btn--active'
                    : 'chat-panel__tone-btn'
                }
                onClick={() => changeHermesTone('verdant')}
              >
                Verdant
              </button>
              <button
                type="button"
                className={
                  hermesTone === 'obsidian'
                    ? 'chat-panel__tone-btn--active'
                    : 'chat-panel__tone-btn'
                }
                onClick={() => changeHermesTone('obsidian')}
              >
                Obsidian
              </button>
            </div>
          )}
          <div className="chat-panel__meta" onMouseDown={(e) => e.stopPropagation()}>
            {agent === 'daedalus' ? (
              <button
                type="button"
                className="chat-panel__model-trigger"
                onClick={() => setDaedalusModelPickerOpen((v) => !v)}
                title="Switch model — fetches the live list from Nous Portal"
              >
                {daedalusModel} · Hermes <span className="chat-panel__model-caret">{daedalusModelPickerOpen ? '▾' : '▸'}</span>
              </button>
            ) : (
              <span>{model}</span>
            )}
            <span> · {status}</span>
            {sessionId && (
              <span className="chat-panel__session" title={sessionId}>
                · {sessionId.slice(0, 8)}
              </span>
            )}
          </div>
          {agent === 'daedalus' && daedalusModelPickerOpen && (
            <div
              className="chat-panel__model-picker"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                className="chat-panel__model-search"
                placeholder={
                  nousModelsLoading
                    ? 'Loading models…'
                    : nousModelsError
                      ? 'Could not load — see error below'
                      : `Search ${nousModels.length} models…`
                }
                value={daedalusModelSearch}
                onChange={(e) => setDaedalusModelSearch(e.target.value)}
                autoFocus
              />
              {nousModelsError && (
                <div className="chat-panel__model-error">{nousModelsError}</div>
              )}
              <div className="chat-panel__model-list">
                {filteredDaedalusModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={
                      m.id === daedalusModel
                        ? 'chat-panel__model-row chat-panel__model-row--active'
                        : 'chat-panel__model-row'
                    }
                    onClick={() => changeDaedalusModel(m.id)}
                  >
                    <span className="chat-panel__model-row-name">{m.name}</span>
                    <span className="chat-panel__model-row-id">{m.id}</span>
                  </button>
                ))}
                {!nousModelsLoading && !nousModelsError && filteredDaedalusModels.length === 0 && nousModels.length > 0 && (
                  <div className="chat-panel__model-empty">No matches</div>
                )}
              </div>
            </div>
          )}
        </div>
        <button className="panel__close" onClick={() => togglePanel('chat')}>
          ×
        </button>
      </div>

      <div className="chat-panel__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat__empty">
            {agent === 'daedalus' ? (
              <p>Talk to Daedalus. Master craftsman, labyrinth-builder — it plans pipelines with precision, measures twice before each cut, and remembers every lesson a bad joint taught it.</p>
            ) : (
              <p>Talk to Claude Code. It has access to the nebula skill — ask it to build a graph.</p>
            )}
            <p className="chat__empty-hint">
              {agent === 'daedalus' ? (
                <code>/clear</code>
              ) : (
                <>
                  <code>/model sonnet|opus|haiku</code> · <code>/clear</code>
                </>
              )}
            </p>
          </div>
        )}
        {messages.map((m) => {
          if (m.role === 'user') {
            return (
              <div key={m.id} className="chat__bubble chat__bubble--user">
                {m.images && m.images.length > 0 && (
                  <div className="chat__bubble-thumbs">
                    {m.images.map((img) => (
                      <img
                        key={img.nodeId}
                        src={img.thumbUrl}
                        alt=""
                        className="chat__bubble-thumb"
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
              <div key={m.id} className="chat-panel__system-line">
                {m.text}
              </div>
            );
          }
          if (m.role === 'thinking') {
            return (
              <div
                key={m.id}
                className={`chat-panel__thinking ${m.completed ? 'chat-panel__thinking--completed' : ''}`}
              >
                <button
                  type="button"
                  className="chat-panel__thinking-header"
                  onClick={() => toggleThinkingCollapsed(m.id)}
                >
                  <span className="chat-panel__thinking-indicator">
                    {m.completed ? '✓' : '…'}
                  </span>
                  <span className="chat-panel__thinking-label">
                    {m.completed ? 'thinking complete' : 'thinking'} · {m.lines.length} update
                    {m.lines.length === 1 ? '' : 's'}
                  </span>
                  <span className="chat-panel__thinking-caret">
                    {m.collapsed ? '▸' : '▾'}
                  </span>
                </button>
                {!m.collapsed && (
                  <div
                    ref={thinkingBodyRef}
                    key={m.lines.length}
                    className="chat-panel__thinking-body"
                  >
                    {m.lines.map((line, i) => (
                      <div key={i} className="chat-panel__thinking-line">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (m.role === 'approval') {
            return (
              <div key={m.id} className="chat-panel__approval">
                <div className="chat-panel__approval-summary">
                  <strong>Approval required:</strong> {m.summary}
                </div>
                {m.plan && (
                  <div className="chat-panel__approval-plan">
                    <strong>Plan:</strong> {m.plan}
                  </div>
                )}
                {m.cost && (
                  <div className="chat-panel__approval-cost">
                    <strong>Cost:</strong> {m.cost}
                  </div>
                )}
                <div className="chat-panel__approval-actions">
                  <button
                    type="button"
                    className="chat-panel__approval-btn chat-panel__approval-btn--approve"
                    onClick={() => handleApprovalResponse('APPROVED: continue')}
                    disabled={m.responded}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="chat-panel__approval-btn chat-panel__approval-btn--reject"
                    onClick={() => handleApprovalResponse('REJECTED: please revise')}
                    disabled={m.responded}
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          }
          return <AssistantBubble key={m.id} message={m} />;
        })}
      </div>

      <div className="chat-panel__input">
        {notice && <div className="chat-panel__notice">{notice}</div>}
        {pendingImages.length > 0 && (
          <div className="chat-panel__chips">
            {pendingImages.map((chip) => (
              <div
                key={chip.id}
                className={`chat-panel__chip chat-panel__chip--${chip.status}`}
                title={chip.label}
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
                  className="chat-panel__chip-close"
                  onClick={() => removeChip(chip.id)}
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-panel__input-row">
          <textarea
            className="chat-panel__textarea"
            placeholder={connected ? 'Type a message… (drag a node in to reference it)' : 'Connecting…'}
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
                      URL.revokeObjectURL(newChips[i].thumbUrl);
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
            rows={2}
            disabled={!connected}
          />
          {busy ? (
            <button className="chat-panel__send chat-panel__send--stop" onClick={cancel}>
              Stop
            </button>
          ) : (
            <button
              className="chat-panel__send"
              onClick={send}
              disabled={
                !connected ||
                !input.trim() ||
                pendingImages.some((p) => p.status === 'uploading')
              }
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

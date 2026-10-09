import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { chatAuthUsesProviderBilling, type ChatModelCatalog } from '../../lib/api';
import { usePanelFocus } from '../../hooks/usePanelFocus';
import { ScrollFade } from '../ScrollFade';
import '../../styles/chat-model-picker.css';

type Agent = 'claude' | 'codex';

export interface ChatModelPickerProps {
  agent: Agent;
  model: string | null;
  effort: string | null;
  catalog: ChatModelCatalog | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onAgentChange: (agent: Agent) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string | null) => void;
  onRetry: () => void;
}

const PROVIDERS: Array<{ id: Agent; label: string }> = [
  { id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' },
];

export function ChatModelPicker({ agent, model, effort, catalog, loading, error, disabled,
  onAgentChange, onModelChange, onEffortChange, onRetry }: ChatModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 8, y: 8 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const id = useId();
  // A new running/authorizing state also dismisses an already open picker.
  // Do not reopen it automatically when that work finishes.
  if (open && disabled) setOpen(false);
  const visible = open && !disabled;
  const dismiss = useCallback(() => setOpen(false), []);
  usePanelFocus(visible, dialogRef, dismiss, {
    initialFocus: `[data-chat-provider="${agent}"]`,
  });

  const keepTabInPicker = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button:not([disabled]), input:not([disabled])',
    )].filter((item) => !item.closest('[hidden], [inert], [aria-hidden="true"]'));
    // Native radio groups contribute only the checked (or first) radio to Tab
    // order. Counting unchecked choices would miss the real final Tab stop.
    const tabStops = controls.filter((item) => {
      if (!(item instanceof HTMLInputElement) || item.type !== 'radio' || !item.name) return true;
      const group = controls.filter((other) => other instanceof HTMLInputElement
        && other.type === 'radio' && other.name === item.name) as HTMLInputElement[];
      return item === (group.find((other) => other.checked) ?? group[0]);
    });
    const first = tabStops[0];
    const last = tabStops.at(-1);
    if (event.shiftKey && document.activeElement === first && last) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last && first) {
      event.preventDefault();
      first.focus();
    }
  };

  const current = catalog?.agent === agent ? catalog : null;
  const ready = !loading && !error && current?.status === 'ready';
  const models = ready ? current.models : [];
  const selected = model ? models.find((item) => item.id === model) : models.find((item) => item.isDefault);
  const offeredEffort = selected?.supportedEfforts.find((item) => item.id === effort);
  const defaultEffort = selected?.supportedEfforts.find((item) => item.id === selected.defaultEffort);
  const provider = PROVIDERS.find((item) => item.id === agent)!;
  const modelLabel = selected?.label ?? model ?? (loading ? 'Loading models…' : 'Choose model');
  const effortLabel = effort ? offeredEffort?.label ?? 'Unavailable effort'
    : defaultEffort ? `${defaultEffort.label} · default` : 'CLI default';
  const unavailable = error ?? current?.error?.message ?? (
    current?.status === 'not_installed' ? `${provider.label} is not installed.`
      : current?.status === 'not_authenticated' ? `Sign in to ${provider.label}, then retry.`
        : ready && !models.length ? 'No models are available from this CLI.' : 'Model catalog is unavailable.'
  );
  const connection = current?.auth.mode === 'chatgpt' ? 'Connected to ChatGPT'
    : chatAuthUsesProviderBilling(current?.auth.mode ?? null)
      ? /api|bearer/i.test(current?.auth.mode || '') ? 'Using API billing' : 'Using provider billing'
      : 'Local CLI connection ready';

  useLayoutEffect(() => {
    if (!visible) return;
    const measure = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const dialog = dialogRef.current?.getBoundingClientRect();
      if (!trigger || !dialog) return;
      const below = trigger.bottom + 8;
      const top = below + dialog.height <= window.innerHeight - 8 ? below : trigger.top - dialog.height - 8;
      const next = {
        x: Math.max(8, Math.min(trigger.left, window.innerWidth - dialog.width - 8)),
        y: Math.max(8, Math.min(top, window.innerHeight - dialog.height - 8)),
      };
      setAnchor((value) => value.x === next.x && value.y === next.y ? value : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (dialogRef.current) observer?.observe(dialogRef.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)
        && !triggerRef.current?.contains(event.target)) dismiss();
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [visible, dismiss]);

  return <div className="chat-model-picker">
    <button type="button" ref={triggerRef} className="chat-model-picker__trigger"
      aria-label="Choose chat model" aria-describedby={`${id}-selection`} aria-haspopup="dialog"
      aria-expanded={visible} aria-controls={visible ? id : undefined} disabled={disabled}
      onClick={() => { triggerRef.current?.focus({ preventScroll: true }); setOpen((value) => !value); }}>
      <span id={`${id}-selection`} className="chat-model-picker__selection">
        <span className="chat-model-picker__model-label">{modelLabel}</span>
        <span className="chat-model-picker__effort-label">{selected ? effortLabel : provider.label}</span>
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {visible && createPortal(<div id={id} ref={dialogRef} role="dialog" aria-label="Chat model settings"
      aria-busy={loading} tabIndex={-1} className="chat-model-picker__dialog"
      style={{ '--chat-picker-left': `${anchor.x}px`, '--chat-picker-top': `${anchor.y}px` } as CSSProperties}
      onMouseDown={(event) => event.stopPropagation()} onKeyDownCapture={keepTabInPicker}
      onKeyDown={(event) => event.stopPropagation()}>
      <div className="chat-model-picker__header"><strong>Model &amp; thinking</strong>
        <button type="button" className="chat-model-picker__close" aria-label="Close chat model settings" onClick={dismiss}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="chat-model-picker__providers" role="group" aria-label="Chat provider">
        {PROVIDERS.map((item) => <button key={item.id} type="button" data-chat-provider={item.id}
          aria-pressed={agent === item.id} onClick={() => { if (item.id !== agent) onAgentChange(item.id); }}>
          {item.label}
        </button>)}
      </div>
      <p className="chat-model-picker__connection">
        {agent === 'claude' ? 'Uses your existing Claude Code login.' : 'Uses your existing Codex connection.'}
        {ready && <span>{connection}</span>}
      </p>
      <ScrollFade className="chat-model-picker__body">
        {loading ? <p role="status">Loading models…</p> : !ready || !models.length ? <div className="chat-model-picker__unavailable">
          <p role="status">{unavailable}</p>
          <button type="button" className="chat-model-picker__retry" onClick={onRetry}>Retry model discovery</button>
        </div> : <>
          {model && !selected && <p role="status">Saved model is unavailable. Choose a model from this CLI.</p>}
          <fieldset className="chat-model-picker__options"><legend>Chat model</legend>
            <ScrollFade className="chat-model-picker__models">
            {models.map((item, index) => <label key={item.id} className="chat-model-picker__option">
              <input type="radio" name={`${id}-model`} aria-label={item.label}
                aria-describedby={item.description ? `${id}-description-${index}` : undefined}
                value={item.id} checked={selected?.id === item.id} onChange={() => onModelChange(item.id)} />
              <span><strong>{item.label}</strong>
                {item.description && <span id={`${id}-description-${index}`} className="chat-model-picker__description">{item.description}</span>}
              </span>
            </label>)}
            </ScrollFade>
          </fieldset>
          {selected && <fieldset className="chat-model-picker__options"><legend>Thinking effort</legend>
            {effort && !offeredEffort && <p role="status">Saved thinking effort is unavailable for this model. Choose an offered effort or CLI default.</p>}
            <div className="chat-model-picker__efforts">
            <label className="chat-model-picker__option chat-model-picker__effort" title={defaultEffort ? `CLI default: ${defaultEffort.label}` : 'Use the CLI default thinking effort'}>
              <input type="radio" name={`${id}-effort`} aria-label="CLI default" value="" checked={effort === null}
                aria-describedby={defaultEffort ? `${id}-default-effort` : undefined}
                onChange={() => onEffortChange(null)} />
              <span><strong>CLI default</strong>{defaultEffort && <span id={`${id}-default-effort`} className="chat-model-picker__effort-description">{defaultEffort.label}</span>}</span>
            </label>
            {selected.supportedEfforts.map((item, index) => <label key={item.id} className="chat-model-picker__option chat-model-picker__effort" title={item.description}>
              <input type="radio" name={`${id}-effort`} aria-label={item.label}
                aria-describedby={item.description ? `${id}-effort-description-${index}` : undefined}
                value={item.id} checked={effort === item.id} onChange={() => onEffortChange(item.id)} />
              <span><strong>{item.label}</strong>{item.description && <span id={`${id}-effort-description-${index}`}
                className="chat-model-picker__effort-description">{item.description}</span>}</span>
            </label>)}
            </div>
          </fieldset>}
        </>}
      </ScrollFade>
      <p className="chat-model-picker__footer">Applies to your next message.</p>
    </div>, document.body)}
  </div>;
}
